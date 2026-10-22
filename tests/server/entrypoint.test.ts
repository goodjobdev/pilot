import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { chmod,mkdir,mkdtemp,readdir,readFile,readlink,realpath,rm,stat,symlink,unlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { request,type ClientRequest } from 'node:http';
import { createConnection,createServer } from 'node:net';
import { spawn,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { effectiveConfig } from '../../src/server/effective-config';
import { acquireServiceLock } from '../../src/server/service-lock';
import { observeStorageSchema } from '../../src/server/release';
import { doctorStartBlockers,restorePauseRefusal } from '../../src/server/main';
import { PAUSED_MARKER,backup,promote,restore } from '../../scripts/data-tools.mjs';
import { ControlStore } from '../../src/server/state/control-store';
import { ReleaseStore } from '../../src/server/state/release-store';
import { DeliveryLedger } from '../../src/server/state/delivery';
import { SessionLifecycleStore } from '../../src/server/state/session-lifecycle';
import { newTask } from '../../src/shared/model';

/** The entrypoint validates the whole environment, so a test must not inherit deployment values. */
const DEPLOYMENT_VARIABLES=['DASHBOARD_MODE','DASHBOARD_EXPOSURE','DASHBOARD_BIND','DASHBOARD_ALLOWED_HOSTS','DASHBOARD_RELEASE','DASHBOARD_RELEASE_MANIFEST','DASHBOARD_ROOT_ID','DASHBOARD_SHUTDOWN_DEADLINE_MS','DASHBOARD_ORIGIN','CF_ACCESS_TEAM','CF_ACCESS_AUD','DASHBOARD_OWNER','DASHBOARD_DATA','DASHBOARD_ROOTS','DASHBOARD_REGISTRY','PORT'];
function testEnv(overrides:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const env:{[name:string]:string|undefined}={...process.env};
  for(const name of DEPLOYMENT_VARIABLES)delete env[name];
  return {...env,...overrides} as NodeJS.ProcessEnv;
}
/** The release layout the entrypoint is launched through, including the current symlink. */
async function releaseRoot():Promise<string> {
  const root=await mkdtemp(join(tmpdir(),'dashboard-entry-'));
  const release=join(root,'releases','v1');await mkdir(release,{recursive:true});
  await build({entryPoints:[resolve('src/server/main.ts')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:join(release,'server.mjs')});
  // Production externals resolve from the app's installed dependencies, not this disposable root.
  await symlink(resolve('node_modules'),join(release,'node_modules'),'dir');
  // The local-mode session token is injected into the page it serves, so a test that needs an
  // authenticated request reads it from there; only these bytes have to exist.
  await mkdir(join(release,'client'),{recursive:true});
  await writeFile(join(release,'client','index.html'),'<!doctype html><html><head></head><body></body></html>');
  await symlink(release,join(root,'current'),'dir');
  return root;
}
function spawnServer(script:string,overrides:NodeJS.ProcessEnv):ChildProcess {
  return spawn(process.execPath,[script],{env:testEnv(overrides),stdio:['ignore','pipe','pipe']});
}
function collect(child:ChildProcess) {
  let out='',err='';
  child.stdout?.on('data',chunk=>{out+=chunk;});
  child.stderr?.on('data',chunk=>{err+=chunk;});
  return {stdout:()=>out,stderr:()=>err};
}
const sleep=(ms:number)=>new Promise(ok=>setTimeout(ok,ms));
/** Polls a condition that a real server satisfies asynchronously; bounded, so it never hangs a test. */
async function waitFor<T>(check:()=>Promise<T|undefined>,timeoutMs=10000):Promise<T>{
 const until=Date.now()+timeoutMs;
 for(;;){
  const value=await check();
  if(value!==undefined)return value;
  if(Date.now()>until)throw Error('condition was not met in time');
  await sleep(100);
 }
}
/** The local-mode session token, exactly as the served page carries it. */
async function sessionToken(port:number):Promise<string> {
  const html=await (await fetch('http://127.0.0.1:'+port+'/')).text();
  const match=html.match(/name="dashboard-token" content="([a-f0-9]+)"/);
  assert.ok(match,'the served page must carry the session token: '+html.slice(0,200));
  return match[1];
}
/**
 * One authenticated request that stops mid-body. Authentication has happened and the handler is
 * waiting for bytes that never arrive, so the server can neither answer nor finish closing.
 */
async function holdRequestOpen(port:number,token:string):Promise<{held:ClientRequest;answered:()=>boolean}> {
  let answered=false;
  const held=request({host:'127.0.0.1',port,path:'/api/projects',method:'POST',headers:{host:'127.0.0.1:'+port,'x-dashboard-token':token,origin:'http://127.0.0.1:'+port,'content-type':'application/json','content-length':64}},res=>{answered=true;res.resume();});
  held.on('error',()=>{});
  await once(held,'socket');
  held.write('{"name":"unfinished');
  await sleep(250);
  return {held,answered:()=>answered};
}
function freePort():Promise<number> {
  return new Promise((ok,fail)=>{const probe=createServer();probe.once('error',fail);probe.listen(0,'127.0.0.1',()=>{const address=probe.address() as {port:number};probe.close(()=>ok(address.port));});});
}
function waitForListening(child:ChildProcess,stderr:()=>string,timeoutMs=10000):Promise<void> {
  return new Promise<void>((ok,fail)=>{
    const timer=setTimeout(()=>fail(Error('Entrypoint did not listen: '+stderr())),timeoutMs);
    child.stdout?.on('data',chunk=>{if(String(chunk).includes('Dashboard listening')){clearTimeout(timer);ok();}});
    child.once('exit',code=>{clearTimeout(timer);fail(Error('Early exit '+code+': '+stderr()));});
    child.once('error',error=>{clearTimeout(timer);fail(error);});
  });
}
/** One request with an explicit Host header, which fetch would not let a test set. */
function health(port:number,host:string):Promise<{status:number;body:string}> {
  return new Promise((ok,fail)=>{
    const req=request({host:'127.0.0.1',port,path:'/healthz',headers:{host}},res=>{let body='';res.on('data',chunk=>{body+=chunk;});res.on('end',()=>ok({status:res.statusCode??0,body}));});
    req.on('error',fail);req.end();
  });
}
async function expectNothingListening(port:number):Promise<void> {
  await assert.rejects(new Promise<void>((_ok,fail)=>{
    const socket=createConnection({host:'127.0.0.1',port});
    // Bounded, so a port that never answers fails the test instead of hanging the suite.
    const timer=setTimeout(()=>{socket.destroy();fail(Error('probe of port '+port+' did not settle'));},5000);
    const done=(settle:()=>void)=>{clearTimeout(timer);socket.destroy();settle();};
    socket.once('connect',()=>done(()=>fail(Object.assign(Error('something accepted a connection'),{code:'ELISTENING'}))));
    socket.once('error',error=>done(()=>fail(error)));
  }),{code:'ECONNREFUSED'},'nothing should be listening on port '+port);
}
/** A foreign listener is observed at the TCP level: it accepts connections but need never answer HTTP. */
function probePort(port:number):Promise<'accepted'|'refused'> {
  return new Promise((ok,fail)=>{
    const socket=createConnection({host:'127.0.0.1',port});
    let settled=false;
    const timer=setTimeout(()=>{if(!settled){settled=true;socket.destroy();fail(Error('probe of port '+port+' did not settle'));}},2000);
    const finish=(result:'accepted'|'refused'|Error)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();result instanceof Error?fail(result):ok(result);};
    socket.once('connect',()=>finish('accepted'));
    socket.once('error',error=>(error as NodeJS.ErrnoException).code==='ECONNREFUSED'?finish('refused'):finish(error));
  });
}
async function stop(child:ChildProcess,exited:Promise<unknown>,signal:NodeJS.Signals):Promise<void> {
  if(child.exitCode===null&&child.signalCode===null){child.kill(signal);await exited;}
}
/** A child that never exits must fail the test with its logs, not hang the suite. */
async function waitForExit(child:ChildProcess,exited:Promise<unknown>,logs:{stderr:()=>string},timeoutMs=15000):Promise<number|null> {
  let timer:NodeJS.Timeout|undefined;
  try {
    const [code]=await Promise.race([
      exited as Promise<[number|null,NodeJS.Signals|null]>,
      new Promise<never>((_ok,fail)=>{timer=setTimeout(()=>{child.kill('SIGKILL');fail(Error('the entrypoint did not exit within '+timeoutMs+'ms: '+logs.stderr()));},timeoutMs);})
    ]);
    return code;
  } finally {if(timer)clearTimeout(timer);}
}

test('startup bind, origin and exposure policy comes from the validated configuration',()=>{
 const local:NodeJS.ProcessEnv={DASHBOARD_MODE:'local'};
 assert.equal(effectiveConfig(local).bindHost,'127.0.0.1');
 assert.deepEqual([...effectiveConfig(local).allowedHosts],['127.0.0.1:4317']);
 const container=effectiveConfig({DASHBOARD_MODE:'hosted',DASHBOARD_ORIGIN:'https://pilot.example.test',CF_ACCESS_TEAM:'https://team.cloudflareaccess.com',CF_ACCESS_AUD:'audience',DASHBOARD_OWNER:'owner@example.com',DASHBOARD_EXPOSURE:'container-private-interface',DASHBOARD_BIND:'0.0.0.0'});
 assert.equal(container.bindHost,'0.0.0.0');
 assert.deepEqual([...container.allowedHosts],['pilot.example.test']);
 for(const DASHBOARD_BIND of ['localhost','256.1.1.1','::'])assert.throws(()=>effectiveConfig({...local,DASHBOARD_BIND}),/IPv4/);
 assert.throws(()=>effectiveConfig({...local,DASHBOARD_EXPOSURE:'container-private-interface'}),/host-loopback/);
 assert.throws(()=>effectiveConfig({}),/DASHBOARD_MODE explicitly/);
});
test('a contradictory mode and exposure combination exits non-zero without taking the root or listening',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_EXPOSURE:'container-private-interface',DASHBOARD_DATA:data,PORT:String(port)});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const [code]=await exited as [number];
  assert.notEqual(code,0,'a contradictory exposure must not start');
  assert.match(logs.stderr(),/host-loopback/);
  await assert.rejects(stat(join(data,'service.lock')),{code:'ENOENT'},'no lock may be taken');
  await expectNothingListening(port);
 }finally{
  await stop(child,exited,'SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
});
test('a held service lock fails startup closed and leaves that evidence byte-identical',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const canonical=await realpath(data),lockPath=join(canonical,'service.lock');
 // A real record from the reviewed module, held for the whole test: the spawned start must not
 // remove it. The test closes its own handle in the finally, so an open descriptor cannot outlive
 // this test and be collected as an error while a later test is running.
 const held=await acquireServiceLock({root:canonical,purpose:'service',rootId:'foreign-root-id',releaseId:'previous-release',schemaId:'pilot-state-1'});
 const before=await readFile(lockPath,'utf8');
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port)});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const [code]=await exited as [number];
  assert.notEqual(code,0,'a held lock must refuse startup');
  assert.match(logs.stderr(),/locked/);
  assert.ok(logs.stderr().includes(lockPath),'the diagnostic names the lock path: '+logs.stderr());
  assert.ok(logs.stderr().includes('No automatic recovery'),'the diagnostic states that recovery is not automatic');
  assert.equal(await readFile(lockPath,'utf8'),before,'the lock evidence is byte-identical');
  await expectNothingListening(port);
 }finally{
  await stop(child,exited,'SIGKILL');
  await held.release().catch(()=>{});
  await rm(root,{recursive:true,force:true});
 }
});
test('a failed bind releases the lock that failed start created and reports the bind failure',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 // A foreign listener owns the port, so this start's very first listen attempt fails.
 const blocker=createServer();
 await new Promise<void>((ok,fail)=>{blocker.once('error',fail);blocker.listen(0,'127.0.0.1',()=>ok());});
 const taken=(blocker.address() as {port:number}).port;
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(taken)});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const code=await waitForExit(child,exited,logs);
  assert.notEqual(code,0,'a failed bind must exit non-zero');
  assert.match(logs.stderr(),/EADDRINUSE|address already in use/,'the original bind failure is reported: '+logs.stderr());
  assert.doesNotMatch(logs.stderr(),/Shutdown|retained/,'a failed start must not report a retained lock: '+logs.stderr());
  await assert.rejects(stat(join(await realpath(data),'service.lock')),{code:'ENOENT'},'the failed start releases the lock it created');
  assert.equal(await probePort(taken),'accepted','the foreign blocker still owns that port');
 }finally{
  await stop(child,exited,'SIGKILL');
  await new Promise<void>(ok=>blocker.close(()=>ok()));
 }
 // Nothing was left behind: the same root starts on a free port and stops cleanly.
 const port=await freePort();
 const next=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port)});
 const nextLogs=collect(next),nextExited=once(next,'exit');
 try{
  await waitForListening(next,nextLogs.stderr);
  const lockPath=join(await realpath(data),'service.lock');
  assert.equal(JSON.parse(await readFile(lockPath,'utf8')).purpose,'service');
  assert.equal((await health(port,'127.0.0.1:'+port)).status,200,'the start after the failure serves requests');
  next.kill('SIGTERM');
  assert.equal(await waitForExit(next,nextExited,nextLogs),0,'a start after a bind failure stops cleanly');
  await assert.rejects(stat(lockPath),{code:'ENOENT'},'a clean stop still releases the lock');
 }finally{
  await stop(next,nextExited,'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
});
test('startup values outside the effective configuration are bounded and fail closed before the root exists',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 // Lock identity becomes durable evidence, and the drain deadline is an operator knob, so both are
 // bounded. None of these may reach the filesystem: the data root must not even be created.
 const rejected:readonly (readonly [string,string])[]=[
  ['DASHBOARD_ROOT_ID','root id with spaces'],
  ['DASHBOARD_ROOT_ID','a'.repeat(121)],
  ['DASHBOARD_RELEASE','x'.repeat(200)],
  ['DASHBOARD_SHUTDOWN_DEADLINE_MS','0'],
  ['DASHBOARD_SHUTDOWN_DEADLINE_MS','60001'],
  ['DASHBOARD_SHUTDOWN_DEADLINE_MS','1.5']
 ];
 try{
  for(const [name,value] of rejected){
   const port=await freePort();
   const overrides:NodeJS.ProcessEnv={DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port)};
   overrides[name]=value;
   const child=spawnServer(join(root,'current','server.mjs'),overrides);
   const logs=collect(child),exited=once(child,'exit');
   try{
    const code=await waitForExit(child,exited,logs);
    assert.notEqual(code,0,name+'='+value+' must fail closed');
    assert.match(logs.stderr(),new RegExp(name),'the message names the variable: '+logs.stderr());
    assert.match(logs.stderr(),/must be a positive whole number|must be between 1 and 60000|must be 1-120 characters/,'the message states the requirement: '+logs.stderr());
    await assert.rejects(stat(data),{code:'ENOENT'},'nothing is created for an invalid startup value');
    await expectNothingListening(port);
   }finally{
    await stop(child,exited,'SIGKILL');
   }
  }
 }finally{
  await rm(root,{recursive:true,force:true});
 }
});
test('the entrypoint starts through the current release symlink, holds the startup lock and releases it on SIGTERM',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
 const logs=collect(child),exited=once(child,'exit');
 try{
  await waitForListening(child,logs.stderr);
  const canonical=await realpath(data),lockPath=join(canonical,'service.lock');
  assert.equal((await stat(canonical)).mode&0o777,0o700,'the data root is created 0700');
  const record=JSON.parse(await readFile(lockPath,'utf8'));
  assert.equal(record.version,1);
  assert.equal(record.purpose,'service');
  assert.equal(record.schemaId,'pilot-state-1');
  assert.equal(record.releaseId,'unreleased-local');
  assert.equal(record.root,canonical);
  assert.equal(record.rootId,createHash('sha256').update(canonical).digest('hex').slice(0,16));
  assert.equal(record.process.pid,child.pid);
  const served=await health(port,'127.0.0.1:'+port);
  assert.equal(served.status,200);
  assert.deepEqual(JSON.parse(served.body),{ok:true});
  assert.equal((await health(port,'evil.example')).status,403,'a mismatching Host is refused');
  child.kill('SIGTERM');
  assert.equal((await exited as [number])[0],0);
  await assert.rejects(stat(lockPath),{code:'ENOENT'},'a clean stop releases the lock');
 }finally{
  await stop(child,exited,'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
});
test('a drain that misses its deadline retains the lock and reports the timeout, and the root is usable once the operator clears it',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_SHUTDOWN_DEADLINE_MS:'1'});
 const logs=collect(child),exited=once(child,'exit');
 let held:ClientRequest|undefined;
 try{
  await waitForListening(child,logs.stderr);
  const lockPath=join(await realpath(data),'service.lock');
  const open=await holdRequestOpen(port,await sessionToken(port));
  held=open.held;
  assert.equal(open.answered(),false,'the held request must be accepted and left unanswered: '+logs.stderr());
  child.kill('SIGTERM');
  const code=await waitForExit(child,exited,logs);
  assert.notEqual(code,0,'a drain that misses the deadline must exit non-zero');
  assert.match(logs.stderr(),/Shutdown did not finish within 1ms after SIGTERM/);
  assert.match(logs.stderr(),/intentionally retained/);
  assert.match(logs.stderr(),/no automatic recovery is performed/);
  assert.equal(await stat(lockPath).then(()=>true,()=>false),true,'the lock is retained, not stolen');
  // Recovery stays a deliberate operator action: nothing may take the lock over on its own.
  held.destroy();held=undefined;
  await unlink(lockPath);
  const freshPort=await freePort();
  const fresh=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(freshPort)});
  const freshLogs=collect(fresh),freshExited=once(fresh,'exit');
  try{
   await waitForListening(fresh,freshLogs.stderr);
   assert.equal((await health(freshPort,'127.0.0.1:'+freshPort)).status,200,'the root is usable again');
   fresh.kill('SIGTERM');
   assert.equal(await waitForExit(fresh,freshExited,freshLogs),0,'the root starts again after the evidence is cleared');
   await assert.rejects(stat(lockPath),{code:'ENOENT'},'the fresh start releases its own lock');
  }finally{
   await stop(fresh,freshExited,'SIGTERM');
  }
 }finally{
  held?.destroy();
  await stop(child,exited,'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
});
test('DASHBOARD_ROOT_ID and DASHBOARD_RELEASE name the lock identity, and SIGINT stops cleanly',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_ROOT_ID:'operator-named-root',DASHBOARD_RELEASE:'v9.9.9'});
 const logs=collect(child),exited=once(child,'exit');
 try{
  await waitForListening(child,logs.stderr);
  const lockPath=join(await realpath(data),'service.lock');
  const record=JSON.parse(await readFile(lockPath,'utf8'));
  assert.equal(record.rootId,'operator-named-root');
  assert.equal(record.releaseId,'v9.9.9');
  child.kill('SIGINT');
  assert.equal((await exited as [number])[0],0,'SIGINT drains and exits cleanly too');
  await assert.rejects(stat(lockPath),{code:'ENOENT'});
 }finally{
  await stop(child,exited,'SIGINT');
  await rm(root,{recursive:true,force:true});
 }
});
test('a stop during startup drains and releases the lock instead of stranding it',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 const lockAt=()=>join(data,'service.lock');
 const lockPresent=()=>stat(lockAt()).then(()=>true,()=>false);
 const waitForLock=async(timeoutMs:number)=>{const start=Date.now();while(Date.now()-start<timeoutMs){if(await lockPresent())return true;await sleep(1);}return false;};
 // SIGTERM is sent without waiting for the listen line, across the startup window: immediately
 // after spawn (before the lock exists), and as soon as service.lock appears — the moment the lock
 // exists but the server has not yet listened, which is exactly where the old ordering installed
 // its handlers too late and a stop terminated by default action, stranding the lock. Every trial
 // must exit within a bounded time and leave no service.lock.
 const trials:{[k:string]:unknown}[]=[{label:'immediate-1'},{label:'immediate-2'},{label:'immediate-3'},{label:'on-lock-1',waitForLock:true},{label:'on-lock-2',waitForLock:true},{label:'on-lock-3',waitForLock:true},{label:'delay-100ms',delayMs:100}];
 try{
  for(const trial of trials){
   const label=trial.label as string;
   const port=await freePort();
   const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
   const logs=collect(child),exited=once(child,'exit');
   try{
    if(trial.delayMs)await sleep(trial.delayMs as number);
    if(trial.waitForLock)assert.equal(await waitForLock(3000),true,'trial '+label+' must reach the point where the lock exists: '+logs.stderr());
    child.kill('SIGTERM');
    const code=await waitForExit(child,exited,logs,10000);
    assert.ok(code===0||code===null,'a stop during startup ('+label+') must exit promptly, got '+code+': '+logs.stderr());
    assert.equal(await lockPresent(),false,'no service.lock may be stranded ('+label+'): '+logs.stderr());
   }finally{
    await stop(child,exited,'SIGKILL');
   }
  }
 }finally{
  await rm(root,{recursive:true,force:true});
 }
});
/** Every file in a directory tree, as a stable name-to-content fingerprint. */
async function snapshotTree(dir:string,prefix=''):Promise<Record<string,string>>{
 const out:Record<string,string>={};
 for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(dir,entry.name),key=prefix+entry.name;
  if(entry.isDirectory())Object.assign(out,await snapshotTree(path,key+'/'));
  else if(entry.isSymbolicLink())out[key]='symlink -> '+await readlink(path);
  else out[key]='sha256:'+createHash('sha256').update(await readFile(path)).digest('hex');
 }
 return out;
}
/** One request that carries an explicit Host, so the readiness Host check can be exercised. */
function statusFor(port:number,path:string,host:string,headers:Record<string,string>={}):Promise<{status:number;body:string}> {
 return new Promise((ok,fail)=>{
  const req=request({host:'127.0.0.1',port,path,headers:{host,...headers}},res=>{let body='';res.on('data',chunk=>{body+=chunk;});res.on('end',()=>ok({status:res.statusCode??0,body}));});
  req.on('error',fail);req.end();
 });
}
/** The doctor shares the bundle but starts nothing; it is spawned like any other entry invocation. */
function spawnDoctor(script:string,overrides:NodeJS.ProcessEnv):ChildProcess {
  return spawn(process.execPath,[script,'--doctor'],{env:testEnv(overrides),stdio:['ignore','pipe','pipe']});
}
test('the read-only doctor reports a healthy disposable root and exits zero without taking anything',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 // A sentinel proves the whole directory is untouched, not merely that no service.lock appeared.
 await writeFile(join(data,'operator-note.txt'),'keep me\n');
 const before=await snapshotTree(data);
 const port=await freePort();
 const child=spawnDoctor(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port)});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const [code]=await exited as [number];
  assert.equal(code,0,'a healthy root must diagnose clean: '+logs.stderr());
  const report=JSON.parse(logs.stdout());
  assert.equal(report.readOnly,true);
  assert.match(report.guarantee,/acquires no lock/);
  assert.match(report.guarantee,/rewrites nothing/);
  assert.equal(report.configuration.mode,'local');
  assert.equal(report.configuration.allowedHost,'127.0.0.1:'+port);
  assert.equal(report.dataRoot.permissions,'0700');
  assert.equal(report.dataRoot.groupOrOtherAccessible,false);
  assert.equal(report.serviceLock.classification,'absent');
  assert.equal(report.storageSchema.state,'absent');
  assert.equal(report.release.status,'absent');
  assert.equal(report.server.probe,'not-listening');
  assert.equal(report.unsafe,false);
  assert.deepEqual(report.startBlockers,[],'a healthy root blocks nothing');
  await assert.rejects(stat(join(data,'service.lock')),{code:'ENOENT'},'the doctor takes no lock');
  assert.deepEqual(await snapshotTree(data),before,'the whole directory is byte-identical afterwards');
  await expectNothingListening(port);
 }finally{
  await stop(child,exited,'SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
});
test('the doctor finds malformed lock evidence unsafe, exits non-zero and leaves it byte-identical',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const canonical=await realpath(data),lockPath=join(canonical,'service.lock');
 await writeFile(lockPath,'{"version":1,"root":"truncated');
 const before=await readFile(lockPath);
 const child=spawnDoctor(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(await freePort())});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const [code]=await exited as [number];
  assert.notEqual(code,0,'malformed lock evidence is an unsafe condition');
  const report=JSON.parse(logs.stdout());
  assert.equal(report.unsafe,true);
  assert.equal(report.serviceLock.classification,'ambiguous');
  assert.equal(report.serviceLock.metadata,null);
  assert.match(report.serviceLock.reason,/unreadable or malformed|not a regular file|legacy or malformed/);
  assert.deepEqual(await readFile(lockPath),before,'the malformed evidence must be byte-identical afterwards');
 }finally{
  await stop(child,exited,'SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
});
test('hosted mode refuses to start without a release manifest, before the data root exists',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'hosted',DASHBOARD_ORIGIN:'https://pilot.example.test',CF_ACCESS_TEAM:'https://team.cloudflareaccess.com',CF_ACCESS_AUD:'audience',DASHBOARD_OWNER:'owner@example.com',DASHBOARD_DATA:data,PORT:String(port)});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const [code]=await exited as [number];
  assert.notEqual(code,0,'hosted mode must refuse a missing manifest');
  assert.match(logs.stderr(),/release manifest/);
  assert.match(logs.stderr(),/DASHBOARD_RELEASE_MANIFEST/);
  await assert.rejects(stat(data),{code:'ENOENT'},'no data root is created before the refusal');
  await expectNothingListening(port);
 }finally{
  await stop(child,exited,'SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
});
test('a release manifest supplies the lock releaseId and schemaId, and a malformed one fails closed',async()=>{
 const manifest={version:'2.5.0',releaseId:'release-2026-01',schemaId:'pilot-state-1',createdAt:'2026-01-01T00:00:00.000Z',sourceDigest:'a'.repeat(40)};
 const root=await releaseRoot(),data=join(root,'data');
 await writeFile(join(root,'releases','v1','release.json'),JSON.stringify(manifest));
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_RELEASE:'overridden-by-manifest'});
 const logs=collect(child),exited=once(child,'exit');
 try{
  await waitForListening(child,logs.stderr);
  const lockPath=join(await realpath(data),'service.lock');
  const record=JSON.parse(await readFile(lockPath,'utf8'));
  assert.equal(record.releaseId,'release-2026-01');
  assert.equal(record.schemaId,'pilot-state-1');
  child.kill('SIGTERM');
  assert.equal((await exited as [number])[0],0);
  await assert.rejects(stat(lockPath),{code:'ENOENT'},'a clean stop releases the lock');
 }finally{
  await stop(child,exited,'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
 // A manifest naming an unsupported schema fails closed even in local mode, before the root exists.
 const bad=await releaseRoot();
 await writeFile(join(bad,'releases','v1','release.json'),JSON.stringify({...manifest,schemaId:'pilot-state-2'}));
 const badPort=await freePort();
 const badChild=spawnServer(join(bad,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:join(bad,'data'),PORT:String(badPort)});
 const badLogs=collect(badChild),badExited=once(badChild,'exit');
 try{
  const [code]=await badExited as [number];
  assert.notEqual(code,0,'an unsupported schema version must fail closed');
  assert.match(badLogs.stderr(),/unsupported schema version/);
  await assert.rejects(stat(join(bad,'data')),{code:'ENOENT'},'no data root is created for an invalid manifest');
  await expectNothingListening(badPort);
 }finally{
  await stop(badChild,badExited,'SIGKILL');
  await rm(bad,{recursive:true,force:true});
 }
});

