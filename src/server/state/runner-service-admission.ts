import {createHash} from 'node:crypto';
import {z} from 'zod';
import {RUNNER_LIMIT_BOUNDS} from '../../shared/runner';
import {ControlStore,ControlStoreError,operationDigest} from './control-store';
import {canonicalJson} from '../../shared/control-state';
import {validateRunnerSnapshot,type RunnerSnapshot} from './runner-snapshot';

/**
 * Experimental admission journal for a separately managed runner. It is not installed, does not
 * expose a transport, open a runtime, resolve a workspace or authorize an app request. A future
 * service must open its OWN private ControlStore; sharing the app's store does not establish an
 * independent trust boundary. The service must bind workspaceId and snapshotDigest to a verified
 * immutable workspace handoff before using this journal. They are identities, not paths or proof.
 *
 * A first admission is durable before an effect may be attempted. Every duplicate, including one
 * after a restart, is inspection-only. A pending record may have executed; it must never be replayed.
 */
const id=z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const bounded=(bounds:{min:number;max:number})=>z.number().int().min(bounds.min).max(bounds.max);
const requestSchema=z.strictObject({
  jobId:id,agentId:id,projectId:id,sessionId:id,workspaceId:id,policyRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),snapshotDigest:digest,
  recipe:z.literal('test-run'),
  limits:z.strictObject({timeoutMs:bounded(RUNNER_LIMIT_BOUNDS.timeoutMs),outputBytes:bounded(RUNNER_LIMIT_BOUNDS.outputBytes),memoryBytes:bounded(RUNNER_LIMIT_BOUNDS.memoryBytes),cpus:bounded(RUNNER_LIMIT_BOUNDS.cpus),pids:bounded(RUNNER_LIMIT_BOUNDS.pids)})
});
const payloadSchema=z.strictObject({version:z.literal(1),jobId:id});
const receiptSchema=z.strictObject({snapshotDigest:digest,exitCode:z.number().int().min(0).max(255),stdoutDigest:digest,stderrDigest:digest,stdoutBytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),stderrBytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),durationMs:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
export type RunnerServiceRequest=z.infer<typeof requestSchema>;
export const parseRunnerServiceRequest=(value:unknown):RunnerServiceRequest=>requestSchema.parse(value);
export type RunnerServiceReceipt=z.infer<typeof receiptSchema>;
const scope=Object.freeze({projectId:'runner-service',sessionId:'runner-service-jobs'});
const kind='runner-service.job',outbox='runner-service.attempt';
const key=(jobId:string)=>'runner-service.'+createHash('sha256').update(jobId).digest('hex');

