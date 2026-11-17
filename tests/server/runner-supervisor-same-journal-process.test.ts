import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';
import {RunnerSupervisorJournal} from '../../src/server/state/runner-supervisor-journal';
import {RunnerSupervisor,type RunnerSupervisorRuntime} from '../../src/server/state/runner-supervisor';

const request={jobId:'same-journal-process',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits:{timeoutMs:5000,outputBytes:256,memoryBytes:64*1024*1024,cpus:1,pids:16}};
type Message={stage:string;status?:string;message?:string};
function nextMessage(child:ChildProcess):Promise<Message>{
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>finish(Error('worker message timed out')),5000);
  function finish(error?:Error,value?:Message){clearTimeout(timer);child.off('message',onMessage);child.off('close',onClose);error?reject(error):resolve(value!);}
  function onMessage(value:unknown){finish(undefined,value as Message);}
  function onClose(code:number|null,signal:NodeJS.Signals|null){finish(Error(`worker closed: ${code} ${signal}`));}
  child.once('message',onMessage);child.once('close',onClose);
 });
}
function spawn(root:string,point:string){
 const child=fork('tests/server/fixtures/runner-supervisor-same-journal-worker.ts',[root,point,JSON.stringify(request)],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
 child.stderr?.resume();child.on('error',()=>{});
 const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 return {child,closed};
}
async function setup(root:string){
 const control=new ControlStore(join(root,'control'));
 new RunnerServicePolicyStore(control).update({expectedRevision:0,enabled:true,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});
 control.close();
}
async function stop(child:ChildProcess,closed:Promise<void>){
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('worker did not close')),5000);})]);}
 finally{if(timer)clearTimeout(timer);}
}
const changed={...request,limits:{...request.limits,timeoutMs:4999}};

// This uses the supervisor's current public journal directly: it tests transaction ordering,
// not the missing ownership boundary or the unrelated RunnerDispatchArbitration database.
test('same journal close-first fences delayed supervisor submit across processes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-same-journal-close-'));let worker:ReturnType<typeof spawn>|undefined;
 try{
  await setup(root);const journal=new RunnerSupervisorJournal(join(root,'supervisor'));
  try{
   worker=spawn(root,'create');assert.equal((await nextMessage(worker.child)).stage,'ready');
   assert.equal(journal.closeRequest(request),'closed-before-dispatch');
   assert.throws(()=>journal.closeRequest(changed),/different request content/);
   const next=nextMessage(worker.child);worker.child.send('submit');
   const result=await next;assert.equal(result.stage,'error');assert.match(result.message!,/closed before dispatch/);
   await stop(worker.child,worker.closed);
  }finally{journal.close();}
  const reopened=new RunnerSupervisorJournal(join(root,'supervisor'));
  try{assert.equal(reopened.closeRequest(request),'closed-before-dispatch');assert.equal(reopened.inspect(request.jobId),null);}
  finally{reopened.close();}
 }finally{if(worker)await stop(worker.child,worker.closed);await rm(root,{recursive:true,force:true});}
});

for(const point of ['create','start'] as const)test(`same journal admission-first ${point} interruption is not replayed`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-same-journal-admit-'));let worker:ReturnType<typeof spawn>|undefined;
 try{
  await setup(root);worker=spawn(root,point);assert.equal((await nextMessage(worker.child)).stage,'ready');
  const entered=nextMessage(worker.child);worker.child.send('submit');assert.equal((await entered).stage,point);
  const journal=new RunnerSupervisorJournal(join(root,'supervisor'));
  try{
   assert.equal(journal.closeRequest(request),'dispatch-possible');
   assert.throws(()=>journal.closeRequest(changed),/different request content/);
   assert.equal(journal.closeRequest({...request,jobId:'tombstone'}),'closed-before-dispatch');
   const control=new ControlStore(join(root,'control'));let calls=0;
   try{
    const runtime:RunnerSupervisorRuntime={async create(i){calls++;return {runtimeId:'unexpected',requestDigest:i.requestDigest};},async start(i){calls++;return {...i,started:true};},async inspect(i){return {runtimeId:i.runtimeId,requestDigest:'unused',state:'unavailable'};}};
    const supervisor=new RunnerSupervisor(control,journal,runtime,()=>1000);
    assert.equal((await supervisor.submit(request)).status,'existing');assert.equal(calls,0);
    await assert.rejects(supervisor.submit(changed),/different content/);
    await assert.rejects(supervisor.submit({...request,jobId:'distinct'}),/unresolved/);
    await stop(worker.child,worker.closed);
    assert.equal(journal.closeRequest(request),'dispatch-possible');
    assert.equal((await supervisor.submit(request)).status,'existing');assert.equal(calls,0);
   }finally{control.close();}
  }finally{journal.close();}
  const reopened=new RunnerSupervisorJournal(join(root,'supervisor'));
  try{
   assert.equal(reopened.closeRequest(request),'dispatch-possible');assert.ok(reopened.inspect(request.jobId));
   const control=new ControlStore(join(root,'control'));let calls=0;
   try{
    const runtime:RunnerSupervisorRuntime={async create(i){calls++;return {runtimeId:'unexpected',requestDigest:i.requestDigest};},async start(i){calls++;return {...i,started:true};},async inspect(i){return {runtimeId:i.runtimeId,requestDigest:'unused',state:'unavailable'};}};
    assert.equal((await new RunnerSupervisor(control,reopened,runtime,()=>1000).submit(request)).status,'existing');assert.equal(calls,0);
   }finally{control.close();}
  }finally{reopened.close();}
 }finally{if(worker)await stop(worker.child,worker.closed);await rm(root,{recursive:true,force:true});}
});

test('same journal admission-first close does not revoke delayed continuation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-same-journal-continue-'));let worker:ReturnType<typeof spawn>|undefined;
 try{
  await setup(root);worker=spawn(root,'create');assert.equal((await nextMessage(worker.child)).stage,'ready');
  const entered=nextMessage(worker.child);worker.child.send('submit');assert.equal((await entered).stage,'create');
  const journal=new RunnerSupervisorJournal(join(root,'supervisor'));
  try{
   assert.equal(journal.closeRequest(request),'dispatch-possible');
   const result=nextMessage(worker.child);worker.child.send('release');assert.deepEqual(await result,{stage:'result',status:'running'});
   await stop(worker.child,worker.closed);assert.equal(journal.closeRequest(request),'dispatch-possible');
  }finally{journal.close();}
 }finally{if(worker)await stop(worker.child,worker.closed);await rm(root,{recursive:true,force:true});}
});
