/** Set continuous agent runs on a stopped instance without bypassing its settings store. */
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireServiceLock } from '../src/server/service-lock';
import { HarnessSettingsStore } from '../src/server/harness-settings-store';

export async function setContinuousHarness(dataRoot:string,expectedRevision:number,turnLimit=0) {
 if(!Number.isInteger(turnLimit)||turnLimit<0||turnLimit>300)throw new Error('Turn limit must be between 0 and 300.');
 const info=await lstat(dataRoot);
 if(!info.isDirectory()||info.isSymbolicLink())throw new Error('The data root must be a real directory.');
 const root=await realpath(dataRoot);
 const lock=await acquireServiceLock({root,rootId:createHash('sha256').update(root).digest('hex').slice(0,16),releaseId:'operator-continuous',schemaId:'pilot-state-1',purpose:'service'});
 let settings:HarnessSettingsStore|undefined;
 try {
  const paused=await lstat(resolve(root,'RESTORE-PAUSED.json')).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  if(paused)throw new Error('The data root is a paused restore; settings were not changed.');
  const file=await lstat(resolve(root,'settings/harness.json'));
  if(!file.isFile()||file.isSymbolicLink())throw new Error('The existing harness settings must be a regular file.');
  settings=new HarnessSettingsStore(root,{codingTools:true,shell:true,fileEdit:true},40);
  const current=await settings.view();
  if(current.revision!==expectedRevision)throw new Error('The harness settings revision changed; nothing was written.');
  return await settings.update({revision:expectedRevision,settings:{preferences:{...current.settings.preferences,maxModelTurns:turnLimit},capabilities:current.settings.capabilities}});
 } finally {try {await settings?.drain();} finally {await lock.release();}}
}
async function main(){
 const [root,revision,limit,execute,...rest]=process.argv.slice(2);
 if(!root||!revision||!/^\d+$/.test(revision)||!limit||!/^\d+$/.test(limit)||execute!=='--execute'||rest.length)throw new Error('Usage: continuous-harness <data-root> <expected-revision> <turn-limit> --execute');
 const result=await setContinuousHarness(root,Number(revision),Number(limit));
 console.log(JSON.stringify({revision:result.revision,maxModelTurns:result.effective.maxModelTurns}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error((error as Error).message);process.exitCode=1;});
