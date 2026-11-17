import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { ReusableToolStore } from '../../src/server/state/reusable-tools';
import { AgentStore } from '../../src/server/state/agent-store';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

test('definitions are revisioned, bounded, isolated, and survive reopening', async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-reusable-')); let control=new ControlStore(root);t.after(async()=>{control.close();await rm(root,{recursive:true,force:true});});
 let tools=new ReusableToolStore(control);const base={projectId:'p',agentId:'a',name:'summary',revision:0,fields:['name','count'],guard:()=>{}};
 assert.equal(tools.write(base).revision,1);
 assert.throws(()=>tools.write(base),/conflict/i);
 assert.deepEqual(JSON.parse(tools.invoke('p','a','summary','{"name":"ok","count":2,"secret":"omit"}').json),{name:'ok',count:2});
 assert.throws(()=>tools.invoke('p','b','summary','{}'),/not found/i);
 assert.throws(()=>tools.invoke('q','a','summary','{}'),/not found/i);
 assert.throws(()=>tools.invoke('p','a','summary','[]'),/object/i);
 for(const number of ['-0','9007199254740993','-9007199254740992','1e400','1.0000000000000001','1e0','0.1'])
  assert.throws(()=>tools.invoke('p','a','summary','{\"ignored\":{\"nested\":['+number+']}}'),/safe integer/i,number);
 assert.equal(tools.invoke('p','a','summary','{\"name\":\"number 1e400 and 9007199254740993\",\"count\":9007199254740991}').json,'{\"name\":\"number 1e400 and 9007199254740993\",\"count\":9007199254740991}');
 assert.throws(()=>tools.invoke('p','a','summary','x'.repeat(8193)),/8192/);
 assert.throws(()=>tools.write({...base,name:'__proto__'}));
 assert.throws(()=>tools.write({...base,name:'bad',fields:['x','x']}));
 assert.throws(()=>tools.write({...base,name:'race',guard:()=>{throw Error('revoked');}}),/revoked/);
 assert.equal(tools.list('p','a').length,1);
 assert.equal(tools.write({...base,revision:1,fields:['count']}).revision,2);
 control.close();control=new ControlStore(root);tools=new ReusableToolStore(control);
 assert.deepEqual(tools.list('p','a').map(x=>x.revision),[2]);
 assert.equal(tools.invoke('p','a','summary','{"name":"x","count":1}').json,'{"count":1}');
});

