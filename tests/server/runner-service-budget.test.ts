import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';
import {RunnerServiceBudgetStore} from '../../src/server/state/runner-service-budget';
const limits={timeoutMs:1000,outputBytes:1024,memoryBytes:64*1024*1024,cpus:1,pids:16};
const target={agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace'};
const request={jobId:'job-1',...target,policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits};
async function within<T>(promise:Promise<T>,ms=5000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('child process deadline exceeded')),ms);})]);}finally{if(timer)clearTimeout(timer);}}

test('service job reservations bind the exact agent, are single use, and survive restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-service-budget-'));let store=new ControlStore(root);
 try{
  const policy=new RunnerServicePolicyStore(store),budget=new RunnerServiceBudgetStore(store);
  policy.update({expectedRevision:0,enabled:true,targets:[target,{...target,sessionId:'session-2'}],limits,maxJobsPerHour:1});
  assert.equal(budget.reserve(request).existing,false);assert.equal(budget.reserve(request).existing,true);
  assert.throws(()=>budget.reserve({...request,jobId:'job-2',sessionId:'session-2'}),/budget is exhausted/);
  assert.throws(()=>budget.reserve({...request,jobId:'job-3',agentId:'pretend-agent'}),/policy refused/);
  assert.throws(()=>budget.reserve({...request,snapshotDigest:'b'.repeat(64)}),/different content/);
  store.close();store=new ControlStore(root);assert.throws(()=>new RunnerServiceBudgetStore(store).reserve({...request,jobId:'job-4'}),/budget is exhausted/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('damaged reservation evidence cannot restore the hourly budget',async()=>{
 for(const corruption of ['timestamp','kind','key','scope','outbox-scope','payload'] as const){
  const root=await mkdtemp(join(tmpdir(),'pilot-service-budget-corrupt-')),store=new ControlStore(root);
  try{
   new RunnerServicePolicyStore(store).update({expectedRevision:0,enabled:true,targets:[target],limits,maxJobsPerHour:1});const budget=new RunnerServiceBudgetStore(store);budget.reserve(request);
   const row=store.db.prepare("SELECT id FROM operations WHERE kind='runner-service.budget'").get() as {id:string};
   if(corruption==='timestamp')store.db.prepare("UPDATE operations SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(row.id);
   if(corruption==='kind')store.db.prepare("UPDATE operations SET kind='other.budget' WHERE id=?").run(row.id);
   if(corruption==='key')store.db.prepare("UPDATE operations SET idempotency_key='other-key' WHERE id=?").run(row.id);
   if(corruption==='scope')store.db.prepare("UPDATE operations SET session_id='elsewhere' WHERE id=?").run(row.id);
   if(corruption==='outbox-scope')store.db.prepare("UPDATE outboxes SET session_id='elsewhere' WHERE operation_id=?").run(row.id);
   if(corruption==='payload')store.db.prepare("UPDATE outboxes SET payload_json='{}' WHERE operation_id=?").run(row.id);
   assert.throws(()=>budget.reserve({...request,jobId:'job-2'}),/budget evidence could not be verified/,corruption);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
 }
});

test('two processes cannot reserve the last service budget slot for different jobs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-service-budget-race-')),store=new ControlStore(root);
 new RunnerServicePolicyStore(store).update({expectedRevision:0,enabled:true,targets:[target],limits,maxJobsPerHour:1});store.close();
 const script=`import {ControlStore} from './src/server/state/control-store.ts';import {RunnerServiceBudgetStore} from './src/server/state/runner-service-budget.ts';import {createInterface} from 'node:readline';const s=new ControlStore(process.argv[1]),b=new RunnerServiceBudgetStore(s);process.stdout.write('ready\\n');for await(const line of createInterface({input:process.stdin})){if(line==='go'){try{b.reserve({...${JSON.stringify(request)},jobId:process.argv[2]});process.stdout.write('won\\n');}catch(e){process.stdout.write(JSON.stringify({code:e.code,message:e.message})+'\\n');}break;}}s.close();`;
 const children=[0,1].map(i=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,root,'job-'+i],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});let err='';child.stderr.on('data',chunk=>{err+=chunk.toString();});const lines=createInterface({input:child.stdout})[Symbol.asyncIterator](),closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));return{child,lines,closed,error:()=>err};});
 try{
  for(const c of children)assert.equal((await within(c.lines.next())).value,'ready',c.error());for(const c of children)c.child.stdin.end('go\n');
  const answers=await Promise.all(children.map(async c=>(await within(c.lines.next())).value));assert.equal(answers.filter(value=>value==='won').length,1);const refused=JSON.parse(answers.find(value=>value!=='won')!);assert.equal(refused.code,'CONFLICT');assert.match(refused.message,/job budget is exhausted/);
 }finally{for(const c of children)c.child.kill();await Promise.all(children.map(c=>within(c.closed)));await rm(root,{recursive:true,force:true});}
});
