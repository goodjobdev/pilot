import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,realpath,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { fauxAssistantMessage,fauxProvider,fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Project } from '../../src/shared/model';
import type { ArtifactIdentity } from '../../src/shared/acceptance';
import { defaultAcceptancePolicy } from '../../src/shared/acceptance';
import type { AgentScope } from '../../src/shared/agent-registry';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { ActionTargetStore } from '../../src/server/state/action-target-store';
import { AcceptedActionExecutor } from '../../src/server/state/accepted-action';
import { AcceptedCommitService } from '../../src/server/agents/accepted-commit';
import { AcceptedPushService,type ExactPushTransport } from '../../src/server/agents/accepted-push';
import { acceptAgentEvidence } from '../../src/server/agents/accept-evidence';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import { WorkspaceStore } from '../../src/server/workspace';
import { LocalGitPushTransport,resolveLocalPushRemote } from '../../src/server/state/local-git-push-transport';

/**
 * The installed commit and push tools, end to end through the real harness.
 *
 * The scripted model calls `commit_preview`, `commit_accepted`, `push_preview` and `push_accepted`
 * exactly as a model would; everything below the call is production code: the acceptance-bound
 * executor, the Git plumbing adapter, the local push transport and disposable repositories on this
 * machine. No network and no real remote is used.
 */
const exec=promisify(execFile);
const env={PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
async function git(cwd: string,...args: string[]): Promise<string> {
  const { stdout }=await exec('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=always','-C',cwd,...args],{env,timeout:20000,maxBuffer:1024*1024});
  return stdout.trim();
}
const session=String(ROOT_CONVERSATION_ID);

async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'pilot-installed-commit-push-'))),worktree=join(root,'project'),remotePath=join(root,'remote.git'),data=join(root,'data'),template=join(root,'template');
  await Promise.all([mkdir(worktree),mkdir(data),mkdir(template)]);
  const projectId=randomUUID(),short='work/pilot-'+projectId.slice(0,8),branch='refs/heads/'+short;
  await git(worktree,'init','-q','--template='+template);
  await git(worktree,'config','user.name','Fixture');await git(worktree,'config','user.email','fixture@example.invalid');
  await git(worktree,'checkout','-q','-b',short);
  await writeFile(join(worktree,'a.txt'),'base\n');
  await git(worktree,'add','a.txt');await git(worktree,'commit','-q','-m','base');
  const base=await git(worktree,'rev-parse','HEAD');
  await git(root,'init','--bare','-q','--template='+template,remotePath);
  await git(remotePath,'config','core.hooksPath','/dev/null');
  await git(worktree,'remote','add','origin',remotePath);
  await git(worktree,'push','-q','--no-verify','--',remotePath,base+':'+branch);
  const project:Project={id:projectId,name:'Installed commit and push',path:worktree,managed:true,repository:'',created:''};
  const control=new ControlStore(data),targets=new ActionTargetStore(control),workspace=new WorkspaceStore();
  const acceptance=new AcceptanceStore(control,{projectRoot:id=>id===projectId?worktree:undefined}),executor=new AcceptedActionExecutor(control);
  const commitTarget=targets.write({projectId,targetId:'pilot-commit',revision:0,enabled:true,definition:{kind:'commit',repositoryId:projectId,branch},actor:{kind:'owner',identity:'fixture'}});
  const remote=await resolveLocalPushRemote({project,remoteId:'origin'});
  const pushTarget=targets.write({projectId,targetId:'pilot-push',revision:0,enabled:true,definition:{kind:'push',remoteId:remote.remoteId,repositoryDigest:remote.repositoryDigest,branch},actor:{kind:'owner',identity:'fixture'}});
  const policy=(mode:'full-auto'|'ask')=>({mode:'agent-may-accept' as const,actionClasses:{...defaultAcceptancePolicy().actionClasses,commit:mode,push:mode}});
  acceptance.updatePolicy({revision:0,policy:policy('full-auto'),actor:{kind:'owner',identity:'fixture'}});
  const targetCurrent=async(project:string,id:string,targetId:string,revision:number)=>{
    const target=targets.read(project,targetId);
    return target!==null&&target.enabled&&target.revision===revision&&id===session;
  };
  const commitService=new AcceptedCommitService({project,targetId:'pilot-commit',targetRevision:commitTarget.revision,workspace,acceptance,executor,targets,targetCurrent});
  const transport=new LocalGitPushTransport({projectFor:id=>id===projectId?project:undefined});
  const pushService=new AcceptedPushService({projectId,targetId:'pilot-push',targetRevision:pushTarget.revision,targets,acceptance,executor,transport,targetCurrent});
  const caller={projectId,sessionId:session,agentId:'agent',authorize:async()=>{}};
  const record=async(artifact:ArtifactIdentity)=>{
    const evidence=await acceptance.recordEvidence({projectId,evidence:{sessionId:session,subject:{kind:'session',id:session},artifact,commands:['node --test'],diff:{files:1,linesAdded:1,linesRemoved:1,text:'fixture claim',reference:null},tests:[{command:'node --test',outcome:'passed',output:'# tests 1\n# pass 1\n# fail 0\n# skipped 0',counts:{passed:1,failed:0,skipped:0}}],review:null,producedAt:'2026-01-01T00:00:00.000Z'}});
    return evidence.evidence.record.id;
  };
  const accept=async(evidenceId:string,artifact:ArtifactIdentity,actionClass:'commit'|'push')=>{
    const accepted=await acceptance.accept({authorizeAdmission:()=>{},projectId,request:{evidenceId,artifact,actionClass,actor:{kind:'agent',identity:'agent'}}});
    return accepted.acceptance.id;
  };
  return {root,worktree,remotePath,project,projectId,branch,base,control,targets,acceptance,executor,commitService,pushService,transport,remote,caller,record,accept,policy,cleanup:async()=>{control.close();await rm(root,{recursive:true,force:true});}};
}

