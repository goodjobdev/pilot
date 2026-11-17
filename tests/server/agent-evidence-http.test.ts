import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxAssistantMessage,fauxProvider,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {createApp} from '../../src/server/main';
import {localConfig} from '../../src/server/security';
import {ControlStore} from '../../src/server/state/control-store';

const claim={artifact:{revision:'a'.repeat(64),commit:null},commands:['node --test'],diff:{files:1,linesAdded:1,linesRemoved:0,text:'+change',reference:null},tests:[{command:'node --test',outcome:'passed',output:'# tests 1\n# pass 1\n# fail 0\n# skipped 0',counts:{passed:1,failed:0,skipped:0}}]};

test('agent evidence recording is absent by default and requires the real deployment opt-in',async()=>{
 for(const {enabled,scope,forged} of [{enabled:false,scope:'accept',forged:false},{enabled:true,scope:'accept',forged:false},{enabled:true,scope:'read_notes',forged:false},{enabled:true,scope:'accept',forged:true}] as const){
  const root=await mkdtemp(join(tmpdir(),'pilot-evidence-http-')),security=localConfig('http://127.0.0.1:0'),control=new ControlStore(root);
  const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control,agentPauseMs:0,...(enabled?{agentEvidenceRecording:true}:{})});
  try{
   await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
   const auth={'x-dashboard-token':security.token},writes={...auth,origin:security.origin,'content-type':'application/json'};
   const get=(path:string)=>fetch(security.origin+'/api'+path,{headers:auth});
   const post=(path:string,body:unknown)=>fetch(security.origin+'/api'+path,{method:'POST',headers:writes,body:JSON.stringify(body)});
   assert.equal((await (await get('/acceptance/policy')).json()).agentEvidenceRecording,enabled);
   const project=await (await post('/projects',{name:'Evidence fixture',managed:true,confirm:true})).json() as {id:string};
   const fake=fauxProvider({provider:'evidence-http-faux',models:[{id:'fixture'}]});app.providers.models.setProvider(fake.provider);
   await app.providers.savePreferences({defaultModel:{provider:'evidence-http-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
   const actor={kind:'owner' as const,identity:'local'};
   const response=await post('/agents',{actor,draft:{name:'Evidence agent',description:'',enabled:true,model:{provider:'evidence-http-faux',modelId:'fixture'},workspace:{scope:{kind:'projects',projectIds:[project.id]},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:[scope]}});
   assert.equal(response.status,201,await response.clone().text());const agent=await response.json() as {agent:{id:string}};
   const base='/projects/'+project.id+'/agents',view=await (await get(base)).json() as {view:{conversationId:string}};
   assert.equal((await post('/sessions/'+view.view.conversationId+'/agent',{projectId:project.id,revision:0,agentId:agent.agent.id,actor})).status,200);
   fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('acceptance_record',forged?{...claim,sessionId:'other-session'}:claim)],{stopReason:'toolUse'}),()=>fauxAssistantMessage('Evidence attempt finished.')]);
   assert.equal((await post(base+'/input',{text:'Record fixture evidence',mode:'followUp'})).status,200);
   const end=Date.now()+10000;
   for(;;){const current=await (await get(base)).json() as {view:{working:boolean;entries:{text:string}[]}};if(!current.view.working&&current.view.entries.some(entry=>entry.text.includes('Evidence attempt finished.')))break;if(Date.now()>end)throw Error('Faux evidence attempt did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
   const records=await (await get('/acceptance?projectId='+project.id)).json() as {evidence:{record:{sessionId:string};acceptance:unknown}[]};
   const allowed=enabled&&scope==='accept'&&!forged;
   assert.equal(records.evidence.length,allowed?1:0,'deployment, scope and input validation must all permit recording');
   if(allowed){assert.equal(records.evidence[0].record.sessionId,view.view.conversationId);assert.equal(records.evidence[0].acceptance,null);}
  }finally{await app.close();control.close();await rm(root,{recursive:true,force:true});}
 }
});
