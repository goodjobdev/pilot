import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat,realpath } from 'node:fs/promises';
import { isAbsolute,resolve } from 'node:path';
import type { Project } from '../../shared/model';
import type { ExactPushTransport } from '../agents/accepted-push';

const exec=promisify(execFile);
// Bounded process limits: an oversized or non-UTF-8 answer is a refusal, never a truncated result.
const TIMEOUT_MS=60_000,MAX_OUTPUT_BYTES=64*1024;
const REMOTE_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/,COMMIT_ID=/^[a-f0-9]{40}$/;
const BRANCH=/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const ENV=Object.freeze({PATH:process.env.PATH,HOME:'/nonexistent',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'});

function isPushBranch(value: string): boolean {
  return BRANCH.test(value)&&!value.includes('..')&&!value.includes('//')&&!value.endsWith('/')&&!value.endsWith('.')&&!value.endsWith('.lock');
}
function localRemoteRefusal(){return new Error('A push target must be a local filesystem repository: one absolute path or one file:// URL. This instance does not push over a network and has no hosted credential integration.');}
function notFastForward(){return new Error('The local remote branch is not at the accepted commit\u2019s parent, so this push would not be a fast-forward; no push was attempted.');}
function pushRefusal(reason: string){return new Error(reason+'; no push was attempted.');}

/**
 * The one local path a configured remote value may name. A network URL, a relative path, a URL with
 * a host, or a non-canonical path is refused without echoing the value: a remote URL may carry a
 * credential, and this module never returns or logs one.
 */
function localRemotePath(value: string): string {
  const trimmed=value.trim();
  if(trimmed==='')throw localRemoteRefusal();
  let path=trimmed;
  if(/^file:\/\//i.test(trimmed)){
    let url:URL;
    try{url=new URL(trimmed);}catch{throw localRemoteRefusal();}
    if(url.host!==''&&url.host!=='localhost')throw localRemoteRefusal();
    try{path=decodeURIComponent(url.pathname);}catch{throw localRemoteRefusal();}
  }else if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) throw localRemoteRefusal();
  if(!isAbsolute(path))throw localRemoteRefusal();
  return resolve(path);
}

export type LocalPushRemote = Readonly<{remoteId:string;repositoryDigest:string;path:string}>;

type GitResult={code:number;text:string};
function base(projectPath: string): string[] {
  // Hooks, filters and helpers are disabled, and only the local file transport is selectable: the
  // remote this module resolves is a directory on this machine, never a network endpoint.
  return ['--no-pager','-C',projectPath,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','core.untrackedCache=false','-c','submodule.recurse=false','-c','commit.gpgSign=false',
    '-c','tag.gpgSign=false','-c','maintenance.auto=false','-c','gc.auto=0',
    '-c','protocol.allow=never','-c','protocol.file.allow=always','-c','credential.helper='];
}
async function run(projectPath: string,args: string[]): Promise<GitResult> {
  let stdout: unknown;
  try{
    const result=await exec('git',[...base(projectPath),...args],{env:ENV,encoding:'buffer',timeout:TIMEOUT_MS,maxBuffer:MAX_OUTPUT_BYTES});
    stdout=result.stdout;
  }catch(error){
    const code=(error as {code?:unknown}).code;
    return {code:typeof code==='number'?code:-1,text:''};
  }
  const bytes=Buffer.isBuffer(stdout)?stdout:Buffer.from(String(stdout),'utf8');
  const text=bytes.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(bytes))throw new Error('Git output is not valid UTF-8');
  return {code:0,text};
}
async function configValues(projectPath: string,key: string): Promise<string[]> {
  const result=await run(projectPath,['config','--null','--get-all',key]);
  if(result.code===1)return [];
  if(result.code!==0)throw new Error('The project Git configuration could not be read; no push target was configured.');
  return result.text.split('\0').filter(value=>value.length>0);
}

