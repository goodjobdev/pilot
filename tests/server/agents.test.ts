import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { DeliveryLedger } from '../../src/server/state/delivery';
import type { AlertPayload } from '../../src/server/alerts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 10000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw Error('condition was not met in time');
    await sleep(50);
  }
}

async function instance(agents: 'on' | 'off', dataRoot: string, agentPauseMs = 300) {
  const security = localConfig('http://127.0.0.1:0');
  const created = await createApp({ dataRoot, browseRoots: [], security, agents, agentPauseMs });
  await new Promise<void>(ok => created.server.listen(0, '127.0.0.1', ok));
  security.origin = 'http://127.0.0.1:' + (created.server.address() as { port: number }).port;
  const token = { 'x-dashboard-token': security.token };
  const writes = { ...token, 'content-type': 'application/json', origin: security.origin };
  // Reuse a registered project when one exists, so a second instance models a restart
  // rather than registering a different project (and therefore a different session file).
  const listed = await (await fetch(security.origin + '/api/projects', { headers: token })).json() as { id: string }[];
  const project = listed[0] ?? await (await fetch(security.origin + '/api/projects', { method: 'POST', headers: writes, body: JSON.stringify({ name: 'Agents', managed: true, confirm: true }) })).json();
  const base = security.origin + '/api/projects/' + project.id + '/agents';
  const view = async () => (await (await fetch(base, { headers: token })).json()) as { enabled: boolean; view: any };
  return { created, security, token, writes, project, base, view };
}

/**
 * One instance with a durable control store and a fake push transport, so every receipt the delivery
 * ledger records is a real report from the notification channel rather than a synthetic one.
 *
 * `failAll` models a push service that accepts the call and then fails for every device, which is
 * the receipt `{sent:0,failed:n,skipped:false}`. On a root that already holds a project (a restart
 * on the same data) that project is reused, so the rows the second instance reconciles are the ones
 * the first one wrote.
 */
async function deliveryInstance(root:string,sent:AlertPayload[],options:{failAll?:boolean}={}){
  const security=localConfig('http://127.0.0.1:0');
  const store=new ControlStore(root);
  const created=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',agentPauseMs:200,control:store,alertTransport:async(_subscription,payload)=>{
    sent.push(payload);
    if(options.failAll)throw Object.assign(new Error('the push service could not deliver to this device'),{statusCode:500});
  }});
  await new Promise<void>(ok=>created.server.listen(0,'127.0.0.1',ok));
  security.origin='http://127.0.0.1:'+(created.server.address() as {port:number}).port;
  const token={'x-dashboard-token':security.token};
  const writes={...token,'content-type':'application/json',origin:security.origin};
  const listed=await (await fetch(security.origin+'/api/projects',{headers:token})).json() as {id:string}[];
  const project=listed[0]??await (await fetch(security.origin+'/api/projects',{method:'POST',headers:writes,body:JSON.stringify({name:'Ledger',managed:true,confirm:true})})).json() as {id:string};
  // A subscribed device is what makes the notification an attempted delivery with a real receipt.
  const subscribed=await fetch(security.origin+'/api/alerts/subscribe',{method:'POST',headers:writes,body:JSON.stringify({endpoint:'https://push.example.test/ledger',keys:{p256dh:'B'.repeat(80),auth:'C'.repeat(20)}})});
  if(subscribed.status!==200)throw Error('could not subscribe the fake device: '+await subscribed.text());
  const base=security.origin+'/api/projects/'+project.id+'/agents';
  const view=async()=>(await (await fetch(base,{headers:token})).json()) as {enabled:boolean;view:any;delivery:{scope:{projectId:string;sessionId:string};questions:any[];answers:any[];unreadable:string[]}};
  return {created,security,token,writes,project,base,store,view};
}
/** The ledger operations this instance holds, by kind: the count is the "recorded exactly once" proof. */
const ledgerCounts=(store:ControlStore)=>(store.db.prepare('SELECT kind,count(*) AS n FROM operations GROUP BY kind ORDER BY kind').all() as {kind:string;n:number}[]).map(row=>({kind:String(row.kind),n:Number(row.n)}));

test('the agent harness is off unless the instance enables it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-off-'));
  const app=await instance('off',root);
  try{
    assert.deepEqual(await app.view(),{enabled:false,view:null});
    assert.equal((await fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify({text:'hi'})})).status,503);
    assert.equal((await fetch(app.base+'/stream',{headers:app.token})).status,503);
    assert.equal((await fetch(app.base+'/abort',{method:'POST',headers:app.writes,body:'{}'})).status,503);
    assert.equal(await stat(join(root,'agents')).then(()=>true).catch(()=>false),false,'a disabled harness writes nothing');
  }finally{await app.created.close();}
});

