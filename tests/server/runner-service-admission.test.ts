import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServiceAdmission} from '../../src/server/state/runner-service-admission';
import {validateRunnerSnapshot} from '../../src/server/state/runner-snapshot';

const request={jobId:'job-1',agentId:'agent',projectId:'project-1',sessionId:'session-1',workspaceId:'workspace-1',policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits:{timeoutMs:1000,outputBytes:1024,memoryBytes:64*1024*1024,cpus:1,pids:16}};
const receipt={snapshotDigest:request.snapshotDigest,exitCode:1,stdoutDigest:'b'.repeat(64),stderrDigest:'c'.repeat(64),stdoutBytes:4,stderrBytes:8,durationMs:100};
async function within<T>(promise:Promise<T>,ms=5000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('child process deadline exceeded')),ms);})]);}finally{if(timer)clearTimeout(timer);}}

test('the service journal binds the exact request and never grants a duplicate attempt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-service-'));let a=new ControlStore(root),b=new ControlStore(root);
 try{
  const one=new RunnerServiceAdmission(a),two=new RunnerServiceAdmission(b);
  const [first,duplicate]=await Promise.all([Promise.resolve().then(()=>one.admit(request,()=>true)),Promise.resolve().then(()=>two.admit(request,()=>true))]);
  assert.deepEqual([first.first,duplicate.first],[true,false]);assert.equal(first.operationId,duplicate.operationId);
  assert.equal(two.inspect(first.operationId).outcomeUncertain,true);
  assert.throws(()=>two.admit({...request,snapshotDigest:'f'.repeat(64)},()=>true),/different content/i);
  assert.throws(()=>two.recordResult(first.operationId,{...receipt,snapshotDigest:'f'.repeat(64)}),/does not match/);
  assert.equal(two.inspect(first.operationId).state,'pending');
  const recorded=one.recordResult(first.operationId,receipt);assert.equal(recorded.receipt?.exitCode,1,'recording a result does not mean tests passed');
  assert.throws(()=>two.recordResult(first.operationId,receipt),/no longer awaiting/);
  a.close();b.close();a=new ControlStore(root);b=new ControlStore(root);
  const reopened=new RunnerServiceAdmission(a);assert.equal(reopened.admit(request,()=>true).first,false);assert.equal(reopened.inspect(first.operationId).receipt?.exitCode,1);
 }finally{a.close();b.close();await rm(root,{recursive:true,force:true});}
});

test('separate processes racing the same service job have exactly one first admission',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-service-process-'));
 const bootstrap=new ControlStore(root);bootstrap.close();
 const script=`import {ControlStore} from './src/server/state/control-store.ts';
 import {RunnerServiceAdmission} from './src/server/state/runner-service-admission.ts';
 import {createInterface} from 'node:readline';
 const store=new ControlStore(process.argv[1]),service=new RunnerServiceAdmission(store);
 process.stdout.write('ready\\n');
 for await(const line of createInterface({input:process.stdin})){if(line==='go'){try{process.stdout.write(JSON.stringify(service.admit(${JSON.stringify(request)},()=>true))+'\\n');}catch(e){process.stdout.write(JSON.stringify({error:String(e)})+'\\n');}break;}}
 store.close();`;
 const children=[0,1].map(()=>{
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,root],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr+=chunk;});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  return {child,lines,closed,stderr:()=>stderr};
 });
 try{
  for(const c of children){const line=await within(c.lines.next());assert.equal(line.value,'ready',c.stderr());}
  for(const c of children)c.child.stdin.end('go\n');
  const answers=await Promise.all(children.map(async c=>{const line=await within(c.lines.next());assert.equal(typeof line.value,'string',c.stderr());return JSON.parse(line.value as string) as {first?:boolean;operationId?:string;error?:string};}));
  assert.equal(answers.filter(value=>value.first===true).length,1,JSON.stringify(answers));
  assert.equal(answers.filter(value=>value.first===false).length,1,JSON.stringify(answers));
  assert.equal(answers[0].operationId,answers[1].operationId);
 }finally{for(const c of children)c.child.kill();await Promise.all(children.map(c=>within(c.closed)));await rm(root,{recursive:true,force:true});}
});

