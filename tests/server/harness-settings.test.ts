import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessSettingsStore } from '../../src/server/harness-settings-store';
import { HttpError } from '../../src/server/board-store';
import { MAX_MODEL_TURNS_CEILING,MAX_OUTPUT_TOKENS_CEILING,effectiveCapabilities } from '../../src/shared/harness-settings';

/**
 * The owner's harness settings: preferences that apply at the next request, and capabilities that
 * can only ever be narrowed by this file.
 *
 * The rule under test is the one that matters for safety: a deployment that did not offer a
 * capability cannot be made to offer it here, and a stale revision changes nothing.
 */
async function store(t:{after:(fn:()=>Promise<void>)=>void}){
  const root=await mkdtemp(join(tmpdir(),'pilot-harness-settings-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,store:new HarnessSettingsStore(root,{codingTools:true,shell:false,fileEdit:true},40)};
}
test('the bound and the default thinking level are stored, revision-checked and applied',async t=>{
  const {store:s}=await store(t);
  const first=await s.view();
  assert.equal(first.revision,1);assert.equal(first.settings.preferences.maxModelTurns,40);assert.equal(first.settings.preferences.defaultThinking,null);
  const saved=await s.update({revision:1,settings:{preferences:{maxModelTurns:300,maxOutputTokens:8000,defaultThinking:'high'},capabilities:{codingTools:true,shell:true,fileEdit:true}}});
  assert.equal(saved.revision,2);assert.equal(await s.maxModelTurns(),300);assert.equal(await s.maxOutputTokens(),8000);assert.equal(await s.defaultThinking(),'high');
  assert.equal((await s.view()).settings.preferences.maxModelTurns,MAX_MODEL_TURNS_CEILING,'300 is the ceiling and is accepted');
  // A stale revision is a conflict that writes nothing, and an out-of-range bound is refused.
  await assert.rejects(()=>s.update({revision:1,settings:{preferences:{maxModelTurns:10,maxOutputTokens:8000,defaultThinking:null},capabilities:{codingTools:true,shell:true,fileEdit:true}}}),(error:Error)=>error instanceof HttpError&&error.status===409);
  assert.equal(await s.maxModelTurns(),300,'the conflict left the stored value alone');
  await assert.rejects(()=>s.update({revision:2,settings:{preferences:{maxModelTurns:MAX_MODEL_TURNS_CEILING+1,maxOutputTokens:8000,defaultThinking:null},capabilities:{codingTools:true,shell:true,fileEdit:true}}}));
  await assert.rejects(()=>s.update({revision:2,settings:{preferences:{maxModelTurns:0,maxOutputTokens:8000,defaultThinking:null},capabilities:{codingTools:true,shell:true,fileEdit:true}}}));
  await assert.rejects(()=>s.update({revision:2,settings:{preferences:{maxModelTurns:5,maxOutputTokens:8000,defaultThinking:'enormous'},capabilities:{codingTools:true,shell:true,fileEdit:true}}}));
  assert.equal(await s.maxModelTurns(),300,'a refused write changed nothing');
  // The output bound is bounded in the same way, and the ceiling is refused rather than clamped.
  await assert.rejects(()=>s.update({revision:2,settings:{preferences:{maxModelTurns:300,maxOutputTokens:MAX_OUTPUT_TOKENS_CEILING+1,defaultThinking:null},capabilities:{codingTools:true,shell:true,fileEdit:true}}}));
  assert.equal(await s.maxOutputTokens(),8000,'an over-ceiling write changed nothing');
});
test('a capability the deployment does not offer cannot be switched on here',async t=>{
  const {store:s}=await store(t);
  const before=await s.view();
  assert.equal(before.effective.capabilities.shell.deployed,false);
  assert.equal(before.effective.capabilities.shell.enabled,false,'the deployment switch is the ceiling');
  const saved=await s.update({revision:1,settings:{preferences:{maxModelTurns:40,maxOutputTokens:8000,defaultThinking:null},capabilities:{codingTools:true,shell:true,fileEdit:true}}});
  assert.equal(saved.settings.capabilities.shell,true,'the owner asked for it');
  assert.equal(saved.effective.capabilities.shell.enabled,false,'and it is still off, because the deployment does not offer it');
  assert.equal(await s.capability('shell'),false);
  // Narrowing a capability the deployment does offer takes effect immediately.
  const off=await s.update({revision:saved.revision,settings:{preferences:{maxModelTurns:40,maxOutputTokens:8000,defaultThinking:null},capabilities:{codingTools:false,shell:false,fileEdit:false}}});
  assert.equal(off.effective.capabilities.codingTools.enabled,false);assert.equal(await s.capability('codingTools'),false);
  assert.equal(await s.capability('fileEdit'),false);
});
test('the effective state always reports both sides, so neither can be guessed at',()=>{
  const state=effectiveCapabilities({codingTools:true,shell:true,fileEdit:false},{codingTools:false,shell:true,fileEdit:true});
  assert.deepEqual(state.codingTools,{deployed:true,allowed:false,enabled:false});
  assert.deepEqual(state.shell,{deployed:true,allowed:true,enabled:true});
  assert.deepEqual(state.fileEdit,{deployed:false,allowed:true,enabled:false});
});
test('the settings file is private, and a fresh instance starts from its own deployment bound',async t=>{
  const {root,store:s}=await store(t);
  await s.update({revision:1,settings:{preferences:{maxModelTurns:12,maxOutputTokens:8000,defaultThinking:null},capabilities:{codingTools:true,shell:true,fileEdit:true}}});
  const info=await stat(join(root,'settings/harness.json'));
  assert.equal(info.mode&0o077,0,'the harness settings file is not world-readable');
  const other=new HarnessSettingsStore(root,{codingTools:false,shell:false,fileEdit:false},7);
  const view=await other.view();
  assert.equal(view.settings.preferences.maxModelTurns,12,'the stored value is read, not the new bound');
  assert.equal(view.effective.capabilities.codingTools.enabled,false,'a different deployment narrows the same stored intent');
});
