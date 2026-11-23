import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {chmod,chown,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {createServer as createHttpsServer,request as httpsRequest} from 'node:https';
import {connect as tlsConnect,type TLSSocket} from 'node:tls';
import {join} from 'node:path';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerService} from '../../src/server/state/runner-service';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';
import {RunnerServiceAdmission} from '../../src/server/state/runner-service-admission';
import {RunnerTransportClient} from '../../src/server/state/runner-transport-client';
import {promisify} from 'node:util';
import {startRunnerUnixTransport} from '../../src/server/state/runner-transport-unix';
import {validateRunnerSnapshot} from '../../src/server/state/runner-snapshot';
import {RUNNER_TRANSPORT_MAX_BODY_BYTES} from '../../src/server/state/runner-transport-input';

const exec=promisify(execFile);
const snapshot={version:1,files:[{path:'test/example.test.js',mode:'100644',base64:Buffer.from('test').toString('base64')}]};
const job={jobId:'job-1',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:validateRunnerSnapshot(snapshot).digest,recipe:'test-run',limits:{timeoutMs:1000,outputBytes:1024,memoryBytes:64*1024*1024,cpus:1,pids:16}};
const body=JSON.stringify({request:job,snapshot});
async function certificates(root:string){
 const run=(...args:string[])=>exec('openssl',args,{cwd:root});
 await run('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-subj','/CN=Runner test CA','-days','1');
 for(const name of ['server','client','wrong']){
  await run('req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name);
  await writeFile(join(root,name+'.ext'),name==='server'?'subjectAltName=DNS:runner.local\nextendedKeyUsage=serverAuth\n':'extendedKeyUsage=clientAuth\n');
  await run('x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext');
 }
 const get=(name:string)=>readFile(join(root,name));
 const [ca,server,serverKey,client,clientKey,wrong,wrongKey]=await Promise.all(['ca.pem','server.pem','server.key','client.pem','client.key','wrong.pem','wrong.key'].map(get));
 return {ca,server,serverKey,client,clientKey,wrong,wrongKey,pin:new X509Certificate(client).fingerprint256.replaceAll(':','').toLowerCase()};
}
function send(socketPath:string,certs:Awaited<ReturnType<typeof certificates>>,options:{body?:string;path?:string;client?:'good'|'wrong'|'none';length?:number}={}){
 return new Promise<{status:number;body:string}>((resolve,reject)=>{
  const payload=options.body??body,client=options.client??'good';
  const req=httpsRequest({socketPath,servername:'runner.local',host:'runner.local',path:options.path??'/v1/jobs',method:'POST',ca:certs.ca,cert:client==='none'?undefined:client==='wrong'?certs.wrong:certs.client,key:client==='none'?undefined:client==='wrong'?certs.wrongKey:certs.clientKey,agent:false,headers:{'content-type':'application/json','content-length':String(options.length??Buffer.byteLength(payload))}},res=>{
   let response='';res.setEncoding('utf8');res.on('data',chunk=>response+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:response}));res.on('error',reject);
  });
  req.setTimeout(4000,()=>req.destroy(new Error('test deadline')));req.on('error',reject);req.end(payload);
 });
}
async function openRaw(socketPath:string,certs:Awaited<ReturnType<typeof certificates>>):Promise<TLSSocket>{
 return await new Promise((resolve,reject)=>{const socket=tlsConnect({path:socketPath,servername:'runner.local',ca:certs.ca,cert:certs.client,key:certs.clientKey},()=>resolve(socket));socket.once('error',reject);socket.setTimeout(4000,()=>socket.destroy(new Error('test deadline')));});
}
async function writable(path:string):Promise<void>{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())return;await chmod(path,0o700);for(const child of await readdir(path))await writable(join(path,child));}

