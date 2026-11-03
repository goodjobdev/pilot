import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import type { RepositoryCommand } from '../../src/server/repositories';
import type { Project } from '../../src/shared/model';
const exec=promisify(execFile);
async function fixture(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'pilot-remote-http-')),source=join(root,'source'),data=join(root,'data');await mkdir(source);await mkdir(data);
 const git=async(...args:string[])=>(await exec('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@localhost',...args])).stdout.trim();await git('init','-b','main');await writeFile(join(source,'index.html'),'baseline\n');await git('add','.');await git('commit','-m','Baseline');
 let fetching:()=>Promise<void>=async()=>{};
 const repositoryCommand:RepositoryCommand=async(file,args,options)=>{if(file==='git'&&args.includes('fetch'))await fetching();if(file==='git'&&args.includes('git@github.com:example/disposable.git')){args=args.map(a=>a==='git@github.com:example/disposable.git'?source:a);args=['-c','protocol.file.allow=always',...args.filter((a,i)=>!(a==='-c'&&args[i+1]==='protocol.file.allow=never')&&a!=='protocol.file.allow=never')];}return exec(file,args,options);};
 const security=localConfig('http://127.0.0.1:0'),control=new ControlStore(data),app=await createApp({dataRoot:data,browseRoots:[],security,control,repositoryCommand});t.after(async()=>{await app.close();control.close();await rm(root,{recursive:true,force:true});});await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
 const auth={'x-dashboard-token':security.token},writes={...auth,origin:security.origin,'content-type':'application/json'};
 const call=(path:string,body?:unknown)=>fetch(security.origin+'/api'+path,body===undefined?{headers:auth}:{method:'POST',headers:writes,body:JSON.stringify(body)});
 const added=await call('/projects',{name:'Disposable',managed:true,repository:'https://github.com/example/disposable.git',confirm:true}),p=await added.json() as Project;
 assert.equal(added.status,201);assert.equal((await call('/projects/'+p.id+'/repository/key',{})).status,200);assert.equal((await call('/projects/'+p.id+'/repository/connect',{confirm:true})).status,200);
 const workspace='/projects/'+p.id+'/workspace',file=await (await call(workspace+'/file?path=docs/dashboard/board.md')).json();assert.equal((await call(workspace+'/commit',{path:file.path,revision:file.revision})).status,200);
 const remote=workspace+'/remote';
 return {app,p,call,remote,workspace,security,writes,advance:async()=>{await writeFile(join(source,'index.html'),'incoming\n');await git('add','.');await git('commit','-m','Incoming change');},holdFetch:(fn:()=>Promise<void>)=>{fetching=fn;}};
}
test('remote API shares authentication/origin/confirmation boundaries and applies a real reviewed merge',async t=>{
 const f=await fixture(t);await f.advance();
 for(const action of ['check','apply']){
  assert.equal((await fetch(f.security.origin+'/api'+f.remote+'/'+action,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(f.security.origin+'/api'+f.remote+'/'+action,{method:'POST',headers:{...f.writes,origin:'https://evil.invalid'},body:'{}'})).status,403);
 }
 assert.equal((await f.call(f.remote+'/check',null)).status,422);
 assert.equal((await f.call(f.remote+'/check',{remote:'ssh://untrusted.invalid'})).status,422);
 const checked=await f.call(f.remote+'/check',{});assert.equal(checked.status,200);const review=await checked.json();assert.equal(review.mode,'merge');assert.equal(review.canApply,true);assert.equal((await f.call(f.remote+'/diff?token='+review.token+'&path=index.html')).status,200);
 assert.equal((await f.call(f.remote+'/apply',{token:review.token,confirm:false})).status,422);
 assert.equal((await f.call(f.remote+'/apply',{token:review.token,confirm:true,target:'unreviewed'})).status,422);
 const applied=await f.call(f.remote+'/apply',{token:review.token,confirm:true});assert.equal(applied.status,200);assert.equal((await applied.json()).mode,'merge');assert.equal((await f.call(f.remote+'/apply',{token:review.token,confirm:true})).status,409);
});
test('fetch blocks ordinary mutations, lifecycle dispatch and scoped palette actions until it finishes',async t=>{
 const f=await fixture(t);await f.advance();let entered!:()=>void,release!:()=>void;const entrance=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);f.holdFetch(async()=>{entered();await wait;});const checking=f.call(f.remote+'/check',{});await entrance;
 try{
  assert.equal((await f.call('/projects/'+f.p.id+'/board',{})).status,409);
  assert.equal((await f.call('/sessions/example/lifecycle/resume?projectId='+f.p.id,{})).status,409);
  assert.equal((await f.call('/actions/execute',{id:'anything',scope:{projectId:f.p.id}})).status,409);
  assert.equal((await f.call(f.remote+'/check',{})).status,409);
 }finally{release();}
 assert.equal((await checking).status,200);
});
test('already-admitted project writes finish before a remote review can start',async t=>{
 const f=await fixture(t),original=f.app.boards.mutate.bind(f.app.boards);let entered!:()=>void,release!:()=>void;const entrance=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 f.app.boards.mutate=async(...args)=>{entered();await wait;return original(...args);};
 const board=await(await f.call('/projects/'+f.p.id+'/board')).json(),writing=f.call('/projects/'+f.p.id+'/board',{revision:board.revision,operation:{op:'adopt'}});await entrance;
 try{const result=await f.call(f.remote+'/check',{});assert.equal(result.status,409);assert.match((await result.json()).error,/still finishing/);}finally{release();}
 assert.equal((await writing).status,200);
});
