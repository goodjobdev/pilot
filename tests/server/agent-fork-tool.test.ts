import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fauxAssistantMessage,fauxProvider,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {HarnessHost} from '../../src/server/agents/harness-host';
import {ProviderStore} from '../../src/server/providers';
import type {AgentScope} from '../../src/shared/agent-registry';

test('fork tools use the calling session and recheck agent and project scope',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-agent-fork-')),projectId=randomUUID(),path=join(root,'project');await mkdir(path);
 const project={id:projectId,name:'Fixture',path,managed:true,repository:'',created:''};
 const fake=fauxProvider({provider:'fork-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);
 await providers.savePreferences({defaultModel:{provider:'fork-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
 let scopes:readonly AgentScope[]=['fork'],projects:string[]=[projectId];const calls:{projectId:string;parentSessionId:string}[]=[];
 const host=new HarnessHost({dataRoot:root,enabled:true,providers,privileges:{authority:async()=>({agentId:'agent-fixture',model:null,scopes,projects,emptyReason:null})},forkTools:{context:async()=>[{id:'1'}],create:async input=>{calls.push(input);return {created:true,fork:{childSessionId:'child',state:'paused'}};},dispatch:async()=>({requestId:'fork:child:fixture'})}});
 t.after(async()=>{await host.close();await providers.close();await rm(root,{recursive:true,force:true});});
 const run=async(text:string)=>{fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('fork_create',{baseCommit:'a'.repeat(40),cutoffEntryId:1})],{stopReason:'toolUse'}),()=>fauxAssistantMessage(text)]);await host.submit(project,{text:'perform fork attempt',mode:'followUp'});const end=Date.now()+10000;while(!(await host.view(project)).entries.some(e=>e.text===text)){if(Date.now()>end)throw Error('run did not finish');await new Promise(r=>setTimeout(r,20));}};
 await run('first finished');assert.deepEqual(calls,[{projectId,parentSessionId:'1',baseCommit:'a'.repeat(40),cutoffEntryId:1}]);
 scopes=[];await run('revoked finished');assert.equal(calls.length,1);
 scopes=['fork'];projects=[];await run('outside finished');assert.equal(calls.length,1);
});

test('a fork state change after a model response blocks the pending tool and the next provider request',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-fork-boundary-')),projectId=randomUUID(),path=join(root,'project');await mkdir(path);
 const project={id:projectId,name:'Fixture',path,managed:true,repository:'',created:''};
 const fake=fauxProvider({provider:'fork-boundary-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);
 await providers.savePreferences({defaultModel:{provider:'fork-boundary-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
 let closed=false,produced=false,creates=0,requests=0;
 const host=new HarnessHost({dataRoot:root,enabled:true,providers,sessionGate:()=>{if(closed)throw Error('fork no longer active');},privileges:{authority:async()=>({agentId:'agent-fixture',model:null,scopes:['fork'],projects:[projectId],emptyReason:null})},forkTools:{context:async()=>[],create:async()=>{creates++;return {created:true,fork:{childSessionId:'child',state:'paused'}};},dispatch:async()=>({requestId:'fork:child:fixture'})}});
 t.after(async()=>{await host.close();await providers.close();await rm(root,{recursive:true,force:true});});
 fake.setResponses([()=>{requests++;produced=true;closed=true;return fauxAssistantMessage([fauxToolCall('fork_create',{baseCommit:'a'.repeat(40),cutoffEntryId:1})],{stopReason:'toolUse'});},()=>{requests++;return fauxAssistantMessage('unexpected');}]);
 await host.submit(project,{text:'attempt fork',mode:'followUp'});
 const end=Date.now()+10000;
 while(!produced||(await host.view(project)).working){if(Date.now()>end)throw Error('run did not settle');await new Promise(r=>setTimeout(r,20));}
 assert.equal(creates,0);assert.equal(requests,1);
});

test('fork_dispatch carries the calling session, the given invocation identity and the fork scope',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-agent-fork-dispatch-')),projectId=randomUUID(),path=join(root,'project');await mkdir(path);
 const project={id:projectId,name:'Fixture',path,managed:true,repository:'',created:''};
 const fake=fauxProvider({provider:'fork-dispatch-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);
 await providers.savePreferences({defaultModel:{provider:'fork-dispatch-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
 let scopes:readonly AgentScope[]=['fork'],projects:string[]=[projectId];
 const sent:{projectId:string;childSessionId:string;invocationId:string;text:string}[]=[];
 const host=new HarnessHost({dataRoot:root,enabled:true,providers,privileges:{authority:async()=>({agentId:'agent-fixture',model:null,scopes,projects,emptyReason:null})},forkTools:{context:async()=>[],create:async()=>({created:true,fork:{childSessionId:'child',state:'paused'}}),dispatch:async input=>{sent.push(input);return {requestId:'fork:child:'+input.invocationId};}}});
 t.after(async()=>{await host.close();await providers.close();await rm(root,{recursive:true,force:true});});
 const run=async(text:string)=>{fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('fork_dispatch',{childSessionId:'child',invocationId:'inv-1',text:'do the child work'})],{stopReason:'toolUse'}),()=>fauxAssistantMessage(text)]);await host.submit(project,{text:'dispatch once',mode:'followUp'});const end=Date.now()+10000;while(!(await host.view(project)).entries.some(e=>e.text===text)){if(Date.now()>end)throw Error('run did not finish');await new Promise(r=>setTimeout(r,20));}};
 await run('granted finished');
 assert.deepEqual(sent,[{projectId,parentSessionId:'1',childSessionId:'child',invocationId:'inv-1',text:'do the child work'}],'the port received the calling session, project and model-supplied invocation identity');
 scopes=[];await run('revoked finished');
 assert.equal(sent.length,1,'a revoked fork scope never reaches the dispatch port');
 scopes=['fork'];projects=[];await run('outside finished');
 assert.equal(sent.length,1,'a project outside the grant never reaches the dispatch port');
});
