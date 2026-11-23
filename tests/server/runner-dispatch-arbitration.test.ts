import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {RunnerDispatchArbitration} from '../../src/server/state/runner-dispatch-arbitration';

const request={jobId:'job-1',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits:{timeoutMs:500,outputBytes:256,memoryBytes:64*1024*1024,cpus:1,pids:16}};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'pilot-arbitration-'));return {root,file:join(root,'journal.sqlite'),remove:()=>rm(root,{recursive:true,force:true})};}

test('close tombstone wins across independent connections and restart; changed content is refused',async()=>{
 const f=await fixture();try{
  const a=RunnerDispatchArbitration.provision(f.file),b=new RunnerDispatchArbitration(f.file);
  assert.deepEqual(a.closeRequest(request),{decision:'closed-before-dispatch',invoke:false});
  assert.deepEqual(b.dispatch(request),{decision:'closed-before-dispatch',invoke:false});
  assert.throws(()=>b.dispatch({...request,snapshotDigest:'b'.repeat(64)}),/different request/);
  assert.throws(()=>b.closeRequest({...request,policyRevision:2}),/different request/);
  a.close();b.close();
  const reopened=new RunnerDispatchArbitration(f.file);
  assert.deepEqual(reopened.dispatch(request),{decision:'closed-before-dispatch',invoke:false});
  assert.equal(reopened.dispatch({...request,jobId:'different-job'}).invoke,true);reopened.close();
 }finally{await f.remove();}
});

test('dispatch winning or a lost response remains uncertain and blocks retries and new jobs after restart',async()=>{
 const f=await fixture();try{
  const a=RunnerDispatchArbitration.provision(f.file),b=new RunnerDispatchArbitration(f.file);
  assert.deepEqual(a.dispatch(request),{decision:'dispatch-possible',invoke:true});
  assert.deepEqual(b.closeRequest(request),{decision:'dispatch-possible',invoke:false});
  assert.deepEqual(b.dispatch(request),{decision:'dispatch-possible',invoke:false});
  assert.throws(()=>b.dispatch({...request,jobId:'different-job'}),/unresolved/);
  a.close();b.close();
  const reopened=new RunnerDispatchArbitration(f.file);
  assert.deepEqual(reopened.dispatch(request),{decision:'dispatch-possible',invoke:false});
  assert.throws(()=>reopened.dispatch({...request,jobId:'different-job'}),/unresolved/);reopened.close();
 }finally{await f.remove();}
});

function worker(file:string,gate:string,action:string){
 const child=spawn(process.execPath,['--import','tsx','tests/server/fixtures/runner-arbitration-worker.ts',file,gate,action,JSON.stringify(request)],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 let out='',err='';
 let readyResolve:()=>void,readyReject:(error:Error)=>void;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 child.stdout.on('data',x=>{out+=x;if(out.includes('\n'))readyResolve();});child.stderr.on('data',x=>err+=x);
 const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 const result=new Promise<{decision:string;invoke:boolean}>((resolve,reject)=>{child.on('error',error=>{readyReject(error);reject(error);});child.on('close',code=>{if(code!==0||!out.includes('\n')){const error=new Error(err||`worker exited ${code} before producing a result`);readyReject(error);reject(error);}else {try{resolve(JSON.parse(out.slice(out.indexOf('\n')+1)));}catch(error){reject(error);}}});});
 // A worker can fail while its sibling is still starting, before either promise is awaited.
 void ready.catch(()=>{});void result.catch(()=>{});
 return {ready,result,child,exited};
}
async function withDeadline<T>(promise:Promise<T>,ms:number,message:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]);}
 finally{clearTimeout(timer);}
}
async function raceDispatchAndClose(f:Awaited<ReturnType<typeof fixture>>,workers:ReturnType<typeof worker>[],stall=false){
 try{
  // Initialize before spawning so both processes race only the decision, not first-open setup.
  RunnerDispatchArbitration.provision(f.file).close();
  const gate=join(f.root,'gate');const dispatch=worker(f.file,gate,stall?'stall':'dispatch');workers.push(dispatch);
  const close=worker(f.file,gate,'close');workers.push(close);
  await withDeadline(Promise.all([dispatch.ready,close.ready]),5000,'worker readiness timed out');
  await writeFile(gate,'go');
  const [d,c]=await withDeadline(Promise.all([dispatch.result,close.result]),stall?200:5000,'worker results timed out');
  assert.equal(d.decision,c.decision);assert.equal(c.invoke,false);
  assert.equal(d.invoke,d.decision==='dispatch-possible');
  const reopened=new RunnerDispatchArbitration(f.file);
  assert.deepEqual(reopened.dispatch(request),{decision:d.decision,invoke:false});reopened.close();
 }finally{
  for(const {child} of workers)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  try{await withDeadline(Promise.all(workers.map(({exited})=>exited)),5000,'worker reaping timed out');}
  finally{await f.remove();}
 }
}
test('independent processes racing dispatch and close agree on one durable decision',async()=>{
 const f=await fixture();await raceDispatchAndClose(f,[]);
});
test('post-ready worker stall times out and reaps workers before removing the fixture',async()=>{
 const f=await fixture();const workers:ReturnType<typeof worker>[]=[];
 await assert.rejects(raceDispatchAndClose(f,workers,true),/worker results timed out/);
 assert.equal(workers.length,2);
 assert.equal(workers[0].child.signalCode,'SIGKILL');
 for(const {child} of workers)assert.ok(child.exitCode!==null||child.signalCode!==null);
 await assert.rejects(access(f.root),{code:'ENOENT'});
});

