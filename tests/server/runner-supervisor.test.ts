import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,lstat,mkdtemp,mkdir,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';
import {RunnerSupervisorJournal} from '../../src/server/state/runner-supervisor-journal';
import {RunnerSupervisor,type RunnerSupervisorRuntime} from '../../src/server/state/runner-supervisor';
import {parseRunnerServiceRequest} from '../../src/server/state/runner-service-admission';
const request=parseRunnerServiceRequest({jobId:'supervisor-job',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits:{timeoutMs:500,outputBytes:256,memoryBytes:64*1024*1024,cpus:1,pids:16}});
async function writable(path:string):Promise<void>{const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())return;await chmod(path,0o700);for(const child of await readdir(path))await writable(join(path,child));}
async function fixture(){
 const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-runner-supervisor-'));
 const control=new ControlStore(join(root,'control'));
 new RunnerServicePolicyStore(control).update({expectedRevision:0,enabled:true,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});
 const journal=new RunnerSupervisorJournal(join(root,'journal'));
 return {root,control,journal,close(){journal.close();control.close();},async remove(){await writable(root);await rm(root,{recursive:true,force:true});}};
}
const ack=(runtimeId:string,requestDigest:string)=>({runtimeId,requestDigest,started:true as const});
const stub=(overrides:Partial<RunnerSupervisorRuntime>={}):RunnerSupervisorRuntime=>({async create(input){return {runtimeId:'runtime-immutable-123',requestDigest:input.requestDigest};},async start(input){return ack(input.runtimeId,input.requestDigest);},async inspect(input){return {runtimeId:input.runtimeId,requestDigest:'unused',state:'running'};},...overrides});

// Keep the exact identity-recorded stage without a public journal transition/dispatch call.
// The trigger simulates failed writes after identity persistence; it never invokes a runtime effect.
async function supervisorAtIdentity(f:Awaited<ReturnType<typeof fixture>>,jobId:string,runtimeId:string){
 let starts=0;
 f.journal.db.exec(`CREATE TRIGGER fail_after_identity BEFORE UPDATE ON supervisor_jobs
  WHEN OLD.stage='identity-recorded' AND NEW.stage IN ('start-intent','uncertain')
  BEGIN SELECT RAISE(ABORT,'injected identity-stage write failure'); END`);
 const supervisor=new RunnerSupervisor(f.control,f.journal,stub({async create(i){return {runtimeId,requestDigest:i.requestDigest};},async start(i){starts++;return ack(i.runtimeId,i.requestDigest);}}),()=>500);
 const pending=supervisor.submit({...request,jobId});
 const bounded=async <T,>(promise:Promise<T>):Promise<T>=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('timed out waiting for identity-stage supervisor submit')),2000);})]);}
  finally{if(timer)clearTimeout(timer);}
 };
 try{
  const result=await bounded(pending);
  assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'identity-recorded');
  assert.equal(result.job?.runtimeId,runtimeId);assert.equal(starts,0);
  return {supervisor,job:result.job!};
 }finally{
  try{await bounded(pending.then(()=>undefined,()=>undefined));}
  finally{f.journal.db.exec('DROP TRIGGER fail_after_identity');}
 }
}

test('supervisor commits create intent, immutable ID, and start intent in order before each port effect',async()=>{
 const f=await fixture();try{
  const events:string[]=[];
  const runtime:RunnerSupervisorRuntime={async create(i){events.push(`create:${f.journal.inspect(i.request.jobId)?.stage}`);return {runtimeId:'runtime-immutable-123',requestDigest:i.requestDigest};},async start(i){events.push(`start:${f.journal.inspect(request.jobId)?.stage}:${i.runtimeId}`);return ack(i.runtimeId,i.requestDigest);},async inspect(i){events.push(`inspect:${i.runtimeId}`);return {runtimeId:i.runtimeId,requestDigest:f.journal.inspect(request.jobId)!.requestDigest,state:'running'};}};
  const supervisor=new RunnerSupervisor(f.control,f.journal,runtime,()=>1000),result=await supervisor.submit(request);
  assert.equal(result.status,'running');assert.deepEqual(events,['create:create-intent','start:start-intent:runtime-immutable-123']);
  assert.equal(result.job?.deadlineMs,1500);assert.equal(result.job?.runtimeId,'runtime-immutable-123');
  const inspected=await supervisor.inspect(request.jobId);assert.equal(inspected.status,'uncertain');assert.equal(inspected.runtimeState,'running');
  assert.deepEqual(events,['create:create-intent','start:start-intent:runtime-immutable-123','inspect:runtime-immutable-123']);
 }finally{f.close();await f.remove();}
});

