import { randomUUID } from 'node:crypto';
import { lstat,realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../shared/model';
import { parseBoard } from '../shared/markdown';
import { PLAN_PATH,isWorkspacePath } from '../shared/workspace';
import type { RemoteReview,RemoteApplied } from '../shared/remote';
import { HttpError } from './board-store';
import { safePath } from './paths';
import type { RepositoryStore } from './repositories';
import type { WorkspaceStore } from './workspace';
type Review={projectId:string;repository:string;key:string|null;ref:string;base:string;tree:string|null;expires:number;view:RemoteReview};
const oid=/^[a-f0-9]{40,64}$/;
/** Owner-only fixed workflows. Tokens are ephemeral, one-use and never replayed after restart. */
export class RemoteStore {
 private busy=new Set<string>();private reviews=new Map<string,Review>();
 constructor(private repositories:Pick<RepositoryStore,'view'|'fetchDefault'>,private workspace:WorkspaceStore,private prepare:(p:Project)=>Promise<void>,private now=()=>Date.now()){}
 isBusy(id:string){return this.busy.has(id);}
 private async exclusive<T>(p:Project,work:()=>Promise<T>){
  if(this.busy.has(p.id))throw new HttpError(409,'A repository review or update is already in progress');
  this.busy.add(p.id);
  try{return await this.workspace.exclusive(p,async()=>{await this.prepare(p);return work();});}
  catch(e){if(e instanceof HttpError)throw e;throw new HttpError(422,'Repository review failed within the Git safety limits. No command output is exposed. Inspect local history and files before retrying.');}
  finally{this.busy.delete(p.id);}
 }
 private git(p:Project,args:string[]){return this.workspace.localGit(p,args);}
 private async configKeys(p:Project,pattern:string){try{return (await this.git(p,['config','--null','--name-only','--get-regexp',pattern])).split('\0').filter(Boolean);}catch(e){if((e as {code?:number}).code===1)return [];throw e;}}
 private async identity(p:Project){
  if(!(await this.repositories.view(p)).connected)throw new HttpError(409,'Connect a managed GitHub repository before checking remote changes');
  if(await realpath((await this.git(p,['rev-parse','--show-toplevel'])).trim())!==await realpath(p.path))throw new HttpError(409,'The connected repository root changed');
  if((await this.git(p,['symbolic-ref','HEAD'])).trim()!=='refs/heads/work/pilot-'+p.id.slice(0,8))throw new HttpError(409,'Restore this project’s Pilot working branch before checking remote changes. No branch was switched.');
  if((await this.configKeys(p,'^(url\\..*\\.(insteadof|pushinsteadof)|core\\.alternaterefscommand)$')).length)throw new HttpError(409,'Repository URL rewrites or alternate-ref commands are unsupported. Ask an operator to review the configuration.');
  return (await this.git(p,['rev-parse','--verify','HEAD'])).trim();
 }
 private async cleanReason(p:Project):Promise<string>{
  for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REBASE_HEAD','rebase-merge','rebase-apply','index.lock','HEAD.lock']){
   const path=(await this.git(p,['rev-parse','--path-format=absolute','--git-path',name])).trim();
   try{await lstat(path);return 'A Git operation or lock is present. Operator review is required.';}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  if((await this.configKeys(p,'^merge\\..*\\.driver$')).length)return 'Custom merge drivers are unsupported. Review externally.';
  if((await this.git(p,['ls-files','-v','-z'])).split('\0').some(row=>row&&row[0]!=='H'))return 'Special index flags or unresolved entries require operator review.';
  if((await this.git(p,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none'])).length)return 'Uncommitted or staged files must be reviewed and committed first. No stash or reset is performed.';
  return '';
 }
 private async entry(p:Project,tree:string,path:string){
  const row=(await this.git(p,['ls-tree','-z',tree,'--',path])).split('\0').filter(Boolean);
  if(row.length>1)throw new HttpError(409,'Unsafe repository tree entry');
  return row[0]?.match(/^(\d+) (?:blob|tree|commit) ([a-f0-9]+)\t/)?.[1]??null;
 }
 private async entries(p:Project,tree:string,paths:string[]){
  if(Buffer.byteLength(paths.join('\0'))>120*1024)throw new HttpError(413,'Changed paths exceed the review argument limit');
  const result=new Map<string,string>();
  if(!paths.length)return result;
  for(const row of (await this.git(p,['ls-tree','-r','-z',tree,'--',...paths])).split('\0')){const match=/^(\d+) (?:blob|commit) [a-f0-9]+\t([\s\S]+)$/.exec(row);if(match)result.set(match[2],match[1]);}
  return result;
 }
 private async resultReason(p:Project,head:string,tree:string){
  const paths=(await this.git(p,['diff','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=none','--name-only','-z',head,tree])).split('\0').filter(Boolean);
  if(paths.length>5000)return 'The update exceeds the 5,000-path review limit. Review it externally.';
  const beforeEntries=await this.entries(p,head,paths),afterEntries=await this.entries(p,tree,paths);
  for(const path of paths){
   const before=beforeEntries.get(path)??null,after=afterEntries.get(path)??null;
   if([before,after].some(mode=>mode!==null&&!['100644','100755'].includes(mode)))return 'Changed symlinks, submodules or file/directory transitions require external review.';
   let file:string;try{file=await safePath(p.path,path);}catch{return 'A changed path is unsafe or crosses a symlink. Review it externally.';}
   try{const info=await lstat(file);if(!info.isFile())return 'A changed path is a symlink or directory. Review it externally.';
    if(!before&&after)return 'An untracked or ignored file would be overwritten. Preserve it before updating.';
   }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  try{
   if(!['100644','100755'].includes(await this.entry(p,tree,PLAN_PATH)??''))return 'The update must retain a regular, valid canonical plan. Review it externally.';
   parseBoard(await this.git(p,['show',tree+':'+PLAN_PATH]));
  }catch{return 'The resulting canonical plan is invalid or exceeds the safety limit. No workspace update is allowed.';}
  return '';
 }
 async check(p:Project):Promise<RemoteReview>{
  return this.exclusive(p,async()=>{
   for(const[token,item]of this.reviews)if(item.expires<=this.now()||item.projectId===p.id)this.reviews.delete(token);
   if(this.reviews.size>=20)throw new HttpError(429,'Too many pending repository reviews');
   const head=await this.identity(p),key=(await this.repositories.view(p)).fingerprint;
   const {branch,target,ref}=await this.repositories.fetchDefault(p);
   if(!oid.test(head)||!oid.test(target))throw new HttpError(409,'Unsupported commit identity');
   if(await this.identity(p)!==head)throw new HttpError(409,'Local history changed during the check. Review it and check again.');
   let base:string;try{base=(await this.git(p,['merge-base',head,target])).trim();}catch{throw new HttpError(409,'The histories have no common ancestor. Review externally; no merge or reset was attempted.');}
   const counts=(await this.git(p,['rev-list','--left-right','--count',head+'...'+target])).trim().split(/\s+/).map(Number),[ahead,behind]=counts;
   if(counts.length!==2||counts.some(n=>!Number.isSafeInteger(n)||n<0))throw new HttpError(422,'Invalid history summary');
   const allPaths=(await this.git(p,['diff','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=none','--name-only','-z',base,target])).split('\0').filter(Boolean);
   if(allPaths.length>5000)throw new HttpError(413,'Incoming changes exceed the 5,000-path review limit');
   const records=(await this.git(p,['log','-21','--no-show-signature','--format=%H%x00%s','-z',head+'..'+target])).split('\0'),commits:{hash:string;subject:string}[]=[];
   for(let i=0;i+1<records.length;i+=2)if(oid.test(records[i]))commits.push({hash:records[i],subject:records[i+1].slice(0,300)});
   let mode:RemoteReview['mode']=behind===0?'up-to-date':ahead===0?'fast-forward':'merge',tree:string|null=target;
   let reason=await this.cleanReason(p);
   if(mode==='merge'){
    if((await this.configKeys(p,'^merge\\..*\\.driver$')).length){mode='blocked';tree=null;reason='Custom merge drivers are unsupported. Review the merge externally.';}
    else try{tree=(await this.git(p,['merge-tree','--write-tree',head,target])).trim();if(!oid.test(tree))throw Error('Invalid merge tree');}
    catch(e){if((e as {code?:number}).code===1){mode='conflict';tree=null;reason='The proposed merge conflicts. No working files, index or branch were changed. Review externally.';}else throw e;}
   }
   if(tree&&mode!=='up-to-date'){const unsafe=await this.resultReason(p,head,tree);if(unsafe)reason=unsafe;}
   const resultAvailable=tree!==null&&mode!=='up-to-date';
   const resultPaths=resultAvailable?(await this.git(p,['diff','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=none','--name-only','-z',head,tree!])).split('\0').filter(Boolean):[];
   if(resultPaths.length>5000)throw new HttpError(413,'The proposed result exceeds the 5,000-path review limit');
   const canApply=(mode==='fast-forward'||mode==='merge')&&!reason;
   const token=randomUUID(),expires=this.now()+10*60*1000;
   const view:RemoteReview={token,checkedAt:new Date(this.now()).toISOString(),expiresAt:new Date(expires).toISOString(),branch,head,target,ahead,behind,mode,canApply,
    message:reason||(mode==='up-to-date'?'The Pilot branch already contains the fetched remote default branch.':mode==='merge'?'Local and remote commits diverged. Review and explicitly approve a two-parent merge.':'Review and explicitly approve this fast-forward update.'),
    commits:commits.slice(0,20),commitsTruncated:commits.length>20,paths:allPaths.filter(isWorkspacePath),totalPaths:allPaths.length,resultPaths:resultPaths.filter(isWorkspacePath),totalResultPaths:resultPaths.length,resultAvailable};
   this.reviews.set(token,{projectId:p.id,repository:p.repository,key,ref,base,tree,expires,view});return view;
  });
 }
 private review(p:Project,token:string){const item=this.reviews.get(token);if(!item||item.projectId!==p.id||item.repository!==p.repository||item.expires<=this.now())throw new HttpError(409,'Repository review expired or is unavailable. Check remote changes again.');return item;}
 async diff(p:Project,token:string,path:string,comparison:'incoming'|'result'='incoming'){
  const item=this.review(p,token),result=comparison==='result';
  if(result&&!item.view.resultAvailable)throw new HttpError(409,'No proposed result is available in this review');
  if(!isWorkspacePath(path)||!(result?item.view.resultPaths:item.view.paths).includes(path))throw new HttpError(403,'Path is not previewable in this review');
  try{return {path,diff:await this.git(p,['diff','--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=none',result?item.view.head:item.base,result?item.tree!:item.view.target,'--',path])};}
  catch{throw new HttpError(422,'Incoming diff is unavailable or exceeds the preview limit');}
 }
 async apply(p:Project,token:string):Promise<RemoteApplied>{
  return this.exclusive(p,async()=>{
   const item=this.review(p,token),view=item.view;
   // A confirmed attempt consumes its review before any consequential command, even on refusal.
   this.reviews.delete(token);
   if(!view.canApply||!item.tree||!['fast-forward','merge'].includes(view.mode))throw new HttpError(409,'This review cannot be applied. Resolve its blockers and check again.');
   const head=await this.identity(p);
   if(head!==view.head||(await this.git(p,['rev-parse','--verify',item.ref+'^{commit}'])).trim()!==view.target||(await this.repositories.view(p)).fingerprint!==item.key)throw new HttpError(409,'History, remote target or deploy key changed since review. Check again.');
   const reason=await this.cleanReason(p)||await this.resultReason(p,head,item.tree);
   if(reason)throw new HttpError(409,reason+' Check again after review.');
   if((await this.configKeys(p,'^merge\\..*\\.driver$')).length)throw new HttpError(409,'Custom merge drivers are unsupported. Review externally.');
   let target=view.target;
   if(view.mode==='merge'){
    target=(await this.git(p,['-c','user.name=Pilot','-c','user.email=pilot@localhost','commit-tree',item.tree,'-p',head,'-p',view.target,'-m','Merge reviewed remote default branch'])).trim();
    if(!oid.test(target))throw new HttpError(422,'Git did not confirm the reviewed merge identity. No branch update was attempted.');
   }
   // Native ff-only performs the index/worktree transaction. A prepared merge has both
   // reviewed parents; this checkout never recomputes a merge or invokes a merge driver.
   try{
    if(await this.identity(p)!==head||await this.cleanReason(p))throw new HttpError(409,'Local state changed before update. Review it and check again.');
    await this.git(p,['merge','--ff-only','--no-edit','--no-verify','--no-gpg-sign',target]);
    if((await this.git(p,['rev-parse','HEAD'])).trim()!==target)throw Error('Unconfirmed head');
   }catch(e){if(e instanceof HttpError)throw e;throw new HttpError(409,'Workspace update is unconfirmed. Inspect local history, index and files before any fresh review. No automatic retry or rollback occurred.');}
   return {head:target,mode:view.mode as RemoteApplied['mode'],message:view.mode==='merge'?'Reviewed merge committed locally. No push occurred.':'Workspace fast-forward confirmed. No push occurred.'};
  });
 }
}
