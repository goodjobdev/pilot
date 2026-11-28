import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,realpath,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fauxAssistantMessage,fauxProvider,fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import type { AgentScope } from '../../src/shared/agent-registry';

/**
 * The installed commit and push capability as the running application offers it.
 *
 * These tests read the deployment switches, the owner's target routes and the agent-facing tools
 * through `createApp`: the same wiring a deployment uses, with disposable repositories on this
 * machine and no network.
 */
const exec=promisify(execFile);
const env={PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
async function git(cwd: string,...args: string[]): Promise<string> {
  const { stdout }=await exec('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=always','-C',cwd,...args],{env,timeout:20000,maxBuffer:1024*1024});
  return stdout.trim();
}
async function listen(app: Awaited<ReturnType<typeof createApp>>,security: ReturnType<typeof localConfig>) {
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
}
function client(security: ReturnType<typeof localConfig>) {
  const headers={'x-dashboard-token':security.token},writes={...headers,origin:security.origin,'content-type':'application/json'};
  return {
    get:(path:string)=>fetch(security.origin+'/api'+path,{headers}),
    post:(path:string,body:unknown,override:Record<string,string>={})=>fetch(security.origin+'/api'+path,{method:'POST',headers:{...writes,...override},body:JSON.stringify(body)})
  };
}

test('the deployment switches decide whether the commit and push tools exist, and the registry reports it',async()=>{
  const roots:string[]=[],apps:Awaited<ReturnType<typeof createApp>>[]=[],stores:ControlStore[]=[];
  try{
    const open=async(enabled:boolean)=>{
      const root=await realpath(await mkdtemp(join(tmpdir(),'pilot-commit-push-switch-'))),store=new ControlStore(root),security=localConfig('http://127.0.0.1:0');
      roots.push(root);stores.push(store);
      const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control:store,...(enabled?{acceptedCommit:{enabled:true},acceptedPush:{enabled:true}}:{})});
      apps.push(app);await listen(app,security);
      const view=await (await client(security).get('/agents')).json() as {scopes:{scope:string;installed:boolean}[]};
      return {app,security,view};
    };
    const off=await open(false),offInstalled=new Map(off.view.scopes.map(entry=>[entry.scope,entry.installed]));
    assert.equal(offInstalled.get('commit'),false,'the commit tool is not installed by default');
    assert.equal(offInstalled.get('push'),false,'the push tool is not installed by default');
    const project=await off.app.catalog.register({name:'Switch off',managed:true,confirm:true,repository:''});
    const offTarget=await (await client(off.security).get('/projects/'+project.id+'/action-targets/commit')).json() as {available:boolean;reason:string};
    assert.equal(offTarget.available,false);assert.match(offTarget.reason,/not installed/);
    const on=await open(true),onInstalled=new Map(on.view.scopes.map(entry=>[entry.scope,entry.installed]));
    assert.equal(onInstalled.get('commit'),true,'the commit tool is installed when its switch is on');
    assert.equal(onInstalled.get('push'),true,'the push tool is installed when its switch is on');
  }finally{
    for(const app of apps)await app.close();
    for(const store of stores)store.close();
    for(const root of roots)await rm(root,{recursive:true,force:true});
  }
});

