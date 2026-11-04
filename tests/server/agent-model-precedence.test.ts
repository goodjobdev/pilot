import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';
import { ControlStore } from '../../src/server/state/control-store';

/**
 * Which model governs a session: the owner's choice for that session, else the bound agent's
 * declared model, else the conversation's own.
 *
 * The order is the decision the owner asked for. It is checked end to end because the alternative —
 * a field that is stored and never applied — is exactly what this replaced.
 */
async function fixture(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'pilot-model-precedence-'));
  const security=localConfig('http://127.0.0.1:0'),control=new ControlStore(root);
  const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control});
  await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));
  security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
  const auth={'x-dashboard-token':security.token},writes={...auth,origin:security.origin,'content-type':'application/json'};
  const call=(path:string,body?:unknown)=>fetch(security.origin+'/api'+path,body===undefined?{headers:auth}:{method:'POST',headers:writes,body:JSON.stringify(body)});
  t.after(async()=>{await app.close();control.close();await rm(root,{recursive:true,force:true});});
  const project=await (await call('/projects',{name:'Precedence',managed:true,confirm:true})).json() as {id:string};
  return {app,call,project,security};
}
test('a bound agent’s declared model is applied, and a session’s own choice wins over it',async t=>{
  const f=await fixture(t);
  const offered=await (await f.call('/agents')).json() as {models:{provider:string;modelId:string}[]};
  // Two offered models: the scripted provider is always there, so a second is not needed — the
  // agent's declared model and the session's choice are compared by name, not by provider.
  const agentModel=offered.models[0],otherModel=offered.models.find(candidate=>candidate.provider!==agentModel.provider||candidate.modelId!==agentModel.modelId) as {provider:string;modelId:string};
  const created=await (await f.call('/agents',{actor:{kind:'owner',identity:'local'},draft:{name:'Precedence agent',description:'',enabled:true,model:agentModel,workspace:{scope:{kind:'projects',projectIds:[f.project.id]},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:['read_notes']}})).json() as {agent:{id:string;revision:number}};
  // The project conversation exists before the binding, on the scripted provider.
  const before=await (await f.call('/projects/'+f.project.id+'/agents')).json() as {view:{conversationId:string;model:{provider:string;modelId:string}|null}};
  assert.ok(before.view.conversationId);
  const rootSession=before.view.conversationId;
  // Bind the agent: its declared model is applied to the conversation that session governs.
  const bound=await f.call('/sessions/'+rootSession+'/agent',{projectId:f.project.id,revision:0,agentId:created.agent.id,actor:{kind:'owner',identity:'local'}});
  assert.equal(bound.status,200,await bound.text());
  await assert.doesNotReject(async()=>{
    const view=await (await f.call('/projects/'+f.project.id+'/agents')).json() as {view:{model:{provider:string;modelId:string}|null}};
    assert.equal(view.view.model?.provider,agentModel.provider,'the agent’s model is in force after the binding');
  });
  // The owner's own pick for that session is recorded with the session and wins.
  const picked=await f.call('/projects/'+f.project.id+'/agents/model',{sessionId:rootSession,model:otherModel});
  assert.equal(picked.status,200,await picked.text());
  const session=await (await f.call('/sessions?projectId='+f.project.id)).json() as {sessions:{id:string;model:{provider:string;modelId:string}|null}[]};
  const record=session.sessions.find(candidate=>candidate.id===rootSession);
  assert.equal(record?.model?.provider,otherModel.provider,'the session records the owner’s choice');assert.equal(record?.model?.modelId,otherModel.modelId);
  const after=await (await f.call('/projects/'+f.project.id+'/agents')).json() as {view:{model:{provider:string;modelId:string}|null}};
  assert.equal(after.view.model?.provider,otherModel.provider,'and the session’s choice is what governs it');
  assert.equal(after.view.model?.modelId,otherModel.modelId);
});
