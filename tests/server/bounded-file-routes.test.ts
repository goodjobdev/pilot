import assert from 'node:assert/strict';
import { mkdir,mkdtemp,open,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../src/server/main';
import { emptyBoard } from '../../src/shared/model';
import { serializeBoard } from '../../src/shared/markdown';
import { localConfig } from '../../src/server/security';

test('import apply refuses and preserves an oversized retained source snapshot',async()=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'pilot-import-source-cap-'));
 const security=localConfig('http://127.0.0.1:0'),app=await createApp({dataRoot,browseRoots:[],security});
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
 try{
  const headers={'x-dashboard-token':security.token,'content-type':'application/json',origin:security.origin};
  const created=await fetch(security.origin+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Import source cap',managed:true,confirm:true})});assert.equal(created.status,201);
  const project=await created.json() as {id:string};const p=app.catalog.get(project.id),base=security.origin+'/api/projects/'+project.id;
  const content='# Tasks\n- [ ] Store <!-- pilot:task STORE -->\n';
  const previewResponse=await fetch(base+'/import/preview',{method:'POST',headers,body:JSON.stringify({documents:[{name:'docs/tasks.md',content}]})});assert.equal(previewResponse.status,200);
  const preview=await previewResponse.json() as {token:string;preview:{candidates:{id:string;source:{path:string}}[];relationships:{id:string}[]}};
  const candidate=preview.preview.candidates[0];assert(candidate);
  const retainedPath=join(p.path,candidate.source.path);await mkdir(join(p.path,dirname(candidate.source.path)),{recursive:true});
  const retained=await open(retainedPath,'w');try{await retained.truncate(Buffer.byteLength(content)+1);}finally{await retained.close();}
  const apply=await fetch(base+'/import/apply',{method:'POST',headers,body:JSON.stringify({token:preview.token,selected:[candidate.id],edgeIds:preview.preview.relationships.map(edge=>edge.id)})});
  assert.equal(apply.status,409);assert.match(await apply.text(),/retained source snapshot differs/);
  const boardAfter=await (await fetch(base+'/board',{headers:{'x-dashboard-token':security.token}})).json();assert.equal(boardAfter.board.tasks.length,0,'failed materialization leaves the board untouched');
  const after=await open(retainedPath,'r');try{assert.equal((await after.stat()).size,Buffer.byteLength(content)+1,'the oversized file is not replaced or truncated');}finally{await after.close();}
 }finally{await app.close();await rm(dataRoot,{recursive:true,force:true});}
});

test('source snapshot route returns 413 for an oversized retained snapshot',async()=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'pilot-source-cap-'));
 const security=localConfig('http://127.0.0.1:0'),app=await createApp({dataRoot,browseRoots:[],security});
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
 try{
  const headers={ 'x-dashboard-token':security.token,'content-type':'application/json',origin:security.origin };
  const response=await fetch(security.origin+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Source cap',managed:true,confirm:true})});assert.equal(response.status,201);
  const project=await response.json() as {id:string};const p=app.catalog.get(project.id),sourceId='22222222-2222-4222-8222-222222222222';
  const board=emptyBoard();board.sources.push({id:sourceId,name:'Retained source',path:'docs/dashboard/sources/'+sourceId+'-'+'a'.repeat(64)+'.md',locator:'task fixture',fingerprint:'a'.repeat(64),captured:new Date(0).toISOString()});
  await mkdir(join(p.path,'docs/dashboard/sources'),{recursive:true});await writeFile(join(p.path,'docs/dashboard/board.md'),serializeBoard(board));
  const retained=await open(join(p.path,'docs/dashboard/sources/'+sourceId+'-'+'a'.repeat(64)+'.md'),'w');try{await retained.truncate(2*1024*1024+1);}finally{await retained.close();}
  const result=await fetch(security.origin+'/api/projects/'+project.id+'/sources/'+sourceId,{headers});assert.equal(result.status,413);
 }finally{await app.close();await rm(dataRoot,{recursive:true,force:true});}
});
