import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderStore,FileCredentials} from '../../src/server/providers';
import {HarnessHost} from '../../src/server/agents/harness-host';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import type {Provider} from '@earendil-works/pi-ai';
import type {Project} from '../../src/shared/model';
import {randomUUID} from 'node:crypto';
const root=()=>mkdtemp(join(tmpdir(),'pilot-providers-'));
async function eventually(check:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await check())return;await new Promise(ok=>setTimeout(ok,25));}throw Error('Timed out');}

test('provider keys are private, persist across restart, and defaults/favourites are validated and sorted',async()=>{
 const directory=await root(),store=new ProviderStore(directory);
 try{
  assert.equal((await store.view()).preferences.allowRealModels,false);
  await store.saveKey('openai',{key:'test-not-a-real-key'});
  const view=await store.view(),models=view.models.filter(m=>m.provider==='openai');
  const favourite=models.at(-1)!;
  await store.savePreferences({allowRealModels:false,defaultModel:{provider:favourite.provider,modelId:favourite.modelId},favourites:[{provider:favourite.provider,modelId:favourite.modelId}]});
  const reread=new ProviderStore(directory),settings=await reread.view();
  assert.equal(settings.models[0].modelId,favourite.modelId);
  assert.equal(settings.providers.find(p=>p.id==='openai')?.configured,true);
  assert.equal(JSON.stringify(settings).includes('test-not-a-real-key'),false);
  assert.equal((await stat(join(directory,'credentials/providers.json'))).mode&0o777,0o600);
  assert.equal((await stat(join(directory,'credentials'))).mode&0o777,0o700);
  await assert.rejects(()=>store.savePreferences({allowRealModels:false,defaultModel:{provider:'openai',modelId:'does-not-exist'},favourites:[]}),/Unknown model/);
  await assert.rejects(()=>store.saveKey('openai-codex',{key:'not-a-key'}),/requires sign-in/);
  await assert.rejects(()=>store.assertUsable(favourite),/Enable real model calls/);
  await store.logout('openai');
  assert.equal((await store.view()).providers.find(p=>p.id==='openai')?.configured,false);
  assert.equal((await readFile(join(directory,'credentials/providers.json'),'utf8')).includes('test-not-a-real-key'),false);
  await reread.close();
 }finally{await store.close();}
});

test('credential refresh/update and logout serialize without lost updates',async()=>{
 const credentials=new FileCredentials(await root());
 try{
  await credentials.modify('openai',async()=>({type:'oauth',access:'fake-access',refresh:'fake-refresh',expires:1,count:0}));
  await Promise.all(Array.from({length:10},()=>credentials.modify('openai',async current=>{
   if(current?.type!=='oauth')throw Error('missing');await new Promise(ok=>setTimeout(ok,2));
   return {...current,count:Number(current.count)+1};
  })));
  assert.equal((await credentials.read('openai') as any).count,10);
  await Promise.all([credentials.modify('openai',async current=>{await new Promise(ok=>setTimeout(ok,5));return current;}),credentials.delete('openai')]);
  assert.equal(await credentials.read('openai'),undefined);
 }finally{await credentials.close();}
});

test('Models refresh is serialized and preserves rotated OAuth credentials',async()=>{
 const directory=await root(),fake=fauxProvider({provider:'openai'});let refreshes=0;
 const provider:Provider={...fake.provider,auth:{oauth:{
  name:'Refresh test',login:async()=>({type:'oauth',access:'initial',refresh:'initial-refresh',expires:1}),
  refresh:async credential=>{refreshes++;await new Promise(ok=>setTimeout(ok,10));return {...credential,access:'rotated-access',refresh:'rotated-refresh',expires:Date.now()+3600000};},
  toAuth:async credential=>({apiKey:credential.access})
 }}};
 const store=new ProviderStore(directory,[provider]);
 try{
  await store.credentials.modify('openai',async()=>({type:'oauth',access:'initial',refresh:'initial-refresh',expires:1}));
  const auth=await Promise.all(Array.from({length:5},()=>store.models.getAuth('openai')));
  assert.equal(refreshes,1);assert.ok(auth.every(v=>v?.auth.apiKey==='rotated-access'));
  assert.equal((await store.credentials.read('openai') as any).refresh,'rotated-refresh');
 }finally{await store.close();}
});