test('the running service reports its release identity, refuses a release the store did not promote, and keeps readiness intact',async()=>{
 const manifest={version:'2.5.0',releaseId:'release-2026-01',schemaId:'pilot-state-1',createdAt:'2026-01-01T00:00:00.000Z',sourceDigest:'a'.repeat(40)};
 const root=await releaseRoot(),data=join(root,'data');
 await writeFile(join(root,'releases','v1','release.json'),JSON.stringify(manifest));
 // The promoted candidate is recorded in the data root's own control store, through the release
 // store's synthetic port: no container is built and no VPS is touched anywhere in this test.
 await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const releases=new ReleaseStore(store,{promotionPort:{activate:async(request)=>({pointer:'/srv/pilot/releases/'+request.releaseId,removed:[]})}});
 releases.createCandidate({candidateId:'cand-1',releaseId:manifest.releaseId,schemaId:manifest.schemaId,sourceDigest:manifest.sourceDigest,environment:'hosted-vps',createdAt:manifest.createdAt,artifact:{repository:'ghcr.io/owner/pilot',kind:'immutable-tag',identity:'v2.5.0',reference:'ghcr.io/owner/pilot:v2.5.0'}});
 await releases.promote({candidateId:'cand-1',expectedRevision:0,actor:'owner'});
 store.close();
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
 const logs=collect(child),exited=once(child,'exit');
 try{
  await waitForListening(child,logs.stderr);
  const token=await sessionToken(port),host='127.0.0.1:'+port,headers={'x-dashboard-token':token};
  const canonical=await realpath(data);
  assert.equal((await statusFor(port,'/api/release',host)).status,401,'the release identity is behind the owner door');
  const report=await statusFor(port,'/api/release',host,headers);
  assert.equal(report.status,200,logs.stderr());
  const body=JSON.parse(report.body);
  assert.deepEqual(body.release,{releaseId:manifest.releaseId,schemaId:manifest.schemaId,expectedSchemaVersion:1,version:'2.5.0',source:'manifest',sourceDigest:manifest.sourceDigest,buildId:null});
  assert.equal(body.promotion.state,'match','the manifest identity is the promoted candidate');
  assert.equal(body.promotion.revision,1);
  assert.equal(body.promotion.candidate.candidateId,'cand-1');
  assert.deepEqual(body.promotion.candidate.artifact,{repository:'ghcr.io/owner/pilot',kind:'immutable-tag',reference:'ghcr.io/owner/pilot:v2.5.0',identity:'v2.5.0'});
  assert.deepEqual(body.reasons,[]);
  assert.ok(!report.body.includes(canonical),'the release report carries no filesystem path');
  // Readiness itself is unchanged: the same facts and the same reasons as before this feature.
  const ready=await statusFor(port,'/readyz',host,headers);
  assert.equal(ready.status,200);
  assert.deepEqual(JSON.parse(ready.body),{ok:true,releaseId:manifest.releaseId,schemaId:manifest.schemaId,lockHeld:true,dataRootWritable:true,reasons:[]});
  child.kill('SIGTERM');
  assert.equal(await waitForExit(child,exited,logs),0,'a clean stop exits zero');
 }finally{
  await stop(child,exited,'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
 // The same promoted store under a different manifest identity: the start is refused, nothing listens
 // and the lock it took is released, so the refusal strands nothing.
 const other=await releaseRoot(),otherData=join(other,'data');
 await writeFile(join(other,'releases','v1','release.json'),JSON.stringify({...manifest,releaseId:'release-2026-02'}));
 await mkdir(otherData,{recursive:true,mode:0o700});
 const otherStore=new ControlStore(otherData);
 const otherReleases=new ReleaseStore(otherStore,{promotionPort:{activate:async(request)=>({pointer:'/srv/pilot/releases/'+request.releaseId,removed:[]})}});
 otherReleases.createCandidate({candidateId:'cand-1',releaseId:manifest.releaseId,schemaId:manifest.schemaId,sourceDigest:manifest.sourceDigest,environment:'hosted-vps',createdAt:manifest.createdAt,artifact:{repository:'ghcr.io/owner/pilot',kind:'immutable-tag',identity:'v2.5.0',reference:'ghcr.io/owner/pilot:v2.5.0'}});
 await otherReleases.promote({candidateId:'cand-1',expectedRevision:0,actor:'owner'});
 otherStore.close();
 const otherPort=await freePort();
 const mismatched=spawnServer(join(other,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:otherData,PORT:String(otherPort),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
 const mismatchedLogs=collect(mismatched),mismatchedExited=once(mismatched,'exit');
 try{
  const [code]=await mismatchedExited as [number];
  assert.notEqual(code,0,'a build that is not the promoted release must fail closed');
  assert.match(mismatchedLogs.stderr(),/the control store says the promoted release is release-2026-01/);
  assert.match(mismatchedLogs.stderr(),/differing in releaseId/);
  await expectNothingListening(otherPort);
  await assert.rejects(stat(join(await realpath(otherData),'service.lock')),{code:'ENOENT'},'the refusal releases the lock it took');
 }finally{
  await stop(mismatched,mismatchedExited,'SIGKILL');
  await rm(other,{recursive:true,force:true});
 }
 // A promotion history that cannot be read refuses the start too: nothing is served on a guess.
 const broken=await releaseRoot(),brokenData=join(broken,'data');
 await writeFile(join(broken,'releases','v1','release.json'),JSON.stringify(manifest));
 await mkdir(brokenData,{recursive:true,mode:0o700});
 const brokenStore=new ControlStore(brokenData);
 const brokenReleases=new ReleaseStore(brokenStore,{promotionPort:{activate:async(request)=>({pointer:'/srv/pilot/releases/'+request.releaseId,removed:[]})}});
 brokenReleases.createCandidate({candidateId:'cand-1',releaseId:manifest.releaseId,schemaId:manifest.schemaId,sourceDigest:manifest.sourceDigest,environment:'hosted-vps',createdAt:manifest.createdAt,artifact:{repository:'ghcr.io/owner/pilot',kind:'immutable-tag',identity:'v2.5.0',reference:'ghcr.io/owner/pilot:v2.5.0'}});
 const event=await brokenReleases.promote({candidateId:'cand-1',expectedRevision:0,actor:'owner'});
 brokenStore.close();
 const tamper=new DatabaseSync(join(await realpath(brokenData),'control.sqlite'));
 tamper.prepare("UPDATE operations SET input_json=? WHERE kind='release.promotion'").run(JSON.stringify({...event,actor:'someone-else'}));
 tamper.close();
 const brokenPort=await freePort();
 const brokenChild=spawnServer(join(broken,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:brokenData,PORT:String(brokenPort),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
 const brokenLogs=collect(brokenChild),brokenExited=once(brokenChild,'exit');
 try{
  const [code]=await brokenExited as [number];
  assert.notEqual(code,0,'an unreadable promotion history must fail closed');
  assert.match(brokenLogs.stderr(),/promotion history in the control store could not be read/);
  await expectNothingListening(brokenPort);
 }finally{
  await stop(brokenChild,brokenExited,'SIGKILL');
  await rm(broken,{recursive:true,force:true});
 }
});

test('a real start creates the control schema and answers authenticated readiness from the live handle',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
 const logs=collect(child),exited=once(child,'exit');
 try{
  await waitForListening(child,logs.stderr);
  const canonical=await realpath(data),schemaFile=join(canonical,'control.sqlite');
  // Startup itself creates the storage the documentation tells supervisors to gate on, so a real
  // deployment cannot answer 503 storage-schema-absent while nothing was ever going to create it.
  assert.equal((await stat(schemaFile)).mode&0o777,0o600,'the control database is created 0600');
  assert.deepEqual(observeStorageSchema(canonical),{state:'present',version:1},'the created schema is the one this build expects');
  const token=await sessionToken(port);
  const ready=await statusFor(port,'/readyz','127.0.0.1:'+port,{'x-dashboard-token':token});
  assert.equal(ready.status,200,'readiness passes on a fresh root: '+logs.stderr());
  const body=JSON.parse(ready.body);
  assert.deepEqual(body,{ok:true,releaseId:'unreleased-local',schemaId:'pilot-state-1',lockHeld:true,dataRootWritable:true,reasons:[]});
  assert.ok(!ready.body.includes(canonical),'readiness carries no filesystem path');
  assert.equal((await statusFor(port,'/readyz','127.0.0.1:'+port)).status,401,'readiness stays behind owner auth');
  assert.equal((await statusFor(port,'/readyz','evil.example',{'x-dashboard-token':token})).status,403,'the unchanged Host check still applies');
  // The documented writable-data-root condition is real, not only documented.
  await chmod(canonical,0o500);
  try{
   const blocked=await statusFor(port,'/readyz','127.0.0.1:'+port,{'x-dashboard-token':token});
   assert.equal(blocked.status,503);
   assert.deepEqual(JSON.parse(blocked.body).reasons,['data-root-not-writable']);
  }finally{await chmod(canonical,0o700);}
  child.kill('SIGTERM');
  assert.equal(await waitForExit(child,exited,logs),0,'a clean stop exits zero');
  await assert.rejects(stat(join(canonical,'service.lock')),{code:'ENOENT'},'the store is closed before the lock is released');
 }finally{
  await stop(child,exited,'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
});
test('a real start serves an authenticated single-use approval from the live control store, and a restart does not revive it',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
 const logs=collect(child),exited=once(child,'exit');
 let restarted:ChildProcess|null=null,restartedExit:Promise<unknown>|null=null;
 const target={remote:'git@github.com:owner/repo.git',branch:'main',commitSha:'a'.repeat(40)};
 const post=(atPort:number,token:string,path:string,body:unknown)=>fetch('http://127.0.0.1:'+atPort+path,{method:'POST',headers:{'x-dashboard-token':token,'content-type':'application/json',origin:'http://127.0.0.1:'+atPort},body:JSON.stringify(body)});
 try{
  await waitForListening(child,logs.stderr);
  const token=await sessionToken(port);
  assert.equal((await statusFor(port,'/api/approvals?projectId=project-a','127.0.0.1:'+port)).status,401,'approvals are behind owner auth on a real start');
  assert.equal((await statusFor(port,'/api/approvals?projectId=project-a','evil.example',{'x-dashboard-token':token})).status,403,'the unchanged Host check still applies');
  const created=await post(port,token,'/api/approvals',{kind:'push',scope:{projectId:'project-a'},target,expiresAt:new Date(Date.now()+600000).toISOString()});
  assert.equal(created.status,201,logs.stderr());
  const id=(await created.json()).approval.id as string;
  const consumed=await post(port,token,'/api/approvals/'+id+'/consume',{scope:{projectId:'project-a'},kind:'push',target,consumedBy:'owner'});
  assert.equal(consumed.status,200);
  assert.deepEqual((await consumed.json()).target,target,'consuming returns the exact target it authorised');
  child.kill('SIGTERM');
  assert.equal(await waitForExit(child,exited,logs),0,'a clean stop exits zero');

  // The same data root again: the control store is the authority, so a spent approval is still spent.
  const port2=await freePort();
  restarted=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port2),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
  restartedExit=once(restarted,'exit');
  const restartedLogs=collect(restarted);
  await waitForListening(restarted,restartedLogs.stderr);
  const token2=await sessionToken(port2);
  const read=await statusFor(port2,'/api/approvals/'+id+'?projectId=project-a','127.0.0.1:'+port2,{'x-dashboard-token':token2});
  assert.equal(read.status,200);
  assert.equal(JSON.parse(read.body).approval.state,'consumed','the record survives the restart, consumed');
  const replay=await post(port2,token2,'/api/approvals/'+id+'/consume',{scope:{projectId:'project-a'},kind:'push',target,consumedBy:'owner'});
  assert.equal(replay.status,409,'a replay after a restart is refused');
  assert.match((await replay.json()).error,/already consumed/);
 }finally{
  if(restarted)await stop(restarted,restartedExit!,'SIGTERM');
  await stop(child,exited,'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
});
test('a real start reconciles the delivery ledger it finds: it re-sends only what it can prove idempotent and reports the rest',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 // The rows a crash left behind: one intact question delivery whose notification never went out (no
 // device is subscribed on this root), and one whose stored payload no longer matches its delivery.
 const store=new ControlStore(data),ledger=new DeliveryLedger(store);
 const scope={projectId:'project-a',sessionId:'session-1'};
 const honest=ledger.admitQuestion({...scope,questionId:'11111111-1111-4111-8111-111111111111',text:'Should I proceed?',askedAt:1700000000000});
 const tampered=ledger.admitQuestion({...scope,questionId:'22222222-2222-4222-8222-222222222222',text:'Which provider?',askedAt:1700000000001});
 const outboxRows=(id:string)=>JSON.stringify(store.db.prepare('SELECT * FROM outboxes WHERE operation_id=?').all(id));
 const refusedWas=outboxRows(tampered.operation.id);
 store.db.prepare('UPDATE outboxes SET payload_json=? WHERE operation_id=?').run(JSON.stringify({version:1,delivery:'question',questionId:'22222222-2222-4222-8222-222222222222',tag:'question:someone-else',requestId:null}),tampered.operation.id);
 const refusedIs=outboxRows(tampered.operation.id);
 store.close();
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:'',DASHBOARD_AGENTS:'on'});
 const logs=collect(child),exited=once(child,'exit');
 try{
  await waitForListening(child,logs.stderr);
  const line=logs.stdout().split('\n').find(entry=>entry.startsWith('Delivery reconciliation: '));
  assert.ok(line,'the start reports the reconciliation it performed: '+logs.stdout());
  const summary=JSON.parse(line!.slice('Delivery reconciliation: '.length));
  assert.equal(summary.readOnly,false);
  assert.deepEqual(summary.counts,{pendingOperations:2,undeliveredOutboxRows:2,redeliverIdempotent:1,completeAcknowledgement:0,needsOperatorAttention:1});
  // The licensed re-send was attempted and the channel reported that it sent nothing, so the row
  // stays outstanding instead of being acknowledged as delivered; the row that cannot be proven
  // idempotent is reported and never replayed.
  assert.deepEqual(summary.actions,{redelivered:0,completed:0,outstanding:1,needsOperatorAttention:1});
  assert.equal(summary.attention.length,1);
  assert.match(summary.attention[0].reason,/does not match this delivery/);
  assert.equal(summary.attention[0].questionId,'22222222-2222-4222-8222-222222222222');
  // The report is a receipt report: no question text, no filesystem path.
  assert.ok(!line!.includes('Should I proceed?'),'the reconciliation reports no question text');
  assert.ok(!line!.includes(await realpath(data)),'the reconciliation reports no filesystem path');
  child.kill('SIGTERM');
  assert.equal(await waitForExit(child,exited,logs),0,'a clean stop exits zero');
 }finally{await stop(child,exited,'SIGTERM');}
 // The start duplicated nothing and rewrote nothing it refused: the ledger is what it was.
 const reopened=new ControlStore(data);
 assert.equal((reopened.db.prepare('SELECT count(*) AS n FROM operations WHERE kind=?').get('question.delivery') as {n:number}).n,2,'the start created no second row');
 assert.equal((reopened.db.prepare('SELECT count(*) AS n FROM outboxes WHERE operation_id=?').get(honest.operation.id) as {n:number}).n,1);
 assert.equal(JSON.stringify(reopened.db.prepare('SELECT * FROM outboxes WHERE operation_id=?').all(tampered.operation.id)),refusedIs,'the refused row kept its state through the whole start');
 reopened.close();
 await rm(root,{recursive:true,force:true});
});
/**
 * The crash window Milestone C2 could not recover: the ledger holds the answer and the transcript
 * write never happened, so the question is open in the interface and the human's answer exists only
 * in the durable record. A start must finish that record from the ledger's own text, once, under the
 * request id derived from the question, instead of reporting a question it holds an answer for as
 * unanswerable.
 */
test('a real start completes the transcript write and the submission for an answer the ledger holds, exactly once',async()=>{
 const root=await releaseRoot();
 try{
  const data=join(root,'data');
  const env:NodeJS.ProcessEnv={DASHBOARD_MODE:'local',DASHBOARD_DATA:data,DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:'',DASHBOARD_AGENTS:'on',DASHBOARD_AGENT_PAUSE_MS:'100'};
  const answerText='Yes, finish the answer record.';
  const auth=(token:string)=>({'x-dashboard-token':token});
  const writes=(token:string,port:number)=>({...auth(token),'content-type':'application/json',origin:'http://127.0.0.1:'+port});
  type AgentResponse={view:{conversationId:string;entries:{kind:string;rawKind:string;text:string}[];questions:{id:string;text:string;answer:{text:string}|null}[]};delivery:{scope:{projectId:string;sessionId:string};questions:{questionId:string;delivered:boolean}[];answers:{questionId:string;delivered:boolean;receipt:{submissionId?:string;requestId?:string}|null}[]}};
  const agentView=async(port:number,token:string,projectId:string)=>await (await fetch('http://127.0.0.1:'+port+'/api/projects/'+projectId+'/agents',{headers:auth(token)})).json() as AgentResponse;
  let projectId='',sessionId='',questionId='';

  // One real start asks the question in the transcript and admits it to the ledger.
  const port=await freePort();
  const child=spawnServer(join(root,'current','server.mjs'),{...env,PORT:String(port)});
  const logs=collect(child),exited=once(child,'exit');
  try{
   await waitForListening(child,logs.stderr);
   const token=await sessionToken(port);
   const created=await fetch('http://127.0.0.1:'+port+'/api/projects',{method:'POST',headers:writes(token,port),body:JSON.stringify({name:'Answer recovery',managed:true,confirm:true})});
   assert.equal(created.status,201,logs.stderr());
   projectId=((await created.json()) as {id:string}).id;
   const started=await fetch('http://127.0.0.1:'+port+'/api/projects/'+projectId+'/agents/input',{method:'POST',headers:writes(token,port),body:JSON.stringify({text:'[ask] finish the answer record',mode:'followUp',requestId:'seed-question'})});
   assert.equal(started.status,200,logs.stderr());
   const open=await waitFor(async()=>{
    const view=await agentView(port,token,projectId);
    const asked=view.view.questions[0];
    return asked&&view.delivery?.questions?.some(row=>row.questionId===asked.id)?view:undefined;
   });
   questionId=open.view.questions[0].id;
   sessionId=open.view.conversationId;
   assert.equal(open.view.questions[0].answer,null,'the question is open in the interface');
   child.kill('SIGTERM');
   assert.equal(await waitForExit(child,exited,logs),0,'a clean stop exits zero');
  }finally{await stop(child,exited,'SIGTERM');}

  // The crash window, written to the durable store while nothing holds it: the answer record exists,
  // and no transcript write and no submission ever happened.
  const seeded=new ControlStore(data);
  try{
   const ledger=new DeliveryLedger(seeded);
   assert.equal(ledger.hasQuestion(questionId,{projectId,sessionId}),true,'the live question really was admitted under this session');
   const recorded=ledger.answerQuestion({projectId,sessionId,questionId,text:answerText,answeredAt:Date.now()});
   assert.equal(recorded.operation.state,'pending');
   assert.equal(recorded.outbox.state,'pending');
   assert.equal(ledger.deliveries({projectId,sessionId}).answers[0].receipt,null,'the answer was never delivered');
   assert.equal(ledger.deliveries({projectId,sessionId}).answers[0].delivered,false);
   assert.ok(!JSON.stringify(ledger.deliveries({projectId,sessionId})).includes(answerText),'the owner view exposes no answer text');
  }finally{seeded.close();}

  // The next start reconciles before it listens: the answer row is completed from the ledger's own
  // text and acknowledged, while the question notification (no device on this root) stays outstanding.
  const port2=await freePort();
  const second=spawnServer(join(root,'current','server.mjs'),{...env,PORT:String(port2)});
  const secondLogs=collect(second),secondExited=once(second,'exit');
  try{
   await waitForListening(second,secondLogs.stderr);
   const line=secondLogs.stdout().split('\n').find(entry=>entry.startsWith('Delivery reconciliation: '));
   assert.ok(line,'the start reports the reconciliation it performed: '+secondLogs.stdout());
   const summary=JSON.parse(line!.slice('Delivery reconciliation: '.length));
   assert.deepEqual(summary.actions,{redelivered:1,completed:0,outstanding:1,needsOperatorAttention:0});
   assert.ok(!line!.includes(answerText),'the reconciliation reports no answer text');
   const token=await sessionToken(port2);
   const answered=await waitFor(async()=>{
    const view=await agentView(port2,token,projectId);
    return view.view.questions[0]?.answer?view:undefined;
   });
   assert.equal(answered.view.questions[0].answer!.text,answerText,'the ledger\'s recorded answer completed the transcript write');
   assert.equal(answered.view.entries.filter(entry=>entry.rawKind==='app.answer').length,1,'exactly one answer entry was written');
   assert.equal(answered.view.entries.filter(entry=>entry.kind==='user'&&entry.text===answerText).length,1,'the agent received the answer exactly once');
   const settled=await waitFor(async()=>{
    const view=await agentView(port2,token,projectId);
    return view.delivery?.answers?.[0]?.delivered?view:undefined;
   });
   assert.equal(settled.delivery.answers[0].questionId,questionId);
   assert.equal(settled.delivery.answers[0].receipt?.requestId,'answer-input:'+questionId,'the submission is the one the question-derived request id names');
   assert.equal(typeof settled.delivery.answers[0].receipt?.submissionId,'string');
   assert.deepEqual(settled.delivery.scope,{projectId,sessionId},'the restarted instance reconciles the same project and session');
   second.kill('SIGTERM');
   assert.equal(await waitForExit(second,secondExited,secondLogs),0,'a clean stop exits zero');
  }finally{await stop(second,secondExited,'SIGTERM');}

  // Nothing was delivered twice: the settled answer is no longer pending work and there is exactly
  // one answer record for the question.
  const reopened=new ControlStore(data);
  try{
   const ledger=new DeliveryLedger(reopened);
   assert.deepEqual(ledger.reconcileOnStartup().entries.map(entry=>entry.delivery+'/'+entry.disposition),['question/redeliver-idempotent'],'only the un-notified question is still pending work');
   assert.equal(ledger.deliveries({projectId,sessionId}).answers.length,1);
   assert.equal(ledger.deliveries({projectId,sessionId}).answers[0].delivered,true);
   assert.equal((reopened.db.prepare('SELECT count(*) AS n FROM operations WHERE kind=?').get('answer.delivery') as {n:number}).n,1,'the start created no second answer row');
  }finally{reopened.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});
test('an unopenable control store refuses the start, releases the lock and serves nothing',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const schemaFile=join(data,'control.sqlite');
 await writeFile(schemaFile,'not a database');await chmod(schemaFile,0o600);
 const canonical=await realpath(data),before=await readFile(schemaFile);
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port)});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const code=await waitForExit(child,exited,logs);
  assert.notEqual(code,0,'a store that cannot be opened must not serve');
  assert.match(logs.stderr(),/control store/i);
  assert.match(logs.stderr(),/service lock is released/);
  await assert.rejects(stat(join(canonical,'service.lock')),{code:'ENOENT'},'the lock the start created is released');
  assert.deepEqual(await readFile(schemaFile),before,'the unopenable store is left byte-identical');
  await expectNothingListening(port);
 }finally{
  await stop(child,exited,'SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
});
test('the doctor reports an unresolvable manifest path as an invalid release instead of crashing',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const before=await snapshotTree(data);
 const child=spawnDoctor(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(await freePort()),DASHBOARD_RELEASE_MANIFEST:'../outside/release.json'});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const [code]=await exited as [number];
  assert.notEqual(code,0,'an unresolvable manifest path is unsafe');
  // The report must still be printed: an exception here used to abort before the JSON was written.
  const report=JSON.parse(logs.stdout());
  assert.equal(report.release.status,'invalid');
  assert.match(report.release.reason,/traversal/);
  assert.equal(report.unsafe,true);
  assert.deepEqual(await snapshotTree(data),before,'the doctor still changed nothing');
 }finally{
  await stop(child,exited,'SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
});
test('the doctor treats a missing hosted manifest as unsafe and exits non-zero',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const child=spawnDoctor(join(root,'current','server.mjs'),{DASHBOARD_MODE:'hosted',DASHBOARD_ORIGIN:'https://pilot.example.test',CF_ACCESS_TEAM:'https://team.cloudflareaccess.com',CF_ACCESS_AUD:'audience',DASHBOARD_OWNER:'owner@example.com',DASHBOARD_DATA:data,PORT:String(await freePort())});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const [code]=await exited as [number];
  assert.notEqual(code,0,'hosted mode without a manifest cannot start, so it is unsafe');
  const report=JSON.parse(logs.stdout());
  assert.equal(report.release.status,'absent');
  assert.equal(report.unsafe,true);
  assert.deepEqual(report.startBlockers,[],'nothing else blocks the next start');
 }finally{
  await stop(child,exited,'SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
});
test('the doctor reports a foreign-root lock and an unsupported storage schema as unsafe without changing them',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const canonical=await realpath(data),lockPath=join(canonical,'service.lock');
 const other=await mkdtemp(join(tmpdir(),'dashboard-doctor-foreign-'));
 try{
  const foreign=await acquireServiceLock({root:other,purpose:'service',rootId:'foreign-root',releaseId:'previous-release',schemaId:'pilot-state-1'});
  await writeFile(lockPath,JSON.stringify(foreign.metadata));await chmod(lockPath,0o600);
  await foreign.release();
  const lockBefore=await readFile(lockPath);
  const first=spawnDoctor(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(await freePort())});
  const firstLogs=collect(first),firstExited=once(first,'exit');
  try{
   const [code]=await firstExited as [number];
   assert.notEqual(code,0,'a lock naming another canonical root is unsafe');
   const report=JSON.parse(firstLogs.stdout());
   assert.equal(report.serviceLock.classification,'ambiguous');
   assert.match(report.serviceLock.reason,/different canonical root/);
   assert.equal(report.unsafe,true);
   assert.deepEqual(await readFile(lockPath),lockBefore,'the foreign evidence is byte-identical');
  }finally{
   await stop(first,firstExited,'SIGKILL');
  }
 }finally{
  await rm(other,{recursive:true,force:true});
 }
 await unlink(lockPath);
 const schemaFile=join(canonical,'control.sqlite'),db=new DatabaseSync(schemaFile);
 db.exec('CREATE TABLE control_schema(version INTEGER PRIMARY KEY); INSERT INTO control_schema VALUES(2);');db.close();
 await chmod(schemaFile,0o600);
 const schemaBefore=await readFile(schemaFile);
 const second=spawnDoctor(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(await freePort())});
 const secondLogs=collect(second),secondExited=once(second,'exit');
 try{
  const [code]=await secondExited as [number];
  assert.notEqual(code,0,'an unsupported storage schema version is unsafe');
  const report=JSON.parse(secondLogs.stdout());
  assert.deepEqual(report.storageSchema,{state:'present',version:2});
  assert.equal(report.unsafe,true);
  assert.deepEqual(await readFile(schemaFile),schemaBefore,'the doctor rewrote nothing');
 }finally{
  await stop(second,secondExited,'SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
});
test('the doctor reports an existing lock for this root as a start blocker and exits non-zero',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const canonical=await realpath(data),lockPath=join(canonical,'service.lock');
 // A real record from the reviewed module. Its recorded process is not classifiable by the
 // default observer, yet any existing lock blocks acquisition, so it must reach the exit code.
 const held=await acquireServiceLock({root:canonical,purpose:'service',rootId:'local-root',releaseId:'previous-release',schemaId:'pilot-state-1'});
 const before=await readFile(lockPath);
 const child=spawnDoctor(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(await freePort())});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const [code]=await exited as [number];
  assert.notEqual(code,0,'an existing lock blocks the next start');
  const report=JSON.parse(logs.stdout());
  assert.equal(report.serviceLock.classification,'ambiguous');
  assert.deepEqual(report.startBlockers,['service-lock-present']);
  assert.deepEqual(await readFile(lockPath),before,'the doctor leaves the evidence byte-identical');
 }finally{
  await stop(child,exited,'SIGKILL');
  await held.release().catch(()=>{});
  await rm(root,{recursive:true,force:true});
 }
});
test('the doctor reports an occupied port as a start blocker and exits non-zero',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const blocker=createServer();
 await new Promise<void>((ok,fail)=>{blocker.once('error',fail);blocker.listen(0,'127.0.0.1',()=>ok());});
 const taken=(blocker.address() as {port:number}).port;
 const child=spawnDoctor(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(taken)});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const [code]=await exited as [number];
  assert.notEqual(code,0,'a port the next start cannot bind exits non-zero');
  const report=JSON.parse(logs.stdout());
  assert.equal(report.server.probe,'listening');
  assert.deepEqual(report.startBlockers,['port-in-use']);
  assert.equal(report.unsafe,false,'occupying the port is not unsafe in itself; it blocks the next start');
  assert.equal(report.storageSchema.state,'absent');
 }finally{
  await stop(child,exited,'SIGKILL');
  await new Promise<void>(ok=>blocker.close(()=>ok()));
  await rm(root,{recursive:true,force:true});
 }
});
test('lock states that block the next start are reported as blockers',()=>{
 // The doctor's default process observer cannot establish "active" or "proven dead" on its own, so
 // the mapping that turns a classification into an exit-relevant blocker is asserted directly.
 assert.deepEqual(doctorStartBlockers({lockClassification:'absent',lockNamedForRoot:false,probe:'not-listening'}),[]);
 assert.deepEqual(doctorStartBlockers({lockClassification:'ambiguous',lockNamedForRoot:false,probe:'not-listening'}),[]);
 assert.deepEqual(doctorStartBlockers({lockClassification:'active',lockNamedForRoot:true,probe:'listening'}),['service-lock-active','port-in-use']);
 assert.deepEqual(doctorStartBlockers({lockClassification:'proven-dead',lockNamedForRoot:true,probe:'not-listening'}),['service-lock-proven-dead']);
 assert.deepEqual(doctorStartBlockers({lockClassification:'ambiguous',lockNamedForRoot:true,probe:'not-listening'}),['service-lock-present']);
 // A restored root blocks the next start until an operator promotes it, whatever the lock says.
 assert.deepEqual(doctorStartBlockers({lockClassification:'absent',lockNamedForRoot:false,probe:'not-listening',restorePaused:true}),['restore-not-promoted']);
 assert.deepEqual(doctorStartBlockers({lockClassification:'active',lockNamedForRoot:true,probe:'listening',restorePaused:true}),['restore-not-promoted','service-lock-active','port-in-use']);
});
/**
 * The full operator path of a restore: a real backup of a disposable root, restored into an isolated
 * root, refused by startup until it is deliberately promoted, and serving afterwards. Nothing here
 * touches a live data root, a real credential or a billed call.
 */