test('every persisted crash-stage fixture reopens inspection-only and never repeats create or start',async()=>{
 for(const crashStage of ['admitted','create-intent','create-dispatched','identity-recorded','start-intent','start-dispatched','running'] as const){
  const f=await fixture();let creates=0,starts=0,journalClosed=false;
  try{
   // Fail all updates leaving this stage, including the uncertainty latch. The effect callback
   // can already have run before a dispatched-stage write fails; this is not a physical crash.
   if(crashStage!=='running')f.journal.db.exec(`CREATE TRIGGER stop_at_stage BEFORE UPDATE ON supervisor_jobs
    WHEN OLD.stage='${crashStage}' BEGIN SELECT RAISE(ABORT,'injected stage write failure'); END`);
   const runtime=stub({async create(i){creates++;return {runtimeId:'runtime-fixed-id',requestDigest:i.requestDigest};},async start(i){starts++;return ack(i.runtimeId,i.requestDigest);}});
   const supervisor=new RunnerSupervisor(f.control,f.journal,runtime,()=>2000);
   const pending=supervisor.submit(request);
   const bounded=async <T,>(promise:Promise<T>):Promise<T>=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`timed out at ${crashStage}`)),2000);})]);}
    finally{if(timer)clearTimeout(timer);}
   };
   try{
    if(crashStage==='admitted')await assert.rejects(bounded(pending),/injected stage write failure/);
    else{
     const result=await bounded(pending);
     assert.equal(result.status,crashStage==='running'?'running':'uncertain',crashStage);
     assert.equal(result.job?.stage,crashStage);
    }
   }finally{
    try{await bounded(pending.then(()=>undefined,()=>undefined));}
    finally{if(crashStage!=='running')f.journal.db.exec('DROP TRIGGER stop_at_stage');}
   }
   const expectedCreates=crashStage==='admitted'?0:1;
   const expectedStarts=['start-intent','start-dispatched','running'].includes(crashStage)?1:0;
   assert.equal(creates,expectedCreates,crashStage);assert.equal(starts,expectedStarts,crashStage);
   f.journal.close();journalClosed=true;
   const journal=new RunnerSupervisorJournal(join(f.root,'journal'));
   try{
    const reopened=new RunnerSupervisor(f.control,journal,runtime,()=>5000);
    const result=await reopened.submit(request);assert.equal(result.status,'existing',crashStage);
    assert.equal(creates,expectedCreates);assert.equal(starts,expectedStarts);
    assert.equal(result.job?.deadlineMs,2500);assert.equal(result.job?.stage,crashStage);
   }finally{journal.close();}
  }finally{if(!journalClosed)f.journal.close();f.control.close();await f.remove();}
 }
});

