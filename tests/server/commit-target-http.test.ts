import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';

test('owner configures only the fixed inactive commit target, with durable revision checks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-commit-target-http-'));
 let control:ControlStore|undefined,app:Awaited<ReturnType<typeof createApp>>|undefined;
 try{
  const start=async()=>{
   const security=localConfig('http://127.0.0.1:0');control=new ControlStore(root);
   app=await createApp({dataRoot:root,browseRoots:[],security,control});
   await new Promise<void>(resolve=>app!.server.listen(0,'127.0.0.1',resolve));
   security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
   const auth={'x-dashboard-token':security.token},writes={...auth,origin:security.origin,'content-type':'application/json'};
   const call=(path:string,body?:unknown)=>fetch(security.origin+'/api'+path,body===undefined?{headers:auth}:{method:'POST',headers:writes,body:JSON.stringify(body)});
   return {security,auth,writes,call};
  };
  let client=await start();
  const project=await (await client.call('/projects',{name:'Commit target',managed:true,confirm:true})).json() as {id:string};
  const base='/projects/'+project.id+'/action-targets/commit';
  assert.equal((await fetch(client.security.origin+'/api'+base)).status,401);
  assert.equal((await fetch(client.security.origin+'/api'+base,{method:'POST',headers:{...client.writes,origin:'https://evil.invalid'},body:JSON.stringify({revision:0,enabled:true})})).status,403);
  const before=await (await client.call(base)).json() as {target:unknown;available:boolean};
  assert.equal(before.target,null);assert.equal(before.available,false);
  for(const extra of [{branch:'refs/heads/other'},{actor:{kind:'agent',identity:'agent'}},{credential:'secret'},{command:'git push'}]){
   assert.equal((await client.call(base,{revision:0,enabled:true,...extra})).status,422);
  }
  const saved=await client.call(base,{revision:0,enabled:true});assert.equal(saved.status,200);
  const first=await saved.json() as {target:{revision:number;enabled:boolean;definition:{kind:string;repositoryId:string;branch:string};updatedBy:string};available:boolean;reason:string};
  assert.equal(first.available,false);assert.match(first.reason,/not installed/);
  assert.deepEqual(first.target.definition,{kind:'commit',repositoryId:project.id,branch:'refs/heads/work/pilot-'+project.id.slice(0,8)});
  assert.equal(first.target.updatedBy,'local');assert.equal(first.target.revision,1);
  assert.equal((await client.call(base,{revision:0,enabled:false})).status,409);
  const results=await Promise.all([client.call(base,{revision:1,enabled:false}),client.call(base,{revision:1,enabled:true})]);
  assert.deepEqual(results.map(response=>response.status).sort(),[200,409]);
  const current=await (await client.call(base)).json() as {target:{revision:number}};
  assert.equal(current.target.revision,2);
  await app!.close();control!.close();app=undefined;control=undefined;
  client=await start();
  const reopened=await (await client.call(base)).json() as {target:{revision:number};available:boolean};
  assert.equal(reopened.target.revision,2);assert.equal(reopened.available,false);
 }finally{if(app)await app.close();control?.close();await rm(root,{recursive:true,force:true});}
});
