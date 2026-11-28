import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { codingTools,codingToolNames,insideWorktree } from '../../src/server/agents/coding-tools';
import { HttpError } from '../../src/server/board-store';

/**
 * The coding tools: the containment this build adds around Pi's own `read`, `write` and `bash`, and
 * the switches that decide whether they exist at all.
 *
 * The tools themselves belong to `@earendil-works/pi-durable`; what is tested here is what this
 * application is responsible for: every path stays inside the connected worktree, the environment is
 * rooted there, the shell is separable from read/write, and a refusal is a refusal rather than a
 * silent rewrite. No model is called and no provider is contacted.
 */
async function worktree(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await mkdtemp(join(tmpdir(), 'pilot-coding-'));
  const root = join(base, 'worktree');
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs/plan.md'), '# Plan\n');
  await mkdir(join(root, '..', 'outside'), { recursive: true });
  await writeFile(join(root, '..', 'outside', 'secret.txt'), 'outside the worktree\n');
  t.after(() => rm(base, { recursive: true, force: true }));
  return root;
}
/** The smallest execution api the tools actually use, so a tool body can run outside a harness. */
function api(cwd: string, output: string[] = []) {
  const env = new NodeExecutionEnv({ cwd });
  return {
    env,
    output: (chunk: string) => { output.push(chunk); },
    diagnostic: () => {},
    retainedOutput: () => ({ text: output.join(''), truncated: false }),
    agent: async () => ({ model: undefined }),
    models: { getModel: () => undefined }
  } as never;
}
const context = { abortSignal: undefined } as never;

test('insideWorktree accepts the worktree and refuses everything that leaves it',()=>{
 const root='/work/tree';
 for(const path of ['docs/plan.md','./a.txt','a/b/c.txt','/work/tree/docs/plan.md','/work/tree'])assert.equal(insideWorktree(root,path),true,path);
 for(const path of ['../outside.txt','docs/../../outside.txt','/etc/passwd','/work/other/x.txt','/work/tree/../other.txt','','   ','docs/a\0b.txt'])assert.equal(insideWorktree(root,path),false,path);
});

test('the read and write tools stay inside the worktree and refuse a path outside it',async t=>{
 const root=await worktree(t),coding=codingTools({root,shell:false});
 const [read,write]=coding.extension.tools as never as {name:string;execute:(a:unknown,api:unknown,context:unknown)=>Promise<{content?:string}>}[];
 assert.deepEqual(coding.extension.tools?.map(tool=>tool.name),['read','write','edit']);
 // Inside: the tool reads and writes the real file.
 const inside=await read.execute({path:'docs/plan.md'},api(root),context);
 assert.match(JSON.stringify(inside),/Plan/);
 await write.execute({path:'docs/new.md',content:'# New\n'},api(root),context);
 assert.equal(await readFile(join(root,'docs/new.md'),'utf8'),'# New\n');
 // Outside: refused before anything is read or written, and the refusal names the path.
 for(const path of ['../outside/secret.txt','/etc/hostname',join(root,'..','outside','secret.txt')]){
  await assert.rejects(()=>read.execute({path},api(root),context),(error:Error)=>error instanceof HttpError&&error.status===403&&error.message.includes('connected repository worktree'),path);
  await assert.rejects(()=>write.execute({path,content:'overwritten\n'},api(root),context),(error:Error)=>error instanceof HttpError&&error.status===403,path);
 }
 assert.equal(await readFile(join(root,'..','outside','secret.txt'),'utf8'),'outside the worktree\n');
});

test('symlinks inside the worktree are refused without following them',async t=>{
 const root=await worktree(t);
 await writeFile(join(root,'docs/real.md'),'# Real\n');
 await symlink('real.md',join(root,'docs/inside-link.md'));
 await symlink('/etc/hostname',join(root,'escape.txt'));
 const read=(codingTools({root,shell:false}).extension.tools as never as {name:string;execute:(a:unknown,api:unknown,context:unknown)=>Promise<unknown>}[])[0];
 await assert.rejects(()=>read.execute({path:'docs/inside-link.md'},api(root),context));
 // The path is inside the worktree, so the containment check passes it. The environment is what
 // refuses: it does not follow a link that leaves the root, so nothing outside can be read through
 // one. The refusal is the environment's own error, and no content is returned.
 await assert.rejects(()=>read.execute({path:'escape.txt'},api(root),context),(error:Error)=>!String(error.message).includes('hostname'));
});

