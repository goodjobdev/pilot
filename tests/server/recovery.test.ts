import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,rm,stat,unlink,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { build } from 'esbuild';
import { spawn,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs = 20000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > until) throw Error('condition was not met in time');
    await sleep(100);
  }
}
function freePort(): Promise<number> {
  return new Promise((ok,fail) => {
    const probe = createServer();
    probe.once('error',fail);
    probe.listen(0,'127.0.0.1',() => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => ok(port));
    });
  });
}

/**
 * The entrypoint validates the whole environment, so these tests must not inherit a deployment's
 * values: an ambient DASHBOARD_ORIGIN, CF_ACCESS_*, DASHBOARD_EXPOSURE or DASHBOARD_ALLOWED_HOSTS
 * would make every start here fail closed before the behaviour under test is reached.
 */
const DEPLOYMENT_VARIABLES=['DASHBOARD_MODE','DASHBOARD_EXPOSURE','DASHBOARD_BIND','DASHBOARD_ALLOWED_HOSTS','DASHBOARD_RELEASE','DASHBOARD_ROOT_ID','DASHBOARD_SHUTDOWN_DEADLINE_MS','DASHBOARD_ORIGIN','CF_ACCESS_TEAM','CF_ACCESS_AUD','DASHBOARD_OWNER','DASHBOARD_DATA','DASHBOARD_ROOTS','DASHBOARD_REGISTRY','DASHBOARD_AGENT_NOTE_DELAY_MS','DASHBOARD_AGENT_NOTE_AFTER_WRITE_MS','DASHBOARD_AGENT_TEST_SEAMS','PORT'];
function testEnv(overrides:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const env:{[name:string]:string|undefined}={...process.env};
  for(const name of DEPLOYMENT_VARIABLES)delete env[name];
  return {...env,...overrides} as NodeJS.ProcessEnv;
}