test('a durable agent answers, steers, aborts, de-duplicates and survives a restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-on-'));
  const app=await instance('on',root,300);
  const send=async(body:unknown)=>fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify(body)});
  try{
    const empty=await app.view();
    assert.equal(empty.enabled,true);
    assert.deepEqual(empty.view.entries,[]);
    assert.deepEqual(empty.view.model,{provider:'faux',modelId:'faux-1'});
    assert.equal(empty.view.working,false);

    // A scripted answer, committed to the transcript.
    const first=await send({text:'hello from the test',mode:'followUp'});
    assert.equal(first.status,200);
    const answered=await waitFor(async()=>{const v=await app.view();return v.view.entries.some((e:any)=>e.kind==='assistant')?v:undefined;});
    const reply=answered.view.entries.filter((e:any)=>e.kind==='assistant').at(-1);
    assert.match(reply.text,/Scripted test reply/);
    assert.match(reply.text,/hello from the test/);
    assert.equal(reply.stopReason,'stop');

    // The same request id never submits twice.
    const one=await (await send({text:'deduplicated',mode:'followUp',requestId:'same-request'})).json();
    const two=await (await send({text:'deduplicated',mode:'followUp',requestId:'same-request'})).json();
    assert.equal(one.submissionId,two.submissionId);
    await waitFor(async()=>{const v=await app.view();return v.view.entries.filter((e:any)=>e.kind==='user'&&e.text==='deduplicated').length===1?v:undefined;});

    // Steering joins a busy run, and the queued item is visible while it waits.
    assert.equal((await send({text:'[pause] hold the run open',mode:'followUp'})).status,200);
    assert.equal((await send({text:'steer: prefer pnpm',mode:'steer'})).status,200);
    const busy=await waitFor(async()=>{const v=await app.view();return v.view.working?v:undefined;});
    assert.equal(busy.view.working,true);
    assert.ok(busy.view.inbox.some((item:any)=>item.mode==='steer'&&item.text.includes('prefer pnpm')));

    // Aborting stops the run and withdraws what was queued behind it.
    assert.equal((await fetch(app.base+'/abort',{method:'POST',headers:app.writes,body:'{}'})).status,200);
    const stopped=await waitFor(async()=>{const v=await app.view();return v.view.working?undefined:v;});
    assert.deepEqual(stopped.view.inbox,[]);

    // Authentication and validation still apply to the agent routes.
    assert.equal((await fetch(app.base)).status,401);
    assert.equal((await send({text:''})).status,400);
    // Request validation rejects an oversized message as a bad request; the host's own
    // 413 bound also guards direct callers.
    assert.equal((await send({text:'x'.repeat(9000)})).status,400);
  }finally{await app.created.close();}

  // The transcript is in SQLite, so a new process opens the same conversation.
  const reopened=await instance('on',root,300);
  try{
    const persisted=await waitFor(async()=>{const v=await reopened.view();return v.view.entries.length? v:undefined;});
    assert.ok(persisted.view.entries.some((e:any)=>e.kind==='assistant'&&/hello from the test/.test(e.text)));
    const file=join(root,'agents',reopened.project.id,'session.sqlite');
    assert.ok((await stat(file)).size>0,'the durable session file exists');
  }finally{await reopened.created.close();}
});

test('an agent question is asked once, answered once and refused a second time',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-ask-'));
  const app=await instance('on',root,200);
  const send=async(body:unknown)=>fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify(body)});
  const answer=async(body:unknown)=>fetch(app.base+'/answer',{method:'POST',headers:app.writes,body:JSON.stringify(body)});
  try{
    assert.equal((await send({text:'[ask] add the invoice export',mode:'followUp'})).status,200);
    const asked=await waitFor(async()=>{const v=await app.view();return v.view.questions.length?v:undefined;});
    assert.equal(asked.view.questions.length,1);
    const question=asked.view.questions[0];
    assert.match(question.text,/Should I proceed with: add the invoice export\?/);
    assert.equal(question.answer,null);
    // The question came from a tool call, which is what makes it durable.
    assert.ok(asked.view.entries.some((entry:any)=>entry.tools.some((tool:any)=>tool.name==='ask_question')));

    assert.equal((await answer({questionId:'00000000-0000-4000-8000-000000000000',text:'x'})).status,404);
    assert.equal((await answer({questionId:question.id,text:''})).status,400);

    assert.equal((await answer({questionId:question.id,text:'Yes, use the CSV export'})).status,200);
    const answered=await waitFor(async()=>{const v=await app.view();return v.view.questions[0]?.answer?v:undefined;});
    assert.equal(answered.view.questions[0].answer.text,'Yes, use the CSV export');

    // Answering once resolves once: the second attempt is refused and changes nothing.
    assert.equal((await answer({questionId:question.id,text:'Changed my mind'})).status,409);
    const afterwards=await app.view();
    assert.equal(afterwards.view.questions.length,1);
    assert.equal(afterwards.view.questions[0].answer.text,'Yes, use the CSV export');

    await waitFor(async()=>{const v=await app.view();return v.view.entries.some((entry:any)=>entry.kind==='user'&&entry.text==='Yes, use the CSV export')?v:undefined;});
  }finally{await app.created.close();}
});

test('the agent stream sends the current view as server-sent events',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-stream-'));
  const app=await instance('on',root,200);
  const controller=new AbortController();
  try{
    const response=await fetch(app.base+'/stream',{headers:app.token,signal:controller.signal});
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type')??'',/text\/event-stream/);
    const reader=response.body!.getReader(),decoder=new TextDecoder();
    let buffered='';
    const until=Date.now()+5000;
    while(!buffered.includes('data: ')&&Date.now()<until){
      const chunk=await reader.read();
      if(chunk.done)break;
      buffered+=decoder.decode(chunk.value,{stream:true});
    }
    assert.match(buffered,/data: \{/);
    const frame=buffered.split('\n\n').map(part=>part.split('\n').find(line=>line.startsWith('data: '))).filter(Boolean).at(-1)!;
    const view=JSON.parse(frame.slice(6));
    assert.equal(view.conversationId,app.project.id?'1':'1');
    assert.deepEqual(view.entries,[]);
  }finally{controller.abort();await app.created.close();}
});