test('the shell is separable: read and write do not install it, and it runs in the worktree',async t=>{
 const root=await worktree(t);
 assert.deepEqual(codingToolNames(false),['read','write','edit']);
 assert.deepEqual(codingToolNames(true),['read','write','edit','bash']);
 assert.equal(codingTools({root,shell:false}).extension.tools?.some(tool=>tool.name==='bash'),false);
 const withShell=codingTools({root,shell:true});
 const bash=withShell.extension.tools?.find(tool=>tool.name==='bash') as unknown as {execute:(a:unknown,api:unknown,context:unknown)=>Promise<{output?:string}>};
 assert.ok(bash,'the shell tool is installed when its switch is on');
 const output:string[]=[];
 const result=await bash.execute({command:'pwd; cat docs/plan.md'},api(root,output),context);
 const text=output.join('')+JSON.stringify(result);
 assert.match(text,/# Plan/,'the command ran with the worktree as its working directory');
});

test('the environment is rooted at the worktree, so a relative path resolves there and a command starts there',async()=>{
 const root=await worktree({after:()=>Promise.resolve()});
 const env=codingTools({root,shell:true}).env(undefined,context);
 const absolute=await env.absolutePath('docs/plan.md',context);
 assert.equal(absolute.ok&&absolute.value,join(root,'docs/plan.md'));
 assert.equal(env.cwd,root);
});

test('the instance switches decide what the interface reports as installed, per scope',async t=>{
 const { mkdtemp:mk }=await import('node:fs/promises');
 const { createApp }=await import('../../src/server/main');
 const { localConfig }=await import('../../src/server/security');
 const { ControlStore }=await import('../../src/server/state/control-store');
 const root=await mk(join(tmpdir(),'pilot-coding-http-'));
 const store=new ControlStore(root);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control:store,coding:{enabled:true,shell:false}});
 await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));
 security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
 t.after(async()=>{await app.close();store.close();await rm(root,{recursive:true,force:true});});
 const body=await (await fetch(security.origin+'/api/agents',{headers:{'x-dashboard-token':security.token}})).json() as {scopes:{scope:string;installed:boolean}[];fileEdit:{enabled:boolean}};
 const installed=new Map(body.scopes.map(entry=>[entry.scope,entry.installed]));
 assert.equal(installed.get('accept'),true,'the acceptance tools are installed with the control store');
 assert.equal(installed.get('file_read'),true,'the read tool is installed when the coding switch is on');
 assert.equal(installed.get('file_write'),true,'the write tool is installed with it');
 assert.equal(installed.get('shell'),false,'the shell stays uninstalled while its own switch is off');
 assert.equal(installed.get('file_edit'),false,'the file-edit tool has its own switch and is off here');
 // The vocabulary describes the shell in the words an owner needs to decide: it is not contained.
 const shell=body.scopes.find(entry=>entry.scope==='shell');
 assert.match(String((shell as {description?:string}).description),/not contained/);
});

/**
 * The end-to-end evidence: a scripted model, through the real harness, calling the real tools.
 *
 * The faux provider answers with tool calls exactly as a model would; everything below the call —
 * the harness, the environment, the containment and the worktree — is the production code path.
 */