async function fixture(scopes: readonly AgentScope[]) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'pilot-commit-push-http-'))),store=new ControlStore(root),security=localConfig('http://127.0.0.1:0'),template=join(root,'template');
  await mkdir(template);
  const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control:store,agentEvidenceRecording:true,acceptedCommit:{enabled:true},acceptedPush:{enabled:true}});
  await listen(app,security);
  const api=client(security);
  const project=await app.catalog.register({name:'Installed targets',managed:true,confirm:true,repository:''});
  const worktree=join(app.catalog.root,'repositories',project.id,'agent');
  await mkdir(worktree,{recursive:true});
  const short='work/pilot-'+project.id.slice(0,8),branch='refs/heads/'+short;
  await git(worktree,'init','-q','--template='+template);
  await git(worktree,'config','user.name','Fixture');await git(worktree,'config','user.email','fixture@example.invalid');
  await git(worktree,'checkout','-q','-b',short);
  await writeFile(join(worktree,'a.txt'),'base\n');
  await git(worktree,'add','a.txt');await git(worktree,'commit','-q','-m','base');
  const base=await git(worktree,'rev-parse','HEAD');
  const remotePath=join(root,'remote.git');
  await git(root,'init','--bare','-q','--template='+template,remotePath);
  await git(remotePath,'config','core.hooksPath','/dev/null');
  await git(worktree,'remote','add','origin',remotePath);
  await app.catalog.attachWorktree(project.id);
  const fake=fauxProvider({provider:'commit-push-faux',models:[{id:'fixture'}]});
  app.providers.models.setProvider(fake.provider);
  await app.providers.savePreferences({defaultModel:{provider:'commit-push-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
  const agent=app.agentStore!.create({actor:{kind:'owner',identity:'fixture'},draft:{name:'Commit and push agent',description:'',enabled:true,model:{provider:'commit-push-faux',modelId:'fixture'},workspace:{scope:{kind:'projects',projectIds:[project.id]},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:[...scopes]}});
  return {root,store,security,app,api,project,worktree,remotePath,branch,base,fake,agent,
    cleanup:async()=>{await app.close();store.close();await rm(root,{recursive:true,force:true});}};
}

test('the owner configures one exact local push target, revision-checked, with no model input',async()=>{
  const f=await fixture(['accept','push']);
  try{
    const base='/projects/'+f.project.id+'/action-targets/push';
    assert.equal((await fetch(f.security.origin+'/api'+base)).status,401);
    assert.equal((await f.api.post(base,{revision:0,enabled:true,remoteId:'origin'},{origin:'https://evil.invalid'})).status,403);
    const before=await (await f.api.get(base)).json() as {target:unknown;branch:string;remotes:{remoteId:string;repositoryDigest:string}[];connected:boolean;available:boolean};
    assert.equal(before.target,null);assert.equal(before.connected,true);assert.equal(before.available,true);
    assert.equal(before.branch,f.branch,'the push branch is the project Pilot branch, chosen by the server');
    assert.deepEqual(before.remotes.map(remote=>remote.remoteId),['origin']);
    assert.match(before.remotes[0].repositoryDigest,/^[a-f0-9]{64}$/);
    // A client may name only a configured remote; a network URL, a branch, a command or an actor is refused.
    for(const extra of [{branch:'refs/heads/main'},{command:'git push --force'},{actor:{kind:'owner',identity:'x'}}]){
      assert.equal((await f.api.post(base,{revision:0,enabled:true,remoteId:'origin',...extra})).status,422);
    }
    await git(f.worktree,'remote','add','hosted','https://owner:'+randomUUID()+'@example.invalid/private.git');
    const hosted=await f.api.post(base,{revision:0,enabled:true,remoteId:'hosted'});
    assert.equal(hosted.status,422);
    const refusal=await hosted.text();
    assert.match(refusal,/local filesystem repository/);
    assert.ok(!refusal.includes('example.invalid')&&!refusal.includes('owner:'),'the refusal echoes neither the URL nor a credential');
    assert.equal((await f.api.post(base,{revision:0,enabled:true,remoteId:'missing'})).status,422);
    const saved=await f.api.post(base,{revision:0,enabled:true,remoteId:'origin'});
    assert.equal(saved.status,200);
    const first=await saved.json() as {target:{revision:number;enabled:boolean;definition:{kind:string;remoteId:string;repositoryDigest:string;branch:string};updatedBy:string};available:boolean};
    assert.equal(first.target.revision,1);assert.equal(first.target.enabled,true);assert.equal(first.target.updatedBy,'local');
    assert.deepEqual(first.target.definition,{kind:'push',remoteId:'origin',repositoryDigest:before.remotes[0].repositoryDigest,branch:f.branch});
    assert.equal(first.available,true);
    assert.ok(!JSON.stringify(first).includes(f.remotePath),'the target view carries no local path');
    assert.equal((await f.api.post(base,{revision:0,enabled:false,remoteId:'origin'})).status,409);
    const racing=await Promise.all([f.api.post(base,{revision:1,enabled:false,remoteId:'origin'}),f.api.post(base,{revision:1,enabled:true,remoteId:'origin'})]);
    assert.deepEqual(racing.map(response=>response.status).sort(),[200,409]);
    const current=await (await f.api.get(base)).json() as {target:{revision:number}};
    assert.equal(current.target.revision,2);
    // The commit target reports the installed tool, and its definition stays server-chosen.
    const commit=await (await f.api.get('/projects/'+f.project.id+'/action-targets/commit')).json() as {available:boolean;reason:string};
    assert.equal(commit.available,true);assert.match(commit.reason,/installed/);
    assert.equal((await f.api.post('/projects/'+f.project.id+'/action-targets/commit',{revision:0,enabled:true})).status,200);
  }finally{await f.cleanup();}
});

test('a project with no connected worktree cannot be given a push target',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'pilot-commit-push-detached-'))),store=new ControlStore(root),security=localConfig('http://127.0.0.1:0');
  const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control:store,acceptedPush:{enabled:true}});
  try{
    await listen(app,security);
    const api=client(security),project=await app.catalog.register({name:'Detached',managed:true,confirm:true,repository:''});
    const base='/projects/'+project.id+'/action-targets/push';
    const view=await (await api.get(base)).json() as {connected:boolean;remotes:unknown[]};
    assert.equal(view.connected,false);assert.deepEqual(view.remotes,[]);
    const refused=await api.post(base,{revision:0,enabled:true,remoteId:'origin'});
    assert.equal(refused.status,409);assert.match(await refused.text(),/connected repository worktree/);
  }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('the running app offers commit_preview and push_preview to a bound agent with the configured targets',async()=>{
  const f=await fixture(['accept','commit','push']);
  try{
    await f.api.post('/projects/'+f.project.id+'/action-targets/commit',{revision:0,enabled:true});
    const pushTarget=await f.api.post('/projects/'+f.project.id+'/action-targets/push',{revision:0,enabled:true,remoteId:'origin'});
    assert.equal(pushTarget.status,200);
    const session=await (await f.api.post('/sessions',{projectId:f.project.id,name:'Commit session'})).json() as {session:{id:string}};
    const bound=await f.api.post('/sessions/'+session.session.id+'/agent',{projectId:f.project.id,revision:0,agentId:f.agent.id,actor:{kind:'owner',identity:'local'}});
    assert.equal(bound.status,200);
    await writeFile(join(f.worktree,'a.txt'),'staged for the model\n');
    await git(f.worktree,'add','a.txt');
    f.fake.setResponses([
      ()=>fauxAssistantMessage([fauxToolCall('commit_preview',{})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage([fauxToolCall('push_preview',{commit:f.base})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage('Previews done.')
    ]);
    await f.app.agents.submit(f.project,{text:'Preview the targets',mode:'followUp',sessionId:session.session.id});
    const deadline=Date.now()+15000;
    let entries=(await f.app.agents.sessionView(f.project,session.session.id))!;
    while(!entries.entries.some(entry=>entry.text.includes('Previews done.'))){
      if(Date.now()>deadline)throw Error('the scripted run did not settle');
      await new Promise(resolve=>setTimeout(resolve,20));
      entries=(await f.app.agents.sessionView(f.project,session.session.id))!;
    }
    const results=entries.entries.filter(entry=>entry.kind==='tool').map(entry=>{
      try{return JSON.parse(entry.text) as Record<string,unknown>;}catch{return null;}
    }).filter((result):result is Record<string,unknown>=>result!==null);
    const commitPreview=results.find(result=>typeof result.contentRevision==='string'&&String(result.contentRevision).startsWith('tree-'));
    assert.ok(commitPreview,'the commit preview reached the model');
    const commitTarget=commitPreview.target as {id:string;branch:string;digest:string};
    assert.equal(commitTarget.id,'pilot-commit');assert.equal(commitTarget.branch,f.branch);assert.match(commitTarget.digest,/^[a-f0-9]{64}$/);
    assert.deepEqual(commitPreview.changedPaths,['a.txt']);
    const pushPreview=results.find(result=>typeof result.contentRevision==='string'&&String(result.contentRevision).startsWith('commit-'));
    assert.ok(pushPreview,'the push preview reached the model');
    assert.equal((pushPreview.target as {kind:string}).kind,'push');
    assert.equal(pushPreview.remoteHead,null,'the preview observed the empty local remote branch');
    assert.equal(await git(f.worktree,'rev-parse','HEAD'),f.base,'a preview commits nothing');
    assert.equal(await git(f.remotePath,'rev-parse','--verify','--quiet',f.branch).catch(()=>null),null,'a preview pushes nothing');
  }finally{await f.cleanup();}
});
