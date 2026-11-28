import {createHash} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {request as httpsRequest} from 'node:https';
import {dirname,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {checkServerIdentity} from 'node:tls';
import {z} from 'zod';
import {RUNNER_TRANSPORT_MAX_BODY_BYTES} from './runner-transport-input';
import {parseRunnerServiceRequest} from './runner-service-admission';
import {validateRunnerSnapshot} from './runner-snapshot';

const response=z.strictObject({status:z.enum(['completed','uncertain','existing']),operationId:z.string().uuid(),jobId:z.string().min(1).max(160)});
const receipt=z.strictObject({snapshotDigest:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.number().int().min(0).max(255),stdoutDigest:z.string().regex(/^[a-f0-9]{64}$/),stderrDigest:z.string().regex(/^[a-f0-9]{64}$/),stdoutBytes:z.number().int().nonnegative().safe(),stderrBytes:z.number().int().nonnegative().safe(),durationMs:z.number().int().nonnegative().safe()});
const inspectionResponse=z.discriminatedUnion('status',[
 z.strictObject({jobId:z.string(),status:z.literal('unavailable'),operationId:z.null(),receipt:z.null()}),
 z.strictObject({jobId:z.string(),status:z.literal('uncertain'),operationId:z.string().uuid(),receipt:z.null()}),
 z.strictObject({jobId:z.string(),status:z.literal('receipt-recorded'),operationId:z.string().uuid(),receipt})
]);
type RunnerInspection={status:'inspection-unknown'}|z.infer<typeof inspectionResponse>;
type RunnerClientAnswer={status:'not-dispatched'|'unknown'}|z.infer<typeof response>;

/** Only the preflight check runs in the background if it stalls; it cannot dispatch a request. */
export async function runnerClientPreflight(check:()=>Promise<boolean>,ms:number,signal?:AbortSignal):Promise<boolean>{
 if(ms<=0||signal?.aborted)return false;
 let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
 const interrupted=new Promise<boolean>(resolve=>{abort=()=>resolve(false);signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,ms);if(signal?.aborted)abort();});
 try{return await Promise.race([Promise.resolve().then(check).catch(()=>false),interrupted]);}
 finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

/**
 * Uninstalled client for the fixed-job Unix/TLS experiment. It never retries. A completed response
 * is only the service's assertion, not independent proof of tests, provenance, or isolation.
 */
export class RunnerTransportClient{
 constructor(private readonly config:{readonly socketPath:string;readonly serverName:string;readonly serverCa:string|Buffer;readonly clientCert:string|Buffer;readonly clientKey:string|Buffer;readonly serverFingerprintSha256:string;readonly deadlineMs:number}){
  if(resolve(config.socketPath)!==config.socketPath||!config.serverName||config.serverName.length>253||!/^[a-f0-9]{64}$/.test(config.serverFingerprintSha256)||!Number.isSafeInteger(config.deadlineMs)||config.deadlineMs<100||config.deadlineMs>600000)throw Error('Invalid runner transport client configuration.');
 }
 async submit(request:unknown,snapshot:unknown,signal?:AbortSignal):Promise<RunnerClientAnswer>{
  if(signal?.aborted)return {status:'not-dispatched'};
  const deadline=performance.now()+this.config.deadlineMs;
  let body:Buffer,expectedJobId:string;
  try{
   const parsed=parseRunnerServiceRequest(request),checked=validateRunnerSnapshot(snapshot);expectedJobId=parsed.jobId;
   if(parsed.snapshotDigest!==checked.digest)throw Error();
   const boundedSnapshot={version:1,files:checked.files.map(({path,mode,base64})=>({path,mode,base64}))};
   body=Buffer.from(JSON.stringify({request:parsed,snapshot:boundedSnapshot}),'utf8');
   if(body.length>RUNNER_TRANSPORT_MAX_BODY_BYTES)throw Error();
  }catch{return {status:'not-dispatched'};}
  const valid=await runnerClientPreflight(async()=>{const parent=dirname(this.config.socketPath),actual=await realpath(parent),stat=await lstat(this.config.socketPath);return actual===parent&&!stat.isSymbolicLink()&&stat.isSocket();},deadline-performance.now(),signal);
  if(!valid||signal?.aborted||performance.now()>=deadline)return {status:'not-dispatched'};
  const raw=await this.exchange('/v1/jobs',body,deadline,signal);
  if(raw===null)return {status:'unknown'};
  try{const parsed=response.parse(JSON.parse(raw));if(JSON.stringify(parsed)!==raw||parsed.jobId!==expectedJobId)throw Error();return parsed;}catch{return {status:'unknown'};}
 }
 /** Read-only exact-request lookup; unavailable is not permission to retry or evidence of absence. */
 async inspect(request:unknown,signal?:AbortSignal):Promise<RunnerInspection>{
  if(signal?.aborted)return {status:'inspection-unknown'};
  const deadline=performance.now()+this.config.deadlineMs;
  let parsed:ReturnType<typeof parseRunnerServiceRequest>,body:Buffer;
  try{parsed=parseRunnerServiceRequest(request);body=Buffer.from(JSON.stringify({request:parsed}),'utf8');if(body.length>4096)throw Error();}catch{return {status:'inspection-unknown'};}
  const valid=await runnerClientPreflight(async()=>{const parent=dirname(this.config.socketPath),actual=await realpath(parent),stat=await lstat(this.config.socketPath);return actual===parent&&!stat.isSymbolicLink()&&stat.isSocket();},deadline-performance.now(),signal);
  if(!valid||signal?.aborted||performance.now()>=deadline)return {status:'inspection-unknown'};
  const raw=await this.exchange('/v1/jobs/inspect',body,deadline,signal);
  if(raw===null)return {status:'inspection-unknown'};
  try{const result=inspectionResponse.parse(JSON.parse(raw));if(JSON.stringify(result)!==raw||result.jobId!==parsed.jobId||(result.receipt!==null&&(result.receipt.snapshotDigest!==parsed.snapshotDigest||result.receipt.stdoutBytes+result.receipt.stderrBytes>parsed.limits.outputBytes)))throw Error();return result;}catch{return {status:'inspection-unknown'};}
 }
 private async exchange(path:string,body:Buffer,deadline:number,signal?:AbortSignal):Promise<string|null>{
  return await new Promise<string|null>(resolveAnswer=>{
   let settled=false;
   const finish=(answer:string|null)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolveAnswer(answer);};
   let client:ReturnType<typeof httpsRequest>;
   const abort=()=>{client.destroy();finish(null);};
   const timer=setTimeout(()=>{client.destroy();finish(null);},Math.max(1,deadline-performance.now()));
   try{
    client=httpsRequest({socketPath:this.config.socketPath,servername:this.config.serverName,host:this.config.serverName,method:'POST',path,agent:false,ca:this.config.serverCa,cert:this.config.clientCert,key:this.config.clientKey,minVersion:'TLSv1.3',headers:{'content-type':'application/json','content-length':String(body.length)},checkServerIdentity:(name,certificate)=>{
     const normal=checkServerIdentity(name,certificate);if(normal)return normal;
     if(!certificate.raw||createHash('sha256').update(certificate.raw).digest('hex')!==this.config.serverFingerprintSha256)return Error('Runner server identity mismatch.');
     return undefined;
    }},res=>{
     let size=0;const chunks:Buffer[]=[];
     res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4096){res.destroy();finish(null);return;}chunks.push(chunk);});
     res.on('error',()=>finish(null));
     res.on('end',()=>{if(res.statusCode!==200||res.headers['content-type']!=='application/json'){finish(null);return;}finish(Buffer.concat(chunks,size).toString('utf8'));});
     res.on('close',()=>{if(!res.complete)finish(null);});
    });
    client.on('error',()=>finish(null));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    client.end(body);
   }catch{finish(null);}
  });
 }
}