test('Unix TLS fixed-job transport authenticates, bounds input and handles stuck work conservatively',async t=>{
 const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||!gid){t.skip('requires non-root POSIX identity');return;}
 const root=await mkdtemp(join(await realpath('/tmp'),'prt-')),parent=join(root,'p');await mkdir(parent,{mode:0o710});await chown(parent,uid,gid);await chmod(parent,0o710);
 let transport:Awaited<ReturnType<typeof startRunnerUnixTransport>>|undefined;
 try{
  const certs=await certificates(root),config={parent,groupId:gid,applicationUid:uid+1,key:certs.serverKey,cert:certs.server,clientCa:certs.ca,clientFingerprintSha256:certs.pin,serviceDeadlineMs:100};
  let calls=0,hang=false,aborted=false,finish:(()=>void)|undefined;
  const service={async start(_request:unknown,_snapshot:unknown,signal?:AbortSignal):Promise<{status:'completed'|'uncertain';operationId:string}>{
   calls++;if(hang)await new Promise<void>(resolve=>{finish=resolve;signal?.addEventListener('abort',()=>{aborted=true;},{once:true});});
   return {status:hang?'uncertain':'completed',operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
  }};
  await assert.rejects(startRunnerUnixTransport({...config,applicationUid:uid},service),/identity configuration/);
  transport=await startRunnerUnixTransport(config,service);
  assert.equal((await lstat(join(parent,'socket'))).mode&0o777,0o710);assert.equal((await lstat(transport.socketPath)).mode&0o777,0o660);
  const success=await send(transport.socketPath,certs);assert.equal(success.status,200);assert.equal(JSON.parse(success.body).status,'completed');assert.equal(calls,1);
  await assert.rejects(send(transport.socketPath,certs,{client:'none'}));
  assert.equal(calls,1,'a missing client certificate must not dispatch');
  await assert.rejects(send(transport.socketPath,certs,{client:'wrong'}));
  assert.equal(calls,1,'a CA-valid but unpinned client certificate must not dispatch');
  assert.equal((await send(transport.socketPath,certs,{path:'/v1/jobs?x=1'})).status,400);
  assert.equal((await send(transport.socketPath,certs,{body:body.replace('"jobId":','"jobId":"duplicate","jobId":')})).status,400);
  assert.equal((await send(transport.socketPath,certs,{length:RUNNER_TRANSPORT_MAX_BODY_BYTES+1,body:''})).status,413);assert.equal(calls,1);
  hang=true;const timed=await send(transport.socketPath,certs);assert.equal(timed.status,504);assert.equal(JSON.parse(timed.body).error,'outcome_unknown');assert.equal(aborted,true);
  assert.equal((await send(transport.socketPath,certs)).status,503,'stuck work retains the transport slot');
  const stopped=await transport.close();transport=undefined;assert.equal(stopped.serviceSettled,false);assert.equal(stopped.requiresReview,true);assert.equal(stopped.directoryRemoved,false);finish?.();
 }finally{if(transport)await transport.close();await rm(root,{recursive:true,force:true});}
});