/**
 * Resolve one owner-named remote to the exact local repository it currently points at.
 *
 * The digest is the identity stored in the push target: it is computed over the canonical local
 * path, so editing the remote afterwards changes it and the action is refused. An alias change
 * alone does not change it. This is a local filesystem identity, not a hosted repository identity.
 */
export async function resolveLocalPushRemote(input: { project: Project; remoteId: unknown }): Promise<LocalPushRemote> {
  const remoteId=String(input.remoteId??'');
  if(!REMOTE_ID.test(remoteId))throw new Error('A push target must name one configured Git remote by its name.');
  const urlKey='remote.'+remoteId+'.url',pushUrlKey='remote.'+remoteId+'.pushurl';
  const pushUrls=await configValues(input.project.path,pushUrlKey),urls=pushUrls.length>0?pushUrls:await configValues(input.project.path,urlKey);
  if(urls.length!==1)throw new Error('The named remote must have exactly one configured URL; this instance configures one exact target.');
  const path=localRemotePath(urls[0]);
  let info;
  try{info=await lstat(path);}catch{throw new Error('The configured remote directory does not exist; no push target was configured.');}
  if(info.isSymbolicLink()||!info.isDirectory())throw new Error('The configured remote must be a real local directory, not a symlink or a file.');
  if(await realpath(path)!==path)throw new Error('The configured remote path is not its canonical path; configure the real path.');
  if((await run(path,['rev-parse','--git-dir'])).code!==0)throw new Error('The configured remote is not a local Git repository.');
  const repositoryDigest=createHash('sha256').update(JSON.stringify(['pilot-local-push-remote-v1',path])).digest('hex');
  return Object.freeze({remoteId,repositoryDigest,path});
}

/** The local remotes this project already has, as candidate targets for the owner. No URL is returned. */
export async function listLocalPushRemotes(project: Project): Promise<readonly {remoteId:string;repositoryDigest:string}[]> {
  const result=await run(project.path,['remote']);
  if(result.code!==0)return [];
  const names=result.text.split('\n').map(name=>name.trim()).filter(name=>REMOTE_ID.test(name)).slice(0,50);
  const remotes:{remoteId:string;repositoryDigest:string}[]=[];
  for(const remoteId of names){
    try{const resolved=await resolveLocalPushRemote({project,remoteId});remotes.push({remoteId:resolved.remoteId,repositoryDigest:resolved.repositoryDigest});}
    catch{/* a network remote or a broken one is not offered */}
  }
  return remotes;
}

type Prepared=Readonly<{project:Project;remote:LocalPushRemote;commit:string;parent:string|null;branch:string}>;

/**
 * The installed local push adapter: one non-force push of one exact commit to one exact owner-
 * configured branch of one local repository. It selects no target, branch, remote or command from
 * model input, installs no credential, and reaches no network transport.
 *
 * Identity is checked again immediately before the write (canonical remote path and digest, the
 * commit and its parent, the remote branch head), but those checks are not atomic with Git's ref
 * update and cannot stop an external writer changing the branch afterwards. Any failure after the
 * push is uncertain: inspect the branch, do not replay.
 */
export class LocalGitPushTransport implements ExactPushTransport {
  constructor(private readonly options: {projectFor(projectId: string): Project | undefined}){}

  private async prepare(input: {projectId:string;remoteId:string;repositoryDigest:string;branch:string;commit:string}): Promise<Prepared> {
    if(!COMMIT_ID.test(input.commit))throw pushRefusal('The accepted push does not name one commit');
    if(!isPushBranch(input.branch))throw pushRefusal('The configured push branch is invalid');
    const project=this.options.projectFor(input.projectId);
    if(!project)throw pushRefusal('The project\u2019s connected worktree is unavailable');
    const remote=await resolveLocalPushRemote({project,remoteId:input.remoteId});
    if(remote.repositoryDigest!==input.repositoryDigest)throw pushRefusal('The configured remote no longer matches the push target');
    const commit=await run(project.path,['rev-parse','--verify','--quiet',input.commit+'^{commit}']);
    if(commit.code!==0||commit.text.trim()!==input.commit)throw pushRefusal('The accepted commit is not a commit in this project');
    if((await run(project.path,['merge-base','--is-ancestor',input.commit,'HEAD'])).code!==0)
      throw pushRefusal('The accepted commit is not in this project branch\u2019s history');
    const lineage=await run(project.path,['rev-list','--parents','-n','1',input.commit]);
    const fields=lineage.text.trim().split(/\s+/).filter(Boolean);
    if(lineage.code!==0||fields[0]!==input.commit||fields.length>2)throw pushRefusal('The accepted commit must have exactly one parent or none');
    const parent=fields.length===2?fields[1]:null;
    if(parent!==null&&!COMMIT_ID.test(parent))throw pushRefusal('The accepted commit\u2019s parent could not be verified');
    return {project,remote,commit:input.commit,parent,branch:input.branch};
  }

