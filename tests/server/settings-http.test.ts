import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../src/server/main';
import {localConfig} from '../../src/server/security';

test('settings and project-key routes enforce owner auth, origin and secret-free reads',async()=>{
 const security=localConfig('http://127.0.0.1:0'),directory=await mkdtemp(join(tmpdir(),'pilot-settings-api-'));
 const app=await createApp({dataRoot:directory,browseRoots:[],security});
 await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));security.origin='http://127.0.0.1:'+(app.server.address() as any).port;
 const base=security.origin,token={'x-dashboard-token':security.token},headers={...token,origin:base,'content-type':'application/json'};
 const post=(path:string,body:unknown,h=headers)=>fetch(base+'/api'+path,{method:'POST',headers:h,body:JSON.stringify(body)});
 try{
  assert.equal((await fetch(base+'/api/settings/providers')).status,401);
  assert.equal((await post('/settings/providers/openai/key',{key:'fake-api-key'}, {...headers,origin:'https://evil.example'})).status,403);
  assert.equal((await post('/settings/providers/openai/key',{key:'fake-api-key'})).status,200);
  const settings=await (await fetch(base+'/api/settings/providers',{headers:token})).json();
  assert.equal(JSON.stringify(settings).includes('fake-api-key'),false);assert.equal(settings.preferences.allowRealModels,false);
  const p=await (await post('/projects',{name:'Repository fixture',repository:'https://github.com/example/disposable.git',managed:true,confirm:true})).json();
  const path='/projects/'+p.id+'/repository';
  assert.equal((await fetch(base+'/api'+path)).status,401);
  assert.equal((await post(path+'/key',{}, {...headers,origin:'https://evil.example'})).status,403);
  const key=await (await post(path+'/key',{})).json();assert.match(key.publicKey,/^ssh-ed25519 /);
  assert.equal(JSON.stringify(key).includes('PRIVATE KEY'),false);
  assert.equal((await post(path+'/connect',{})).status,422,'connection requires separate explicit confirmation');
  assert.equal((await fetch(base+'/api/projects/'+p.id+'/docs/document?path='+encodeURIComponent('../../credentials/providers.json'),{headers:token})).status,400);
  assert.equal((await post('/settings/models',{...settings.preferences,defaultModel:{provider:'openai',modelId:'invalid'}})).status,422);
  const deleted=await fetch(base+'/api'+path+'/key',{method:'DELETE',headers,body:'{}'});assert.equal(deleted.status,200);
  assert.equal((await deleted.json()).publicKey,null);
 }finally{await app.close();}
});
