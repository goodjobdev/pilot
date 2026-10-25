<script lang="ts">
 import {onMount} from 'svelte';
 import {api,ApiError} from './api';
 import type {WorkerView} from './api';
 import {modelKey} from '../shared/settings';
 import type {WorkerRecord, WorkerRun} from '../shared/workers';

 /**
  * The owner's minimal worker surface (W1).
  *
  * It lists this project's owner-created workers and their runs, creates a worker from the owner's
  * policy models and the installed worker scopes, starts one bounded run, stops a run and revokes a
  * worker. It is not the enforcement point: every refusal is the server's own, shown here as it
  * arrived. A report is only a path to read; nothing here accepts it.
  */
 let {projectId,onclose}:{projectId:string;onclose:()=>void}=$props();
 let dialog:HTMLDialogElement;
 let view=$state<WorkerView|null>(null);
 let name=$state(''),choice=$state(''),scopes=$state<string[]>(['read_notes']);
 let problem=$state(''),message=$state(''),busy=$state(false);
 onMount(()=>{
  dialog.showModal();
  void load();
  // Bounded refresh while the dialog is open: it also picks up a changed canonical report, so an
  // integrity warning is visible without a reload. The server reads at most the newest 20 reports.
  const timer=setInterval(()=>void load(true),2000);
  return ()=>clearInterval(timer);
 });
 async function load(quiet=false){
  try{
   const next=await api.workers(projectId);
   view=next;
   if(!quiet&&choice===''){
    const preferred=next.policy?.defaultWorkerModel??next.policy?.allowedWorkerModels[0]??null;
    choice=preferred?modelKey(preferred):'';
   }
  }catch(error){if(!quiet)problem=(error as Error).message;}
 }
 async function action(work:()=>Promise<void>){
  if(busy)return;
  busy=true;problem='';message='';
  try{await work();}catch(error){
   problem=error instanceof ApiError?error.message:(error as Error).message;
  }finally{busy=false;}
 }
 async function create(){
  await action(async()=>{
   const chosen=view?.policy?.allowedWorkerModels.find(model=>modelKey(model)===choice)??undefined;
   await api.createWorker(projectId,{name, ...(chosen?{model:chosen}:{}), scopes});
   name='';message='Worker created. Its model is pinned; the run uses the application harness.';
   await load(true);
  });
 }
 async function run(worker:WorkerRecord){
  await action(async()=>{
   await api.startWorkerRun(projectId,worker.id);
   message='Run admitted. It runs one bounded model conversation and writes the report.';
   await load(true);
  });
 }
 async function stop(run:WorkerRun){
  await action(async()=>{
   await api.stopWorkerRun(projectId,run.id);
   message='Stop requested. A committed report is not rolled back.';
   await load(true);
  });
 }
 async function revoke(worker:WorkerRecord){
  if(!confirm('Revoke "'+worker.name+'"? It blocks every new run and cancels an active run. Effects already committed stay.'))return;
  await action(async()=>{
   await api.revokeWorker(projectId,worker.id,worker.revision);
   message='Worker revoked. A new run is refused; an active run was cancelled cooperatively.';
   await load(true);
  });
 }
 const models=$derived(view?.policy?.allowedWorkerModels??[]);
 const installed=$derived(view?.scopes??[]);
 function runsOf(worker:WorkerRecord):WorkerRun[]{return (view?.runs??[]).filter(run=>run.workerId===worker.id);}
 function activeRun():WorkerRun|null{return (view?.runs??[]).find(run=>run.state==='running')??null;}
</script>