async function harness(f: Awaited<ReturnType<typeof fixture>>,scopes:()=>readonly AgentScope[]) {
  const fake=fauxProvider({provider:'commit-push-faux',models:[{id:'fixture'}]}),providers=new ProviderStore(f.root,[fake.provider]);
  await providers.savePreferences({defaultModel:{provider:'commit-push-faux',modelId:'fixture'},favourites:[],allowRealModels:true});
  const host=new HarnessHost({dataRoot:f.root,enabled:true,providers,
    privileges:{authority:async()=>({agentId:'agent',model:null,scopes:scopes(),projects:[f.projectId],emptyReason:null})},
    acceptanceTools:{read:projectId=>f.acceptance.readProject({projectId}),accept:input=>acceptAgentEvidence(f.acceptance,{...input,verifyAdmission:()=>{}})},
    acceptedCommitTools:{preview:input=>f.commitService.preview(input),commit:input=>f.commitService.commit(input)},
    acceptedPushTools:{preview:input=>f.pushService.preview(input),push:input=>f.pushService.push(input)}
  });
  const settle=async(text:string)=>{
    const deadline=Date.now()+15000;
    for(;;){
      if((await host.view(f.project)).entries.some(entry=>entry.text.includes(text)))return;
      if(Date.now()>deadline)throw Error('the scripted run did not settle');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  return {fake,host,providers,settle,close:async()=>{await host.close();await providers.close();}};
}

test('a scripted model commits the exact staged tree and then pushes that commit to the local remote',async()=>{
  const f=await fixture(),scopes:AgentScope[]=['accept','commit','push'],h=await harness(f,()=>scopes);
  try{
    await writeFile(join(f.worktree,'a.txt'),'committed by the model\n');
    await git(f.worktree,'add','a.txt');
    const tree=await git(f.worktree,'write-tree');
    const preview=await f.commitService.preview(f.caller);
    assert.equal(preview.artifact.commit,f.base);assert.equal(preview.contentRevision,'tree-'+tree);
    const commitEvidence=await f.record(preview.artifact),commitAcceptance=await f.accept(commitEvidence,preview.artifact,'commit');
    h.fake.setResponses([
      ()=>fauxAssistantMessage([fauxToolCall('commit_preview',{})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage([fauxToolCall('commit_accepted',{evidenceId:commitEvidence,acceptanceId:commitAcceptance,artifact:preview.artifact})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage('Commit finished.')
    ]);
    await h.host.submit(f.project,{text:'Commit the staged tree',mode:'followUp'});
    await h.settle('Commit finished.');
    const commit=await git(f.worktree,'rev-parse','HEAD');
    assert.notEqual(commit,f.base,'the accepted tree became one commit on the Pilot branch');
    assert.equal(await git(f.worktree,'rev-parse','HEAD^{tree}'),tree,'the commit carries exactly the staged tree');
    assert.equal(await git(f.worktree,'rev-parse','HEAD^'),f.base,'its parent is the branch head that was accepted');
    assert.equal(await git(f.worktree,'symbolic-ref','HEAD'),f.branch);
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),f.base,'committing never pushes');
    assert.ok((await h.host.view(f.project)).entries.some(entry=>{
      try{return (JSON.parse(entry.text) as {status?:string}).status==='succeeded';}catch{return false;}
    }),'the durable receipt reports success');

    const pushPreview=await f.pushService.preview({...f.caller,commit});
    assert.equal(pushPreview.remoteHead,f.base);
    const pushEvidence=await f.record(pushPreview.artifact),pushAcceptance=await f.accept(pushEvidence,pushPreview.artifact,'push');
    h.fake.setResponses([
      ()=>fauxAssistantMessage([fauxToolCall('push_preview',{commit})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage([fauxToolCall('push_accepted',{evidenceId:pushEvidence,acceptanceId:pushAcceptance,artifact:pushPreview.artifact})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage('Push finished.')
    ]);
    await h.host.submit(f.project,{text:'Push the accepted commit',mode:'followUp'});
    await h.settle('Push finished.');
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),commit,'the local remote received exactly that commit');
    assert.equal(await git(f.worktree,'rev-parse','HEAD'),commit,'the push did not change the local branch');
  }finally{await h.close();await f.cleanup();}
});

test('a second identical commit is refused, and a revoked scope or a non-full-auto policy refuses',async()=>{
  const f=await fixture(),scopes:AgentScope[]=['accept','commit'],h=await harness(f,()=>scopes);
  try{
    await writeFile(join(f.worktree,'a.txt'),'one\n');await git(f.worktree,'add','a.txt');
    const preview=await f.commitService.preview(f.caller);
    const evidenceId=await f.record(preview.artifact),acceptanceId=await f.accept(evidenceId,preview.artifact,'commit');
    h.fake.setResponses([
      ()=>fauxAssistantMessage([fauxToolCall('commit_accepted',{evidenceId,acceptanceId,artifact:preview.artifact})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage('First commit done.')
    ]);
    await h.host.submit(f.project,{text:'Commit once',mode:'followUp'});
    await h.settle('First commit done.');
    const head=await git(f.worktree,'rev-parse','HEAD');
    assert.notEqual(head,f.base);
    // The same acceptance is one durable intent: a second call is refused and creates no commit.
    h.fake.setResponses([
      ()=>fauxAssistantMessage([fauxToolCall('commit_accepted',{evidenceId,acceptanceId,artifact:preview.artifact})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage('Repeat refused.')
    ]);
    await h.host.submit(f.project,{text:'Commit again',mode:'followUp'});
    await h.settle('Repeat refused.');
    assert.equal(await git(f.worktree,'rev-parse','HEAD'),head,'no second commit was created');
    // Revoking the scope refuses the tool at dispatch with no effect.
    scopes.length=0;
    h.fake.setResponses([
      ()=>fauxAssistantMessage([fauxToolCall('commit_preview',{})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage('Revoked scope checked.')
    ]);
    await h.host.submit(f.project,{text:'Try a revoked scope',mode:'followUp'});
    await h.settle('Revoked scope checked.');
    assert.match(JSON.stringify((await h.host.view(f.project)).entries),/refused|not permitted/i);
    assert.equal(await git(f.worktree,'rev-parse','HEAD'),head);
    // A class decision other than full-auto is refused even when the evidence was accepted earlier.
    // The acceptance is recorded under full-auto, and the owner then narrows the policy to `ask`.
    scopes.push('commit');
    await writeFile(join(f.worktree,'a.txt'),'two\n');await git(f.worktree,'add','a.txt');
    const asked=await f.commitService.preview(f.caller);
    const askedEvidence=await f.record(asked.artifact);
    const askedAcceptance=await f.accept(askedEvidence,asked.artifact,'commit');
    f.acceptance.updatePolicy({revision:1,policy:f.policy('ask'),actor:{kind:'owner',identity:'fixture'}});
    h.fake.setResponses([
      ()=>fauxAssistantMessage([fauxToolCall('commit_accepted',{evidenceId:askedEvidence,acceptanceId:askedAcceptance,artifact:asked.artifact})],{stopReason:'toolUse'}),
      ()=>fauxAssistantMessage('Policy refusal checked.')
    ]);
    await h.host.submit(f.project,{text:'Commit under ask',mode:'followUp'});
    await h.settle('Policy refusal checked.');
    assert.equal(await git(f.worktree,'rev-parse','HEAD'),head,'a non-full-auto policy created no commit');
    assert.match(JSON.stringify((await h.host.view(f.project)).entries),/could not be confirmed/i);
  }finally{await h.close();await f.cleanup();}
});

test('a lost push receipt stays uncertain, is not replayed, and an artifact from another commit is refused',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.worktree,'a.txt'),'pushed once\n');await git(f.worktree,'add','a.txt');
    const commitPreview=await f.commitService.preview(f.caller);
    const commitEvidence=await f.record(commitPreview.artifact),commitAcceptance=await f.accept(commitEvidence,commitPreview.artifact,'commit');
    const committed=await f.commitService.commit({...f.caller,evidenceId:commitEvidence,acceptanceId:commitAcceptance,artifact:commitPreview.artifact});
    assert.equal(committed.status,'succeeded');if(committed.status!=='succeeded')return;
    const commit=committed.receipt.externalId;
    const pushPreview=await f.pushService.preview({...f.caller,commit});
    const pushEvidence=await f.record(pushPreview.artifact),pushAcceptance=await f.accept(pushEvidence,pushPreview.artifact,'push');
    // A transport that performs the real push and then loses its receipt: the effect happened and the
    // service cannot know it, so the durable intent must stay uncertain and must never be replayed.
    let pushes=0;
    const losing:ExactPushTransport={inspect:input=>f.transport.inspect(input),push:async input=>{pushes++;await f.transport.push(input);throw new Error('receipt lost');}};
    const service=new AcceptedPushService({projectId:f.projectId,targetId:'pilot-push',targetRevision:1,targets:f.targets,acceptance:f.acceptance,executor:f.executor,transport:losing,targetCurrent:async()=>true});
    const result=await service.push({...f.caller,evidenceId:pushEvidence,acceptanceId:pushAcceptance,artifact:pushPreview.artifact});
    assert.equal(result.status,'uncertain');
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),commit,'the uncertain push really did reach the local remote');
    await assert.rejects(service.push({...f.caller,evidenceId:pushEvidence,acceptanceId:pushAcceptance,artifact:pushPreview.artifact}),/already has an action intent/);
    assert.equal(pushes,1,'the uncertain effect was not replayed');
    await assert.rejects(f.pushService.push({...f.caller,evidenceId:pushEvidence,acceptanceId:pushAcceptance,artifact:pushPreview.artifact}),/already has an action intent/);
    // An artifact that names a different commit is refused before any push.
    await assert.rejects(f.pushService.push({...f.caller,evidenceId:pushEvidence,acceptanceId:pushAcceptance,artifact:{...pushPreview.artifact,commit:f.base}}),/does not bind this exact action target|accepted push must name a commit/);
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),commit);
  }finally{await f.cleanup();}
});

test('a moved remote refuses the next push before any intent, and no branch is changed',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.worktree,'a.txt'),'first\n');await git(f.worktree,'add','a.txt');
    const firstPreview=await f.commitService.preview(f.caller);
    const firstEvidence=await f.record(firstPreview.artifact),firstAcceptance=await f.accept(firstEvidence,firstPreview.artifact,'commit');
    const committed=await f.commitService.commit({...f.caller,evidenceId:firstEvidence,acceptanceId:firstAcceptance,artifact:firstPreview.artifact});
    assert.equal(committed.status,'succeeded');if(committed.status!=='succeeded')return;
    const first=committed.receipt.externalId;
    const firstPushPreview=await f.pushService.preview({...f.caller,commit:first});
    const firstPushEvidence=await f.record(firstPushPreview.artifact),firstPushAcceptance=await f.accept(firstPushEvidence,firstPushPreview.artifact,'push');
    const pushed=await f.pushService.push({...f.caller,evidenceId:firstPushEvidence,acceptanceId:firstPushAcceptance,artifact:firstPushPreview.artifact});
    assert.equal(pushed.status,'succeeded');
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),first);
    await writeFile(join(f.worktree,'a.txt'),'second\n');await git(f.worktree,'add','a.txt');
    const secondPreview=await f.commitService.preview(f.caller);
    const secondEvidence=await f.record(secondPreview.artifact),secondAcceptance=await f.accept(secondEvidence,secondPreview.artifact,'commit');
    const secondCommitted=await f.commitService.commit({...f.caller,evidenceId:secondEvidence,acceptanceId:secondAcceptance,artifact:secondPreview.artifact});
    assert.equal(secondCommitted.status,'succeeded');if(secondCommitted.status!=='succeeded')return;
    const second=secondCommitted.receipt.externalId;
    const secondPushPreview=await f.pushService.preview({...f.caller,commit:second});
    assert.equal(secondPushPreview.remoteHead,first);
    const secondPushEvidence=await f.record(secondPushPreview.artifact),secondPushAcceptance=await f.accept(secondPushEvidence,secondPushPreview.artifact,'push');
    // A competing commit reaches the remote branch first.
    await git(f.worktree,'checkout','-q','--detach',first);
    await writeFile(join(f.worktree,'a.txt'),'competing\n');await git(f.worktree,'add','a.txt');await git(f.worktree,'commit','-q','-m','competing');
    const competitor=await git(f.worktree,'rev-parse','HEAD');
    await git(f.worktree,'push','-q','--no-verify','--',f.remotePath,competitor+':'+f.branch);
    await git(f.worktree,'checkout','-q','work/pilot-'+f.projectId.slice(0,8));
    await assert.rejects(
      f.pushService.push({...f.caller,evidenceId:secondPushEvidence,acceptanceId:secondPushAcceptance,artifact:secondPushPreview.artifact}),
      /not at the accepted commit\u2019s parent/
    );
    assert.equal(await git(f.remotePath,'rev-parse',f.branch),competitor,'the refused push did not move the remote branch');
  }finally{await f.cleanup();}
});
