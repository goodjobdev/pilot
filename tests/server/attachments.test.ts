import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readdir,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ATTACHMENT_MAX_BYTES,AttachmentStore,attachmentLine,isAttachmentPath,safeAttachmentName } from '../../src/server/attachments';
import { HttpError } from '../../src/server/board-store';
import type { Project } from '../../src/shared/model';

/**
 * Attachments: a file the owner sends is written into the project's connected worktree and the
 * message names it, so an agent reads it through its own contained read.
 *
 * What is checked here is what this application promises: the name cannot choose a path, the bytes
 * are capped before anything is written, a project with no worktree is refused, and the file that
 * lands is the owner's own bytes and nothing else.
 */
async function fixture(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'pilot-attachment-'));
  const worktree=join(root,'repositories',randomUUID(),'agent');
  await mkdir(worktree,{recursive:true});
  const project:Project={id:randomUUID(),name:'Attachments',path:worktree,managed:true,repository:'',created:''};
  const unconnected:Project={...project,id:randomUUID(),path:join(root,'workspaces',randomUUID())};
  await mkdir(unconnected.path,{recursive:true});
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,worktree,project,unconnected,store:new AttachmentStore(id=>id===project.id?worktree:undefined)};
}
test('a name cannot choose a path, and the stored name is one this store could have written',async t=>{
  const {store,project,worktree}=await fixture(t);
  for(const [given,expected] of [['../../etc/passwd','passwd'],['a/b/c.txt','c.txt'],['..','attachment'],['','attachment'],['  ','attachment'],['notes.md','notes.md'],['weird name!.md','weird-name-.md']])
    assert.equal(safeAttachmentName(given),expected,given);
  // A long name is bounded rather than rejected, and it keeps its extension.
  const long=safeAttachmentName('x'.repeat(400)+'.txt');
  assert.equal(long.length,120);assert.ok(long.endsWith('.txt'));
  const stored=await store.store(project,'../../etc/passwd',Buffer.from('hello'));
  assert.equal(isAttachmentPath(stored.path),true,stored.path);
  assert.equal(stored.path.startsWith('docs/uploads/'),true);
  assert.equal(stored.path.endsWith('-passwd'),true);
  assert.equal(await readFile(join(worktree,stored.path),'utf8'),'hello');
  const files=await readdir(join(worktree,'docs/uploads'));
  assert.deepEqual(files,[stored.path.split('/').pop()],'exactly one file was written');
});
test('an empty or oversized body is refused before anything is written',async t=>{
  const {store,project,worktree}=await fixture(t);
  await assert.rejects(()=>store.store(project,'a.txt',Buffer.alloc(0)),(error:Error)=>error instanceof HttpError&&error.status===422);
  await assert.rejects(()=>store.store(project,'a.txt',Buffer.alloc(ATTACHMENT_MAX_BYTES+1)),(error:Error)=>error instanceof HttpError&&error.status===413);
  await assert.rejects(()=>readdir(join(worktree,'docs/uploads')),/ENOENT/,'nothing was stored for a refused body');
});
test('a project without a connected worktree has no attachment storage',async t=>{
  const {store,unconnected}=await fixture(t);
  await assert.rejects(()=>store.store(unconnected,'a.txt',Buffer.from('x')),(error:Error)=>error instanceof HttpError&&error.status===409&&/connected repository worktree/.test(error.message));
});
test('a symlinked uploads directory is refused rather than followed',async t=>{
  const {store,project,worktree,root}=await fixture(t);
  const outside=join(root,'outside');await mkdir(outside);await mkdir(join(worktree,'docs'),{recursive:true});await symlink(outside,join(worktree,'docs/uploads'));
  await assert.rejects(()=>store.store(project,'a.txt',Buffer.from('x')),/Symlinks/);
  assert.deepEqual(await readdir(outside),[],'nothing was written through the symlink');
});
test('the message line names every stored path, so an agent reads them from the worktree',async t=>{
  const {store,project}=await fixture(t);
  const first=await store.store(project,'one.txt',Buffer.from('1')),second=await store.store(project,'two.md',Buffer.from('2'));
  const line=attachmentLine([first.path,second.path]);
  assert.match(line,/read them from there/);
  assert.ok(line.includes(first.path)&&line.includes(second.path));
});
