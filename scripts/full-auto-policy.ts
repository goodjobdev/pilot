/** Offline, revision-checked operator switch for the acceptance policy. */
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireServiceLock } from '../src/server/service-lock';
import { ControlStore } from '../src/server/state/control-store';
import { AcceptanceStore } from '../src/server/state/acceptance-store';
import { ACCEPTANCE_ACTION_CLASSES } from '../src/shared/acceptance';

/** The caller must be an operator with access to the stopped instance's data root. */
export async function setFullAutoPolicy(dataRoot:string,revision:number,actor:string) {
  const rootInfo=await lstat(dataRoot);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error('The data root must be a real directory; policy was not changed.');
  const root=await realpath(dataRoot);
  const paused=await lstat(resolve(root,'RESTORE-PAUSED.json')).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  if(paused)throw new Error('The data root is a paused restore; policy was not changed.');
  const db=await lstat(resolve(root,'control.sqlite'));
  if(!db.isFile()||db.isSymbolicLink())throw new Error('The control store must already exist as a regular file; policy was not changed.');
  const lock=await acquireServiceLock({root,rootId:createHash('sha256').update(root).digest('hex').slice(0,16),releaseId:'operator-policy',schemaId:'pilot-state-1',purpose:'service'});
  let store:ControlStore|undefined;
  try {
    const marker=await lstat(resolve(root,'RESTORE-PAUSED.json')).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
    if(marker)throw new Error('The data root is a paused restore; policy was not changed.');
    store=new ControlStore(root);
    const acceptance=new AcceptanceStore(store,{projectRoot:()=>undefined});
    const current=acceptance.readPolicy();
    if(current.revision!==revision)throw new Error('The policy revision changed; no policy was written.');
    const actionClasses=Object.fromEntries(ACCEPTANCE_ACTION_CLASSES.map(name=>[name,'full-auto']));
    return acceptance.updatePolicy({revision,policy:{mode:'agent-may-accept',actionClasses},actor:{kind:'owner',identity:actor}});
  } finally { try {store?.close();} finally {await lock.release();} }
}

async function main(){
  const [root,revision,actor,execute,...extra]=process.argv.slice(2);
  if(!root||!revision||!actor||execute!=='--execute'||extra.length||!/^\d+$/.test(revision))
    throw new Error('Usage: full-auto-policy <data-root> <expected-revision> <owner-identity> --execute');
  const result=await setFullAutoPolicy(root,Number(revision),actor);
  console.log(JSON.stringify({revision:result.revision,mode:result.mode,actionClasses:result.actionClasses,updatedBy:result.updatedBy}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error((error as Error).message);process.exitCode=1;});