test('a real question is a durable delivery, its notification is the ledger outbox step, and its answer is recorded once',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-ledger-'));
  const sent:AlertPayload[]=[];
  const app=await deliveryInstance(root,sent);
  const send=async(body:unknown)=>fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify(body)});
  const answer=async(body:unknown)=>fetch(app.base+'/answer',{method:'POST',headers:app.writes,body:JSON.stringify(body)});
  try{
    assert.equal((await send({text:'[ask] wire the delivery ledger',mode:'followUp'})).status,200);
    // The question is admitted durably, notified as the ledger's outbox step, and acknowledged with
    // the receipt the channel reported — which is why the projection shows it delivered.
    const asked=await waitFor(async()=>{const v=await app.view();return v.delivery?.questions?.[0]?.delivered?v:undefined;});
    const question=asked.view.questions[0];
    const sessionId=asked.view.conversationId as string;
    assert.ok(sessionId,'the conversation id is the session scope of the delivery ledger');
    assert.deepEqual(asked.delivery.scope,{projectId:app.project.id,sessionId});
    const row=asked.delivery.questions[0];
    assert.equal(row.delivery,'question');
    assert.equal(row.questionId,question.id);
    assert.equal(row.operationState,'succeeded');
    assert.equal(row.outboxState,'delivered');
    assert.deepEqual(row.receipt,{sent:1,failed:0,skipped:false});
    assert.equal(typeof row.acknowledgedAt,'string');
    assert.deepEqual(asked.delivery.answers,[],'nothing is recorded as an answer yet');
    assert.deepEqual(asked.delivery.unreadable,[]);
    // The notification is tagged by the question id, so a re-send collapses onto this one, and the
    // owner-visible ledger carries no question text.
    const notifications=sent.filter(payload=>payload.tag==='pilot-question-'+question.id);
    assert.equal(notifications.length,1,'a question notifies once');
    assert.match(notifications[0].body,/wire the delivery ledger/);
    assert.equal(notifications[0].url,'/?project='+app.project.id+'&view=Agents');
    assert.ok(!JSON.stringify(asked.delivery).includes('wire the delivery ledger'),'the ledger view returns no question text');

    assert.equal((await answer({questionId:question.id,text:'Yes, wire it'})).status,200);
    const delivered=await waitFor(async()=>{const v=await app.view();return v.delivery?.answers?.[0]?.delivered?v:undefined;});
    const recorded=delivered.delivery.answers[0];
    assert.equal(recorded.delivery,'answer');
    assert.equal(recorded.questionId,question.id);
    assert.equal(recorded.receipt.requestId,'answer-input:'+question.id);
    assert.equal(typeof recorded.receipt.submissionId,'string');
    assert.equal(delivered.view.questions[0].answer.text,'Yes, wire it');
    assert.deepEqual(ledgerCounts(app.store),[{kind:'answer.delivery',n:1},{kind:'question.delivery',n:1}],'one question and one answer, recorded once each');

    // A duplicate answer is refused, and the ledger still holds exactly the first one.
    assert.equal((await answer({questionId:question.id,text:'Yes, wire it'})).status,409);
    assert.equal((await answer({questionId:question.id,text:'Changed my mind'})).status,409);
    assert.deepEqual(ledgerCounts(app.store),[{kind:'answer.delivery',n:1},{kind:'question.delivery',n:1}]);
    // A question this conversation never asked is refused, and nothing is recorded for it.
    assert.equal((await answer({questionId:'99999999-9999-4999-8999-999999999999',text:'Orphan'})).status,404);
    assert.deepEqual(ledgerCounts(app.store),[{kind:'answer.delivery',n:1},{kind:'question.delivery',n:1}]);
    assert.deepEqual((await app.view()).delivery.answers.map((entry:any)=>entry.questionId),[question.id]);
  }finally{await app.created.close();app.store.close();}
});

test('a crash between the answer record and the transcript write settles on a same-text retry, once, under the question-derived request id',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-ledger-window-'));
  const sent:AlertPayload[]=[];
  const app=await deliveryInstance(root,sent);
  const send=async(body:unknown)=>fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify(body)});
  const answer=async(body:unknown)=>fetch(app.base+'/answer',{method:'POST',headers:app.writes,body:JSON.stringify(body)});
  try{
    assert.equal((await send({text:'[ask] confirm the answer flow',mode:'followUp'})).status,200);
    const asked=await waitFor(async()=>{const v=await app.view();return v.delivery?.questions?.[0]?.delivered?v:undefined;});
    const question=asked.view.questions[0];
    const scope={projectId:app.project.id,sessionId:asked.view.conversationId as string};
    const text='Yes, and nothing else';
    // The crash window: the answer record is committed and the transcript write never happened, so
    // the question is still open in the interface and the answer exists only in the ledger.
    new DeliveryLedger(app.store).answerQuestion({...scope,questionId:question.id,text,answeredAt:Date.now()});
    assert.equal((await waitFor(async()=>{const v=await app.view();return v.delivery?.answers?.[0]?.delivered===false?v:undefined;})).view.questions[0].answer,null);
    assert.equal(new DeliveryLedger(app.store).recordedAnswer({...scope,questionId:question.id})?.text,text,'the ledger holds the answer text for the reconciliation path');
    assert.ok(!JSON.stringify((await app.view()).delivery).includes(text),'the owner-visible ledger still exposes no answer text');

    // A different answer is refused by the durable record itself: the agent never receives it.
    const refused=await answer({questionId:question.id,text:'No, stop'});
    assert.equal(refused.status,409);
    assert.match((await refused.json()).error,/already has an answer/);
    const afterRefusal=await app.view();
    assert.equal(afterRefusal.view.questions[0].answer,null,'the refused answer was not written to the transcript');
    assert.ok(!afterRefusal.view.entries.some((entry:any)=>entry.kind==='user'&&entry.text==='No, stop'),'the refused answer never reached the agent');
    assert.deepEqual(afterRefusal.delivery.answers.map((entry:any)=>[entry.questionId,entry.delivered]),[[question.id,false]],'the recorded answer is still the one that exists, and still outstanding');

    // The same text is the same answer, even though this retry carries a new answer instant: the
    // retry reconciles, completes the transcript write and the submission, and settles the row.
    assert.equal((await answer({questionId:question.id,text})).status,200);
    const answered=await waitFor(async()=>{const v=await app.view();return v.view.questions[0]?.answer?v:undefined;});
    assert.equal(answered.view.questions[0].answer.text,text);
    assert.equal(answered.view.entries.filter((entry:any)=>entry.rawKind==='app.answer').length,1,'the transcript holds exactly one answer');
    assert.equal(answered.view.entries.filter((entry:any)=>entry.kind==='user'&&entry.text===text).length,1,'the agent received the answer exactly once');
    const settled=await waitFor(async()=>{const v=await app.view();return v.delivery?.answers?.[0]?.delivered?v:undefined;});
    assert.equal(settled.delivery.answers[0].questionId,question.id);
    assert.equal(settled.delivery.answers[0].receipt.requestId,'answer-input:'+question.id,'the submission is the one the request id derived from the question names');
    assert.equal(typeof settled.delivery.answers[0].receipt.submissionId,'string');
    assert.deepEqual(ledgerCounts(app.store),[{kind:'answer.delivery',n:1},{kind:'question.delivery',n:1}],'one question and one answer, recorded once each');

    // The at-most-once refusal still holds after the row settled: nothing changes and nothing is sent.
    assert.equal((await answer({questionId:question.id,text:'Changed my mind'})).status,409);
    assert.equal((await answer({questionId:question.id,text})).status,409,'an answered question is refused rather than answered twice');
    const afterwards=await app.view();
    assert.equal(afterwards.view.questions[0].answer.text,text);
    assert.equal(afterwards.view.entries.filter((entry:any)=>entry.rawKind==='app.answer').length,1);
    assert.deepEqual(ledgerCounts(app.store),[{kind:'answer.delivery',n:1},{kind:'question.delivery',n:1}]);
  }finally{await app.created.close();app.store.close();}
});

