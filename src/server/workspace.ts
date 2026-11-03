import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat,readFile,readdir,realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../shared/model';
import { isWorkspacePath,isWorkspaceImagePath,type SaveCommit,type WorkspaceState,type WorkspaceDocument } from '../shared/workspace';
import { safePath } from './paths';
import { hash,HttpError } from './board-store';
const exec=promisify(execFile);
const maxBytes=2*1024*1024;
/** Fixed local Git operations only. No shell, remote access, hooks, signing or configured filters. */
export class WorkspaceStore {
 private tails=new Map<string,Promise<unknown>>();
 private async serial<T>(id:string,fn:()=>Promise<T>):Promise<T>{const prev=this.tails.get(id)??Promise.resolve(),next=prev.catch(()=>{}).then(fn);this.tails.set(id,next);try{return await next;}finally{if(this.tails.get(id)===next)this.tails.delete(id);}}
 async drain(){await Promise.allSettled([...this.tails.values()]);}
 /** Server-internal fixed Git workflows share the same lock as disk saves and commits. */
 async exclusive<T>(p:Project,work:()=>Promise<T>){return this.serial(p.id,work);}
 async localGit(p:Project,args:string[]){return this.git(p,args);}
 private env(){return {PATH:process.env.PATH,HOME:'/nonexistent',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'};}
 private base(p:Project){return ['--no-pager','-C',p.path,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','submodule.recurse=false','-c','diff.ignoreSubmodules=all','-c','status.submoduleSummary=false','-c','commit.status=false','-c','commit.gpgSign=false','-c','tag.gpgSign=false','-c','core.pager=cat','-c','core.attributesFile=/dev/null','-c','merge.autoStash=false','-c','merge.verifySignatures=false','-c','diff.external=','-c','maintenance.auto=false','-c','gc.auto=0','-c','protocol.allow=never','-c','protocol.ssh.allow=never','-c','protocol.https.allow=never','-c','protocol.http.allow=never','-c','protocol.git.allow=never','-c','protocol.file.allow=never','-c','protocol.ext.allow=never'];}
 private async command(p:Project,args:string[],extra:string[]=[]){
  const {stdout}=await exec('git',[...this.base(p),...extra,...args],{env:this.env(),encoding:'buffer',timeout:10000,maxBuffer:4*1024*1024});
  const text=stdout.toString('utf8');if(!Buffer.from(text,'utf8').equals(stdout))throw Error('Git output is not valid UTF-8');return text;
 }
 private async root(p:Project):Promise<boolean>{
  try{const meta=await lstat(join(p.path,'.git'));if(meta.isSymbolicLink())return false;if(!meta.isFile()&&!meta.isDirectory())return false;
   const top=(await this.command(p,['rev-parse','--show-toplevel'])).trim();return await realpath(top)===await realpath(p.path);
  }catch{return false;}
 }
 /** Disable every configured clean/process/smudge filter, including repository-local definitions.
  * --no-ext-diff/--no-textconv alone do not stop clean filters during worktree comparisons.
  */
 private async filters(p:Project):Promise<string[]>{
  let keys:string;try{keys=await this.command(p,['config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process|required)$']);}
  catch(e){if((e as {code?:number}).code===1)return [];throw e;}
  const names=new Set(keys.split('\0').filter(Boolean).map(k=>k.replace(/\.(clean|smudge|process|required)$/,'')));
  if(names.size>100)throw Error('Too many filters');
  return [...names].flatMap(n=>['-c',n+'.clean=','-c',n+'.smudge=','-c',n+'.process=','-c',n+'.required=false']);
 }
 private async git(p:Project,args:string[]){return this.command(p,args,await this.filters(p));}
 private path(value:string){if(!isWorkspacePath(value))throw new HttpError(403,'This path is not available in the project text viewer');return value;}
 async read(p:Project,value:string):Promise<WorkspaceDocument>{
  const path=this.path(value),file=await safePath(p.path,path);let info;try{info=await lstat(file);}catch{throw new HttpError(404,'File not found');}
  if(!info.isFile())throw new HttpError(404,'File not found');if(info.size>maxBytes)throw new HttpError(413,'File exceeds the text preview limit');
  const bytes=await readFile(file);if(bytes.length>maxBytes)throw new HttpError(413,'File exceeds the text preview limit');
  if(bytes.includes(0))throw new HttpError(415,'Binary files cannot be shown as text');
  const text=bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(bytes))throw new HttpError(415,'Only valid UTF-8 text can be previewed');return {path,text,revision:hash(text)};
 }
 async state(p:Project):Promise<WorkspaceState>{
  const files:{path:string;bytes:number}[]=[],changes:{path:string;status:string}[]=[];let truncated=false,visited=0;
  const walk=async(dir:string)=>{for(const e of await readdir(dir?join(p.path,dir):p.path,{withFileTypes:true})){
   if(++visited>15000||files.length>=5000){truncated=true;return;}
   const path=dir?dir+'/'+e.name:e.name;if(e.isSymbolicLink())continue;
   if(e.isDirectory()){if(isWorkspacePath(path+'/file.txt'))await walk(path);}
   else if(e.isFile()&&isWorkspacePath(path)){const info=await lstat(await safePath(p.path,path));files.push({path,bytes:info.size});}
  }};
  await walk('');files.sort((a,b)=>a.path.localeCompare(b.path));
  if(!await this.root(p))return {files,changes,commits:[],git:false,branch:null,message:'Git history is unavailable. Connect a repository to commit saves.',truncated};
  try{
   const raw=await this.git(p,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all']),items=raw.split('\0');
   for(let i=0;i<items.length;i++){const row=items[i];if(!row)continue;if(changes.length>=5000){truncated=true;break;}const status=row.slice(0,2),path=row.slice(3);if(isWorkspacePath(path))changes.push({path,status});if(/[RC]/.test(status)){const old=items[++i];if(old&&isWorkspacePath(old))changes.push({path:old,status:'D '});}}
   let commits:{hash:string;subject:string}[]=[];
   let hasHead=false;try{await this.git(p,['rev-parse','--verify','HEAD']);hasHead=true;}catch{/* An unborn repository has no commits. */}
   if(hasHead){const fields=(await this.git(p,['log','-12','--no-show-signature','--format=%H%x00%s','-z'])).split('\0');for(let i=0;i+1<fields.length;i+=2)if(/^[a-f0-9]{40,64}$/.test(fields[i]))commits.push({hash:fields[i],subject:fields[i+1].slice(0,300)});}
   let branch:string|null=null;try{branch=(await this.git(p,['symbolic-ref','--short','HEAD'])).trim();}catch{/* detached HEAD is read-only for automatic commits */}
   return {files,changes,commits,git:true,branch,message:branch==='work/pilot-'+p.id.slice(0,8)?'Pilot working branch · no automatic push or merge':'Not the Pilot working branch · automatic commits disabled',truncated};
  }catch{throw new HttpError(422,'Git changes could not be read within the safety limits. No command output is exposed');}
 }
 async commitPaths(p:Project,commit:string):Promise<{paths:string[]}>{
  if(!/^[a-f0-9]{40,64}$/.test(commit))throw new HttpError(422,'Invalid commit identity');
  if(!await this.root(p))throw new HttpError(409,'Git history is unavailable');
  try{return {paths:(await this.git(p,['diff-tree','--diff-merges=first-parent','--no-commit-id','--root','--no-renames','-r','--name-only','-z',commit])).split('\0').filter(isWorkspacePath)};}
  catch{throw new HttpError(422,'Commit changes are unavailable or exceed the preview limit');}
 }
 async diff(p:Project,value:string,commit?:string):Promise<{path:string;diff:string}>{
  const path=this.path(value);await safePath(p.path,path);
  if(!await this.root(p))throw new HttpError(409,'Git history is unavailable');
  if(commit!==undefined&&!/^[a-f0-9]{40,64}$/.test(commit))throw new HttpError(422,'Invalid commit identity');
  try{
   if(commit)return {path,diff:await this.git(p,['show','--format=','--diff-merges=first-parent','--no-ext-diff','--no-textconv','--no-renames',commit,'--',path])};
   let tracked=false;try{await this.git(p,['ls-files','--error-unmatch','--',path]);tracked=true;}catch{}
   if(!tracked){if(isWorkspaceImagePath(path)){const file=await lstat(await safePath(p.path,path));if(!file.isFile())throw new HttpError(404,'File not found');return {path,diff:'New image file: '+path+'\nNo textual diff; open the current file to preview it.'};}const doc=await this.read(p,path);return {path,diff:'--- /dev/null\n+++ b/'+path+'\n'+doc.text.split('\n').map(line=>'+'+line).join('\n')};}
   let head=true;try{await this.git(p,['rev-parse','--verify','HEAD']);}catch{head=false;}
   return {path,diff:await this.git(p,['diff','--no-ext-diff','--no-textconv','--no-renames',...(head?['HEAD']:['--cached']),'--',path])};
  }catch(e){if(e instanceof HttpError)throw e;throw new HttpError(422,'Diff is unavailable or exceeds the preview limit');}
 }
 async commitFiles(p:Project,paths:string[],message:string):Promise<SaveCommit>{
  if(!await this.root(p))return {status:'unavailable',message:'No connected Git repository'};
  let committing=false;
  try{
   const names=[...new Set(paths.map(path=>/^docs\/dashboard\/sources\/[a-f0-9-]{36}-[a-f0-9]{64}\.md$/.test(path)?path:this.path(path)))];if(!names.length||names.length>5001||Buffer.byteLength(names.join('\0'))>128*1024)throw Error('Invalid commit paths');
   for(const name of names)await safePath(p.path,name);
   const branch=(await this.git(p,['symbolic-ref','HEAD'])).trim();if(branch!=='refs/heads/work/pilot-'+p.id.slice(0,8))return {status:'failed',message:'The repository is not on this project’s Pilot working branch. No branch was switched and no commit was made.'};
   // Never consume an existing staged change in an action's files. Other staged paths are
   // preserved by Git's --only transaction and are never included in this commit.
   if((await this.git(p,['diff','--cached','--name-only','-z','--',...names])).length)return {status:'failed',message:'A selected file already has staged edits. Review them in Changes before saving again.'};
   for(const name of names){try{await this.git(p,['ls-files','--error-unmatch','--',name]);}catch{await this.git(p,['add','--intent-to-add','--',name]);}}
   const diff=await this.git(p,['diff','--name-only','-z','--',...names]);if(!diff)return {status:'unchanged',message:'No content changes'};
   committing=true;
   await this.git(p,['-c','user.name=Pilot','-c','user.email=pilot@localhost','commit','--only','--no-verify','--no-gpg-sign','-m',message,'--',...names]);
   const commit=(await this.git(p,['rev-parse','HEAD'])).trim();return {status:'committed',hash:commit,message:'Saved and committed locally'};
  }catch{return {status:committing?'uncertain':'failed',message:committing?'The saved file is retained, but Git did not confirm the commit. Inspect history before retrying; no automatic retry, push or merge occurred.':'Git could not prepare the commit. The saved file is retained; inspect Changes. No push or merge was attempted.'};}
 }
 /** Shared project serialization covers the disk save AND its Git commit across docs/boards/notes. */
 async save<T extends object>(p:Project,paths:string[],write:()=>Promise<T>,message='docs: update '+paths[0]):Promise<T&{commit:SaveCommit}>{
  return this.serial(p.id,async()=>{const saved=await write(),commit=await this.commitFiles(p,paths,message);return {...saved,commit};});
 }
}
