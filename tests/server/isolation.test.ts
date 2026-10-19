import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import type { AlertPayload,AlertSubscription } from '../../src/server/alerts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs = 10000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw Error('condition was not met in time');
    await sleep(50);
  }
}

test('two projects share no documents, no agent session and no credential material',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-isolation-'));
  const sent:{ subscription: AlertSubscription; payload: AlertPayload }[]=[];
  const security=localConfig('http://127.0.0.1:0');
  const app=await createApp({ dataRoot:root,browseRoots:[],security,agents:'on',agentPauseMs:100,alertCooldownMs:1,alertTransport:async(entry,payload)=>{ sent.push({subscription:entry,payload}); } });
  await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));
  security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
  const token={'x-dashboard-token':security.token};
  const writes={...token,'content-type':'application/json',origin:security.origin};
  const base=security.origin+'/api';
  const register=async(name:string)=>await (await fetch(base+'/projects',{method:'POST',headers:writes,body:JSON.stringify({name,managed:true,confirm:true})})).json() as { id: string; path: string };
  try{
    const alpha=await register('Isolation Alpha');
    const beta=await register('Isolation Beta');

    // Documentation belongs to the project it was written in.
    const created=await fetch(base+'/projects/'+alpha.id+'/docs/document',{method:'POST',headers:writes,body:JSON.stringify({path:'docs/alpha.md',text:'# Alpha only\n'})});
    assert.equal(created.status,201);
    const alphaDocs=await (await fetch(base+'/projects/'+alpha.id+'/docs',{headers:token})).json() as { documents: { path: string }[] };
    const betaDocs=await (await fetch(base+'/projects/'+beta.id+'/docs',{headers:token})).json() as { documents: { path: string }[] };
    assert.deepEqual(alphaDocs.documents.map(document=>document.path),['docs/alpha.md']);
    assert.deepEqual(betaDocs.documents,[],'the other project sees no documents');
    const crossRead=await fetch(base+'/projects/'+beta.id+'/docs/document?path='+encodeURIComponent('docs/alpha.md'),{headers:token});
    assert.equal(crossRead.status,404,'a path from one project is not readable in another');

    // Agent sessions are separate: separate storage files and separate transcripts.
    const alphaAgents=base+'/projects/'+alpha.id+'/agents';
    const betaAgents=base+'/projects/'+beta.id+'/agents';
    assert.equal((await fetch(alphaAgents+'/input',{method:'POST',headers:writes,body:JSON.stringify({text:'a message for alpha only',mode:'followUp'})})).status,200);
    await waitFor(async()=>{
      const view=await (await fetch(alphaAgents,{headers:token})).json() as { view: { entries: unknown[] } };
      return view.view.entries.length ? true : undefined;
    });
    const betaView=await (await fetch(betaAgents,{headers:token})).json() as { view: { entries: unknown[]; questions: unknown[] } };
    assert.deepEqual(betaView.view.entries,[],'the other project has an empty transcript');
    assert.deepEqual(betaView.view.questions,[]);
    assert.ok((await stat(join(root,'agents',alpha.id,'session.sqlite'))).size>0);
    assert.ok((await stat(join(root,'agents',beta.id,'session.sqlite'))).size>0);

    // A question alerts with the project it came from.
    await fetch(base+'/alerts/subscribe',{method:'POST',headers:writes,body:JSON.stringify({endpoint:'https://push.example/isolation',keys:{p256dh:'BIsolationKeyValueForTests',auth:'isolationAuth'}})});
    await fetch(betaAgents+'/input',{method:'POST',headers:writes,body:JSON.stringify({text:'[ask] beta question',mode:'followUp'})});
    const alert=await waitFor(()=>sent.find(entry=>/needs an answer/.test(entry.payload.title)));
    assert.match(alert.payload.body,/Isolation Beta/);
    assert.doesNotMatch(alert.payload.body,/Isolation Alpha/);
    assert.match(alert.payload.url,new RegExp(beta.id));

    // Nothing in the agent view exposes credential or key material.
    const serialized=JSON.stringify(await (await fetch(alphaAgents,{headers:token})).json());
    for (const forbidden of ['privateKey','vapid','p256dh','apiKey','refresh']) {
      assert.doesNotMatch(serialized,new RegExp(forbidden,'i'),'the agent view must not expose '+forbidden);
    }
  }finally{await app.close();}
});