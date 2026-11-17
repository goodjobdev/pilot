import {spawn,execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {lstat,mkdir,open,realpath} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import type {RunnerServiceRuntime} from './runner-service';
import {RUNNER_LIMIT_BOUNDS} from '../../shared/runner';

const execFileAsync=promisify(execFile);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const imagePattern=/^sha256:[0-9a-f]{64}$/;
const bounded=(b:{min:number;max:number})=>z.number().int().min(b.min).max(b.max);
const limitsSchema=z.strictObject({timeoutMs:bounded(RUNNER_LIMIT_BOUNDS.timeoutMs),outputBytes:bounded(RUNNER_LIMIT_BOUNDS.outputBytes),memoryBytes:bounded(RUNNER_LIMIT_BOUNDS.memoryBytes),cpus:bounded(RUNNER_LIMIT_BOUNDS.cpus),pids:bounded(RUNNER_LIMIT_BOUNDS.pids)});
const inspectedSchema=z.object({Id:z.string().regex(/^[a-f0-9]{64}$/),Name:z.string(),Config:z.object({Labels:z.record(z.string(),z.string())}),State:z.object({Status:z.enum(['running','exited']),Running:z.boolean(),Dead:z.boolean(),ExitCode:z.number().int().min(0).max(255).nullable(),FinishedAt:z.string()})});
const stateSchema=z.object({Status:z.literal('exited'),Running:z.literal(false),Dead:z.literal(false),ExitCode:z.number().int().min(0).max(255),FinishedAt:z.string().min(1).refine(v=>!v.startsWith('0001-'))});
export function runnerServiceContainerName(operationId:string):string{
 if(!uuid.test(operationId))throw Error('Invalid runner operation identity.');
 return 'pilot-runner-'+createHash('sha256').update(operationId).digest('hex').slice(0,32);
}
function operationDirectory(privateRoot:string,operationId:string):string{
 return join(privateRoot,'run-'+createHash('sha256').update(operationId).digest('hex').slice(0,32));
}
async function readContainerId(path:string,uid:number):Promise<string>{
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const file=await handle.stat();if(!file.isFile()||file.uid!==uid||file.nlink!==1||file.size<64||file.size>65)throw Error('Invalid container identity file.');const id=(await handle.readFile('utf8')).trim();if(!/^[a-f0-9]{64}$/.test(id))throw Error('Runner container identity was not confirmed.');return id;}finally{await handle.close();}
}
/** Read-only restart inspection of the exact cidfile identity; it never reconciles or cancels work. */
export async function inspectDockerServiceOperation(config:{privateRoot:string;dockerBinary?:string},operationId:string):Promise<{status:'unavailable'|'uncertain'|'running'|'exited';containerId?:string;exitCode?:number}>{
 const uid=process.getuid?.();if(uid===undefined||uid===0||process.geteuid?.()!==uid)throw Error('Invalid runner service identity.');
 const docker=config.dockerBinary??'docker',expectedName='/'+runnerServiceContainerName(operationId),directory=operationDirectory(config.privateRoot,operationId),cidfile=join(directory,'container.id');
 try{
  const dir=await lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==uid||(dir.mode&0o7777)!==0o700)return {status:'uncertain'};
  const id=await readContainerId(cidfile,uid);
  const result=await execFileAsync(docker,['inspect','--format','{{json .}}',id],{timeout:5000,maxBuffer:16384});
  const inspected=inspectedSchema.parse(JSON.parse(result.stdout));
  if(inspected.Id!==id||inspected.Name!==expectedName||inspected.Config.Labels['pilot.runner.operation']!==operationId)return {status:'uncertain',containerId:id};
  if(inspected.State.Status==='running'&&inspected.State.Running&&!inspected.State.Dead)return {status:'running',containerId:id};
  const state=stateSchema.parse(inspected.State);return {status:'exited',containerId:id,exitCode:state.ExitCode};
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {status:'unavailable'};return {status:'uncertain'};}
}

/**
 * Uninstalled service-side Docker port. The daemon, image, CLI and service principal are trusted
 * owner configuration, not request parameters. This code cannot establish Docker daemon security,
 * ACLs, user-namespace mapping, peer authentication or kernel isolation. It retains containers and
 * private cidfiles for operator inspection; no automatic recovery or cleanup is provided. Aborts,
 * output overflow, CLI failures and unverified daemon state throw and must remain uncertain.
 */
