import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';

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
