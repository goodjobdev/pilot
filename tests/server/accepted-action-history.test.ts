import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ControlStore} from '../../src/server/state/control-store';
import {acceptedActionHistory} from '../../src/server/state/accepted-action-history';
import {targetBoundArtifact} from '../../src/server/state/accepted-action';
import {AcceptedActionReviewStore,ActionReviewConflict} from '../../src/server/state/accepted-action-review';
import {createApp} from '../../src/server/main';
import {localConfig} from '../../src/server/security';

function admit(store:ControlStore,projectId:string,n:number,state:'pending'|'unknown'|'not-started'|'receipt-recorded',externalId='credential-like-secret'){
 const target={projectId,actionClass:'commit' as const,targetId:'fixed-target',targetRevision:1,targetDigest:'b'.repeat(64),contentRevision:'tree-'+n,commit:'a'.repeat(40)};
 const artifact=targetBoundArtifact(target),intent={projectId,sessionId:'session',agentId:'agent',evidenceId:'evidence-'+n,acceptanceId:'acceptance-'+n,actionClass:target.actionClass,artifact,contentRevision:target.contentRevision,targetId:target.targetId,targetRevision:target.targetRevision,targetDigest:target.targetDigest};
 const scope={projectId,sessionId:'accepted-actions'},key='accepted-action.'+createHash('sha256').update(artifact.revision).digest('hex');
 const result=store.admit({scope,idempotencyKey:key,kind:'accepted.action',input:intent,outbox:{kind:'accepted.action',payload:{version:1,acceptanceId:intent.acceptanceId}}});
 if(state==='unknown')store.updateOperation(result.operation.id,scope,1,'unknown');
 if(state==='not-started')store.updateOperation(result.operation.id,scope,1,'failed',{status:'not-started'});
 if(state==='receipt-recorded')store.updateOperation(result.operation.id,scope,1,'succeeded',{targetId:intent.targetId,artifact,externalId});
 return result.operation.id;
}