test('a restored root is paused: startup and the doctor refuse it until an operator promotes it',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const port=await freePort(),passphrase='a-sufficiently-long-restore-passphrase';
 await writeFile(join(data,'catalog.json'),JSON.stringify({version:1,projects:[]})+ '\n');
 const archive=join(root,'fixture.pbkp');
 await backup(data,archive,{passphrase});
 const restored=join(root,'restored');
 const marker=join(restored,PAUSED_MARKER);
 await restore(archive,restored,{passphrase});
 assert.equal(await stat(marker).then(()=>true).catch(()=>false),true,'a restored root carries the pause marker');
 const before=await readFile(marker);
 // The doctor reports the pause as a start blocker and never promotes the root itself.
 const doctor=spawnDoctor(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:restored,PORT:String(port)});
 const doctorLogs=collect(doctor),doctorExited=once(doctor,'exit');
 try{
  const [code]=await doctorExited as [number];
  assert.notEqual(code,0,'a paused root blocks the next start: '+doctorLogs.stderr());
  const report=JSON.parse(doctorLogs.stdout());
  assert.equal(report.restorePause.paused,true);
  assert.deepEqual(report.startBlockers,['restore-not-promoted'],'the pause is the only blocker');
  assert.equal(report.unsafe,false,'a deliberate pause is a blocker, not unsafe evidence');
  assert.deepEqual(await readFile(marker),before,'the doctor never promotes a root');
 } finally { await stop(doctor,doctorExited,'SIGKILL'); }
 // Startup refuses it: one clear operator message, no listener and no lock evidence.
 const blocked=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:restored,PORT:String(port)});
 const blockedLogs=collect(blocked),blockedExited=once(blocked,'exit');
 const blockedCode=await waitForExit(blocked,blockedExited,{stderr:blockedLogs.stderr});
 assert.notEqual(blockedCode,0,'startup must not serve a paused root');
 assert.match(blockedLogs.stderr(),/RESTORE-PAUSED\.json/);
 assert.match(blockedLogs.stderr(),/promote/,'the message says exactly what the operator must do');
 assert.equal(await stat(join(restored,'service.lock')).then(()=>true).catch(()=>false),false,'a refused start takes no lock');
 assert.deepEqual(await readFile(marker),before,'a refused start leaves the marker byte-identical');
 await expectNothingListening(port);
 // Promotion is a deliberate operator action, and then the same root starts and serves.
 const promoted=await promote(restored);
 assert.equal(promoted.promoted,true);
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:restored,PORT:String(port)});
 const logs=collect(child),exited=once(child,'exit');
 try{
  await waitForListening(child,logs.stderr);
  assert.equal((await health(port,'127.0.0.1:'+port)).status,200);
  await stop(child,exited,'SIGTERM');
  assert.equal(await waitForExit(child,exited,logs),0);
  await assert.rejects(stat(join(restored,'service.lock')),{code:'ENOENT'},'a clean stop releases the lock');
 } finally { await stop(child,exited,'SIGKILL'); await rm(root,{recursive:true,force:true}); }
});
/**
 * The crash window a restore's pause marker has to cover. The marker is written into the staging root
 * before a single archive byte is read, so a tree a crash left behind - a catalog, no control store,
 * and a marker that still carries no final counts - is already paused, and startup refuses it exactly
 * as it refuses a finished restore. Without that ordering such a tree would start and open a fresh,
 * empty control store.
 */