  private async readBranch(prepared: Prepared): Promise<string|null> {
    const result=await run(prepared.project.path,['ls-remote',prepared.remote.path,prepared.branch]);
    if(result.code!==0)throw pushRefusal('The local remote branch could not be read');
    const lines=result.text.split('\n').map(line=>line.trim()).filter(Boolean);
    if(lines.length===0)return null;
    if(lines.length!==1)throw pushRefusal('The local remote reported more than one matching branch');
    const [head,ref]=lines[0].split(/\s+/);
    if(ref!==prepared.branch||!COMMIT_ID.test(head))throw pushRefusal('The local remote branch identity is unexpected');
    return head;
  }

  private assertRemoteCurrent(prepared: Prepared): Promise<string> {
    return resolveLocalPushRemote({project:prepared.project,remoteId:prepared.remote.remoteId}).then(current=>{
      if(current.repositoryDigest!==prepared.remote.repositoryDigest)throw pushRefusal('The configured remote changed');
      return current.repositoryDigest;
    });
  }

  async inspect(input: {projectId:string;remoteId:string;repositoryDigest:string;branch:string;commit:string}): Promise<{repositoryDigest:string;remoteHead:string|null}> {
    const prepared=await this.prepare(input);
    const remoteHead=await this.readBranch(prepared);
    // An empty branch, the accepted commit's parent, or the accepted commit itself (a read-back after
    // a push) are the states in which this commit either is, or already became, a fast-forward.
    if(remoteHead!==null&&remoteHead!==prepared.parent&&remoteHead!==prepared.commit)throw notFastForward();
    return {repositoryDigest:input.repositoryDigest,remoteHead};
  }

  async push(input: {projectId:string;remoteId:string;repositoryDigest:string;branch:string;commit:string;signal?:AbortSignal}): Promise<{repositoryDigest:string;observedCommit:string}> {
    input.signal?.throwIfAborted();
    const prepared=await this.prepare(input);
    input.signal?.throwIfAborted();
    const before=await this.readBranch(prepared);
    if(before!==null&&before!==prepared.parent)throw notFastForward();
    // The target already holds this exact commit. Returning that observation writes nothing and is
    // not a second push; the service still reads the branch back and reports the accepted commit.
    if(before===prepared.commit)return {repositoryDigest:input.repositoryDigest,observedCommit:prepared.commit};
    await this.assertRemoteCurrent(prepared);
    input.signal?.throwIfAborted();
    // One non-force push of the exact commit to the exact branch: no tags, no submodules, no signing,
    // no hooks. Git itself rejects a non-fast-forward, and the parent check above already refused it.
    const pushed=await run(prepared.project.path,['push','--porcelain','--no-verify','--no-follow-tags','--no-signed','--recurse-submodules=no','--',prepared.remote.path,prepared.commit+':'+prepared.branch]);
    if(pushed.code!==0)throw new Error('The local Git push did not complete; the remote branch may or may not have changed. Inspect it before any retry.');
    const observed=await this.readBranch(prepared);
    if(observed===null)throw new Error('The pushed branch could not be read back; inspect the remote before any retry.');
    return {repositoryDigest:input.repositoryDigest,observedCommit:observed};
  }
}