test('create ambiguity, forged IDs, mismatched start acknowledgements, timeout, and cancellation remain uncertain',async()=>{
 const f=await fixture();try{
  let calls=0;const ambiguous=new RunnerSupervisor(f.control,f.journal,stub({async create(){calls++;throw Error('effect may have occurred before lost reply');}}),()=>10);
  const result=await ambiguous.submit(request);assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(result.job?.runtimeId,null);assert.equal(calls,1);
  assert.equal((await ambiguous.submit(request)).status,'existing');assert.equal(calls,1);
 }finally{f.close();await f.remove();}
 const g=await fixture();try{
  const forgedRequest={...request,jobId:'forged-id-job'};let starts=0;
  const service=new RunnerSupervisor(g.control,g.journal,stub({async create(i){return {runtimeId:'runtime-trusted-shape',requestDigest:i.requestDigest};},async start(i){starts++;return ack('different-runtime-id',i.requestDigest);}}),()=>10);
  const result=await service.submit(forgedRequest);assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(result.job?.runtimeId,'runtime-trusted-shape');assert.equal(starts,1);
  assert.equal((await service.submit(forgedRequest)).status,'existing');assert.equal(starts,1);
 }finally{g.close();await g.remove();}
 const forged=await fixture();try{
  let starts=0;const service=new RunnerSupervisor(forged.control,forged.journal,stub({async create(i){return {runtimeId:'not a runtime identity',requestDigest:i.requestDigest};},async start(i){starts++;return ack(i.runtimeId,i.requestDigest);}}),()=>10);
  const result=await service.submit({...request,jobId:'forged-create-id'});assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(result.job?.runtimeId,null);assert.equal(starts,0);
 }finally{forged.close();await forged.remove();}
 const h=await fixture();try{
  let clockCalls=0,creates=0;const deadlineService=new RunnerSupervisor(h.control,h.journal,stub({async create(i){creates++;return {runtimeId:'runtime-no-call',requestDigest:i.requestDigest};}}),()=>clockCalls++===0?100:200);
  const timed=await deadlineService.submit({...request,jobId:'expired-before-create',limits:{...request.limits,timeoutMs:100}});
  assert.equal(timed.status,'uncertain');assert.equal(timed.job?.stage,'uncertain');assert.equal(timed.job?.runtimeId,null);assert.equal(creates,0);
 }finally{h.close();await h.remove();}
 const createCrossing=await fixture();try{
  let ticks=0,creates=0;const clock=()=>{ticks++;return ticks<3?100:200;};
  const service=new RunnerSupervisor(createCrossing.control,createCrossing.journal,stub({async create(i){creates++;return {runtimeId:'too-late-create',requestDigest:i.requestDigest};}}),clock);
  const result=await service.submit({...request,jobId:'expired-inside-create-gate',limits:{...request.limits,timeoutMs:100}});
  assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(creates,0);
 }finally{createCrossing.close();await createCrossing.remove();}
 const startExpired=await fixture();try{
  let ticks=0,starts=0,creates=0;const clock=()=>{ticks++;return ticks<=4?100:200;};
  const service=new RunnerSupervisor(startExpired.control,startExpired.journal,stub({async create(i){creates++;return {runtimeId:'runtime-start-not-called',requestDigest:i.requestDigest};},async start(i){starts++;return ack(i.runtimeId,i.requestDigest);}}),clock);
  const result=await service.submit({...request,jobId:'expired-before-start',limits:{...request.limits,timeoutMs:100}});
  assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(result.job?.runtimeId,'runtime-start-not-called');assert.equal(creates,1);assert.equal(starts,0);
 }finally{startExpired.close();await startExpired.remove();}
 const c=await fixture();try{
  const cancelRequest={...request,jobId:'cancelled-job'};
  const running=new RunnerSupervisor(c.control,c.journal,stub(),()=>100).submit(cancelRequest);const started=await running;assert.equal(started.status,'running');
  const cancelled=new RunnerSupervisor(c.control,c.journal,stub(),()=>101).requestCancellation(cancelRequest.jobId);assert.equal(cancelled.stage,'uncertain');assert.equal(cancelled.runtimeId,'runtime-immutable-123');
 }finally{c.close();await c.remove();}
});

test('runtime deadline expiry returns uncertainty, leaves the port unresolved, and never replays',async()=>{
 const f=await fixture();try{
  let starts=0;const runtime=stub({async start(){starts++;return new Promise<never>(()=>{});}});
  const supervisor=new RunnerSupervisor(f.control,f.journal,runtime);
  const bounded={...request,jobId:'start-timeout-job',limits:{...request.limits,timeoutMs:100}};
  const result=await supervisor.submit(bounded);assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(result.job?.runtimeId,'runtime-immutable-123');assert.equal(starts,1);
  assert.equal((await supervisor.submit(bounded)).status,'existing');assert.equal(starts,1);
 }finally{f.close();await f.remove();}
});

