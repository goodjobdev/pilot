import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,lstat,mkdtemp,mkdir,readFile,readdir,realpath,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateRunnerSnapshot} from '../../src/server/state/runner-snapshot';
import {materializeRunnerSnapshot} from '../../src/server/state/runner-snapshot-materialize';
const content={version:1,files:[{path:'src/a.test.js',mode:'100644',base64:Buffer.from('test').toString('base64')},{path:'run.sh',mode:'100755',base64:Buffer.from('#!/bin/sh\n').toString('base64')}]};
const digest=validateRunnerSnapshot(content).digest;
async function makeWritable(path:string):Promise<void>{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())return;await chmod(path,0o700);for(const child of await readdir(path))await makeWritable(join(path,child));}

test('a service-private snapshot contains exactly the admitted files and modes',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires a non-root POSIX service identity');return;}
 const temp=await mkdtemp(join(await realpath(tmpdir()),'pilot-snapshot-')),root=join(temp,'private');await mkdir(root,{mode:0o700});
 try{
  const result=await materializeRunnerSnapshot({privateRoot:root,applicationUid:uid+1},content,digest);
  assert.equal(result.digest,digest);assert.equal(await readFile(join(result.directory,'src/a.test.js'),'utf8'),'test');
  assert.equal(await readFile(join(result.directory,'run.sh'),'utf8'),'#!/bin/sh\n');
  assert.deepEqual((await readdir(result.directory)).sort(),['run.sh','src']);
  assert.equal((await lstat(result.directory)).mode&0o777,0o555);
  assert.equal((await lstat(join(result.directory,'src/a.test.js'))).mode&0o777,0o444);
  assert.equal((await lstat(join(result.directory,'run.sh'))).mode&0o777,0o555);
 }finally{await makeWritable(temp);await rm(temp,{recursive:true,force:true});}
});

test('materialization refuses same UID, unsafe roots, bad identities and cancellation without execution',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires a non-root POSIX service identity');return;}
 const temp=await mkdtemp(join(await realpath(tmpdir()),'pilot-snapshot-refusal-')),root=join(temp,'private');await mkdir(root,{mode:0o700});
 try{
  const config={privateRoot:root,applicationUid:uid+1};
  await assert.rejects(materializeRunnerSnapshot({...config,applicationUid:uid},content,digest),/identity/);
  await assert.rejects(materializeRunnerSnapshot(config,content,'0'.repeat(64)),/identity/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(materializeRunnerSnapshot(config,content,digest,controller.signal),/cancelled/);
  const alias=join(temp,'alias');await symlink(root,alias);
  await assert.rejects(materializeRunnerSnapshot({...config,privateRoot:alias},content,digest),/failed/);
  await chmod(root,0o755);await assert.rejects(materializeRunnerSnapshot(config,content,digest),/failed/);await chmod(root,0o700);
  await chmod(temp,0o777);await assert.rejects(materializeRunnerSnapshot(config,content,digest),/failed/);await chmod(temp,0o700);
  assert.deepEqual(await readdir(root),[]);
 }finally{await makeWritable(temp);await rm(temp,{recursive:true,force:true});}
});
