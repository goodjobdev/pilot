import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,lstat,mkdtemp,mkdir,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServiceAdmission} from '../../src/server/state/runner-service-admission';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';
import {RunnerService,type RunnerServiceRuntime} from '../../src/server/state/runner-service';
import {validateRunnerSnapshot} from '../../src/server/state/runner-snapshot';
const snapshot={version:1,files:[{path:'test/example.test.js',mode:'100644',base64:Buffer.from('example').toString('base64')}]};
const request={jobId:'job-1',agentId:'agent',projectId:'project-1',sessionId:'session-1',workspaceId:'workspace-1',policyRevision:1,snapshotDigest:validateRunnerSnapshot(snapshot).digest,recipe:'test-run',limits:{timeoutMs:200,outputBytes:256,memoryBytes:64*1024*1024,cpus:1,pids:16}};
const result={exitCode:0,stdout:Buffer.from('ok'),stderr:Buffer.alloc(0)};
async function writable(path:string):Promise<void>{const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())return;await chmod(path,0o700);for(const child of await readdir(path))await writable(join(path,child));}
async function fixture(){const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-runner-flow-'));const privateRoot=join(root,'private');await mkdir(privateRoot,{mode:0o700});const store=new ControlStore(join(root,'store'));new RunnerServicePolicyStore(store).update({expectedRevision:0,enabled:true,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});return {root,store,journal:new RunnerServiceAdmission(store),config:{privateRoot,applicationUid:process.getuid!()+1},async close(){store.close();await writable(root);await rm(root,{recursive:true,force:true});}};}

test('service journals exact bytes before a single fixed stub run; duplicates only inspect',async t=>{
 if(!process.getuid?.()){t.skip('requires a non-root POSIX service identity');return;}const f=await fixture();
 try{
  let calls=0,unblock!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{unblock=r;});
  const runtime:RunnerServiceRuntime={async run(input){calls++;assert.equal(input.recipe,'test-run');assert.equal(await readFile(join(input.directory,'test/example.test.js'),'utf8'),'example');entered();await wait;return result;}};
  const service=new RunnerService(f.store,f.config,runtime);
  const first=service.start(request,snapshot);await ready;
  const duplicate=await service.start(request,snapshot);assert.equal(duplicate.status,'existing');assert.equal(calls,1);assert.equal(f.journal.inspect(duplicate.operationId).outcomeUncertain,true);
  unblock();const done=await first;assert.equal(done.status,'completed');assert.equal(done.operationId,duplicate.operationId);
  const record=f.journal.inspect(done.operationId);assert.equal(record.receipt?.exitCode,0);assert.equal(record.receipt?.stdoutBytes,2);assert.equal(record.request.snapshotDigest,request.snapshotDigest);
  assert.equal((await service.start(request,snapshot)).status,'existing');assert.equal(calls,1);
 }finally{await f.close();}
});

test('revocation before dispatch and missing output confirmation remain uncertain, never retried',async t=>{
 if(!process.getuid?.()){t.skip('requires a non-root POSIX service identity');return;}const f=await fixture();
 try{
  let calls=0;const runtime:RunnerServiceRuntime={async run(){calls++;return result;}};
  const revoked=new RunnerService(f.store,f.config,runtime),policy=new RunnerServicePolicyStore(f.store);
  const pending=revoked.start(request,snapshot);
  policy.update({expectedRevision:1,enabled:false,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});
  const stopped=await pending;assert.equal(stopped.status,'uncertain');assert.equal(calls,0);assert.equal(f.journal.inspect(stopped.operationId).state,'unknown');
  policy.update({expectedRevision:2,enabled:true,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});
  await assert.rejects(revoked.start(request,snapshot),/policy refused/);assert.equal(calls,0);
  await assert.rejects(revoked.start({...request,jobId:'job-next',policyRevision:3},snapshot),/operator review/);assert.equal(calls,0);
 }finally{await f.close();}
});

test('oversized runtime output leaves the job uncertain',async t=>{
 if(!process.getuid?.()){t.skip('requires a non-root POSIX service identity');return;}const f=await fixture();
 try{
  const service=new RunnerService(f.store,f.config,{async run(){return {...result,stdout:Buffer.alloc(257)};}});
  const failed=await service.start(request,snapshot);assert.equal(failed.status,'uncertain');assert.equal(f.journal.inspect(failed.operationId).outcomeUncertain,true);
 }finally{await f.close();}
});

test('cancellation never claims that an uncooperative runtime stopped',async t=>{
 if(!process.getuid?.()){t.skip('requires a non-root POSIX service identity');return;}const f=await fixture();
 try{
  let calls=0,entered!:()=>void,observedSignal:AbortSignal|undefined;const ready=new Promise<void>(r=>{entered=r;});
  const runtime:RunnerServiceRuntime={run(input){calls++;observedSignal=input.signal;entered();return new Promise(()=>{});}};
  const service=new RunnerService(f.store,f.config,runtime),controller=new AbortController();
  const pending=service.start(request,snapshot,controller.signal);await ready;controller.abort();const cancelled=await pending;
  assert.equal(cancelled.status,'uncertain');assert.equal(observedSignal?.aborted,true);assert.equal(f.journal.inspect(cancelled.operationId).state,'unknown');
  assert.equal((await service.start(request,snapshot)).status,'existing');assert.equal(calls,1);
  await assert.rejects(service.start({...request,jobId:'job-next'},snapshot),/operator review/);assert.equal(calls,1);
 }finally{await f.close();}
});

test('timeout never claims that an uncooperative runtime stopped',async t=>{
 if(!process.getuid?.()){t.skip('requires a non-root POSIX service identity');return;}const f=await fixture();
 try{
  let observedSignal:AbortSignal|undefined;const runtime:RunnerServiceRuntime={run(input){observedSignal=input.signal;return new Promise(()=>{});}};
  const service=new RunnerService(f.store,f.config,runtime);
  const timeout=await service.start({...request,limits:{...request.limits,timeoutMs:100}},snapshot);
  assert.equal(timeout.status,'uncertain');assert.equal(observedSignal?.aborted,true);assert.equal(f.journal.inspect(timeout.operationId).state,'unknown');
 }finally{await f.close();}
});