test('Unix TLS reaches the real journal once and disconnect retains uncertainty',async t=>{
 const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||!gid){t.skip('requires non-root POSIX identity');return;}
 const root=await mkdtemp(join(await realpath('/tmp'),'prt-')),parent=join(root,'p'),privateRoot=join(root,'snap');await mkdir(parent,{mode:0o710});await chown(parent,uid,gid);await chmod(parent,0o710);await mkdir(privateRoot,{mode:0o700});
 const store=new ControlStore(join(root,'store'));let transport:Awaited<ReturnType<typeof startRunnerUnixTransport>>|undefined;
 try{
  const certs=await certificates(root);new RunnerServicePolicyStore(store).update({expectedRevision:0,enabled:true,targets:[{agentId:job.agentId,projectId:job.projectId,sessionId:job.sessionId,workspaceId:job.workspaceId}],limits:job.limits,maxJobsPerHour:10});
  let calls=0,block=false,aborted=false,onStart:()=>void=()=>{},release:()=>void=()=>{};const seen=new Promise<void>(resolve=>onStart=resolve);
  const service=new RunnerService(store,{privateRoot,applicationUid:uid+1},{async run({signal}){calls++;if(block){onStart();await new Promise<void>(resolve=>{release=resolve;signal.addEventListener('abort',()=>{aborted=true;},{once:true});});}return {exitCode:0,stdout:Buffer.from('ok'),stderr:Buffer.alloc(0)};}});
  transport=await startRunnerUnixTransport({parent,groupId:gid,applicationUid:uid+1,key:certs.serverKey,cert:certs.server,clientCa:certs.ca,clientFingerprintSha256:certs.pin,serviceDeadlineMs:3000},service);
  const client=new RunnerTransportClient({socketPath:transport.socketPath,serverName:'runner.local',serverCa:certs.ca,clientCert:certs.client,clientKey:certs.clientKey,serverFingerprintSha256:new X509Certificate(certs.server).fingerprint256.replaceAll(':','').toLowerCase(),deadlineMs:2000});
  assert.equal((await client.inspect(job)).status,'unavailable');
  assert.equal((await send(transport.socketPath,certs,{path:'/v1/jobs/inspect',body:'{"request":null,"request":null}'})).status,500);
  await assert.rejects(send(transport.socketPath,certs,{path:'/v1/jobs/inspect',body:JSON.stringify({request:job}),client:'wrong'}));
  const first=await send(transport.socketPath,certs);assert.equal(JSON.parse(first.body).status,'completed');assert.equal(calls,1);
  const completed=await client.inspect(job);assert.equal(completed.status,'receipt-recorded');if(completed.status==='receipt-recorded'){assert.equal(completed.receipt.exitCode,0);assert.equal(completed.receipt.snapshotDigest,job.snapshotDigest);}
  assert.equal((await client.inspect({...job,workspaceId:'different'})).status,'unavailable','changed identity cannot inspect this job');
  block=true;const payload=JSON.stringify({request:{...job,jobId:'job-2'},snapshot});
  const streaming=httpsRequest({socketPath:transport.socketPath,servername:'runner.local',host:'runner.local',path:'/v1/jobs',method:'POST',ca:certs.ca,cert:certs.client,key:certs.clientKey,agent:false,headers:{'content-type':'application/json','content-length':String(Buffer.byteLength(payload))}});streaming.on('error',()=>{});streaming.end(payload);
  await seen;assert.deepEqual(await client.inspect({...job,jobId:'job-2'}),{status:'inspection-unknown'},'active body/service retains the shared slot');streaming.destroy();
  const journal=new RunnerServiceAdmission(store),deadline=Date.now()+3000;let state='pending';
  while(Date.now()<deadline){const row=store.db.prepare("SELECT id FROM operations WHERE kind='runner-service.job' ORDER BY rowid DESC LIMIT 1").get() as {id:string};state=journal.inspect(row.id).state;if(state==='unknown')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(state,'unknown');assert.equal(calls,2);assert.equal(aborted,true);
  const inspected=await client.inspect({...job,jobId:'job-2'});assert.equal(inspected.status,'uncertain');
  assert.equal((await client.inspect({...job,jobId:'job-3'})).status,'unavailable');
  assert.equal((await send(transport.socketPath,certs,{body:JSON.stringify({request:{...job,jobId:'job-3'},snapshot})})).status,503,'an unconfirmed runtime keeps the transport fenced');
  const closed=await transport.close();transport=undefined;assert.equal(closed.requiresReview,true);assert.equal(closed.directoryRemoved,false);
  await assert.rejects(startRunnerUnixTransport({parent,groupId:gid,applicationUid:uid+1,key:certs.serverKey,cert:certs.server,clientCa:certs.ca,clientFingerprintSha256:certs.pin},service),/EEXIST/);
  release();await new Promise(resolve=>setTimeout(resolve,10));
 }finally{if(transport)await transport.close();store.close();await writable(root);await rm(root,{recursive:true,force:true});}
});



