import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ACCEPTANCE_ACTION_CLASSES,parseArtifactIdentity} from '../../shared/acceptance';
import {canonicalJson} from '../../shared/control-state';
import {parseAgentIdentifier} from '../../shared/agent-registry';
import {ControlStore,operationDigest} from './control-store';
import {targetBoundArtifact} from './accepted-action';

const id=z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const intentSchema=z.strictObject({projectId:id,sessionId:id,agentId:id,evidenceId:id,acceptanceId:id,actionClass:z.enum(ACCEPTANCE_ACTION_CLASSES),artifact:z.unknown(),contentRevision:z.string(),targetId:id,targetRevision:z.number().int().positive().safe(),targetDigest:digest,resourceKey:z.string().regex(/^resource-[a-f0-9]{64}$/).optional()});
const payloadSchema=z.strictObject({version:z.literal(1),acceptanceId:id});
const receiptSchema=z.strictObject({targetId:id,artifact:z.unknown(),externalId:id});
const failureSchema=z.strictObject({status:z.literal('not-started')});
export type AcceptedActionHistoryItem={id:string;revision:number;actionClass:string;state:'uncertain'|'not-started'|'receipt-recorded';agentId:string;sessionId:string;targetId:string;targetRevision:number;artifact:{revision:string;commit:string|null};receiptCommit:string|null;createdAt:string;updatedAt:string};

/** Validates one action against the current store snapshot. Caller controls any transaction. */
export function readAcceptedActionItem(store:ControlStore,projectId:string,operationId:string):AcceptedActionHistoryItem{
  const scope={projectId,sessionId:'accepted-actions'};
  const op=store.getOperation(operationId,scope),intent=intentSchema.parse(op.input),artifact=parseArtifactIdentity(intent.artifact);
  if(intent.projectId!==projectId||op.kind!=='accepted.action'||intent.actionClass==='deploy'&&!intent.resourceKey)throw Error('Invalid action history.');
  const expected=targetBoundArtifact({...intent,commit:artifact.commit});
  if(artifact.revision!==expected.revision||op.idempotencyKey!=='accepted-action.'+createHash('sha256').update(artifact.revision).digest('hex'))throw Error('Invalid action binding.');
  const links=store.db.prepare('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2').all(op.id) as {id:string}[];
  if(links.length!==1)throw Error('Invalid action outbox.');
  const out=store.getOutbox(links[0].id,scope),payload=payloadSchema.parse(out.payload);
  if(out.operationId!==op.id||out.kind!=='accepted.action'||payload.acceptanceId!==intent.acceptanceId||op.inputDigest!==operationDigest(op.kind,{input:op.input,outbox:{kind:out.kind,payload:out.payload}})||op.receiptPresent!==out.receiptPresent||(op.receiptPresent&&canonicalJson(op.receipt)!==canonicalJson(out.receipt)))throw Error('Invalid action evidence.');
  let state:AcceptedActionHistoryItem['state']='uncertain',receiptCommit:string|null=null;
  if(op.state==='succeeded'&&op.receiptPresent){
    const receipt=receiptSchema.parse(op.receipt),identity=parseArtifactIdentity(receipt.artifact);
    if(receipt.targetId!==intent.targetId||identity.revision!==artifact.revision||identity.commit!==artifact.commit)throw Error('Invalid action receipt.');
    state='receipt-recorded';
    // Never echo arbitrary external IDs: they can contain provider/account information or secrets.
    if((intent.actionClass==='commit'||intent.actionClass==='push')&&/^[a-f0-9]{40,64}$/.test(receipt.externalId))receiptCommit=receipt.externalId;
  // Only the direct pending→failed transition can prove the executor's pre-dispatch refusal.
  // A later failed record may follow an unknown effect and must remain uncertain.
  }else if(op.state==='failed'&&op.revision===2&&op.receiptPresent&&failureSchema.safeParse(op.receipt).success)state='not-started';
  return {id:op.id,revision:op.revision,actionClass:intent.actionClass,state,agentId:intent.agentId,sessionId:intent.sessionId,targetId:intent.targetId,targetRevision:intent.targetRevision,artifact,receiptCommit,createdAt:op.createdAt,updatedAt:op.updatedAt};
}
export class ActionHistoryCursorError extends Error{}
/** Read-only owner projection. Never executes, retries, reconciles or releases a barrier. */
export function acceptedActionHistory(store:ControlStore,project:unknown,before?:string):{projectId:string;items:AcceptedActionHistoryItem[];truncated:boolean;nextBefore:string|null}{
  const projectId=parseAgentIdentifier(project),scope={projectId,sessionId:'accepted-actions'};
  store.db.exec('BEGIN');
  try{
    let rows:{id:string}[];
    if(before!==undefined){
      if(!z.string().uuid().safeParse(before).success)throw new ActionHistoryCursorError('Invalid action history cursor.');
      const anchor=store.db.prepare("SELECT rowid FROM operations WHERE id=? AND project_id=? AND session_id=? AND kind='accepted.action'").get(before,projectId,scope.sessionId) as {rowid:number}|undefined;
      if(!anchor)throw new ActionHistoryCursorError('Invalid action history cursor.');
      rows=store.db.prepare("SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind='accepted.action' AND rowid<? ORDER BY rowid DESC LIMIT 51").all(projectId,scope.sessionId,anchor.rowid) as {id:string}[];
    }else rows=store.db.prepare("SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind='accepted.action' ORDER BY rowid DESC LIMIT 51").all(projectId,scope.sessionId) as {id:string}[];
    const items=rows.slice(0,50).map(({id:operationId})=>readAcceptedActionItem(store,projectId,operationId));
    store.db.exec('COMMIT');
    return {projectId,items,truncated:rows.length>50,nextBefore:rows.length>50?items[items.length-1].id:null};
  }catch(error){try{store.db.exec('ROLLBACK');}catch{}throw error;}
}
