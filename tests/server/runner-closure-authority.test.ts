import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as closureModule from './fixtures/runner-closure-authority';
import {openClosureAuthority,provisionClosureAuthority} from './fixtures/runner-closure-authority';

const request={jobId:'closure-job',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits:{timeoutMs:5000,outputBytes:256,memoryBytes:64*1024*1024,cpus:1,pids:16}};
const changed={...request,limits:{...request.limits,timeoutMs:4999}};
type Message={stage:string;decision?:string;message?:string};
function next(child:ChildProcess):Promise<Message>{return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>done(Error('worker message timeout')),5000);
 function done(error?:Error,value?:Message){clearTimeout(timer);child.off('message',message);child.off('close',closed);error?reject(error):resolve(value!);}
 function message(value:unknown){done(undefined,value as Message);}
 function closed(code:number|null,signal:NodeJS.Signals|null){done(Error(`worker closed ${code} ${signal}`));}
 child.once('message',message);child.once('close',closed);
});}
function worker(file:string,point:string){
 const child=fork('tests/server/fixtures/runner-closure-authority-worker.ts',[file,point,JSON.stringify(request)],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
 child.stderr?.resume();child.on('error',()=>{});const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));return {child,closed};
}
async function stop(w:ReturnType<typeof worker>){
 if(w.child.exitCode===null&&w.child.signalCode===null)w.child.kill('SIGKILL');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([w.closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('worker reap timeout')),5000);})]);}
 finally{if(timer)clearTimeout(timer);}
}
function fixture(){const root=mkdtempSync(join(tmpdir(),'pilot-closure-authority-')),file=join(root,'journal.sqlite');provisionClosureAuthority(file);return {root,file};}
type EffectRecord={effect:'create'|'start';jobId:string;stage:string;decision:string;request_json:string;deadline_ms:number};
function observe(file:string,effect:'create'|'start',jobId:string):EffectRecord{
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  const row=db.prepare('SELECT stage,decision,request_json,deadline_ms FROM synthetic_jobs WHERE job_id=?').get(jobId);
  assert.ok(row,'invocation must have a committed journal row');return {effect,jobId,...row} as EffectRecord;
 }finally{db.close();}
}
function assertEffects(records:EffectRecord[],expected:('create'|'start')[]){
 assert.equal(records.length,expected.length);
 records.forEach((record,index)=>{
  assert.equal(record.effect,expected[index]);assert.equal(record.jobId,request.jobId);
  assert.equal(record.stage,record.effect==='create'?'create-intent':'start-intent');
  assert.equal(record.decision,'dispatch-possible');assert.deepEqual(JSON.parse(record.request_json),request);
  assert.ok(Number.isSafeInteger(record.deadline_ms)&&record.deadline_ms>0);
 });
}
function childEffects(file:string):EffectRecord[]{
 const path=`${file}.effects`;if(!existsSync(path))return [];
 assert.ok(statSync(path).size<=8192,'synthetic invocation evidence exceeded bound');
 return readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line) as EffectRecord);
}
async function bounded<T>(promise:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic test timeout')),2000);})]);}
 finally{if(timer)clearTimeout(timer);}
}

test('closure authority exposes no journal, runtime, admission permission or continuation',async()=>{
 const {root,file}=fixture();const seen:string[]=[],effects:EffectRecord[]=[];
 const authority=openClosureAuthority(file,{onStage(stage){seen.push(stage);},onEffect(effect,id){effects.push(observe(file,effect,id));}});
 try{
  assert.deepEqual(Object.keys(closureModule).sort(),['openClosureAuthority','provisionClosureAuthority']);
  assert.deepEqual(Object.keys(authority).sort(),['closeRequest','dispose','submit']);
  for(const name of ['db','journal','runtime','admit','dispatch','create','start','advance'])assert.equal((authority as unknown as Record<string,unknown>)[name],undefined,name);
  assert.equal(await authority.submit(request),'dispatch-possible');
  assert.deepEqual(seen,['admitted','create-intent','created','start-intent','started']);assertEffects(effects,['create','start']);
  assert.equal(await authority.submit(request),'dispatch-possible');assert.equal(seen.length,5);assertEffects(effects,['create','start']);
  assert.throws(()=>authority.closeRequest(changed),/different request content/);
  await assert.rejects(authority.submit({...request,jobId:'other'}),/unresolved/);
  assert.equal(authority.closeRequest({...request,jobId:'other'}),'closed-before-dispatch');
 }finally{authority.dispose();rmSync(root,{recursive:true,force:true});}
});

test('synthetic hook failure preserves dispatch-possible and never replays',async()=>{
 const {root,file}=fixture();const effects:EffectRecord[]=[];
 const authority=openClosureAuthority(file,{onStage(stage){if(stage==='created')throw Error('injected lost reply');},onEffect(effect,id){effects.push(observe(file,effect,id));}});
 try{await assert.rejects(authority.submit(request),/lost reply/);assert.equal(authority.closeRequest(request),'dispatch-possible');assertEffects(effects,['create']);}
 finally{authority.dispose();}
 const seen:string[]=[],reopened=openClosureAuthority(file,{onStage(stage){seen.push(stage);},onEffect(effect,id){effects.push(observe(file,effect,id));}});
 try{assert.equal(await reopened.submit(request),'dispatch-possible');assert.deepEqual(seen,[]);assertEffects(effects,['create']);await assert.rejects(reopened.submit({...request,jobId:'other'}),/unresolved/);}
 finally{reopened.dispose();rmSync(root,{recursive:true,force:true});}
});

