import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { ReusableToolStore } from '../../src/server/state/reusable-tools';

test('production application wiring requires opt-in and bound scope to define and invoke a projection',async()=>{
 for(const [enabled,scope] of [[false,'reusable_tools'],[true,'read_notes'],[true,'reusable_tools']] as const){
  const root=await mkdtemp(join(tmpdir(),'pilot-reusable-http-')),security=localConfig('http://127.0.0.1:0'),control=new ControlStore(root);
  const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control,agentPauseMs:0,reusableTools:enabled});
  try{
   await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
   const auth={'x-dashboard-token':security.token},writes={...auth,origin:security.origin,'content-type':'application/json'};
   const get=(path:string)=>fetch(security.origin+'/api'+path,{headers:auth});
   const post=(path:string,body:unknown)=>fetch(security.origin+'/api'+path,{method:'POST',headers:writes,body:JSON.stringify(body)});
   const project=await (await post('/projects',{name:'Projection fixture',managed:true,confirm:true})).json() as {id:string};
   const fake=fauxProvider({provider:'reusable-http-faux',models:[{id:'fixture'}]});app.providers.models.setProvider(fake.provider);
   await app.providers.savePreferences({defaultModel:{provider:'reusable-http-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
   const actor={kind:'owner' as const,identity:'local'};
   const response=await post('/agents',{actor,draft:{name:'Projection agent',description:'',enabled:true,model:{provider:'reusable-http-faux',modelId:'fixture'},workspace:{scope:{kind:'projects',projectIds:[project.id]},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:[scope]}});
   assert.equal(response.status,201,await response.clone().text());const agent=(await response.json() as {agent:{id:string}}).agent;
   const vocabulary=await (await get('/agents')).json() as {scopes:{scope:string;installed:boolean}[]};
   assert.equal(vocabulary.scopes.find(x=>x.scope==='reusable_tools')?.installed,enabled);
   const base='/projects/'+project.id+'/agents',view=await (await get(base)).json() as {view:{conversationId:string}};
   assert.equal((await post('/sessions/'+view.view.conversationId+'/agent',{projectId:project.id,revision:0,agentId:agent.id,actor})).status,200);
   fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('reusable_define',{name:'pick',revision:0,fields:['name']})],{stopReason:'toolUse'}),()=>fauxAssistantMessage([fauxToolCall('reusable_invoke',{name:'pick',json:'{"name":"Visible","other":"omitted"}'})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('Projection attempt finished.')]);
   assert.equal((await post(base+'/input',{text:'Create and invoke projection',mode:'followUp'})).status,200);
   let current:{view:{working:boolean;entries:{kind:string;text:string}[]}};const end=Date.now()+10000;
   for(;;){current=await (await get(base)).json() as typeof current;if(!current.view.working&&current.view.entries.some(entry=>entry.text.includes('Projection attempt finished.')))break;if(Date.now()>end)throw Error('Projection attempt did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
   const definitions=new ReusableToolStore(control).list(project.id,agent.id),allowed=enabled&&scope==='reusable_tools';
   assert.equal(definitions.length,allowed?1:0);
   const outputs=current.view.entries.filter(entry=>entry.kind==='tool').map(entry=>entry.text).join('\n');
   if(allowed){assert.equal(definitions[0].revision,1);assert.match(outputs,/Visible/);assert.doesNotMatch(outputs,/omitted/);}
   else assert.doesNotMatch(outputs,/\\"Visible\\"/);
  }finally{await app.close();control.close();await rm(root,{recursive:true,force:true});}
 }
});
