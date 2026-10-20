import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,readFile,lstat,readdir,copyFile,chmod,rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Project } from '../shared/model';
import type { RepositoryConnection } from '../shared/settings';
import { atomicWrite,HttpError } from './board-store';
import { safePath } from './paths';

const exec=promisify(execFile);
// GitHub's Ed25519 host key, from https://api.github.com/meta (TLS), verified
// fingerprint SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.
// Never use ssh-keyscan on an untrusted network or accept-new.
const knownHost='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';
export function githubRepository(input:string){
 const match=/^(?:https:\/\/github\.com\/|git@github\.com:)([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\/([a-zA-Z0-9_.-]{1,100}?)(?:\.git)?$/.exec(input);
 if(!match||['.','..'].includes(match[2]))throw new HttpError(422,'Use a GitHub repository URL without credentials, query strings or fragments');
 return {ssh:'git@github.com:'+match[1]+'/'+match[2]+'.git',settings:'https://github.com/'+match[1]+'/'+match[2]+'/settings/keys'};
}
export type RepositoryCommand=(file:string,args:string[],options:{env?:NodeJS.ProcessEnv;cwd?:string;timeout:number;maxBuffer:number})=>Promise<{stdout:string}>;
export class RepositoryStore {
 private tails=new Map<string,Promise<unknown>>();
 private connecting=new Set<string>();
 constructor(private root:string,private command:RepositoryCommand=async(file,args,options)=>exec(file,args,options)){}
 isConnecting(id:string){return this.connecting.has(id);}
 private id(id:string){return z.string().uuid().parse(id);}
 private async serial<T>(id:string,work:()=>Promise<T>){
  this.id(id);const before=this.tails.get(id)??Promise.resolve(),next=before.catch(()=>{}).then(work);this.tails.set(id,next);
  try{return await next;}finally{if(this.tails.get(id)===next)this.tails.delete(id);}
 }
 private keyPath(id:string){return safePath(this.root,'credentials/projects/'+this.id(id)+'/id_ed25519',true);}
 private async keyView(id:string){
  const path=await this.keyPath(id);
  try{
   // Expose only the derived public key, never read back the private key.
   const key=(await readFile(await safePath(this.root,'credentials/projects/'+id+'/id_ed25519.pub'),'utf8')).trim();
   if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*?)?$/.test(key))throw Error('Invalid public key');
   const fingerprint='SHA256:'+createHash('sha256').update(Buffer.from(key.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'');
   await lstat(path);
   return {publicKey:key,fingerprint};
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {publicKey:null,fingerprint:null};throw new HttpError(409,'Deploy key is incomplete. Remove and regenerate it.');}
 }
 async view(p:Project):Promise<RepositoryConnection>{
  const branch='work/pilot-'+p.id.slice(0,8);
  return {repository:p.repository,...await this.keyView(p.id),connected:p.path===join(this.root,'repositories',p.id,'agent'),branch:p.path===join(this.root,'repositories',p.id,'agent')?branch:null};
 }
 async generate(p:Project){
  githubRepository(p.repository);
  return this.serial(p.id,async()=>{
   const path=await this.keyPath(p.id);
   try{await lstat(path);return this.view(p);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   try{await this.command('ssh-keygen',['-q','-t','ed25519','-N','','-C','pilot-'+p.id,'-f',path],{timeout:10000,maxBuffer:8192});await chmod(path,0o600);}
   catch{throw new HttpError(503,'Could not generate deploy key. The server needs OpenSSH tools.');}
   return this.view(p);
  });
 }
 async removeKey(p:Project){
  return this.serial(p.id,async()=>{
   const path=await this.keyPath(p.id);await rm(path,{force:true});await rm(path+'.pub',{force:true});
   return this.view(p);
  });
 }
 private async environment(id:string){
  const key=await this.keyPath(id);
  if(!(await this.keyView(id)).publicKey)throw new HttpError(409,'Generate a deploy key and add the public key to GitHub first');
  const hosts=await safePath(this.root,'credentials/github_known_hosts',true);await atomicWrite(hosts,knownHost);
  // No shell input comes from the repository URL. Quoting is for the absolute,
  // app-owned key and hosts paths in the fixed GIT_SSH_COMMAND only.
  const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
  return {PATH:process.env.PATH,HOME:'/nonexistent',LANG:'C.UTF-8',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
   GIT_SSH_COMMAND:'ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=15 -o IdentityAgent=none -o UserKnownHostsFile='+quote(hosts)+' -i '+quote(key)};
 }
 private async git(id:string,args:string[],cwd?:string){
  try{return (await this.command('git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','protocol.ext.allow=never',...args],{env:await this.environment(id),cwd,timeout:120000,maxBuffer:1024*1024})).stdout.trim();}
  catch(e){if(e instanceof HttpError)throw e;throw new HttpError(422,'Git operation failed. Check the repository URL and deploy key permissions. No credential or command output is shown.');}
 }
 async test(p:Project){const repo=githubRepository(p.repository);await this.git(p.id,['ls-remote','--exit-code',repo.ssh,'HEAD']);return {ok:true,message:'Read access confirmed. Write access is not tested: Pilot does not push automatically.'};}
 /** Explicit UI action, never implicit on registration. No install, commit or push. */
 async connect(p:Project,prepare:()=>Promise<void>,attach:(path:string)=>Promise<void>){
  return this.serial(p.id,async()=>{
   if((await this.view(p)).connected)throw new HttpError(409,'Repository already connected');
   if(!p.managed)throw new HttpError(409,'Only a managed planning workspace can connect to a new checkout');
   const repo=githubRepository(p.repository),base=await safePath(this.root,'repositories/'+p.id+'/sentinel',true);
   const directory=join(base,'..'),main=join(directory,'main'),agent=join(directory,'agent'),branch='work/pilot-'+p.id.slice(0,8);
   this.connecting.add(p.id);
   try{
    await prepare();
    // Refuse leftover attempts rather than delete files an operator might have edited.
    for(const path of [main,agent])try{await lstat(path);throw new HttpError(409,'A checkout already exists for this project. Operator review is required before retrying.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    await this.git(p.id,['clone','--no-recurse-submodules','--',repo.ssh,main]);
    await this.git(p.id,['worktree','add','-b',branch,agent,'HEAD'],main);
    // Preserve every existing planning file with exclusive copies; conflicts fail
    // without overwriting either side. The old workspace remains as a safety copy.
    const copy=async(relative:string)=>{
     for(const entry of await readdir(join(p.path,relative),{withFileTypes:true})){
      const rel=relative?relative+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink()||entry.name==='.git')throw new HttpError(409,'Review the existing workspace before connecting: symlink or Git metadata found');
      const target=await safePath(agent,rel,true);
      if(entry.isDirectory()){await mkdir(target,{recursive:true,mode:0o700});await copy(rel);}
      else if(entry.isFile())await copyFile(await safePath(p.path,rel),target,constants.COPYFILE_EXCL);
     }
    };
    await copy('');
    await attach(agent);
    return this.view(p);
   }catch(e){
    // Never cleanup a failed checkout automatically: preserve both trees for review.
    if(e instanceof HttpError)throw e;
    throw new HttpError(409,'Connection stopped without overwriting planning files. The old workspace is unchanged; review the staged checkout before retrying.');
   }finally{this.connecting.delete(p.id);}
  });
 }
 async close(){await Promise.allSettled([...this.tails.values()]);}
}
