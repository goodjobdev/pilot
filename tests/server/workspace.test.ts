import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceStore } from '../../src/server/workspace';
import { BoardStore } from '../../src/server/board-store';
import { DocStore } from '../../src/server/docs-store';
import { emptyBoard,newTask,type Project } from '../../src/shared/model';
import { serializeBoard } from '../../src/shared/markdown';
import { PLAN_PATH } from '../../src/shared/workspace';
const exec=promisify(execFile);
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},git=true){
 const root=await mkdtemp(join(tmpdir(),'pilot-workspace-')),path=join(root,'repo');await mkdir(path);t.after(()=>rm(root,{recursive:true,force:true}));
 const p:Project={id:randomUUID(),name:'Fixture',path,managed:true,repository:'',created:new Date().toISOString()};
 const command=async(...args:string[])=>(await exec('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:path,env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},timeout:10000})).stdout;
 if(git)await command('init','-b','work/pilot-'+p.id.slice(0,8));
 const workspace=new WorkspaceStore(),boards=new BoardStore(root,workspace),docs=new DocStore({}, {boards,workspace});return {root,p,command,workspace,boards,docs};
}
test('document saves commit exactly their file and preserve unrelated staged changes',async t=>{
 const {p,docs,workspace,command}=await fixture(t);
 const first=await docs.create(p,'docs/spec.md','# Spec\n');assert.equal(first.commit?.status,'committed');
 assert.equal(await command('show','HEAD:docs/spec.md'),'# Spec\n');
 await writeFile(join(p.path,'unrelated.txt'),'staged elsewhere\n');await command('add','unrelated.txt');
 const saved=await docs.write(p,first.path,first.revision,'# Spec\n\nUpdated\n');assert.equal(saved.commit?.status,'committed');
 assert.equal((await command('diff','--cached','--name-only')).trim(),'unrelated.txt');
 assert.equal((await workspace.commitPaths(p,saved.commit!.hash!)).paths.join(','),'docs/spec.md');
 assert.match((await workspace.diff(p,first.path,saved.commit!.hash)).diff,/\+Updated/);
 const noop=await docs.write(p,saved.path,saved.revision,saved.text);assert.equal(noop.commit?.status,'unchanged');
});
test('canonical plan edits and board operations use the same document, revision and commits',async t=>{
 const {p,boards,docs,command}=await fixture(t);const initialized=await boards.initialize(p,serializeBoard(emptyBoard()));
 assert.equal(initialized.commit?.status,'committed');assert((await docs.list(p)).some(d=>d.path===PLAN_PATH));
 const source=await docs.read(p,PLAN_PATH),board=(await boards.read(p)).board;const task=newTask(randomUUID(),'From the document');board.tasks.push(task);
 const saved=await docs.write(p,PLAN_PATH,source.revision,serializeBoard(board));assert.equal(saved.commit?.status,'committed');
 assert.equal((await boards.read(p)).board.tasks[0].title,'From the document');
 await assert.rejects(()=>boards.mutate(p,initialized.revision,{op:'putTask',task:newTask(randomUUID(),'Stale')}),/changed/);
 const current=await boards.read(p);task.status='done';const result=await boards.mutate(p,current.revision,{op:'putTask',task});assert.equal(result.commit?.status,'committed');
 assert.match((await docs.read(p,PLAN_PATH)).text,/status: done/);assert.equal(await command('show','HEAD:'+PLAN_PATH),await boards.raw(p));
 await assert.rejects(()=>docs.write(p,PLAN_PATH,result.revision,'not a plan'),/Invalid plan/);assert.equal((await boards.read(p)).revision,result.revision);
});
test('a staged target is retained and reported as saved, not committed',async t=>{
 const {p,docs,command}=await fixture(t);const first=await docs.create(p,'docs/spec.md','# Original\n');
 await writeFile(join(p.path,first.path),'# Staged\n');await command('add','docs/spec.md');const read=await docs.read(p,first.path);
 const saved=await docs.write(p,read.path,read.revision,'# Saved\n');assert.equal(saved.commit?.status,'failed');
 assert.equal(await readFile(join(p.path,read.path),'utf8'),'# Saved\n');assert.equal(await command('show',':docs/spec.md'),'# Staged\n');assert.equal(await command('show','HEAD:docs/spec.md'),'# Original\n');
});
test('unconnected projects save honestly without manufacturing Git history',async t=>{
 const {p,docs,workspace}=await fixture(t,false);const result=await docs.create(p,'docs/spec.md','# Saved\n');assert.equal(result.commit?.status,'unavailable');assert.equal((await workspace.state(p)).git,false);
});
test('file and change previews reject traversal, credentials, generated paths, symlinks and binary data',async t=>{
 const {p,workspace}=await fixture(t);await mkdir(join(p.path,'src'));await writeFile(join(p.path,'src/app.ts'),'export const value=1;\n');await writeFile(join(p.path,'.env'),'PRIVATE');await writeFile(join(p.path,'secrets.json'),'PRIVATE');await writeFile(join(p.path,'binary.txt'),Buffer.from([0,1,2]));await symlink('../.env',join(p.path,'src/link.ts'));
 const state=await workspace.state(p);assert(state.files.some(f=>f.path==='src/app.ts'));assert(!state.files.some(f=>/\.env|secrets|link/.test(f.path)));
 for(const path of ['../private.md','/etc/passwd','.git/config','.env','secrets.json','node_modules/file.ts','src/link.ts'])await assert.rejects(()=>workspace.read(p,path));
 await assert.rejects(()=>workspace.read(p,'binary.txt'),/Binary/);assert.equal((await workspace.read(p,'src/app.ts')).text,'export const value=1;\n');
});
test('repository filters and hooks never execute during viewing or automatic commits',async t=>{
 const {p,workspace,docs,command}=await fixture(t);await docs.create(p,'docs/spec.md','# Initial\n');
 const marker=join(p.path,'executed.txt');await command('config','filter.hostile.clean','touch '+marker);await command('config','filter.hostile.process','touch '+marker);await command('config','filter.hostile.required','true');
 await writeFile(join(p.path,'.gitattributes'),'*.md filter=hostile\n');await writeFile(join(p.path,'.git/hooks/post-commit'),'#!/bin/sh\ntouch "'+marker+'"\n');await chmod(join(p.path,'.git/hooks/post-commit'),0o755);
 const doc=await docs.read(p,'docs/spec.md');const saved=await docs.write(p,doc.path,doc.revision,'# Safe\n');assert.equal(saved.commit?.status,'committed');
 await workspace.state(p);await workspace.diff(p,doc.path);await assert.rejects(()=>readFile(marker),{code:'ENOENT'});
});
test('automatic commits refuse main and preserve saved content without switching branches',async t=>{
 const {p,docs,command}=await fixture(t);const first=await docs.create(p,'docs/spec.md','# Original\n');await command('checkout','-b','main');
 const saved=await docs.write(p,first.path,first.revision,'# Saved on purpose\n');assert.equal(saved.commit?.status,'failed');assert.match(saved.commit!.message,/working branch/);assert.equal((await command('symbolic-ref','--short','HEAD')).trim(),'main');assert.equal(await command('show','HEAD:docs/spec.md'),'# Original\n');assert.equal(await readFile(join(p.path,first.path),'utf8'),'# Saved on purpose\n');
});
test('an invalid external plan remains readable for repair but cannot mutate the board until validated',async t=>{
 const {p,boards,docs}=await fixture(t);await boards.initialize(p,serializeBoard(emptyBoard()));await writeFile(join(p.path,PLAN_PATH),'invalid YAML plan');
 await assert.rejects(()=>boards.read(p),/read-only/);const invalid=await docs.read(p,PLAN_PATH);assert.equal(invalid.text,'invalid YAML plan');
 const fixed=await docs.write(p,PLAN_PATH,invalid.revision,serializeBoard(emptyBoard()));assert.equal(fixed.commit?.status,'unchanged');assert.equal((await boards.read(p)).board.tasks.length,0);
});

test('linked worktree commits use the project branch and do not change the base checkout',async t=>{
 const {root,p,docs,command}=await fixture(t);await docs.create(p,'docs/spec.md','# Base\n');
 const id=randomUUID(),path=join(root,'linked');await command('worktree','add','-b','work/pilot-'+id.slice(0,8),path,'HEAD');
 const linked={...p,id,path},saved=await docs.create(linked,'docs/linked.md','# Linked only\n');assert.equal(saved.commit?.status,'committed');
 assert.equal((await command('rev-list','--count','HEAD')).trim(),'1');await assert.rejects(()=>command('show','HEAD:docs/linked.md'));
 assert.equal(await readFile(join(path,'docs/linked.md'),'utf8'),'# Linked only\n');
});

test('concurrent board and document saves keep separate commits and both canonical results',async t=>{
 const {p,docs,boards,command}=await fixture(t);const initial=await boards.initialize(p,serializeBoard(emptyBoard())),doc=await docs.create(p,'docs/spec.md','# Initial\n');
 const task={id:randomUUID(),title:'Concurrent task',domain:initial.board.domains[0].id,milestone:null,status:'todo',scope:'active',description:'',acceptance:'',gates:[],tags:[],specs:[],sources:[],archived:false};
 const [plan,saved]=await Promise.all([boards.mutate(p,initial.revision,{op:'putTask',task}),docs.write(p,doc.path,doc.revision,'# Updated\n')]);
 assert.equal(plan.commit?.status,'committed');assert.equal(saved.commit?.status,'committed');assert.equal((await command('rev-list','--count','HEAD')).trim(),'4');assert.match(await command('show','HEAD:'+PLAN_PATH),/Concurrent task/);assert.equal(await command('show','HEAD:docs/spec.md'),'# Updated\n');
});

test('merge history shows real first-parent paths and patches',async t=>{
 const {p,docs,workspace,command}=await fixture(t);const first=await docs.create(p,'docs/base.md','# Base\n');
 await command('checkout','-b','fixture-side');await writeFile(join(p.path,'docs/side.md'),'# Side\n');await command('add','docs/side.md');await command('commit','-m','fixture: side');
 await command('checkout','work/pilot-'+p.id.slice(0,8));await docs.write(p,first.path,first.revision,'# Main line\n');await command('merge','--no-ff','-m','fixture: merge','fixture-side');
 const head=(await command('rev-parse','HEAD')).trim();assert.deepEqual((await workspace.commitPaths(p,head)).paths,['docs/side.md']);assert.match((await workspace.diff(p,'docs/side.md',head)).diff,/\+# Side/);
});
