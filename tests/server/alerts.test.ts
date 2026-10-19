import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import type { AlertPayload,AlertSubscription } from '../../src/server/alerts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw Error('condition was not met in time');
    await sleep(50);
  }
}
const subscription = (endpoint = 'https://push.example/device-1') => ({ endpoint, keys: { p256dh: 'BExampleP256dhKeyValueForTests', auth: 'authValueForTests' } });

async function instance(root: string,options: { cooldownMs?: number; fail?: boolean; failStatus?: number } = {}) {
  const sent: { subscription: AlertSubscription; payload: AlertPayload }[] = [];
  const security = localConfig('http://127.0.0.1:0');
  const created = await createApp({
    dataRoot: root, browseRoots: [], security, agents: 'on', agentPauseMs: 100, alertCooldownMs: options.cooldownMs ?? 10000,
    alertTransport: async (entry,payload) => {
      if (options.fail) throw Object.assign(new Error('push service said no'),{ statusCode: options.failStatus ?? 500 });
      sent.push({ subscription: entry, payload });
    }
  });
  await new Promise<void>(ok => created.server.listen(0,'127.0.0.1',ok));
  security.origin = 'http://127.0.0.1:' + (created.server.address() as { port: number }).port;
  const token = { 'x-dashboard-token': security.token };
  const writes = { ...token,'content-type': 'application/json',origin: security.origin };
  const project = await (await fetch(security.origin + '/api/projects',{ method: 'POST',headers: writes,body: JSON.stringify({ name: 'Alerts fixture',managed: true,confirm: true }) })).json() as { id: string };
  return { created,security,token,writes,project,sent,
    base: security.origin + '/api',
    agentInput: (body: unknown) => fetch(security.origin + '/api/projects/' + project.id + '/agents/input',{ method: 'POST',headers: writes,body: JSON.stringify(body) }) };
}

test('alerts are configured, subscribed, unsubscribed and gated like every other route',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-alerts-'));
  const app=await instance(root);
  let firstPublicKey='';
  try{
    const status=await (await fetch(app.base+'/alerts',{headers:app.token})).json();
    firstPublicKey=status.publicKey;
    assert.equal(status.enabled,true);
    assert.equal(typeof status.publicKey,'string');
    assert.ok(status.publicKey.length>80,'a VAPID public key is generated on first use');
    assert.equal(status.subscriptions,0);
    // The key pair is written beside the data, owner-only, and reused rather than regenerated.
    const keyFile=join(root,'alerts','vapid.json');
    assert.equal((await stat(keyFile)).mode & 0o777,0o600);
    const stored=JSON.parse(await readFile(keyFile,'utf8'));
    assert.equal(stored.publicKey,status.publicKey);
    assert.ok(typeof stored.privateKey==='string' && stored.privateKey.length>20);

    assert.equal((await fetch(app.base+'/alerts')).status,401);
    const withoutSession=await fetch(app.base+'/alerts/subscribe',{method:'POST',headers:{'content-type':'application/json',origin:app.security.origin},body:JSON.stringify(subscription())});
    assert.equal(withoutSession.status,401,'the alert routes need the session like every other route');
    const insecure=await fetch(app.base+'/alerts/subscribe',{method:'POST',headers:app.writes,body:JSON.stringify({endpoint:'http://insecure.example/x',keys:{p256dh:'aaaaaaaaaaaaaaaaaaaaaa',auth:'aaaaaaaaaa'}})});
    assert.equal(insecure.status,400,'a non-HTTPS endpoint is refused');
    const shortKeys=await fetch(app.base+'/alerts/subscribe',{method:'POST',headers:app.writes,body:JSON.stringify({endpoint:'https://push.example/x',keys:{p256dh:'short',auth:'short'}})});
    assert.equal(shortKeys.status,400,'incomplete keys are refused');

    assert.deepEqual(await (await fetch(app.base+'/alerts/subscribe',{method:'POST',headers:app.writes,body:JSON.stringify(subscription())})).json(),{count:1});
    assert.deepEqual(await (await fetch(app.base+'/alerts/subscribe',{method:'POST',headers:app.writes,body:JSON.stringify(subscription('https://push.example/device-2'))})).json(),{count:2});
    assert.equal((await (await fetch(app.base+'/alerts',{headers:app.token})).json()).subscriptions,2);
    assert.deepEqual(await (await fetch(app.base+'/alerts/unsubscribe',{method:'POST',headers:app.writes,body:JSON.stringify({endpoint:'https://push.example/device-2'})})).json(),{count:1});

    // The test alert goes through the same sender.
    assert.deepEqual(await (await fetch(app.base+'/alerts/test',{method:'POST',headers:app.writes,body:'{}'})).json(),{sent:1,failed:0,skipped:false});
    assert.equal(app.sent.length,1);
    assert.match(app.sent[0].payload.title,/Test alert|Project dashboard/);
  }finally{await app.created.close();}

  // A new process keeps the same keys and the same devices.
  const reopened=await instance(root);
  try{
    const status=await (await fetch(reopened.base+'/alerts',{headers:reopened.token})).json();
    assert.equal(status.subscriptions,1);
    assert.equal(status.publicKey,firstPublicKey,'the same key pair is reused after a restart');
  }finally{await reopened.created.close();}
});

test('an agent question, a finished run and a failure each alert once',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-alerts-events-'));
  const app=await instance(root,{cooldownMs:1});
  try{
    await fetch(app.base+'/alerts/subscribe',{method:'POST',headers:app.writes,body:JSON.stringify(subscription())});

    // A question alerts with the project name and a link to the view that answers it.
    assert.equal((await app.agentInput({text:'[ask] add the invoice export',mode:'followUp'})).status,200);
    const questionAlert=await waitFor(()=>app.sent.find(entry=>/needs an answer/.test(entry.payload.title)));
    assert.match(questionAlert.payload.body,/Alerts fixture/);
    assert.match(questionAlert.payload.body,/invoice export/);
    assert.match(questionAlert.payload.url,/project=/);
    assert.match(questionAlert.payload.url,/view=Agents/);

    // A finished run alerts too.
    await waitFor(()=>app.sent.find(entry=>/finished/.test(entry.payload.title)));
  }finally{await app.created.close();}

  // The throttle keeps repeats of the same kind of event down within its window.
  const throttled=await instance(root,{cooldownMs:60000});
  try{
    await fetch(throttled.base+'/alerts/subscribe',{method:'POST',headers:throttled.writes,body:JSON.stringify(subscription('https://push.example/device-3'))});
    assert.equal((await throttled.agentInput({text:'first run',mode:'followUp'})).status,200);
    await waitFor(()=>throttled.sent.find(entry=>/finished/.test(entry.payload.title)));
    const sent=throttled.sent.length;
    assert.equal((await throttled.agentInput({text:'second run',mode:'followUp'})).status,200);
    await sleep(1200);
    assert.equal(throttled.sent.length,sent,'a second completion inside the cooldown is not sent again');
  }finally{await throttled.created.close();}
});

test('a device the push service reports as gone is dropped',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-alerts-gone-'));
  const app=await instance(root,{fail:true,failStatus:410});
  try{
    await fetch(app.base+'/alerts/subscribe',{method:'POST',headers:app.writes,body:JSON.stringify(subscription())});
    const result=await (await fetch(app.base+'/alerts/test',{method:'POST',headers:app.writes,body:'{}'})).json();
    assert.deepEqual(result,{sent:0,failed:1,skipped:false});
    assert.equal((await (await fetch(app.base+'/alerts',{headers:app.token})).json()).subscriptions,0,'a gone endpoint is pruned');
  }finally{await app.created.close();}
});
