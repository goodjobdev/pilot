import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentStore } from '../../src/server/state/agent-store';
import { HarnessHost } from '../../src/server/agents/harness-host';
import { ProviderStore } from '../../src/server/providers';
import { randomUUID } from 'node:crypto';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';

test('a revoked reservation is refused before the provider is called', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-budget-revoked-'));
  let requests = 0, checks = 0;
  const fake = fauxProvider({ provider: 'revocation-faux', models: [{ id: 'fixture' }] });
  const providers = new ProviderStore(root, [fake.provider]);
  await providers.savePreferences({ defaultModel: { provider: 'revocation-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
  const project = { id: randomUUID(), name: 'Fixture', path: root, managed: true, repository: '', created: '' };
  const host = new HarnessHost({ dataRoot: root, enabled: true, pauseMs: 0, providers, onModelRequest: () => { requests++; },
    agentRequestBudget: async () => ({ maxOutputTokens: 32, check: () => { checks++; throw Error('revoked before call'); } }) });
  try {
    await host.submit(project, { text: 'try a request', mode: 'followUp' });
    const end = Date.now() + 10000;
    while (checks === 0 || (await host.view(project)).working) {
      if (Date.now() > end) throw Error('request did not settle');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(requests, 0); assert.equal(checks, 1);
    assert.equal(fake.state.callCount, 0, 'revocation before dispatch invokes no faux provider stream');
  } finally { await host.close(); await providers.close(); await rm(root, { recursive: true, force: true }); }
});

test('unbound and formerly governed sessions never reach the provider', async () => {
  for (const change of ['unbind', 'disable', 'archive', 'move'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'pilot-budget-inactive-')), security = localConfig('http://127.0.0.1:0'), control = new ControlStore(root);
    let calls = 0;
    const app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', control, agentPauseMs: 0, onModelRequest: () => { calls++; } });
    try {
      await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
      security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
      const auth = { 'x-dashboard-token': security.token }, writes = { ...auth, origin: security.origin, 'content-type': 'application/json' };
      const post = (path: string, body: unknown) => fetch(security.origin + '/api' + path, { method: 'POST', headers: writes, body: JSON.stringify(body) });
      const project = await (await post('/projects', { name: 'Inactive fixture', managed: true, confirm: true })).json() as { id: string };
      const other = await (await post('/projects', { name: 'Other fixture', managed: true, confirm: true })).json() as { id: string };
      const offered = app.agents.offeredModels()[0], actor = { kind: 'owner' as const, identity: 'local' };
      const agent = app.agentStore!.create({ actor, draft: { name: 'Governed fixture', description: '', enabled: true, model: offered, workspace: { scope: { kind: 'projects', projectIds: [project.id] }, subpath: '' }, budgets: { maxRequests: null, maxOutputTokens: null, maxJobsPerHour: null }, scopes: ['read_notes'] } });
      if (change === 'unbind') {
        app.agentStore!.bindSession({ projectId: project.id, sessionId: '1', revision: 0, agentId: agent.id, actor });
        app.agentStore!.bindSession({ projectId: project.id, sessionId: '1', revision: 1, agentId: null, actor });
      } else if (change === 'archive') app.agentStore!.archive({ agentId: agent.id, revision: agent.revision, actor });
      else app.agentStore!.update({ agentId: agent.id, revision: agent.revision, actor, patch: change === 'disable' ? { enabled: false } : { workspace: { scope: { kind: 'projects', projectIds: [other.id] }, subpath: '' } } });
      const response = await post('/projects/' + project.id + '/agents/input', { text: 'refused ' + change, mode: 'followUp' });
      assert.equal(response.status, 200);
      const until = Date.now() + 10000;
      for (;;) {
        const result = await (await fetch(security.origin + '/api/projects/' + project.id + '/agents', { headers: auth })).json() as { view: { working: boolean; entries: { text: string }[] } };
        if (!result.view.working && result.view.entries.some(entry => entry.text.includes('refused ' + change))) break;
        if (Date.now() > until) throw Error('inactive request did not settle');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(calls, 0, change);
    } finally { await app.close(); control.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('ambiguous legacy authority with a configured budget refuses until an owner binds an agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-budget-ambiguous-')), security = localConfig('http://127.0.0.1:0'), control = new ControlStore(root);
  let calls = 0;
  const app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', control, agentPauseMs: 0, onModelRequest: () => { calls++; } });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
    const auth = { 'x-dashboard-token': security.token }, writes = { ...auth, origin: security.origin, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) => fetch(security.origin + '/api' + path, { method: 'POST', headers: writes, body: JSON.stringify(body) });
    const project = await (await post('/projects', { name: 'Ambiguous budget', managed: true, confirm: true })).json() as { id: string };
    const actor = { kind: 'owner' as const, identity: 'local' }, model = app.agents.offeredModels()[0];
    const create = (name: string, maxRequests: number | null) => app.agentStore!.create({ actor, draft: { name, description: '', enabled: true, model, workspace: { scope: { kind: 'projects', projectIds: [project.id] }, subpath: '' }, budgets: { maxRequests, maxOutputTokens: null, maxJobsPerHour: null }, scopes: ['read_notes'] } });
    const governed = create('Bound budget candidate', 1); create('Unbudgeted candidate', null);
    const base = '/projects/' + project.id + '/agents';
    const initial = await (await fetch(security.origin + '/api' + base, { headers: auth })).json() as { view: { conversationId: string } };
    const send = async (text: string) => {
      assert.equal((await post(base + '/input', { text, mode: 'followUp' })).status, 200);
      const deadline = Date.now() + 10000;
      for (;;) {
        const result = await (await fetch(security.origin + '/api' + base, { headers: auth })).json() as { view: { working: boolean; entries: { text: string }[] } };
        if (!result.view.working && result.view.entries.some(entry => entry.text.includes(text))) return;
        if (Date.now() > deadline) throw Error('budgeted request did not settle');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await send('ambiguous input'); assert.equal(calls, 0, 'no candidate budget may silently be bypassed');
    assert.equal((await post('/sessions/' + initial.view.conversationId + '/agent', { projectId: project.id, revision: 0, agentId: governed.id, actor })).status, 200);
    await send('bound input'); assert.equal(calls, 1);
    await send('bound limit exhausted'); assert.equal(calls, 1);
  } finally { await app.close(); control.close(); await rm(root, { recursive: true, force: true }); }
});

test('binding revoke and restore before budget admission cannot revive a provider request',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-budget-binding-aba-')),security=localConfig('http://127.0.0.1:0'),control=new ControlStore(root),otherControl=new ControlStore(root);
 let calls=0,interleaved=false;const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control,agentPauseMs:0,onModelRequest:()=>{calls++;}});
 try{
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
  const auth={'x-dashboard-token':security.token},writes={...auth,origin:security.origin,'content-type':'application/json'};
  const post=(path:string,body:unknown)=>fetch(security.origin+'/api'+path,{method:'POST',headers:writes,body:JSON.stringify(body)});
  const project=await (await post('/projects',{name:'Binding ABA',managed:true,confirm:true})).json() as {id:string};
  const offered=app.agents.offeredModels()[0],actor={kind:'owner' as const,identity:'local'};
  const agent=app.agentStore!.create({actor,draft:{name:'Budgeted',description:'',enabled:true,model:offered,workspace:{scope:{kind:'projects',projectIds:[project.id]},subpath:''},budgets:{maxRequests:3,maxOutputTokens:null,maxJobsPerHour:null},scopes:['read_notes']}});
  app.agentStore!.bindSession({projectId:project.id,sessionId:'1',revision:0,agentId:agent.id,actor});
  const other=new AgentStore(otherControl,{models:()=>[offered],projectKnown:id=>id===project.id}),admit=control.admit.bind(control);
  control.admit=input=>{
   if(!interleaved&&input.kind==='agent.budget-request'){
    interleaved=true;const unbound=other.bindSession({projectId:project.id,sessionId:'1',revision:1,agentId:null,actor});
    other.bindSession({projectId:project.id,sessionId:'1',revision:unbound.revision,agentId:agent.id,actor});
   }
   return admit(input);
  };
  assert.equal((await post('/projects/'+project.id+'/agents/input',{text:'budget binding race',mode:'followUp'})).status,200);
  const end=Date.now()+10000;
  for(;;){const result=await (await fetch(security.origin+'/api/projects/'+project.id+'/agents',{headers:auth})).json() as {view:{working:boolean;entries:{text:string}[]}};
   if(!result.view.working&&result.view.entries.some(entry=>entry.text.includes('budget binding race')))break;
   if(Date.now()>end)throw Error('request did not settle');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(interleaved,true);assert.equal(calls,0);
  assert.equal(new (await import('../../src/server/state/agent-budget')).AgentBudgetLedger(control).requestsAccounted(agent.id),0);
 }finally{await app.close();otherControl.close();control.close();await rm(root,{recursive:true,force:true});}
});

test('bound agent request and output limits reach faux stream calls and exhaustion denies further calls across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-budget-http-'));
  const observed: number[] = [];
  const fake = fauxProvider({ provider: 'budget-faux', models: [{ id: 'fixture' }] });
  fake.setResponses(Array.from({ length: 8 }, () => (_context, options) => {
    observed.push(options?.maxTokens ?? 0);
    return fauxAssistantMessage('Faux provider response.');
  }));
  let control: ControlStore | undefined, app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const start = async () => {
      const security = localConfig('http://127.0.0.1:0');
      control = new ControlStore(root);
      app = await createApp({ dataRoot: root, browseRoots: [], security, agents: 'on', control, agentPauseMs: 0 });
      fake.setResponses(Array.from({ length: 8 }, () => (_context, options) => {
        observed.push(options?.maxTokens ?? 0);
        return fauxAssistantMessage('Faux provider response.');
      }));
      app.providers.models.setProvider(fake.provider);
      await app.providers.savePreferences({ defaultModel: { provider: 'budget-faux', modelId: 'fixture' }, favourites: [], allowRealModels: true });
      await new Promise<void>(resolve => app!.server.listen(0, '127.0.0.1', resolve));
      security.origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
      const auth = { 'x-dashboard-token': security.token }, writes = { ...auth, origin: security.origin, 'content-type': 'application/json' };
      return { call: (path: string, body?: unknown) => fetch(security.origin + '/api' + path, body === undefined ? { headers: auth } : { method: 'POST', headers: writes, body: JSON.stringify(body) }) };
    };
    let client = await start();
    const project = await (await client.call('/projects', { name: 'Budget fixture', managed: true, confirm: true })).json() as { id: string };
    const offered = { provider: 'budget-faux', modelId: 'fixture' };
    const created = await (await client.call('/agents', { actor: { kind: 'owner', identity: 'local' }, draft: { name: 'Budgeted', description: '', enabled: true, model: offered, workspace: { scope: { kind: 'projects', projectIds: [project.id] }, subpath: '' }, budgets: { maxRequests: 1, maxOutputTokens: 321, maxJobsPerHour: null }, scopes: ['read_notes'] } })).json() as { agent: { id: string; revision: number } };
    const base = '/projects/' + project.id + '/agents';
    const initial = await (await client.call(base)).json() as { view: { conversationId: string } };
    const bound = await client.call('/sessions/' + initial.view.conversationId + '/agent', { projectId: project.id, revision: 0, agentId: created.agent.id, actor: { kind: 'owner', identity: 'local' } });
    assert.equal(bound.status, 200);
    const send = async (text: string) => {
      const response = await client.call(base + '/input', { text, mode: 'followUp' }); assert.equal(response.status, 200);
      const until = Date.now() + 10000;
      for (;;) {
        const result = await (await client.call(base)).json() as { view: { working: boolean; entries: { text: string }[] } };
        if (!result.view.working && result.view.entries.some(entry => entry.text.includes(text))) return result.view;
        if (Date.now() > until) throw Error('budgeted request did not settle');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await send('first request'); assert.deepEqual(observed, [321]);
    assert.equal(fake.state.callCount, 1, 'the faux provider stream was invoked once');
    await send('second request'); assert.deepEqual(observed, [321]);
    assert.equal(fake.state.callCount, 1, 'request exhaustion prevents another faux stream invocation');
    const detail = await (await client.call('/agents/' + created.agent.id)).json() as { budgetUsage: { requestsAccounted: number } };
    assert.equal(detail.budgetUsage.requestsAccounted, 1);
    await app!.close(); control!.close(); app = undefined; control = undefined;
    client = await start();
    await send('after restart'); assert.deepEqual(observed, [321]);
    assert.equal(fake.state.callCount, 1, 'the exhausted reservation remains enforced after restart');
    // The owner may revise the threshold. It never resets already-accounted reservations.
    const raised = await client.call('/agents/' + created.agent.id + '/update', { revision: created.agent.revision, patch: { budgets: { maxRequests: 2, maxOutputTokens: 321, maxJobsPerHour: null } }, actor: { kind: 'owner', identity: 'local' } });
    assert.equal(raised.status, 200);
    const updated = await raised.json() as { agent: { revision: number } };
    await send('after owner raises limit'); assert.deepEqual(observed, [321, 321]);
    assert.equal(fake.state.callCount, 2, 'raising the limit admits exactly one additional faux stream invocation');
    await send('new limit exhausted'); assert.deepEqual(observed, [321, 321]);
    assert.equal(fake.state.callCount, 2, 'the new request limit denies further faux stream invocations');
    const lowered = await client.call('/agents/' + created.agent.id + '/update', { revision: updated.agent.revision, patch: { budgets: { maxRequests: 1, maxOutputTokens: 321, maxJobsPerHour: null } }, actor: { kind: 'owner', identity: 'local' } });
    assert.equal(lowered.status, 200);
    await send('lowered below usage'); assert.deepEqual(observed, [321, 321]);
    const after = await (await client.call('/agents/' + created.agent.id)).json() as { budgetUsage: { requestsAccounted: number } };
    assert.equal(after.budgetUsage.requestsAccounted, 2);
  } finally { if (app) await app.close(); control?.close(); await rm(root, { recursive: true, force: true }); }
});
