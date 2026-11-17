import {parseRunnerServiceRequest,type RunnerServiceRequest} from './runner-service-admission';
import {RunnerServicePolicyStore} from './runner-service-policy';
import {RunnerServiceBudgetStore} from './runner-service-budget';
import {ControlStore} from './control-store';
import {RunnerSupervisorJournal,type RunnerSupervisorJob,type RunnerSupervisorStage} from './runner-supervisor-journal';

/**
 * Promise-returning methods do not constrain their synchronous prefix. The journal invokes that prefix
 * under its writer lock to serialize cancellation; a blocking port stalls the event loop/lock, so this
 * prototype cannot promise timely cancellation or deadline response.
 */
export type RunnerSupervisorRuntime={
 create(input:{readonly request:Readonly<RunnerServiceRequest>;readonly requestDigest:string;readonly deadlineMs:number}):Promise<{readonly runtimeId:string;readonly requestDigest:string}>;
 start(input:{readonly runtimeId:string;readonly requestDigest:string;readonly deadlineMs:number}):Promise<{readonly runtimeId:string;readonly requestDigest:string;readonly started:true}>;
 inspect(input:{readonly runtimeId:string}):Promise<{readonly runtimeId:string;readonly requestDigest:string;readonly state:'created'|'running'|'exited'|'unavailable'|'mismatch'}>;
};
export type RunnerSupervisorResult={job:RunnerSupervisorJob|null;status:'admitted'|'uncertain'|'running'|'existing';runtimeState?:'created'|'running'|'exited'|'unavailable'|'mismatch'};

/** Uninstalled staged coordinator. It is not wired to an endpoint or real runtime. */
export class RunnerSupervisor{
 private readonly policy:RunnerServicePolicyStore;
 private readonly budget:RunnerServiceBudgetStore;
 constructor(private readonly control:ControlStore,private readonly journal:RunnerSupervisorJournal,private readonly runtime:RunnerSupervisorRuntime,private readonly clock:()=>number=Date.now){
  this.policy=new RunnerServicePolicyStore(control);this.budget=new RunnerServiceBudgetStore(control);
 }
 async submit(value:unknown):Promise<RunnerSupervisorResult>{
  const request=parseRunnerServiceRequest(value);
  if(!this.policy.allows(request))throw new Error('Runner service policy refused the job.');
  // These stores cannot participate in one SQLite transaction. A budget reservation may be spent
  // if the journal admission fails; it is intentionally never refunded. Journal admission is the
  // sole dispatch authority and duplicate admission never resumes an earlier stage. Policy is
  // rechecked immediately before both port invocations below, but revocation after either check can
  // race with the separate journal dispatch transaction and is not atomically enforced.
  this.budget.reserve(request);
  const admission=this.journal.admit(request,()=>this.clock());
  if(!admission.first)return {job:admission.job,status:'existing'};
  let job=admission.job;
  job=this.journal.transition(job.jobId,'admitted','create-intent');
  let createDispatch:{job:RunnerSupervisorJob;effect:Promise<{runtimeId:string;requestDigest:string}>}|undefined;
  const createOutcome=await this.beforeDeadline(()=>{
   createDispatch=this.journal.dispatchCreate(job.jobId,this.clock,()=>this.policy.allows(request),()=>this.runtime.create({request:Object.freeze({...request,limits:Object.freeze({...request.limits})}),requestDigest:job.requestDigest,deadlineMs:job.deadlineMs}));
   return createDispatch.effect;
  },job.deadlineMs);
  if(createOutcome.kind!=='result')return this.uncertain(createDispatch?.job??job);
  job=createDispatch!.job;
  const created=createOutcome.value;
  if(!created||created.requestDigest!==job.requestDigest||typeof created.runtimeId!=='string')return this.uncertain(job);
  try{job=this.journal.transition(job.jobId,'create-dispatched','identity-recorded',created.runtimeId);}
  catch{return this.uncertain(job);}
  try{job=this.journal.transition(job.jobId,'identity-recorded','start-intent');}
  catch{return this.uncertain(job);}
  let startDispatch:{job:RunnerSupervisorJob;effect:Promise<{runtimeId:string;requestDigest:string;started:true}>}|undefined;
  const startOutcome=await this.beforeDeadline(()=>{
   startDispatch=this.journal.dispatchStart(job.jobId,this.clock,()=>this.policy.allows(request),()=>this.runtime.start({runtimeId:job.runtimeId!,requestDigest:job.requestDigest,deadlineMs:job.deadlineMs}));
   return startDispatch.effect;
  },job.deadlineMs);
  if(startOutcome.kind!=='result')return this.uncertain(startDispatch?.job??job);
  job=startDispatch!.job;
  const started=startOutcome.value;
  if(!started||started.runtimeId!==job.runtimeId||started.requestDigest!==job.requestDigest||started.started!==true)return this.uncertain(job);
  if(this.clock()>=job.deadlineMs)return this.uncertain(job);
  try{job=this.journal.transition(job.jobId,'start-dispatched','running');}
  catch{return this.uncertain(job);}
  if(this.clock()>=job.deadlineMs)return this.uncertain(job);
  return {job,status:'running'};
 }
 /** Inspection can query only the persisted immutable runtime ID; it never mutates or resumes a job. */
 async inspect(jobId:string):Promise<RunnerSupervisorResult>{
  const job=this.journal.inspect(jobId);if(!job)return {job:null,status:'uncertain'};
  if(!job.runtimeId)return {job,status:job.stage==='admitted'?'admitted':'uncertain'};
  try{
   const observed=await this.runtime.inspect({runtimeId:job.runtimeId});
   if(!observed||observed.runtimeId!==job.runtimeId||observed.requestDigest!==job.requestDigest||!['created','running','exited','unavailable','mismatch'].includes(observed.state))return {job,status:'uncertain',runtimeState:'mismatch'};
   return {job,status:'uncertain',runtimeState:observed.state};
  }catch{return {job,status:'uncertain',runtimeState:'unavailable'};}
 }
 /** No termination API exists here. Cancellation therefore records uncertainty, never a name-based kill. */
 requestCancellation(jobId:string):RunnerSupervisorJob{
  return this.journal.markUncertain(jobId);
 }
 private async beforeDeadline<T>(effect:()=>Promise<T>,deadlineMs:number):Promise<{kind:'result';value:T}|{kind:'uncertain'}>{
  const remaining=deadlineMs-this.clock();
  if(remaining<=0)return {kind:'uncertain'};
  let dispatched:Promise<T>;
  try{dispatched=effect();}catch{return {kind:'uncertain'};}
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const result=await Promise.race([
    dispatched.then(value=>({kind:'result' as const,value}),()=>({kind:'uncertain' as const})),
    new Promise<{kind:'uncertain'}>(resolve=>{timer=setTimeout(()=>resolve({kind:'uncertain'}),remaining);})
   ]);
   return result;
  }finally{if(timer)clearTimeout(timer);}
 }
 private uncertain(job:RunnerSupervisorJob):RunnerSupervisorResult{
  try{return {job:this.journal.markUncertain(job.jobId),status:'uncertain'};}
  catch{return {job:this.journal.inspect(job.jobId)??job,status:'uncertain'};}
 }
}