async function codingHarness(t: { after: (fn: () => Promise<void>) => void }, scopes?: readonly never[], fileEdit?: import('../../src/server/state/file-edit-tool').FileEditCapability, fileEditAllowed=true) {
  const { mkdtemp:mk, writeFile:wr }=await import('node:fs/promises');
  const { fauxProvider }=await import('@earendil-works/pi-ai/providers/faux');
  const { HarnessHost }=await import('../../src/server/agents/harness-host');
  const { ProviderStore }=await import('../../src/server/providers');
  const { BoardStore }=await import('../../src/server/board-store');
  const { randomUUID }=await import('node:crypto');
  const root=await mk(join(tmpdir(),'pilot-coding-flow-'));
  const worktree=join(root,'repositories',randomUUID(),'agent');
  await mkdir(join(worktree,'docs'),{recursive:true});
  await wr(join(worktree,'docs/inside.md'),'# Inside\n');
  await mkdir(join(root,'outside'),{recursive:true});
  await wr(join(root,'outside','secret.md'),'# Secret\n');
  const project={id:randomUUID(),name:'Coding fixture',path:worktree,managed:true,repository:'',created:''};
  const fake=fauxProvider({provider:'coding-faux',models:[{id:'fixture'}]});
  const providers=new ProviderStore(root,[fake.provider]);
  await providers.savePreferences({defaultModel:{provider:'coding-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
  const host=new HarnessHost({dataRoot:root,enabled:true,providers,boards:new BoardStore(root),
    coding:{enabled:true,shell:true,root:()=>worktree},
    ...(fileEdit?{fileEdit,allowedCapabilities:async()=>({codingTools:true,shell:true,fileEdit:fileEditAllowed})}:{}),
    ...(scopes===undefined?{}:{privileges:{authority:async()=>({agentId:'fixture',model:null,scopes,projects:null,emptyReason:null})}} as never)});
  t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
  return {root,worktree,project,fake,host};
}
async function until(check:()=>Promise<boolean>){
  const deadline=Date.now()+15000;
  while(!await check()){if(Date.now()>deadline)throw Error('the scripted run did not settle');await new Promise(r=>setTimeout(r,20));}
}
test('a scripted model reads, writes and runs a command inside the connected worktree',async t=>{
 const { fauxAssistantMessage,fauxToolCall }=await import('@earendil-works/pi-ai/providers/faux');
 const { worktree,project,fake,host }=await codingHarness(t);
 fake.setResponses([
  () => fauxAssistantMessage([fauxToolCall('read',{path:'docs/inside.md'})],{stopReason:'toolUse'}),
  () => fauxAssistantMessage([fauxToolCall('write',{path:'docs/written.md',content:'# Written\n'})],{stopReason:'toolUse'}),
  () => fauxAssistantMessage([fauxToolCall('edit',{path:'docs/written.md',edits:[{oldText:'Written',newText:'Edited'}]})],{stopReason:'toolUse'}),
  () => fauxAssistantMessage([fauxToolCall('bash',{command:'printf ran > marker.txt; echo command-ok'})],{stopReason:'toolUse'}),
  () => fauxAssistantMessage('Coding done.')
 ]);
 await host.submit(project,{text:'Work in the worktree',mode:'followUp'});
 await until(async()=>(await host.view(project)).entries.some(entry=>entry.text.includes('Coding done.')));
 const view=await host.view(project),transcript=JSON.stringify(view.entries);
 assert.match(transcript,/# Inside/,'the read tool returned the file inside the worktree');
 assert.equal(await readFile(join(worktree,'docs/written.md'),'utf8'),'# Edited\n');
 assert.equal(await readFile(join(worktree,'marker.txt'),'utf8'),'ran','the command ran with the worktree as its working directory');
 assert.match(transcript,/command-ok/,'the command output reached the transcript');
});
test('a path outside the worktree is refused at dispatch and changes nothing',async t=>{
 const { fauxAssistantMessage,fauxToolCall }=await import('@earendil-works/pi-ai/providers/faux');
 const { root,worktree,project,fake,host }=await codingHarness(t);
 fake.setResponses([
  () => fauxAssistantMessage([fauxToolCall('read',{path:'../outside/secret.md'})],{stopReason:'toolUse'}),
  () => fauxAssistantMessage([fauxToolCall('write',{path:join(root,'outside','secret.md'),content:'overwritten\n'})],{stopReason:'toolUse'}),
  () => fauxAssistantMessage([fauxToolCall('bash',{command:'echo still-permitted > inside-marker.txt'})],{stopReason:'toolUse'}),
  () => fauxAssistantMessage('Refusals observed.')
 ]);
 await host.submit(project,{text:'Try to leave the worktree',mode:'followUp'});
 await until(async()=>(await host.view(project)).entries.some(entry=>entry.text.includes('Refusals observed.')));
 const transcript=JSON.stringify((await host.view(project)).entries);
 assert.match(transcript,/connected repository worktree/,'both refusals are reported to the model in those words');
 assert.equal(await readFile(join(root,'outside','secret.md'),'utf8'),'# Secret\n','the file outside the worktree is unchanged');
 assert.equal(await readFile(join(worktree,'inside-marker.txt'),'utf8'),'still-permitted\n','the shell itself still works inside the worktree');
});

test('the coding tools are governed by name: read, write and bash each have a scope',async()=>{
 const { AGENT_TOOL_SCOPES,authorizeToolUse }=await import('../../src/shared/agent-registry');
 // The tool names a model calls, mapped to the scope that governs them. Without these three
 // entries the dispatch path refuses every coding tool for every caller, which is exactly the
 // defect the scripted end-to-end run above catches.
 assert.equal(AGENT_TOOL_SCOPES['read'],'file_read');
 assert.equal(AGENT_TOOL_SCOPES['write'],'file_write');
 assert.equal(AGENT_TOOL_SCOPES['edit'],'file_write');
 assert.equal(authorizeToolUse({scopes:[],tool:'edit'}).permitted,false);
 assert.equal(AGENT_TOOL_SCOPES['bash'],'shell');
 assert.equal(authorizeToolUse({scopes:['file_read'],tool:'read'}).permitted,true);
 assert.equal(authorizeToolUse({scopes:[],tool:'read'}).permitted,false);
 assert.equal(authorizeToolUse({scopes:['file_read'],tool:'bash'}).permitted,false,'the shell is not granted by reading a file');
});

test('Pi edit rejects an escaping symlink without changing its target',async t=>{
 const root=await worktree(t);
 const target=join(root,'..','outside','secret.txt');
 await symlink(target,join(root,'escape.txt'));
 const edit=codingTools({root,shell:false}).extension.tools?.find(tool=>tool.name==='edit') as unknown as {execute:(a:unknown,api:unknown,context:unknown)=>Promise<unknown>};
 await assert.rejects(()=>edit.execute({path:'escape.txt',edits:[{oldText:'outside',newText:'changed'}]},api(root),context));
 assert.equal(await readFile(target,'utf8'),'outside the worktree\n');
});

test('a model without the file_write grant cannot call Pi edit',async t=>{
 const { fauxAssistantMessage,fauxToolCall }=await import('@earendil-works/pi-ai/providers/faux');
 const { worktree,project,fake,host }=await codingHarness(t,['file_read'] as never);
 fake.setResponses([
  () => fauxAssistantMessage([fauxToolCall('edit',{path:'docs/inside.md',edits:[{oldText:'Inside',newText:'Changed'}]})],{stopReason:'toolUse'}),
  () => fauxAssistantMessage('Denied edit observed.')
 ]);
 await host.submit(project,{text:'Try editing',mode:'followUp'});
 await until(async()=>(await host.view(project)).entries.some(entry=>entry.text.includes('Denied edit observed.')));
 assert.equal(await readFile(join(worktree,'docs/inside.md'),'utf8'),'# Inside\n');
 const transcript=JSON.stringify((await host.view(project)).entries);
 assert.match(transcript,/not permitted|refus|denied|not found|unknown tool/i);
});

test('coding tools refuse generated and application-managed directories at every depth',async t=>{
 const root=await worktree(t);
 await mkdir(join(root,'docs','node_modules'),{recursive:true});
 await writeFile(join(root,'docs','node_modules','generated.txt'),'keep');
 const tools=codingTools({root,shell:false}).extension.tools as unknown as {name:string;execute:(a:unknown,api:unknown,context:unknown)=>Promise<unknown>}[];
 for(const [name,args] of [['read',{path:'docs/node_modules/generated.txt'}],['write',{path:'docs/node_modules/generated.txt',content:'overwrite'}],['edit',{path:'docs/node_modules/generated.txt',edits:[{oldText:'keep',newText:'overwrite'}]}]] as const){
  const tool=tools.find(entry=>entry.name===name)!;
  await assert.rejects(()=>tool.execute(args,api(root),context));
 }
 assert.equal(await readFile(join(root,'docs','node_modules','generated.txt'),'utf8'),'keep');
});

test('tilde-shaped paths are read as literal worktree paths, not expanded to the home directory',async t=>{
 const root=await worktree(t);
 await mkdir(join(root,'~'));
 await writeFile(join(root,'~','local.txt'),'worktree tilde');
 const read=codingTools({root,shell:false}).extension.tools?.find(tool=>tool.name==='read') as unknown as {execute:(a:unknown,api:unknown,context:unknown)=>Promise<unknown>};
 assert.match(JSON.stringify(await read.execute({path:'~/local.txt'},api(root),context)),/worktree tilde/);
});


test('the model sees the file-edit mode in force on each request',async t=>{
 const { fauxAssistantMessage }=await import('@earendil-works/pi-ai/providers/faux');
 let mode: 'propose-only'|'auto-apply'='propose-only';
 const capability={enabled:true,mode:async()=>mode,view:async()=>{throw Error('unused');},edit:async()=>{throw Error('unused');}};
 const {project,fake,host}=await codingHarness(t,undefined,capability);
 const prompts:string[]=[];
 fake.setResponses([context=>{prompts.push(JSON.stringify(context));return fauxAssistantMessage('First complete.');},context=>{prompts.push(JSON.stringify(context));return fauxAssistantMessage('Second complete.');}]);
 await host.submit(project,{text:'First',mode:'followUp'});
 await until(async()=>(await host.view(project)).entries.some(entry=>entry.text.includes('First complete.')));
 mode='auto-apply';
 await host.submit(project,{text:'Second',mode:'followUp'});
 await until(async()=>(await host.view(project)).entries.some(entry=>entry.text.includes('Second complete.')));
 assert.match(prompts[0],/current mode is propose-only/);
 assert.match(prompts[1],/current mode is auto-apply/);
});


test('an installed file-edit tool is refused at model dispatch when the owner disabled it',async t=>{
 const { fauxAssistantMessage,fauxToolCall }=await import('@earendil-works/pi-ai/providers/faux');
 let calls=0;
 const capability={enabled:true,mode:async()=>('auto-apply' as const),view:async()=>{throw Error('unused');},edit:async()=>{calls++;throw Error('must not execute');}};
 const {project,fake,host}=await codingHarness(t,undefined,capability,false);
 fake.setResponses([()=>fauxAssistantMessage([fauxToolCall('file_edit',{path:'docs/inside.md',content:'changed'})],{stopReason:'toolUse'}),()=>fauxAssistantMessage('Disabled edit observed.')]);
 await host.submit(project,{text:'Try the disabled tool',mode:'followUp'});
 await until(async()=>(await host.view(project)).entries.some(entry=>entry.text.includes('Disabled edit observed.')));
 assert.equal(calls,0);
 assert.match(JSON.stringify((await host.view(project)).entries),/switched off/);
});

test('coding tools use the session workspace for each call',async t=>{
 const parent=await worktree(t),child=join(parent,'..','child');await mkdir(child);await writeFile(join(child,'marker.txt'),'child');await writeFile(join(parent,'marker.txt'),'parent');
 const coding=codingTools({root:parent,shell:true,rootForConversation:async id=>{if(id==='child')return child;if(id==='parent')return parent;throw new Error('unknown session');}});
 const tool=(name:string)=>(coding.extension.tools as never as {name:string;execute:(args:unknown,api:unknown,ctx:unknown)=>Promise<unknown>}[]).find(x=>x.name===name)!;
 const session=(id:string)=>({...(api(parent) as object),conversationId:id}) as never;
 assert.match(JSON.stringify(await tool('read').execute({path:'marker.txt'},session('child'),context)),/child/);
 await tool('write').execute({path:'created.txt',content:'child only'},session('child'),context);
 assert.equal(await readFile(join(child,'created.txt'),'utf8'),'child only');
 await assert.rejects(()=>readFile(join(parent,'created.txt'),'utf8'));
 await tool('bash').execute({command:'pwd > shell-cwd.txt'},session('child'),context);
 assert.equal((await readFile(join(child,'shell-cwd.txt'),'utf8')).trim(),await (await import('node:fs/promises')).realpath(child));
 await assert.rejects(()=>tool('read').execute({path:'marker.txt'},session('unknown'),context),/unknown session/);
});
