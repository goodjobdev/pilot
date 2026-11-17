import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomicWrite} from '../../src/server/board-store';

test('a synchronous final gate dispatches the rename before queued microtasks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-atomic-gate-')),path=join(root,'file.md'),events:string[]=[];let observing=false;
 const hook=createHook({init(_id,type){if(observing&&type==='FSREQPROMISE')events.push('filesystem-dispatch');}});
 try{
  await writeFile(path,'old');hook.enable();
  await atomicWrite(path,'new',()=>{observing=true;events.push('gate');queueMicrotask(()=>{events.push('microtask');observing=false;});});
  assert.deepEqual(events.slice(0,3),['gate','filesystem-dispatch','microtask']);assert.equal(await readFile(path,'utf8'),'new');
 }finally{hook.disable();await rm(root,{recursive:true,force:true});}
});

test('a refused gate keeps the old file and an asynchronous gate is still awaited',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-atomic-refusal-')),path=join(root,'file.md');
 try{
  await writeFile(path,'old');await assert.rejects(atomicWrite(path,'bad',()=>{throw Error('revoked');}),/revoked/);
  assert.equal(await readFile(path,'utf8'),'old');assert.deepEqual(await readdir(root),['file.md']);
  await assert.rejects(atomicWrite(path,'bad',async()=>{await Promise.resolve();throw Error('async revoked');}),/async revoked/);
  assert.equal(await readFile(path,'utf8'),'old');assert.deepEqual(await readdir(root),['file.md']);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),inside=new Promise<void>(r=>{entered=r;});
  const pending=atomicWrite(path,'new',async()=>{entered();await gate;});await inside;assert.equal(await readFile(path,'utf8'),'old');release();await pending;assert.equal(await readFile(path,'utf8'),'new');
 }finally{await rm(root,{recursive:true,force:true});}
});
