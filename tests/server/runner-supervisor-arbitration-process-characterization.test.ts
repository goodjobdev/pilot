import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';
import {RunnerDispatchArbitration} from '../../src/server/state/runner-dispatch-arbitration';
import {RunnerSupervisorJournal} from '../../src/server/state/runner-supervisor-journal';
import {RunnerSupervisor,type RunnerSupervisorRuntime} from '../../src/server/state/runner-supervisor';

const request={jobId:'gap-process',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits:{timeoutMs:5000,outputBytes:256,memoryBytes:64*1024*1024,cpus:1,pids:16}};
async function bounded<T>(promise:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('worker timed out')),5000);})]);}
 finally{if(timer)clearTimeout(timer);}
}
async function message(child:ChildProcess){
 const result=await bounded(Promise.race([
  once(child,'message').then(([value])=>value as {stage:string;message?:string}),
  once(child,'exit').then(([code,signal])=>{throw Error(`worker exited early: ${code} ${signal}`);})
 ]));
 return result;
}

// A passing test is a counterexample: the existing arbitration and staged supervisor are NOT integrated.
for(const point of ['create','start'] as const)test(`cross-process close cannot fence staged ${point}; crash is not replayed`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-supervisor-gap-process-'));
 let child:ChildProcess|undefined;
 let closed:Promise<void>|undefined;
 try{
  const control=new ControlStore(join(root,'control'));
  try{new RunnerServicePolicyStore(control).update({expectedRevision:0,enabled:true,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});}
  finally{control.close();}
  const arbitration=RunnerDispatchArbitration.provision(join(root,'arbitration.sqlite'));
  try{
   child=fork('tests/server/fixtures/runner-supervisor-arbitration-gap-worker.ts',[root,point,JSON.stringify(request)],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
   // A spawn failure emits error and close, but not exit. Register before awaiting any messages.
   child.on('error',()=>{});
   closed=new Promise(resolve=>child!.once('close',()=>resolve()));
   child.stderr?.resume();
   assert.equal((await message(child)).stage,'ready');
   assert.equal(arbitration.closeRequest(request).decision,'closed-before-dispatch');
   const entered=message(child);child.send('continue');
   assert.equal((await entered).stage,point); // actual staged supervisor called the synthetic runtime despite close
   child.kill('SIGKILL');await bounded(closed);
  }finally{arbitration.close();}
  const reopenedArbitration=new RunnerDispatchArbitration(join(root,'arbitration.sqlite'));
  try{assert.equal(reopenedArbitration.dispatch(request).decision,'closed-before-dispatch');}
  finally{reopenedArbitration.close();}
  const reopenedControl=new ControlStore(join(root,'control'));
  try{
   const journal=new RunnerSupervisorJournal(join(root,'supervisor'));
   try{
    let calls=0,inspections=0;
    const persisted=journal.inspect(request.jobId);
    assert.ok(persisted);
    const runtime:RunnerSupervisorRuntime={async create(input){calls++;return {runtimeId:'unexpected',requestDigest:input.requestDigest};},async start(input){calls++;return {...input,started:true};},async inspect(input){inspections++;return {runtimeId:input.runtimeId,requestDigest:persisted.requestDigest,state:'exited'};}};
    const supervisor=new RunnerSupervisor(reopenedControl,journal,runtime,()=>1000);
    const existing=await supervisor.submit(request);
    assert.equal(existing.status,'existing');
    // The worker can commit the dispatched stage before SIGKILL arrives; either crash window is possible.
    assert.ok((point==='create'?['create-intent','create-dispatched']:['start-intent','start-dispatched']).includes(existing.job?.stage ?? ''));
    assert.equal(calls,0);
    const observed=await supervisor.inspect(request.jobId);
    assert.equal(observed.status,'uncertain');
    if(point==='start'){
     // An exited observation is not a termination receipt and does not release capacity.
     assert.equal(observed.runtimeState,'exited');
     assert.equal(inspections,1);
    }else{
     // No runtime identity was persisted at create, so the inspection port is not called.
     assert.equal(observed.runtimeState,undefined);
     assert.equal(inspections,0);
    }
    await assert.rejects(supervisor.submit({...request,jobId:'another-job'}),/unresolved/);
    assert.equal(calls,0);
   }finally{journal.close();}
  }finally{reopenedControl.close();}
 }finally{
  try{
   if(child&&closed){
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await bounded(closed);
   }
  }finally{await rm(root,{recursive:true,force:true});}
 }
});