test('partial uploads release the slot; pipelining does not cancel an admitted job',async t=>{
 const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||!gid){t.skip('requires non-root POSIX identity');return;}
 const root=await mkdtemp(join(await realpath('/tmp'),'prt-')),parent=join(root,'p');await mkdir(parent,{mode:0o710});await chown(parent,uid,gid);await chmod(parent,0o710);
 let transport:Awaited<ReturnType<typeof startRunnerUnixTransport>>|undefined;
 try{
  const certs=await certificates(root);let calls=0,hold=false,aborted=false,start:()=>void=()=>{},release:()=>void=()=>{};const started=new Promise<void>(resolve=>start=resolve);
  const service={async start(_request:unknown,_snapshot:unknown,signal?:AbortSignal):Promise<{status:'completed';operationId:string}>{calls++;if(hold){start();await new Promise<void>(resolve=>{release=resolve;signal?.addEventListener('abort',()=>{aborted=true;},{once:true});});}return {status:'completed',operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};}};
  transport=await startRunnerUnixTransport({parent,groupId:gid,applicationUid:uid+1,key:certs.serverKey,cert:certs.server,clientCa:certs.ca,clientFingerprintSha256:certs.pin,serviceDeadlineMs:3000},service);
  const eol=String.fromCharCode(13,10);const partial=await openRaw(transport.socketPath,certs);partial.on('error',()=>{});partial.write(['POST /v1/jobs HTTP/1.1','Host: runner.local','Content-Type: application/json','Content-Length: 100','','{'].join(eol));
  let response=0,deadline=Date.now()+3000;while(Date.now()<deadline){response=(await send(transport.socketPath,certs)).status;if(response===503)break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(response,503);const baseline=calls;
  partial.destroy();deadline=Date.now()+3000;while(Date.now()<deadline){response=(await send(transport.socketPath,certs)).status;if(response===200)break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(response,200);assert.equal(calls,baseline+1);
  hold=true;const pipeline=await openRaw(transport.socketPath,certs);let data='';pipeline.setEncoding('utf8');pipeline.on('data',chunk=>data+=chunk);const closed=new Promise<void>((resolve,reject)=>{pipeline.once('close',()=>resolve());pipeline.once('error',reject);});
  const wire=['POST /v1/jobs HTTP/1.1','Host: runner.local','Content-Type: application/json','Content-Length: '+Buffer.byteLength(body),'',body].join(eol);
  pipeline.write(wire+wire);await started;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(aborted,false,'pipelining must not abort the first accepted job');release();await closed;
  assert.ok(data.startsWith('HTTP/1.1 200'),data);assert.equal(data.includes('HTTP/1.1 400'),false,'connection closes after the first response');assert.equal(calls,baseline+2);assert.equal(aborted,false);
 }finally{if(transport)await transport.close();await rm(root,{recursive:true,force:true});}
});


test('startup and close never remove unexpected socket-directory evidence',async t=>{
 const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||!gid){t.skip('requires non-root POSIX identity');return;}
 const root=await mkdtemp(join(await realpath('/tmp'),'prt-')),parent=join(root,'p');await mkdir(parent,{mode:0o710});await chown(parent,uid,gid);await chmod(parent,0o710);
 let transport:Awaited<ReturnType<typeof startRunnerUnixTransport>>|undefined;
 try{
  const certs=await certificates(root),config={parent,groupId:gid,applicationUid:uid+1,key:certs.serverKey,cert:certs.server,clientCa:certs.ca,clientFingerprintSha256:certs.pin};
  const service={async start(){return {status:'completed' as const,operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};}};
  await assert.rejects(startRunnerUnixTransport({...config,key:'not-a-private-key'},service));
  await assert.rejects(lstat(join(parent,'socket')),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT');
  await mkdir(join(parent,'socket'),{mode:0o700});await writeFile(join(parent,'socket','sentinel'),'evidence');
  await assert.rejects(startRunnerUnixTransport(config,service),/EEXIST/);assert.equal(await readFile(join(parent,'socket','sentinel'),'utf8'),'evidence');
  await rm(join(parent,'socket'),{recursive:true});transport=await startRunnerUnixTransport(config,service);
  await writeFile(join(parent,'socket','sentinel'),'preserve');const result=await transport.close();transport=undefined;
  assert.equal(result.serviceSettled,true);assert.equal(result.requiresReview,false);assert.equal(result.directoryRemoved,false);assert.equal(await readFile(join(parent,'socket','sentinel'),'utf8'),'preserve');
 }finally{if(transport)await transport.close();await rm(root,{recursive:true,force:true});}
});


test('ambiguous HTTP framing and upgrades cannot dispatch a job',async t=>{
 const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||!gid){t.skip('requires non-root POSIX identity');return;}
 const root=await mkdtemp(join(await realpath('/tmp'),'prt-')),parent=join(root,'p');await mkdir(parent,{mode:0o710});await chown(parent,uid,gid);await chmod(parent,0o710);
 let transport:Awaited<ReturnType<typeof startRunnerUnixTransport>>|undefined;
 try{
  const certs=await certificates(root);let calls=0;const service={async start(){calls++;return {status:'completed' as const,operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};}};
  transport=await startRunnerUnixTransport({parent,groupId:gid,applicationUid:uid+1,key:certs.serverKey,cert:certs.server,clientCa:certs.ca,clientFingerprintSha256:certs.pin},service);
  const eol=String.fromCharCode(13,10),cases=[
   ['POST /v1/jobs HTTP/1.1','Host: runner.local','Content-Type: application/json','Content-Length: 2','Content-Length: 2','','{}'],
   ['POST /v1/jobs HTTP/1.1','Host: runner.local','Content-Type: application/json','Transfer-Encoding: chunked','','0','',''],
   ['POST /v1/jobs HTTP/1.1','Host: runner.local','Content-Type: application/json','Content-Length: 2','Expect: 100-continue','','{}'],
   ['GET /v1/jobs HTTP/1.1','Host: runner.local','Connection: upgrade','Upgrade: websocket','',''],
   ['POST /v1/jobs HTTP/1.1','Host: runner.local','Content-Type: application/json','Content-Length: 2','Content-Encoding: gzip','','{}']
  ];
  for(const parts of cases){const socket=await openRaw(transport.socketPath,certs);let data='';socket.setEncoding('utf8');socket.on('data',chunk=>data+=chunk);const closed=new Promise<void>(resolve=>{socket.once('error',()=>{});socket.once('close',()=>resolve());});socket.write(parts.join(eol));await closed;assert.equal(data.includes(' 200 '),false);}
  assert.equal(calls,0);
 }finally{if(transport)await transport.close();await rm(root,{recursive:true,force:true});}
});