test('separate processes cannot admit different jobs while either may execute',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-service-barrier-race-')),bootstrap=new ControlStore(root);bootstrap.close();
 const script=`import {ControlStore} from './src/server/state/control-store.ts';import {RunnerServiceAdmission} from './src/server/state/runner-service-admission.ts';import {createInterface} from 'node:readline';const s=new ControlStore(process.argv[1]),j=new RunnerServiceAdmission(s);process.stdout.write('ready\\n');for await(const line of createInterface({input:process.stdin})){if(line==='go'){try{j.admit({...${JSON.stringify(request)},jobId:process.argv[2]},()=>true);process.stdout.write('won\\n');}catch(e){process.stdout.write(JSON.stringify({code:e.code,message:e.message})+'\\n');}break;}}s.close();`;
 const children=[0,1].map(i=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,root,'job-'+i],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});let err='';child.stderr.on('data',chunk=>{err+=chunk.toString();});const lines=createInterface({input:child.stdout})[Symbol.asyncIterator](),closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));return {child,lines,closed,error:()=>err};});
 try{for(const c of children)assert.equal((await within(c.lines.next())).value,'ready',c.error());for(const c of children)c.child.stdin.end('go\n');const answers=await Promise.all(children.map(async c=>(await within(c.lines.next())).value));assert.equal(answers.filter(value=>value==='won').length,1);const refused=JSON.parse(answers.find(value=>value!=='won')!);assert.equal(refused.code,'CONFLICT');assert.match(refused.message,/job is in progress or uncertain/);}
 finally{for(const c of children)c.child.kill();await Promise.all(children.map(c=>within(c.closed)));await rm(root,{recursive:true,force:true});}
});

