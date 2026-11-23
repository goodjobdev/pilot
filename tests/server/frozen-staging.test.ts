import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFrozenStagingArtifact} from '../../src/server/state/frozen-staging';

const target={projectId:'project-1',targetId:'pilot-commit',revision:3,targetDigest:'a'.repeat(64),branch:'refs/heads/work/pilot-project'};
const file=(path:string,text:string,mode:'100644'|'100755'='100644')=>({path,mode,base64:Buffer.from(text).toString('base64')});
const manifest=(...files:unknown[])=>({version:1,files});

test('frozen staging is stable across entry order and binds bytes, mode and owner-fixed target identity',()=>{
 const a=file('src/a.ts','a'),b=file('run.sh','run','100755');
 const one=createFrozenStagingArtifact(target,manifest(a,b)),two=createFrozenStagingArtifact(target,manifest(b,a));
 assert.equal(one.digest,two.digest);assert.equal(one.snapshot.digest,two.snapshot.digest);
 assert.notEqual(one.digest,createFrozenStagingArtifact({...target,revision:4},manifest(a,b)).digest);
 assert.notEqual(one.digest,createFrozenStagingArtifact({...target,targetDigest:'b'.repeat(64)},manifest(a,b)).digest);
 assert.notEqual(one.digest,createFrozenStagingArtifact(target,manifest(file('src/a.ts','changed'),b)).digest);
 assert.ok(Object.isFrozen(one)&&Object.isFrozen(one.target)&&Object.isFrozen(one.snapshot.files));
});

test('frozen staging restricts paths to ASCII and rejects ASCII case collisions',()=>{
 assert.throws(()=>createFrozenStagingArtifact(target,manifest(file('cafe\u0301.txt','x'))),/ASCII paths/);
 // Final sigma and sigma have Unicode case-fold relationships, but neither is in the supported alphabet.
 assert.throws(()=>createFrozenStagingArtifact(target,manifest(file('ΟΣ.js','x'),file('οσ.js','y'))),/ASCII paths/);
 assert.throws(()=>createFrozenStagingArtifact(target,manifest(file('Readme.md','x'),file('README.md','y'))),/ASCII case collisions/);
 assert.throws(()=>createFrozenStagingArtifact(target,manifest(file('Dir.txt','x'),file('dir.TXT/child.ts','y'))),/ASCII case file\/directory collisions/);
 assert.throws(()=>createFrozenStagingArtifact(target,manifest(file('dir.TXT/child.ts','y'),file('Dir.txt','x'))),/ASCII case file\/directory collisions/);
 assert.throws(()=>createFrozenStagingArtifact(target,manifest(file('x.txt','x'),file('x.txt/child.txt','y'))),/collision/);
});

test('frozen staging applies manifest bounds before its ASCII and alias scans',()=>{
 const oversized=Array.from({length:1001},(_,i)=>file(`Ω${i}.js`,'x'));
 assert.throws(()=>createFrozenStagingArtifact(target,manifest(...oversized)),/Too big|too_big|1000/i);
});

test('frozen staging refuses target substitution and delegates strict path, mode and byte policy',()=>{
 for(const bad of [
  {...target,targetId:'../other'}, {...target,targetId:'.target'}, {...target,projectId:':project'},
  {...target,revision:0}, {...target,targetDigest:'not-digest'},
  {...target,branch:'refs/heads/main..elsewhere'}, {...target,branch:'refs/heads/trailing.'},
  {...target,branch:'refs/heads/name.lock'}, {...target,extra:'caller data'}
 ])assert.throws(()=>createFrozenStagingArtifact(bad,manifest(file('a.ts','x'))));
 assert.doesNotThrow(()=>createFrozenStagingArtifact({...target,targetId:'target:one'},manifest(file('a.ts','x'))));
 for(const bad of [
  manifest(file('../outside.ts','x')),manifest({...file('link.ts','x'),mode:'120000'}),
  manifest(file('.env','secret')),manifest(file('node_modules/pkg/a.js','x'))
 ])assert.throws(()=>createFrozenStagingArtifact(target,bad));
});
