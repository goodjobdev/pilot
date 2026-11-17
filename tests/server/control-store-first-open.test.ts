import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {ControlStore} from '../../src/server/state/control-store';

const script=`
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const link=fs.linkSync;
fs.linkSync=(...args)=>{fs.writeSync(1,'staged\\n');const buf=Buffer.alloc(1);fs.readSync(0,buf,0,1,null);return link(...args);};
syncBuiltinESMExports();
const {ControlStore}=await import('./src/server/state/control-store.ts');
const store=new ControlStore(process.argv[1]);
fs.writeSync(1,'opened:'+store.schemaVersion()+'\\n');
store.close();
`;
async function within<T>(promise:Promise<T>,ms=5000):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('child process deadline exceeded')),ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}
function childFor(root:string){
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,root],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
 return {child,lines,closed,stderr:()=>stderr};
}
test('competing first opener never sees a staged uninitialized database',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-first-open-')),worker=childFor(root);
 try{
  assert.equal((await within(worker.lines.next())).value,'staged',worker.stderr());
  const first=new ControlStore(root);
  try{assert.equal(first.schemaVersion(),1);}finally{first.close();}
  worker.child.stdin.end('x');assert.equal((await within(worker.lines.next())).value,'opened:1',worker.stderr());
  assert.equal(await within(worker.closed),0,worker.stderr());
 }finally{worker.child.kill('SIGKILL');await within(worker.closed);await rm(root,{recursive:true,force:true});}
});
test('orphaned target sidecars are preserved and prevent fresh initialization',async()=>{
 for(const suffix of ['-wal','-shm','-journal']){
  const root=await mkdtemp(join(tmpdir(),'pilot-first-open-orphan-'));
  try{
   const sidecar=join(root,'control.sqlite'+suffix);await writeFile(sidecar,'recoverable evidence',{mode:0o600});
   assert.throws(()=>new ControlStore(root),/sidecar evidence remains/);
   assert.equal(await readFile(sidecar,'utf8'),'recoverable evidence');assert.equal((await readdir(root)).includes('control.sqlite'),false);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});
test('a killed initializer leaves no incomplete target and a later opener succeeds',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-first-open-crash-')),worker=childFor(root);
 try{
  assert.equal((await within(worker.lines.next())).value,'staged',worker.stderr());
  worker.child.kill('SIGKILL');await within(worker.closed);
  const files=await readdir(root);assert.equal(files.includes('control.sqlite'),false);assert.ok(files.some(file=>file.startsWith('.control-init-')));
  const store=new ControlStore(root);try{assert.equal(store.schemaVersion(),1);}finally{store.close();}
 }finally{worker.child.kill('SIGKILL');await within(worker.closed);await rm(root,{recursive:true,force:true});}
});