test('integrity evidence updates across each legitimate stage transition',async()=>{
 const f=await fixture();try{
  // A connection-local audit observes even transient stages without changing journal data.
  f.journal.db.exec(`CREATE TEMP TABLE supervisor_audit(stage TEXT,integrity_digest TEXT);
   CREATE TEMP TRIGGER audit_insert AFTER INSERT ON main.supervisor_jobs BEGIN
    INSERT INTO supervisor_audit VALUES(NEW.stage,NEW.integrity_digest); END;
   CREATE TEMP TRIGGER audit_update AFTER UPDATE ON main.supervisor_jobs BEGIN
    INSERT INTO supervisor_audit VALUES(NEW.stage,NEW.integrity_digest); END;`);
  const input={...request,jobId:'integrity-transitions'};
  const supervisor=new RunnerSupervisor(f.control,f.journal,stub({async create(i){return {runtimeId:'runtime-integrity',requestDigest:i.requestDigest};}}),()=>1000);
  const running=await supervisor.submit(input);assert.equal(running.status,'running');
  const job=supervisor.requestCancellation(input.jobId);
  const rows=f.journal.db.prepare('SELECT stage,integrity_digest FROM supervisor_audit ORDER BY rowid').all() as {stage:string;integrity_digest:string}[];
  assert.deepEqual(rows.map(row=>row.stage),['admitted','create-intent','create-dispatched','identity-recorded','start-intent','start-dispatched','running','uncertain']);
  const hashes=rows.map(row=>row.integrity_digest);
  assert.equal(new Set(hashes).size,hashes.length);assert.equal(f.journal.inspect(job.jobId)?.integrityDigest,job.integrityDigest);
 }finally{f.close();await f.remove();}
});

test('deadline crossing after running commit is durably latched as uncertain',async()=>{
 const f=await fixture();try{
  let tick=0;const clock=()=>++tick<7?100:200;
  const service=new RunnerSupervisor(f.control,f.journal,stub(),clock);
  const bounded={...request,jobId:'deadline-crossing-job',limits:{...request.limits,timeoutMs:100}};
  const result=await service.submit(bounded);
  assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(result.job?.revision,8);
  const persisted=f.journal.inspect(bounded.jobId);assert.equal(persisted?.stage,'uncertain');assert.equal(persisted?.revision,8);
 }finally{f.close();await f.remove();}
});

test('persisted deadline integrity rejects tampering on reopen and duplicates never recompute it',async()=>{
 const f=await fixture();try{
  let clockCalls=0;const admitted=f.journal.admit({...request,jobId:'deadline-integrity'},()=>{clockCalls++;return 1000;}).job;
  assert.equal(admitted.deadlineMs,1500);assert.equal(clockCalls,1);
  const duplicate=f.journal.admit({...request,jobId:'deadline-integrity'},()=>{clockCalls++;throw Error('duplicate consulted a new clock');}).job;
  assert.equal(duplicate.deadlineMs,1500);assert.equal(clockCalls,1);
  f.journal.db.prepare('UPDATE supervisor_jobs SET deadline_ms=? WHERE job_id=?').run(1600,admitted.jobId);
  f.journal.close();
  assert.throws(()=>new RunnerSupervisorJournal(join(f.root,'journal')),/corrupt or inconsistent/);
 }finally{f.control.close();await f.remove();}
});

test('integrity binds valid runtime-ID substitutions across reopen',async()=>{
 const f=await fixture();try{
  const {job}=await supervisorAtIdentity(f,'runtime-id-integrity','runtime-original-id');
  assert.equal(job.stage,'identity-recorded');assert.equal(job.runtimeId,'runtime-original-id');
  f.journal.db.prepare("UPDATE supervisor_jobs SET runtime_id='runtime-replacement-id' WHERE job_id=?").run(job.jobId);
  f.journal.close();
  assert.throws(()=>new RunnerSupervisorJournal(join(f.root,'journal')),/corrupt or inconsistent/);
 }finally{f.control.close();await f.remove();}
 const g=await fixture();try{
  const {job}=await supervisorAtIdentity(g,'stage-integrity','runtime-stage-id');
  g.journal.db.prepare("UPDATE supervisor_jobs SET stage='start-intent',revision=5 WHERE job_id=?").run(job.jobId);
  g.journal.close();
  assert.throws(()=>new RunnerSupervisorJournal(join(g.root,'journal')),/corrupt or inconsistent/);
 }finally{g.control.close();await g.remove();}
});

