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
    if (value !== undefined) return value;
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
 * A killed process must not leave the vault unusable, and a tool that already ran must not run
 * again. This spawns the real server bundle, kills it in the middle of a tool call, restarts it
 * on the same data, and checks what the durable session recorded.
 */
test('a run killed mid-tool resumes from its checkpoint and never replays an unsafe tool',async()=>{
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
  const env={ ...process.env,DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:String(port),DASHBOARD_AGENTS:'on',DASHBOARD_AGENT_PAUSE_MS:'100',DASHBOARD_REGISTRY:'',DASHBOARD_ROOTS:'' };
  const startServer=()=>spawn(process.execPath,[join(release,'server.mjs')],{env,stdio:['ignore','pipe','pipe']});
  const waitForListening=(child:ChildProcess)=>new Promise<void>((ok,fail)=>{
    const timer=setTimeout(()=>fail(Error('the server did not start listening')),10000);
    child.stdout!.on('data',chunk=>{ if(String(chunk).includes('Dashboard listening')){clearTimeout(timer);ok();} });
    child.once('exit',code=>{clearTimeout(timer);fail(Error('the server exited early with '+code));});
  });
  const tokenOf=async():Promise<string|undefined>=>{
    try{
      const html=await (await fetch(base+'/')).text();
      const match=html.match(/name="dashboard-token" content="([a-f0-9]+)"/);
      return match ? match[1] : undefined;
    }catch{ return undefined; }
  };
  let server:ChildProcess|null=null;
  try{
    server=startServer();
    await waitForListening(server);
    const token=await waitFor(tokenOf);
    const headers={ 'x-dashboard-token': token,'content-type':'application/json',origin: base };
    const project=await (await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Recovery fixture',managed:true,confirm:true})})).json() as { id: string; path: string };
    const agents=base+'/api/projects/'+project.id+'/agents';
    const view=async(auth:{'x-dashboard-token':string})=>(await (await fetch(agents,{headers:auth})).json()) as { view: { working: boolean; entries: { kind: string; text: string; tools: { name: string }[] }[] } };

    const started=await fetch(agents+'/input',{method:'POST',headers,body:JSON.stringify({text:'[slow-note kill me mid tool]',mode:'followUp',requestId:'recovery-run'})});
    assert.equal(started.status,200,'the run must be accepted: '+await started.text());
    await waitFor(async()=>{
      const current=await view({'x-dashboard-token':token});
      return current.view.entries.some(entry=>entry.tools.some(tool=>tool.name==='record_note')) ? true : undefined;
    });
    server.kill('SIGKILL');
    await once(server,'exit');
    server=null;

    // Fail closed: the killed process left its lock, so a restart refuses until an operator clears it.
    const refused=startServer();
    let refusal='';
    refused.stderr.on('data',chunk=>{refusal+=String(chunk);});
    const [refusedCode]=await once(refused,'exit') as [number];
    assert.notEqual(refusedCode,0,'a restart on a locked data root must fail');
    assert.match(refusal,/locked/);
    assert.equal(await stat(join(data,'service.lock')).then(()=>true),true,'the stale lock is still present, not stolen');
    await unlink(join(data,'service.lock'));

    server=startServer();
    await waitForListening(server);
    const token2=await waitFor(tokenOf);
    const auth2={'x-dashboard-token':token2};
    const settled=await waitFor(async()=>{
      const current=await view(auth2);
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
    const replay=await (await fetch(agents+'/input',{method:'POST',headers:{...auth2,'content-type':'application/json',origin:base},body:JSON.stringify({text:'[slow-note kill me mid tool]',mode:'followUp',requestId:'recovery-run'})})).json() as { submissionId: string };
    await sleep(500);
    const after=await view(auth2);
    assert.equal(after.view.entries.filter(entry=>entry.kind==='user'&&entry.text.includes('kill me mid tool')).length,1,'a repeated request id adds nothing');
    assert.ok(replay.submissionId);
  }finally{
    if(server&&server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await once(server,'exit').catch(()=>{});}
    await rm(root,{recursive:true,force:true});
  }
});