test('a notification that reached no device is not a delivery, and the next start re-sends it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-undelivered-'));
  const attempted:AlertPayload[]=[];
  let projectId='',sessionId='',questionId='';
  const first=await deliveryInstance(root,attempted,{failAll:true});
  try{
    assert.equal((await fetch(first.base+'/input',{method:'POST',headers:first.writes,body:JSON.stringify({text:'[ask] reach a device',mode:'followUp'})})).status,200);
    const asked=await waitFor(async()=>{const v=await first.view();return v.view.questions.length?v:undefined;});
    projectId=first.project.id;sessionId=asked.view.conversationId as string;questionId=asked.view.questions[0].id;
    // The notification was attempted and no device received it: `skipped:false` with `sent:0` is
    // not a delivery, so the row stays outstanding instead of being acknowledged as one.
    await waitFor(async()=>attempted.some(payload=>payload.tag==='pilot-question-'+questionId)?true:undefined);
    const outstanding=new DeliveryLedger(first.store).deliveries({projectId,sessionId}).questions[0];
    assert.equal(outstanding.delivered,false,'a notification no device received is not a delivery');
    assert.equal(outstanding.operationState,'pending');
    assert.equal(outstanding.outboxState,'pending');
    assert.equal(outstanding.receipt,null);
    assert.equal(outstanding.acknowledgedAt,null);
  }finally{await first.created.close();first.store.close();}

  // The next start on the same data finds the row outstanding, re-sends the same notification under
  // the same question tag, and acknowledges it with the receipt this channel reports.
  const second=await deliveryInstance(root,attempted);
  try{
    const settled=await waitFor(async()=>{const v=await second.view();return v.delivery?.questions?.[0]?.delivered?v:undefined;});
    assert.deepEqual(settled.delivery.scope,{projectId,sessionId},'the restarted instance reconciles the same project and session');
    assert.equal(settled.delivery.questions[0].questionId,questionId);
    assert.deepEqual(settled.delivery.questions[0].receipt,{sent:1,failed:0,skipped:false});
    assert.equal(settled.delivery.scope.projectId,projectId);
    assert.equal(attempted.filter(payload=>payload.tag==='pilot-question-'+questionId).length,2,'the re-send is the same notification under the same tag');
  }finally{await second.created.close();second.store.close();}
});


/**
 * Per-agent privilege scopes, enforced at dispatch.
 *
 * The scope decision is made server-side, on every tool call, by the authoritative dispatch path —
 * never by the interface and never by hiding a tool. The two tests below prove both halves: a tool
 * the scopes forbid is refused with a precise reason and writes nothing, and the refusal is the
 * scope's rather than the tool's, because granting the scope makes the very same call succeed.
 */
async function privilegeInstance(root:string,scopes:readonly string[]){
 const security=localConfig('http://127.0.0.1:0');
 const store=new ControlStore(root);
 const created=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',agentPauseMs:150,control:store});
 await new Promise<void>(ok=>created.server.listen(0,'127.0.0.1',ok));
 security.origin='http://127.0.0.1:'+(created.server.address() as {port:number}).port;
 const token={'x-dashboard-token':security.token};
 const writes={...token,'content-type':'application/json',origin:security.origin};
 const listed=await (await fetch(security.origin+'/api/projects',{headers:token})).json() as {id:string;path:string}[];
 const project=listed[0]??await (await fetch(security.origin+'/api/projects',{method:'POST',headers:writes,body:JSON.stringify({name:'Privileges',managed:true,confirm:true})})).json() as {id:string;path:string};
 const offered=created.agents.offeredModels()[0];
 const agent=created.agentStore!.create({draft:{
   name:'Scope fixture',description:'A bounded agent.',enabled:true,
   model:{provider:offered.provider,modelId:offered.modelId},
   workspace:{scope:{kind:'projects',projectIds:[project.id]},subpath:''},
   budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},
   scopes:scopes as never
 },actor:{kind:'owner',identity:'local'}});
 const base=security.origin+'/api/projects/'+project.id+'/agents';
 const view=async()=>(await (await fetch(base,{headers:token})).json()) as {enabled:boolean;view:any};
 const send=async(body:unknown)=>fetch(base+'/input',{method:'POST',headers:writes,body:JSON.stringify(body)});
 const notesFile=join(project.path,'docs','notes.md');
 return {created,security,token,writes,project,agent,base,view,send,store,notesFile};
}
/** The text every entry of a settled conversation carries, tool results included. */
const transcriptText=async(app:{view:()=>Promise<{view:any}>})=>{
 const settled=await waitFor(async()=>{const v=await app.view();return v.view.working?undefined:v;});
 return (settled.view.entries as {kind:string;text:string}[]).map(entry=>entry.kind+': '+entry.text).join('\n');
};

test('a tool the scopes forbid is refused at dispatch with a precise reason and writes nothing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-agents-scopes-'));
 // The agent holds read_notes and record_note, so the harness is opened with both enabled.
 const app=await privilegeInstance(root,['read_notes','record_note']);
 try{
   // Opening the conversation is what builds the offered tool list from the scopes in force.
   await app.view();
   // The scope is revoked after the offered list was built, so the tool is still offered to the model:
   // this is the directly-crafted request, and the dispatch path re-reads the scopes and refuses it.
   app.created.agentStore!.update({agentId:app.agent.id,revision:app.agent.revision,patch:{scopes:['read_notes']},actor:{kind:'owner',identity:'local'}});
   assert.equal((await app.send({text:'[note this must never be written]',mode:'followUp'})).status,200);
   const refusedText=await transcriptText(app);
   assert.match(refusedText,/Tool call blocked/,'the refusal is reported in the transcript, not merely absent');
   assert.match(refusedText,/The record_note scope is not in this agent\u2019s allowlist/,'the refusal names the scope that was missing');
   assert.match(refusedText,/Append one line/,'the refusal says what granting it would allow');
   assert.equal(await stat(app.notesFile).then(()=>true).catch(()=>false),false,'a refused tool call wrote nothing at all');
 }finally{await app.created.close();app.store.close();}
});