test('journal rejects malformed persisted stage, revision, and runtime identity combinations',async()=>{
 const f=await fixture();try{
  const admitted=f.journal.admit({...request,jobId:'corrupt-revision'},1).job;
  f.journal.db.prepare('UPDATE supervisor_jobs SET revision=2 WHERE job_id=?').run(admitted.jobId);
  assert.throws(()=>f.journal.inspect(admitted.jobId),/corrupt or inconsistent/);
 }finally{f.close();await f.remove();}
 const g=await fixture();try{
  const {job}=await supervisorAtIdentity(g,'corrupt-id','runtime-good');
  g.journal.db.prepare("UPDATE supervisor_jobs SET runtime_id='bad identity' WHERE job_id=?").run(job.jobId);
  assert.throws(()=>g.journal.inspect(job.jobId),/corrupt or inconsistent/);
 }finally{g.close();await g.remove();}
 const h=await fixture();try{
  const job=h.journal.admit({...request,jobId:'missing-id'},1).job;
  h.journal.db.prepare("UPDATE supervisor_jobs SET stage='identity-recorded',revision=3 WHERE job_id=?").run(job.jobId);
  assert.throws(()=>h.journal.inspect(job.jobId),/corrupt or inconsistent/);
 }finally{h.close();await h.remove();}
 const i=await fixture();try{
  let job=i.journal.admit({...request,jobId:'uncertain-bad-id'},1).job;
  job=i.journal.transition(job.jobId,'admitted','uncertain');
  i.journal.db.prepare("UPDATE supervisor_jobs SET runtime_id='fake-but-well-formed' WHERE job_id=?").run(job.jobId);
  assert.throws(()=>i.journal.inspect(job.jobId),/corrupt or inconsistent/);
 }finally{i.close();await i.remove();}
 const j=await fixture();try{
  const {supervisor,job:identity}=await supervisorAtIdentity(j,'uncertain-missing-id','runtime-good');
  const job=supervisor.requestCancellation(identity.jobId);
  assert.equal(job.stage,'uncertain');assert.equal(job.revision,5);
  j.journal.db.prepare("UPDATE supervisor_jobs SET runtime_id='bad identity' WHERE job_id=?").run(job.jobId);
  assert.throws(()=>j.journal.inspect(job.jobId),/corrupt or inconsistent/);
  j.journal.db.prepare('UPDATE supervisor_jobs SET runtime_id=NULL WHERE job_id=?').run(job.jobId);
  assert.throws(()=>j.journal.inspect(job.jobId),/corrupt or inconsistent/);
 }finally{j.close();await j.remove();}
});

