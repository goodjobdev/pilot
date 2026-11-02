import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
const exec=promisify(execFile);
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
 const root=await mkdtemp(join(tmpdir(),'pilot-sync-')),security=localConfig('http://127.0.0.1:0'),app=await createApp({dataRoot:root,browseRoots:[],security});
 await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const token={'x-dashboard-token':security.token},headers={...token,origin:security.origin,'content-type':'application/json'};
 const post=async(path:string,body:unknown)=>fetch(security.origin+'/api'+path,{method:'POST',headers,body:JSON.stringify(body)});
 const get=async(path:string)=>fetch(security.origin+'/api'+path,{headers:token});
 const p=await (await post('/projects',{name:'Sync fixture',managed:true,confirm:true})).json();
 const git=async(...args:string[])=>(await exec('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:p.path,env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},timeout:10000})).stdout;
 await git('init','-b','work/pilot-'+p.id.slice(0,8));
 const base='/projects/'+p.id;return {p,base,security,token,post,get,git};
}
test('repository sync verifies source and board revisions, applies an atomic committed batch, and remains idempotent',async t=>{
 const {base,post,get,git}=await fixture(t);let saved=await (await post(base+'/docs/document',{path:'docs/tasks.md',text:'# Tasks\n- [ ] Store <!-- pilot:task STORE -->\n- [ ] View <!-- pilot:task VIEW --> <!-- pilot:depends STORE -->\n'})).json();assert.equal(saved.commit.status,'committed');
 const preview=await (await post(base+'/plan/preview',{paths:['docs/tasks.md']})).json();assert.equal(preview.preview.candidates.length,2);assert.equal(preview.preview.relationships.length,1);
 saved=await (await post(base+'/docs/document',{path:'docs/tasks.md',revision:saved.revision,text:saved.text+'\nChanged after preview\n'})).json();
 const selection={token:preview.token,selected:preview.preview.candidates.map((c:{id:string})=>c.id),edgeIds:preview.preview.relationships.map((e:{id:string})=>e.id)};
 assert.equal((await post(base+'/import/apply',selection)).status,409);assert.equal((await (await get(base+'/board')).json()).board.tasks.length,0);
 const fresh=await (await post(base+'/plan/preview',{paths:['docs/tasks.md']})).json();
 const before=Number((await git('rev-list','--count','HEAD')).trim());
 const applied=await post(base+'/import/apply',{token:fresh.token,selected:fresh.preview.candidates.map((c:{id:string})=>c.id),edgeIds:fresh.preview.relationships.map((e:{id:string})=>e.id)});assert.equal(applied.status,200);const board=await applied.json();assert.equal(board.commit.status,'committed');assert.equal(board.board.tasks.length,2);assert.equal(board.board.relationships.length,1);assert.equal(new Set(board.board.sources.map((s:{path:string})=>s.path)).size,1);assert.equal(board.board.tasks[0].specs[0].path,'docs/tasks.md');assert.equal(Number((await git('rev-list','--count','HEAD')).trim()),before+1);
 const again=await (await post(base+'/plan/preview',{paths:['docs/tasks.md']})).json();assert(again.preview.candidates.every((c:{change:string})=>c.change==='unchanged'));assert.equal(again.preview.relationships.length,0);
 assert.equal((await post(base+'/plan/preview',{paths:['docs/dashboard/board.md']})).status,422);
});
test('workspace routes keep authentication, containment, scope and reviewed-content checks',async t=>{
 const {p,base,security,post,get}=await fixture(t);
 assert.equal((await fetch(security.origin+'/api'+base+'/workspace')).status,401);
 assert.equal((await get('/projects/00000000-0000-4000-8000-000000000000/workspace')).status,404);
 const saved=await (await post(base+'/docs/document',{path:'docs/readme.md',text:'# One\n'})).json();await writeFile(join(p.path,'source.ts'),'export const n=1;\n');
 const view=await (await get(base+'/workspace')).json();assert(view.git);assert(view.files.some((f:{path:string})=>f.path==='source.ts'));
 const file=await (await get(base+'/workspace/file?path=source.ts')).json();assert.equal(file.text,'export const n=1;\n');
 for(const path of ['../outside.md','.git/config','.env','node_modules/other.md'])assert.equal((await get(base+'/workspace/file?path='+encodeURIComponent(path))).status,403);
 assert.equal((await post(base+'/workspace/commit',{path:'source.ts',revision:file.revision})).status,403);
 assert.equal((await post(base+'/workspace/commit',{path:'docs/readme.md',revision:'0'.repeat(64)})).status,409);
 const retry=await (await post(base+'/workspace/commit',{path:'docs/readme.md',revision:saved.revision})).json();assert.equal(retry.commit.status,'unchanged');
 assert.equal((await get(base+'/workspace/diff?path=source.ts&commit='+encodeURIComponent('--all'))).status,422);
});