/** All methods are internal-only; a caller must independently authenticate and authorize peers. */
export class RunnerServiceAdmission {
  constructor(private readonly store:ControlStore){}
  /** The guard is service-side and synchronous, and runs under the journal's SQLite writer lock. */
  admit(value:unknown,authorize:(request:Readonly<RunnerServiceRequest>)=>boolean):{operationId:string;first:boolean;state:string}{
    const request=requestSchema.parse(value);
    if(typeof authorize!=='function')throw new Error('A service-local authorization guard is required.');
    const idempotencyKey=key(request.jobId);
    const admitted=this.store.admit({scope,idempotencyKey,kind,input:request,outbox:{kind:outbox,payload:{version:1,jobId:request.jobId}},guard:()=>{
      const verdict:unknown=authorize(Object.freeze({...request,limits:Object.freeze({...request.limits})}));
      if(verdict&&typeof (verdict as {then?:unknown}).then==='function')void Promise.resolve(verdict).catch(()=>{});
      if(verdict!==true)throw new Error('Service authorization refused.');
      // One in-flight OR uncertain job blocks the whole service. The same identity may only inspect;
      // the store still compares its complete request digest after this guard. This deliberately
      // sacrifices availability until a separately reviewed recovery protocol exists.
      this.assertBarrier(idempotencyKey);
    }});
    return {operationId:admitted.operation.id,first:!admitted.existing,state:admitted.operation.state};
  }
  /** Validate supplied bytes and bind their computed digest before durable admission. This is not
   * proof that the bytes came from a Git commit, nor does it make an untrusted transport safe. */
  admitSnapshot(value:unknown,snapshotInput:unknown,authorize:(request:Readonly<RunnerServiceRequest>)=>boolean):{operationId:string;first:boolean;state:string;snapshot:RunnerSnapshot}{
    const request=requestSchema.parse(value),snapshot=validateRunnerSnapshot(snapshotInput);
    if(request.snapshotDigest!==snapshot.digest)throw new Error('Snapshot bytes do not match the admitted identity.');
    return {...this.admit(request,authorize),snapshot};
  }
  /** The caller holds a read or write transaction across all linked evidence reads. */
  private checked(operationId:string){
    try {
      const operation=this.store.getOperation(operationId,scope),request=requestSchema.parse(operation.input);
      const links=this.store.db.prepare('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2').all(operation.id) as {id:string}[];
      if(links.length!==1)throw Error('Invalid outbox linkage');
      const out=this.store.getOutbox(links[0].id,scope),payload=payloadSchema.parse(out.payload);
      const receipt=operation.receiptPresent?receiptSchema.parse(operation.receipt):null;
      if(operation.kind!==kind||operation.idempotencyKey!==key(request.jobId)||out.kind!==outbox||out.operationId!==operation.id||out.state!=='pending'||payload.jobId!==request.jobId||operation.inputDigest!==operationDigest(kind,{input:operation.input,outbox:{kind:out.kind,payload:out.payload}})||operation.receiptPresent!==out.receiptPresent||(receipt!==null&&canonicalJson(receipt)!==canonicalJson(out.receipt)))throw Error('Invalid job binding');
      if(operation.state==='pending'&&(operation.revision!==1||receipt!==null||out.revision!==1))throw Error('Invalid pending job');
      if(operation.state==='unknown'&&(operation.revision!==2||receipt!==null||out.revision!==1))throw Error('Invalid uncertain job');
      if(operation.state==='succeeded'&&(operation.revision!==2||receipt===null||out.revision!==2||receipt.snapshotDigest!==request.snapshotDigest||receipt.stdoutBytes+receipt.stderrBytes>request.limits.outputBytes))throw Error('Invalid job receipt');
      if(!['pending','unknown','succeeded'].includes(operation.state))throw Error('Invalid job state');
      return {operationId:operation.id,state:operation.state,request,receipt,outcomeUncertain:operation.state==='pending'||operation.state==='unknown'};
    }catch{throw new ControlStoreError('Runner job evidence could not be verified.','CORRUPT');}
  }
  /** Verify every record in the exclusive job scope before deciding that the barrier is clear. */
  private assertBarrier(currentKey:string){
    let cursor:number|null=null;
    for(;;){
      const rows=(cursor===null?this.store.db.prepare('SELECT rowid,id FROM operations WHERE project_id=? AND session_id=? ORDER BY rowid LIMIT 64').all(scope.projectId,scope.sessionId):this.store.db.prepare('SELECT rowid,id FROM operations WHERE project_id=? AND session_id=? AND rowid>? ORDER BY rowid LIMIT 64').all(scope.projectId,scope.sessionId,cursor)) as {rowid:number;id:string}[];
      if(!rows.length)break;
      for(const row of rows){cursor=row.rowid;const job=this.checked(row.id);if(job.outcomeUncertain&&key(job.request.jobId)!==currentKey)throw new ControlStoreError('A runner job is in progress or uncertain; operator review is required.','CONFLICT');}
      if(rows.length<64)break;
    }
    // Detect an operation moved out of the scope while its linked outbox remains here.
    cursor=null;
    for(;;){
      const rows=(cursor===null?this.store.db.prepare('SELECT rowid,operation_id FROM outboxes WHERE project_id=? AND session_id=? ORDER BY rowid LIMIT 64').all(scope.projectId,scope.sessionId):this.store.db.prepare('SELECT rowid,operation_id FROM outboxes WHERE project_id=? AND session_id=? AND rowid>? ORDER BY rowid LIMIT 64').all(scope.projectId,scope.sessionId,cursor)) as {rowid:number;operation_id:string}[];
      if(!rows.length)break;
      for(const row of rows){cursor=row.rowid;this.checked(row.operation_id);}
      if(rows.length<64)break;
    }
  }
  /** Read-only inspection; pending and unknown both mean an effect may have happened. */
  inspect(operationId:string){
    this.store.db.exec('BEGIN');
    try {const result=this.checked(operationId);this.store.db.exec('COMMIT');return result;}
    catch(error){try{this.store.db.exec('ROLLBACK');}catch{}throw error;}
  }
  /** Read-only exact-request lookup; absence does not prove a submitted job could not still start. */
  inspectRequest(value:unknown){
    const request=requestSchema.parse(value);
    this.store.db.exec('BEGIN');
    try{
      const row=this.store.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND idempotency_key=?').get(scope.projectId,scope.sessionId,key(request.jobId)) as {id:string}|undefined;
      const result=row?this.checked(row.id):null;
      const exact=result!==null&&canonicalJson(result.request)===canonicalJson(request)?result:null;
      this.store.db.exec('COMMIT');return exact;
    }catch(error){try{this.store.db.exec('ROLLBACK');}catch{}throw error;}
  }
  /** Record a verified completed process result, not a timeout or a claim of containment. */
  recordResult(operationId:string,value:unknown){
    const job=this.inspect(operationId),receipt=receiptSchema.parse(value);
    if(receipt.snapshotDigest!==job.request.snapshotDigest)throw new Error('The receipt does not match the admitted snapshot.');
    if(receipt.stdoutBytes+receipt.stderrBytes>job.request.limits.outputBytes)throw new Error('The receipt exceeds the admitted output limit.');
    // updateOperation is a single-use compare-and-swap; never turn an uncertain prior attempt into
    // success merely from a new submission. A recovery design needs independent trusted evidence.
    if(job.state!=='pending')throw new Error('This job is no longer awaiting its first result.');
    this.store.updateOperation(operationId,scope,1,'succeeded',receipt);
    return this.inspect(operationId);
  }
  /** Explicitly retain uncertainty, never release or re-execute an admitted identity. */
  markUnknown(operationId:string){
    const job=this.inspect(operationId);
    if(job.state!=='pending')throw new Error('This job is no longer pending.');
    this.store.updateOperation(operationId,scope,1,'unknown');
    return this.inspect(operationId);
  }
}