test('durable cancellation before start dispatch prevents invocation, but cannot retract an invoked effect',async()=>{
 const f=await fixture();try{
  const input={...request,jobId:'cancel-before-dispatch'};
  let starts=0,cancelledStage:string|undefined,stageAtCancellation:string|undefined;
  let supervisor:RunnerSupervisor;
  // The supervisor consults its clock immediately before dispatching start. Cancel at that
  // observable stage without fabricating journal transitions or calling a dispatch mutator.
  const clock=()=>{
   const job=f.journal.inspect(input.jobId);
   if(job?.stage==='start-intent'&&!cancelledStage){
    stageAtCancellation=job.stage;
    cancelledStage=supervisor.requestCancellation(input.jobId).stage;
   }
   return 100;
  };
  supervisor=new RunnerSupervisor(f.control,f.journal,stub({async create(i){return {runtimeId:'runtime-cancel-test',requestDigest:i.requestDigest};},async start(i){starts++;return ack(i.runtimeId,i.requestDigest);}}),clock);
  const result=await supervisor.submit(input);
  assert.equal(stageAtCancellation,'start-intent');assert.equal(cancelledStage,'uncertain');
  assert.equal(result.status,'uncertain');assert.equal(result.job?.runtimeId,'runtime-cancel-test');assert.equal(starts,0);
  assert.equal((await supervisor.submit(input)).status,'existing');assert.equal(starts,0);
 }finally{f.close();await f.remove();}
 const g=await fixture();try{
  const input={...request,jobId:'cancel-after-dispatch'};
  let portInvocations=0,queuedEffect=0,entered!:()=>void,release!:()=>void;
  const began=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const supervisor=new RunnerSupervisor(g.control,g.journal,stub({async create(i){return {runtimeId:'runtime-already-invoked',requestDigest:i.requestDigest};},async start(i){portInvocations++;entered();await gate;queuedEffect++;return ack(i.runtimeId,i.requestDigest);}}),()=>100);
  const pending=supervisor.submit(input);
  const boundedDrain=async <T,>(promise:Promise<T>):Promise<T>=>{
   let drainTimer:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([promise,new Promise<never>((_,reject)=>{drainTimer=setTimeout(()=>reject(Error('timed out draining supervisor submit')),2000);})]);}
   finally{if(drainTimer)clearTimeout(drainTimer);}
  };
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   await Promise.race([
    began,
    pending.then(result=>{throw Error(`submit settled before start port entry: ${result.status}`);},error=>{throw Error('submit rejected before start port entry',{cause:error});}),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('timed out waiting for start port entry')),2000);})
   ]);
   assert.equal(g.journal.inspect(input.jobId)?.stage,'start-dispatched');assert.equal(portInvocations,1);assert.equal(queuedEffect,0);
   assert.equal(supervisor.requestCancellation(input.jobId).stage,'uncertain');
   release();assert.equal((await boundedDrain(pending)).status,'uncertain');assert.equal(queuedEffect,1);
   assert.equal((await supervisor.submit(input)).status,'existing');assert.equal(portInvocations,1);
  }finally{
   if(timer)clearTimeout(timer);
   release();
   // Drain on ordinary failure without hanging; a drain timeout can replace an earlier failure.
   await boundedDrain(pending.then(()=>undefined,()=>undefined));
  }
 }finally{g.close();await g.remove();}
});

test('identity is immutable, mismatched inspection is uncertainty, and duplicates cannot alter request/deadline',async()=>{
 const f=await fixture();try{
  const service=new RunnerSupervisor(f.control,f.journal,stub({async inspect(i){return {runtimeId:i.runtimeId+'-forged',requestDigest:'bad',state:'exited'};}}),()=>200);
  const started=await service.submit(request);assert.equal(started.job?.deadlineMs,700);assert.equal(started.status,'running');
  const duplicate=await service.submit(request);assert.equal(duplicate.status,'existing');assert.equal(duplicate.job?.deadlineMs,700);
  const inspection=await service.inspect(request.jobId);assert.equal(inspection.status,'uncertain');assert.equal(inspection.runtimeState,'mismatch');
  assert.throws(()=>f.journal.transition(request.jobId,'running','uncertain','replacement-id'),/Unexpected runtime identity/);
  await assert.rejects(service.submit({...request,limits:{...request.limits,timeoutMs:499}}),/different content/);
 }finally{f.close();await f.remove();}
});

test('policy revocation during create prevents start and retains uncertainty barrier',async()=>{
 const f=await fixture();try{
  const policy=new RunnerServicePolicyStore(f.control);let creates=0,starts=0;
  const revokedRequest={...request,jobId:'policy-revoked-during-create'};
  const runtime=stub({async create(i){creates++;policy.update({expectedRevision:1,enabled:false,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});return {runtimeId:'created-before-revoke',requestDigest:i.requestDigest};},async start(i){starts++;return ack(i.runtimeId,i.requestDigest);}});
  const service=new RunnerSupervisor(f.control,f.journal,runtime,()=>100);
  const result=await service.submit(revokedRequest);
  assert.equal(creates,1);assert.equal(starts,0);assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(result.job?.runtimeId,'created-before-revoke');
  policy.update({expectedRevision:2,enabled:true,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});
  await assert.rejects(service.submit({...revokedRequest,jobId:'after-revocation',policyRevision:3}),/previous runner job remains unresolved/);
  assert.equal(f.journal.inspect(revokedRequest.jobId)?.stage,'uncertain');
 }finally{f.close();await f.remove();}
});