test('the client pins the server, never retries, and preserves ambiguous outcomes',async t=>{
 const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||!gid){t.skip('requires non-root POSIX identity');return;}
 const root=await mkdtemp(join(await realpath('/tmp'),'prt-')),parent=join(root,'p');await mkdir(parent,{mode:0o710});await chown(parent,uid,gid);await chmod(parent,0o710);
 let transport:Awaited<ReturnType<typeof startRunnerUnixTransport>>|undefined,release:()=>void=()=>{};
 try{
  const certs=await certificates(root);let calls=0,hang=false,aborted=false;
  const service={async start(_request:unknown,_snapshot:unknown,signal?:AbortSignal):Promise<{status:'completed'|'uncertain';operationId:string}>{calls++;if(hang)await new Promise<void>(resolve=>{release=resolve;signal?.addEventListener('abort',()=>{aborted=true;},{once:true});});return {status:hang?'uncertain':'completed',operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};}};
  transport=await startRunnerUnixTransport({parent,groupId:gid,applicationUid:uid+1,key:certs.serverKey,cert:certs.server,clientCa:certs.ca,clientFingerprintSha256:certs.pin,serviceDeadlineMs:3000},service);
  const config={socketPath:transport.socketPath,serverName:'runner.local',serverCa:certs.ca,clientCert:certs.client,clientKey:certs.clientKey,serverFingerprintSha256:new X509Certificate(certs.server).fingerprint256.replaceAll(':','').toLowerCase(),deadlineMs:150};
  const client=new RunnerTransportClient(config),badPin=new RunnerTransportClient({...config,serverFingerprintSha256:'f'.repeat(64)}),badName=new RunnerTransportClient({...config,serverName:'wrong.local'});
  assert.deepEqual(await client.submit({...job,recipe:'shell'},snapshot),{status:'not-dispatched'});
  const cancelled=new AbortController();cancelled.abort();assert.deepEqual(await client.submit(job,snapshot,cancelled.signal),{status:'not-dispatched'});
  assert.deepEqual(await badPin.submit(job,snapshot),{status:'unknown'});assert.deepEqual(await badName.submit(job,snapshot),{status:'unknown'});assert.equal(calls,0);
  assert.equal((await client.submit(job,snapshot)).status,'completed');assert.equal(calls,1);
  hang=true;assert.deepEqual(await client.submit({...job,jobId:'job-2'},snapshot),{status:'unknown'});assert.equal(calls,2);
  const until=Date.now()+2000;while(!aborted&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(aborted,true);
  assert.deepEqual(await client.submit({...job,jobId:'job-3'},snapshot),{status:'unknown'});assert.equal(calls,2,'no automatic retry and no further dispatch while fenced');
  const result=await transport.close();transport=undefined;assert.equal(result.requiresReview,true);assert.equal(result.directoryRemoved,false);release();
 }finally{release();if(transport)await transport.close();await rm(root,{recursive:true,force:true});}
});