test('model creates and invokes only with a bound scoped identity, and a transactional authority change refuses writes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-reusable-model-')),path=join(root,'project');await mkdir(path);
 const control=new ControlStore(join(root,'data')),other=new ControlStore(join(root,'data'));
 const offered=[{provider:'reusable-faux',modelId:'fixture'}],options={models:()=>offered,projectKnown:(id:string)=>id==='11111111-1111-4111-8111-111111111111'},agents=new AgentStore(control,options),competitor=new AgentStore(other,options),actor={kind:'owner' as const,identity:'owner'};
 const agent=agents.create({actor,draft:{name:'Agent',description:'',enabled:true,model:offered[0],workspace:{scope:{kind:'projects',projectIds:['11111111-1111-4111-8111-111111111111']},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:['reusable_tools']}});
 agents.bindSession({projectId:'11111111-1111-4111-8111-111111111111',sessionId:'1',revision:0,agentId:agent.id,actor});
 const store=new ReusableToolStore(control),fake=fauxProvider({provider:'reusable-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);
 await providers.savePreferences({defaultModel:offered[0],favourites:[],allowRealModels:true});
 type Identity={projectId:string;sessionId:string;agentId:string;expectedAuthority:string};
 const verify=(x:Identity)=>{const a=agents.versionedAuthorityForSession(x);if(a.agentId!==x.agentId||!a.scopes?.includes('reusable_tools')||JSON.stringify(a)!==x.expectedAuthority)throw Error('authority changed');};
 const host=new HarnessHost({dataRoot:root,enabled:true,providers,privileges:{authority:async({projectId,sessionId})=>agents.versionedAuthorityForSession({projectId,sessionId:sessionId??''})},reusableTools:{
  list:x=>{verify(x);return store.list(x.projectId,x.agentId);},
  write:x=>store.write({...x,guard:()=>{x.signal?.throwIfAborted();verify(x);}}),
  invoke:x=>{verify(x);return store.invoke(x.projectId,x.agentId,x.name,x.json);}
 }});
 t.after(async()=>{await host.close();await providers.close();other.close();control.close();await rm(root,{recursive:true,force:true});});
 const project={id:'11111111-1111-4111-8111-111111111111',name:'Fixture',path,managed:true,repository:'',created:''};
 async function run(responses:Parameters<typeof fake.setResponses>[0],end:string){fake.setResponses(responses);await host.submit(project,{text:'execute the requested tool',mode:'followUp'});const until=Date.now()+10000;while(!(await host.view(project)).entries.some(e=>e.text.includes(end))){if(Date.now()>until)throw Error('model timeout');await new Promise(r=>setTimeout(r,20));}}
 const define={name:'pick',revision:0,fields:['name']};
 const admit=control.admit.bind(control);let raced=false;
 control.admit=input=>{if(input.kind==='reusable.definition'&&!raced){raced=true;const b=competitor.bindSession({projectId:'11111111-1111-4111-8111-111111111111',sessionId:'1',revision:1,agentId:null,actor});competitor.bindSession({projectId:'11111111-1111-4111-8111-111111111111',sessionId:'1',revision:b.revision,agentId:agent.id,actor});}return admit(input);};
 await run([()=>fauxAssistantMessage([fauxToolCall('reusable_define',define)],{stopReason:'toolUse'}),()=>fauxAssistantMessage('race done')],'race done');
 assert.equal(raced,true);assert.equal(store.list('11111111-1111-4111-8111-111111111111',agent.id).length,0);control.admit=admit;
 await run([()=>fauxAssistantMessage([fauxToolCall('reusable_define',define)],{stopReason:'toolUse'}),()=>fauxAssistantMessage([fauxToolCall('reusable_invoke',{name:'pick',json:'{"name":"Ada","other":1}'})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('invoke done')],'invoke done');
 assert.equal(store.list('11111111-1111-4111-8111-111111111111',agent.id).length,1);assert.match(JSON.stringify((await host.view(project)).entries),/Ada/);
 agents.update({agentId:agent.id,revision:agent.revision,patch:{scopes:[]},actor});
 await run([()=>fauxAssistantMessage([fauxToolCall('reusable_invoke',{name:'pick',json:'{\"name\":\"Revoked\"}'})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('revocation done')],'revocation done');
 assert.doesNotMatch(JSON.stringify((await host.view(project)).entries),/\\\"Revoked\\\"/);
 agents.bindSession({projectId:'11111111-1111-4111-8111-111111111111',sessionId:'1',revision:3,agentId:null,actor});
 await run([()=>fauxAssistantMessage([fauxToolCall('reusable_define',{...define,name:'unbound'})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('unbound done')],'unbound done');
 assert.equal(store.list('11111111-1111-4111-8111-111111111111',agent.id).length,1);
});

test('unbound owner dispatch cannot use an installed reusable tool',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-reusable-owner-')),path=join(root,'project');await mkdir(path);
 const fake=fauxProvider({provider:'owner-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);
 await providers.savePreferences({defaultModel:{provider:'owner-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
 let calls=0;
 const host=new HarnessHost({dataRoot:root,enabled:true,providers,reusableTools:{list:()=>{calls++;return [];},write:()=>{calls++;return {};},invoke:()=>{calls++;return {};}}});
 t.after(async()=>{await host.close();await providers.close();await rm(root,{recursive:true,force:true});});
 const project={id:'22222222-2222-4222-8222-222222222222',name:'Fixture',path,managed:true,repository:'',created:''};
 fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('reusable_define',{name:'pick',revision:0,fields:['x']})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('owner refused')]);
 await host.submit(project,{text:'Try creating a tool',mode:'followUp'});
 const until=Date.now()+10000;while(!(await host.view(project)).entries.some(e=>e.text.includes('owner refused'))){if(Date.now()>until)throw Error('model timeout');await new Promise(r=>setTimeout(r,20));}
 assert.equal(calls,0);
 assert.match(JSON.stringify((await host.view(project)).entries),/bound agent with reusable_tools scope/);
});

test('persisted selections gain reusable tools after instance enablement and later scope grant, but revocation and unbound owner refuse effects',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-reusable-migration-')),path=join(root,'project');await mkdir(path);
 const project={id:'44444444-4444-4444-8444-444444444444',name:'Fixture',path,managed:true,repository:'',created:''};
 const control=new ControlStore(join(root,'control')),store=new ReusableToolStore(control);
 const fake=fauxProvider({provider:'migration-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);
 await providers.savePreferences({defaultModel:{provider:'migration-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
 let scopes:readonly import('../../src/shared/agent-registry').AgentScope[]|null=['reusable_tools'],agentId:string|null='agent';let writes=0;
 const privileges={authority:async()=>({agentId,model:null,scopes,projects:[project.id],emptyReason:null})};
 const port={list:(x:{projectId:string;agentId:string})=>store.list(x.projectId,x.agentId),write:(x:{projectId:string;agentId:string;name:string;revision:number;fields:string[]})=>{writes++;return store.write({...x,guard:()=>{}});},invoke:(x:{projectId:string;agentId:string;name:string;json:string})=>store.invoke(x.projectId,x.agentId,x.name,x.json)};
 const options={dataRoot:root,enabled:true,providers,privileges};let host=new HarnessHost(options);
 t.after(async()=>{await host.close();await providers.close();control.close();await rm(root,{recursive:true,force:true});});
 const opened=await (host as any).open(project);
 assert.ok(!(await opened.conversation.agent((await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT)).tools.some((x:{name:string})=>x.name==='reusable_define'));
 await host.close();host=new HarnessHost({...options,reusableTools:port});
 const reopened=await (host as any).open(project),ctx=(await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT;
 assert.ok((await reopened.conversation.agent(ctx)).tools.some((x:{name:string})=>x.name==='reusable_define'),'root migration occurs during reopen');
 const send=async(name:string,done:string)=>{fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('reusable_define',{name,revision:0,fields:['name']})],{stopReason:'toolUse'}),()=>fauxAssistantMessage(done)]);await host.submit(project,{text:'exercise projection '+name,mode:'followUp'});const end=Date.now()+10000;while(!(await host.view(project)).entries.some(e=>e.text.includes(done))){if(Date.now()>end)throw Error('migration run did not settle');await new Promise(resolve=>setTimeout(resolve,20));}};
 await send('enabled','enabled completed');assert.equal(writes,1,'reopening an existing conversation with the instance switch installs usable tools: '+JSON.stringify((await host.view(project)).entries));
 scopes=[];await send('revoked','revoked completed');assert.equal(writes,1,'a revoked scope cannot write despite persisted selection');
 scopes=['reusable_tools'];await send('regranted','regranted completed');assert.equal(writes,2,'a subsequent grant is usable');
 agentId=null;scopes=null;await send('owner','unbound completed');assert.equal(writes,2,'unbound owner dispatch never gains reusable-tool authority');
});

test('a scope first granted after conversation creation becomes selectable on the next dispatch',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-reusable-late-grant-')),path=join(root,'project');await mkdir(path);
 const project={id:'55555555-5555-4555-8555-555555555555',name:'Fixture',path,managed:true,repository:'',created:''},control=new ControlStore(join(root,'control')),store=new ReusableToolStore(control);
 const fake=fauxProvider({provider:'late-grant-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);await providers.savePreferences({defaultModel:{provider:'late-grant-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
 let scopes:readonly import('../../src/shared/agent-registry').AgentScope[]=[];let writes=0;
 const host=new HarnessHost({dataRoot:root,enabled:true,providers,privileges:{authority:async()=>({agentId:'agent',model:null,scopes,projects:[project.id],emptyReason:null})},reusableTools:{list:x=>store.list(x.projectId,x.agentId),write:x=>{writes++;return store.write({...x,guard:()=>{}});},invoke:x=>store.invoke(x.projectId,x.agentId,x.name,x.json)}});
 t.after(async()=>{await host.close();await providers.close();control.close();await rm(root,{recursive:true,force:true});});
 const opened=await (host as any).open(project),ctx=(await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT;
 assert.equal((await opened.conversation.agent(ctx)).tools.some((x:{name:string})=>x.name==='reusable_define'),false);
 scopes=['reusable_tools'];fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('reusable_define',{name:'late',revision:0,fields:['name']})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('late grant completed')]);
 await host.submit(project,{text:'use later grant',mode:'followUp'});const end=Date.now()+10000;while(!(await host.view(project)).entries.some(e=>e.text.includes('late grant completed'))){if(Date.now()>end)throw Error('late grant did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(writes,1);assert.ok((await opened.conversation.agent(ctx)).tools.some((x:{name:string})=>x.name==='reusable_define'));
});

test('startup migration installs reusable tools on an existing named conversation',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-reusable-named-')),path=join(root,'project');await mkdir(path);
 const project={id:'66666666-6666-4666-8666-666666666666',name:'Fixture',path,managed:true,repository:'',created:''},control=new ControlStore(join(root,'control')),store=new ReusableToolStore(control);
 const fake=fauxProvider({provider:'named-migration-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);await providers.savePreferences({defaultModel:{provider:'named-migration-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
 const bindings=new Map<string,number>(),conversationBinding={list:()=>[...bindings].map(([sessionId,conversationId])=>({sessionId,conversationId})),read:(_projectId:string,sessionId:string)=>{const id=bindings.get(sessionId);return id===undefined?null:{conversationId:id,revision:1};},record:({sessionId,conversationId}:{sessionId:string;conversationId:number})=>{bindings.set(sessionId,conversationId);}};
 const options={dataRoot:root,enabled:true,providers,conversationBinding,privileges:{authority:async()=>({agentId:'agent',model:null,scopes:['reusable_tools'] as const,projects:[project.id],emptyReason:null})}};
 let host=new HarnessHost(options);t.after(async()=>{await host.close();await providers.close();control.close();await rm(root,{recursive:true,force:true});});
 const id=await host.ensureSessionConversation(project,'named');await host.close();
 let writes=0;host=new HarnessHost({...options,reusableTools:{list:x=>store.list(x.projectId,x.agentId),write:x=>{writes++;return store.write({...x,guard:()=>{}});},invoke:x=>store.invoke(x.projectId,x.agentId,x.name,x.json)}});
 const opened=await (host as any).open(project),ctx=(await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT,named=await opened.harness.conversation(id,ctx);
 assert.ok((await named.agent(ctx)).tools.some((x:{name:string})=>x.name==='reusable_define'),'named-session migration occurs during reopen');
 fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('reusable_define',{name:'named',revision:0,fields:['name']})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('named migration complete')]);
 await host.submit(project,{text:'Use named projection',mode:'followUp',sessionId:'named'});const deadline=Date.now()+10000;
 while(!(await host.sessionView(project,'named'))?.entries.some(e=>e.text.includes('named migration complete'))){if(Date.now()>deadline)throw Error('named migration did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(writes,1);
});

test('explicit reusable-tools extension removal survives reopen and a later scope grant',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-reusable-removed-')),path=join(root,'project');await mkdir(path);
 const project={id:'77777777-7777-4777-8777-777777777777',name:'Fixture',path,managed:true,repository:'',created:''};
 const control=new ControlStore(join(root,'control')),store=new ReusableToolStore(control);
 const model={provider:'removed-reusable-faux',modelId:'fixture'},fake=fauxProvider({provider:model.provider,models:[{id:model.modelId}]}),providers=new ProviderStore(root,[fake.provider]);
 await providers.savePreferences({defaultModel:model,favourites:[],allowRealModels:true});
 const agents=new AgentStore(control,{models:()=>[model],projectKnown:id=>id===project.id}),actor={kind:'owner' as const,identity:'local'};
 const agent=agents.create({actor,draft:{name:'Scoped agent',description:'',enabled:true,model,workspace:{scope:{kind:'projects',projectIds:[project.id]},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:['read_notes']}});
 agents.bindSession({projectId:project.id,sessionId:'1',revision:0,agentId:agent.id,actor});
 let calls=0;
 const verify=(input:{projectId:string;sessionId:string;agentId:string;expectedAuthority:string})=>{
  const current=agents.versionedAuthorityForSession(input);
  if(current.agentId!==input.agentId||!current.scopes?.includes('reusable_tools')||JSON.stringify(current)!==input.expectedAuthority)throw Error('authority changed');
 };
 const options={dataRoot:root,enabled:true,providers,privileges:{authority:async({projectId,sessionId}:{projectId:string;sessionId?:string})=>agents.versionedAuthorityForSession({projectId,sessionId:sessionId??''})},reusableTools:{
  list:(input:Parameters<typeof verify>[0])=>{calls++;verify(input);return store.list(input.projectId,input.agentId);},
  write:(input:Parameters<typeof verify>[0]&{name:string;revision:number;fields:string[]})=>{calls++;return store.write({...input,guard:()=>verify(input)});},
  invoke:(input:Parameters<typeof verify>[0]&{name:string;json:string})=>{calls++;verify(input);return store.invoke(input.projectId,input.agentId,input.name,input.json);}
 }};
 let host=new HarnessHost(options);
 t.after(async()=>{await host.close();await providers.close();control.close();await rm(root,{recursive:true,force:true});});
 const ctx=(await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT,opened=await (host as any).open(project);
 await opened.conversation.configure({extensions:{remove:[{name:'reusable-tools'}]}},ctx);
 const check=async(conversation:any)=>{
  const state=await conversation.viewState(ctx);try{assert.ok(state.value.docs['pi.agent'].extensions.remove.includes('reusable-tools'));}finally{state.dispose();}
  const selected=await conversation.agent(ctx);
  assert.ok(!selected.extensions.some((item:{name:string})=>item.name==='reusable-tools'));
  assert.ok(!selected.tools.some((item:{name:string})=>['reusable_define','reusable_list','reusable_invoke'].includes(item.name)));
 };
 await check(opened.conversation);await host.close();
 agents.update({agentId:agent.id,revision:agent.revision,patch:{scopes:['read_notes','reusable_tools']},actor});
 host=new HarnessHost(options);const reopened=await (host as any).open(project);await check(reopened.conversation);
 fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('reusable_define',{name:'excluded',revision:0,fields:['name']})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('removed extension attempt finished')]);
 await host.submit(project,{text:'Try the explicitly removed tool',mode:'followUp'});
 const deadline=Date.now()+10000;while(!(await host.view(project)).entries.some(entry=>entry.text.includes('removed extension attempt finished'))){if(Date.now()>deadline)throw Error('removed extension attempt did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
 const entries=(await host.view(project)).entries;
 assert.ok(entries.some(entry=>entry.kind==='tool'&&entry.toolResult?.name==='reusable_define'&&entry.toolResult.isError),'the crafted model call is refused');
 await check(reopened.conversation);assert.equal(calls,0,'no reusable port may execute');assert.deepEqual(store.list(project.id,agent.id),[]);
 await host.close();host=new HarnessHost(options);await check((await (host as any).open(project)).conversation);
});
