import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { DeliveryLedger } from '../../src/server/state/delivery';
import { SessionLifecycleService, SessionLifecycleStore } from '../../src/server/state/session-lifecycle';
import type { AlertPayload } from '../../src/server/alerts';
import { observeStorageSchema } from '../../src/server/release';
import { newTask } from '../../src/shared/model';
import { ACTION_DESCRIPTORS, ACTION_IDS, LIVE_RUN_DETAILS, LIVE_RUN_REASONS, LIVE_TOOL_REASONS } from '../../src/shared/actions';
import { AGENT_SCOPES } from '../../src/shared/agent-registry';
import { FILE_EDIT_MAX_FILE_BYTES } from '../../src/server/state/file-edit-tool';
import { RunnerError, type RunnerContainment } from '../../src/shared/runner';
import type { RunnerExecution, RunnerExecutionRequest, RunnerPort } from '../../src/server/state/runner-broker';

const listen=(app:Awaited<ReturnType<typeof createApp>>,security:ReturnType<typeof localConfig>)=>new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',()=>{security.origin='http://127.0.0.1:'+(app.server.address() as any).port;ok();}));
/**
 * The coding runner is disabled on every instance unless it is enabled explicitly, so its five actions
 * are absent from the offered registry rather than listed and failing. These helpers describe that
 * default without weakening the assertions about everything else the registry offers.
 */
const RUNNER_ACTION_IDS:readonly string[]=ACTION_IDS.filter(id=>id.startsWith('runner.'));
/**
 * The fork capability needs the agent harness, which is off on the instances these registry assertions
 * are made against, so its four actions are absent from the offered registry rather than listed and
 * failing — exactly as the disabled coding runner's are. The fork routes themselves are driven against
 * an instance that really has the harness, in the fork test below.
 */
const FORK_ACTION_IDS:readonly string[]=ACTION_IDS.filter(id=>id.startsWith('fork.'));
/**
 * The bounded file-edit capability is disabled on every instance unless it is enabled explicitly, so
 * its two actions are absent from the offered registry rather than listed and failing — exactly as
 * the disabled coding runner's are. The routes themselves are driven against an instance that really
 * has the capability, in the file-edit test below.
 */