test('a staging tree a crashed restore left behind is refused by startup',async()=>{
 const root=await releaseRoot(),partial=join(root,'.pilot-restore-dead','stage');
 await mkdir(partial,{recursive:true,mode:0o700});
 await writeFile(join(partial,'catalog.json'),JSON.stringify({version:1,projects:[]})+ '\n');
 // Exactly what restore writes before it reads the archive: no counts, no archive, not complete.
 await writeFile(join(partial,PAUSED_MARKER),JSON.stringify({format:'pilot-restore-pause',version:1,created:new Date().toISOString(),complete:false,archive:null,backup:null,credentials:'absent'},null,2)+ '\n');
 const refusal=await restorePauseRefusal(partial);
 assert.ok(refusal!==null,'a provisional marker already refuses the root');
 assert.match(refusal as string,/promote/,'the refusal names the promotion command');
 const port=await freePort();
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:partial,PORT:String(port)});
 const logs=collect(child),exited=once(child,'exit');
 try{
  const code=await waitForExit(child,exited,{stderr:logs.stderr});
  assert.notEqual(code,0,'a partial staging tree is never served');
  assert.match(logs.stderr(),/RESTORE-PAUSED\.json/);
  assert.equal(await stat(join(partial,'service.lock')).then(()=>true).catch(()=>false),false,'a refused start takes no lock');
  assert.equal(await stat(join(partial,'control.sqlite')).then(()=>true).catch(()=>false),false,'no control store is created for a tree that was never promoted');
  await expectNothingListening(port);
 } finally { await rm(root,{recursive:true,force:true}); }
});
/**
 * The legacy conversation a project already has is adopted as a named session exactly once, at
 * start, without opening a harness or touching the transcript - and running the migration again,
 * through the owner-only route, changes nothing. This is the end-to-end form of the registry test:
 * a real server, a real agent conversation, a real restart.
 */
