import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateRunnerSnapshot,RUNNER_SNAPSHOT_MAX_BYTES,RUNNER_SNAPSHOT_MAX_FILE_BYTES} from '../../src/server/state/runner-snapshot';
const file=(path:string,text:string,mode:'100644'|'100755'='100644')=>({path,mode,base64:Buffer.from(text).toString('base64')});
const snapshot=(files:unknown[])=>({version:1,files});

test('snapshot identity binds sorted exact paths, modes and bytes without a host path',()=>{
 const a=file('src/a.test.js','test'),b=file('run.sh','echo test','100755');
 const one=validateRunnerSnapshot(snapshot([a,b])),two=validateRunnerSnapshot(snapshot([b,a]));
 assert.equal(one.digest,two.digest);assert.deepEqual(one.files.map(f=>f.path),['run.sh','src/a.test.js']);
 assert.equal(one.totalBytes,13);assert.equal(one.files[1].sha256,createHash('sha256').update('test').digest('hex'));
 assert.notEqual(one.digest,validateRunnerSnapshot(snapshot([file('src/a.test.js','other'),b])).digest);
 assert.notEqual(one.digest,validateRunnerSnapshot(snapshot([file('src/a.test.js','test','100755'),b])).digest);
 assert.notEqual(one.digest,validateRunnerSnapshot(snapshot([file('src/b.test.js','test'),b])).digest);
 assert.ok(Object.isFrozen(one)&&Object.isFrozen(one.files)&&one.files.every(Object.isFrozen));
});

test('snapshot validation refuses paths, special objects, collisions and noncanonical content',()=>{
 for(const path of ['/etc/passwd','../a.js','src/../../a.js','src\\a.js','.git/config','.env','node_modules/pkg/a.js','docs/dashboard/sources/secret.md','secrets.json'])
  assert.throws(()=>validateRunnerSnapshot(snapshot([file(path,'x')])),/refused path/,path);
 assert.throws(()=>validateRunnerSnapshot(snapshot([file('x.js','1'),file('x.js','2')])),/duplicate/);
 assert.throws(()=>validateRunnerSnapshot(snapshot([file('x.js','1'),file('x.js/child.js','2')])),/collision/);
 assert.throws(()=>validateRunnerSnapshot(snapshot([file('d/'.repeat(32)+'x.js','1')])),/too deep/);
 assert.throws(()=>validateRunnerSnapshot(snapshot([{...file('x.js','a'),mode:'120000'}])));
 assert.throws(()=>validateRunnerSnapshot(snapshot([{...file('x.js','a'),symlink:'target'}])));
 for(const base64 of ['YQ','YQ===','YQ==\n','!AAA','YR=='])assert.throws(()=>validateRunnerSnapshot(snapshot([{path:'x.js',mode:'100644',base64}])));
 assert.throws(()=>validateRunnerSnapshot({version:1,files:[file('x.js','x')],workspace:'/etc'}));
});

test('snapshot validation enforces file and aggregate byte bounds',()=>{
 const full=Buffer.alloc(RUNNER_SNAPSHOT_MAX_FILE_BYTES).toString('base64');
 const files=Array.from({length:RUNNER_SNAPSHOT_MAX_BYTES/RUNNER_SNAPSHOT_MAX_FILE_BYTES},(_,i)=>({path:'f'+i+'.js',mode:'100644',base64:full}));
 assert.equal(validateRunnerSnapshot(snapshot(files)).totalBytes,RUNNER_SNAPSHOT_MAX_BYTES);
 assert.throws(()=>validateRunnerSnapshot(snapshot([...files,file('extra.js','x')])),/byte bound/);
 const over=Buffer.alloc(RUNNER_SNAPSHOT_MAX_FILE_BYTES+1).toString('base64');
 assert.throws(()=>validateRunnerSnapshot(snapshot([{path:'large.js',mode:'100644',base64:over}])));
});