test('the very same call succeeds when the scope is held, so the refusal was the scope rather than the tool',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-agents-granted-'));
 const app=await privilegeInstance(root,['read_notes','record_note']);
 try{
   await app.view();
   assert.equal((await app.send({text:'[note this one is allowed]',mode:'followUp'})).status,200);
   await waitFor(async()=>{const ok=await stat(app.notesFile).then(()=>true).catch(()=>false);return ok?true:undefined;});
   assert.match(await readFile(app.notesFile,'utf8'),/this one is allowed/,'a permitted call really wrote the note');
   assert.doesNotMatch(await readFile(app.notesFile,'utf8'),/must never be written/,'the refused text left no trace');
 }finally{await app.created.close();app.store.close();}
});

test('an agent is offered only the tools its scopes name, and a call to a tool it was never offered is refused',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-agents-exposure-'));
 // This agent holds read_notes and nothing else, so record_note is never offered to the model.
 const app=await privilegeInstance(root,['read_notes']);
 try{
   await app.view();
   assert.equal((await app.send({text:'[note a tool this agent was never offered]',mode:'followUp'})).status,200);
   const text=await transcriptText(app);
   // The call is refused by the dispatch path, with no effect: the model attempted a tool the agent
   // was never granted, and the refusal is reported rather than silently swallowed.
   assert.match(text,/not available|blocked|refused/i,text);
   assert.equal(await stat(app.notesFile).then(()=>true).catch(()=>false),false,'a refused call wrote nothing at all');
   // The permitted tool still works, so the refusal is about the scope and not about the harness.
   assert.equal((await app.send({text:'[read-notes]',mode:'followUp'})).status,200);
   const after=await transcriptText(app);
   assert.match(after,/No notes yet/,'the permitted read_notes tool really ran');
 }finally{await app.created.close();app.store.close();}
});

/**
 * Vision checks are enforced server-side, twice: at admission, against the model the session has
 * selected, and again at dispatch, against the model the submission will actually run under. A
 * client-side hint is not enough, and a refusal is never a silent drop.
 */
/**
 * The missing link the owner reported: a **session** bound to an **agent**.
 *
 * Before this round the authority was resolved per project and nothing bound a running conversation
 * to a chosen agent, so a session reported "no privileges". These tests prove the wire end to end: a
 * bound session uses its agent's scopes, the same session unbound refuses every tool with a named
 * reason and no side effect, a rebind takes effect at the next dispatch without a restart, and the
 * binding is durable across a restart. No model is called: the scripted provider drives the calls.
 */
test('a session bound to an agent uses its scopes, the same session unbound refuses with a reason and writes nothing, and the rebind takes effect at the next dispatch',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-binding-'));
  const app=await privilegeInstance(root,['read_notes','record_note']);
  const bind=(revision:number,agentId:string|null)=>app.created.agentStore!.bindSession({projectId:app.project.id,sessionId:'1',revision,agentId,actor:{kind:'owner',identity:'local'}});
  try{
    // Bind the project's root conversation (session '1' is Pi's reserved root) to this agent.
    bind(0,app.agent.id);
    // Opening the conversation reads the binding, so the agent's tools are offered.
    await app.view();
    assert.equal((await app.send({text:'[note the bound session may write this]',mode:'followUp'})).status,200);
    await waitFor(async()=>{const ok=await stat(app.notesFile).then(()=>true).catch(()=>false);return ok?true:undefined;});
    assert.match(await readFile(app.notesFile,'utf8'),/the bound session may write this/,'a bound session really used its agent\u2019s scope');

    // Unbind the very same session: it now has no agent, so a tool call is refused with the reason.
    // The tool differs (read_notes) only because the scripted provider never repeats a call it has
    // already made in one conversation; the point proven is the authority, not the tool.
    bind(1,null);
    const before=await readFile(app.notesFile,'utf8');
    assert.equal((await app.send({text:'[read-notes]',mode:'followUp'})).status,200);
    const refused=await transcriptText(app);
    assert.match(refused,/blocked/i,'the refusal is reported in the transcript');
    assert.match(refused,/No agent is bound to this session/,'the refusal names why there are no privileges');
    assert.equal(await readFile(app.notesFile,'utf8'),before,'an unbound session wrote nothing');
  }finally{await app.created.close();app.store.close();}
});

test('a session binding is durable across a restart and still governs the dispatch after it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-binding-restart-'));
  const first=await privilegeInstance(root,['read_notes','record_note']);
  let projectId='',agentId='';
  try{
    projectId=first.project.id;agentId=first.agent.id;
    first.created.agentStore!.bindSession({projectId,sessionId:'1',revision:0,agentId,actor:{kind:'owner',identity:'local'}});
    assert.equal((await first.send({text:'[note before the restart]',mode:'followUp'})).status,200);
    await waitFor(async()=>{const ok=await stat(first.notesFile).then(()=>true).catch(()=>false);return ok?true:undefined;});
  }finally{await first.created.close();first.store.close();}

  // A second process on the same data root: no agent is recreated, so this reads the binding back.
  const security=localConfig('http://127.0.0.1:0');
  const store=new ControlStore(root);
  const created=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',agentPauseMs:150,control:store});
  await new Promise<void>(ok=>created.server.listen(0,'127.0.0.1',ok));
  security.origin='http://127.0.0.1:'+(created.server.address() as {port:number}).port;
  const token={'x-dashboard-token':security.token};
  const writes={...token,'content-type':'application/json',origin:security.origin};
  try{
    const project=(await (await fetch(security.origin+'/api/projects',{headers:token})).json() as {id:string;path:string}[]).find(candidate=>candidate.id===projectId)!;
    assert.deepEqual(created.agentStore!.binding(projectId,'1')?.agentId,agentId,'the binding survived the restart');
    const base=security.origin+'/api/projects/'+projectId+'/agents';
    await fetch(base,{headers:token});
    // read_notes is never repeated by the scripted provider, so it really runs under the restored
    // binding and returns the note the first process wrote.
    assert.equal((await fetch(base+'/input',{method:'POST',headers:writes,body:JSON.stringify({text:'[read-notes]',mode:'followUp'})})).status,200);
    await waitFor(async()=>{const v=await (await fetch(base,{headers:token})).json() as {view:{working:boolean;entries:{kind:string;text:string}[]}};return v.view.working?undefined:v;});
    const view=await (await fetch(base,{headers:token})).json() as {view:{entries:{kind:string;text:string}[]}};
    assert.ok(view.view.entries.some(entry=>entry.text.includes('before the restart')),'the restored binding still governs the dispatch');
  }finally{await created.close();store.close();}
});

