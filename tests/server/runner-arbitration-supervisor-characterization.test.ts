import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';
import {RunnerDispatchArbitration} from '../../src/server/state/runner-dispatch-arbitration';
import {RunnerSupervisorJournal} from '../../src/server/state/runner-supervisor-journal';
import {RunnerSupervisor,type RunnerSupervisorRuntime} from '../../src/server/state/runner-supervisor';

const request={jobId:'characterization',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits:{timeoutMs:500,outputBytes:256,memoryBytes:64*1024*1024,cpus:1,pids:16}};

// These are counterexamples, not a service or a proposed integration.
test('a close tombstone does not fence an independently invoked staged supervisor',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-arbitration-gap-'));
 const control=new ControlStore(join(root,'control'));
 const journal=new RunnerSupervisorJournal(join(root,'supervisor'));
 const arbitration=RunnerDispatchArbitration.provision(join(root,'arbitration.sqlite'));
 try{
  new RunnerServicePolicyStore(control).update({expectedRevision:0,enabled:true,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});
  let creates=0,starts=0;
  const runtime:RunnerSupervisorRuntime={async create(input){creates++;return {runtimeId:'runtime-id',requestDigest:input.requestDigest};},async start(input){starts++;return {...input,started:true};},async inspect(input){return {runtimeId:input.runtimeId,requestDigest:'unused',state:'unavailable'};}};
  assert.deepEqual(arbitration.closeRequest(request),{decision:'closed-before-dispatch',invoke:false});
  assert.equal((await new RunnerSupervisor(control,journal,runtime,()=>1000).submit(request)).status,'running');
  assert.equal(creates,1);assert.equal(starts,1);
  assert.deepEqual(arbitration.dispatch(request),{decision:'closed-before-dispatch',invoke:false});
 }finally{arbitration.close();journal.close();control.close();await rm(root,{recursive:true,force:true});}
});

test('committed permission can outlive close without implying a supervisor admission',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-arbitration-permission-'));const file=join(root,'arbitration.sqlite');
 try{
  let arbitration=RunnerDispatchArbitration.provision(file);
  const permission=arbitration.dispatch(request);
  assert.deepEqual(permission,{decision:'dispatch-possible',invoke:true});
  assert.deepEqual(arbitration.closeRequest(request),{decision:'dispatch-possible',invoke:false});
  arbitration.close();arbitration=new RunnerDispatchArbitration(file);
  assert.deepEqual(arbitration.dispatch(request),{decision:'dispatch-possible',invoke:false});
  // The caller could still hold the first permission; no runtime invocation is evidenced here.
  assert.equal(permission.invoke,true);arbitration.close();
 }finally{await rm(root,{recursive:true,force:true});}
});

test('reprovisioning a lost journal forgets a tombstone without an external freshness anchor',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-arbitration-anchor-'));const file=join(root,'arbitration.sqlite');
 try{
  let arbitration=RunnerDispatchArbitration.provision(file);
  assert.equal(arbitration.closeRequest(request).decision,'closed-before-dispatch');arbitration.close();
  await rm(file);
  arbitration=RunnerDispatchArbitration.provision(file);
  assert.deepEqual(arbitration.dispatch(request),{decision:'dispatch-possible',invoke:true});arbitration.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
