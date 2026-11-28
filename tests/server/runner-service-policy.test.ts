import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,lstat,mkdtemp,mkdir,readdir,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';
import {RunnerServiceAdmission} from '../../src/server/state/runner-service-admission';
import {RunnerService} from '../../src/server/state/runner-service';
import {validateRunnerSnapshot} from '../../src/server/state/runner-snapshot';
const limits={timeoutMs:1000,outputBytes:1024,memoryBytes:64*1024*1024,cpus:1,pids:16};
const targets=[{agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace'}];
const snapshot={version:1,files:[{path:'test/example.test.js',mode:'100644',base64:Buffer.from('test').toString('base64')}]};
const request={jobId:'job-1',...targets[0],policyRevision:1,snapshotDigest:validateRunnerSnapshot(snapshot).digest,recipe:'test-run' as const,limits};
async function writable(path:string):Promise<void>{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())return;await chmod(path,0o700);for(const child of await readdir(path))await writable(join(path,child));}

test('service policy uses exact targets, fixed ceilings and a revision CAS across connections',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-runner-policy-')),a=new ControlStore(root),b=new ControlStore(root);
 try{
  const one=new RunnerServicePolicyStore(a),two=new RunnerServicePolicyStore(b);assert.equal(one.allows(request),false);
  const first=one.update({expectedRevision:0,enabled:true,targets,limits,maxJobsPerHour:100});assert.equal(first.revision,1);assert.equal(two.allows(request),true);
  assert.equal(two.allows({...request,workspaceId:'other'}),false);assert.equal(two.allows({...request,sessionId:'other'}),false);
  assert.equal(two.allows({...request,limits:{...limits,cpus:2}}),false);assert.equal(two.allows({...request,policyRevision:2}),false);
  assert.throws(()=>two.update({expectedRevision:0,enabled:false,targets,limits,maxJobsPerHour:100}),/revision changed/);
  assert.throws(()=>one.update({expectedRevision:1,enabled:true,targets:[...targets,...targets],limits,maxJobsPerHour:100}),/Duplicate/);
  assert.throws(()=>one.update({expectedRevision:1,enabled:true,targets:[...targets,{...targets[0],agentId:'other',workspaceId:'other'}],limits,maxJobsPerHour:100}),/multiple agents/);
  const disabled=two.update({expectedRevision:1,enabled:false,targets,limits,maxJobsPerHour:100});assert.equal(disabled.revision,2);assert.equal(one.allows(request),false);
  const restored=one.update({expectedRevision:2,enabled:true,targets,limits,maxJobsPerHour:100});assert.equal(restored.revision,3);assert.equal(two.allows(request),false);assert.equal(two.allows({...request,policyRevision:3}),true);
  a.close();b.close();const reopened=new ControlStore(root);try{assert.equal(new RunnerServicePolicyStore(reopened).read()?.revision,3);}finally{reopened.close();}
 }finally{a.close();b.close();await rm(root,{recursive:true,force:true});}
});

