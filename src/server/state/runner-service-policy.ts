import {z} from 'zod';
import {RUNNER_LIMIT_BOUNDS} from '../../shared/runner';
import {ControlStore,ControlStoreError,operationDigest} from './control-store';
import type {RunnerServiceRequest} from './runner-service-admission';

const id=z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const bounded=(b:{min:number;max:number})=>z.number().int().min(b.min).max(b.max);
const limits=z.strictObject({timeoutMs:bounded(RUNNER_LIMIT_BOUNDS.timeoutMs),outputBytes:bounded(RUNNER_LIMIT_BOUNDS.outputBytes),memoryBytes:bounded(RUNNER_LIMIT_BOUNDS.memoryBytes),cpus:bounded(RUNNER_LIMIT_BOUNDS.cpus),pids:bounded(RUNNER_LIMIT_BOUNDS.pids)});
const target=z.strictObject({agentId:id,projectId:id,sessionId:id,workspaceId:id});
const policy=z.strictObject({version:z.literal(1),revision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),enabled:z.boolean(),targets:z.array(target).max(100),limits,maxJobsPerHour:z.number().int().min(1).max(1000)}).superRefine((value,ctx)=>{
 const seen=new Set<string>(),sessions=new Map<string,string>();for(const item of value.targets){const key=JSON.stringify([item.projectId,item.sessionId,item.workspaceId]),session=JSON.stringify([item.projectId,item.sessionId]);if(seen.has(key))ctx.addIssue({code:'custom',message:'Duplicate runner target.'});if(sessions.has(session)&&sessions.get(session)!==item.agentId)ctx.addIssue({code:'custom',message:'A session cannot be assigned to multiple agents.'});seen.add(key);sessions.set(session,item.agentId);}
});
const change=z.strictObject({expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),enabled:z.boolean(),targets:z.array(target).max(100),limits,maxJobsPerHour:z.number().int().min(1).max(1000)});
export type RunnerServicePolicy=z.infer<typeof policy>;
const scope={projectId:'runner-service',sessionId:'runner-service-policy'} as const;
const kind='runner-service.policy',prefix='runner-service-policy.r';

/**
 * Uninstalled service-local policy. The service operator alone must control this store and its
 * update path; using the application's database gives no independent authorization. Exact targets
 * and a request-bound revision prevent ordinary revoke-and-restore ABA. A target is still only an
 * identity assertion: this policy does not prove snapshot origin or authenticate a transport peer.
 */
export class RunnerServicePolicyStore{
 constructor(private readonly store:ControlStore){}
 read():RunnerServicePolicy|null{
  const own=!this.store.db.isTransaction;
  if(own)this.store.db.exec('BEGIN');
  try{const result=this.readSnapshot();if(own)this.store.db.exec('COMMIT');return result;}
  catch(error){if(own)try{this.store.db.exec('ROLLBACK');}catch{}throw error;}
 }
 private readSnapshot():RunnerServicePolicy|null{
  try{
   let cursor:number|null=null,last:RunnerServicePolicy|null=null,count=0;
   for(;;){
    const rows=(cursor===null?this.store.db.prepare('SELECT rowid,id FROM operations WHERE project_id=? AND session_id=? ORDER BY rowid LIMIT 64').all(scope.projectId,scope.sessionId):this.store.db.prepare('SELECT rowid,id FROM operations WHERE project_id=? AND session_id=? AND rowid>? ORDER BY rowid LIMIT 64').all(scope.projectId,scope.sessionId,cursor)) as {rowid:number;id:string}[];
    if(!rows.length)break;
    for(const row of rows){
     cursor=row.rowid;const op=this.store.getOperation(row.id,scope),value=policy.parse(op.input);count++;
     const links=this.store.db.prepare('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2').all(op.id) as {id:string}[];
     if(links.length!==1)throw Error();
     const out=this.store.getOutbox(links[0].id,scope),payload=out.payload;
     if(value.revision!==count||op.kind!==kind||op.idempotencyKey!==prefix+value.revision||op.state!=='pending'||op.revision!==1||op.receiptPresent||out.kind!==kind||out.operationId!==op.id||out.state!=='pending'||out.revision!==1||out.receiptPresent||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).sort().join(',')!=='revision,version'||(payload as {version?:unknown}).version!==1||(payload as {revision?:unknown}).revision!==value.revision||op.inputDigest!==operationDigest(kind,{input:op.input,outbox:{kind:out.kind,payload}}))throw Error();
     last=value;
    }
    if(rows.length<64)break;
   }
   const outboxCount=this.store.db.prepare('SELECT COUNT(*) AS total FROM outboxes WHERE project_id=? AND session_id=?').get(scope.projectId,scope.sessionId) as {total:number};
   if(Number(outboxCount.total)!==count)throw Error();
   return last;
  }catch(error){if(error instanceof ControlStoreError&&error.code!=='CORRUPT'&&error.code!=='NOT_FOUND'&&error.code!=='SCOPE')throw error;throw new ControlStoreError('Runner service policy could not be verified.','CORRUPT');}
 }
 /** Out-of-band trusted owner operation, never exposed to the requesting app. */
 update(input:unknown):RunnerServicePolicy{
  const request=change.parse(input),next=policy.parse({version:1,revision:request.expectedRevision+1,enabled:request.enabled,targets:request.targets,limits:request.limits,maxJobsPerHour:request.maxJobsPerHour});
  const admitted=this.store.admit({scope,idempotencyKey:prefix+next.revision,kind,input:next,outbox:{kind,payload:{version:1,revision:next.revision}},guard:()=>{
   if((this.read()?.revision??0)!==request.expectedRevision)throw new ControlStoreError('Runner service policy revision changed.','CONFLICT');
  }});
  if(admitted.existing)throw new ControlStoreError('Runner service policy revision changed.','CONFLICT');
  return next;
 }
 allows(request:Readonly<RunnerServiceRequest>):boolean{
  const current=this.read();
  return !!current&&current.enabled&&current.revision===request.policyRevision&&current.targets.some(target=>target.agentId===request.agentId&&target.projectId===request.projectId&&target.sessionId===request.sessionId&&target.workspaceId===request.workspaceId)&&Object.keys(current.limits).every(key=>request.limits[key as keyof typeof current.limits]<=current.limits[key as keyof typeof current.limits]);
 }
}