test('a real start adopts a project conversation once, leaves it byte-identical, and the migration route is idempotent',async()=>{
 const root=await releaseRoot();
 const data=join(root,'data'),workspaces=join(root,'projects'),projectPath=join(workspaces,'workspace');
 await mkdir(join(projectPath,'docs','spec'),{recursive:true,mode:0o755});
 const env={DASHBOARD_MODE:'local',DASHBOARD_DATA:data,DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:workspaces,DASHBOARD_AGENTS:'on'};
 const auth=(token:string)=>({'x-dashboard-token':token});
 let first:ChildProcess|null=null,second:ChildProcess|null=null;
 try{
  // One real start: register a project inside the browse roots, give it a board task and a document,
  // and ask the agent something. That opens the harness, which creates the single lazy conversation.
  const port=await freePort();
  first=spawnServer(join(root,'current','server.mjs'),{...env,PORT:String(port)});
  const firstLogs=collect(first),firstExited=once(first,'exit');
  const firstToken=await (async()=>{await waitForListening(first!,firstLogs.stderr);return sessionToken(port);})();
  const writes={...auth(firstToken),'content-type':'application/json',origin:'http://127.0.0.1:'+port};
  const call=(atPort:number,token:string,path:string,method:string,body?:unknown)=>fetch('http://127.0.0.1:'+atPort+path,{method,headers:{...auth(token),...(body===undefined?{}:{'content-type':'application/json',origin:'http://127.0.0.1:'+atPort})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const registered=await fetch('http://127.0.0.1:'+port+'/api/projects',{method:'POST',headers:writes,body:JSON.stringify({name:'Legacy',path:projectPath,managed:false,confirm:true})});
  assert.equal(registered.status,201,firstLogs.stderr());
  const project=await registered.json() as {id:string;path:string};
  assert.equal(await call(port,firstToken,'/api/projects/'+project.id+'/initialize','POST',{confirm:true}).then((res)=>res.status),200);
  const board=await (await call(port,firstToken,'/api/projects/'+project.id+'/board','GET')).json() as {revision:string};
  const taskId=randomUUID();
  const put=await call(port,firstToken,'/api/projects/'+project.id+'/board','POST',{revision:board.revision,operation:{op:'putTask',task:newTask(taskId,'Ship the release')}});
  assert.equal(put.status,200,firstLogs.stderr());
  assert.equal(await call(port,firstToken,'/api/projects/'+project.id+'/docs/document','POST',{path:'docs/spec/product.md',text:'# Product\n'}).then((res)=>res.status),201);
  // Nothing was registered for this project when this start began, so this start migrated nothing.
  assert.ok(!firstLogs.stdout().includes('Session migration: '),'a start with no registered project logs no migration');
  const started=await call(port,firstToken,'/api/projects/'+project.id+'/agents/input','POST',{text:'Say hello',mode:'followUp'});
  assert.equal(started.status,200,firstLogs.stderr());
  const opened=await waitFor(async()=>{
   const view=await call(port,firstToken,'/api/projects/'+project.id+'/agents','GET').then((res)=>res.json()) as {view:{conversationId:string;model:{provider:string;modelId:string}|null}};
   return view.view.conversationId===''?undefined:view;
  });
  assert.equal(opened.view.conversationId,'1','the project already has exactly one conversation, and it is the reserved root');
  const modelBefore=opened.view.model;
  first.kill('SIGTERM');
  assert.equal(await waitForExit(first,firstExited,firstLogs),0,'a clean stop exits zero');
  first=null;

  // The conversation store is what the migration looks for, and it is untouched by the adoption.
  const store=join(await realpath(data),'agents',project.id,'session.sqlite');
  const transcript=createHash('sha256').update(await readFile(store)).digest('hex');

  // The next start adopts it: one session, once, and nothing else is touched.
  const port2=await freePort();
  second=spawnServer(join(root,'current','server.mjs'),{...env,PORT:String(port2)});
  const secondLogs=collect(second),secondExited=once(second,'exit');
  await waitForListening(second,secondLogs.stderr);
  const secondToken=await sessionToken(port2);
  const line=secondLogs.stdout().split('\n').find((entry)=>entry.startsWith('Session migration: '));
  assert.ok(line,'the start logs the migration it performed: '+secondLogs.stdout());
  const report=JSON.parse(line!.slice('Session migration: '.length));
  assert.equal(report.dryRun,false);
  assert.deepEqual(report.counts,{projects:1,conversations:1,adopted:1,alreadyAdopted:0,withoutConversation:0,refused:0});
  assert.equal(report.actions[0].sessionId,'1');
  assert.equal(report.actions[0].action,'adopt');
  assert.ok(!line!.includes(await realpath(data))&&!line!.includes(project.path),'the migration report carries no filesystem path');
  // Adopting a conversation opens no harness: the store is byte-identical before any agent request.
  assert.equal(createHash('sha256').update(await readFile(store)).digest('hex'),transcript,'the adoption leaves the conversation store byte-identical');
  const sessions=await (await call(port2,secondToken,'/api/sessions?projectId='+project.id,'GET')).json() as {sessions:{id:string;name:string;model:unknown;links:{kind:string;path:string}[];revision:number}[]};
  assert.equal(sessions.sessions.length,1,'exactly one session was adopted');
  assert.equal(sessions.sessions[0].id,'1');
  assert.equal(sessions.sessions[0].name,'Legacy legacy conversation');
  assert.equal(sessions.sessions[0].model,null,'the migration declares no model choice');
  assert.deepEqual(sessions.sessions[0].links,[{kind:'workspace',path:project.path}],'the project folder is linked as a workspace');
  // Running the migration again, dry first, changes nothing at all.
  const dry=await call(port2,secondToken,'/api/sessions/migrate','POST',{dryRun:true});
  assert.equal(dry.status,200);
  const dryReport=await dry.json();
  assert.equal(dryReport.dryRun,true);
  assert.deepEqual(dryReport.counts,{projects:1,conversations:1,adopted:0,alreadyAdopted:1,withoutConversation:0,refused:0});
  const applied=await (await call(port2,secondToken,'/api/sessions/migrate','POST',{})).json();
  assert.deepEqual(applied.counts,dryReport.counts);
  const after=await (await call(port2,secondToken,'/api/sessions?projectId='+project.id,'GET')).json();
  assert.deepEqual(after,sessions,'a second migration duplicates no session and no link');
  assert.equal(createHash('sha256').update(await readFile(store)).digest('hex'),transcript,'the migration route leaves the conversation store byte-identical');
  // A created session round-trips with a task, a document and a workspace link, and stays revision-checked.
  const created=await call(port2,secondToken,'/api/sessions','POST',{projectId:project.id,name:'Round trip',model:null,links:[
   {kind:'task',taskId},
   {kind:'document',path:'docs/spec/product.md',anchor:'intent'},
   {kind:'workspace',path:projectPath}
  ]});
  assert.equal(created.status,201,secondLogs.stderr());
  const session=(await created.json()).session;
  assert.deepEqual(session.links,[
   {kind:'document',path:'docs/spec/product.md',anchor:'intent'},
   {kind:'task',taskId},
   {kind:'workspace',path:project.path}
  ]);
  const reread=(await (await call(port2,secondToken,'/api/sessions/'+session.id+'?projectId='+project.id,'GET')).json()).session;
  assert.deepEqual(reread,session,'the session with a task, a document and a workspace link round-trips');
  assert.equal((await call(port2,secondToken,'/api/sessions/'+session.id+'/link','POST',{projectId:project.id,link:{kind:'task',taskId:randomUUID()},revision:1})).status,404);
  assert.equal((await call(port2,secondToken,'/api/sessions/'+session.id+'/link','POST',{projectId:project.id,link:{kind:'workspace',path:await realpath(data)},revision:1})).status,403);
  const stale=await call(port2,secondToken,'/api/sessions/'+session.id+'/rename','POST',{projectId:project.id,name:'Renamed',revision:9});
  assert.equal(stale.status,409);
  assert.deepEqual((await (await call(port2,secondToken,'/api/sessions/'+session.id+'?projectId='+project.id,'GET')).json()).session,reread,'a stale revision leaves the record unchanged');
  const unlinked=await call(port2,secondToken,'/api/sessions/'+session.id+'/unlink','POST',{projectId:project.id,link:{kind:'task',taskId},revision:1});
  assert.equal(unlinked.status,200);
  const unlinkedOnce=(await unlinked.json()).session;
  assert.deepEqual((await (await call(port2,secondToken,'/api/sessions/'+session.id+'/unlink','POST',{projectId:project.id,link:{kind:'task',taskId},revision:unlinkedOnce.revision})).json()).session,unlinkedOnce,'unlinking twice changes nothing');
  // The registry declared no model and applied none: the live selection is the one from before.
  const openAgain=await waitFor(async()=>{
   const view=await call(port2,secondToken,'/api/projects/'+project.id+'/agents','GET').then((res)=>res.json()) as {view:{conversationId:string;model:{provider:string;modelId:string}|null}};
   return view.view.conversationId===''?undefined:view;
  });
  assert.equal(openAgain.view.conversationId,'1','the adopted session names the same conversation');
  assert.deepEqual(openAgain.view.model,modelBefore,'no provider, model or thinking selection changed');
  second.kill('SIGTERM');
  assert.equal(await waitForExit(second,secondExited,secondLogs),0,'a clean stop exits zero');
  second=null;
 }finally{
  if(second)await stop(second,once(second,'exit'),'SIGTERM');
  if(first)await stop(first,once(first,'exit'),'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
});
test('a manifest that identifies the release tolerates an otherwise invalid DASHBOARD_RELEASE',async()=>{
 const root=await releaseRoot(),data=join(root,'data');
 const manifest={version:'2.5.0',releaseId:'release-2026-02',schemaId:'pilot-state-1',createdAt:'2026-02-01T00:00:00.000Z'};
 await writeFile(join(root,'releases','v1','release.json'),JSON.stringify(manifest));
 const port=await freePort();
 // DASHBOARD_RELEASE is only a fallback identity, so a manifest must be able to identify the start
 // even when that variable is unusable.
 const child=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_RELEASE:'release id with spaces'});
 const logs=collect(child),exited=once(child,'exit');
 try{
  await waitForListening(child,logs.stderr);
  const record=JSON.parse(await readFile(join(await realpath(data),'service.lock'),'utf8'));
  assert.equal(record.releaseId,'release-2026-02');
  assert.equal(record.schemaId,'pilot-state-1');
  child.kill('SIGTERM');
  assert.equal(await waitForExit(child,exited,logs),0);
 }finally{
  await stop(child,exited,'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
});
/**
 * The browser-independent recovery of a session whose process is gone. A durable lifecycle row that
 * says running is adopted as interrupted with a reason, deterministically and idempotently, and a
 * fresh client that later connects reads the interrupted state and the reason instead of a stuck
 * running session. A second start changes nothing, and resuming the uncertain interruption is refused
 * with operator attention rather than replayed.
 */
test('a real start adopts a running session whose process is gone, and a fresh client reads the reason',async()=>{
 const root=await releaseRoot(),data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const projectId='project-a',sessionId='1';
 // The durable state a process that died mid-generation leaves behind: a session record and a
 // running lifecycle row. Written while nothing holds the store, exactly as the dead process left it.
 const seeded=new ControlStore(data);
 seeded.admit({
  scope:{projectId,sessionId},
  idempotencyKey:'session.r1',
  kind:'session.record',
  input:{version:1,id:sessionId,projectId,name:'Adopted session',revision:1,model:null,links:[],createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'},
  outbox:{kind:'session.registry',payload:{version:1,sessionId,revision:1}}
 });
 new SessionLifecycleStore(seeded,{clock:()=>new Date('2026-01-01T00:00:00.000Z')}).markRunning({projectId,sessionId,requestId:'interrupted-request'});
 seeded.close();
 let first:ChildProcess|null=null,second:ChildProcess|null=null;
 try{
  const port=await freePort();
  first=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
  const firstLogs=collect(first),firstExited=once(first,'exit');
  await waitForListening(first,firstLogs.stderr);
  const token=await sessionToken(port);
  const line=firstLogs.stdout().split('\n').find((entry)=>entry.startsWith('Session lifecycle adoption: '));
  assert.ok(line,'the start logs the adoption it performed: '+firstLogs.stdout());
  const report=JSON.parse(line!.slice('Session lifecycle adoption: '.length));
  assert.equal(report.readOnly,false);
  assert.equal(report.adopted,1);
  assert.deepEqual(report.entries,[{projectId,sessionId,revision:2}]);
  assert.ok(!line!.includes(await realpath(data)),'the adoption summary carries no filesystem path');
  // A fresh client reads the interrupted state and the recorded reason, not a stuck running session.
  const readLifecycle=async(atPort:number,atToken:string)=>await (await fetch('http://127.0.0.1:'+atPort+'/api/sessions/'+sessionId+'/lifecycle?projectId='+projectId,{headers:{'x-dashboard-token':atToken}})).json() as {lifecycle:{state:string;revision:number;uncertain:boolean;reason:string|null;requestId:string|null}};
  const record=(await readLifecycle(port,token)).lifecycle;
  assert.equal(record.state,'interrupted');
  assert.equal(record.revision,2);
  assert.equal(record.uncertain,true);
  assert.equal(record.requestId,'interrupted-request');
  assert.ok(record.reason!==null&&/cannot be proven/.test(record.reason),'the reason explains why the session is not running: '+record.reason);
  // The uncertain interruption refuses a resume with operator attention, on a real server.
  const refused=await fetch('http://127.0.0.1:'+port+'/api/sessions/'+sessionId+'/lifecycle/resume',{method:'POST',headers:{'x-dashboard-token':token,'content-type':'application/json',origin:'http://127.0.0.1:'+port},body:JSON.stringify({projectId,revision:2})});
  assert.equal(refused.status,409);
  assert.match((await refused.json()).error,/cannot be proven idempotent/);
  first.kill('SIGTERM');
  assert.equal(await waitForExit(first,firstExited,firstLogs),0,'a clean stop exits zero');

  // A second start finds nothing running: it adopts nothing, logs no adoption, and changes nothing.
  const port2=await freePort();
  second=spawnServer(join(root,'current','server.mjs'),{DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port2),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''});
  const secondLogs=collect(second),secondExited=once(second,'exit');
  await waitForListening(second,secondLogs.stderr);
  assert.ok(!secondLogs.stdout().includes('Session lifecycle adoption: '),'a second start finds no running session and admits nothing');
  const token2=await sessionToken(port2);
  assert.deepEqual((await readLifecycle(port2,token2)).lifecycle,record,'the adoption is idempotent: a second start changes nothing');
  second.kill('SIGTERM');
  assert.equal(await waitForExit(second,secondExited,secondLogs),0,'a clean stop exits zero');
  second=null;
 }finally{
  if(second)await stop(second,once(second,'exit'),'SIGTERM');
  if(first)await stop(first,once(first,'exit'),'SIGTERM');
  await rm(root,{recursive:true,force:true});
 }
});