test('damaged policy history cannot silently restore a previous enabled revision',async()=>{
 for(const corruption of ['kind-and-key','scope','outbox-scope'] as const){
  const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-runner-policy-corrupt-')),store=new ControlStore(root);
  try{
   const policy=new RunnerServicePolicyStore(store);policy.update({expectedRevision:0,enabled:true,targets,limits,maxJobsPerHour:100});policy.update({expectedRevision:1,enabled:false,targets,limits,maxJobsPerHour:100});
   const row=store.db.prepare("SELECT id FROM operations WHERE kind='runner-service.policy' ORDER BY rowid DESC LIMIT 1").get() as {id:string};
   if(corruption==='kind-and-key')store.db.prepare("UPDATE operations SET kind='other.policy',idempotency_key='other-key' WHERE id=?").run(row.id);
   if(corruption==='scope')store.db.prepare("UPDATE operations SET session_id='elsewhere' WHERE id=?").run(row.id);
   if(corruption==='outbox-scope')store.db.prepare("UPDATE outboxes SET session_id='elsewhere' WHERE operation_id=?").run(row.id);
   assert.throws(()=>policy.allows(request),/policy could not be verified/,corruption);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
 }
});

test('the real service flow charges an uncertain job before enforcing its per-agent cap',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires a non-root POSIX service identity');return;}
 const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-runner-service-limit-')),privateRoot=join(root,'private');await mkdir(privateRoot,{mode:0o700});const store=new ControlStore(join(root,'store'));
 try{
  const policy=new RunnerServicePolicyStore(store);policy.update({expectedRevision:0,enabled:true,targets:[...targets,{...targets[0],sessionId:'session-2'}],limits,maxJobsPerHour:1});let calls=0;
  const service=new RunnerService(store,{privateRoot,applicationUid:uid+1},{async run(){calls++;throw Error('unconfirmed');}});
  const first=await service.start(request,snapshot);assert.equal(first.status,'uncertain');assert.equal(calls,1);
  await assert.rejects(service.start({...request,jobId:'job-2',sessionId:'session-2'},snapshot),/budget is exhausted/);assert.equal(calls,1);
  assert.equal((await service.start(request,snapshot)).status,'existing');assert.equal(calls,1);
 }finally{store.close();await writable(root);await rm(root,{recursive:true,force:true});}
});

test('a revocation queued before the dispatch microtask prevents the runtime invocation',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires a non-root POSIX service identity');return;}
 const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-runner-policy-dispatch-')),privateRoot=join(root,'private');await mkdir(privateRoot,{mode:0o700});const store=new ControlStore(join(root,'store'));
 try{
  const owner=new RunnerServicePolicyStore(store);owner.update({expectedRevision:0,enabled:true,targets,limits,maxJobsPerHour:100});let calls=0;
  const service=new RunnerService(store,{privateRoot,applicationUid:uid+1},{async run(){calls++;return {exitCode:0,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};}});
  const internal=(service as unknown as {policy:RunnerServicePolicyStore}).policy,allows=internal.allows.bind(internal);let checks=0;
  internal.allows=value=>{const allowed=allows(value);if(++checks===2)queueMicrotask(()=>owner.update({expectedRevision:1,enabled:false,targets,limits,maxJobsPerHour:100}));return allowed;};
  const result=await service.start(request,snapshot);assert.equal(result.status,'uncertain');assert.equal(calls,0);assert.equal(owner.read()?.enabled,false);
 }finally{store.close();await writable(root);await rm(root,{recursive:true,force:true});}
});

test('revoke-and-restore after admission cannot revive an old service job',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires a non-root POSIX service identity');return;}
 const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-runner-policy-flow-')),privateRoot=join(root,'private');await mkdir(privateRoot,{mode:0o700});const store=new ControlStore(join(root,'store'));
 try{
  const policy=new RunnerServicePolicyStore(store),journal=new RunnerServiceAdmission(store);policy.update({expectedRevision:0,enabled:true,targets,limits,maxJobsPerHour:100});let calls=0;
  const service=new RunnerService(store,{privateRoot,applicationUid:uid+1},{async run(){calls++;return {exitCode:0,stdout:Buffer.from('ok'),stderr:Buffer.alloc(0)};}});
  const old=service.start(request,snapshot);policy.update({expectedRevision:1,enabled:false,targets,limits,maxJobsPerHour:100});policy.update({expectedRevision:2,enabled:true,targets,limits,maxJobsPerHour:100});
  const result=await old;assert.equal(result.status,'uncertain');assert.equal(calls,0);assert.equal(journal.inspect(result.operationId).state,'unknown');
  await assert.rejects(service.start({...request,policyRevision:3},snapshot),/different content/);
  await assert.rejects(service.start({...request,jobId:'job-2',policyRevision:3},snapshot),/operator review/);assert.equal(calls,0);
 }finally{store.close();await writable(root);await rm(root,{recursive:true,force:true});}
});