test('the client refuses a mismatched job echo and ambiguous service response without retry',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires non-root POSIX identity');return;}
 const root=await mkdtemp(join(await realpath('/tmp'),'prt-'));let server:ReturnType<typeof createHttpsServer>|undefined;
 try{
  const certs=await certificates(root),socketPath=join(root,'fake.sock');let calls=0,response=JSON.stringify({status:'completed',operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',jobId:'different-job'});
  server=createHttpsServer({key:certs.serverKey,cert:certs.server,ca:certs.ca,requestCert:true,rejectUnauthorized:true},(req,res)=>{calls++;req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/json','connection':'close'});res.end(response);});});
  await new Promise<void>((resolve,reject)=>server!.listen(socketPath,resolve).once('error',reject));
  const client=new RunnerTransportClient({socketPath,serverName:'runner.local',serverCa:certs.ca,clientCert:certs.client,clientKey:certs.clientKey,serverFingerprintSha256:new X509Certificate(certs.server).fingerprint256.replaceAll(':','').toLowerCase(),deadlineMs:2000});
  assert.deepEqual(await client.submit(job,snapshot),{status:'unknown'});assert.equal(calls,1);
  response='{"status":"completed","status":"completed","operationId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","jobId":"job-1"}';
  assert.deepEqual(await client.submit(job,snapshot),{status:'unknown'});assert.equal(calls,2);
  response=JSON.stringify({jobId:'job-1',status:'receipt-recorded',operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',receipt:{snapshotDigest:'f'.repeat(64),exitCode:0,stdoutDigest:'a'.repeat(64),stderrDigest:'b'.repeat(64),stdoutBytes:0,stderrBytes:0,durationMs:0}});
  assert.deepEqual(await client.inspect(job),{status:'inspection-unknown'});assert.equal(calls,3);
  response='{"jobId":"job-1","jobId":"job-1","status":"unavailable","operationId":null,"receipt":null}';
  assert.deepEqual(await client.inspect(job),{status:'inspection-unknown'});assert.equal(calls,4);
 }finally{if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