<dialog bind:this={dialog} oncancel={onclose} class="workers">
 <header class="modal-head"><div><span class="eyebrow">BOUNDED WORKERS</span><h2>Workers</h2></div><button aria-label="Close workers" onclick={onclose}>×</button></header>
 <p class="muted">Only the owner creates a worker. Its model is pinned from the allowed worker set, its scopes are default-deny, and one run at a time uses the application harness. Reports are untrusted evidence and are never accepted automatically.</p>
 {#if view}
  <p class="limits" aria-label="Worker limits">Limits: {view.limits.maxLiveWorkersPerProject} live workers per project · {view.limits.maxActiveRunsPerProject} active run · {view.limits.maxModelTurnsPerRun} model turns · {view.limits.maxOutputTokensPerTurn} output tokens per turn</p>
  <p class="muted">This project has {view.liveWorkers} live worker{view.liveWorkers===1?'':'s'}.</p>
 {/if}
 {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
 {#if message}<p class="notice" role="status">{message}</p>{/if}

 <fieldset disabled={busy||!view}>
  <legend>Create a worker</legend>
  {#if view&&(view.policy===null||models.length===0)}
   <p class="muted">No owner worker model policy is saved. Save an allowed worker set and an optional default in Providers &amp; models before creating a worker.</p>
  {/if}
  <label>Name<input aria-label="Worker name" bind:value={name} maxlength="80" placeholder="Reviewer" /></label>
  <label>Pinned model<select aria-label="Worker model" bind:value={choice}>
   {#if models.length===0}<option value="">no allowed model</option>{/if}
   {#each models as model}<option value={modelKey(model)}>{modelKey(model)}</option>{/each}
  </select></label>
  <fieldset class="scope-list"><legend>Scopes (default deny)</legend>
   {#each installed as scope}
    <label class="check"><input type="checkbox" checked={scopes.includes(scope)} onchange={(event)=>{const on=(event.currentTarget as HTMLInputElement).checked;scopes=on?[...scopes,scope]:scopes.filter(value=>value!==scope);}} />{scope}</label>
   {/each}
  </fieldset>
  <button class="primary" disabled={name.trim()===''||models.length===0} onclick={()=>void create()}>Create worker</button>
 </fieldset>

 {#if view&&view.workers.length===0}<p class="muted">No workers in this project.</p>{/if}
 {#if view}
  <ul class="worker-list" aria-label="Workers">
   {#each view.workers as worker (worker.id)}
    <li class="worker">
     <div class="worker-head"><strong>{worker.name}</strong><span class="state" class:revoked={worker.state==='revoked'}>{worker.state}</span></div>
     <div class="detail">Model <code>{modelKey(worker.model)}</code></div>
     <div class="detail">Scopes {worker.scopes.length?worker.scopes.join(', '):'none — every tool is refused'}</div>
     <div class="detail">Budgets {worker.budgets.maxModelTurns} turns · {worker.budgets.maxOutputTokensPerTurn} output tokens per turn</div>
     <div class="row">
      {#if worker.state==='active'}
       <button class="compact-button" disabled={busy||view.activeRunId!==null} onclick={()=>void run(worker)}>Start one run</button>
       {#if activeRun()}<button class="compact-button" aria-label="Stop the active worker run" disabled={busy} onclick={()=>void stop(activeRun()!)}>Stop active run</button>{/if}
       <button class="compact-button danger-command" disabled={busy} onclick={()=>void revoke(worker)}>Revoke</button>
      {:else}<span class="muted">Revoked. It can start no run; its records stay as history.</span>{/if}
     </div>
     {#if runsOf(worker).length>0}
      <ul class="run-list" aria-label="Runs">
       {#each runsOf(worker) as run (run.id)}
        <li class="run">
         <span class="state" class:failed={run.state==='failed'||run.state==='interrupted'}>{run.state}</span>
         <span class="detail">{run.turns} turn{run.turns===1?'':'s'}</span>
         {#if run.report}<span class="detail report">Report <code>{run.report.path}</code> · {run.report.bytes} bytes</span>{:else}<span class="detail">No report</span>{/if}
         {#if run.report && view?.reportIntegrity?.[run.id] && view.reportIntegrity[run.id].state !== 'intact'}
          <span class="detail warning" role="status">The canonical report is {view.reportIntegrity[run.id].state} since tracking. The Markdown file is authoritative.</span>
         {/if}
         {#if run.reason}<span class="detail reason">{run.reason}</span>{/if}
        </li>
       {/each}
      </ul>
     {/if}
    </li>
   {/each}
  </ul>
 {/if}
</dialog>

<style>
 .workers{width:min(620px,96vw);max-height:88vh;overflow:auto}
 .limits{font:10px var(--mono);letter-spacing:.4px;color:var(--muted);overflow-wrap:anywhere}
 .scope-list{display:flex;flex-wrap:wrap;gap:6px 14px;border:1px solid var(--line);border-radius:5px;padding:8px 10px}
 .scope-list legend{font:9px var(--mono);letter-spacing:1px;color:var(--muted);text-transform:uppercase}
 .check{display:flex;align-items:center;gap:6px;font-size:12px}
 .worker-list{list-style:none;display:flex;flex-direction:column;gap:10px;padding:0;margin:0}
 .worker{border:1px solid var(--line);border-radius:6px;padding:10px;background:var(--panel);min-width:0}
 .worker-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
 .detail{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
 .report code{word-break:break-all}
 .reason{color:var(--danger,#b42318)}
 .warning{color:var(--danger,#b42318);font-weight:600}
 .state{font:9px var(--mono);letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}
 .state.revoked,.state.failed{color:var(--danger,#b42318)}
 .run-list{list-style:none;margin:8px 0 0;padding:6px 0 0;border-top:1px dashed var(--line);display:flex;flex-direction:column;gap:6px}
 .run{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;min-width:0}
 .row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
 .problem{color:var(--danger,#b42318)}
 @media (max-width:520px){.workers{width:100vw;max-width:100vw;max-height:100vh;border-radius:0;padding:12px}}
</style>