test('action history is project scoped, bounded, validates bindings, and redacts external IDs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-action-history-')),store=new ControlStore(root);
 try{
  admit(store,'project-a',1,'pending');admit(store,'project-a',2,'unknown');admit(store,'project-a',3,'not-started');admit(store,'project-a',4,'receipt-recorded');
  const hash='c'.repeat(40);admit(store,'project-a',5,'receipt-recorded',hash);admit(store,'project-b',1,'pending');
  const view=acceptedActionHistory(store,'project-a');assert.equal(view.items.length,5);assert.equal(view.truncated,false);
  assert.deepEqual(view.items.map(item=>item.state),['receipt-recorded','receipt-recorded','not-started','uncertain','uncertain']);
  assert.equal(view.items[0].receiptCommit,hash);assert.equal(view.items[1].receiptCommit,null);assert.doesNotMatch(JSON.stringify(view),/credential-like-secret/);
  assert.equal(acceptedActionHistory(store,'project-b').items.length,1);
  for(let n=6;n<=56;n++)admit(store,'project-a',n,'pending');
  const bounded=acceptedActionHistory(store,'project-a');assert.equal(bounded.items.length,50);assert.equal(bounded.truncated,true);assert.ok(bounded.nextBefore);
  const earlier=acceptedActionHistory(store,'project-a',bounded.nextBefore);assert.equal(earlier.items.length,6);assert.equal(earlier.nextBefore,null);
  assert.equal(new Set([...bounded.items,...earlier.items].map(item=>item.id)).size,56,'pages neither repeat nor omit intents');
  const foreign=acceptedActionHistory(store,'project-b').items[0].id;
  assert.throws(()=>acceptedActionHistory(store,'project-a',foreign),/Invalid action history cursor/);
  assert.throws(()=>acceptedActionHistory(store,'project-a','not-an-id'),/Invalid action history cursor/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('corrupt action history is refused rather than presented as a safe outcome',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-action-history-corrupt-')),store=new ControlStore(root);
 try{
  const op=admit(store,'project-a',1,'not-started');
  store.db.prepare('UPDATE outboxes SET receipt_json=? WHERE operation_id=?').run(JSON.stringify({status:'different'}),op);
  assert.throws(()=>acceptedActionHistory(store,'project-a'),/Invalid action evidence/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('owner observations bind the exact action revision and never change the intent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-action-observation-')),store=new ControlStore(root),other=new ControlStore(root);
 try{
  const actionId=admit(store,'project-a',1,'pending'),reviews=new AcceptedActionReviewStore(store),actor={kind:'owner',identity:'local'};
  const request={projectId:'project-a',actionId,actionRevision:1,revision:0,observation:'checked-uncertain',actor};
  assert.throws(()=>reviews.record({...request,actor:{kind:'agent',identity:'agent'}}),/Only an authenticated owner/);
  let raced=false;const admitControl=store.admit.bind(store);
  store.admit=input=>{if(input.kind==='accepted.review'&&!raced){raced=true;other.updateOperation(actionId,{projectId:'project-a',sessionId:'accepted-actions'},1,'unknown');}return admitControl(input);};
  assert.throws(()=>reviews.record(request),ActionReviewConflict);
  store.admit=admitControl;assert.equal(reviews.read('project-a',actionId).reviews.length,0);
  const result=reviews.record({...request,actionRevision:2,observation:'checked-no-effect-visible'});
  assert.equal(result.reviews.length,1);assert.equal(result.reviews[0].observedBy,'local');assert.equal(result.reviews[0].actionRevision,2);
  assert.equal(store.getOperation(actionId,{projectId:'project-a',sessionId:'accepted-actions'}).state,'unknown','observation cannot clear or resolve an action');
  assert.throws(()=>reviews.record({...request,actionRevision:2}),ActionReviewConflict,'duplicate/stale observation is not silently overwritten');
  assert.throws(()=>reviews.read('project-b',actionId));
 }finally{other.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('an observation reads one snapshot when a receipt arrives between linked reads',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-action-observation-snapshot-')),store=new ControlStore(root),other=new ControlStore(root);
 try{
  const actionId=admit(store,'project-a',1,'pending'),scope={projectId:'project-a',sessionId:'accepted-actions'},original=store.getOperation.bind(store);let raced=false;
  store.getOperation=(id,readScope)=>{const op=original(id,readScope);if(id===actionId&&!raced){raced=true;other.updateOperation(actionId,scope,1,'failed',{status:'not-started'});}return op;};
  const reviews=new AcceptedActionReviewStore(store);
  assert.throws(()=>reviews.record({projectId:'project-a',actionId,actionRevision:1,revision:0,observation:'checked-uncertain',actor:{kind:'owner',identity:'local'}}),ActionReviewConflict);
  assert.equal(raced,true);assert.equal(reviews.read('project-a',actionId).reviews.length,0);
 }finally{other.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('an uncertain effect cannot become not-started just by adding a failure receipt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-action-history-uncertain-')),store=new ControlStore(root);
 try{
  const actionId=admit(store,'project-a',1,'unknown');
  store.updateOperation(actionId,{projectId:'project-a',sessionId:'accepted-actions'},2,'failed',{status:'not-started'});
  assert.equal(acceptedActionHistory(store,'project-a').items[0].state,'uncertain');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('concurrent owner observations serialize and remain durable across reopen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-action-observation-race-'));let first=new ControlStore(root),second=new ControlStore(root);
 try{
  const actionId=admit(first,'project-a',1,'unknown'),review=new AcceptedActionReviewStore(first),competing=new AcceptedActionReviewStore(second);
  const request={projectId:'project-a',actionId,actionRevision:2,revision:0,observation:'checked-uncertain',actor:{kind:'owner',identity:'local'}};
  let raced=false;const original=first.admit.bind(first);
  first.admit=input=>{if(input.kind==='accepted.review'&&!raced){raced=true;competing.record(request);}return original(input);};
  assert.throws(()=>review.record(request),ActionReviewConflict);assert.equal(review.read('project-a',actionId).reviews.length,1);
  first.close();second.close();first=new ControlStore(root);second=new ControlStore(root);
  const reopened=new AcceptedActionReviewStore(first).read('project-a',actionId);assert.equal(reopened.reviews.length,1);assert.equal(reopened.reviews[0].observation,'checked-uncertain');assert.equal(reopened.action.state,'uncertain');
 }finally{first.close();second.close();await rm(root,{recursive:true,force:true});}
});

test('action history HTTP is owner-only and read-only, and does not expose another project',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-action-history-http-')),security=localConfig('http://127.0.0.1:0'),store=new ControlStore(root);
 const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'off',control:store});
 try{
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
  const auth={'x-dashboard-token':security.token},writes={...auth,origin:security.origin,'content-type':'application/json'};
  const project=await (await fetch(security.origin+'/api/projects',{method:'POST',headers:writes,body:JSON.stringify({name:'History fixture',managed:true,confirm:true})})).json() as {id:string};
  const id=admit(store,project.id,1,'unknown');const foreign=admit(store,'another-project',1,'receipt-recorded');
  const url=security.origin+'/api/projects/'+project.id+'/action-history';
  assert.equal((await fetch(url)).status,401);
  const response=await fetch(url,{headers:auth});assert.equal(response.status,200);
  const result=await response.json() as {items:{id:string;state:string}[]};assert.deepEqual(result.items.map(item=>[item.id,item.state]),[[id,'uncertain']]);
  assert.equal((await fetch(url+'?before='+foreign,{headers:auth})).status,422);
  assert.equal((await fetch(url+'?before=invalid',{headers:auth})).status,422);
  assert.equal((await fetch(url+'?before='+id+'&before='+id,{headers:auth})).status,422);
  assert.equal((await fetch(url,{method:'POST',headers:writes,body:'{}'})).status,405);
  const observationUrl=url+'/'+id+'/observations';
  assert.equal((await fetch(observationUrl)).status,401);
  assert.equal((await fetch(observationUrl,{method:'POST',headers:{...writes,origin:'https://evil.invalid'},body:JSON.stringify({actionRevision:2,revision:0,observation:'checked-uncertain'})})).status,403);
  assert.equal((await fetch(observationUrl,{method:'POST',headers:writes,body:JSON.stringify({actionRevision:2,revision:0,observation:'checked-uncertain',actor:{kind:'agent',identity:'impersonated'}})})).status,422);
  const saved=await fetch(observationUrl,{method:'POST',headers:writes,body:JSON.stringify({actionRevision:2,revision:0,observation:'checked-uncertain'})});assert.equal(saved.status,201);
  const review=await saved.json() as {reviews:{observedBy:string;actionRevision:number}[]};assert.equal(review.reviews[0].observedBy,'local');assert.equal(review.reviews[0].actionRevision,2);
  assert.equal((await fetch(observationUrl,{method:'POST',headers:writes,body:JSON.stringify({actionRevision:2,revision:0,observation:'checked-uncertain'})})).status,409);
  assert.equal(store.getOperation(id,{projectId:project.id,sessionId:'accepted-actions'}).state,'unknown');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});
