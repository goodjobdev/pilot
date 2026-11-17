import {createHash} from 'node:crypto';
import {ControlStore,ControlStoreError,operationDigest} from './control-store';
import {parseRunnerServiceRequest} from './runner-service-admission';
import {RunnerServicePolicyStore} from './runner-service-policy';

const projectId='runner-service-budgets',kind='runner-service.budget';
/**
 * Service-owned, per-agent rolling-hour reservations. Policy authorization, counting and recording
 * occur under one SQLite writer lock. A reservation is never refunded, even if job admission or
 * execution fails. This relies on the host wall clock and an inaccessible service store; it is not
 * the application's own agent budget and cannot authenticate a peer or prove snapshot provenance.
 */
export class RunnerServiceBudgetStore{
 private readonly policy:RunnerServicePolicyStore;
 constructor(private readonly store:ControlStore){this.policy=new RunnerServicePolicyStore(store);}
 reserve(input:unknown):{existing:boolean}{
  const request=parseRunnerServiceRequest(input),now=Date.now();
  if(!Number.isFinite(now))throw new Error('Runner budget clock unavailable.');
  const since=new Date(now-60*60*1000).toISOString(),scope={projectId,sessionId:request.agentId};
  const idempotencyKey='runner-service-budget.'+createHash('sha256').update(request.jobId).digest('hex');
  const admitted=this.store.admit({scope,idempotencyKey,kind,input:request,outbox:{kind,payload:{version:1,jobId:request.jobId}},guard:()=>{
   const policy=this.policy.read();
   if(!policy||!this.policy.allows(request))throw new ControlStoreError('Runner service policy refused the job.','CONFLICT');
   let cursor:number|null=null,count=0,total=0,existing=false;
   try{
    for(;;){
     const rows=(cursor===null?this.store.db.prepare('SELECT rowid,id FROM operations WHERE project_id=? AND session_id=? ORDER BY rowid LIMIT 64').all(scope.projectId,scope.sessionId):this.store.db.prepare('SELECT rowid,id FROM operations WHERE project_id=? AND session_id=? AND rowid>? ORDER BY rowid LIMIT 64').all(scope.projectId,scope.sessionId,cursor)) as {rowid:number;id:string}[];
     if(!rows.length)break;
     for(const row of rows){
      cursor=row.rowid;const op=this.store.getOperation(row.id,scope),stored=parseRunnerServiceRequest(op.input),links=this.store.db.prepare('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2').all(op.id) as {id:string}[];
      if(links.length!==1)throw Error();
      const out=this.store.getOutbox(links[0].id,scope),payload=out.payload;
      if(stored.agentId!==request.agentId||op.kind!==kind||op.idempotencyKey!=='runner-service-budget.'+createHash('sha256').update(stored.jobId).digest('hex')||op.state!=='pending'||op.revision!==1||op.receiptPresent||out.kind!==kind||out.operationId!==op.id||out.state!=='pending'||out.revision!==1||out.receiptPresent||op.createdAt!==op.updatedAt||op.createdAt!==out.createdAt||op.createdAt!==out.updatedAt||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).sort().join(',')!=='jobId,version'||(payload as {version?:unknown}).version!==1||(payload as {jobId?:unknown}).jobId!==stored.jobId||op.inputDigest!==operationDigest(kind,{input:op.input,outbox:{kind:out.kind,payload}}))throw Error();
      total++;if(op.createdAt>=since)count++;if(op.idempotencyKey===idempotencyKey)existing=true;
     }
     if(rows.length<64)break;
    }
    const linked=this.store.db.prepare('SELECT COUNT(*) AS total FROM outboxes WHERE project_id=? AND session_id=?').get(scope.projectId,scope.sessionId) as {total:number};
    if(Number(linked.total)!==total)throw Error();
   }catch{throw new ControlStoreError('Runner service budget evidence could not be verified.','CORRUPT');}
   if(existing)return; // Same job never consumes a second slot; the admission digest is still checked.
   if(count>=policy.maxJobsPerHour)throw new ControlStoreError('The service agent job budget is exhausted.','CONFLICT');
  }});
  return {existing:admitted.existing};
 }
}