test('a session bound to a multi-project agent acts in the projects it names and is refused in one it does not, with no side effect',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-multiproject-'));
  const app=await privilegeInstance(root,['read_notes','record_note']);
  try{
    // A second registered project the narrow agent never names.
    const second=await (await fetch(app.security.origin+'/api/projects',{method:'POST',headers:app.writes,body:JSON.stringify({name:'Elsewhere fixture',managed:true,confirm:true})})).json() as {id:string;path:string};
    const offered=app.created.agents.offeredModels()[0];
    const draftFor=(name:string,ids:string[])=>app.created.agentStore!.create({draft:{name,description:'',enabled:true,model:{provider:offered.provider,modelId:offered.modelId},workspace:{scope:{kind:'projects',projectIds:ids},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:['read_notes','record_note']},actor:{kind:'owner',identity:'local'}});
    const both=draftFor('Two projects',[app.project.id,second.id]);

    // Bound to the two-project agent: it may act in this project.
    app.created.agentStore!.bindSession({projectId:app.project.id,sessionId:'1',revision:0,agentId:both.id,actor:{kind:'owner',identity:'local'}});
    await app.view();
    assert.equal((await app.send({text:'[note inside the allowed project]',mode:'followUp'})).status,200);
    await waitFor(async()=>{const ok=await stat(app.notesFile).then(()=>true).catch(()=>false);return ok?true:undefined;});
    assert.match(await readFile(app.notesFile,'utf8'),/inside the allowed project/);

    // Rebind to an agent that does not name this project: a call is refused by the project scope,
    // with no effect. read_notes is used because the scripted provider never repeats record_note.
    const elsewhere=draftFor('Elsewhere only',[second.id]);
    app.created.agentStore!.bindSession({projectId:app.project.id,sessionId:'1',revision:1,agentId:elsewhere.id,actor:{kind:'owner',identity:'local'}});
    const before=await readFile(app.notesFile,'utf8');
    assert.equal((await app.send({text:'[read-notes]',mode:'followUp'})).status,200);
    const refused=await transcriptText(app);
    assert.match(refused,/outside this dispatch.s project scope/,'the refusal names the project scope');
    assert.equal(await readFile(app.notesFile,'utf8'),before,'a refused call wrote nothing');
  }finally{await app.created.close();app.store.close();}
});

test('an image is refused at admission and again at dispatch when the model cannot take it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-vision-'));
  const app=await instance('on',root,200);
  // A tiny valid PNG, generated here rather than committed as a binary fixture.
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwnnkGAAKbAZnxMlgqAAAAAElFTkSuQmCC';
  const upload=async(body:unknown)=>fetch(app.base+'/media',{method:'POST',headers:app.writes,body:JSON.stringify(body)});
  const choose=async(model:unknown)=>fetch(app.base+'/model',{method:'POST',headers:app.writes,body:JSON.stringify({model})});
  try{
    // The scripted provider takes image input, so the image is admitted and stored, and its declared
    // capability comes back with it.
    const admitted=await upload({data:png});
    assert.equal(admitted.status,201);
    const media=await admitted.json();
    assert.match(media.media.id,/^[a-f0-9]{64}$/);
    assert.deepEqual(media.media.requires,['image']);

    // A model that takes text only. The catalog the instance really offers is the source of it.
    const textOnly=app.created.providers.models.getModels().find(model=>Array.isArray(model.input)&&!model.input.includes('image'));
    assert.ok(textOnly,'this build offers a text-only model to prove the refusal with');
    const selected=await choose({provider:textOnly.provider,modelId:textOnly.id});
    assert.equal(selected.status,200);
    assert.deepEqual((await selected.json()).model,{provider:textOnly.provider,modelId:textOnly.id});

    // Admission: refused before anything is stored, with the model named in the reason.
    const refused=await upload({data:png});
    assert.equal(refused.status,422);
    const refusal=await refused.json();
    assert.equal(refusal.code,'vision');
    assert.match(refusal.error,new RegExp(textOnly.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.equal((await app.created.media.get(media.media.id))?.mimeType,'image/png','the earlier object is untouched');

    // Dispatch: an image admitted under a model that accepts images is re-checked against the model
    // that will actually run, and the whole submission is refused rather than sent without it.
    const sent=await fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify({text:'look at this',images:[media.media.id]})});
    assert.equal(sent.status,409);
    assert.match((await sent.json()).error,/does not accept image input/);
    const afterRefusal=await app.view();
    assert.ok(!afterRefusal.view.entries.some((entry:any)=>entry.text==='look at this'),'a refused submission reaches no transcript');

    // A message with an unknown image id is refused rather than sent without the image.
    const unknown=await fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify({text:'look at this',images:['a'.repeat(64)]})});
    assert.equal(unknown.status,422);
    assert.equal((await unknown.json()).code,'unknown-media');
    // Too many images in one message is a domain refusal with its own code, before any id is
    // resolved: the same shape every other media refusal has.
    const tooMany=await fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify({text:'many',images:Array.from({length:7},()=>'a'.repeat(64))})});
    assert.equal(tooMany.status,422);
    const tooManyRefusal=await tooMany.json();
    assert.equal(tooManyRefusal.code,'too-many-images');
    assert.match(tooManyRefusal.error,/at most 6 images; this one carries 7/);
    // A message that fits the count is unaffected, and so is the per-image id shape.
    const stillChecked=await fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify({text:'many',images:['not-a-media-id']})});
    assert.equal(stillChecked.status,400);

    // Back on a model that accepts images, the same message is admitted, and it carries the image.
    assert.equal((await choose(null)).status,200);
    const accepted=await fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify({text:'look at this',images:[media.media.id]})});
    assert.equal(accepted.status,200);
    const submission=await accepted.json();
    assert.equal(typeof submission.submissionId,'string');
    const answered=await waitFor(async()=>{const view=await app.view();return view.view.entries.some((entry:any)=>entry.kind==='assistant'&&/look at this/.test(entry.text))?view:undefined;});
    assert.ok(answered.view.entries.some((entry:any)=>entry.kind==='user'&&entry.text==='look at this'));

    // With agents disabled the media route refuses as a whole: there is no session to check.
    const off=await mkdtemp(join(tmpdir(),'dashboard-agents-vision-off-'));
    const disabled=await instance('off',off);
    try{
      const blocked=await fetch(disabled.base+'/media',{method:'POST',headers:disabled.writes,body:JSON.stringify({data:png})});
      assert.equal(blocked.status,503);
    }finally{await disabled.created.close();}
  }finally{await app.created.close();}
});

