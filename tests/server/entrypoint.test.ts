import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

test('the bind address defaults to loopback and must be an IPv4 literal',async()=>{
 const {bindHost}=await import('../../src/server/main');
 assert.equal(bindHost({}),'127.0.0.1');
 assert.equal(bindHost({DASHBOARD_BIND:'0.0.0.0'}),'0.0.0.0');
 assert.throws(()=>bindHost({DASHBOARD_BIND:'localhost'}),/IPv4/);
 assert.throws(()=>bindHost({DASHBOARD_BIND:'256.1.1.1'}),/IPv4/);
 assert.throws(()=>bindHost({DASHBOARD_BIND:'::'}),/IPv4/);
});
test('production entrypoint starts through current release symlink and drains on stop',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-entry-'));
 const release=join(root,'releases','v1');await mkdir(release,{recursive:true});
 await build({entryPoints:[resolve('src/server/main.ts')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:join(release,'server.mjs')});
 // Production externals resolve from the app's installed dependencies, not this disposable root.
 await symlink(resolve('node_modules'),join(release,'node_modules'),'dir');
 await symlink(release,join(root,'current'),'dir');
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as import('node:net').AddressInfo).port;
 await new Promise<void>(ok=>probe.close(()=>ok()));
 const data=join(root,'data');
 const child=spawn(process.execPath,[join(root,'current','server.mjs')],{env:{...process.env,DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:''},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 try{
  await new Promise<void>((ok,fail)=>{
   const timer=setTimeout(()=>fail(Error('Entrypoint did not listen: '+stderr)),10000);
   child.stdout.on('data',chunk=>{if(String(chunk).includes('Dashboard listening')){clearTimeout(timer);ok();}});
   child.once('exit',code=>{clearTimeout(timer);fail(Error('Early exit '+code+': '+stderr));});
   child.once('error',fail);
  });
  const health=await fetch('http://127.0.0.1:'+port+'/healthz');assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true});
  child.kill('SIGTERM');const [code]=await exited;assert.equal(code,0);
  const {stat}=await import('node:fs/promises');await assert.rejects(stat(join(data,'service.lock')),{code:'ENOENT'});
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}
  await rm(root,{recursive:true,force:true});
 }
});
