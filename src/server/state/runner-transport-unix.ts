import {createHash,constants} from 'node:crypto';
import {chmod,chown,lstat,mkdir,realpath,rmdir} from 'node:fs/promises';
import type {Duplex} from 'node:stream';
import {createServer,type Server} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {join,resolve} from 'node:path';
import type {TLSSocket} from 'node:tls';
import type {RunnerService} from './runner-service';
import {parseRunnerInspectionInput,parseRunnerTransportInput,RUNNER_INSPECTION_MAX_BODY_BYTES,RUNNER_TRANSPORT_MAX_BODY_BYTES} from './runner-transport-input';

/**
 * Uninstalled experimental endpoint. It only accepts a fixed job over a Unix socket and requires
 * both a verified client certificate and an exact leaf pin. POSIX modes are not ACL verification;
 * the caller must independently protect keys, store, parent, host and runtime before deployment.
 */
export async function startRunnerUnixTransport(config:{
 readonly parent:string;readonly groupId:number;readonly applicationUid:number;
 readonly key:string|Buffer;readonly cert:string|Buffer;readonly clientCa:string|Buffer;
 readonly clientFingerprintSha256:string;readonly serviceDeadlineMs?:number;
},service:Pick<RunnerService,'start'>&Partial<Pick<RunnerService,'inspectJob'>>):Promise<{socketPath:string;close:()=>Promise<{serviceSettled:boolean;requiresReview:boolean;directoryRemoved:boolean}>}>{
 const uid=process.getuid?.();
 if(uid===undefined||uid===0||!Number.isSafeInteger(config.applicationUid)||config.applicationUid<=0||uid===config.applicationUid||!Number.isSafeInteger(config.groupId)||config.groupId<=0)throw Error('Runner transport identity configuration is invalid.');
 if(!/^[a-f0-9]{64}$/.test(config.clientFingerprintSha256))throw Error('Runner transport certificate pin is invalid.');
 const serviceDeadline=config.serviceDeadlineMs??60000;
 if(!Number.isSafeInteger(serviceDeadline)||serviceDeadline<100||serviceDeadline>600000)throw Error('Runner transport deadline is invalid.');
 const parent=resolve(config.parent),canonical=await realpath(parent),parentStat=await lstat(parent);
 if(parent!==canonical||parentStat.isSymbolicLink()||!parentStat.isDirectory()||parentStat.uid!==uid||parentStat.gid!==config.groupId||(parentStat.mode&0o7777)!==0o710)throw Error('Runner transport parent is not private and service-owned.');
 // A new directory is private until the socket has its final group and mode. Never reuse a path.
 const directory=join(parent,'socket'),socketPath=join(directory,'service.sock');
 await mkdir(directory,{mode:0o700});
 const created=await lstat(directory);
 const removeOwnEmptyDirectory=async()=>{try{const now=await lstat(directory);if(now.isDirectory()&&!now.isSymbolicLink()&&now.dev===created.dev&&now.ino===created.ino){await rmdir(directory);return true;}}catch{}return false;};
 let server:Server|undefined;const connections=new Set<Duplex>(),active=new Set<AbortController>();let busy=false,requiresReview=false,ready=false;
 try{
  await chown(directory,uid,config.groupId);
  const sockets=new WeakSet<object>();
  server=createServer({key:config.key,cert:config.cert,ca:config.clientCa,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',secureOptions:constants.SSL_OP_NO_TICKET,handshakeTimeout:5000,maxHeaderSize:8192},(req:IncomingMessage,res:ServerResponse)=>{
   const peer=req.socket as TLSSocket;
   if(sockets.has(peer)){res.writeHead(400,{'connection':'close','content-type':'application/json'});res.end('{"error":"invalid_request"}');return;}
   sockets.add(peer);
   const certificate=peer.getPeerCertificate(),raw=certificate?.raw;
   const verified=peer.authorized&&Buffer.isBuffer(raw)&&createHash('sha256').update(raw).digest('hex')===config.clientFingerprintSha256;
   if(!verified){peer.destroy();return;}
   const reject=(status:number,code:string)=>{res.writeHead(status,{'content-type':'application/json','connection':'close','cache-control':'no-store'});res.end(JSON.stringify({error:code}));};
   if(!ready){reject(503,'busy');return;}
   const headers=new Map<string,string[]>();
   for(let i=0;i<req.rawHeaders.length;i+=2){const name=req.rawHeaders[i].toLowerCase(),values=headers.get(name)??[];values.push(req.rawHeaders[i+1]);headers.set(name,values);}
   const single=(name:string)=>headers.get(name)?.length===1?headers.get(name)![0]:undefined;
   const length=single('content-length'),type=single('content-type');
   const inspection=req.url==='/v1/jobs/inspect';
   if(req.method!=='POST'||(!inspection&&req.url!=='/v1/jobs')||req.httpVersion!=='1.1'||!length||!/^(0|[1-9][0-9]*)$/.test(length)||!type||type.toLowerCase()!=='application/json'||headers.has('transfer-encoding')||headers.has('trailer')||headers.has('expect')||headers.has('upgrade')||headers.has('content-encoding')){reject(400,'invalid_request');return;}
   const declared=Number(length);
   if(!Number.isSafeInteger(declared)||declared>(inspection?RUNNER_INSPECTION_MAX_BODY_BYTES:RUNNER_TRANSPORT_MAX_BODY_BYTES)){reject(413,'invalid_request');return;}
   if(busy||(!inspection&&requiresReview)){reject(503,'busy');return;}busy=true;
   const controller=new AbortController();active.add(controller);let size=0,ended=false,serviceStarted=false;const body=Buffer.allocUnsafe(declared);
   const timer=setTimeout(()=>{controller.abort();req.destroy();},15000);
   let serviceTimer:ReturnType<typeof setTimeout>|undefined;
   const cleanup=()=>{clearTimeout(timer);if(serviceTimer)clearTimeout(serviceTimer);active.delete(controller);busy=false;};
   req.on('aborted',()=>controller.abort());
   res.on('close',()=>{if(!res.writableFinished){if(serviceStarted)requiresReview=true;controller.abort();}});
   req.on('error',()=>controller.abort());
   req.on('data',(chunk:Buffer)=>{
    size+=chunk.length;
    if(size>declared||size>RUNNER_TRANSPORT_MAX_BODY_BYTES){controller.abort();req.destroy();return;}
    chunk.copy(body,size-chunk.length);
   });
   req.on('end',()=>{
    if(ended)return;ended=true;clearTimeout(timer);
    if(controller.signal.aborted||size!==declared){cleanup();if(!res.destroyed)reject(400,'invalid_request');return;}
    if(inspection){
     try{
      const request=parseRunnerInspectionInput(body);
      if(!service.inspectJob)throw Error('Inspection unavailable');
      const view=service.inspectJob(request);
      res.writeHead(200,{'content-type':'application/json','connection':'close','cache-control':'no-store'});res.end(JSON.stringify(view));
     }catch{if(!res.destroyed)reject(500,'inspection_unavailable');}
     finally{cleanup();}
     return;
    }
    let input:ReturnType<typeof parseRunnerTransportInput>;
    try{input=parseRunnerTransportInput(body);}
    catch{cleanup();reject(400,'invalid_request');return;}
    serviceTimer=setTimeout(()=>{if(serviceStarted)requiresReview=true;controller.abort();if(!res.destroyed&&!res.writableEnded)reject(504,'outcome_unknown');},serviceDeadline);
    void Promise.resolve().then(()=>{if(controller.signal.aborted)throw Error('Cancelled');serviceStarted=true;return service.start(input.request,input.snapshot,controller.signal);}).then(answer=>{
     if(answer.status!=='completed'||controller.signal.aborted)requiresReview=true;
     if(res.destroyed||res.writableEnded)return;
     if(!['completed','uncertain','existing'].includes(answer.status)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(answer.operationId)){requiresReview=true;reject(500,'outcome_unknown');return;}
     res.writeHead(200,{'content-type':'application/json','connection':'close','cache-control':'no-store'});res.end(JSON.stringify({status:answer.status,operationId:answer.operationId,jobId:input.request.jobId}));
    }).catch(()=>{if(serviceStarted)requiresReview=true;if(!res.destroyed&&!res.writableEnded)reject(500,'outcome_unknown');}).finally(cleanup);
   });
   res.on('close',()=>{if(!ended)cleanup();});
  });
  server.maxConnections=8;server.headersTimeout=5000;server.requestTimeout=15000;server.keepAliveTimeout=1000;
  server.on('connection',socket=>{connections.add(socket);socket.once('close',()=>connections.delete(socket));});
  server.on('checkContinue',(_req,res)=>res.destroy());server.on('checkExpectation',(_req,res)=>res.destroy());
  server.on('connect',(_req,socket)=>socket.destroy());server.on('upgrade',(_req,socket)=>socket.destroy());server.on('clientError',(_error,socket)=>socket.destroy());
  server.on('newSession',(_id,_data,done)=>done());server.on('resumeSession',(_id,done)=>done(null,null));
  await new Promise<void>((ok,fail)=>{server!.once('error',fail);server!.listen(socketPath,()=>{server!.off('error',fail);ok();});});
  await chown(socketPath,uid,config.groupId);await chmod(socketPath,0o660);
  const socketStat=await lstat(socketPath),dirStat=await lstat(directory);
  if(!socketStat.isSocket()||socketStat.uid!==uid||socketStat.gid!==config.groupId||(socketStat.mode&0o7777)!==0o660||!dirStat.isDirectory()||dirStat.isSymbolicLink()||dirStat.uid!==uid||dirStat.gid!==config.groupId||(dirStat.mode&0o7777)!==0o700)throw Error('Runner transport socket could not be verified.');
  await chmod(directory,0o710);
  const published=await lstat(directory);
  if(!published.isDirectory()||published.isSymbolicLink()||published.uid!==uid||published.gid!==config.groupId||(published.mode&0o7777)!==0o710)throw Error('Runner transport directory could not be verified.');
  ready=true;const listening=server;
  return {socketPath,close:async()=>{
   if(busy)requiresReview=true;
   for(const controller of active)controller.abort();
   const closed=new Promise<void>((ok,fail)=>listening.close(error=>error?fail(error):ok()));
   for(const socket of connections)socket.destroy();
   await closed;return {serviceSettled:!busy,requiresReview,directoryRemoved:!busy&&!requiresReview?await removeOwnEmptyDirectory():false};
  }};
 }catch(error){ready=false;if(busy)requiresReview=true;for(const controller of active)controller.abort();if(server?.listening){for(const socket of connections)socket.destroy();await new Promise<void>(ok=>server!.close(()=>ok()));}if(!busy&&!requiresReview)await removeOwnEmptyDirectory();throw error;}
}