test('policy-check failure after create leaves uncertainty and never starts',async()=>{
 const f=await fixture();try{
  let starts=0;const runtime=stub({async create(i){f.control.db.prepare("UPDATE operations SET input_json='{}' WHERE project_id='runner-service' AND session_id='runner-service-policy'").run();return {runtimeId:'created-before-policy-error',requestDigest:i.requestDigest};},async start(i){starts++;return ack(i.runtimeId,i.requestDigest);}});
  const service=new RunnerSupervisor(f.control,f.journal,runtime,()=>100),revokedRequest={...request,jobId:'policy-check-error-after-create'};
  const result=await service.submit(revokedRequest);
  assert.equal(starts,0);assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(result.job?.runtimeId,'created-before-policy-error');
 }finally{f.close();await f.remove();}
});

test('policy revoked before create dispatch prevents create and retains uncertainty barrier',async()=>{
 const f=await fixture();try{
  const policy=new RunnerServicePolicyStore(f.control);let revoke=true,creates=0,starts=0;
  const clock=()=>{if(revoke){revoke=false;policy.update({expectedRevision:1,enabled:false,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});}return 100;};
  const service=new RunnerSupervisor(f.control,f.journal,stub({async create(i){creates++;return {runtimeId:'must-not-create',requestDigest:i.requestDigest};},async start(i){starts++;return ack(i.runtimeId,i.requestDigest);}}),clock);
  const revokedRequest={...request,jobId:'policy-revoked-before-create'},result=await service.submit(revokedRequest);
  assert.equal(creates,0);assert.equal(starts,0);assert.equal(result.status,'uncertain');assert.equal(result.job?.stage,'uncertain');assert.equal(result.job?.runtimeId,null);
  assert.equal(f.journal.inspect(revokedRequest.jobId)?.stage,'uncertain');
 }finally{f.close();await f.remove();}
});

test('global barrier never releases on exited inspection and admits no second distinct job',async()=>{
 const f=await fixture();try{
  const runtime=stub({async inspect(i){return {runtimeId:i.runtimeId,requestDigest:f.journal.inspect(request.jobId)!.requestDigest,state:'exited'};}});
  const service=new RunnerSupervisor(f.control,f.journal,runtime,()=>100);
  const first=await service.submit(request);assert.equal(first.status,'running');
  const observed=await service.inspect(request.jobId);assert.equal(observed.runtimeState,'exited');assert.equal(observed.status,'uncertain');
  await assert.rejects(service.submit({...request,jobId:'second-distinct-job'}),/previous runner job remains unresolved/);
  assert.equal(f.journal.inspect(request.jobId)?.stage,'running');
 }finally{f.close();await f.remove();}
});

test('concurrent duplicate submissions across journal handles produce one create and one start',async()=>{
 const f=await fixture();const other=new RunnerSupervisorJournal(join(f.root,'journal'));try{
  let calls=0,entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
  const runtime=stub({async create(i){calls++;entered();await wait;return {runtimeId:'runtime-concurrent-id',requestDigest:i.requestDigest};},async start(i){calls++;return ack(i.runtimeId,i.requestDigest);}});
  const first=new RunnerSupervisor(f.control,f.journal,runtime,()=>1000),second=new RunnerSupervisor(f.control,other,runtime,()=>1000);
  const pending=first.submit({...request,jobId:'concurrent-job'});await began;
  const duplicate=await second.submit({...request,jobId:'concurrent-job'});assert.equal(duplicate.status,'existing');assert.equal(calls,1);
  release();assert.equal((await pending).status,'running');assert.equal(calls,2);
 }finally{other.close();f.close();await f.remove();}
});
