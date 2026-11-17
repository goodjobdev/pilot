import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {RunnerServiceAdmission,parseRunnerServiceRequest,type RunnerServiceRequest} from './runner-service-admission';
import {RunnerServicePolicyStore} from './runner-service-policy';
import {RunnerServiceBudgetStore} from './runner-service-budget';
import {validateRunnerSnapshot} from './runner-snapshot';
import {ControlStore} from './control-store';
import {materializeRunnerSnapshot} from './runner-snapshot-materialize';

type RuntimeResult={readonly exitCode:number;readonly stdout:Uint8Array;readonly stderr:Uint8Array};
/** Trusted service-local runtime port; the port, not this interface, must prove actual containment. */
export type RunnerServiceRuntime={run(input:{readonly operationId:string;readonly directory:string;readonly recipe:'test-run';readonly limits:Readonly<RunnerServiceRequest['limits']>;readonly signal:AbortSignal}):Promise<RuntimeResult>};
type Answer={readonly status:'completed'|'uncertain'|'existing';readonly operationId:string};
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/**
 * Uninstalled service-side orchestration, not a server, client transport, policy store or real
 * runtime. Configuration, the private control store and runtime are trusted service-owned inputs. Admission is
 * durable before materialization/execution; a duplicate is inspection-only. An abort, lost result,
 * failed verification or unconfirmed termination is uncertain and cannot be automatically replayed.
 * No path or runtime error is returned. Caller must independently authenticate the peer and cap its
 * input before parsing. The runtime must enforce all declared bounds and a read-only snapshot mount.
 */
export class RunnerService{
 private readonly journal:RunnerServiceAdmission;
 private readonly policy:RunnerServicePolicyStore;
 private readonly budget:RunnerServiceBudgetStore;
 constructor(control:ControlStore,private readonly config:{privateRoot:string;applicationUid:number},private readonly runtime:RunnerServiceRuntime){
  this.journal=new RunnerServiceAdmission(control);this.policy=new RunnerServicePolicyStore(control);this.budget=new RunnerServiceBudgetStore(control);
 }
 /** Inspection never reconciles, releases the barrier, or implies absent work is safe to retry. */
 inspectJob(requestInput:unknown){
  const request=parseRunnerServiceRequest(requestInput),job=this.journal.inspectRequest(request);
  if(!job)return {jobId:request.jobId,status:'unavailable' as const,operationId:null,receipt:null};
  if(job.outcomeUncertain)return {jobId:request.jobId,status:'uncertain' as const,operationId:job.operationId,receipt:null};
  return {jobId:request.jobId,status:'receipt-recorded' as const,operationId:job.operationId,receipt:job.receipt};
 }
 async start(requestInput:unknown,snapshotInput:unknown,signal?:AbortSignal):Promise<Answer>{
  if(signal?.aborted)throw Error('The request was cancelled before admission.');
  const requested=parseRunnerServiceRequest(requestInput),validated=validateRunnerSnapshot(snapshotInput);
  if(validated.digest!==requested.snapshotDigest)throw Error('Snapshot bytes do not match the requested identity.');
  this.budget.reserve(requested);
  if(signal?.aborted)throw Error('The request was cancelled after budget reservation and before job admission.');
  const admission=this.journal.admitSnapshot(requested,snapshotInput,request=>this.policy.allows(request));
  const operationId=admission.operationId;
  if(!admission.first)return {status:'existing',operationId};
  const uncertain=():Answer=>{try{this.journal.markUnknown(operationId);}catch{/* pending remains inspection-only */}return {status:'uncertain',operationId};};
  try{
   const request=this.journal.inspect(operationId).request;
   const snapshot=await materializeRunnerSnapshot(this.config,snapshotInput,request.snapshotDigest,signal);
   if(signal?.aborted||!this.policy.allows(request))return uncertain();
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
   const interrupted=new Promise<{kind:'interrupted'}>(resolve=>{
    abort=()=>{controller.abort();resolve({kind:'interrupted'});};
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(abort,request.limits.timeoutMs);
    if(signal?.aborted)abort();
   });
   const started=performance.now();
   const execution=Promise.resolve().then(async()=>{
    // Recheck in the dispatch microtask, immediately before invoking the runtime. Another process
    // can revoke after this check but before invocation, or after the invocation has been issued.
    if(controller.signal.aborted||!this.policy.allows(request))return {kind:'interrupted' as const};
    const result=await this.runtime.run({operationId,directory:snapshot.directory,recipe:request.recipe,limits:Object.freeze({...request.limits}),signal:controller.signal});
    return {kind:'result' as const,result};
   }).catch(()=>({kind:'failed' as const}));
   const outcome=await Promise.race([interrupted,execution]);
   if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);
   if(outcome.kind!=='result'||signal?.aborted||controller.signal.aborted)return uncertain();
   const {exitCode,stdout,stderr}=outcome.result;
   if(!Number.isInteger(exitCode)||exitCode<0||exitCode>255||!(stdout instanceof Uint8Array)||!(stderr instanceof Uint8Array)||stdout.byteLength+stderr.byteLength>request.limits.outputBytes)return uncertain();
   this.journal.recordResult(operationId,{snapshotDigest:request.snapshotDigest,exitCode,stdoutDigest:sha256(stdout),stderrDigest:sha256(stderr),stdoutBytes:stdout.byteLength,stderrBytes:stderr.byteLength,durationMs:Math.max(0,Math.floor(performance.now()-started))});
   return {status:'completed',operationId};
  }catch{return uncertain();}
 }
}
