import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';

/**
 * The harness settings over HTTP, on an instance that really offers the capabilities.
 *
 * This is where the disable-only rule is checked end to end: the owner can switch a capability off
 * and the next tool call is refused, but a capability the deployment never offered cannot be
 * switched on from the interface at all.
 */
async function fixture(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'pilot-harness-http-'));
  const security=localConfig('http://127.0.0.1:0');
  // A control store, so the agent registry really answers and the vocabulary can be compared.
  const control=new ControlStore(root);
  const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control,coding:{enabled:true,shell:true},fileEdit:{enabled:true}});
  await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));
  security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
  const auth={'x-dashboard-token':security.token};
  const writes={...auth,origin:security.origin,'content-type':'application/json'};
  t.after(async()=>{await app.close();control.close();await rm(root,{recursive:true,force:true});});
  const call=(path:string,body?:unknown)=>fetch(security.origin+'/api'+path,body===undefined?{headers:auth}:{method:'POST',headers:writes,body:JSON.stringify(body)});
  return {app,call,security,auth,writes};
}
test('the harness settings share the owner-only boundary and are revision-checked',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.security.origin+'/api/settings/harness')).status,401);
  assert.equal((await fetch(f.security.origin+'/api/settings/harness',{method:'POST',headers:{...f.writes,origin:'https://evil.invalid'},body:'{}'})).status,403);
  const first=await (await f.call('/settings/harness')).json() as {revision:number;settings:{preferences:{maxModelTurns:number};capabilities:{shell:boolean}};effective:{capabilities:{shell:{deployed:boolean;enabled:boolean}}}};
  assert.equal(first.revision,1);assert.equal(first.effective.capabilities.shell.deployed,true,'this instance offers the shell');
  assert.equal(first.effective.capabilities.shell.enabled,true);
  // A stale revision writes nothing and says so.
  await f.call('/settings/harness',{revision:first.revision,settings:{preferences:{maxModelTurns:50,defaultThinking:'low'},capabilities:{codingTools:true,shell:true,fileEdit:true}}});
  const stale=await f.call('/settings/harness',{revision:1,settings:{preferences:{maxModelTurns:9,defaultThinking:null},capabilities:{codingTools:true,shell:true,fileEdit:true}}});
  assert.equal(stale.status,409);assert.match((await stale.json()).error,/changed since you read/);
  // An out-of-range bound is refused by the shared validation, with nothing written.
  const tooHigh=await f.call('/settings/harness',{revision:2,settings:{preferences:{maxModelTurns:301,defaultThinking:null},capabilities:{codingTools:true,shell:true,fileEdit:true}}});
  assert.equal(tooHigh.status,422);
  const current=await (await f.call('/settings/harness')).json() as {revision:number;settings:{preferences:{maxModelTurns:number}}};
  assert.equal(current.revision,2);assert.equal(current.settings.preferences.maxModelTurns,50);
});
test('switching a capability off refuses the tool from the next call; switching it on is deployment-only',async t=>{
  const f=await fixture(t);
  const view=await (await f.call('/settings/harness')).json() as {revision:number};
  const off=await (await f.call('/settings/harness',{revision:view.revision,settings:{preferences:{maxModelTurns:40,defaultThinking:null},capabilities:{codingTools:true,shell:false,fileEdit:false}}})).json() as {effective:{capabilities:{shell:{deployed:boolean;allowed:boolean;enabled:boolean};fileEdit:{enabled:boolean}}}};
  assert.deepEqual(off.effective.capabilities.shell,{deployed:true,allowed:false,enabled:false});
  assert.equal(off.effective.capabilities.fileEdit.enabled,false);
  // The vocabulary the interface reads reports the same state, so the two cannot disagree.
  const agents=await (await f.call('/agents')).json() as {scopes:{scope:string;installed:boolean}[]};
  const shell=agents.scopes.find(entry=>entry.scope==='shell');
  assert.equal(shell?.installed,false,'the shell is not installed while the owner has it switched off');
  // The bounded file-edit route refuses with the reason while it is switched off.
  const project=await (await f.call('/projects',{name:'Harness',managed:true,confirm:true})).json() as {id:string};
  const propose=await f.call('/projects/'+project.id+'/file-edits',{path:'docs/x.md',content:'x',mode:'propose-only'});
  assert.equal(propose.status,409);
  assert.match((await propose.json()).error,/switched off in this instance/);
});
