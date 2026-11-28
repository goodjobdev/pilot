import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {ProviderStore} from '../../src/server/providers';
import {HarnessHost} from '../../src/server/agents/harness-host';

test('uncheckable Codex model is refused before generation, even if credential checking succeeds',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-codex-cap-')),provider=openaiCodexProvider(),providers=new ProviderStore(root,[provider]);let authChecks=0;
 const model=provider.getModels()[0];assert.ok(model);providers.assertUsable=async()=>{authChecks++;};
 const host=new HarnessHost({dataRoot:root,enabled:true,providers});const project={id:randomUUID(),name:'fixture',path:root,managed:true,repository:'',created:''};
 try{
  await providers.savePreferences({defaultModel:{provider:provider.id,modelId:model.id},favourites:[],allowRealModels:true});
  await host.submit(project,{text:'codex bound check',mode:'followUp'});const until=Date.now()+10000;
  for(;;){const view=await host.view(project);if(!view.working&&view.entries.some(entry=>entry.text.includes('cannot verify the configured output-token bound')))break;
   if(Date.now()>until)throw Error('expected transport refusal');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(authChecks,1,'submission credential preflight can run before generation refusal');
 }finally{await host.close();await providers.close();await rm(root,{recursive:true,force:true});}
});

for(const cap of [1,32])test('harness validates OpenAI payload and avoids retries at cap '+cap,async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-cap-host-')),actual=openaiProvider();let hooks=0,fetches=0;
 const provider={...actual,streamSimple:((model,context,options)=>actual.streamSimple(model,context,{...options,
  fetch:async()=>{fetches++;return new Response('{"error":{"message":"stubbed rate limit"}}',{status:429,headers:{'content-type':'application/json'}});},
  onPayload:async(payload,active)=>{hooks++;return options?.onPayload?.(payload,active);}
 })) as typeof actual.streamSimple};
 const providers=new ProviderStore(root,[provider]);
 const host=new HarnessHost({dataRoot:root,enabled:true,providers,agentRequestBudget:async()=>({maxOutputTokens:cap,check:()=>{}})});
 const project={id:randomUUID(),name:'fixture',path:root,managed:true,repository:'',created:''};
 try{
  await providers.saveKey('openai',{key:'sk-fixture-not-a-key'});
  await providers.savePreferences({defaultModel:{provider:'openai',modelId:'gpt-4.1-mini'},favourites:[],allowRealModels:true});
  await host.submit(project,{text:'check cap',mode:'followUp'});
  const until=Date.now()+10000;
  while(hooks===0||(await host.view(project)).working){if(Date.now()>until)throw Error('provider request did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(hooks,1);assert.equal(fetches,cap===1?0:1);
 }finally{await host.close();await providers.close();await rm(root,{recursive:true,force:true});}
});
