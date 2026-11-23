import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessSettingsStore} from '../../src/server/harness-settings-store';
import {setContinuousHarness} from '../../scripts/continuous-harness';

test('continuous mode preserves other settings, checks revision, and refuses a live or paused root',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-continuous-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new HarnessSettingsStore(root,{codingTools:true,shell:true,fileEdit:true},40);
 const saved=await store.update({revision:1,settings:{preferences:{maxModelTurns:12,maxOutputTokens:8000,defaultThinking:null},capabilities:{codingTools:true,shell:false,fileEdit:true}}});await store.drain();
 await writeFile(join(root,'service.lock'),'held');await assert.rejects(()=>setContinuousHarness(root,saved.revision),/exist/i);await unlink(join(root,'service.lock'));
 await writeFile(join(root,'RESTORE-PAUSED.json'),'{}');await assert.rejects(()=>setContinuousHarness(root,saved.revision),/paused restore/i);await unlink(join(root,'RESTORE-PAUSED.json'));
 await assert.rejects(()=>setContinuousHarness(root,1),/revision changed/);
 const result=await setContinuousHarness(root,saved.revision);assert.equal(result.settings.preferences.maxModelTurns,0);assert.equal(result.settings.preferences.maxOutputTokens,8000);assert.equal(result.settings.capabilities.shell,false);
 const restored=await setContinuousHarness(root,result.revision,12);assert.equal(restored.settings.preferences.maxModelTurns,12);
});