const FILE_EDIT_ACTION_IDS:readonly string[]=ACTION_IDS.filter(id=>id.startsWith('file-edit.'));
const withoutRunner=<T extends {readonly id:string}>(descriptors:readonly T[])=>descriptors.filter(descriptor=>!RUNNER_ACTION_IDS.includes(descriptor.id)&&!FORK_ACTION_IDS.includes(descriptor.id)&&!FILE_EDIT_ACTION_IDS.includes(descriptor.id));
/** The containment every required property is checked against, as an injected port would report it. */
const containment=(overrides:Partial<RunnerContainment>={}):RunnerContainment=>Object.freeze({runtime:'fake-runtime',image:'pilot-runner:test',network:'none',rootFilesystem:'read-only' as const,user:'10001:10001',capabilities:'none',noNewPrivileges:true,dockerSocket:false,mounts:Object.freeze(['workspace']) as readonly string[],maxMemoryBytes:1024*1024*1024,maxCpus:2,maxPids:128,maxWallClockMs:300_000,...overrides});
/** One scripted execution: no container is started and no container runtime is contacted in this suite. */
const execution=(overrides:Partial<RunnerExecution>={}):RunnerExecution=>Object.freeze({exitCode:0,stdout:'probe\n',stderr:'',stdoutBytes:6,stderrBytes:0,stdoutTruncated:false,stderrTruncated:false,timedOut:false,durationMs:3,startedAt:new Date(1700000000000).toISOString(),endedAt:new Date(1700000000003).toISOString(),...overrides});
const hostProbe=(port:string,host:string):Promise<number>=>new Promise((ok,fail)=>{const req=request({host:'127.0.0.1',port,path:'/readyz',headers:{host}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
const execAsync=promisify(execFile);
/** One git command with the environment the fork port uses: no system or global config and no prompt. */
const gitIn=async(cwd:string,args:string[]):Promise<string>=>{
 const {stdout}=await execAsync('git',args,{cwd,timeout:30000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,HOME:'/nonexistent',LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
 return stdout.trim();
};
const exists=async(path:string):Promise<boolean>=>{try{await stat(path);return true;}catch{return false;}};
/** The project's conversation view, once it has settled and the condition holds. No model is called for the polling. */
const agentViewUntil=async(url:string,token:Record<string,string>,projectId:string,ready:(view:any)=>boolean):Promise<any>=>{
 const deadline=Date.now()+15000;
 for(;;){
  const body=await (await fetch(url+'/api/projects/'+projectId+'/agents',{headers:token})).json();
  if(body.view&&!body.view.working&&ready(body.view))return body.view;
  if(Date.now()>deadline)throw new Error('the conversation did not settle in time');
  await new Promise(resolve=>setTimeout(resolve,25));
 }
};
test('API authentication, origin, content type and project isolation',async()=>{
 const security=localConfig('http://127.0.0.1:0'),app=await createApp({dataRoot:await mkdtemp(join(tmpdir(),'dashboard-api-')),browseRoots:[],security});
 await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));security.origin='http://127.0.0.1:'+(app.server.address() as any).port;
 try{
 const url=security.origin,token={'x-dashboard-token':security.token};
 assert.equal((await fetch(url+'/api/projects')).status,401);
 // Stored media is behind the same owner-only session and the same Host check as every other route,
 // and an unknown id is simply unknown rather than a path.
 assert.equal((await fetch(url+'/api/media/'+'a'.repeat(64))).status,401);
 assert.equal((await fetch(url+'/api/media/..%2f..%2fetc%2fpasswd',{headers:token})).status,404);
 assert.equal((await fetch(url+'/api/projects',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403);
 const res=await fetch(url+'/api/projects',{method:'POST',headers:{...token,'content-type':'application/json',origin:url},body:JSON.stringify({name:'Test',managed:true,confirm:true})});assert.equal(res.status,201);
 assert.equal((await fetch(url+'/api/projects/00000000-0000-4000-8000-000000000000/board',{headers:token})).status,404);
 assert.equal((await fetch(url+'/api/browse?path=/etc',{headers:token})).status,400);
 }finally{await app.close();}
});
test('document routes enforce authentication, origin, containment and revisions',async()=>{
 const security=localConfig('http://127.0.0.1:0'),app=await createApp({dataRoot:await mkdtemp(join(tmpdir(),'dashboard-docs-api-')),browseRoots:[],security});
 await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));security.origin='http://127.0.0.1:'+(app.server.address() as any).port;
 try{
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const project=await (await fetch(url+'/api/projects',{method:'POST',headers:writes,body:JSON.stringify({name:'Docs',managed:true,confirm:true})})).json();
 const base=url+'/api/projects/'+project.id+'/docs';
 assert.equal((await fetch(base)).status,401);
 assert.equal((await fetch(base+'/document',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403);
 const saved=await fetch(base+'/document',{method:'POST',headers:writes,body:JSON.stringify({path:'docs/spec/product.md',text:'# Product\\n\\nIntent.\\n'})});
 assert.equal(saved.status,201);const snapshot=await saved.json();assert.equal(snapshot.kind,'spec');
 const listed=await (await fetch(base,{headers:token})).json();assert.deepEqual(listed.documents.map((d:any)=>d.path),['docs/spec/product.md']);
 const read=await (await fetch(base+'/document?path='+encodeURIComponent('docs/spec/product.md'),{headers:token})).json();assert.equal(read.revision,snapshot.revision);
 const conflict=await fetch(base+'/document',{method:'POST',headers:writes,body:JSON.stringify({path:'docs/spec/product.md',text:'# Rewritten\\n',revision:'0'.repeat(64)})});
 assert.equal(conflict.status,409);
 assert.equal((await fetch(base+'/document?path='+encodeURIComponent('../outside.md'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/document?path='+encodeURIComponent('notes.txt'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/document?path='+encodeURIComponent('docs/dashboard/board.md'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/document',{method:'POST',headers:writes,body:JSON.stringify({path:'docs/spec/other.md',text:'x'.repeat(3*1024*1024)})})).status,400);
 assert.equal((await fetch(url+'/api/projects/'+randomUUID()+'/docs',{headers:token})).status,404);
 const search=await (await fetch(base+'/search?q='+encodeURIComponent('Intent'),{headers:token})).json();
 assert.equal(search.matches[0].path,'docs/spec/product.md');
 assert.equal((await fetch(base+'/search?q=x',{headers:token})).status,400);
 const opened=await fetch(base+'/document',{method:'POST',headers:writes,body:JSON.stringify({path:'docs/spec/open.md',text:'# Open\n\n## Open questions\n\n- [ ] Which provider?\n'})});
 assert.equal(opened.status,201);
 const inbox=await (await fetch(base+'/inbox',{headers:token})).json();
 assert.deepEqual(inbox.questions.map((q:any)=>q.text),['Which provider?']);
 assert.equal(inbox.questions[0].path,'docs/spec/open.md');
 assert.equal((await fetch(url+'/api/projects/'+randomUUID()+'/docs/inbox',{headers:token})).status,404);
 const projectPath=(await (await fetch(url+'/api/projects',{headers:token})).json())[0].path as string;
 const png=Buffer.from('89504e470d0a1a0a','hex');
 await writeFile(join(projectPath,'docs','pixel.png'),png);
 const pixel=await fetch(base+'/asset?path='+encodeURIComponent('docs/pixel.png'),{headers:token});
 assert.equal(pixel.status,200);assert.equal(pixel.headers.get('content-type'),'image/png');assert.equal(pixel.headers.get('x-content-type-options'),'nosniff');
 assert.deepEqual(Buffer.from(await pixel.arrayBuffer()),png);
 await writeFile(join(projectPath,'docs','mockup.html'),'<p>Static</p>');
 const mockup=await fetch(base+'/asset?path='+encodeURIComponent('docs/mockup.html'),{headers:token});
 assert.equal(mockup.status,200);assert.match(mockup.headers.get('content-security-policy')??'',/sandbox/);
 assert.equal((await fetch(base+'/asset?path='+encodeURIComponent('docs/spec/product.md'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/asset?path='+encodeURIComponent('../outside.png'),{headers:token})).status,400);
 assert.equal((await fetch(base+'/asset',{headers:token})).status,400);
 }finally{await app.close();}
});
test('readyz reports the schema observed from the live store handle rather than a second connection',async()=>{
 // The observation root is deliberately empty and the handle lives in another root: a second
 // connection would answer storage-schema-absent, so a 200 can only come from the live handle.
 const dataRoot=await mkdtemp(join(tmpdir(),'dashboard-ready-live-data-'));
 const storeRoot=await mkdtemp(join(tmpdir(),'dashboard-ready-live-store-'));
 const store=new ControlStore(storeRoot);
 const observeSchema=()=>{try{return {state:'present' as const,version:store.schemaVersion()};}catch(error){return {state:'malformed' as const,reason:(error as Error).message};}};
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot,browseRoots:[],security,readiness:{releaseId:'v1.2.3',schemaId:'pilot-state-1',manifestValid:true,lockHeld:()=>true,observeSchema}});
 await listen(app,security);
 try{
  assert.deepEqual(observeStorageSchema(dataRoot),{state:'absent'},'a second connection sees no schema there');
  const ready=await fetch(security.origin+'/readyz',{headers:{'x-dashboard-token':security.token}});
  assert.equal(ready.status,200,'the open handle is the authority');
  const body=await ready.json();
  assert.deepEqual(body,{ok:true,releaseId:'v1.2.3',schemaId:'pilot-state-1',lockHeld:true,dataRootWritable:true,reasons:[]});
  assert.ok(!JSON.stringify(body).includes(storeRoot),'readiness must not leak a filesystem path');
  // A closed handle is no longer evidence: readiness degrades instead of claiming the on-disk view.
  store.close();
  const closed=await fetch(security.origin+'/readyz',{headers:{'x-dashboard-token':security.token}});
  assert.equal(closed.status,503);
  assert.ok((await closed.json()).reasons.includes('storage-schema-unreadable'));
 }finally{
  store.close();
  await app.close();
  await rm(dataRoot,{recursive:true,force:true});
  await rm(storeRoot,{recursive:true,force:true});
 }
});
test('readyz is authenticated expected-version readiness, read-only and path-free',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-ready-'));
 const store=new ControlStore(root);store.close();
 const before=await readFile(join(root,'control.sqlite'));
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:root,browseRoots:[],security,readiness:{releaseId:'v1.2.3',schemaId:'pilot-state-1',manifestValid:true,lockHeld:()=>true}});
 await listen(app,security);
 try{
  const url=security.origin,token={'x-dashboard-token':security.token};
  assert.equal((await fetch(url+'/readyz')).status,401,'readiness is behind owner auth, unlike liveness');
  assert.equal(await hostProbe(new URL(url).port,'evil.example'),403,'the wrong-Host 403 still applies');
  const res=await fetch(url+'/readyz',{headers:token});
  assert.equal(res.status,200);
  const ready=await res.json();
  assert.deepEqual(ready,{ok:true,releaseId:'v1.2.3',schemaId:'pilot-state-1',lockHeld:true,dataRootWritable:true,reasons:[]});
  assert.ok(!JSON.stringify(ready).includes(root),'readiness must not leak a filesystem path');
  assert.deepEqual(await readFile(join(root,'control.sqlite')),before,'readiness must not rewrite the storage schema');
  assert.equal((await fetch(url+'/healthz')).status,200,'liveness stays unauthenticated and unchanged');
  assert.equal((await fetch(url+'/readyz',{method:'POST',headers:{...token,'content-type':'application/json',origin:url}})).status,405);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
 // No lock held, and an absent schema: both are machine-readable 503 reasons.
 const root2=await mkdtemp(join(tmpdir(),'dashboard-ready2-'));
 const security2=localConfig('http://127.0.0.1:0');
 const app2=await createApp({dataRoot:root2,browseRoots:[],security:security2,readiness:{releaseId:'unreleased-local',schemaId:'pilot-state-1',lockHeld:()=>false}});
 await listen(app2,security2);
 try{
  const res=await fetch(security2.origin+'/readyz',{headers:{'x-dashboard-token':security2.token}});
  assert.equal(res.status,503);
  const body=await res.json();
  assert.equal(body.ok,false);
  assert.ok(body.reasons.includes('service-lock-not-held'));
  assert.ok(body.reasons.includes('storage-schema-absent'));
 }finally{await app2.close();await rm(root2,{recursive:true,force:true});}
 // An observed schema that does not match the expected schemaId is a mismatch.
 const root3=await mkdtemp(join(tmpdir(),'dashboard-ready3-'));
 const db=new DatabaseSync(join(root3,'control.sqlite'));
 db.exec('CREATE TABLE control_schema(version INTEGER PRIMARY KEY);');db.exec('INSERT INTO control_schema(version) VALUES (2);');db.close();
 const security3=localConfig('http://127.0.0.1:0');
 const app3=await createApp({dataRoot:root3,browseRoots:[],security:security3,readiness:{releaseId:'r',schemaId:'pilot-state-1',lockHeld:()=>true}});
 await listen(app3,security3);
 try{
  const body=await (await fetch(security3.origin+'/readyz',{headers:{'x-dashboard-token':security3.token}})).json();
  assert.equal(body.ok,false);
  assert.ok(body.reasons.includes('storage-schema-mismatch'));
 }finally{await app3.close();await rm(root3,{recursive:true,force:true});}
});

test('the approvals API is owner-only, scope-guarded and single-use, and consuming performs no action',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-approvals-api-'));
 const store=new ControlStore(root);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:root,browseRoots:[],security,control:store});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const target={remote:'git@github.com:owner/repo.git',branch:'main',commitSha:'a'.repeat(40)};
 const approve=(over:Record<string,unknown>={})=>fetch(url+'/api/approvals',{method:'POST',headers:writes,body:JSON.stringify({kind:'push',scope:{projectId:'project-a'},target,expiresAt:new Date(Date.now()+600000).toISOString(),...over})});
 const consume=(id:string,over:Record<string,unknown>={})=>fetch(url+'/api/approvals/'+id+'/consume',{method:'POST',headers:writes,body:JSON.stringify({scope:{projectId:'project-a'},kind:'push',target,consumedBy:'owner',...over})});
 try{
  assert.equal((await fetch(url+'/api/approvals?projectId=project-a')).status,401,'approvals are behind owner auth');
  assert.equal((await fetch(url+'/api/approvals',{method:'POST',headers:{'content-type':'application/json',origin:url},body:'{}'})).status,401,'writing an approval needs the owner token');
  const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:'/api/approvals?projectId=project-a',headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
  assert.equal(wrongHost,403,'the unchanged Host check applies to approvals too');

  const created=await approve();assert.equal(created.status,201);
  const record=(await created.json()).approval;
  assert.equal(record.state,'pending');assert.match(record.nonce,/^[a-f0-9]{64}$/);assert.deepEqual(record.target,target);
  assert.equal((await approve({kind:'transfer'})).status,422,'an unknown kind fails closed');
  assert.equal((await approve({target:{remote:target.remote,branch:'main'}})).status,422,'a missing target field fails closed');
  assert.equal((await approve({target:{...target,force:true}})).status,422,'an unknown target field fails closed');
  assert.equal((await approve({expiresAt:new Date(Date.now()-1000).toISOString()})).status,422,'a non-future expiry fails closed');
  assert.equal((await approve({expiresAt:new Date(Date.now()+3*3600*1000).toISOString()})).status,422,'a lifetime beyond the documented maximum fails closed');
  assert.equal((await approve({confirm:true})).status,400,'an unknown request field fails closed');
  assert.equal((await fetch(url+'/api/approvals',{headers:token})).status,422,'there is no unscoped listing');
  const otherProject=await approve({scope:{projectId:'project-b'}});assert.equal(otherProject.status,201);
  const otherId=(await otherProject.json()).approval.id;
  // A listing is scoped exactly: it returns that scope's approvals and nothing from another one.
  const listed=await (await fetch(url+'/api/approvals?projectId=project-a',{headers:token})).json();
  assert.deepEqual(listed.approvals.map((entry:any)=>entry.id),[record.id]);
  const listedOther=await (await fetch(url+'/api/approvals?projectId=project-b',{headers:token})).json();
  assert.deepEqual(listedOther.approvals.map((entry:any)=>entry.id),[otherId]);
  // A listing is a discovery aid, not a credential store: the single-use nonce stays in the create
  // response, which is the only response that hands it out. The listing returns the same record
  // otherwise, so nothing else about it changed.
  assert.equal('nonce' in listed.approvals[0],false,'the listing does not return the approval nonce');
  assert.equal('nonce' in listedOther.approvals[0],false);
  assert.equal(listed.approvals[0].state,'pending');
  assert.equal(listed.approvals[0].kind,'push');
  assert.deepEqual(listed.approvals[0].target,target);
  assert.equal((await fetch(url+'/api/approvals/'+otherId+'?projectId=project-a',{headers:token})).status,403,'another project\'s approval is not readable here');
  const read=await fetch(url+'/api/approvals/'+record.id+'?projectId=project-a',{headers:token});
  assert.equal(read.status,200);assert.equal((await read.json()).approval.state,'pending');
  assert.equal((await fetch(url+'/api/approvals/'+record.id,{headers:token})).status,422,'a read still has to name a scope');
  assert.equal((await fetch(url+'/api/approvals/'+record.id+'?sessionId=session-a',{headers:token})).status,403,'the exact scope is required');
  assert.equal((await fetch(url+'/api/approvals/'+randomUUID()+'?projectId=project-a',{headers:token})).status,404);
  assert.equal((await fetch(url+'/api/approvals/'+record.id,{method:'POST',headers:writes,body:'{}'})).status,405);

  const mismatch=await consume(record.id,{target:{...target,commitSha:'b'.repeat(40)}});assert.equal(mismatch.status,409);
  assert.match((await mismatch.json()).error,/different push target/);
  assert.equal((await consume(record.id,{kind:'publish',target:{channel:'stable',artifact:'pilot-0.1.0'}})).status,409,'a valid target for the wrong kind is still refused');
  assert.equal((await consume(record.id,{kind:'publish'})).status,422,'a target that does not belong to the requested kind fails closed');
  const consumed=await consume(record.id);assert.equal(consumed.status,200);
  const result=await consumed.json();
  // Consuming records the authorisation and returns the exact target. It performs nothing.
  assert.deepEqual(Object.keys(result).sort(),['approval','target']);
  assert.deepEqual(result.target,target);
  assert.equal(result.approval.state,'consumed');assert.equal(result.approval.consumedBy,'owner');
  const replay=await consume(record.id);assert.equal(replay.status,409);
  assert.match((await replay.json()).error,/already consumed/);
  assert.equal((await (await fetch(url+'/api/approvals/'+record.id+'?projectId=project-a',{headers:token})).json()).approval.state,'consumed');

  const second=await approve();assert.equal(second.status,201);
  const secondId=(await second.json()).approval.id;
  const revoked=await fetch(url+'/api/approvals/'+secondId+'/revoke',{method:'POST',headers:writes,body:JSON.stringify({scope:{projectId:'project-a'},revokedBy:'owner',reason:'superseded'})});
  assert.equal(revoked.status,200);assert.equal((await revoked.json()).approval.state,'revoked');
  const afterRevoke=await consume(secondId);assert.equal(afterRevoke.status,409);assert.match((await afterRevoke.json()).error,/was revoked at/);
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
 // Without a live control store the routes refuse rather than guessing at a scope.
 const bare=await mkdtemp(join(tmpdir(),'dashboard-approvals-bare-'));
 const bareSecurity=localConfig('http://127.0.0.1:0');
 const bareApp=await createApp({dataRoot:bare,browseRoots:[],security:bareSecurity});
 await listen(bareApp,bareSecurity);
 try{
  assert.equal((await fetch(bareSecurity.origin+'/api/approvals?projectId=project-a',{headers:{'x-dashboard-token':bareSecurity.token}})).status,503);
 }finally{await bareApp.close();await rm(bare,{recursive:true,force:true});}
});

test('a start reconciles the delivery ledger: it re-sends only what the tag makes idempotent and acknowledges the real receipt',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-delivery-reconcile-'));
  const store=new ControlStore(root);
  const ledger=new DeliveryLedger(store);
  const questionId='11111111-1111-4111-8111-111111111111';
  const scope={projectId:'project-a',sessionId:'session-1'};
  const admitted=ledger.admitQuestion({...scope,questionId,text:'Should I proceed?',askedAt:1700000000000});
  const outboxRow=(store.db.prepare('SELECT revision FROM outboxes WHERE id=?').get(admitted.outbox.id) as {revision:number});
  const sent:AlertPayload[]=[];
  const transport=async(_subscription:unknown,payload:AlertPayload)=>{sent.push(payload);};
  const first=localConfig('http://127.0.0.1:0');
  const app=await createApp({dataRoot:root,browseRoots:[],security:first,control:store,alertTransport:transport});
  await listen(app,first);
  try{
    const token={'x-dashboard-token':first.token};
    const writes={...token,'content-type':'application/json',origin:first.origin};
    // No device is subscribed, so the channel sent nothing: the row is not claimed as delivered.
    assert.equal(sent.length,0,'a start with no subscribed device sends nothing');
    assert.deepEqual(ledger.deliveries(scope).questions.map((entry)=>[entry.delivered,entry.receipt]),[[false,null]],'an undelivered notification is not acknowledged');
    assert.equal((await fetch(first.origin+'/api/alerts/subscribe',{method:'POST',headers:writes,body:JSON.stringify({endpoint:'https://push.example.test/one',keys:{p256dh:'B'.repeat(80),auth:'C'.repeat(20)}})})).status,200);
  }finally{await app.close();}

  // A restart with a subscribed device: the same pending row is re-sent, and this time the channel
  // reports a real receipt, which is exactly what the ledger acknowledges.
  const second=localConfig('http://127.0.0.1:0');
  const restarted=await createApp({dataRoot:root,browseRoots:[],security:second,control:store,alertTransport:transport});
  await listen(restarted,second);
  let deliveredRevision=1;
  try{
    assert.deepEqual(sent.map((payload)=>[payload.tag,payload.title,payload.body.includes('Should I proceed?')]),[['pilot-question-'+questionId,'An agent needs an answer',false]],'the re-send is tagged by the question id and carries no question text');
    const row=ledger.deliveries(scope).questions[0];
    assert.equal(row.delivered,true);
    assert.deepEqual(row.receipt,{sent:1,failed:0,skipped:false});
    assert.equal(typeof row.acknowledgedAt,'string');
    deliveredRevision=(store.db.prepare('SELECT revision FROM outboxes WHERE id=?').get(admitted.outbox.id) as {revision:number}).revision;
    assert.equal(outboxRow.revision,deliveredRevision-1,'the re-send wrote exactly one acknowledgement');
  }finally{await restarted.close();}

  // A further start has nothing outstanding: a settled delivery is not re-sent, and its row is not
  // rewritten, so a restart can never duplicate an effect.
  const third=localConfig('http://127.0.0.1:0');
  const again=await createApp({dataRoot:root,browseRoots:[],security:third,control:store,alertTransport:transport});
  await listen(again,third);
  try{
    assert.equal(sent.length,1,'a settled notification is never re-sent');
    assert.equal((store.db.prepare('SELECT revision FROM outboxes WHERE id=?').get(admitted.outbox.id) as {revision:number}).revision,deliveredRevision,'the acknowledgement is written once');
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM operations WHERE kind=?').get('question.delivery') as {n:number}).n,1,'a restart duplicates no row');
    assert.equal(ledger.reconcileOnStartup().entries.length,0);
  }finally{await again.close();store.close();await rm(root,{recursive:true,force:true});}
});
test('the sessions API is owner-only, resolves every link kind and is revision-checked',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-sessions-api-'));
 const workspaces=join(root,'projects'),projectPath=join(workspaces,'workspace'),data=join(root,'data');
 await mkdir(join(projectPath,'docs','spec'),{recursive:true,mode:0o755});
 await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:data,browseRoots:[workspaces],security,control:store});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const read=(path:string)=>fetch(url+path,{headers:token});
 try{
  // Behind owner authentication and the unchanged Host check, like every other route.
  assert.equal((await fetch(url+'/api/sessions?projectId='+randomUUID())).status,401,'sessions are behind owner auth');
  assert.equal((await fetch(url+'/api/sessions',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({projectId:randomUUID(),name:'Nope'})})).status,401,'creating a session needs the owner token');
  const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:'/api/sessions?projectId='+randomUUID(),headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
  assert.equal(wrongHost,403,'the unchanged Host check applies to sessions too');
  assert.equal((await fetch(url+'/api/sessions',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403,'a write still needs the canonical origin');
  // A session is created for a registered project, and there is no unscoped listing.
  const project=await (await post('/api/projects',{name:'Sessions',path:projectPath,managed:false,confirm:true})).json();
  assert.equal((await read('/api/sessions')).status,422,'there is no unscoped listing');
  const taskId=randomUUID();
  const created=await post('/api/sessions',{projectId:project.id,name:'Release train'});
  assert.equal(created.status,201);
  const session=(await created.json()).session;
  assert.equal(session.revision,1);
  assert.equal(session.model,null);
  assert.deepEqual(session.links,[]);
  assert.equal((await post('/api/sessions',{projectId:project.id,name:'Release train'})).status,409,'a duplicate live name is refused');
  const unknownField=await post('/api/sessions',{projectId:project.id,name:'Other',colour:'red'});
  assert.equal(unknownField.status,422);
  assert.match((await unknownField.json()).error,/colour/);
  assert.equal((await post('/api/sessions',{projectId:randomUUID(),name:'Other'})).status,404,'an unregistered project is not a session scope');
  assert.deepEqual((await (await read('/api/sessions?projectId='+project.id)).json()).sessions.map((entry:any)=>entry.id),[session.id]);
  assert.equal((await read('/api/sessions/'+randomUUID()+'?projectId='+project.id)).status,404);
  // Links are validated against the board, the documentation store and the approved roots, and no
  // refusal carries a path.
  const link=(body:unknown)=>post('/api/sessions/'+session.id+'/link',body);
  const missingTask=await link({projectId:project.id,link:{kind:'task',taskId:randomUUID()},revision:1});
  assert.equal(missingTask.status,404);
  const missingTaskText=await missingTask.text();
  assert.match(missingTaskText,/contains no task/);
  assert.ok(!missingTaskText.includes(project.path)&&!missingTaskText.includes(data),'a refusal leaks no filesystem path');
  assert.equal((await link({projectId:project.id,link:{kind:'document',path:'docs/spec/missing.md',anchor:null},revision:1})).status,404,'a document the store does not serve is not found');
  assert.equal((await link({projectId:project.id,link:{kind:'document',path:'../outside.md',anchor:null},revision:1})).status,403,'a document path outside the roots is refused');
  assert.equal((await link({projectId:project.id,link:{kind:'document',path:'notes.txt',anchor:null},revision:1})).status,403);
  assert.equal((await link({projectId:project.id,link:{kind:'workspace',path:root},revision:1})).status,403,'a workspace outside the approved roots is refused');
  assert.equal((await link({projectId:project.id,link:{kind:'task',taskId:'not-a-uuid'},revision:1})).status,422);
  assert.equal((await link({projectId:project.id,link:{kind:'board',taskId},revision:1})).status,422,'an unknown link kind fails closed');
  // The board and the documentation store of the registered project supply the link targets.
  assert.equal((await post('/api/projects/'+project.id+'/initialize',{confirm:true})).status,200);
  const board=await (await read('/api/projects/'+project.id+'/board')).json();
  const put=await post('/api/projects/'+project.id+'/board',{revision:board.revision,operation:{op:'putTask',task:newTask(taskId,'Ship the release')}});
  assert.equal(put.status,200);
  assert.equal((await post('/api/projects/'+project.id+'/docs/document',{path:'docs/spec/product.md',text:'# Product\n'})).status,201);
  const task=await link({projectId:project.id,link:{kind:'task',taskId},revision:1});
  assert.equal(task.status,200);
  const taskRecord=(await task.json()).session;
  assert.equal(taskRecord.revision,2);
  assert.equal((await link({projectId:project.id,link:{kind:'document',path:'./docs/spec/product.md',anchor:'intent'},revision:2})).status,200);
  const workspace=await link({projectId:project.id,link:{kind:'workspace',path:projectPath},revision:3});
  assert.equal(workspace.status,200);
  const roundTrip=(await workspace.json()).session;
  assert.equal(roundTrip.revision,4);
  assert.deepEqual(roundTrip.links,[
   {kind:'document',path:'docs/spec/product.md',anchor:'intent'},
   {kind:'task',taskId},
   {kind:'workspace',path:project.path}
  ],'a task, a document and a workspace link round-trip, and the workspace is stored canonically');
  const reread=(await (await read('/api/sessions/'+session.id+'?projectId='+project.id)).json()).session;
  assert.deepEqual(reread,roundTrip);
  // Renaming is revision-checked, and a repeat of the same name is idempotent.
  const rename=(body:unknown)=>post('/api/sessions/'+session.id+'/rename',body);
  const stale=await rename({projectId:project.id,name:'Renamed',revision:1});
  assert.equal(stale.status,409);
  assert.match((await stale.json()).error,/unchanged/);
  assert.deepEqual((await (await read('/api/sessions/'+session.id+'?projectId='+project.id)).json()).session,roundTrip,'a stale rename changes nothing');
  const renamed=await rename({projectId:project.id,name:'Renamed',revision:4});
  assert.equal(renamed.status,200);
  assert.equal((await renamed.json()).session.revision,5);
  assert.equal((await rename({projectId:project.id,name:'Renamed',revision:5})).status,200,'renaming to the same name is idempotent');
  // Unlinking is idempotent, and a stale unlink can never remove a link.
  const unlink=(body:unknown)=>post('/api/sessions/'+session.id+'/unlink',body);
  const removed=await unlink({projectId:project.id,link:{kind:'task',taskId},revision:5});
  assert.equal(removed.status,200);
  const afterUnlink=(await removed.json()).session;
  assert.equal(afterUnlink.links.length,2);
  assert.equal(afterUnlink.revision,6);
  assert.deepEqual((await (await unlink({projectId:project.id,link:{kind:'task',taskId},revision:6})).json()).session,afterUnlink,'unlinking twice changes nothing');
  assert.deepEqual((await (await unlink({projectId:project.id,link:{kind:'task',taskId:randomUUID()},revision:1})).json()).session,afterUnlink,'unlinking an absent link changes nothing');
  assert.equal((await unlink({projectId:project.id,link:{kind:'document',path:'docs/spec/product.md',anchor:'intent'},revision:1})).status,409,'removing a present link with a stale revision is refused');
  // Methods and unknown routes.
  assert.equal((await fetch(url+'/api/sessions/'+session.id+'?projectId='+project.id,{method:'POST',headers:writes,body:'{}'})).status,405);
  assert.equal((await read('/api/sessions/'+session.id+'/rename')).status,405);
  assert.equal((await post('/api/sessions/'+session.id+'/archive',{})).status,404);
  assert.equal((await read('/api/sessions/migrate')).status,405);
  // The migration route: no conversation exists for this project, so it plans and writes nothing.
  const listed=await (await read('/api/sessions?projectId='+project.id)).json();
  const dry=await post('/api/sessions/migrate',{dryRun:true});
  assert.equal(dry.status,200);
  const report=await dry.json();
  assert.equal(report.dryRun,true);
  assert.deepEqual(report.counts,{projects:1,conversations:0,adopted:0,alreadyAdopted:0,withoutConversation:1,refused:0});
  assert.deepEqual(await (await read('/api/sessions?projectId='+project.id)).json(),listed,'a dry run changes nothing');
  const applied=await (await post('/api/sessions/migrate',{})).json();
  assert.equal(applied.dryRun,false);
  assert.deepEqual(applied.counts,report.counts);
  assert.deepEqual(await (await read('/api/sessions?projectId='+project.id)).json(),listed,'a migration with nothing to adopt changes nothing');
  assert.equal((await post('/api/sessions/migrate',{dryRun:'yes'})).status,400,'a dry-run flag that is not a boolean fails closed');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
 // Without a live control store the routes refuse rather than guessing at a registry.
 const bare=await mkdtemp(join(tmpdir(),'dashboard-sessions-bare-'));
 const bareSecurity=localConfig('http://127.0.0.1:0');
 const bareApp=await createApp({dataRoot:bare,browseRoots:[],security:bareSecurity});
 await listen(bareApp,bareSecurity);
 try{
  const bareToken={'x-dashboard-token':bareSecurity.token};
  assert.equal((await fetch(bareSecurity.origin+'/api/sessions?projectId='+randomUUID(),{headers:bareToken})).status,503);
  assert.equal((await fetch(bareSecurity.origin+'/api/sessions/migrate',{method:'POST',headers:{...bareToken,'content-type':'application/json',origin:bareSecurity.origin},body:'{}'})).status,503);
  assert.equal((await fetch(bareSecurity.origin+'/api/sessions/'+randomUUID()+'/lifecycle?projectId='+randomUUID(),{headers:bareToken})).status,503,'the lifecycle routes refuse without a durable store');
 }finally{await bareApp.close();await rm(bare,{recursive:true,force:true});}
});
test('the session lifecycle routes are owner-only, revision-checked and honest about which actions dispatch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-lifecycle-api-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store,agents:'on',agentPauseMs:100});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const read=(p:string)=>fetch(url+p,{headers:token});
 const waitFor=async<T>(check:()=>Promise<T|undefined>,timeoutMs=10000):Promise<T>=>{const until=Date.now()+timeoutMs;for(;;){const value=await check();if(value!==undefined)return value;if(Date.now()>until)throw Error('condition was not met in time');await new Promise(res=>setTimeout(res,50));}};
 try{
  const project=await (await post('/api/projects',{name:'Lifecycle',managed:true,confirm:true})).json();
  const session=(await (await post('/api/sessions',{projectId:project.id,name:'Lifecycle session'})).json()).session;
  const basePath='/api/sessions/'+session.id+'/lifecycle',base=url+basePath;
  // Behind owner auth and the unchanged Host check, exactly like every other route.
  assert.equal((await fetch(base+'?projectId='+project.id)).status,401,'the lifecycle read is behind owner auth');
  const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:'/api/sessions/'+session.id+'/lifecycle?projectId='+project.id,headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
  assert.equal(wrongHost,403,'the unchanged Host check applies to the lifecycle too');
  assert.equal((await fetch(base+'/stop',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403,'a lifecycle write still needs the canonical origin');
  // A session with no durable lifecycle row reads at the deterministic idle record.
  const initial=(await (await read(basePath+'?projectId='+project.id)).json()).lifecycle;
  assert.equal(initial.state,'idle');assert.equal(initial.revision,0);assert.equal(initial.attempt,0);
  // An illegal jump is refused with a reason and changes nothing.
  const illegal=await post(basePath+'/resume',{projectId:project.id,revision:0});
  assert.equal(illegal.status,409);
  assert.match((await illegal.json()).error,/Only a paused or interrupted/);
  // A generation really runs in this process: run the agent once so the transcript has an input to continue.
  assert.equal((await post('/api/projects/'+project.id+'/agents/input',{text:'seed the lifecycle',mode:'followUp'})).status,200);
  const agentsBase=url+'/api/projects/'+project.id+'/agents';
  await waitFor(async()=>{const view=await (await fetch(agentsBase,{headers:token})).json() as {view:{entries:{kind:string}[]}};return view.view.entries.some(entry=>entry.kind==='user')?true:undefined;});
  // The durable state a live generation leaves: running, with the request identity it was submitted under.
  const lifecycle=new SessionLifecycleStore(store);
  lifecycle.markRunning({projectId:project.id,sessionId:session.id,requestId:'seed-request'});
  const running=(await (await read(basePath+'?projectId='+project.id)).json()).lifecycle;
  assert.equal(running.state,'running');assert.equal(running.revision,1);assert.equal(running.requestId,'seed-request');
  // reconnect attaches and dispatches nothing: the record is unchanged and no effect flag is set.
  const reconnected=await post(basePath+'/reconnect',{projectId:project.id,revision:1});
  assert.equal(reconnected.status,200);
  const reconnectedBody=await reconnected.json();
  assert.deepEqual([reconnectedBody.dispatched,reconnectedBody.cancelled,reconnectedBody.unchanged],[false,false,true]);
  assert.equal(reconnectedBody.lifecycle.revision,1,'reconnect wrote no revision');
  // A stale revision is a conflict, not a silent overwrite.
  const stale=await post(basePath+'/stop',{projectId:project.id,revision:0});
  assert.equal(stale.status,409);
  assert.match((await stale.json()).error,/is at lifecycle revision 1, not 0/);
  // stop cancels and dispatches nothing.
  const stopped=await post(basePath+'/stop',{projectId:project.id,revision:1});
  assert.equal(stopped.status,200);
  const stoppedBody=await stopped.json();
  assert.equal(stoppedBody.lifecycle.state,'idle');assert.equal(stoppedBody.cancelled,true);assert.equal(stoppedBody.dispatched,false);
  assert.deepEqual(await (await post(basePath+'/stop',{projectId:project.id,revision:stoppedBody.lifecycle.revision})).json().then((b:any)=>[b.unchanged,b.dispatched,b.cancelled]),[true,false,false],'stopping an already-stopped session is idempotent');
  // A fresh generation, paused by the owner, then resumed and retried: the two dispatching actions.
  lifecycle.markRunning({projectId:project.id,sessionId:session.id,requestId:'seed-request-2'});
  const running2=(await (await read(basePath+'?projectId='+project.id)).json()).lifecycle;
  assert.equal(running2.state,'running');
  const paused=await post(basePath+'/pause',{projectId:project.id,revision:running2.revision,reason:'paused for review'});
  assert.equal(paused.status,200);
  const pausedBody=await paused.json();
  assert.equal(pausedBody.lifecycle.state,'paused');assert.equal(pausedBody.lifecycle.reason,'paused for review');
  assert.deepEqual([pausedBody.dispatched,pausedBody.cancelled],[false,true]);
  const resumed=await post(basePath+'/resume',{projectId:project.id,revision:pausedBody.lifecycle.revision});
  assert.equal(resumed.status,200);
  const resumedBody=await resumed.json();
  assert.equal(resumedBody.lifecycle.state,'running');assert.equal(resumedBody.dispatched,true);assert.equal(resumedBody.lifecycle.requestId,'seed-request-2','resume reused the original request identity');
  lifecycle.markSettled({projectId:project.id,sessionId:session.id,outcome:'failed'});
  const failed=await (await read(basePath+'?projectId='+project.id)).json();
  assert.equal(failed.lifecycle.state,'failed');
  const retried=await post(basePath+'/retry',{projectId:project.id,revision:failed.lifecycle.revision});
  assert.equal(retried.status,200);
  const retriedBody=await retried.json();
  assert.equal(retriedBody.lifecycle.state,'running');assert.equal(retriedBody.dispatched,true);assert.equal(retriedBody.lifecycle.attempt,failed.lifecycle.attempt+1);
  assert.notEqual(retriedBody.lifecycle.requestId,'seed-request-2','retry named a new request identity');
  // Methods, unknown sessions and malformed bodies.
  assert.equal((await fetch(base+'?projectId='+project.id,{method:'POST',headers:writes,body:'{}'})).status,405);
  assert.equal((await read(basePath+'/stop?projectId='+project.id)).status,405);
  assert.equal((await fetch(url+'/api/sessions/'+randomUUID()+'/lifecycle?projectId='+project.id,{headers:token})).status,404);
  assert.equal((await read(basePath)).status,422,'a lifecycle read requires a projectId');
  assert.equal((await post(basePath+'/resume',{projectId:project.id})).status,422,'a whole-number revision is required');
  // A body the route does not recognise is an invalid request (422) in this application's own words,
  // never a generic 400 echoing the schema library's raw message.
  const unknownField=await post(basePath+'/resume',{projectId:project.id,revision:0,surprise:true});
  assert.equal(unknownField.status,422,'an unknown lifecycle body field is an invalid request');
  const unknownError=(await unknownField.json() as {error:string}).error;
  assert.match(unknownError,/does not accept/,'the reason names the refusal: '+unknownError);
  assert.ok(!/Unrecognized key|zod|Invalid input/i.test(unknownError),'the raw schema message is not echoed: '+unknownError);
  const missingProjectId=await post(basePath+'/resume',{revision:0});
  assert.equal(missingProjectId.status,422,'a missing projectId is an invalid request');
  assert.match((await missingProjectId.json() as {error:string}).error,/projectId/,'the reason names the missing field');
  assert.equal((await post(basePath+'/pause',{projectId:project.id,revision:retriedBody.lifecycle.revision,reason:'x'.repeat(400)})).status,422,'a reason beyond the bound fails closed');
  assert.equal((await post(basePath+'/freeze',{projectId:project.id,revision:9})).status,404,'an unknown lifecycle action is not a route');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('two concurrent retries at one lifecycle revision dispatch one generation, and the loser is refused',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-lifecycle-retry-race-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store,agents:'on',agentPauseMs:100});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const waitFor=async<T>(check:()=>Promise<T|undefined>,timeoutMs=10000):Promise<T>=>{const until=Date.now()+timeoutMs;for(;;){const value=await check();if(value!==undefined)return value;if(Date.now()>until)throw Error('condition was not met in time');await new Promise(res=>setTimeout(res,25));}};
 try{
  const project=await (await post('/api/projects',{name:'Retry race',managed:true,confirm:true})).json();
  const session=(await (await post('/api/sessions',{projectId:project.id,name:'Retry race session'})).json()).session;
  const agents=url+'/api/projects/'+project.id+'/agents';
  const view=async()=>await (await fetch(agents,{headers:token})).json() as {view:{working:boolean;entries:{kind:string}[]}};
  // One generation really runs, so the retry has an input to re-submit and a transcript to grow.
  assert.equal((await post('/api/projects/'+project.id+'/agents/input',{text:'retry me',mode:'followUp'})).status,200);
  await waitFor(async()=>{const v=await view();return v.view.entries.some(entry=>entry.kind==='user')&&!v.view.working?true:undefined;});
  const lifecycle=new SessionLifecycleStore(store);
  lifecycle.markRunning({projectId:project.id,sessionId:session.id,requestId:'failed-attempt'});
  lifecycle.markSettled({projectId:project.id,sessionId:session.id,outcome:'failed',reason:'the generation failed'});
  const basePath='/api/sessions/'+session.id+'/lifecycle';
  const failedBody=await (await fetch(url+basePath+'?projectId='+project.id,{headers:token})).json() as {lifecycle:{state:string;revision:number;attempt:number;requestId:string}};
  assert.equal(failedBody.lifecycle.state,'failed');
  const repliesBefore=(await view()).view.entries.filter(entry=>entry.kind==='assistant').length;
  // Two owners tap retry at the same revision: the durable write picks one winner, and only that
  // winner may dispatch, so the loser can never spend a second model run.
  const [first,second]=await Promise.all([
   post(basePath+'/retry',{projectId:project.id,revision:failedBody.lifecycle.revision}),
   post(basePath+'/retry',{projectId:project.id,revision:failedBody.lifecycle.revision})
  ]);
  assert.deepEqual([first.status,second.status].sort(),[200,409],'exactly one retry wins and the loser is refused');
  const winner=first.status===200?first:second,loser=first.status===200?second:first;
  const winnerBody=await winner.json();
  assert.equal(winnerBody.dispatched,true);
  assert.equal(winnerBody.lifecycle.state,'running');
  assert.equal(winnerBody.lifecycle.revision,failedBody.lifecycle.revision+1,'exactly one revision was written');
  assert.equal(winnerBody.lifecycle.attempt,failedBody.lifecycle.attempt+1,'exactly one attempt was recorded');
  assert.equal(winnerBody.lifecycle.requestId,'retry:'+session.id+':r'+(failedBody.lifecycle.revision+1),'the retry identity is derived from the revision it writes, never minted at random');
  const loserBody=await loser.json() as {error:string};
  assert.ok(!/zod|Unrecognized key/i.test(loserBody.error),'the refusal is an application reason, not a library message: '+loserBody.error);
  // Exactly one generation was dispatched: the transcript grew by one reply, not two.
  await waitFor(async()=>{const v=await view();return !v.view.working?true:undefined;});
  assert.equal((await view()).view.entries.filter(entry=>entry.kind==='assistant').length,repliesBefore+1,'exactly one model run started for the two retries');
  const settled=await (await fetch(url+basePath+'?projectId='+project.id,{headers:token})).json() as {lifecycle:{state:string;revision:number;attempt:number;requestId:string}};
  assert.equal(settled.lifecycle.revision,winnerBody.lifecycle.revision,'the loser wrote no second revision');
  assert.equal(settled.lifecycle.attempt,winnerBody.lifecycle.attempt,'the loser recorded no second attempt');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('an owner pause of a genuinely running generation is the only writer at its revision, and the session resumes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-lifecycle-pause-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 // The scripted provider holds the generation open for seconds, so the pause really cancels a live run
 // and the harness's own watcher really observes it leave the working state.
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store,agents:'on',agentPauseMs:5000});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const waitFor=async<T>(check:()=>Promise<T|undefined>,timeoutMs=10000):Promise<T>=>{const until=Date.now()+timeoutMs;for(;;){const value=await check();if(value!==undefined)return value;if(Date.now()>until)throw Error('condition was not met in time');await new Promise(res=>setTimeout(res,25));}};
 try{
  const project=await (await post('/api/projects',{name:'Pause race',managed:true,confirm:true})).json();
  // The named session the harness's own lifecycle hooks record against: Pi's reserved root
  // conversation, adopted under its own id exactly as the start-time legacy migration adopts it.
  const sessionId='1';
  const sessions=app.sessions;
  if(!sessions)throw Error('the application under test has no session registry');
  await sessions.adopt({projectId:project.id,sessionId,name:'The project conversation'});
  const agents=url+'/api/projects/'+project.id+'/agents';
  const view=async()=>await (await fetch(agents,{headers:token})).json() as {view:{working:boolean}};
  assert.equal((await post('/api/projects/'+project.id+'/agents/input',{text:'[pause] hold this generation open',mode:'followUp'})).status,200);
  await waitFor(async()=>{const v=await view();return v.view.working?true:undefined;});
  // The durable record of that genuinely running generation is written by the application's own began
  // hook, under the identity a resume reuses: nothing here writes it by hand.
  const lifecycle=new SessionLifecycleStore(store);
  await waitFor(async()=>lifecycle.read(project.id,sessionId).state==='running'?true:undefined);
  const live=lifecycle.read(project.id,sessionId);
  assert.equal(live.attempt,1,'the live generation is durably running under its own attempt');
  // The owner's pause of that genuinely running generation. Its port is assembled here exactly as the
  // application assembles it, so the harness watcher's own settled branch can be given the opportunity
  // to write *before* the owner's write is attempted: the cancel waits until the conversation has really
  // left the working state and the following event-loop turns have drained. That is the race, made
  // deterministic - the owner's write must still win, and it must be the only one at that revision.
  const registered=app.catalog.get(project.id);
  const bounded=async<T>(work:Promise<T>,ms:number):Promise<T>=>await Promise.race([work,new Promise<never>((_,fail)=>setTimeout(()=>fail(Error('the conversation did not leave the working state in time')),ms))]);
  let revisionWhileCancelling:number|null=null;
  const service=new SessionLifecycleService(lifecycle,{
    authoriseDispatch:()=>{},
    resume:async({requestId})=>{await app.agents.dispatchLifecycle(registered,requestId);},
    retry:async({requestId})=>{await app.agents.dispatchLifecycle(registered,requestId);},
    cancel:async()=>{
      let ended:()=>void=()=>{};const stopped=new Promise<void>(resolve=>{ended=resolve;});
      const unsubscribe=await app.agents.subscribe(registered,value=>{if(!value.working)ended();});
      try {
        await app.agents.cancelLifecycle(registered);
        await bounded(stopped,5000);
        await new Promise(resolve=>setImmediate(resolve));
        await new Promise(resolve=>setImmediate(resolve));
        revisionWhileCancelling=lifecycle.read(project.id,sessionId).revision;
      } finally { await unsubscribe(); }
    }
  },{clock:()=>new Date()});
  const paused=await service.run(project.id,sessionId,'pause',{revision:live.revision,reason:'the owner paused the live generation'});
  assert.equal(revisionWhileCancelling,live.revision,'the settled hook wrote no competing revision while the cancel was in flight');
  assert.equal(paused.record.state,'paused','the owner\'s cancel owns the durable state');
  assert.equal(paused.record.revision,live.revision+1,'exactly one writer at that revision');
  assert.deepEqual([paused.dispatched,paused.cancelled],[false,true]);
  assert.equal(paused.record.requestId,live.requestId,'the paused session keeps the identity it resumes under');
  // The watcher's own settle has had its chance; the record must still be the owner's pause.
  await waitFor(async()=>{const v=await view();return !v.view.working?true:undefined;});
  await new Promise(res=>setTimeout(res,300));
  const after=lifecycle.read(project.id,sessionId);
  assert.equal(after.state,'paused','the settled hook did not overwrite the pause with idle');
  assert.equal(after.revision,live.revision+1,'the settled hook wrote no competing revision');
  assert.equal(after.attempt,live.attempt,'a pause starts no new attempt');
  // A paused session is resumable through the application's own route, under its original identity.
  const basePath='/api/sessions/'+sessionId+'/lifecycle';
  const resumed=await post(basePath+'/resume',{projectId:project.id,revision:after.revision});
  assert.equal(resumed.status,200,'a paused session resumes');
  const resumedBody=await resumed.json();
  assert.equal(resumedBody.lifecycle.state,'running');
  assert.equal(resumedBody.dispatched,true);
  assert.equal(resumedBody.lifecycle.requestId,live.requestId,'resume continued under the original request identity');
  assert.equal(resumedBody.lifecycle.attempt,after.attempt,'resume continues the same attempt, it does not start a new one');
  // Stop the resumed run before closing, so the test holds no live generation at teardown.
  await post('/api/projects/'+project.id+'/agents/abort',{});
  await waitFor(async()=>{const v=await view();return !v.view.working?true:undefined;});
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('the command registry is owner-only, lists only what this instance implements, and executes a real action',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-actions-api-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const read=(p:string)=>fetch(url+p,{headers:token});
 const execute=(body:unknown)=>post('/api/actions/execute',body);
 try{
  // Owner-only, behind the unchanged Host check, with the same origin enforcement for the write.
  assert.equal((await fetch(url+'/api/actions')).status,401,'the registry is behind owner auth');
  assert.equal((await fetch(url+'/api/actions/activity?projectId='+randomUUID())).status,401,'the projection is behind owner auth');
  const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:'/api/actions',headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
  assert.equal(wrongHost,403,'the unchanged Host check applies to the registry');
  assert.equal((await fetch(url+'/api/actions/execute',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify({id:'doctor.report'})})).status,403,'executing an action is a write and needs the canonical origin');
  assert.equal((await read('/api/actions/execute')).status,405,'executing is a POST only');
  assert.equal((await post('/api/actions/activity',{})).status,405);

  // Only implemented actions, and only ones this scope can use: the ids are exactly the registry's,
  // minus the coding runner's, which this instance has disabled.
  const globalIds=withoutRunner(ACTION_DESCRIPTORS.filter(descriptor=>descriptor.requires.length===0)).map(descriptor=>descriptor.id);
  const scopedIds=withoutRunner(ACTION_DESCRIPTORS).map(descriptor=>descriptor.id);
  assert.deepEqual(scopedIds.filter(id=>RUNNER_ACTION_IDS.includes(id)),[],'a disabled coding runner is absent from the registry');
  assert.deepEqual(scopedIds.filter(id=>FORK_ACTION_IDS.includes(id)),[],'a fork capability this instance lacks (the agent harness is off) is absent from the registry, not listed and failing');
  const unscoped=await (await read('/api/actions')).json();
  assert.equal(unscoped.readOnly,true);
  assert.deepEqual(unscoped.scope,{projectId:null,sessionId:null});
  assert.deepEqual(unscoped.actions.map((action:any)=>action.id),globalIds,'with no scope, only actions that need none are offered');
  for(const action of unscoped.actions){assert.ok(ACTION_IDS.includes(action.id));assert.ok(action.label&&action.description);assert.deepEqual(action.surfaces,['palette']);assert.ok(Array.isArray(action.parameters));assert.ok(Array.isArray(action.preconditions));}
  // A well-formed project scope is answered by dimension, not by whether the project exists: the
  // registry declares what the capability needs, and the handler stays the authority on existence.
  const unregistered=await read('/api/actions?projectId='+randomUUID());
  assert.equal(unregistered.status,200,'a project scope is answered whether or not the project exists');
  assert.deepEqual((await unregistered.json()).actions.map((action:any)=>action.id),withoutRunner(ACTION_DESCRIPTORS.filter(descriptor=>!descriptor.requires.includes('session'))).map(descriptor=>descriptor.id));
  assert.equal((await execute({id:'session.create',params:{name:'Orphan'},scope:{projectId:randomUUID()}})).status,404,'the handler is the authority on whether the project exists');

  const project=await (await post('/api/projects',{name:'Actions',managed:true,confirm:true})).json();
  const projectActions=await (await read('/api/actions?projectId='+project.id)).json();
  assert.deepEqual(projectActions.actions.map((action:any)=>action.id),withoutRunner(ACTION_DESCRIPTORS.filter(descriptor=>!descriptor.requires.includes('session'))).map(descriptor=>descriptor.id),'a project scope adds the project-scoped actions');
  // Asking for a disabled capability is a named refusal, not an attempt: the runner is not offered and
  // not silently attempted either.
  const runnerRefusal=await execute({id:'runner.submit',params:{recipe:'noop-probe',workspace:'.'},scope:{projectId:project.id}});
  assert.equal(runnerRefusal.status,503);
  const runnerBody=await runnerRefusal.json();
  assert.equal(runnerBody.code,'UNAVAILABLE');
  assert.match(runnerBody.error,/the coding runner is not enabled on this instance/);
  const session=(await (await post('/api/sessions',{projectId:project.id,name:'Registry session'})).json()).session;
  const full=await (await read('/api/actions?projectId='+project.id+'&sessionId='+session.id)).json();
  assert.deepEqual(full.actions.map((action:any)=>action.id),scopedIds,'one project and one session satisfy every declared scope');
  assert.deepEqual(full.scope,{projectId:project.id,sessionId:session.id});
  const stop=full.actions.find((action:any)=>action.id==='session.lifecycle.stop');
  assert.ok(stop.preconditions.some((precondition:any)=>precondition.code==='REVISION_MATCHES'));
  assert.ok(stop.parameters.some((parameter:any)=>parameter.name==='revision'&&parameter.required===true));
  // An action that does not exist is refused, and the refusal is precise rather than an empty list.
  const unknown=await execute({id:'session.dance',scope:{projectId:project.id}});
  assert.equal(unknown.status,404);const unknownBody=await unknown.json();
  assert.equal(unknownBody.code,'UNKNOWN');
  assert.match(unknownBody.error,/Unknown action id "session\.dance"/);
  assert.ok(!/zod|Unrecognized key/i.test(unknownBody.error));
  // A scope violation is refused, and nothing runs: the action needs a session the request does not name.
  const scopeViolation=await execute({id:'session.lifecycle.stop',params:{revision:0},scope:{projectId:project.id}});
  assert.equal(scopeViolation.status,403);const scopeBody=await scopeViolation.json();
  assert.equal(scopeBody.code,'SCOPE');
  assert.match(scopeBody.error,/requires the session scope/);
  // The parameters are validated against the schema the registry published, in this application's words.
  const extraField=await execute({id:'session.create',params:{name:'Extra',colour:'red'},scope:{projectId:project.id}});
  assert.equal(extraField.status,422);const extraBody=await extraField.json();
  assert.equal(extraBody.code,'INVALID');
  assert.match(extraBody.error,/does not accept/);
  assert.ok(!/zod|Unrecognized key/i.test(extraBody.error),'the raw schema message is not echoed: '+extraBody.error);
  const missingField=await execute({id:'session.create',params:{},scope:{projectId:project.id}});
  assert.equal(missingField.status,422);
  assert.match((await missingField.json()).error,/name/);
  // One real action, executed through the very path the palette uses: it really creates the session.
  const created=await execute({id:'session.create',params:{name:'From the palette'},scope:{projectId:project.id}});
  assert.equal(created.status,200);
  const createdBody=await created.json();
  assert.equal(createdBody.action,'session.create');
  assert.equal(createdBody.result.name,'From the palette');
  const listed=await (await read('/api/sessions?projectId='+project.id)).json();
  assert.deepEqual(listed.sessions.map((entry:any)=>entry.name).sort(),['From the palette','Registry session'],'the action really wrote the session');
  // A duplicate name is the handler's own refusal, and it arrives as such.
  const duplicate=await execute({id:'session.create',params:{name:'From the palette'},scope:{projectId:project.id}});
  assert.equal(duplicate.status,409);
  assert.match((await duplicate.json()).error,/already has a live session named From the palette/);
  // A handler refusal from the lifecycle path too: a stale revision is a conflict that changed nothing.
  const stale=await execute({id:'session.rename',params:{name:'Renamed',revision:99},scope:{projectId:project.id,sessionId:session.id}});
  assert.equal(stale.status,409);
  assert.match((await stale.json()).error,/is at revision 1, not 99/);
  const renamed=await execute({id:'session.rename',params:{name:'Renamed',revision:session.revision},scope:{projectId:project.id,sessionId:session.id}});
  assert.equal(renamed.status,200);
  assert.equal((await renamed.json()).result.name,'Renamed');
  // A session that does not exist is the handler's not-found, not a scope violation.
  const absent=await execute({id:'session.lifecycle.reconnect',params:{revision:0},scope:{projectId:project.id,sessionId:randomUUID()}});
  assert.equal(absent.status,404);
  // The read-only doctor and the delivery report are the same handlers the CLI and the start use.
  const doctor=await execute({id:'doctor.report'});
  assert.equal(doctor.status,200);
  assert.equal((await doctor.json()).result.readOnly,true);
  const reconciliation=await execute({id:'delivery.reconciliation.report'});
  assert.equal(reconciliation.status,200);
  assert.equal((await reconciliation.json()).result.readOnly,true);
  // An envelope field the route does not accept is an invalid request, in this application's words.
  assert.equal((await execute({id:'doctor.report',params:{},scope:{projectId:project.id},extra:true})).status,422);
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
 // Without a durable control store the instance can really only run the read-only doctor, and says so.
 const bare=await mkdtemp(join(tmpdir(),'dashboard-actions-bare-'));
 const bareSecurity=localConfig('http://127.0.0.1:0');
 const bareApp=await createApp({dataRoot:bare,browseRoots:[],security:bareSecurity});
 await listen(bareApp,bareSecurity);
 try{
  const bareToken={'x-dashboard-token':bareSecurity.token},bareWrites={...bareToken,'content-type':'application/json',origin:bareSecurity.origin};
  const listed=await (await fetch(bareSecurity.origin+'/api/actions',{headers:bareToken})).json();
  assert.deepEqual(listed.actions.map((action:any)=>action.id),['doctor.report'],'an action whose capability is absent is not offered');
  assert.equal((await fetch(bareSecurity.origin+'/api/actions/execute',{method:'POST',headers:bareWrites,body:JSON.stringify({id:'session.create',params:{name:'x'},scope:{projectId:randomUUID()}})})).status,503);
  assert.equal((await fetch(bareSecurity.origin+'/api/actions/activity?projectId='+randomUUID(),{headers:bareToken})).status,503,'the projection refuses without a durable store rather than guessing');
  assert.equal((await fetch(bareSecurity.origin+'/api/actions/execute',{method:'POST',headers:bareWrites,body:JSON.stringify({id:'doctor.report'})})).status,200);
 }finally{await bareApp.close();await rm(bare,{recursive:true,force:true});}
});

test('the queue routes are owner-only, revision-checked and precise, and never dispatch where the instance cannot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-queue-api-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const read=(p:string)=>fetch(url+p,{headers:token});
 try{
  const project=await (await post('/api/projects',{name:'Queue',managed:true,confirm:true})).json();
  const session=(await (await post('/api/sessions',{projectId:project.id,name:'Queue session'})).json()).session;
  const base='/api/sessions/'+session.id+'/queue';
  // Owner-only like every other route, behind the unchanged Host check, with the same origin
  // enforcement for the writes; the read is a GET and an unknown operation is not a route at all.
  assert.equal((await fetch(url+base+'?projectId='+project.id)).status,401,'the queue is behind owner auth');
  const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:base+'?projectId='+project.id,headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
  assert.equal(wrongHost,403,'the unchanged Host check applies to the queue');
  assert.equal((await fetch(url+base+'/append',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403,'a queue write needs the canonical origin');
  assert.equal((await post(base,{})).status,405,'the queue read is a GET only');
  assert.equal((await read(base+'/append?projectId='+project.id)).status,405,'a queue write is a POST only');
  assert.equal((await read(base)).status,422,'projectId is required');
  assert.equal((await read(base+'?projectId=../../etc')).status,422,'a project id that is not one is an invalid request');
  assert.equal((await read(base+'?projectId='+randomUUID())).status,404,'an unregistered project is not a queue scope');
  assert.equal((await read('/api/sessions/'+randomUUID()+'/queue?projectId='+project.id)).status,404,'an unknown session has no queue');
  assert.equal((await read(base+'/dance?projectId='+project.id)).status,404,'an operation that does not exist is not a route');
  // The read: the queue with its revision and the bounds this build enforces, and no path in it.
  const empty=await (await read(base+'?projectId='+project.id)).json();
  assert.deepEqual([empty.readOnly,empty.projectId,empty.sessionId,empty.revision,empty.entries],[true,project.id,session.id,0,[]]);
  assert.deepEqual(empty.limits,{entries:50,text:2000,imagesPerEntry:6,bytes:65536});
  assert.ok(!JSON.stringify(empty).includes(data),'the payload carries no filesystem path');
  // An entry with neither text nor an image, an unknown field, and an image the media store does not
  // hold: each refused in this application's own words, before anything is written.
  const nothing=await post(base+'/append',{projectId:project.id,revision:0});
  assert.equal(nothing.status,422);assert.match((await nothing.json()).error,/needs text or an image/);
  const extra=await post(base+'/append',{projectId:project.id,revision:0,text:'x',colour:'red'});
  assert.equal(extra.status,422);assert.match((await extra.json()).error,/does not accept/);
  const unknownImage=await post(base+'/append',{projectId:project.id,revision:0,images:['a'.repeat(64)]});
  assert.equal(unknownImage.status,422);assert.equal((await unknownImage.json()).code,'unknown-media');
  assert.equal((await post(base+'/append',{projectId:project.id,revision:0,images:['../../etc/passwd']})).status,422,'an image reference is a media id, never a path');
  assert.equal((await (await read(base+'?projectId='+project.id)).json()).revision,0,'a refused append wrote nothing');
  // One real append, and the revision it raises.
  const appended=await post(base+'/append',{projectId:project.id,revision:0,text:'the first queued input'});
  assert.equal(appended.status,200);
  const appendedBody=await appended.json();
  assert.deepEqual([appendedBody.outcome,appendedBody.queue.revision,appendedBody.entry.state,appendedBody.changed,appendedBody.removed],['appended',1,'queued',true,0]);
  const entryId=appendedBody.entry.id as string;
  // A stale revision is a conflict, not a silent overwrite, and the record keeps the text it had.
  const stale=await post(base+'/append',{projectId:project.id,revision:0,text:'written over a change nobody saw'});
  assert.equal(stale.status,409);assert.match((await stale.json()).error,/is at revision 1, not 0/);
  assert.deepEqual((await (await read(base+'?projectId='+project.id)).json()).entries.map((entry:any)=>entry.text),['the first queued input']);
  // Editing, a position outside the queue, and a reorder that moves nothing.
  const edited=await post(base+'/edit',{projectId:project.id,revision:1,entryId,text:'the first queued input, edited'});
  assert.equal(edited.status,200);assert.equal((await edited.json()).entry.text,'the first queued input, edited');
  const outside=await post(base+'/reorder',{projectId:project.id,revision:2,entryId,position:4});
  assert.equal(outside.status,422);assert.match((await outside.json()).error,/outside the queue/);
  const unmoved=await (await post(base+'/reorder',{projectId:project.id,revision:2,entryId,position:0})).json();
  assert.deepEqual([unmoved.outcome,unmoved.changed,unmoved.queue.revision],['unchanged',false,2],'moving an entry to its own position writes nothing and raises no revision');
  // A dispatcher that cannot dispatch refuses before claiming, and an entry that is not claimed can
  // be neither submitted, released nor reconciled: every one of those keeps its own status.
  const noDispatch=await post(base+'/claim',{projectId:project.id,owner:'dispatcher-1'});
  assert.equal(noDispatch.status,503);assert.match((await noDispatch.json()).error,/Agents are disabled on this instance/);
  assert.equal((await (await read(base+'?projectId='+project.id)).json()).revision,2,'a refused claim claimed no revision');
  assert.equal((await post(base+'/submit',{projectId:project.id,entryId,owner:'dispatcher-1'})).status,409);
  assert.equal((await post(base+'/release',{projectId:project.id,entryId,owner:'dispatcher-1'})).status,409);
  assert.equal((await post(base+'/reconcile',{projectId:project.id,entryId})).status,409);
  assert.equal((await post(base+'/claim',{projectId:project.id,owner:'dispatcher-1',extra:true})).status,422);
  assert.equal((await post(base+'/edit',{projectId:project.id,revision:2,entryId:randomUUID(),text:'x'})).status,404,'an entry the queue does not hold is not found');
  // Cancelling, clearing nothing, and removing what is left.
  const cancelled=await (await post(base+'/cancel',{projectId:project.id,revision:2,entryId})).json();
  assert.deepEqual([cancelled.entry.state,cancelled.queue.revision],['cancelled',3]);
  const cleared=await (await post(base+'/clear',{projectId:project.id,revision:3})).json();
  assert.deepEqual([cleared.outcome,cleared.changed,cleared.removed],['unchanged',false,0],'a cancelled entry is neither settled nor failed, so clearing it is not what clear does');
  const removed=await (await post(base+'/remove',{projectId:project.id,revision:3,entryId})).json();
  assert.deepEqual([removed.outcome,removed.removed,removed.queue.entries.length],['removed',1,0]);
  assert.equal((await post(base+'/remove',{projectId:project.id,revision:4,entryId})).status,404,'removing an entry twice is not found');
  // The same queue operations are offered by the one command surface, for the same session.
  const listed=await (await read('/api/actions?projectId='+project.id+'&sessionId='+session.id)).json();
  assert.deepEqual(listed.actions.map((action:any)=>action.id).filter((id:string)=>id.startsWith('queue.')).sort(),ACTION_IDS.filter(id=>id.startsWith('queue.')).sort());
  // A queue action keeps the queue's own status through the registry too: a stale revision is a conflict.
  const executed=await post('/api/actions/execute',{id:'queue.append',params:{revision:3,text:'a stale append'},scope:{projectId:project.id,sessionId:session.id}});
  assert.equal(executed.status,409);assert.match((await executed.json()).error,/is at revision 4, not 3/);
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('a claimed input is never cancelled into invisibility, and a reorder never skips one in flight',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-queue-order-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 // Dispatch is enabled, so a claim really happens; no submission is made, so no harness work is asked for.
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store,agents:'on',agentPauseMs:100});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const read=(p:string)=>fetch(url+p,{headers:token});
 try{
  const project=await (await post('/api/projects',{name:'Queue order',managed:true,confirm:true})).json();
  const session=(await (await post('/api/sessions',{projectId:project.id,name:'Queue order session'})).json()).session;
  const base='/api/sessions/'+session.id+'/queue';
  const first=await (await post(base+'/append',{projectId:project.id,revision:0,text:'the input a dispatcher holds'})).json();
  const second=await (await post(base+'/append',{projectId:project.id,revision:1,text:'the later input'})).json();
  const claim=await post(base+'/claim',{projectId:project.id,owner:'dispatcher-1'});
  assert.equal(claim.status,200,'a dispatcher that can dispatch claims the head');
  assert.equal((await claim.json()).entry.claim.requestId,'queue:'+first.entry.id,'the claim records the stable identity it authorises');
  // Cancelling a claimed entry is refused with the reason: a submission of it may be in flight, so a
  // cancel here could withdraw an input the durable transcript already holds.
  const cancelClaimed=await post(base+'/cancel',{projectId:project.id,revision:3,entryId:first.entry.id});
  assert.equal(cancelClaimed.status,409);
  const cancelClaimedRefusal=await cancelClaimed.json();
  assert.match(cancelClaimedRefusal.error,/may be in flight under the identity queue:/);
  assert.match(cancelClaimedRefusal.error,/release the claim first/);
  // A reorder that would move the later input ahead of the entry in flight is refused, and the
  // refusal names the entry that is the queue's effective head.
  const skip=await post(base+'/reorder',{projectId:project.id,revision:3,entryId:second.entry.id,position:0});
  assert.equal(skip.status,409);
  assert.match((await skip.json()).error,/effective head until it settles or is explicitly reconciled/);
  const after=await (await read(base+'?projectId='+project.id)).json();
  assert.deepEqual([after.revision,after.entries.map((entry:any)=>[entry.id,entry.state])],[3,[[first.entry.id,'claimed'],[second.entry.id,'queued']]],'both refusals left the record exactly as it was');
  // Releasing gives the entry back, and only then can the owner withdraw it.
  const released=await post(base+'/release',{projectId:project.id,entryId:first.entry.id,owner:'dispatcher-1'});
  assert.equal(released.status,200);
  const cancelled=await (await post(base+'/cancel',{projectId:project.id,revision:4,entryId:first.entry.id})).json();
  assert.deepEqual([cancelled.entry.state,cancelled.entry.claim,cancelled.queue.revision],['cancelled',null,5]);
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('the live projection reports the durable run state and distinguishes none, unavailable and failed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-live-activity-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store,agents:'on',agentPauseMs:100});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 try{
  const project=await (await fetch(url+'/api/projects',{method:'POST',headers:writes,body:JSON.stringify({name:'Activity',managed:true,confirm:true})})).json();
  const session=(await (await fetch(url+'/api/sessions',{method:'POST',headers:writes,body:JSON.stringify({projectId:project.id,name:'Live session'})})).json()).session;
  // A session with no durable lifecycle row is reported as that absence, never as the state 'idle'
  // the store happens to read at: the state is null, the reason is named and revision 0 is the
  // revision a first write would claim.
  const first=await (await fetch(url+'/api/actions/activity?projectId='+project.id,{headers:token})).json();
  assert.equal(first.readOnly,true);
  assert.deepEqual(first.sessions.map((entry:any)=>[entry.sessionId,entry.run.recorded,entry.run.state,entry.run.absenceReason,entry.run.revision]),[[session.id,false,null,LIVE_RUN_REASONS.noRecord,0]]);
  assert.equal(first.sessions[0].run.absenceDetail,LIVE_RUN_DETAILS.noRecord);
  assert.deepEqual([first.sessions[0].run.activityAt,first.sessions[0].run.updatedAt],[null,null],'no instant is invented for a row that does not exist');
  assert.equal(first.sessions[0].run.state,null,'an absent row is never reported as idle');
  const lifecycle=new SessionLifecycleStore(store);
  lifecycle.markRunning({projectId:project.id,sessionId:session.id,requestId:'live-request'});
  lifecycle.markSettled({projectId:project.id,sessionId:session.id,outcome:'failed',reason:'the generation failed'});
  const failed=await (await fetch(url+'/api/actions/activity?projectId='+project.id,{headers:token})).json();
  // A written state is read back as the fact it is, with no absence reason.
  assert.deepEqual(failed.sessions.map((entry:any)=>[entry.run.recorded,entry.run.state,entry.run.attempt,entry.run.reason,entry.run.absenceReason]),[[true,'failed',1,'the generation failed',null]]);
  // The harness really reports the conversation and its view carries no tool activity yet: 'none yet',
  // which is a different answer from 'unavailable' and from 'failed to read'.
  assert.deepEqual([failed.harness.state,failed.harness.reason],['none',LIVE_TOOL_REASONS.noToolActivity]);
  assert.equal(failed.harness.source,'harness-conversation-view');
  assert.equal(failed.harness.working,false);
  assert.deepEqual(failed.harness.invocations,[]);
  assert.ok(!JSON.stringify(failed).includes(data),'the projection never carries a filesystem path');
  assert.ok(!JSON.stringify(failed).includes(root));

  // What the palette really does, end to end over these routes: read the revision from the live
  // projection, then execute the lifecycle action with exactly that value. A write at that revision
  // succeeds; the revision a client used to assume is refused as the conflict it always was.
  lifecycle.markRunning({projectId:project.id,sessionId:session.id,requestId:'palette-request'});
  const projected=await (await fetch(url+'/api/actions/activity?projectId='+project.id,{headers:token})).json();
  const running=projected.sessions.find((entry:any)=>entry.sessionId===session.id);
  assert.deepEqual([running.run.recorded,running.run.state,running.run.revision],[true,'running',3],'the projection reports the durable revision, above zero');
  const executed=await fetch(url+'/api/actions/execute',{method:'POST',headers:writes,body:JSON.stringify({id:'session.lifecycle.pause',params:{revision:running.run.revision,reason:'paused from the palette'},scope:{projectId:project.id,sessionId:session.id}})});
  assert.equal(executed.status,200,'a lifecycle write at the revision the projection reports succeeds');
  const executedBody=await executed.json();
  assert.deepEqual([executedBody.result.record.state,executedBody.result.record.revision,executedBody.result.cancelled],['paused',running.run.revision+1,true]);
  const assumed=await fetch(url+'/api/actions/execute',{method:'POST',headers:writes,body:JSON.stringify({id:'session.lifecycle.pause',params:{revision:0,reason:'assumed'},scope:{projectId:project.id,sessionId:session.id}})});
  assert.equal(assumed.status,409,'the revision a client would have assumed is still refused as a conflict');
  assert.match((await assumed.json()).error,/is at lifecycle revision \d+, not 0/);
  const afterPause=await (await fetch(url+'/api/actions/activity?projectId='+project.id,{headers:token})).json();
  assert.equal(afterPause.sessions.find((entry:any)=>entry.sessionId===session.id).run.state,'paused','the projection reads the write back');
  // A project the registry does not know, and a projection with no project at all.
  assert.equal((await fetch(url+'/api/actions/activity?projectId='+randomUUID(),{headers:token})).status,404);
  assert.equal((await fetch(url+'/api/actions/activity',{headers:token})).status,422);
  assert.equal((await fetch(url+'/api/actions/activity?projectId=../../etc',{headers:token})).status,422,'a scope that is not an identifier is an invalid request');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
 // An instance with the harness off says so by name instead of reporting an empty list as "none".
 const off=await mkdtemp(join(tmpdir(),'dashboard-live-off-'));
 const offData=join(off,'data');await mkdir(offData,{recursive:true,mode:0o700});
 const offStore=new ControlStore(offData);
 const offSecurity=localConfig('http://127.0.0.1:0');
 const offApp=await createApp({dataRoot:offData,browseRoots:[],security:offSecurity,control:offStore});
 await listen(offApp,offSecurity);
 try{
  const offUrl=offSecurity.origin,offToken={'x-dashboard-token':offSecurity.token},offWrites={...offToken,'content-type':'application/json',origin:offUrl};
  const offProject=await (await fetch(offUrl+'/api/projects',{method:'POST',headers:offWrites,body:JSON.stringify({name:'No harness',managed:true,confirm:true})})).json();
  const unavailable=await (await fetch(offUrl+'/api/actions/activity?projectId='+offProject.id,{headers:offToken})).json();
  assert.deepEqual([unavailable.harness.state,unavailable.harness.reason,unavailable.harness.source],['unavailable','agents-disabled-on-this-instance',null]);
  assert.deepEqual(unavailable.harness.invocations,[]);
 }finally{await offApp.close();offStore.close();await rm(off,{recursive:true,force:true});}
});
test('the coding runner routes are owner-only, are enabled explicitly, and refuse a job this instance cannot contain',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-runner-api-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 // The port is injected, so this suite never starts a container and never contacts a container
 // runtime. It reports the documented containment and one scripted execution.
 const calls:string[]=[];let executions=0;let contained=containment();
 const port:RunnerPort={
  async establish(){calls.push('establish');return contained;},
  async execute(input:RunnerExecutionRequest){calls.push('execute:'+input.job.recipe);executions+=1;return execution();}
 };
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store,runner:{enabled:true,port}});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const read=(p:string)=>fetch(url+p,{headers:token});
 try{
  const project=await (await post('/api/projects',{name:'Runner',managed:true,confirm:true})).json();
  const base='/api/projects/'+project.id+'/runner/jobs';
  // Owner-only, behind the unchanged Host check, with the same origin enforcement for writes.
  assert.equal((await fetch(url+base)).status,401,'the job list is behind owner auth');
  assert.equal((await fetch(url+base,{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({recipe:'noop-probe',workspace:'.'})})).status,401,'submitting is behind owner auth');
  assert.equal((await fetch(url+base,{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403,'submitting is a write and needs the canonical origin');
  const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:base,headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
  assert.equal(wrongHost,403,'the unchanged Host check applies to the runner routes');
  // Enabled explicitly, the runner offers its five actions for this scope — and only because it is on.
  const listed=await (await read('/api/actions?projectId='+project.id)).json();
  assert.deepEqual(listed.actions.map((action:any)=>action.id).filter((id:string)=>id.startsWith('runner.')).sort(),[...RUNNER_ACTION_IDS].sort());
  // A workspace outside the registered root, an unknown recipe, an unknown field, an oversized limit
  // and a workspace that does not exist each fail closed with their own status and no record written.
  assert.equal((await post(base,{recipe:'test-run',workspace:'../outside'})).status,403);
  assert.equal((await post(base,{recipe:'test-run',workspace:'/etc'})).status,403);
  assert.equal((await post(base,{recipe:'rm -rf /',workspace:'.'})).status,422);
  assert.equal((await post(base,{recipe:'noop-probe',workspace:'.',surprise:true})).status,422);
  assert.equal((await post(base,{recipe:'noop-probe',workspace:'.',limits:{cpus:99}})).status,422);
  assert.equal((await post(base,{recipe:'noop-probe',workspace:'nope'})).status,404);
  assert.deepEqual((await (await read(base)).json()).jobs,[],'a refused submission wrote nothing');
  // A real submission, then the documented lifecycle.
  const submitted=await post(base,{recipe:'noop-probe',workspace:'.',limits:{timeoutMs:5000}});
  assert.equal(submitted.status,201);
  const job=(await submitted.json()).job;
  assert.deepEqual([job.state,job.revision,job.workspace,job.limits.timeoutMs],['pending',1,'.',5000]);
  assert.ok(!JSON.stringify(job).includes(data),'no stored field carries a filesystem path');
  assert.deepEqual((await (await read(base)).json()).jobs.map((candidate:any)=>candidate.id),[job.id]);
  // Containment is established before the claim is written: an instance that cannot contain a job
  // leaves the job unclaimed and executes nothing, anywhere.
  contained=containment({network:'bridge',dockerSocket:true});
  const refused=await post(base+'/claim',{owner:'api-dispatcher'});
  assert.equal(refused.status,503);
  const refusedBody=await refused.json();
  assert.match(refusedBody.error,/no-network/);
  assert.match(refusedBody.error,/there is no fallback/i);
  assert.equal(executions,0,'a refused containment executed nothing');
  assert.equal((await (await read(base)).json()).jobs[0].state,'pending','the job is left unclaimed');
  contained=containment();
  assert.equal((await post(base+'/claim',{owner:'api-dispatcher'})).status,200);
  // Only the owner of the claim may run it, and a settled job is never run again.
  assert.equal((await post(base+'/'+job.id+'/run',{owner:'someone-else'})).status,409);
  assert.equal(executions,0,'a foreign claim ran nothing');
  const ran=await post(base+'/'+job.id+'/run',{owner:'api-dispatcher'});
  assert.equal(ran.status,200);
  const ranJob=(await ran.json()).job;
  assert.deepEqual([ranJob.state,ranJob.result.outcome,ranJob.result.exitCode,ranJob.result.stdout],['settled','succeeded',0,'probe\n']);
  assert.deepEqual(ranJob.result.commands,[{recipe:'noop-probe',argv:['/bin/echo','pilot-runner-probe']}]);
  assert.equal(executions,1,'the job ran exactly once');
  assert.equal((await post(base+'/'+job.id+'/run',{owner:'api-dispatcher'})).status,409,'a settled job is never run again');
  const settled=await post(base+'/'+job.id+'/settle',{});
  assert.equal(settled.status,200);
  assert.equal((await settled.json()).outcome,'unchanged');
  assert.equal((await post(base+'/'+randomUUID()+'/run',{owner:'api-dispatcher'})).status,404);
  assert.equal((await post(base+'/claim',{owner:'api-dispatcher'})).status,409,'nothing is left to claim');
  assert.equal((await read(base+'/'+job.id+'/run')).status,405,'a run is a POST');
  assert.equal((await read('/api/projects/'+randomUUID()+'/runner/jobs')).status,404,'an unregistered project is not found');
  assert.equal((await read(base)).status,200);
  assert.equal(executions,1,'no other route ran the job');
  assert.ok(calls.includes('establish'),'containment was established before every claim and run');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});
test('the acceptance routes are owner-only, refuse an agent acceptance under owner-only, and write the Markdown record',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-acceptance-api-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const read=(p:string)=>fetch(url+p,{headers:token});
 try{
  const project=await (await post('/api/projects',{name:'Acceptance',managed:true,confirm:true})).json();
  const session=(await (await post('/api/sessions',{projectId:project.id,name:'Acceptance session'})).json()).session;
  const artifact={revision:'a'.repeat(64),commit:null};
  const evidence={sessionId:session.id,subject:{kind:'session',id:session.id},artifact,commands:['pnpm test'],diff:{files:3,linesAdded:42,linesRemoved:7,text:'--- a/x\n+++ b/x\n-1\n+2\n',reference:null},tests:[{command:'pnpm test',outcome:'passed',output:'# tests 12\n# pass 12\n# fail 0\n# skipped 0',counts:{passed:12,failed:0,skipped:0}}],review:null,producedAt:new Date(Date.now()-60_000).toISOString()};

  // Owner-only, behind the unchanged Host check, with the same origin enforcement for the writes.
  assert.equal((await fetch(url+'/api/acceptance?projectId='+project.id)).status,401,'the record is behind owner auth');
  assert.equal((await fetch(url+'/api/acceptance/policy')).status,401,'the policy is behind owner auth');
  assert.equal((await fetch(url+'/api/acceptance/evidence',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403,'recording evidence is a write and needs the canonical origin');
  const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:'/api/acceptance/policy',headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
  assert.equal(wrongHost,403,'the unchanged Host check applies to the acceptance routes');
  assert.equal((await read('/api/acceptance')).status,422,'a read names the project it is about');
  assert.equal((await read('/api/acceptance?projectId='+randomUUID())).status,404,'an unregistered project is not found');
  assert.equal((await read('/api/acceptance/evidence')).status,405,'recording evidence is a POST');
  assert.equal((await post('/api/acceptance/accept',{projectId:project.id,request:{}})).status,422,'an unparseable acceptance is an invalid request');

  // The policy before anything is written is the documented default, and it says so.
  const initial=(await (await read('/api/acceptance/policy')).json()).policy;
  assert.deepEqual([initial.mode,initial.revision,initial.recorded,initial.updatedBy,initial.absenceReason,Object.values(initial.actionClasses)],['owner-only',0,false,null,'no-policy-recorded-yet',['ask','ask','ask','ask','ask','ask']]);
  assert.deepEqual((await (await read('/api/acceptance?projectId='+project.id)).json()).evidence,[],'a project with no completion record reads as an empty list');

  // One real completion record: its counts are read from its own output, and its Markdown is written.
  const recorded=await post('/api/acceptance/evidence',{projectId:project.id,evidence});
  assert.equal(recorded.status,201);
  const recordedBody=await recorded.json();
  const record=recordedBody.evidence.record;
  assert.deepEqual([recordedBody.written,recordedBody.evidence.markdown.state,recordedBody.evidence.markdown.path],[true,'current','docs/acceptance/'+record.id+'.md']);
  assert.deepEqual([record.artifact.revision,record.artifact.commit,record.frozen,record.tests[0].counts,record.subject],[artifact.revision,null,true,{passed:12,failed:0,skipped:0},{kind:'session',id:session.id}]);
  assert.ok(!JSON.stringify(record).includes(project.path)&&!JSON.stringify(record).includes(data),'no stored field carries a filesystem path');
  const written=await readFile(join(project.path,'docs','acceptance',record.id+'.md'),'utf8');
  assert.ok(written.includes('# Completion record '+record.id),'the durable Markdown record names the record');
  assert.ok(written.includes('- Counts (read from the recorded output): 12 passed, 0 failed, 0 skipped'),'the Markdown record carries the counts read from the output');
  assert.ok(written.includes('No acceptance is recorded for this evidence.'));
  // A claim that contradicts the recorded output is refused, and nothing is written.
  const contradictory=await post('/api/acceptance/evidence',{projectId:project.id,evidence:{...evidence,tests:[{command:'pnpm test',outcome:'passed',output:'# tests 12\n# pass 11\n# fail 1\n# skipped 0',counts:{passed:12,failed:0,skipped:0}}]}});
  assert.equal(contradictory.status,422);
  assert.match((await contradictory.json()).error,/but its recorded output reports 11 passed, 1 failed and 0 skipped/);
  assert.equal((await (await read('/api/acceptance?projectId='+project.id)).json()).evidence.length,1,'a refused record wrote nothing');

  // Under the default owner-only policy an agent acceptance is refused outright, and nothing is written.
  const agentRefused=await post('/api/acceptance/accept',{projectId:project.id,request:{evidenceId:record.id,artifact,actionClass:'commit'},actor:{kind:'agent',identity:'api-worker'}});
  assert.equal(agentRefused.status,403);
  assert.match((await agentRefused.json()).error,/The acceptance policy is owner-only, so an acceptance by agent api-worker is refused outright/);
  assert.equal((await (await read('/api/acceptance?projectId='+project.id)).json()).evidence[0].acceptance,null,'the refusal recorded no acceptance');

  // The owner sets the policy, and then the agent may accept the class set to full-auto.
  const updated=await post('/api/acceptance/policy',{revision:0,policy:{mode:'agent-may-accept',actionClasses:{commit:'full-auto',push:'ask',deploy:'ask',spend:'ask',provision:'ask',publish:'ask'}}});
  assert.equal(updated.status,200);
  const updatedPolicy=(await updated.json()).policy;
  assert.deepEqual([updatedPolicy.mode,updatedPolicy.revision,updatedPolicy.updatedBy],['agent-may-accept',1,'local'],'the policy records the authenticated owner as the one who changed it');
  const accepted=await post('/api/acceptance/accept',{projectId:project.id,request:{evidenceId:record.id,artifact,actionClass:'commit'},actor:{kind:'agent',identity:'api-worker'}});
  assert.equal(accepted.status,200);
  const acceptedBody=await accepted.json();
  assert.deepEqual([acceptedBody.acceptance.acceptedBy.kind,acceptedBody.acceptance.acceptedBy.policyRule,acceptedBody.acceptance.policy.mode,acceptedBody.acceptance.singleUse],['agent','agent-may-accept:commit=full-auto','agent-may-accept',true]);
  const acceptedMarkdown=await readFile(join(project.path,'docs','acceptance',record.id+'.md'),'utf8');
  assert.ok(acceptedMarkdown.includes('agent-may-accept:commit=full-auto'),'the Markdown record carries the rule that permitted the acceptance');
  assert.match(acceptedMarkdown,/- Accepted by: agent .api-worker. at \d{4}-/,'and who accepted it');
  assert.ok(!acceptedMarkdown.includes('No acceptance is recorded for this evidence.'));
  // A second acceptance of the same artifact is single use, whether it is an agent or the owner.
  const second=await post('/api/acceptance/accept',{projectId:project.id,request:{evidenceId:record.id,artifact,actionClass:'commit'}});
  assert.equal(second.status,409,'the second acceptance is refused, even though this one names no actor and so is the owner');
  assert.match((await second.json()).error,/already accepted at .* by agent .api-worker.; an acceptance is single use/);
  // An artifact that has moved since the evidence was produced is refused before any acceptance.
  const moved=await post('/api/acceptance/accept',{projectId:project.id,request:{evidenceId:record.id,artifact:{revision:'b'.repeat(64),commit:null},actionClass:'commit'}});
  assert.equal(moved.status,409);
  assert.match((await moved.json()).error,/The artifact has changed since this evidence was produced/);
  // A stale policy revision is a conflict that writes nothing.
  const stale=await post('/api/acceptance/policy',{revision:0,policy:{mode:'owner-only',actionClasses:{commit:'ask',push:'ask',deploy:'ask',spend:'ask',provision:'ask',publish:'ask'}}});
  assert.equal(stale.status,409);
  assert.match((await stale.json()).error,/at revision 1, not 0/);
  // The read reports the record with its acceptance and the policy in force, and no path.
  const view=await (await read('/api/acceptance?projectId='+project.id)).json();
  assert.deepEqual([view.readOnly,view.projectId,view.evidence.length,view.policy.revision,view.evidence[0].acceptance.acceptedBy.identity,view.truncated],[true,project.id,1,1,'api-worker',false]);
  assert.ok(!JSON.stringify(view).includes(data)&&!JSON.stringify(view).includes(root),'the view leaks no filesystem path');
  // The same capability through the command registry keeps its own statuses.
  const viaRegistry=await post('/api/actions/execute',{id:'acceptance.read',params:{},scope:{projectId:project.id}});
  assert.equal(viaRegistry.status,200);
  assert.equal((await viaRegistry.json()).result.evidence.length,1);
  const registryRefusal=await post('/api/actions/execute',{id:'acceptance.accept',params:{request:{evidenceId:'ev-'+'0'.repeat(64),artifact,actionClass:'commit',actor:{kind:'owner',identity:'local'}}},scope:{projectId:project.id}});
  assert.equal(registryRefusal.status,404);
  assert.ok(!JSON.stringify(await registryRefusal.json()).includes(project.path),'a registry refusal is path-free');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});
test('the accept route records the declared actor whatever shape declares it, refuses a disagreement, and refuses an agent the policy forbids',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-acceptance-actor-'));
 const data=join(root,'data');await mkdir(data,{recursive:true,mode:0o700});
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:data,browseRoots:[],security,control:store});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const read=(p:string)=>fetch(url+p,{headers:token});
 try{
  const project=await (await post('/api/projects',{name:'Acceptance actors',managed:true,confirm:true})).json();
  const session=(await (await post('/api/sessions',{projectId:project.id,name:'Actor session'})).json()).session;
  // Two units of work: one answers the permitted case, the other pins the refusals.
  const firstArtifact={revision:'a'.repeat(64),commit:null},secondArtifact={revision:'b'.repeat(64),commit:null};
  const evidenceFor=(artifact:{revision:string;commit:null})=>({sessionId:session.id,subject:{kind:'session',id:session.id},artifact,commands:['pnpm test'],diff:{files:3,linesAdded:42,linesRemoved:7,text:'--- a/x\n+++ b/x\n-1\n+2\n',reference:null},tests:[{command:'pnpm test',outcome:'passed',output:'# tests 12\n# pass 12\n# fail 0\n# skipped 0',counts:{passed:12,failed:0,skipped:0}}],review:null,producedAt:new Date(Date.now()-60_000).toISOString()});
  const recordFor=async(artifact:{revision:string;commit:null})=>{const body=await (await post('/api/acceptance/evidence',{projectId:project.id,evidence:evidenceFor(artifact)})).json();return body.evidence.record as {id:string};};
  const first=await recordFor(firstArtifact),second=await recordFor(secondArtifact);
  const acceptanceOf=async(evidenceId:string)=>{const view=await (await read('/api/acceptance?projectId='+project.id)).json() as {evidence:{record:{id:string};acceptance:unknown}[]};const entry=view.evidence.find(candidate=>candidate.record.id===evidenceId);assert.ok(entry,'the project view holds the record it just answered with');return entry.acceptance;};

  // The registry publishes the actor INSIDE the request, and the palette sends it that way. Under the
  // default owner-only policy that body must be refused as the agent it declares — never quietly
  // recorded as the owner's permitted acceptance.
  const nestedRefused=await post('/api/acceptance/accept',{projectId:project.id,request:{evidenceId:first.id,artifact:firstArtifact,actionClass:'commit',actor:{kind:'agent',identity:'nested-worker'}}});
  assert.equal(nestedRefused.status,403,'an agent the owner-only policy forbids is refused, however its actor is declared');
  assert.match((await nestedRefused.json()).error,/The acceptance policy is owner-only, so an acceptance by agent nested-worker is refused outright/);
  assert.equal(await acceptanceOf(first.id),null,'the refusal recorded no acceptance');

  // A body that declares two different actors is refused rather than one of them being chosen for it.
  const disagreeing=await post('/api/acceptance/accept',{projectId:project.id,request:{evidenceId:first.id,artifact:firstArtifact,actionClass:'commit',actor:{kind:'agent',identity:'nested-worker'}},actor:{kind:'owner',identity:'local'}});
  assert.equal(disagreeing.status,422,'which identity is accepting must not be ambiguous');
  const disagreeingBody=await disagreeing.json();
  assert.match(disagreeingBody.error,/declares agent .nested-worker. inside the request and owner .local. beside it/);
  assert.ok(!JSON.stringify(disagreeingBody).includes(project.path),'the refusal is path-free');
  assert.equal(await acceptanceOf(first.id),null,'the disagreement recorded no acceptance');

  // The owner opens the class, and then the registry-shaped body is accepted as the agent it declares.
  const policy=await post('/api/acceptance/policy',{revision:0,policy:{mode:'agent-may-accept',actionClasses:{commit:'full-auto',push:'ask',deploy:'ask',spend:'ask',provision:'ask',publish:'ask'}}});
  assert.equal(policy.status,200);
  const nestedAccepted=await post('/api/acceptance/accept',{projectId:project.id,request:{evidenceId:first.id,artifact:firstArtifact,actionClass:'commit',actor:{kind:'agent',identity:'nested-worker'}}});
  assert.equal(nestedAccepted.status,200);
  const acceptedBody=await nestedAccepted.json();
  assert.deepEqual(
   [acceptedBody.acceptance.acceptedBy.kind,acceptedBody.acceptance.acceptedBy.identity,acceptedBody.acceptance.acceptedBy.policyRule,acceptedBody.acceptance.policy.classDecision],
   ['agent','nested-worker','agent-may-accept:commit=full-auto','full-auto'],
   'the agent acceptance records the rule that permitted it, not an owner acceptance'
  );
  assert.ok((await readFile(join(project.path,'docs','acceptance',first.id+'.md'),'utf8')).includes('- Accepted by: agent `nested-worker` at '),'the Markdown record carries the agent the body declared');

  // Declaring the same actor in both places is one identity rather than a disagreement, and is accepted.
  const agreeing=await post('/api/acceptance/accept',{projectId:project.id,request:{evidenceId:second.id,artifact:secondArtifact,actionClass:'commit',actor:{kind:'agent',identity:'nested-worker'}},actor:{kind:'agent',identity:'nested-worker'}});
  assert.equal(agreeing.status,200);
  const agreeingBody=await agreeing.json();
  assert.deepEqual([agreeingBody.acceptance.acceptedBy.kind,agreeingBody.acceptance.acceptedBy.identity],['agent','nested-worker']);
  assert.equal((await acceptanceOf(second.id) as {acceptedBy:{kind:string}}).acceptedBy.kind,'agent');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('the fork routes are owner-only, branch a real repository at a cutoff and never carry the parent dirty state',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-forks-api-'));
 const data=join(root,'data'),workspaces=join(root,'workspaces'),repo=join(workspaces,'repo');
 await mkdir(data,{recursive:true,mode:0o700});await mkdir(repo,{recursive:true,mode:0o755});
 await writeFile(join(repo,'README.md'),'# Base\n');
 // A real repository with a real base commit; the sentinel below is left dirty and untracked.
 await gitIn(repo,['init','-q']);
 await gitIn(repo,['config','user.email','pilot@example.invalid']);
 await gitIn(repo,['config','user.name','Pilot test']);
 await gitIn(repo,['config','commit.gpgsign','false']);
 await gitIn(repo,['add','.']);
 await gitIn(repo,['commit','-q','-m','base']);
 const baseCommit=await gitIn(repo,['rev-parse','HEAD']);
 const sentinel=join(repo,'dirty-sentinel.txt');
 await writeFile(sentinel,'parent only\n');
 const store=new ControlStore(data);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:data,browseRoots:[workspaces],security,control:store,agents:'on'});
 await listen(app,security);
 const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
 const post=(p:string,body:unknown)=>fetch(url+p,{method:'POST',headers:writes,body:JSON.stringify(body)});
 const read=(p:string)=>fetch(url+p,{headers:token});
 try{
  const project=await (await post('/api/projects',{name:'Forkable',path:repo,managed:false,confirm:true})).json();
  const forks='/api/projects/'+project.id+'/forks',input='/api/projects/'+project.id+'/agents/input';
  // Opening the project's conversation creates its durable store; the migration then adopts that
  // conversation as the named parent session, exactly as it does on a fresh installation.
  assert.equal((await (await read('/api/projects/'+project.id+'/agents')).json()).enabled,true);
  await post('/api/sessions/migrate',{});
  const parent=(await (await read('/api/sessions?projectId='+project.id)).json()).sessions[0];
  // Owner-only like every other route, behind the unchanged Host check, with the same origin enforcement.
  assert.equal((await fetch(url+forks)).status,401,'the forks of a project are behind owner auth');
  const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:forks,headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
  assert.equal(wrongHost,403,'the unchanged Host check applies to the forks');
  assert.equal((await fetch(url+forks,{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403,'creating a fork is a write and needs the canonical origin');
  assert.equal((await read(forks+'/'+parent.id+'/resume')).status,405,'resuming is a POST only');
  const empty=await (await read(forks)).json();
  assert.deepEqual([empty.readOnly,empty.projectId,empty.forks],[true,project.id,[]]);
  assert.deepEqual(empty.limits,{forks:20,entryScan:2000,bytes:65536},'the bounds a fork is offered at are published');
  assert.ok(empty.rules.worktree.includes('never copied'),'the worktree rule is published with the forks');
  assert.ok(!JSON.stringify(empty).includes(data),'the fork view carries no fork root path of its own');

  // A submission before the cutoff, then entries after it: the child must not see the later ones.
  await post(input,{text:'parent before the cutoff'});
  const settled=await agentViewUntil(url,token,project.id,(view)=>view.entries.some((entry:any)=>entry.kind==='assistant'&&entry.text.includes('parent before the cutoff')));
  const cutoff=Number(settled.entries[settled.entries.length-1].id);
  await post(input,{text:'parent after the cutoff'});
  await agentViewUntil(url,token,project.id,(view)=>view.entries.some((entry:any)=>entry.kind==='assistant'&&entry.text.includes('parent after the cutoff')));

  // Every creation refusal writes nothing and leaves no worktree behind. The root is compared
  // canonically, because the store records the canonical path of the fork root it really created.
  const forkRoot=join(await realpath(root),'data','forks',project.id);
  const nothing=async()=>{assert.deepEqual((await (await read(forks)).json()).forks,[],'no fork was recorded');assert.deepEqual(await readdir(forkRoot).catch(()=>[]),[],'no worktree was left behind');};
  const missingCutoff=await post(forks,{parentSessionId:parent.id,baseCommit,cutoffEntryId:999999});
  assert.equal(missingCutoff.status,404);assert.match((await missingCutoff.json()).error,/holds no entry 999999/);
  await nothing();
  const badCommit=await post(forks,{parentSessionId:parent.id,baseCommit:'f'.repeat(40),cutoffEntryId:cutoff});
  assert.equal(badCommit.status,422);
  assert.ok(!(await badCommit.json()).error.includes(repo),'a refusal names no path');
  await nothing();
  assert.equal((await post(forks,{parentSessionId:parent.id,baseCommit,cutoffEntryId:cutoff,target:'../escape'})).status,422,'a target that could escape the fork root is refused');
  await nothing();
  const extraField=await post(forks,{parentSessionId:parent.id,baseCommit,cutoffEntryId:cutoff,branch:'work/pilot'});
  assert.equal(extraField.status,422);assert.match((await extraField.json()).error,/does not accept/);await nothing();

  // One real fork: paused, with its own worktree created from the recorded commit.
  const created=await post(forks,{parentSessionId:parent.id,baseCommit,cutoffEntryId:cutoff});
  assert.equal(created.status,201);
  const forkBody=(await created.json()).fork;
  assert.deepEqual([forkBody.state,forkBody.cutoffEntryId,forkBody.baseCommit,forkBody.parentSessionId],['paused',cutoff,baseCommit,parent.id]);
  assert.equal(forkBody.worktreePath,join(forkRoot,forkBody.childSessionId),'the worktree lives inside this instance designated fork root');
  assert.equal(await exists(join(forkBody.worktreePath,'README.md')),true);
  assert.equal(await exists(join(forkBody.worktreePath,'dirty-sentinel.txt')),false,'the child worktree does not carry the parent untracked sentinel');
  assert.equal(await readFile(sentinel,'utf8'),'parent only\n','the parent sentinel is untouched');
  assert.deepEqual(await gitIn(repo,['stash','list']),'','no stash was created anywhere');
  assert.equal(await gitIn(forkBody.worktreePath,['rev-parse','HEAD']),baseCommit,'the child worktree is at the recorded base commit');
  assert.equal(await gitIn(forkBody.worktreePath,['status','--porcelain=v1','--untracked-files=all']),'','the child worktree inherited no dirty state');

  // The child transcript really branches at the cutoff, and the child is a named session with no link.
  const listed=await (await read(forks)).json();
  assert.deepEqual(listed.forks.map((fork:any)=>[fork.childSessionId,fork.revision]),[[forkBody.childSessionId,1]]);
  const childView=await app.agents.sessionView(app.catalog.get(project.id),forkBody.childSessionId);
  assert.ok(childView,'the child transcript is readable');
  assert.ok(childView.entries.some((entry)=>Number(entry.id)===cutoff),'the child sees the entry it branched at');
  assert.equal(childView.entries.some((entry)=>Number(entry.id)>cutoff),false,'the child holds no entry the parent recorded after the cutoff');
  assert.equal(JSON.stringify(childView.entries).includes('parent after the cutoff'),false,'nothing the parent recorded after the cutoff reached the child');
  const sessions=await (await read('/api/sessions?projectId='+project.id)).json();
  assert.equal(sessions.sessions.some((session:any)=>session.id===forkBody.childSessionId&&session.links.length===0),true,'the child is a named session with no link');

  // The child cannot be dispatched into while it is paused, and this project's queue refuses to
  // misdirect a child's queued input into the root conversation.
  assert.equal((await post('/api/sessions/'+forkBody.childSessionId+'/queue/claim',{projectId:project.id,owner:'fork-dispatcher'})).status,409,'a child input is never dispatched into the project root conversation');
  const dispatchRefusal=await app.forks!.dispatchChild({projectId:project.id,childSessionId:forkBody.childSessionId,text:'not yet'}).then(()=>null).catch((error:Error)=>error);
  assert.ok(dispatchRefusal instanceof Error&&/paused/.test(dispatchRefusal.message),'a paused child refuses to dispatch');

  // A stale revision is a conflict that touches nothing, and the resume is what lifts the pause.
  assert.equal((await post(forks+'/'+forkBody.childSessionId+'/resume',{revision:forkBody.revision+3})).status,409);
  assert.equal((await (await read(forks)).json()).forks[0].revision,1,'a refused resume wrote no revision');
  const resumed=await post(forks+'/'+forkBody.childSessionId+'/resume',{revision:forkBody.revision});
  assert.equal(resumed.status,200);
  assert.deepEqual([(await resumed.json()).outcome,(await (await read(forks)).json()).forks[0].state],['resumed','active']);
  assert.equal((await post(forks+'/'+forkBody.childSessionId+'/discard',{})).status,422,'a discard needs the revision it read');

  // A worktree holding this child's own work is never removed without an explicit force.
  await writeFile(join(forkBody.worktreePath,'child-only.txt'),'this worktree own work\n');
  const dirty=await post(forks+'/'+forkBody.childSessionId+'/discard',{revision:2});
  assert.equal(dirty.status,200);
  const dirtyBody=await dirty.json();
  assert.deepEqual([dirtyBody.outcome,dirtyBody.removed,dirtyBody.fork.state,dirtyBody.fork.attention.reason],['attention',false,'failed','worktree-dirty']);
  assert.equal(await exists(join(forkBody.worktreePath,'child-only.txt')),true,'the dirty worktree is untouched');
  assert.equal((await post(forks+'/'+forkBody.childSessionId+'/resume',{revision:3})).status,409,'a fork that needs an operator cannot be resumed');
  const forced=await post(forks+'/'+forkBody.childSessionId+'/discard',{revision:3,force:true});
  assert.equal(forced.status,200);
  const forcedBody=await forced.json();
  assert.deepEqual([forcedBody.outcome,forcedBody.removed,forcedBody.fork.state],['discarded',true,'discarded']);
  assert.equal(await exists(forkBody.worktreePath),false,'the forced discard removed the worktree');
  assert.deepEqual((await (await read(forks)).json()).forks,[],'a discarded fork is not listed any more');
  assert.equal(await readFile(sentinel,'utf8'),'parent only\n','the parent working tree is untouched by every step');
  assert.equal((await post(forks+'/'+forkBody.childSessionId+'/discard',{revision:4})).status,200,'discarding a discarded fork is a legal no-op that touches nothing');
  // The registry offers the fork actions on this instance, and the same capability works through it.
  const offered=await (await read('/api/actions?projectId='+project.id+'&sessionId='+parent.id)).json();
  assert.deepEqual(offered.actions.map((action:any)=>action.id).filter((id:string)=>id.startsWith('fork.')).sort(),['fork.create','fork.discard','fork.list','fork.resume']);
  const viaRegistry=await post('/api/actions/execute',{id:'fork.create',params:{baseCommit,cutoffEntryId:cutoff},scope:{projectId:project.id,sessionId:parent.id}});
  assert.equal(viaRegistry.status,200,'the same capability is reachable through the registry the palette writes with');
  assert.equal((await viaRegistry.json()).action,'fork.create');
  assert.equal((await post(forks,{parentSessionId:parent.id,baseCommit,cutoffEntryId:0})).status,422,'a cutoff of zero is not an entry of any transcript');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});


/**
 * The agent registry routes and the bounded file-edit routes: owner-only, behind the unchanged Host
 * check, with the same origin/CSRF enforcement for writes, and with every refusal the server's own
 * words rather than a generic failure. Nothing here calls a model and nothing spends anything.
 */
test('the agent registry routes are owner-only, strict, governance-checked, and record who changed what',async()=>{
 const security=localConfig('http://127.0.0.1:0');
 const root=await mkdtemp(join(tmpdir(),'dashboard-agents-api-'));
 const store=new ControlStore(root);
 const app=await createApp({dataRoot:root,browseRoots:[],security,control:store});
 await listen(app,security);
 try{
  const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
  const post=async(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:writes,body:JSON.stringify(body)});
  const read=async(path:string)=>fetch(url+path,{headers:token});
  // Owner-only, with the unchanged Host check and the same origin enforcement for writes.
  assert.equal((await fetch(url+'/api/agents')).status,401,'the registry is behind owner auth');
  assert.equal((await fetch(url+'/api/agents',{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403);
  const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:'/api/agents',headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
  assert.equal(wrongHost,403,'the unchanged Host check applies to the registry');
  // The closed vocabulary is served with one description per scope, and the file-edit switch with the
  // mode the acceptance policy puts in force. The capability is disabled by default.
  const listed=await (await read('/api/agents')).json();
  assert.deepEqual(listed.scopes.map((entry:any)=>entry.scope),[...AGENT_SCOPES]);
  for(const entry of listed.scopes)assert.ok(entry.description.length>10,entry.scope+' carries a description');
  assert.deepEqual(listed.fileEdit,{enabled:false,mode:null},'the bounded file-edit capability is disabled by default');
  assert.deepEqual(listed.agents,[]);
  // The models this instance really offers are served beside the vocabulary, so the interface offers
  // exactly the list the server would accept rather than a second, drifting one.
  assert.ok(Array.isArray(listed.models));
  for(const model of listed.models)assert.equal(typeof model.provider,'string');

  const project=await (await post('/api/projects',{name:'Agents API',managed:true,confirm:true})).json();
  const offered=app.agents.offeredModels()[0];
  const draft=(over:Record<string,unknown>={})=>({name:'API worker',description:'',enabled:true,model:{provider:offered.provider,modelId:offered.modelId},workspace:{projectId:project.id,subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:['read_notes'],...over});
  const actor={kind:'owner',identity:'local'};
  const created=await post('/api/agents',{draft:draft(),actor});
  assert.equal(created.status,201);
  const agent=(await created.json()).agent;
  assert.deepEqual([agent.revision,agent.enabled,[...agent.scopes]],[1,true,['read_notes']]);
  const one=await (await read('/api/agents/'+agent.id)).json();
  assert.deepEqual([one.agent.id,one.history.map((entry:any)=>entry.action)],[agent.id,['created']]);
  // Each refusal is the server's own per-field words, not a generic failure.
  const badScope=await post('/api/agents',{draft:draft({name:'Other',scopes:['sudo']}),actor});
  assert.equal(badScope.status,422);
  assert.match((await badScope.json()).error,/a scope must be one of the closed vocabulary/);
  const badModel=await post('/api/agents',{draft:draft({name:'Other',model:{provider:'scripted',modelId:'nope'}}),actor});
  assert.equal(badModel.status,422);
  assert.match((await badModel.json()).error,/not one this instance offers/);
  const badSubpath=await post('/api/agents',{draft:draft({name:'Other',workspace:{projectId:project.id,subpath:'../escape'}}),actor});
  assert.equal(badSubpath.status,422);
  assert.match((await badSubpath.json()).error,/a subpath must be a relative path with no empty, current or parent segment/);
  const duplicate=await post('/api/agents',{draft:draft(),actor});
  assert.equal(duplicate.status,409);
  assert.match((await duplicate.json()).error,/already named API worker/);
  assert.equal((await (await read('/api/agents')).json()).agents.length,1,'every refused creation wrote nothing');
  // A change is revision-checked, and the audit trail names who changed what and when.
  const stale=await post('/api/agents/'+agent.id+'/update',{revision:99,patch:{name:'Renamed'},actor});
  assert.equal(stale.status,409);
  assert.match((await stale.json()).error,/is at revision 1, not 99/);
  const changed=await post('/api/agents/'+agent.id+'/update',{revision:agent.revision,patch:{name:'Renamed',enabled:false},actor:{kind:'owner',identity:'second'}});
  assert.equal(changed.status,200);
  const renamed=(await changed.json()).agent;
  assert.deepEqual([renamed.revision,renamed.name,renamed.enabled,renamed.updatedBy.identity],[2,'Renamed',false,'second']);
  // Governance: an agent may not edit its own record, and the refusal is the rule's own.
  const selfEdit=await post('/api/agents/'+agent.id+'/update',{revision:renamed.revision,patch:{scopes:['read_notes','file_edit']},actor:{kind:'agent',identity:agent.id}});
  assert.equal(selfEdit.status,403);
  assert.match((await selfEdit.json()).error,/may not edit its own record/);
  const wider=await post('/api/agents',{draft:draft({name:'Wider'}),actor:{kind:'agent',identity:agent.id}});
  assert.equal(wider.status,403);
  assert.match((await wider.json()).error,/may not create another agent/);
  // Archiving closes it, and the audit trail is durable and complete.
  const archived=await post('/api/agents/'+agent.id+'/archive',{revision:renamed.revision,actor});
  assert.equal(archived.status,200);
  assert.equal((await archived.json()).agent.archived,true);
  const history=await (await read('/api/agents/'+agent.id)).json();
  assert.deepEqual(history.history.map((entry:any)=>[entry.revision,entry.action,entry.changedBy.identity]),[[1,'created','local'],[2,'updated','second'],[3,'archived','local']]);
  for(const entry of history.history)assert.ok(Number.isFinite(Date.parse(entry.changedAt)),'every audit entry carries an instant');
  // An unknown agent, and an unknown route under the registry prefix, are both refused as not found.
  assert.equal((await read('/api/agents/'+randomUUID())).status,404);
  assert.equal((await read('/api/agents/'+randomUUID()+'/nonsense')).status,404);
  assert.equal((await post('/api/agents/'+randomUUID()+'/archive',{revision:1,actor})).status,404);
  // The typed actions reach the same registry, and the same record.
  const viaAction=await (await post('/api/actions/execute',{id:'agent.list',params:{}})).json();
  assert.equal(viaAction.result.agents.length,1);
  assert.equal(viaAction.result.fileEdit.enabled,false);
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('the file-edit routes are owner-only, disabled by default, and contained to the connected worktree when enabled',async()=>{
 const security=localConfig('http://127.0.0.1:0');
 const root=await mkdtemp(join(tmpdir(),'dashboard-file-edit-api-'));
 const store=new ControlStore(root);
 const app=await createApp({dataRoot:root,browseRoots:[],security,control:store,fileEdit:{enabled:true}});
 await listen(app,security);
 try{
  const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
  const post=async(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers:writes,body:JSON.stringify(body)});
  const read=async(path:string)=>fetch(url+path,{headers:token});
  const project=await (await post('/api/projects',{name:'Edits',managed:true,confirm:true})).json();
  const base='/api/projects/'+project.id+'/file-edits';
  const actor={kind:'owner',identity:'local'};
  assert.equal((await fetch(url+base)).status,401,'the file-edit routes are behind owner auth');
  assert.equal((await fetch(url+base,{method:'POST',headers:{...token,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await read('/api/projects/'+randomUUID()+'/file-edits')).status,404,'an unknown project is refused before anything is read');
  // The mode in force is read from the acceptance policy, whose documented default is owner-only, so
  // the default mode is propose-only rather than an assumption.
  const before=await (await read(base)).json();
  assert.deepEqual([before.enabled,before.mode,before.edits.length],[true,'propose-only',0]);
  // A propose-only write records the change and its diff and writes no file at all.
  const proposed=await post(base,{request:{agentId:null,path:'src/probe.ts',content:'export const one = 1;\n'},actor});
  assert.equal(proposed.status,201);
  const proposal=await proposed.json();
  assert.deepEqual([proposal.written,proposal.edit.applied,proposal.edit.path],[false,false,'src/probe.ts']);
  assert.match(proposal.edit.diff,/\+export const one = 1;/);
  assert.equal(await exists(join(project.path,'src','probe.ts')),false,'a propose-only write wrote no file');
  // A traversal, an absolute path, a symlink escape and an oversize change are each refused with
  // nothing written, and each refusal is precise.
  for(const path of ['../outside.txt','/etc/passwd','src/../../outside.txt','node_modules/thing.js']){
    const refused=await post(base,{request:{agentId:null,path,content:'x'},actor});
    assert.equal(refused.status,403,path);
    assert.match((await refused.json()).error,/refused|generated or app-managed/);
  }
  await symlink(join(root,'outside'),join(project.path,'escape'));
  const throughSymlink=await post(base,{request:{agentId:null,path:'escape/secret.txt',content:'x'},actor});
  assert.equal(throughSymlink.status,403);
  assert.equal(await exists(join(root,'outside','secret.txt')),false,'nothing was written through the symlink');
  const oversize=await post(base,{request:{agentId:null,path:'src/big.ts',content:'x'.repeat(FILE_EDIT_MAX_FILE_BYTES+1)},actor});
  assert.equal(oversize.status,413);
  assert.match((await oversize.json()).error,/over the 262144-byte cap/);
  // Auto-apply is refused while the acceptance policy in force is propose-only.
  const auto=await post(base,{request:{agentId:null,path:'src/probe.ts',content:'export const two = 2;\n',mode:'auto-apply'},actor});
  assert.equal(auto.status,403);
  assert.match((await auto.json()).error,/Auto-apply is not the mode in force/);
  assert.equal((await (await read(base)).json()).edits.length,1,'every refused write recorded nothing');
  // The owner switch is the acceptance policy: with it set to agent-may-accept, auto-apply is permitted
  // and the file is really written atomically.
  const policy=await (await read('/api/acceptance/policy')).json();
  const updated=await post('/api/acceptance/policy',{revision:policy.policy.revision,policy:{mode:'agent-may-accept',actionClasses:{commit:'full-auto',push:'ask',deploy:'ask',spend:'ask',provision:'ask',publish:'ask'}}});
  assert.equal(updated.status,200);
  const applied=await post(base,{request:{agentId:null,path:'src/probe.ts',content:'export const two = 2;\n',mode:'auto-apply'},actor});
  assert.equal(applied.status,201);
  assert.equal((await applied.json()).written,true);
  assert.equal(await readFile(join(project.path,'src','probe.ts'),'utf8'),'export const two = 2;\n');
  // The read side reports both records with their diffs, and the mode now in force.
  const after=await (await read(base)).json();
  assert.deepEqual([after.mode,after.edits.length],[ 'auto-apply',2]);
  assert.equal(after.edits[1].applied,true);
  // The typed actions reach the same capability and the same ledger.
  const viaAction=await (await post('/api/actions/execute',{id:'file-edit.read',params:{},scope:{projectId:project.id}})).json();
  assert.deepEqual([viaAction.result.mode,viaAction.result.edits.length],['auto-apply',2]);
  const viaWrite=await post('/api/actions/execute',{id:'file-edit.write',params:{request:{agentId:null,path:'src/third.ts',content:'three\n'},actor},scope:{projectId:project.id}});
  assert.equal(viaWrite.status,200);
  // The action reads the same mode in force, which the owner switch has now set to auto-apply.
  assert.equal((await viaWrite.json()).result.written,true);
  assert.equal(await readFile(join(project.path,'src','third.ts'),'utf8'),'three\n');
 }finally{await app.close();store.close();await rm(root,{recursive:true,force:true});}

 // An instance without the capability refuses with a named reason, and its actions are absent from the
 // offered registry rather than listed and failing.
 const offRoot=await mkdtemp(join(tmpdir(),'dashboard-file-edit-off-'));
 const offStore=new ControlStore(offRoot);
 const offSecurity=localConfig('http://127.0.0.1:0');
 const off=await createApp({dataRoot:offRoot,browseRoots:[],security:offSecurity,control:offStore});
 await listen(off,offSecurity);
 try{
  const offToken={'x-dashboard-token':offSecurity.token};
  const offWrites={...offToken,'content-type':'application/json',origin:offSecurity.origin};
  const offProject=await (await fetch(offSecurity.origin+'/api/projects',{method:'POST',headers:offWrites,body:JSON.stringify({name:'No edits',managed:true,confirm:true})})).json();
  const refusal=await fetch(offSecurity.origin+'/api/projects/'+offProject.id+'/file-edits',{headers:offToken});
  assert.equal(refusal.status,503);
  assert.match((await refusal.json()).error,/file-edit capability is disabled on this instance/);
  const actions=await (await fetch(offSecurity.origin+'/api/actions?projectId='+offProject.id,{headers:offToken})).json();
  assert.deepEqual(actions.actions.filter((action:any)=>action.id.startsWith('file-edit.')),[],'a disabled capability offers no file-edit action');
  const asking=await fetch(offSecurity.origin+'/api/actions/execute',{method:'POST',headers:offWrites,body:JSON.stringify({id:'file-edit.read',params:{},scope:{projectId:offProject.id}})});
  assert.equal(asking.status,503);
  assert.match((await asking.json()).error,/file-edit capability is disabled on this instance/);
 }finally{await off.close();offStore.close();await rm(offRoot,{recursive:true,force:true});}
});