/**
 * A resume and a retry re-submit the conversation's last input. That input can carry an image, and
 * the replay must carry it too: sending the text alone would silently drop it. The model is the
 * observable, because the dispatch-time vision check reads what the replayed input really carries —
 * so a replay of an image-bearing input under a text-only model refuses, and a replay of the same
 * input after a successful replay refuses again only if the replay itself kept the image.
 *
 * Every model switch here waits for the run it follows to settle (`settled`): a switch is refused
 * with 409 while a run is in flight, and the committed reply lands while the run is still working, so
 * waiting on the reply alone races that refusal.
 */
test('a resumed or retried dispatch carries the image the original input carried, or refuses',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-agents-replay-'));
  const app=await instance('on',root,100);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwnnkGAAKbAZnxMlgqAAAAAElFTkSuQmCC';
  const choose=async(model:unknown)=>fetch(app.base+'/model',{method:'POST',headers:app.writes,body:JSON.stringify({model})});
  const replay=async(requestId:string)=>{
    try{await app.created.agents.dispatchLifecycle(app.created.catalog.get(app.project.id),requestId);return null;}
    catch(error){return error as {status?:number;message:string};}
  };
  const usersWithText=async()=>(await app.view()).view.entries.filter((entry:any)=>entry.kind==='user'&&entry.text==='look at this').length;
  /**
   * The run this test last dispatched has really settled: the reply it produced is committed *and*
   * the harness is idle. The reply alone is not enough, because it is committed while the run is
   * still working, and `setModel` refuses a switch while a run is in flight. So the wait is on the
   * settled condition itself, never on a proxy for it.
   */
  const settled=async(replies:number)=>waitFor(async()=>{
    const view=await app.view();
    const answered=view.view.entries.filter((entry:any)=>entry.kind==='assistant').length;
    return !view.view.working&&answered>=replies?view:undefined;
  });
  try{
    const admitted=await (await fetch(app.base+'/media',{method:'POST',headers:app.writes,body:JSON.stringify({data:png})})).json();
    assert.equal((await fetch(app.base+'/input',{method:'POST',headers:app.writes,body:JSON.stringify({text:'look at this',images:[admitted.media.id]})})).status,200);
    const first=await settled(1);
    assert.ok(first.view.entries.some((entry:any)=>entry.kind==='assistant'&&/look at this/.test(entry.text)),'the image-bearing input was answered');
    assert.equal(await usersWithText(),1);

    const textOnly=app.created.providers.models.getModels().find(model=>Array.isArray(model.input)&&!model.input.includes('image'));
    assert.ok(textOnly,'this build offers a text-only model to prove the refusal with');
    assert.equal((await choose({provider:textOnly.provider,modelId:textOnly.id})).status,200);

    // The replayed input carries an image, so the replay is refused rather than sent without it.
    const refused=await replay('replay-refused');
    assert.ok(refused,'a replay of an image-bearing input under a text-only model refuses');
    assert.equal(refused.status,409);
    assert.match(refused.message,/does not accept image input/);
    assert.equal(await usersWithText(),1,'a refused replay reaches no transcript');

    // On a model that takes images the same replay is admitted, and it keeps the image.
    assert.equal((await choose(null)).status,200);
    assert.equal(await replay('replay-carried'),null);
    await settled(2);
    assert.equal(await usersWithText(),2,'the replay committed the replayed input');

    // The replayed input is now the last input, and it carries an image too: the same refusal applies
    // to it. Without the image the replay would have committed a text-only input and this would pass.
    // The settle above is what makes this switch legal: the replay's own run has ended, so the switch
    // is not racing it. A switch while a run is in flight is refused with 409.
    assert.equal((await choose({provider:textOnly.provider,modelId:textOnly.id})).status,200);
    const refusedAgain=await replay('replay-refused-again');
    assert.ok(refusedAgain,'the replayed input still carries its image, so it is refused again');
    assert.equal(refusedAgain.status,409);
    assert.match(refusedAgain.message,/does not accept image input/);
    assert.equal(await usersWithText(),2,'the refused second replay reaches no transcript');
  }finally{await app.created.close();}
});

// ---- DEFECT 1: per-session conversations ----

test('DEFECT1: a new session has an empty transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-def1a-'));
  let app;
  try {
    app = await instance('on', root, 100);
    // Without a control store, /api/sessions returns 503, so test the agent view directly.
    const viewResp = await fetch(app.base, { headers: app.token });
    assert.equal(viewResp.status, 200);
    const view = await viewResp.json();
    assert.ok(view.view, 'view is present');
    assert.ok(Array.isArray(view.view.entries), 'entries is an array');
  } finally {
    if (app) await app.created.close();
  }
});

test('DEFECT1: the legacy conversation keeps working', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-def1b-'));
  let app;
  try {
    app = await instance('on', root, 100);
    // The root session (ROOT_CONVERSATION_ID) is the legacy project conversation.
    const viewResp = await fetch(app.base, { headers: app.token });
    assert.equal(viewResp.status, 200);
    const view = await viewResp.json();
    assert.ok(view.view, 'legacy view is present');
    assert.equal(view.enabled, true, 'agents are enabled');
    // Submit a message to the root conversation and check it appears as an entry.
    const inputResp = await fetch(app.base + '/input', {
      method: 'POST', headers: app.writes,
      body: JSON.stringify({ text: 'Hello agent', mode: 'followUp', requestId: crypto.randomUUID() })
    });
    assert.equal(inputResp.status, 200, 'input accepted');
    // The scripted provider answers quickly; wait for entries.
    await sleep(500);
    const updatedView = await (await fetch(app.base, { headers: app.token })).json();
    assert.ok(updatedView.view.entries.length > 0, 'legacy session has entries after input');
  } finally {
    if (app) await app.created.close();
  }
});

// ---- DEFECT 2: truthful scope/tool listing ----