test('corrupt persisted request evidence fails closed instead of clearing the barrier',async()=>{
 const f=await fixture();try{
  const journal=RunnerDispatchArbitration.provision(f.file);journal.dispatch(request);journal.close();
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.file);
  db.prepare('UPDATE arbitration_jobs SET evidence_digest=?').run('0'.repeat(64));db.close();
  assert.throws(()=>new RunnerDispatchArbitration(f.file),/corrupt/);
 }finally{await f.remove();}
});


test('decision corruption is detected even when changed to another valid decision',async()=>{
 const f=await fixture();try{
  const journal=RunnerDispatchArbitration.provision(f.file);journal.dispatch(request);journal.close();
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.file);
  db.exec("UPDATE arbitration_jobs SET decision='closed-before-dispatch'");db.close();
  assert.throws(()=>new RunnerDispatchArbitration(f.file),/corrupt/);
 }finally{await f.remove();}
});

test('reopen refuses missing and empty journals; provisioning refuses an existing path',async()=>{
 const f=await fixture();try{
  assert.throws(()=>new RunnerDispatchArbitration(f.file));
  RunnerDispatchArbitration.provision(f.file).close();
  assert.throws(()=>RunnerDispatchArbitration.provision(f.file));
  await writeFile(f.file,'');
  assert.throws(()=>new RunnerDispatchArbitration(f.file),/Incompatible/);
 }finally{await f.remove();}
});

test('missing primary key and duplicate identities fail closed',async()=>{
 const f=await fixture();try{
  const journal=RunnerDispatchArbitration.provision(f.file);journal.dispatch(request);
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.file);
  db.exec(`ALTER TABLE arbitration_jobs RENAME TO old_jobs;
   CREATE TABLE arbitration_jobs(job_id TEXT, request_json TEXT NOT NULL, evidence_digest TEXT NOT NULL, decision TEXT NOT NULL);
   INSERT INTO arbitration_jobs SELECT * FROM old_jobs;
   DROP TABLE old_jobs`);
  const row=db.prepare('SELECT request_json FROM arbitration_jobs').get() as {request_json:string};
  const digest=createHash('sha256').update(JSON.stringify([row.request_json,'closed-before-dispatch'])).digest('hex');
  db.prepare('INSERT INTO arbitration_jobs VALUES(?,?,?,?)').run(request.jobId,row.request_json,digest,'closed-before-dispatch');
  assert.throws(()=>journal.dispatch(request),/corrupt/);
  journal.close();db.close();
  assert.throws(()=>new RunnerDispatchArbitration(f.file),/Incompatible/);
 }finally{await f.remove();}
});
