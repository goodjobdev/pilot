import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RepositoryStore,type RepositoryCommand } from '../../src/server/repositories';
import { RemoteStore } from '../../src/server/remote';
import { WorkspaceStore } from '../../src/server/workspace';
import { HttpError } from '../../src/server/board-store';
import { emptyBoard,type Project } from '../../src/shared/model';
import { serializeBoard } from '../../src/shared/markdown';
import { PLAN_PATH } from '../../src/shared/workspace';
const exec=promisify(execFile);
async function fixture(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'pilot-remote-')),source=join(root,'source'),planning=join(root,'planning');
 await mkdir(join(source,'docs/dashboard'),{recursive:true});await mkdir(planning);
 const git=async(path:string,args:string[])=>(await exec('git',['-C',path,'-c','user.name=Fixture','-c','user.email=fixture@localhost',...args])).stdout.trim();
 await git(source,['init','-b','main']);await writeFile(join(source,PLAN_PATH),serializeBoard(emptyBoard()));await writeFile(join(source,'index.html'),'baseline\n');await writeFile(join(source,'.gitignore'),'.scratch/\n');
 await git(source,['add','.']);await git(source,['commit','-m','Baseline']);
 const p:Project={id:randomUUID(),name:'Disposable',path:planning,managed:true,repository:'https://github.com/example/disposable.git',created:new Date().toISOString()};
 const commands:string[][]=[];
 const command:RepositoryCommand=async(file,args,options)=>{
  commands.push([file,...args]);
  if(file==='git'&&args.includes('git@github.com:example/disposable.git')){
   // Only tests replace the pinned GitHub transport with a disposable local repository.
   args=args.map(a=>a==='git@github.com:example/disposable.git'?source:a);
   args=['-c','protocol.file.allow=always',...args.filter((a,i)=>!(a==='-c'&&args[i+1]==='protocol.file.allow=never')&&a!=='protocol.file.allow=never')];
  }
  return exec(file,args,options);
 };
 const repositories=new RepositoryStore(root,command),workspace=new WorkspaceStore();
 await repositories.generate(p);await repositories.connect(p,async()=>{},async path=>{p.path=path;});
 let blocked=false,clock=Date.now();
 const remote=new RemoteStore(repositories,workspace,async()=>{if(blocked)throw new HttpError(409,'Active or uncertain work');},()=>clock);
 const commit=async(path:string,subject:string)=>{await git(path,['add','-A']);await git(path,['commit','-m',subject]);return git(path,['rev-parse','HEAD']);};
 const advance=async(text='remote\n')=>{await writeFile(join(source,'index.html'),text);return commit(source,'Incoming change');};
 t.after(async()=>{await repositories.close();await workspace.drain();await rm(root,{recursive:true,force:true});});
 return {root,source,p,git,repositories,workspace,remote,commands,advance,commit,setBlocked:(v:boolean)=>{blocked=v;},expire:()=>{clock+=600001;}};
}
test('remote fetch pins the default branch but does not change head, index, files or base checkout',async t=>{
 const f=await fixture(t),head=await f.git(f.p.path,['rev-parse','HEAD']),base=join(f.root,'repositories',f.p.id,'main');
 await writeFile(join(f.p.path,'local.md'),'retained draft\n');const index=await f.git(f.p.path,['write-tree']);await f.advance();
 const review=await f.remote.check(f.p);
 assert.equal(review.branch,'main');assert.equal(review.behind,1);assert.equal(review.ahead,0);assert.equal(review.mode,'fast-forward');assert.equal(review.canApply,false);assert.match(review.message,/Uncommitted/);
 assert.equal(await f.git(f.p.path,['rev-parse','HEAD']),head);assert.equal(await f.git(f.p.path,['write-tree']),index);assert.equal(await readFile(join(f.p.path,'index.html'),'utf8'),'baseline\n');assert.equal(await readFile(join(f.p.path,'local.md'),'utf8'),'retained draft\n');assert.equal(await f.git(base,['rev-parse','HEAD']),head);
 const diff=await f.remote.diff(f.p,review.token,'index.html');assert.match(diff.diff,/-baseline/);assert.match(diff.diff,/\+remote/);
 const fetch=f.commands.find(c=>c.includes('fetch'))!;assert.ok(fetch.includes('--no-write-fetch-head'));assert.ok(fetch.includes('--no-recurse-submodules'));assert.ok(fetch.includes('core.hooksPath=/dev/null'));assert.equal(f.commands.some(c=>c.includes('push')||c.includes('reset')||c.includes('stash')),false);
});
test('approved fast-forward updates only the Pilot worktree and consumes the review',async t=>{
 const f=await fixture(t),head=await f.git(f.p.path,['rev-parse','HEAD']),target=await f.advance(),review=await f.remote.check(f.p);
 assert.equal(review.canApply,true);const applied=await f.remote.apply(f.p,review.token);assert.equal(applied.head,target);assert.equal(applied.mode,'fast-forward');assert.equal(await readFile(join(f.p.path,'index.html'),'utf8'),'remote\n');
 assert.equal(await f.git(join(f.root,'repositories',f.p.id,'main'),['rev-parse','HEAD']),head);
 await assert.rejects(()=>f.remote.apply(f.p,review.token),/expired or is unavailable/);
 assert.equal((await f.remote.check(f.p)).mode,'up-to-date');
});
test('approved divergence makes a clean two-parent merge preserving local documentation commits',async t=>{
 const f=await fixture(t);await writeFile(join(f.p.path,'local.md'),'owner intent\n');const local=await f.commit(f.p.path,'Local documentation');const target=await f.advance();
 const review=await f.remote.check(f.p);assert.equal(review.mode,'merge');assert.equal(review.canApply,true);assert.equal(review.ahead,1);assert.equal(review.behind,1);assert.deepEqual(review.paths,['index.html']);
 const result=await f.remote.apply(f.p,review.token),parents=await f.git(f.p.path,['show','-s','--format=%P',result.head]);assert.equal(parents,local+' '+target);assert.equal(await readFile(join(f.p.path,'local.md'),'utf8'),'owner intent\n');assert.equal(await readFile(join(f.p.path,'index.html'),'utf8'),'remote\n');assert.equal(await f.git(f.p.path,['status','--porcelain']),'');
});
test('proposed result previews follow a local rename instead of showing only the remote source path',async t=>{
 const f=await fixture(t);await f.git(f.p.path,['mv','index.html','renamed.html']);await f.commit(f.p.path,'Local rename');await f.advance();const review=await f.remote.check(f.p);
 assert.equal(review.mode,'merge');assert.equal(review.canApply,true);assert.deepEqual(review.paths,['index.html']);assert.deepEqual(review.resultPaths,['renamed.html']);
 const patch=await f.remote.diff(f.p,review.token,'renamed.html','result');assert.match(patch.diff,/\+remote/);await assert.rejects(()=>f.remote.diff(f.p,review.token,'renamed.html'),/not previewable/);
 await f.remote.apply(f.p,review.token);assert.equal(await readFile(join(f.p.path,'renamed.html'),'utf8'),'remote\n');await assert.rejects(()=>readFile(join(f.p.path,'index.html')),/ENOENT/);
});
test('merge conflicts leave the real head/index/files untouched',async t=>{
 const f=await fixture(t);await writeFile(join(f.p.path,'index.html'),'local edit\n');const local=await f.commit(f.p.path,'Local edit'),index=await f.git(f.p.path,['write-tree']);await f.advance();
 const review=await f.remote.check(f.p);assert.equal(review.mode,'conflict');assert.equal(review.canApply,false);await assert.rejects(()=>f.remote.apply(f.p,review.token),/cannot be applied/);
 assert.equal(await f.git(f.p.path,['rev-parse','HEAD']),local);assert.equal(await f.git(f.p.path,['write-tree']),index);assert.equal(await readFile(join(f.p.path,'index.html'),'utf8'),'local edit\n');assert.equal(await f.git(f.p.path,['status','--porcelain']),'');
});
test('stale head, expired, superseded, wrong-project and consumed reviews cannot apply',async t=>{
 const f=await fixture(t);await f.advance();let review=await f.remote.check(f.p);await assert.rejects(()=>f.remote.apply({...f.p,id:randomUUID()},review.token),/expired or is unavailable/);
 await writeFile(join(f.p.path,'local.md'),'new owner change');await f.commit(f.p.path,'Changed after review');await assert.rejects(()=>f.remote.apply(f.p,review.token),/changed since review/);
 review=await f.remote.check(f.p);f.expire();await assert.rejects(()=>f.remote.apply(f.p,review.token),/expired or is unavailable/);
 review=await f.remote.check(f.p);await f.remote.check(f.p);await assert.rejects(()=>f.remote.apply(f.p,review.token),/expired or is unavailable/);
});
test('dirty and staged edits made after review remain byte-identical on refusal',async t=>{
 const f=await fixture(t);await f.advance();let review=await f.remote.check(f.p);await writeFile(join(f.p.path,'index.html'),'unsaved externally\n');await f.git(f.p.path,['add','index.html']);
 await assert.rejects(()=>f.remote.apply(f.p,review.token),/Uncommitted or staged/);assert.equal(await readFile(join(f.p.path,'index.html'),'utf8'),'unsaved externally\n');assert.equal(await f.git(f.p.path,['diff','--cached','--name-only']),'index.html');
 // A staged target also blocks a fresh check, without consuming its staging.
 review=await f.remote.check(f.p);assert.equal(review.canApply,false);assert.equal(await f.git(f.p.path,['diff','--cached','--name-only']),'index.html');
});
test('ignored untracked collisions are preserved, rather than overwritten by checkout',async t=>{
 const f=await fixture(t);await mkdir(join(f.p.path,'.scratch'));await writeFile(join(f.p.path,'.scratch','notes.txt'),'private retained bytes');await mkdir(join(f.source,'.scratch'));await writeFile(join(f.source,'.scratch','notes.txt'),'remote replacement');await f.git(f.source,['add','-f','.scratch/notes.txt']);await f.git(f.source,['commit','-m','Incoming ignored collision']);
 const review=await f.remote.check(f.p);assert.equal(review.canApply,false);assert.match(review.message,/untracked or ignored/);await assert.rejects(()=>f.remote.apply(f.p,review.token));assert.equal(await readFile(join(f.p.path,'.scratch/notes.txt'),'utf8'),'private retained bytes');
});
test('changed symlinks and invalid or removed canonical plans are refused',async t=>{
 for(const variant of ['symlink','invalid','removed']){
  const f=await fixture(t);if(variant==='symlink')await symlink('../outside',join(f.source,'link'));else if(variant==='invalid')await writeFile(join(f.source,PLAN_PATH),'not a board');else await rm(join(f.source,PLAN_PATH));await f.commit(f.source,'Unsafe incoming '+variant);
  const head=await f.git(f.p.path,['rev-parse','HEAD']),review=await f.remote.check(f.p);assert.equal(review.canApply,false,variant);await assert.rejects(()=>f.remote.apply(f.p,review.token));assert.equal(await f.git(f.p.path,['rev-parse','HEAD']),head);
 }
});
test('hooks and configured filters never execute; custom merge drivers and rewrites are rejected',async t=>{
 const f=await fixture(t),marker=join(f.root,'must-not-run');await writeFile(join(f.source,'.gitattributes'),'index.html filter=exploit diff=exploit\n');await f.advance();
 await f.git(f.p.path,['config','filter.exploit.clean','touch '+marker]);await f.git(f.p.path,['config','filter.exploit.smudge','touch '+marker]);await f.git(f.p.path,['config','filter.exploit.process','touch '+marker]);await f.git(f.p.path,['config','diff.exploit.command','touch '+marker]);
 const hook=(await f.git(f.p.path,['rev-parse','--path-format=absolute','--git-path','hooks/post-merge']));await writeFile(hook,'#!/bin/sh\ntouch '+marker+'\n',{mode:0o755});
 let review=await f.remote.check(f.p);assert.equal(review.canApply,true);await f.remote.diff(f.p,review.token,'index.html');await f.remote.apply(f.p,review.token);await assert.rejects(()=>readFile(marker),/ENOENT/);
 await f.git(f.p.path,['config','merge.exploit.driver','touch '+marker]);await f.advance('second remote\n');review=await f.remote.check(f.p);assert.equal(review.canApply,false);assert.match(review.message,/merge drivers/);await assert.rejects(()=>readFile(marker),/ENOENT/);
 await f.git(f.p.path,['config','url.ssh://elsewhere/.insteadOf','git@github.com:']);await assert.rejects(()=>f.remote.check(f.p),/URL rewrites/);
});
test('active work and Git locks block; save serialization prevents writes during a remote check',async t=>{
 const f=await fixture(t);await f.advance();f.setBlocked(true);const calls=f.commands.length;await assert.rejects(()=>f.remote.check(f.p),/Active or uncertain/);assert.equal(f.commands.length,calls);f.setBlocked(false);
 const lock=await f.git(f.p.path,['rev-parse','--path-format=absolute','--git-path','index.lock']);await writeFile(lock,'operator lock');let review=await f.remote.check(f.p);assert.equal(review.canApply,false);assert.match(review.message,/operation or lock/);await rm(lock);
 let release!:()=>void,entered!:()=>void;const entrance=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 const remote=new RemoteStore(f.repositories,f.workspace,async()=>{entered();await wait;});const checking=remote.check(f.p);await entrance;assert.equal(remote.isBusy(f.p.id),true);await assert.rejects(()=>remote.check(f.p),/already in progress/);
 let written=false;const saving=f.workspace.save(f.p,['local.md'],async()=>{written=true;await writeFile(join(f.p.path,'local.md'),'queued save');return {};});await new Promise(r=>setTimeout(r,25));assert.equal(written,false);release();review=await checking;await saving;assert.equal(written,true);await assert.rejects(()=>remote.apply(f.p,review.token),/changed since review/);
});
test('incoming previews cannot expose excluded or unreviewed paths',async t=>{
 const f=await fixture(t);await writeFile(join(f.source,'.env'),'PRIVATE-TEST-ONLY');await f.advance();const review=await f.remote.check(f.p);assert.equal(review.totalPaths,2);assert.equal(review.paths.includes('.env'),false);
 await assert.rejects(()=>f.remote.diff(f.p,review.token,'.env'),/not previewable/);await assert.rejects(()=>f.remote.diff(f.p,review.token,'../outside'),/not previewable/);
});
test('changed gitlinks and special index flags cannot bypass the update guard',async t=>{
 const f=await fixture(t),head=await f.git(f.source,['rev-parse','HEAD']);await f.git(f.source,['update-index','--add','--cacheinfo','160000,'+head+',vendor']);await f.git(f.source,['commit','-m','Incoming gitlink']);let review=await f.remote.check(f.p);assert.equal(review.canApply,false);assert.match(review.message,/submodules/);
 const other=await fixture(t);await other.advance();await other.git(other.p.path,['update-index','--assume-unchanged','index.html']);await writeFile(join(other.p.path,'index.html'),'hidden local data');review=await other.remote.check(other.p);assert.equal(review.canApply,false);assert.match(review.message,/index flags/);assert.equal(await readFile(join(other.p.path,'index.html'),'utf8'),'hidden local data');
});
test('retargeted origin is ignored, but a changed pinned ref or deploy key invalidates approval',async t=>{
 const f=await fixture(t);await f.git(f.p.path,['config','remote.origin.url','ssh://untrusted.invalid/repo']);await f.advance();let review=await f.remote.check(f.p);assert.equal(review.canApply,true);
 await f.git(f.p.path,['update-ref','refs/pilot/remotes/'+f.p.id+'/default',review.head]);await assert.rejects(()=>f.remote.apply(f.p,review.token),/changed since review/);
 review=await f.remote.check(f.p);await f.repositories.removeKey(f.p);await assert.rejects(()=>f.remote.apply(f.p,review.token),/changed since review/);
});
test('an effect with an unconfirmed response is not replayed and exposes no raw command error',async t=>{
 const f=await fixture(t),target=await f.advance(),review=await f.remote.check(f.p),run=f.workspace.localGit.bind(f.workspace);let effects=0;
 f.workspace.localGit=async(p,args)=>{const value=await run(p,args);if(args[0]==='merge'){effects++;throw Error('PRIVATE-COMMAND-OUTPUT');}return value;};
 await assert.rejects(()=>f.remote.apply(f.p,review.token),(error:Error)=>/unconfirmed/.test(error.message)&&!error.message.includes('PRIVATE-COMMAND-OUTPUT'));
 assert.equal(await f.git(f.p.path,['rev-parse','HEAD']),target);await assert.rejects(()=>f.remote.apply(f.p,review.token),/expired or is unavailable/);assert.equal(effects,1);
});