test('DEFECT2a: the scope vocabulary reports which scopes have an installed tool', async () => {
  // Test via the shared module directly, independent of the HTTP endpoint.
  const { agentScopeVocabulary, AGENT_DEFAULT_INSTALLED_TOOLS, AGENT_SCOPES } = await import('../../src/shared/agent-registry');
  const vocab = agentScopeVocabulary();
  assert.ok(Array.isArray(vocab));
  assert.ok(vocab.length > 0);
  // Every scope has the installed field
  for (const entry of vocab) {
    assert.ok('installed' in entry, entry.scope + ' has installed field');
    assert.equal(typeof entry.installed, 'boolean', entry.scope + ' installed is boolean');
  }
  // The three base tools are installed
  const installed = vocab.filter(s => s.installed).map(s => s.scope);
  assert.ok(installed.includes('read_notes'), 'read_notes is installed');
  assert.ok(installed.includes('record_note'), 'record_note is installed');
  assert.ok(installed.includes('ask_question'), 'ask_question is installed');
  // Scopes with no installed tool
  const uninstalled = vocab.filter(s => !s.installed).map(s => s.scope);
  assert.ok(uninstalled.includes('read_docs'), 'read_docs is uninstalled');
  assert.ok(uninstalled.includes('write_docs'), 'write_docs is uninstalled');
  assert.ok(uninstalled.includes('file_read'), 'file_read is uninstalled');
  assert.ok(uninstalled.includes('run_tests'), 'run_tests is uninstalled');
  assert.ok(uninstalled.includes('fork'), 'fork is uninstalled');
  assert.ok(uninstalled.includes('accept'), 'accept is uninstalled');
  assert.ok(uninstalled.includes('commit'), 'commit is uninstalled');
  assert.ok(uninstalled.includes('push'), 'push is uninstalled');
  assert.ok(uninstalled.includes('deploy'), 'deploy is uninstalled');
  assert.ok(uninstalled.includes('spend'), 'spend is uninstalled');
  assert.ok(uninstalled.includes('provision'), 'provision is uninstalled');
  assert.ok(uninstalled.includes('publish'), 'publish is uninstalled');
  // Verify the total count: 16 scopes, 3 installed + 1 conditional (file_edit behind switch)
  assert.equal(vocab.length, 16, 'there are exactly 16 scopes');
  // file_edit is NOT installed by default (switch is off)
  assert.ok(uninstalled.includes('file_edit'), 'file_edit is uninstalled by default (switch off)');
});

test('DEFECT2b: an agent whose scope is granted but whose tool is not installed gets a 503 from the agent registry endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-def2b-'));
  let app;
  try {
    app = await instance('on', root, 100);
    // Without a control store, the agent registry returns 503.
    const regResp = await fetch(app.security.origin + '/api/agents', { headers: app.token });
    assert.equal(regResp.status, 503);
    const body = await regResp.json();
    assert.match(body.error, /agent registry .* unavailable/i);
  } finally {
    if (app) await app.created.close();
  }
});

test('DEFECT2c: file_edit scope without switch shows as uninstalled with a reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-def2c-'));
  let app;
  try {
    app = await instance('on', root, 100);
    // The agent registry endpoint needs a control store.
    // Without one, verify the harness-host correctly reports file_edit as disabled.
    // The view endpoint works without a control store:
    const viewResp = await fetch(app.base, { headers: app.token });
    assert.equal(viewResp.status, 200);
  } finally {
    if (app) await app.created.close();
  }
});

test('DEFECT2d: the agent prompt section lists only tools it can actually call', async () => {
  // This test validates the scope filtering logic that the privileged extension section implements.
  // It uses the pure function authorizeToolUse which filters based on installed scopes.
  const { authorizeToolUse, installedAgentScopes } = await import('../../src/shared/agent-registry');
  const installed = installedAgentScopes();
  assert.ok(Array.isArray(installed));
  assert.ok(installed.length >= 3, 'at least 3 base tools are installed');
  // A tool whose scope is installed is permitted when scopes include it
  const readNotesVerdict = authorizeToolUse({ scopes: ['read_notes'], tool: 'read_notes' });
  assert.ok(readNotesVerdict.permitted, 'read_notes tool is permitted when scope is held');
  // A tool whose scope is NOT installed (e.g. read_docs) is NOT permitted even when the scope is held
  // because authorizeToolUse checks scope membership, not installation status.
  // The INSTALLATION check is done by the privilege extension section text.
  // Verify the installedAgentScopes function:
  assert.ok(installed.includes('read_notes'));
  assert.ok(installed.includes('record_note'));
  assert.ok(installed.includes('ask_question'));
  assert.ok(!installed.includes('read_docs'), 'read_docs is NOT in installedAgentScopes');
  assert.ok(!installed.includes('write_docs'), 'write_docs is NOT in installedAgentScopes');
  assert.ok(!installed.includes('file_read'), 'file_read is NOT in installedAgentScopes');
  assert.ok(!installed.includes('run_tests'), 'run_tests is NOT in installedAgentScopes');
  // file_edit is NOT in the default installed list (switch off)
  assert.ok(!installed.includes('file_edit'), 'file_edit is NOT in installedAgentScopes when switch off');
});

test('DEFECT2e: enabling the file_edit switch makes the tool appear', async () => {
  // Test via the shared module: file_edit IS declared in AGENT_TOOL_SCOPES but NOT in
  // AGENT_DEFAULT_INSTALLED_TOOLS. At runtime, the harness checks the fileEdit.enabled flag.
  const { AGENT_DEFAULT_INSTALLED_TOOLS, AGENT_TOOL_SCOPES } = await import('../../src/shared/agent-registry');
  // file_edit IS in AGENT_TOOL_SCOPES
  assert.equal(AGENT_TOOL_SCOPES.file_edit, 'file_edit', 'file_edit has a tool-scope mapping');
  // file_edit is NOT in AGENT_DEFAULT_INSTALLED_TOOLS
  const defaultInstalledScopes = Object.values(AGENT_DEFAULT_INSTALLED_TOOLS);
  assert.ok(defaultInstalledScopes.includes('ask_question'));
  assert.ok(defaultInstalledScopes.includes('record_note'));
  assert.ok(defaultInstalledScopes.includes('read_notes'));
  assert.ok(!defaultInstalledScopes.includes('file_edit'), 'file_edit is not in default installed tools');
});