test('a killed service after admission leaves an uncertain non-replayable job',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-service-crash-'));
 const bootstrap=new ControlStore(root);bootstrap.close();
 const script=`import {ControlStore} from './src/server/state/control-store.ts';
 import {RunnerServiceAdmission} from './src/server/state/runner-service-admission.ts';
 const store=new ControlStore(process.argv[1]),service=new RunnerServiceAdmission(store);
 process.stdout.write(JSON.stringify(service.admit(${JSON.stringify(request)},()=>true))+'\\n');
 setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,root],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr+=chunk;});
 const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 try{
  const line=await within(createInterface({input:child.stdout})[Symbol.asyncIterator]().next());assert.equal(typeof line.value,'string',stderr);
  const admitted=JSON.parse(line.value as string) as {first:boolean;operationId:string};assert.equal(admitted.first,true);
  child.kill('SIGKILL');await within(closed);
  const store=new ControlStore(root);
  try{const reopened=new RunnerServiceAdmission(store);assert.equal(reopened.admit(request,()=>true).first,false);const job=reopened.inspect(admitted.operationId);assert.equal(job.state,'pending');assert.equal(job.outcomeUncertain,true);}
  finally{store.close();}
 }finally{child.kill('SIGKILL');await within(closed);await rm(root,{recursive:true,force:true});}
});

test('a lost result stays uncertain after reopen and cannot be submitted again',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-service-unknown-'));let store=new ControlStore(root);
 try{
  const service=new RunnerServiceAdmission(store),first=service.admit(request,()=>true);
  assert.equal(service.markUnknown(first.operationId).outcomeUncertain,true);
  store.close();store=new ControlStore(root);const reopened=new RunnerServiceAdmission(store);
  assert.equal(reopened.admit(request,()=>true).first,false);assert.equal(reopened.inspect(first.operationId).state,'unknown');
  assert.throws(()=>reopened.recordResult(first.operationId,receipt),/no longer awaiting/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('an unresolved job blocks other jobs across connections and restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-service-barrier-'));let one=new ControlStore(root),two=new ControlStore(root);
 try{
  const a=new RunnerServiceAdmission(one),b=new RunnerServiceAdmission(two),first=a.admit(request,()=>true);
  assert.throws(()=>b.admit({...request,jobId:'job-2'},()=>true),/operator review/);
  assert.equal(b.admit(request,()=>true).first,false);
  a.recordResult(first.operationId,receipt);
  const second=b.admit({...request,jobId:'job-2'},()=>true);assert.equal(second.first,true);b.markUnknown(second.operationId);
  one.close();two.close();one=new ControlStore(root);two=new ControlStore(root);
  assert.throws(()=>new RunnerServiceAdmission(one).admit({...request,jobId:'job-3'},()=>true),/operator review/);
 }finally{one.close();two.close();await rm(root,{recursive:true,force:true});}
});

test('exact request inspection preserves absence, mismatch and uncertainty without mutation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-inspect-')),store=new ControlStore(root);
 try{
  const journal=new RunnerServiceAdmission(store);assert.equal(journal.inspectRequest(request),null);
  const job=journal.admit(request,()=>true);assert.equal(journal.inspectRequest(request)?.state,'pending');
  assert.equal(journal.inspectRequest({...request,workspaceId:'other'}),null);
  journal.markUnknown(job.operationId);assert.equal(journal.inspectRequest(request)?.outcomeUncertain,true);
  assert.throws(()=>journal.admit({...request,jobId:'job-2'},()=>true),/in progress or uncertain/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('an oversized result is refused before changing durable job evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-receipt-limit-')),store=new ControlStore(root);
 try{
  const journal=new RunnerServiceAdmission(store),job=journal.admit(request,()=>true);
  assert.throws(()=>journal.recordResult(job.operationId,{...receipt,stdoutBytes:request.limits.outputBytes,stderrBytes:1}),/exceeds the admitted output limit/);
  assert.equal(journal.inspect(job.operationId).state,'pending');
  assert.throws(()=>journal.admit({...request,jobId:'job-2'},()=>true),/in progress or uncertain/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('malformed job evidence cannot clear the global barrier',async()=>{
 for(const corruption of ['false-success','kind','key','input','outbox-scope','operation-scope','receipt'] as const){
  const root=await mkdtemp(join(tmpdir(),'pilot-runner-barrier-corrupt-')),store=new ControlStore(root);
  try{
   const journal=new RunnerServiceAdmission(store),job=journal.admit(request,()=>true);
   if(corruption==='false-success')store.db.prepare("UPDATE operations SET state='succeeded' WHERE id=?").run(job.operationId);
   if(corruption==='kind')store.db.prepare("UPDATE operations SET kind='other.job' WHERE id=?").run(job.operationId);
   if(corruption==='key')store.db.prepare("UPDATE operations SET idempotency_key='other-key' WHERE id=?").run(job.operationId);
   if(corruption==='input')store.db.prepare("UPDATE operations SET input_json='{}' WHERE id=?").run(job.operationId);
   if(corruption==='outbox-scope')store.db.prepare("UPDATE outboxes SET session_id='elsewhere' WHERE operation_id=?").run(job.operationId);
   if(corruption==='operation-scope')store.db.prepare("UPDATE operations SET session_id='elsewhere' WHERE id=?").run(job.operationId);
   if(corruption==='receipt'){journal.recordResult(job.operationId,receipt);store.db.prepare("UPDATE operations SET receipt_json='{}' WHERE id=?").run(job.operationId);}
   assert.throws(()=>journal.admit({...request,jobId:'job-2'},()=>true),/evidence could not be verified/,corruption);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
 }
});

test('snapshot admission recomputes the identity before reserving the job',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-snapshot-admission-')),store=new ControlStore(root),service=new RunnerServiceAdmission(store);
 try{
  const snapshot={version:1,files:[{path:'tests/example.test.js',mode:'100644',base64:Buffer.from('test').toString('base64')}]};
  let authorizations=0;const allow=()=>{authorizations++;return true;};
  assert.throws(()=>service.admitSnapshot(request,snapshot,allow),/do not match/);assert.equal(authorizations,0);
  const bound={...request,snapshotDigest:validateRunnerSnapshot(snapshot).digest};
  const first=service.admitSnapshot(bound,snapshot,allow);assert.equal(first.first,true);assert.equal(first.snapshot.digest,bound.snapshotDigest);
  assert.equal(service.admitSnapshot(bound,snapshot,allow).first,false);
  assert.throws(()=>service.admitSnapshot(bound,{...snapshot,files:[{...snapshot.files[0],base64:Buffer.from('other').toString('base64')}]},allow),/do not match/);
  assert.equal(service.inspect(first.operationId).outcomeUncertain,true);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('the service refuses malformed requests, wrong targets and non-synchronous guards before admission',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-service-invalid-')),store=new ControlStore(root),service=new RunnerServiceAdmission(store);
 try{
  assert.throws(()=>service.admit({...request,workspaceId:'/tmp/outside'},()=>true));
  assert.throws(()=>service.admit({...request,command:'sh -c bad'},()=>true));
  assert.throws(()=>service.admit({...request,recipe:'noop-probe'},()=>true));
  assert.throws(()=>service.admit({...request,limits:{...request.limits,cpus:999}},()=>true));
  assert.throws(()=>service.admit(request,()=>false),/authorization refused/i);
  assert.throws(()=>service.admit(request,(()=>Promise.resolve(true)) as unknown as ()=>boolean),/authorization refused/i);
  assert.equal(service.admit(request,()=>true).first,true,'failed guards did not write an intent');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
