import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,realpath,rm,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project } from '../../src/shared/model';
import { LocalGitPushTransport,listLocalPushRemotes,resolveLocalPushRemote } from '../../src/server/state/local-git-push-transport';

/**
 * The installed local push transport: one non-force push of one exact commit to one exact branch of
 * one owner-configured **local** repository.
 *
 * These tests use disposable repositories on this machine and no network. They check the refusals the
 * adapter is responsible for — a moved remote, a re-pointed remote, a commit from another repository,
 * a network URL — and that a refusal never echoes the configured value, which may carry a credential.
 */
const exec=promisify(execFile);
const env={PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
async function git(cwd: string,...args: string[]): Promise<string> {
  const { stdout }=await exec('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=always','-C',cwd,...args],{env,timeout:20000,maxBuffer:1024*1024});
  return stdout.trim();
}
async function fixture() {
  // The temp path itself may be a symlink on this machine; the adapter asks for the canonical path.
  const root=await realpath(await mkdtemp(join(tmpdir(),'pilot-local-push-'))),projectPath=join(root,'project'),remotePath=join(root,'remote.git'),template=join(root,'template');
  await Promise.all([mkdir(projectPath),mkdir(template)]);
  const id=randomUUID(),short='work/pilot-'+id.slice(0,8),branch='refs/heads/'+short;
  await git(projectPath,'init','-q','--template='+template);
  await git(projectPath,'config','user.name','Fixture');
  await git(projectPath,'config','user.email','fixture@example.invalid');
  await git(projectPath,'checkout','-q','-b',short);
  await writeFile(join(projectPath,'a.txt'),'base\n');
  await git(projectPath,'add','a.txt');await git(projectPath,'commit','-q','-m','base');
  const base=await git(projectPath,'rev-parse','HEAD');
  await git(root,'init','--bare','-q','--template='+template,remotePath);
  await git(remotePath,'config','core.hooksPath','/dev/null');
  await git(projectPath,'remote','add','origin',remotePath);
  await git(projectPath,'push','-q','--no-verify','--',remotePath,base+':'+branch);
  await writeFile(join(projectPath,'a.txt'),'accepted\n');
  await git(projectPath,'add','a.txt');await git(projectPath,'commit','-q','-m','accepted');
  const commit=await git(projectPath,'rev-parse','HEAD');
  const project:Project={id,name:'Local push fixture',path:projectPath,managed:true,repository:'',created:''};
  const transport=new LocalGitPushTransport({projectFor:projectId=>projectId===id?project:undefined});
  const configured=await resolveLocalPushRemote({project,remoteId:'origin'});
  const input={projectId:id,remoteId:'origin',repositoryDigest:configured.repositoryDigest,branch,commit};
  return {root,projectPath,remotePath,project,id,branch,base,commit,transport,configured,input,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test('the local transport inspects and pushes exactly one accepted commit to the configured remote',async()=>{
  const f=await fixture();
  try{
    const preview=await f.transport.inspect(f.input);
    assert.equal(preview.remoteHead,f.base,'the remote branch head is the accepted commit\u2019s parent');
    assert.equal(preview.repositoryDigest,f.configured.repositoryDigest);
    const pushed=await f.transport.push(f.input);
    assert.equal(pushed.observedCommit,f.commit);
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),f.commit,'the remote branch is the pushed commit');
    assert.equal(await git(f.projectPath,'rev-parse','HEAD'),f.commit);
  }finally{await f.cleanup();}
});

test('a moved remote is refused rather than forced',async()=>{
  const f=await fixture();
  try{
    // A competing commit on top of the same parent reaches the remote first.
    await git(f.projectPath,'checkout','-q','--detach',f.base);
    await writeFile(join(f.projectPath,'a.txt'),'competitor\n');
    await git(f.projectPath,'add','a.txt');await git(f.projectPath,'commit','-q','-m','competing');
    const competitor=await git(f.projectPath,'rev-parse','HEAD');
    await git(f.projectPath,'push','-q','--no-verify','--',f.remotePath,competitor+':'+f.branch);
    await git(f.projectPath,'checkout','-q','work/pilot-'+f.id.slice(0,8));
    await assert.rejects(f.transport.inspect(f.input),/not at the accepted commit\u2019s parent/);
    await assert.rejects(f.transport.push(f.input),/not at the accepted commit\u2019s parent/);
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),competitor,'the remote branch was not moved by a refused push');
  }finally{await f.cleanup();}
});

