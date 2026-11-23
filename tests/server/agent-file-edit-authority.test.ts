import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import { AgentStore } from '../../src/server/state/agent-store';
import { ControlStore } from '../../src/server/state/control-store';
import { FileEditTool } from '../../src/server/state/file-edit-tool';

for(const point of ['after-hook', 'queued-write', 'rebind', 'before-rename','capability-aba','agent-aba','binding-aba'] as const) test('file edit refuses changed authority at '+point+' without owner attribution', async () => {
 const root=await mkdtemp(join(tmpdir(),'pilot-file-authority-')),worktree=join(root,'worktree'),data=join(root,'data');
 await Promise.all([mkdir(worktree),mkdir(data)]); const file=join(worktree,'example.md');await writeFile(file,'# Original\n');
 const control=new ControlStore(data),other=new ControlStore(data),projectId=randomUUID();
 const offered=[{provider:'edit-faux',modelId:'fixture'}],options={models:()=>offered,projectKnown:(id:string)=>id===projectId};
 const agents=new AgentStore(control,options),competitor=new AgentStore(other,options),actor={kind:'owner' as const,identity:'fixture'};
 const agent=agents.create({actor,draft:{name:'Editor',description:'',enabled:true,model:offered[0],workspace:{scope:{kind:'projects',projectIds:[projectId]},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:['file_edit']}});
 agents.bindSession({projectId,sessionId:'1',revision:0,agentId:agent.id,actor});
 const replacement=point==='rebind'||point==='binding-aba'?agents.create({actor,draft:{name:'Replacement',description:'',enabled:true,model:offered[0],workspace:{scope:{kind:'projects',projectIds:[projectId]},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:['file_edit']}}):null;
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const tool=new FileEditTool(control,{enabled:true,projectRoot:id=>id===projectId?worktree:undefined,policy:{mode:()=> 'auto-apply'},saveMarkdown:async(_project,_path,write)=>{if(point==='queued-write'){enter();await gate;}await write();return {status:'unchanged',message:'Fixture'};},...(point==='before-rename'?{beforeFileCommit:async()=>{enter();await gate;}}:{})});
 const fake=fauxProvider({provider:'edit-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);
 await providers.savePreferences({defaultModel:{provider:'edit-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
 const project={id:projectId,name:'Fixture',path:worktree,managed:true,repository:'',created:''};
 let capabilityRevision=1;
 const host=new HarnessHost({dataRoot:root,enabled:true,providers,fileEdit:tool,
  allowedCapabilities:async()=>({codingTools:false,shell:false,fileEdit:true,revision:capabilityRevision}),
  privileges:{authority:async({projectId:id,sessionId})=>agents.versionedAuthorityForSession({projectId:id,sessionId:sessionId??''})},
  ...(['after-hook','rebind','capability-aba','agent-aba','binding-aba'].includes(point)?{fileEditAuthorized:async()=>{enter();await gate;}}:{})});
 try {
  fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('file_edit',{path:'example.md',content:'# Changed\n'})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('Edit run settled.')]);
  await host.submit(project,{text:'Try one edit',mode:'followUp'});await entered;
  if(point==='capability-aba')capabilityRevision+=2;
  else if(replacement){const changed=competitor.bindSession({projectId,sessionId:'1',revision:1,agentId:replacement.id,actor});if(point==='binding-aba')competitor.bindSession({projectId,sessionId:'1',revision:changed.revision,agentId:agent.id,actor});}
  else {const changed=competitor.update({agentId:agent.id,revision:agent.revision,patch:{scopes:[]},actor});if(point==='agent-aba')competitor.update({agentId:agent.id,revision:changed.revision,patch:{scopes:['file_edit']},actor});}
  release();
  const deadline=Date.now()+10000;
  while(!(await host.view(project)).entries.some(entry=>entry.text.includes('Edit run settled.'))){if(Date.now()>deadline)throw Error('edit did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(await readFile(file,'utf8'),'# Original\n');
  assert.equal((await readdir(worktree)).filter(name=>name.endsWith('.tmp')).length,0);
  const records=(await tool.view(projectId)).edits;
  if(['after-hook','rebind','capability-aba','agent-aba','binding-aba'].includes(point))assert.equal(records.length,0);
  else {assert.equal(records.length,1);assert.equal(records[0].agentId,agent.id);assert.equal(records[0].applied,null);}
  assert.ok(records.every(record=>record.changedBy.kind==='agent'));
 } finally {release();await host.close();await providers.close();control.close();other.close();await rm(root,{recursive:true,force:true});}
});

test('a valid bound agent can still apply and durably confirm the exact edit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-file-authority-')),worktree=join(root,'worktree'),data=join(root,'data');await Promise.all([mkdir(worktree),mkdir(data)]);
 const control=new ControlStore(data),projectId=randomUUID(),offered=[{provider:'edit-ok-faux',modelId:'fixture'}],agents=new AgentStore(control,{models:()=>offered,projectKnown:id=>id===projectId});
 const actor={kind:'owner' as const,identity:'fixture'},agent=agents.create({actor,draft:{name:'Editor',description:'',enabled:true,model:offered[0],workspace:{scope:{kind:'projects',projectIds:[projectId]},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:['file_edit']}});
 agents.bindSession({projectId,sessionId:'1',revision:0,agentId:agent.id,actor});
 const tool=new FileEditTool(control,{enabled:true,projectRoot:()=>worktree,policy:{mode:()=> 'auto-apply'}}),fake=fauxProvider({provider:'edit-ok-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);
 await providers.savePreferences({defaultModel:{provider:'edit-ok-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
 const project={id:projectId,name:'Fixture',path:worktree,managed:true,repository:'',created:''};
 const host=new HarnessHost({dataRoot:root,enabled:true,providers,fileEdit:tool,privileges:{authority:async({projectId:id,sessionId})=>agents.authorityForSession({projectId:id,sessionId:sessionId??''})}});
 try {
  fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('file_edit',{path:'example.txt',content:'applied'})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('Edit applied.')]);
  await host.submit(project,{text:'Make the edit',mode:'followUp'});const end=Date.now()+10000;
  while(!(await host.view(project)).entries.some(entry=>entry.text.includes('Edit applied.'))){if(Date.now()>end)throw Error('edit did not finish');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(await readFile(join(worktree,'example.txt'),'utf8'),'applied');
  const records=(await tool.view(projectId)).edits;assert.equal(records.length,1);assert.equal(records[0].applied,true);assert.equal(records[0].agentId,agent.id);
  await writeFile(join(worktree,'example.txt'),'external');
  fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('file_edit',{path:'example.txt',content:'applied'})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('Duplicate checked.')]);
  await host.submit(project,{text:'Try the same edit',mode:'followUp'});
  const next=Date.now()+10000;while(!(await host.view(project)).entries.some(entry=>entry.text.includes('Duplicate checked.'))){if(Date.now()>next)throw Error('duplicate did not finish');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(await readFile(join(worktree,'example.txt'),'utf8'),'external');
  assert.match(JSON.stringify((await host.view(project)).entries),/No new write occurred.*previous write confirmation/);
 } finally {await host.close();await providers.close();control.close();await rm(root,{recursive:true,force:true});}
});
