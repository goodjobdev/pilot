import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { adoptRunningSessions } from '../../src/server/state/session-lifecycle';
import { initialQueue, nextQueueRevision, queueRequestId } from '../../src/shared/queue';

const wait = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** Wait until a session reports not-working twice in a row, so a generation that pauses between two
 * requests cannot land one after a count baseline was taken. */
async function settle(app:Awaited<ReturnType<typeof createApp>>,security:ReturnType<typeof localConfig>,projectId:string,sessionId:string):Promise<void>{
 let quiet=0;
 for(let i=0;i<200;i++){
  const response=await fetch(security.origin+'/api/projects/'+projectId+'/agents?sessionId='+encodeURIComponent(sessionId),{headers:{'x-dashboard-token':security.token}});
  const value=await response.json() as {view:{working:boolean}};
  if(value.view.working){quiet=0;await wait(25);continue;}
  quiet+=1;
  if(quiet>=2)return;
  await wait(60);
 }
 throw Error('the session never settled');
}

test('ack route is strict, CSRF protected, project scoped, and refuses absent/nonterminal proof without dispatch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-uncertain-ack-route-'));
 const security=localConfig('http://127.0.0.1:0'),control=new ControlStore(root);let requests=0;
 const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control,onModelRequest:()=>{requests++;}});
 try{
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  security.origin='http://127.0.0.1:'+ (app.server.address() as {port:number}).port;
  const headers={'x-dashboard-token':security.token,origin:security.origin,'content-type':'application/json'};
  const project=await app.catalog.register({name:'Ack route fixture',managed:true,confirm:true});
  const session=await app.sessions!.create({projectId:project.id,name:'Ack candidate'});
  // Create and finish the conversation so the status read is exercised against a real harness store.
  const input=await fetch(security.origin+'/api/projects/'+project.id+'/agents/input',{method:'POST',headers,body:JSON.stringify({sessionId:session.id,text:'prepare conversation',mode:'followUp',requestId:'setup-request'})});
  assert.equal(input.status,200);
  for(let i=0;i<100;i++){
   const view=await fetch(security.origin+'/api/projects/'+project.id+'/agents?sessionId='+session.id,{headers:{'x-dashboard-token':security.token}});
   const data=await view.json() as {view:{working:boolean}};if(!data.view.working)break;await wait(25);
  }
  // A request identity not present in storage cannot be acknowledged, even when the session is idle.
  app.lifecycle!.markRunning({projectId:project.id,sessionId:session.id,requestId:'absent-original'});
  adoptRunningSessions(app.lifecycle!,new Date());
  const revision=app.lifecycle!.read(project.id,session.id).revision;
  const endpoint=security.origin+'/api/sessions/'+encodeURIComponent(session.id)+'/lifecycle/acknowledge-uncertainty';
  const before=requests;
  const noCsrf=await fetch(endpoint,{method:'POST',headers:{'x-dashboard-token':security.token,'content-type':'application/json'},body:JSON.stringify({projectId:project.id,revision})});
  assert.equal(noCsrf.status,403);
  const extra=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({projectId:project.id,revision,actor:'owner'})});
  assert.equal(extra.status,422,'actor is not accepted from the client');
  const stale=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({projectId:project.id,revision:revision-1})});
  assert.equal(stale.status,409);
  assert.equal(app.lifecycle!.read(project.id,session.id).revision,revision,'stale CAS wrote nothing');
  const absent=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({projectId:project.id,revision})});
  assert.equal(absent.status,409,'a missing exact original status fails closed');
  assert.equal(app.lifecycle!.read(project.id,session.id).uncertain,true);
  assert.equal(requests,before,'proof and every refusal dispatch no model request');

  // A successful HTTP acknowledgement uses real terminal submission evidence, a quiet conversation,
  // and an empty queue. It retains the same request identity and performs no provider request.
  const verified=await app.sessions!.create({projectId:project.id,name:'Verified terminal candidate'});
  const sent=await fetch(security.origin+'/api/projects/'+project.id+'/agents/input',{method:'POST',headers,body:JSON.stringify({sessionId:verified.id,text:'terminal proof',mode:'followUp',requestId:'verified-terminal-request'})});
  assert.equal(sent.status,200);
  let idle=false;
  for(let i=0;i<100;i++){
   const response=await fetch(security.origin+'/api/projects/'+project.id+'/agents?sessionId='+encodeURIComponent(verified.id),{headers:{'x-dashboard-token':security.token}});
   const value=await response.json() as {view:{working:boolean}};
   if(!value.view.working){idle=true;break;}await wait(25);
  }
  assert.equal(idle,true,'terminal proof conversation is idle');
  const entry=await app.queue!.append({projectId:project.id,sessionId:verified.id,revision:0,text:'Pilot queue fixture'});
  app.lifecycle!.markRunning({projectId:project.id,sessionId:verified.id,requestId:'verified-terminal-request'});
  adoptRunningSessions(app.lifecycle!,new Date());
  const verifiedRecord=app.lifecycle!.read(project.id,verified.id);
  const ackUrl=security.origin+'/api/sessions/'+encodeURIComponent(verified.id)+'/lifecycle/acknowledge-uncertainty';
  const dispatchesBeforeQueueChecks=requests;
  const refuseQueue=async(revision:number)=>fetch(ackUrl,{method:'POST',headers,body:JSON.stringify({projectId:project.id,revision})});
  assert.equal((await refuseQueue(verifiedRecord.revision)).status,409,'queued Pilot intent blocks acknowledgement');
  const claimed=await app.queue!.claim({projectId:project.id,sessionId:verified.id,owner:'route-test-owner'});
  assert.equal(claimed.entry?.state,'claimed');
  assert.equal((await refuseQueue(verifiedRecord.revision)).status,409,'claimed Pilot intent blocks acknowledgement');
  await app.queue!.release({projectId:project.id,sessionId:verified.id,entryId:entry.entry!.id,owner:'route-test-owner'});
  const queuedAgain=app.queue!.read(project.id,verified.id);
  const cancelled=await app.queue!.cancel({projectId:project.id,sessionId:verified.id,revision:queuedAgain.revision,entryId:entry.entry!.id});
  assert.equal(cancelled.entry?.state,'cancelled');
  assert.equal(requests,dispatchesBeforeQueueChecks,'queue verification, claim, release and cancellation dispatch no model request');
  const terminalQueueRecord=app.lifecycle!.read(project.id,verified.id);
  const dispatchesBeforeAck=requests;
  const accepted=await refuseQueue(terminalQueueRecord.revision);
  assert.equal(accepted.status,200);
  const result=await accepted.json() as {lifecycle:{state:string;requestId:string;uncertain:boolean};dispatched:boolean;outcome:string};
  assert.equal(result.outcome,'acknowledged');assert.equal(result.dispatched,false);
  assert.equal(result.lifecycle.state,'idle');assert.equal(result.lifecycle.uncertain,false);
  assert.equal(result.lifecycle.requestId,'verified-terminal-request','the original request identity is retained');
  assert.equal(requests,dispatchesBeforeAck,'successful verification also performs no model dispatch');

  // A submitted Pilot entry and then its unresolved failed attention state both block acknowledgement.
  const submitted=await app.sessions!.create({projectId:project.id,name:'Submitted queue candidate'});
  const original=await fetch(security.origin+'/api/projects/'+project.id+'/agents/input',{method:'POST',headers,body:JSON.stringify({sessionId:submitted.id,text:'terminal submission proof',mode:'followUp',requestId:'submitted-proof-request'})});
  assert.equal(original.status,200);
  for(let i=0;i<100;i++){
   const response=await fetch(security.origin+'/api/projects/'+project.id+'/agents?sessionId='+encodeURIComponent(submitted.id),{headers:{'x-dashboard-token':security.token}});
   const value=await response.json() as {view:{working:boolean}};if(!value.view.working)break;await wait(25);
  }
  const queued=await app.queue!.append({projectId:project.id,sessionId:submitted.id,revision:0,text:'submitted queue fixture'});
  await app.queue!.claim({projectId:project.id,sessionId:submitted.id,owner:'route-test-owner'});
  const inFlight=await app.queue!.submit({projectId:project.id,sessionId:submitted.id,entryId:queued.entry!.id,owner:'route-test-owner'});
  assert.equal(inFlight.entry?.state,'submitted');
  await settle(app,security,project.id,submitted.id);
  app.lifecycle!.markRunning({projectId:project.id,sessionId:submitted.id,requestId:'submitted-proof-request'});
  adoptRunningSessions(app.lifecycle!,new Date());
  let queueLifecycle=app.lifecycle!.read(project.id,submitted.id);
  await settle(app,security,project.id,submitted.id);
  const queueAckBaseline=requests;
  const submittedAck=await fetch(security.origin+'/api/sessions/'+encodeURIComponent(submitted.id)+'/lifecycle/acknowledge-uncertainty',{method:'POST',headers,body:JSON.stringify({projectId:project.id,revision:queueLifecycle.revision})});
  assert.equal(submittedAck.status,409,'submitted Pilot entry blocks acknowledgement');
  const failed=await app.queue!.reconcile({projectId:project.id,sessionId:submitted.id,entryId:queued.entry!.id});
  assert.equal(failed.entry?.state,'failed');
  queueLifecycle=app.lifecycle!.read(project.id,submitted.id);
  const failedAck=await fetch(security.origin+'/api/sessions/'+encodeURIComponent(submitted.id)+'/lifecycle/acknowledge-uncertainty',{method:'POST',headers,body:JSON.stringify({projectId:project.id,revision:queueLifecycle.revision})});
  assert.equal(failedAck.status,409,'failed Pilot entry still needs owner resolution');
  const failedQueue=app.queue!.read(project.id,submitted.id);
  await app.queue!.cancel({projectId:project.id,sessionId:submitted.id,revision:failedQueue.revision,entryId:queued.entry!.id});
  queueLifecycle=app.lifecycle!.read(project.id,submitted.id);
  const clearedAck=await fetch(security.origin+'/api/sessions/'+encodeURIComponent(submitted.id)+'/lifecycle/acknowledge-uncertainty',{method:'POST',headers,body:JSON.stringify({projectId:project.id,revision:queueLifecycle.revision})});
  assert.equal(clearedAck.status,200,'cancelled Pilot entry permits acknowledgement after proof');
  assert.equal(requests,queueAckBaseline,'acknowledgement verification and refusals dispatch no model request');

  // A settled Pilot row is also terminal. Seed a schema-valid durable queue operation through the
  // real ControlStore, without installing or faking a dispatch port.
  const settledSession=await app.sessions!.create({projectId:project.id,name:'Settled queue candidate'});
  const settledOriginal=await fetch(security.origin+'/api/projects/'+project.id+'/agents/input',{method:'POST',headers,body:JSON.stringify({sessionId:settledSession.id,text:'settled proof',mode:'followUp',requestId:'settled-proof-request'})});
  assert.equal(settledOriginal.status,200);
  for(let i=0;i<100;i++){
   const response=await fetch(security.origin+'/api/projects/'+project.id+'/agents?sessionId='+encodeURIComponent(settledSession.id),{headers:{'x-dashboard-token':security.token}});
   const value=await response.json() as {view:{working:boolean}};if(!value.view.working)break;await wait(25);
  }
  const at=new Date().toISOString(),entryId='settled-entry-fixture',requestId=queueRequestId(entryId);
  const settledEntry={id:entryId,position:0,text:'already reconciled',images:[],state:'settled' as const,claim:null,submission:{requestId,submissionId:'settled-submission-fixture',acceptedAt:at},attention:null,createdAt:at,updatedAt:at};
  const settledRecord=nextQueueRevision(initialQueue(project.id,settledSession.id),{entries:[settledEntry],now:new Date(at)});
  control.admit({scope:{projectId:project.id,sessionId:settledSession.id},idempotencyKey:'queue.r1',kind:'session.queue',input:settledRecord,outbox:{kind:'session.queue',payload:{version:1,projectId:project.id,sessionId:settledSession.id,revision:1}}});
  app.lifecycle!.markRunning({projectId:project.id,sessionId:settledSession.id,requestId:'settled-proof-request'});
  adoptRunningSessions(app.lifecycle!,new Date());
  const settledLifecycle=app.lifecycle!.read(project.id,settledSession.id),settledCalls=requests;
  const settledAck=await fetch(security.origin+'/api/sessions/'+encodeURIComponent(settledSession.id)+'/lifecycle/acknowledge-uncertainty',{method:'POST',headers,body:JSON.stringify({projectId:project.id,revision:settledLifecycle.revision})});
  assert.equal(settledAck.status,200,'settled Pilot entries permit acknowledgement');
  assert.equal(requests,settledCalls,'settled queue verification does not dispatch');

  // A cold project must not be opened merely to inspect an acknowledgement proof. The owner must
  // first open this conversation through Agents, which lets normal recovery guards run visibly.
  const coldProject=await app.catalog.register({name:'Cold acknowledgement fixture',managed:true,confirm:true});
  const coldSession=await app.sessions!.create({projectId:coldProject.id,name:'Cold candidate'});
  app.lifecycle!.markRunning({projectId:coldProject.id,sessionId:coldSession.id,requestId:'cold-request'});
  adoptRunningSessions(app.lifecycle!,new Date());
  const coldRecord=app.lifecycle!.read(coldProject.id,coldSession.id);
  const coldBefore=requests;
  const coldResponse=await fetch(security.origin+'/api/sessions/'+encodeURIComponent(coldSession.id)+'/lifecycle/acknowledge-uncertainty',{method:'POST',headers,body:JSON.stringify({projectId:coldProject.id,revision:coldRecord.revision})});
  assert.equal(coldResponse.status,409);
  assert.match((await coldResponse.json() as {error:string}).error,/Open the interrupted conversation in Agents/);
  assert.equal(app.lifecycle!.read(coldProject.id,coldSession.id).uncertain,true);
  assert.equal(requests,coldBefore,'cold proof refusal sent no provider request');
  await assert.rejects(access(join(root,'agents',coldProject.id,'session.sqlite')),'cold proof inspection did not open the harness database');
 }finally{await app.close();control.close();await rm(root,{recursive:true,force:true});}
});