test('expired synthetic admission cannot resume and retains permanent barrier',async()=>{
 const {root,file}=fixture();let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
 const effects:EffectRecord[]=[],authority=openClosureAuthority(file,{async onStage(stage){if(stage==='admitted'){entered();await gate;}},onEffect(effect,id){effects.push(observe(file,effect,id));}});
 const input={...request,limits:{...request.limits,timeoutMs:100}},pending=authority.submit(input);
 try{
  await bounded(Promise.race([began,pending.then(()=>{throw Error('submit settled before admission gate');})]));
  await new Promise(resolve=>setTimeout(resolve,150));release();
  await assert.rejects(bounded(pending),/deadline expired/);assert.equal(authority.closeRequest(input),'dispatch-possible');
  assert.equal(await authority.submit(input),'dispatch-possible');assertEffects(effects,[]);await assert.rejects(authority.submit({...input,jobId:'other'}),/unresolved/);
 }finally{release();try{await bounded(pending.then(()=>undefined,()=>undefined));}finally{authority.dispose();rmSync(root,{recursive:true,force:true});}}
});

test('synthetic evidence corruption and incompatible schema fail closed',()=>{
 for(const corruption of ['evidence','schema'] as const){
  const {root,file}=fixture();
  try{
   const authority=openClosureAuthority(file);authority.closeRequest(request);authority.dispose();
   const db=new DatabaseSync(file);
   try{if(corruption==='evidence')db.prepare("UPDATE synthetic_jobs SET evidence='forged'").run();else db.exec('PRAGMA user_version=0');}
   finally{db.close();}
   assert.throws(()=>openClosureAuthority(file),corruption==='evidence'?/evidence is corrupt/:/Incompatible synthetic authority schema/);
  }finally{rmSync(root,{recursive:true,force:true});}
 }
});

test('cross-process close-first survives reopen and fences delayed submit',async()=>{
 const {root,file}=fixture();let w:ReturnType<typeof worker>|undefined;
 try{
  w=worker(file,'admitted');assert.equal((await next(w.child)).stage,'ready');
  const a=openClosureAuthority(file);try{assert.equal(a.closeRequest(request),'closed-before-dispatch');assert.throws(()=>a.closeRequest(changed),/different request content/);}finally{a.dispose();}
  const result=next(w.child);w.child.send('submit');assert.deepEqual(await result,{stage:'result',decision:'closed-before-dispatch'});await stop(w);
  assertEffects(childEffects(file),[]);
  const effects:EffectRecord[]=[],reopened=openClosureAuthority(file,{onEffect(effect,id){effects.push(observe(file,effect,id));}});
  try{assert.equal(await reopened.submit(request),'closed-before-dispatch');assert.equal(reopened.closeRequest(request),'closed-before-dispatch');assertEffects(effects,[]);}finally{reopened.dispose();}
 }finally{if(w)await stop(w);rmSync(root,{recursive:true,force:true});}
});

test('cross-process admission-first close cannot revoke winning continuation',async()=>{
 const {root,file}=fixture();let w:ReturnType<typeof worker>|undefined;
 try{
  w=worker(file,'admitted');assert.equal((await next(w.child)).stage,'ready');
  const entered=next(w.child);w.child.send('submit');assert.equal((await entered).stage,'admitted');
  const events:string[]=[],effects:EffectRecord[]=[],other=openClosureAuthority(file,{onStage(stage){events.push(stage);},onEffect(effect,id){effects.push(observe(file,effect,id));}});
  try{
   assert.equal(other.closeRequest(request),'dispatch-possible');assert.equal(await other.submit(request),'dispatch-possible');assert.deepEqual(events,[]);assertEffects(effects,[]);assertEffects(childEffects(file),[]);
   await assert.rejects(other.submit(changed),/different request content/);
   await assert.rejects(other.submit({...request,jobId:'other'}),/unresolved/);
   assert.equal(other.closeRequest({...request,jobId:'other'}),'closed-before-dispatch');
   const result=next(w.child);w.child.send('release');assert.deepEqual(await result,{stage:'result',decision:'dispatch-possible'});await stop(w);
   assertEffects(childEffects(file),['create','start']);assertEffects(effects,[]);
  }finally{other.dispose();}
 }finally{if(w)await stop(w);rmSync(root,{recursive:true,force:true});}
});

for(const point of ['admitted','create-intent','created','start-intent','started'])test(`cross-process ${point} interruption never replays synthetic continuation`,async()=>{
 const {root,file}=fixture();let w:ReturnType<typeof worker>|undefined;
 try{
  w=worker(file,point);assert.equal((await next(w.child)).stage,'ready');
  const entered=next(w.child);w.child.send('submit');assert.equal((await entered).stage,point);await stop(w);
  const expected:('create'|'start')[]=point==='admitted'||point==='create-intent'?[]:point==='created'||point==='start-intent'?['create']:['create','start'];
  assertEffects(childEffects(file),expected);
  const events:string[]=[],effects:EffectRecord[]=[],reopened=openClosureAuthority(file,{onStage(stage){events.push(stage);},onEffect(effect,id){effects.push(observe(file,effect,id));}});
  try{
   assert.equal(reopened.closeRequest(request),'dispatch-possible');
   assert.equal(await reopened.submit(request),'dispatch-possible');assert.deepEqual(events,[]);assertEffects(effects,[]);
   await assert.rejects(reopened.submit({...request,jobId:'distinct'}),/unresolved/);
   assert.throws(()=>reopened.closeRequest(changed),/different request content/);
   assertEffects(childEffects(file),expected);
  }finally{reopened.dispose();}
 }finally{if(w)await stop(w);rmSync(root,{recursive:true,force:true});}
});
