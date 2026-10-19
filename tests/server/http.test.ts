import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
test('API authentication, origin, content type and project isolation',async()=>{
 const security=localConfig('http://127.0.0.1:0'),app=await createApp({dataRoot:await mkdtemp(join(tmpdir(),'dashboard-api-')),browseRoots:[],security});
 await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));security.origin='http://127.0.0.1:'+(app.server.address() as any).port;
 try{
 const url=security.origin,token={'x-dashboard-token':security.token};
 assert.equal((await fetch(url+'/api/projects')).status,401);
 assert.equal((await fetch(url+'/api/projects',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403);
 const res=await fetch(url+'/api/projects',{method:'POST',headers:{...token,'content-type':'application/json',origin:url},body:JSON.stringify({name:'Test',managed:true,confirm:true})});assert.equal(res.status,201);
 assert.equal((await fetch(url+'/api/projects/00000000-0000-4000-8000-000000000000/board',{headers:token})).status,404);
 assert.equal((await fetch(url+'/api/browse?path=/etc',{headers:token})).status,400);
 }finally{await app.close();}
});
test('document routes enforce authentication, origin, containment and revisions',async()=>{
 const security=localConfig('http://127.0.0.1:0'),app=await createApp({dataRoot:await mkdtemp(join(tmpdir(),'dashboard-docs-api-')),browseRoots:[],security});
 await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));security.origin='http://127.0.0.1:'+(app.server.address() as any).port;
 try{
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const project=await (await fetch(url+'/api/projects',{method:'POST',headers:writes,body:JSON.stringify({name:'Docs',managed:true,confirm:true})})).json();
 const base=url+'/api/projects/'+project.id+'/docs';
 assert.equal((await fetch(base)).status,401);
 assert.equal((await fetch(base+'/document',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403);
 const saved=await fetch(base+'/document',{method:'POST',headers:writes,body:JSON.stringify({path:'docs/spec/product.md',text:'# Product\\n\\nIntent.\\n'})});
 assert.equal(saved.status,201);const snapshot=await saved.json();assert.equal(snapshot.kind,'spec');
 const listed=await (await fetch(base,{headers:token})).json();assert.deepEqual(listed.documents.map((d:any)=>d.path),['docs/spec/product.md']);
 const read=await (await fetch(base+'/document?path='+encodeURIComponent('docs/spec/product.md'),{headers:token})).json();assert.equal(read.revision,snapshot.revision);
 const conflict=await fetch(base+'/document',{method:'POST',headers:writes,body:JSON.stringify({path:'docs/spec/product.md',text:'# Rewritten\\n',revision:'0'.repeat(64)})});
 assert.equal(conflict.status,409);
 assert.equal((await fetch(base+'/document?path='+encodeURIComponent('../outside.md'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/document?path='+encodeURIComponent('notes.txt'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/document?path='+encodeURIComponent('docs/dashboard/board.md'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/document',{method:'POST',headers:writes,body:JSON.stringify({path:'docs/spec/other.md',text:'x'.repeat(3*1024*1024)})})).status,400);
 assert.equal((await fetch(url+'/api/projects/'+randomUUID()+'/docs',{headers:token})).status,404);
 const search=await (await fetch(base+'/search?q='+encodeURIComponent('Intent'),{headers:token})).json();
 assert.equal(search.matches[0].path,'docs/spec/product.md');
 assert.equal((await fetch(base+'/search?q=x',{headers:token})).status,400);
 const opened=await fetch(base+'/document',{method:'POST',headers:writes,body:JSON.stringify({path:'docs/spec/open.md',text:'# Open\n\n## Open questions\n\n- [ ] Which provider?\n'})});
 assert.equal(opened.status,201);
 const inbox=await (await fetch(base+'/inbox',{headers:token})).json();
 assert.deepEqual(inbox.questions.map((q:any)=>q.text),['Which provider?']);
 assert.equal(inbox.questions[0].path,'docs/spec/open.md');
 assert.equal((await fetch(url+'/api/projects/'+randomUUID()+'/docs/inbox',{headers:token})).status,404);
 const projectPath=(await (await fetch(url+'/api/projects',{headers:token})).json())[0].path as string;
 const png=Buffer.from('89504e470d0a1a0a','hex');
 await writeFile(join(projectPath,'docs','pixel.png'),png);
 const pixel=await fetch(base+'/asset?path='+encodeURIComponent('docs/pixel.png'),{headers:token});
 assert.equal(pixel.status,200);assert.equal(pixel.headers.get('content-type'),'image/png');assert.equal(pixel.headers.get('x-content-type-options'),'nosniff');
 assert.deepEqual(Buffer.from(await pixel.arrayBuffer()),png);
 await writeFile(join(projectPath,'docs','mockup.html'),'<p>Static</p>');
 const mockup=await fetch(base+'/asset?path='+encodeURIComponent('docs/mockup.html'),{headers:token});
 assert.equal(mockup.status,200);assert.match(mockup.headers.get('content-security-policy')??'',/sandbox/);
 assert.equal((await fetch(base+'/asset?path='+encodeURIComponent('docs/spec/product.md'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/asset?path='+encodeURIComponent('../outside.png'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/asset',{headers:token})).status,400);
 }finally{await app.close();}
});
