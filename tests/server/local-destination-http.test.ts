import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';

/** The owner-only configuration route for the two local release destinations. */
test('owner configures an exact local deploy target and publication root, with durable revision checks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-local-destination-http-'));
 await mkdir(join(root,'www','site'),{recursive:true});
 await mkdir(join(root,'outside'),{recursive:true});
 let control:ControlStore|undefined,app:Awaited<ReturnType<typeof createApp>>|undefined;
 try{
  const start=async(options:{deploy?:{enabled?:boolean};publish?:{enabled?:boolean}}={})=>{
   const security=localConfig('http://127.0.0.1:0');control=new ControlStore(root);
   app=await createApp({dataRoot:root,browseRoots:[join(root,'www')],security,control,...options});
   await new Promise<void>(resolve=>app!.server.listen(0,'127.0.0.1',resolve));
   security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
   const auth={'x-dashboard-token':security.token},writes={...auth,origin:security.origin,'content-type':'application/json'};
   const call=(path:string,body?:unknown)=>fetch(security.origin+'/api'+path,body===undefined?{headers:auth}:{method:'POST',headers:writes,body:JSON.stringify(body)});
   return {security,auth,writes,call};
  };
  let client=await start();
  const project=await (await client.call('/projects',{name:'Local release',managed:true,confirm:true})).json() as {id:string};
  const deployPath='/projects/'+project.id+'/action-destinations/deploy',publishPath='/projects/'+project.id+'/action-destinations/publish';

  // Owner authentication, origin/CSRF and strict shapes are the same as every other write route.
  assert.equal((await fetch(client.security.origin+'/api'+deployPath)).status,401);
  assert.equal((await fetch(client.security.origin+'/api'+deployPath,{method:'POST',headers:{...client.writes,origin:'https://evil.invalid'},body:JSON.stringify({revision:0,enabled:true,artifactPath:'dist',targetDirectory:join(root,'www','site')})})).status,403);
  for(const extra of [{command:'rm -rf /'},{actor:{kind:'agent',identity:'agent'}},{directory:'/tmp/elsewhere'}]){
   assert.equal((await client.call(deployPath,{revision:0,enabled:true,artifactPath:'dist',targetDirectory:join(root,'www','site'),...extra})).status,422);
  }

  const before=await (await client.call(deployPath)).json() as {destination:unknown;available:boolean;reason:string};
  assert.equal(before.destination,null);assert.equal(before.available,false);assert.match(before.reason,/DASHBOARD_DEPLOY=on/);

  // A target that is not an existing real directory under the configured browse roots is refused.
  assert.equal((await client.call(deployPath,{revision:0,enabled:true,artifactPath:'dist',targetDirectory:join(root,'outside','site')})).status,422);
  assert.equal((await client.call(deployPath,{revision:0,enabled:true,artifactPath:'../escape',targetDirectory:join(root,'www','site')})).status,422);

  const saved=await client.call(deployPath,{revision:0,enabled:true,artifactPath:'dist',targetDirectory:join(root,'www','site')});
  assert.equal(saved.status,200);
  const first=await saved.json() as {destination:{revision:number;enabled:boolean;definition:{kind:string;artifactPath:string;targetDirectory:string};updatedBy:string};available:boolean;reason:string};
  assert.equal(first.available,false);assert.match(first.reason,/not installed/);
  assert.equal(first.destination.updatedBy,'local');assert.equal(first.destination.revision,1);assert.equal(first.destination.enabled,true);
  assert.deepEqual(first.destination.definition,{kind:'deploy-local',artifactPath:'dist',targetDirectory:await realpath(join(root,'www','site'))});
  assert.equal((await client.call(deployPath,{revision:0,enabled:false,artifactPath:'dist',targetDirectory:join(root,'www','site')})).status,409);
  const results=await Promise.all([client.call(deployPath,{revision:1,enabled:false,artifactPath:'dist',targetDirectory:join(root,'www','site')}),client.call(deployPath,{revision:1,enabled:true,artifactPath:'dist',targetDirectory:join(root,'www','site')})]);
  assert.deepEqual(results.map(response=>response.status).sort(),[200,409]);

  // The publication root is configured by the same route with its own exact shape.
  const publish=await client.call(publishPath,{revision:0,enabled:true,publicationRoot:join(root,'www','site')});
  assert.equal(publish.status,200);
  const publishBody=await publish.json() as {destination:{revision:number;definition:{kind:string;publicationRoot:string}};available:boolean};
  assert.equal(publishBody.available,false);assert.equal(publishBody.destination.revision,1);
  assert.deepEqual(publishBody.destination.definition,{kind:'publish-local',publicationRoot:await realpath(join(root,'www','site'))});

  await app!.close();control!.close();app=undefined;control=undefined;

  // A reopened process reads the same durable revisions; the switches still decide availability.
  client=await start({deploy:{enabled:true},publish:{enabled:true}});
  const reopened=await (await client.call(deployPath)).json() as {destination:{revision:number};available:boolean;reason:string|null};
  assert.equal(reopened.destination.revision,2);assert.equal(reopened.available,true);assert.equal(reopened.reason,null);
  const reopenedPublish=await (await client.call(publishPath)).json() as {destination:{revision:number};available:boolean};
  assert.equal(reopenedPublish.destination.revision,1);assert.equal(reopenedPublish.available,true);
 }finally{if(app)await app.close();control?.close();await rm(root,{recursive:true,force:true});}
});