test('UI-driven login prompts are one-use, cancellable, and never return stored tokens',async()=>{
 const faux=fauxProvider({provider:'openai'});let deviceId='';
 const provider:Provider={...faux.provider,auth:{oauth:{
  name:'Test sign-in',login:async(interaction,options)=>{
   deviceId=options!.getDeviceId!();
   const method=await interaction.prompt({type:'select',message:'Login method',options:[{id:'device_code',label:'Device code'}]});
   assert.equal(method,'device_code');interaction.notify({type:'device_code',userCode:'TEST-ONLY',verificationUri:'https://example.com/device'});
   const code=await interaction.prompt({type:'manual_code',message:'Test callback'});
   assert.equal(code,'test-callback');
   return {type:'oauth',access:'secret-fake-access',refresh:'secret-fake-refresh',expires:Date.now()+60000};
  },refresh:async credential=>credential,toAuth:async credential=>({apiKey:credential.access})
 }}};
 const directory=await root(),store=new ProviderStore(directory,[provider]);
 try{
  let login=await store.startLogin('openai');
  await eventually(async()=>Boolean(store.login(login.id).prompt));
  login=store.login(login.id);const first=login.prompt!.id;
  assert.throws(()=>store.reply(login.id,{promptId:first,answer:'invalid-choice'}),/listed login method/);
  store.reply(login.id,{promptId:first,answer:'device_code'});
  assert.throws(()=>store.reply(login.id,{promptId:first,answer:'device_code'}),/prompt has changed/);
  await eventually(async()=>store.login(login.id).prompt?.id!==first);
  login=store.login(login.id);assert.equal(login.userCode,'TEST-ONLY');
  store.reply(login.id,{promptId:login.prompt!.id,answer:'test-callback'});
  await eventually(async()=>store.login(login.id).status==='done');
  const result=store.login(login.id);
  assert.equal(result.prompt,undefined);assert.equal(result.url,undefined);assert.equal(result.userCode,undefined);
  assert.equal(JSON.stringify(await store.view()).includes('secret-fake'),false);
  assert.match(deviceId,/^[a-f0-9-]{36}$/);
  const installation=JSON.parse(await readFile(join(directory,'settings/installation.json'),'utf8'));assert.equal(installation.id,deviceId);
  const again=await store.startLogin('openai');await store.cancel(again.id);
  assert.equal(store.login(again.id).status,'cancelled');
 }finally{await store.close();}
});

test('real-model selection drives the harness with explicit opt-in, persists, and never falls back to faux',async()=>{
 const directory=await root(),fake=fauxProvider({provider:'test-real',models:[{id:'test-model'}]});
 fake.setResponses([(_context,options)=>{assert.equal(options?.maxTokens,4096);return fauxAssistantMessage('Selected provider reply');}]);
 const store=new ProviderStore(directory,[fake.provider]),host=new HarnessHost({dataRoot:directory,enabled:true,providers:store});
 const project:Project={id:randomUUID(),name:'Disposable',managed:true,path:directory,repository:'',created:new Date().toISOString()};
 try{
  await store.savePreferences({defaultModel:{provider:'test-real',modelId:'test-model'},favourites:[],allowRealModels:false});
  assert.equal((await host.view(project)).model?.provider,'test-real');
  await assert.rejects(()=>host.submit(project,{text:'no permission',mode:'followUp'}),/Enable real model calls/);
  assert.equal(fake.state.callCount,0);
  await store.savePreferences({defaultModel:{provider:'test-real',modelId:'test-model'},favourites:[],allowRealModels:true});
  await host.submit(project,{text:'explicit test input',mode:'followUp'});
  await eventually(async()=>!(await host.view(project)).working&&(await host.view(project)).entries.some(e=>e.text==='Selected provider reply'));
  assert.equal(fake.state.callCount,1);
  await host.close();
  const reopened=new HarnessHost({dataRoot:directory,enabled:true,providers:store});
  assert.equal((await reopened.view(project)).model?.provider,'test-real');
  await reopened.setModel(project,null);
  assert.equal((await reopened.view(project)).model?.provider,'faux');
  await reopened.close();
 }finally{await host.close();await store.close();}
});

test('model policy stops a tool loop at eight requests',async()=>{
 const directory=await root(),fake=fauxProvider({provider:'test-real',models:[{id:'loop'}]});
 fake.setResponses(Array.from({length:12},()=>()=>fauxAssistantMessage([fauxToolCall('read_notes',{})],{stopReason:'toolUse'})));
 const store=new ProviderStore(directory,[fake.provider]),host=new HarnessHost({dataRoot:directory,enabled:true,providers:store});
 const project:Project={id:randomUUID(),name:'Loop',managed:true,path:directory,repository:'',created:new Date().toISOString()};
 try{
  await store.savePreferences({defaultModel:{provider:'test-real',modelId:'loop'},favourites:[],allowRealModels:true});
  await host.submit(project,{text:'bounded loop',mode:'followUp'});
  await eventually(async()=>fake.state.callCount>=8&&!(await host.view(project)).working);
  assert.equal(fake.state.callCount,8);
 }finally{await host.close();await store.close();}
});