interface CrashFixture {
  readonly root: string;
  readonly data: string;
  /** Build the real server bundle once; every start in one test runs that same bundle. */
  start(): { server: ChildProcess; listening: Promise<void>; base: string };
  /** The token the local-mode page embeds, once the server answers. */
  tokenOf(): Promise<string | undefined>;
  /** Kill the process and wait for it to be gone, so the next observation is after the crash. */
  kill(server: ChildProcess): Promise<void>;
  /** Prove the stale lock fails the next start closed, then clear it as the operator would. */
  refuseWhileLocked(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * One disposable root, one disposable data root and the real server bundle. The bundle is built in
 * the test's own temporary directory, so nothing in the worktree is replaced. No live project, no
 * real data, no provider account and no remote call is used anywhere in this file.
 */
async function crashFixture(extraEnv:Record<string,string> = {}): Promise<CrashFixture> {
  const root=await mkdtemp(join(tmpdir(),'dashboard-recovery-'));
  const release=join(root,'release');
  await mkdir(release,{recursive:true});
  await build({entryPoints:[resolve('src/server/main.ts')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:join(release,'server.mjs')});
  await symlink(resolve('node_modules'),join(release,'node_modules'),'dir');
  // The entrypoint serves a client directory; only an index page is needed here, because the
  // local-mode session token is injected into it and nothing else is under test.
  await mkdir(join(release,'client'),{recursive:true});
  await writeFile(join(release,'client','index.html'),'<!doctype html><html><head></head><body></body></html>');
  const data=join(root,'data');
  const port=await freePort();
  const base='http://127.0.0.1:'+port;
  const env=testEnv({ DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_AGENTS:'on',DASHBOARD_AGENT_PAUSE_MS:'100',DASHBOARD_AGENT_TEST_SEAMS:'on',DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:'',...extraEnv });
  const start=()=>{
    const server=spawn(process.execPath,[join(release,'server.mjs')],{env,stdio:['ignore','pipe','pipe']});
    let errors='';
    server.stderr!.on('data',chunk=>{errors+=String(chunk);});
    const listening=new Promise<void>((ok,fail)=>{
      const timer=setTimeout(()=>fail(Error('the server did not start listening')),10000);
      server.stdout!.on('data',chunk=>{ if(String(chunk).includes('Dashboard listening')){clearTimeout(timer);ok();} });
      server.once('exit',code=>{clearTimeout(timer);fail(Error('the server exited early with '+code+': '+errors.trim()));});
    });
    return {server,listening,base};
  };
  const tokenOf=async():Promise<string|undefined>=>{
    try{
      const html=await (await fetch(base+'/')).text();
      const match=html.match(/name="dashboard-token" content="([a-f0-9]+)"/);
      return match ? match[1] : undefined;
    }catch{ return undefined; }
  };
  return {
    root,data,start,tokenOf,
    async kill(server){ server.kill('SIGKILL'); await once(server,'exit'); },
    async refuseWhileLocked(){
      const refused=start();
      // The refused start is expected to exit non-zero; its listening promise must not become an
      // unhandled rejection that disguises the refusal this test is proving.
      refused.listening.catch(()=>undefined);
      let refusal='';
      refused.server.stderr!.on('data',chunk=>{refusal+=String(chunk);});
      const [code]=await once(refused.server,'exit') as [number];
      assert.notEqual(code,0,'a restart on a locked data root must fail');
      assert.match(refusal,/locked/);
      assert.equal(await stat(join(data,'service.lock')).then(()=>true),true,'the stale lock is still present, not stolen');
      await unlink(join(data,'service.lock'));
    },
    async cleanup(){
      await rm(root,{recursive:true,force:true});
    }
  };
}

/** The headers every local-mode write needs, once the server is listening. */
async function open(fixture:CrashFixture): Promise<{server:ChildProcess;token:string;headers:Record<string,string>;base:string}> {
  const started=fixture.start();
  await started.listening;
  const token=await waitFor(fixture.tokenOf);
  return {server:started.server,token,base:started.base,headers:{'x-dashboard-token':token,'content-type':'application/json',origin:started.base}};
}

/**
 * Wait until the harness has committed the tool call's own `execute` checkpoint, read-only. This is
 * for the pre-write kill only: the tool has started and the checkpoint is durable, so the restart
 * must report `interrupted` rather than execute it. The post-append test must NOT use this; it kills
 * immediately after the append and asserts the documented behaviour without a checkpoint wait.
 */
async function waitForToolCheckpoint(sessionFile:string):Promise<void> {
  await waitFor(async()=>{
    const {DatabaseSync}=await import('node:sqlite');
    let db:import('node:sqlite').DatabaseSync|undefined;
    try{
      db=new DatabaseSync(sessionFile,{readOnly:true});
      const rows=db.prepare('SELECT record FROM tasks').all() as {record:string}[];
      return rows.some(row=>{
        try{
          const record=JSON.parse(String(row.record)) as {kind?:string;state?:{checkpoint?:{phase?:string;replay?:string}}};
          return record.kind==='pi.tool'&&record.state?.checkpoint?.phase==='execute'&&record.state.checkpoint.replay==='unsafe';
        }catch{ return false; }
      })?true:undefined;
    }catch{ return undefined; }
    finally{ db?.close(); }
  },10000);
}

const agentView=async(base:string,projectId:string,token:string,sessionId?:string)=>
  (await (await fetch(base+'/api/projects/'+projectId+'/agents'+(sessionId?'?sessionId='+encodeURIComponent(sessionId):''),{headers:{'x-dashboard-token':token}})).json()) as {
    view:{working:boolean;entries:{kind:string;text:string;tools:{name:string}[]}[]}
  };

/**
 * A killed process must not leave the vault unusable, and a tool that already ran must not run
 * again. This spawns the real server bundle, kills it in the middle of a tool call, restarts it
 * on the same data, and checks what the durable session recorded.
 */
test('a run killed mid-tool resumes from its checkpoint and never replays an unsafe tool',async()=>{
  const fixture=await crashFixture({DASHBOARD_AGENT_NOTE_DELAY_MS:'5000'});
  let server:ChildProcess|null=null;
  try{
    const opened=await open(fixture);
    server=opened.server;
    const {base,headers}=opened;
    const project=await (await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Recovery fixture',managed:true,confirm:true})})).json() as { id: string; path: string };
    const agents=base+'/api/projects/'+project.id+'/agents';

    const started=await fetch(agents+'/input',{method:'POST',headers,body:JSON.stringify({text:'[slow-note kill me mid tool]',mode:'followUp',requestId:'recovery-run'})});
    assert.equal(started.status,200,'the run must be accepted: '+await started.text());
    await waitFor(async()=>{
      const current=await agentView(base,project.id,opened.token);
      return current.view.entries.some(entry=>entry.tools.some(tool=>tool.name==='record_note')) ? true : undefined;
    });
    // The visible tool call is the transcript's record; the execute checkpoint is the harness's.
    // Wait for the durable checkpoint before the kill, so this case is deterministic.
    await waitForToolCheckpoint(join(fixture.data,'agents',project.id,'session.sqlite'));
    await fixture.kill(server);
    server=null;

    // Fail closed: the killed process left its lock, so a restart refuses until an operator clears it.
    await fixture.refuseWhileLocked();

    const restarted=await open(fixture);
    server=restarted.server;
    const settled=await waitFor(async()=>{
      const current=await agentView(base,project.id,restarted.token);
      return current.view.entries.some(entry=>entry.kind==='tool') && !current.view.working ? current : undefined;
    });

    const kinds=settled.view.entries.map(entry=>entry.kind);
    assert.deepEqual(kinds,['user','system','assistant','tool','assistant'],'the run resumed and finished after the restart');
    const toolResult=settled.view.entries.find(entry=>entry.kind==='tool')!;
    assert.match(toolResult.text,/interrupted/i,'an unsafe tool reports that it was interrupted');
    assert.match(toolResult.text,/may have partially run/);
    // The unsafe tool was not replayed, so nothing was appended twice or at all.
    assert.equal(await readFile(join(project.path,'docs','notes.md'),'utf8').then(()=>true).catch(()=>false),false,'the interrupted write did not happen');
    assert.equal(settled.view.entries.filter(entry=>entry.kind==='user'&&entry.text.includes('kill me mid tool')).length,1,'the submission was not duplicated');

    // The same request id still finds the original submission after a restart.
    const replay=await (await fetch(agents+'/input',{method:'POST',headers:{...restarted.headers},body:JSON.stringify({text:'[slow-note kill me mid tool]',mode:'followUp',requestId:'recovery-run'})})).json() as { submissionId: string };
    await sleep(500);
    const after=await agentView(base,project.id,restarted.token);
    assert.equal(after.view.entries.filter(entry=>entry.kind==='user'&&entry.text.includes('kill me mid tool')).length,1,'a repeated request id adds nothing');
    assert.ok(replay.submissionId);
  }finally{
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await once(server,'exit').catch(()=>{});}
    await fixture.cleanup();
  }
});

/**
 * The post-append window: the append is the commit point, the harness is held after it, and the
 * process is killed immediately with no wait for a checkpoint. The next start must report the call
 * interrupted and leave exactly one line.
 *
 * The earlier version of this test did not actually wait for the append:
 * `readFile(...).then(text => text.includes(...))` returns `false`, and `false` is not `undefined`,
 * so its waiting helper returned at once. A kill before the append then let the restarted process
 * perform the only append and report `Recorded:` — which looked like a replay but was one
 * execution. The condition below returns `true`/`undefined`, so the kill follows the append. This
 * is not a checkpoint wait: it is the immediate-post-append condition itself.
 */
test('a kill immediately after the note append keeps one line and reports an interrupted call',async()=>{
  const fixture=await crashFixture({DASHBOARD_AGENT_NOTE_AFTER_WRITE_MS:'2000'});
  let server:ChildProcess|null=null;
  try{
    const opened=await open(fixture);
    server=opened.server;
    const {base,headers}=opened;
    const project=await (await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Mid-write recovery',managed:true,confirm:true})})).json() as { id: string; path: string };
    const session=(await (await fetch(base+'/api/sessions',{method:'POST',headers,body:JSON.stringify({projectId:project.id,name:'Post-append session'})})).json() as {session:{id:string}}).session;
    const lifecycle=async(token:string)=>await (await fetch(base+'/api/sessions/'+session.id+'/lifecycle?projectId='+project.id,{headers:{'x-dashboard-token':token}})).json() as {lifecycle:{state:string;uncertain:boolean;reason:string|null;requestId:string|null}};

    const agents=base+'/api/projects/'+project.id+'/agents';
    assert.equal((await fetch(agents+'/input',{method:'POST',headers,body:JSON.stringify({sessionId:session.id,text:'[slow-note post-append line]',mode:'followUp'})})).status,200);
    const notesFile=join(project.path,'docs','notes.md');
    // Wait for the append itself. `? true : undefined` matters: a `false` is not `undefined`, so a
    // `false` result would end the wait at once and the kill could land before the append. This is
    // not a checkpoint wait; it is the immediate-post-append condition the repro needs.
    await waitFor(async()=>await readFile(notesFile,'utf8').then(text=>text.includes('post-append line')?true:undefined).catch(()=>undefined),10000);
    assert.match((await lifecycle(opened.token)).lifecycle.state,/running/);
    // Kill immediately, with no checkpoint wait and no sleep: the repro must include the window
    // between the append and a restart's recovery decision.
    await fixture.kill(server);
    server=null;
    await fixture.refuseWhileLocked();

    const restarted=await open(fixture);
    server=restarted.server;
    // Adoption is written at startup, before anything listens; it is read before the harness is
    // opened, so this is the adopted record and not a later settled one.
    const adopted=(await lifecycle(restarted.token)).lifecycle;
    assert.equal(adopted.state,'interrupted');
    assert.equal(adopted.uncertain,true);
    assert.match(adopted.reason??'',/cannot be proven/i);
    assert.ok(adopted.requestId);

    // An uncertain interruption needs the owner: resume is refused and nothing is replayed.
    const revision=(await (await fetch(base+'/api/sessions/'+session.id+'/lifecycle?projectId='+project.id,{headers:{'x-dashboard-token':restarted.token}})).json() as {lifecycle:{revision:number}}).lifecycle.revision;
    const refusedResume=await fetch(base+'/api/sessions/'+session.id+'/lifecycle/resume',{method:'POST',headers:restarted.headers,body:JSON.stringify({projectId:project.id,revision})});
    assert.equal(refusedResume.status,409,'an uncertain interruption is operator attention, not a resume');
    assert.match((await refusedResume.json() as {error:string}).error,/uncertain effect|operator|replayed/i);

    const settled=await waitFor(async()=>{
      const current=await agentView(base,project.id,restarted.token,session.id);
      return current.view.entries.some(entry=>entry.kind==='tool') && !current.view.working ? current : undefined;
    },10000);
    // The line count is the primary assertion, so a failure names the duplicate append rather than
    // only the tool's wording.
    assert.equal(await readFile(notesFile,'utf8'),'post-append line\n','the committed line must stay exactly once; a second line is the unsafe replay');
    const toolResult=settled.view.entries.find(entry=>entry.kind==='tool')!;
    assert.match(toolResult.text,/interrupted/i,'the reopened call must be reported interrupted, never executed again');
    assert.equal(settled.view.entries.filter(entry=>entry.kind==='user').length,1,'no duplicate input was appended');
    // The adopted uncertainty is still visible after the harness has settled. This exposes the
    // current behaviour; it is not a policy decision. Whether an automatic continuation should
    // clear or retain this attention is an owner decision, and this test does not take it.
    const afterSettle=(await lifecycle(restarted.token)).lifecycle;
    assert.equal(afterSettle.state,'interrupted','current behaviour: the adopted uncertain interruption stays after the resumed generation settles');
    assert.equal(afterSettle.uncertain,true);
    assert.match(afterSettle.reason??'',/cannot be proven/i);
  }finally{
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await once(server,'exit').catch(()=>{});}
    await fixture.cleanup();
  }
});

/**
 * A kill between a durable queue claim and its submission. The claim is the durable intent and the
 * stable request identity, so after the restart the queue still names one submission and the
 * transcript holds none. Reconciliation reports the named operator-attention state, and the entry
 * is never submitted again.
 */
test('a kill between a queue claim and its submission leaves one claim, and reconciliation replays nothing',async()=>{
  const fixture=await crashFixture();
  let server:ChildProcess|null=null;
  try{
    const opened=await open(fixture);
    server=opened.server;
    const {base,headers}=opened;
    const project=await (await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Queue crash fixture',managed:true,confirm:true})})).json() as { id: string };
    const session=(await (await fetch(base+'/api/sessions',{method:'POST',headers,body:JSON.stringify({projectId:project.id,name:'Queue crash session'})})).json() as {session:{id:string}}).session;
    const queuePath=base+'/api/sessions/'+session.id+'/queue';
    const queue=async(token:string)=>{
      const response=await fetch(queuePath+'?projectId='+project.id,{headers:{'x-dashboard-token':token}});
      assert.equal(response.status,200,'the queue read must succeed: '+await response.clone().text());
      // The read route answers the queue view itself, not a wrapper around it.
      return await response.json() as {
        revision:number;entries:{id:string;state:string;text:string;claim:{owner:string;requestId:string;leaseExpiresAt:string}|null}[]
      };
    };
    const write=async(token:string,operation:string,body:Record<string,unknown>)=>
      await fetch(queuePath+'/'+operation,{method:'POST',headers:{'x-dashboard-token':token,'content-type':'application/json',origin:base},body:JSON.stringify({projectId:project.id,...body})});

    const appended=await write(opened.token,'append',{revision:(await queue(opened.token)).revision,text:'queued while the process dies'});
    assert.equal(appended.status,200);
    const entryId=((await appended.json()) as {entry:{id:string}}).entry.id;
    const claimed=await write(opened.token,'claim',{owner:'crash-dispatcher'});
    assert.equal(claimed.status,200);
    const claimBody=await claimed.json() as {outcome:string;entry:{state:string;claim:{owner:string;requestId:string}}};
    assert.equal(claimBody.outcome,'claimed');
    assert.equal(claimBody.entry.state,'claimed');
    const requestId=claimBody.entry.claim.requestId;
    assert.ok(requestId.length>0);

    // The claim was written and no submission started: the root transcript has no input.
    assert.equal((await agentView(base,project.id,opened.token)).view.entries.length,0,'a claim starts no run');
    await fixture.kill(server);
    server=null;
    await fixture.refuseWhileLocked();

    const restarted=await open(fixture);
    server=restarted.server;
    const after=await queue(restarted.token);
    assert.equal(after.entries.length,1,'the queue holds exactly one entry after the restart');
    assert.deepEqual(
      {id:after.entries[0].id,state:after.entries[0].state,owner:after.entries[0].claim?.owner,requestId:after.entries[0].claim?.requestId},
      {id:entryId,state:'claimed',owner:'crash-dispatcher',requestId},
      'the durable claim and its stable identity survive the crash'
    );
    assert.equal(after.revision,(await queue(restarted.token)).revision,'a read changes no revision');
    // No generation was ever recorded, so no false `running` was adopted.
    const lifecycle=await (await fetch(base+'/api/sessions/'+session.id+'/lifecycle?projectId='+project.id,{headers:{'x-dashboard-token':restarted.token}})).json() as {lifecycle:{state:string}};
    assert.equal(lifecycle.lifecycle.state,'idle');
    const view=await agentView(base,project.id,restarted.token);
    assert.equal(view.view.entries.length,0,'the restart dispatched nothing');
    assert.equal(view.view.working,false);

    // Reconciliation reads the transcript only. This instance has no read-back, so the queue says so
    // by name and does not send the entry again.
    const reconciled=await write(restarted.token,'reconcile',{entryId});
    assert.equal(reconciled.status,200);
    const reconcileBody=await reconciled.json() as {outcome:string;entry:{state:string;attention:{reason:string;detail:string}|null}};
    assert.equal(reconcileBody.outcome,'attention');
    assert.equal(reconcileBody.entry.state,'failed');
    assert.equal(reconcileBody.entry.attention?.reason,'submission-not-readable');
    assert.ok(!JSON.stringify(reconcileBody).includes(fixture.root),'the refusal names no filesystem path');

    const again=await write(restarted.token,'reconcile',{entryId});
    assert.equal(again.status,200);
    const againBody=await again.json() as {outcome:string;entry:{state:string;attention:{reason:string}|null}};
    assert.equal(againBody.entry.state,'failed');
    assert.equal(againBody.entry.attention?.reason,'submission-not-readable','a second reconciliation refreshes the named reason only');

    const afterReconcile=await agentView(base,project.id,restarted.token);
    assert.equal(afterReconcile.view.entries.length,0,'reconciliation sent nothing to the transcript');
    assert.equal(afterReconcile.view.working,false);
    const finalQueue=await queue(restarted.token);
    assert.equal(finalQueue.entries[0].state,'failed','a failed entry is never claimed or submitted again');
  }finally{
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await once(server,'exit').catch(()=>{});}
    await fixture.cleanup();
  }
});