test('a re-pointed remote is refused before any push',async()=>{
  const f=await fixture();
  try{
    const other=join(f.root,'other.git');
    await git(f.root,'init','--bare','-q','--template='+join(f.root,'template'),other);
    await git(f.projectPath,'remote','set-url','origin',other);
    await assert.rejects(f.transport.inspect(f.input),/no longer matches the push target/);
    await assert.rejects(f.transport.push(f.input),/no longer matches the push target/);
    await assert.rejects(git(other,'rev-parse','--verify',f.branch),'the newly configured remote received nothing');
  }finally{await f.cleanup();}
});

test('a commit from another repository is refused',async()=>{
  const f=await fixture();
  try{
    const foreign=join(f.root,'foreign');
    await mkdir(foreign);
    await git(foreign,'init','-q','--template='+join(f.root,'template'));
    await git(foreign,'config','user.name','Fixture');await git(foreign,'config','user.email','fixture@example.invalid');
    await writeFile(join(foreign,'b.txt'),'foreign\n');
    await git(foreign,'add','b.txt');await git(foreign,'commit','-q','-m','foreign');
    const sha=await git(foreign,'rev-parse','HEAD');
    await assert.rejects(f.transport.inspect({...f.input,commit:sha}),/not a commit in this project/);
    await assert.rejects(f.transport.push({...f.input,commit:sha}),/not a commit in this project/);
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),f.base);
  }finally{await f.cleanup();}
});

test('only one canonical local repository can be a target, and a refusal echoes no configured value',async()=>{
  const f=await fixture();
  try{
    const secret='https://owner:'+randomUUID()+'@example.invalid/private.git';
    await git(f.projectPath,'remote','add','hosted',secret);
    const listed=await listLocalPushRemotes(f.project);
    assert.deepEqual(listed.map(remote=>remote.remoteId),['origin'],'a network remote is not offered as a target');
    await assert.rejects(resolveLocalPushRemote({project:f.project,remoteId:'hosted'}),(error:Error)=>!error.message.includes('example.invalid')&&!error.message.includes(secret.split(':')[2].split('@')[0]));
    await git(f.projectPath,'remote','add','relative','../elsewhere.git');
    await assert.rejects(resolveLocalPushRemote({project:f.project,remoteId:'relative'}),/local filesystem repository/);
    const linked=join(f.root,'linked.git');
    await symlink(f.remotePath,linked);
    await git(f.projectPath,'remote','add','linked',linked);
    await assert.rejects(resolveLocalPushRemote({project:f.project,remoteId:'linked'}),/real local directory|canonical path/);
    await assert.rejects(resolveLocalPushRemote({project:f.project,remoteId:'missing'}),/exactly one configured URL/);
    await assert.rejects(resolveLocalPushRemote({project:f.project,remoteId:'../origin'}),/name one configured Git remote/);
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),f.base,'no refusal touched the repository');
  }finally{await f.cleanup();}
});

test('an unavailable project or an invalid branch is refused',async()=>{
  const f=await fixture();
  try{
    const unknown=new LocalGitPushTransport({projectFor:()=>undefined});
    await assert.rejects(unknown.inspect(f.input),/connected worktree is unavailable/);
    await assert.rejects(f.transport.inspect({...f.input,branch:'refs/heads/../escape'}),/push branch is invalid/);
    await assert.rejects(f.transport.inspect({...f.input,commit:'not-a-commit'}),/does not name one commit/);
  }finally{await f.cleanup();}
});