export function dockerServiceRuntime(config:{privateRoot:string;imageId:string;dockerBinary?:string}):RunnerServiceRuntime{
 if(!imagePattern.test(config.imageId)||!config.privateRoot.startsWith('/')||/[,:\u0000-\u001f\u007f]/.test(config.privateRoot))throw Error('Invalid runner runtime configuration.');
 const docker=config.dockerBinary??'docker';
 if(!docker||/[\u0000\r\n]/.test(docker))throw Error('Invalid runner runtime configuration.');
 return {async run(input){
  if(input.signal.aborted)throw Error('Runner invocation was cancelled.');
  const name=runnerServiceContainerName(input.operationId),limits=limitsSchema.parse(input.limits);
  if(input.recipe!=='test-run'||dirname(input.directory)!==config.privateRoot||!/^snapshot-[A-Za-z0-9]{6}$/.test(basename(input.directory))||await realpath(input.directory)!==input.directory)throw Error('Invalid private snapshot.');
  const stat=await lstat(input.directory),uid=process.getuid?.();
  if(uid===undefined||uid===0||process.geteuid?.()!==uid||!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o7777)!==0o555)throw Error('Invalid private snapshot.');
  const metadata=operationDirectory(config.privateRoot,input.operationId);await mkdir(metadata,{mode:0o700});const cidfile=join(metadata,'container.id');
  if(input.signal.aborted)throw Error('Runner invocation was cancelled.');
  const args=['run','--name',name,'--label','pilot.runner.operation='+input.operationId,'--cidfile',cidfile,'--pull','never','--sig-proxy=false','--network','none','--read-only','--user','65534:65534','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit',String(limits.pids),'--memory',String(limits.memoryBytes)+'b','--memory-swap',String(limits.memoryBytes)+'b','--cpus',String(limits.cpus),'--tmpfs','/tmp:rw,noexec,nosuid,size=33554432','--mount','type=bind,src='+input.directory+',dst=/workspace,readonly','--workdir','/workspace','--entrypoint','node',config.imageId,'--test'];
  const child=spawn(docker,args,{stdio:['ignore','pipe','pipe']});
  const stdout:Buffer[]=[],stderr:Buffer[]=[];let bytes=0,stopped=false,hard:ReturnType<typeof setTimeout>|undefined;
  const stop=()=>{
   if(stopped)return;stopped=true;
   // The derived name is not authenticated container identity. Never send a daemon kill by name:
   // a collision or replacement could target someone else's container. Stop only our CLI; signal
   // proxying is disabled above. The container may continue and the result remains uncertain.
   child.kill('SIGTERM');hard=setTimeout(()=>child.kill('SIGKILL'),1000);hard.unref();
  };
  const capture=(target:Buffer[])=>(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limits.outputBytes){stop();return;}target.push(Buffer.from(chunk));};
  child.stdout.on('data',capture(stdout));child.stderr.on('data',capture(stderr));
  input.signal.addEventListener('abort',stop,{once:true});if(input.signal.aborted)stop();
  const closed=await new Promise<{code:number|null;error:Error|null}>(resolve=>{
   child.once('error',error=>resolve({code:null,error}));child.once('close',code=>resolve({code,error:null}));
  });
  input.signal.removeEventListener('abort',stop);if(hard)clearTimeout(hard);
  if(stopped||input.signal.aborted||closed.error||closed.code===null)throw Error('Runner termination was not confirmed.');
  const id=await readContainerId(cidfile,uid);
  const inspected=await execFileAsync(docker,['inspect','--format','{{json .}}',id],{timeout:5000,maxBuffer:16384});
  const exact=inspectedSchema.parse(JSON.parse(inspected.stdout));
  if(exact.Id!==id||exact.Name!=='/'+name||exact.Config.Labels['pilot.runner.operation']!==input.operationId)throw Error('Runner container identity was not confirmed.');
  const state=stateSchema.parse(exact.State);
  if(state.ExitCode!==closed.code||input.signal.aborted)throw Error('Runner result was not confirmed.');
  return {exitCode:state.ExitCode,stdout:Buffer.concat(stdout),stderr:Buffer.concat(stderr)};
 }};
}
