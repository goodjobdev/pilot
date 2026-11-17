import {ControlStore,ControlStoreError,operationDigest} from './control-store';
import {ForkError} from '../../shared/forks';

class InvalidFence extends Error{}
type FenceBase={readonly revision:number;readonly state:'held'|'released';readonly token:string};
/**
 * Verify the newest two immutable fence revisions and their durable outboxes. This is a bounded
 * integrity check, not a full-history audit or proof against a same-UID writer. The caller's
 * parser checks each fence's exact shape; no token is exposed by an owner-facing view.
 */
export function readFenceChain<T extends FenceBase>(store:ControlStore,scope:{projectId:string;sessionId:string},kind:string,prefix:string,parse:(input:unknown)=>T,sameReservation:(held:T,released:T)=>boolean):T|null{
 try{
  // Detect a damaged kind or key rather than letting either hide a live fence from this lookup.
  const rows=store.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND (kind=? OR idempotency_key GLOB ?) ORDER BY rowid DESC LIMIT 2').all(scope.projectId,scope.sessionId,kind,prefix+'*') as {id:unknown}[];
  if(!rows.length)return null;
  const entries=rows.map(row=>{
   if(typeof row.id!=='string')throw new InvalidFence('invalid id');
   const op=store.getOperation(row.id,scope);let value:T;
   try{value=parse(op.input);}catch{throw new InvalidFence('invalid fence input');}
   if(op.kind!==kind||op.idempotencyKey!==prefix+value.revision||op.state!=='pending'||op.receiptPresent)throw new InvalidFence('invalid fence operation');
   const links=store.db.prepare('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2').all(op.id) as {id:string}[];
   if(links.length!==1)throw new InvalidFence('invalid fence outbox');
   const out=store.getOutbox(links[0].id,scope),payload=out.payload;
   if(out.operationId!==op.id||out.kind!==kind||out.state!=='pending'||out.receiptPresent||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).sort().join(',')!=='revision,version'||(payload as {version?:unknown}).version!==1||(payload as {revision?:unknown}).revision!==value.revision||op.inputDigest!==operationDigest(op.kind,{input:op.input,outbox:{kind:out.kind,payload:out.payload}}))throw new InvalidFence('invalid fence evidence');
   return value;
  });
  const latest=entries[0],previous=entries[1];
  if(!previous){if(latest.revision!==1||latest.state!=='held')throw new InvalidFence('missing predecessor');}
  else{
   if(latest.revision!==previous.revision+1||(previous.revision===1&&previous.state!=='held'))throw new InvalidFence('invalid sequence');
   if(previous.state==='held'){
    if(latest.state!=='released'||latest.token!==previous.token||!sameReservation(previous,latest))throw new InvalidFence('invalid release');
   }else if(latest.state!=='held'||latest.token===previous.token)throw new InvalidFence('invalid acquisition');
  }
  return Object.freeze({...latest});
 }catch(error){
  if(error instanceof InvalidFence||(error instanceof ControlStoreError&&['CORRUPT','NOT_FOUND','SCOPE'].includes(error.code)))throw new ForkError('The fork fence or its recent history is corrupt; dispatch and recovery are refused.','CORRUPT');
  throw new ForkError('The fork fence could not be verified; dispatch and recovery are refused.','STORAGE');
 }
}
