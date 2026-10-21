<script lang="ts">
 /**
  * The command palette: one surface, driven entirely by the registry.
  *
  * Nothing here lists a capability of its own. It asks the server which actions the authenticated
  * caller may use in the scope it is in, renders exactly those (label, id, description, parameters
  * and preconditions as the registry declares them), and executes through the same API route the
  * demo and the tests use. A refusal the server returns is shown as the server's own words; nothing
  * is swallowed and nothing is retried silently.
  *
  * Two things the palette deliberately reads from the server rather than assuming:
  *
  * - **The revision.** It is the one parameter a caller cannot know, so it is read from the read the
  *   registry names for it — the live projection for a lifecycle action, the session list for a
  *   session-record action — immediately before the form is shown. Nothing is pre-filled with a
  *   number the caller did not type unless the server reported that number.
  * - **The live projection.** The durable run state of each named session and the tool activity the
  *   harness really reports are shown as the server reports them, including the named reasons for
  *   anything it cannot report. The panel never fills a gap: an absent row or an empty conversation
  *   is shown as the named absence it is.
  *
  * The component is opened by the shell (⌘/Ctrl K), never by a key it intercepts itself while a text
  * field or editor has focus, so typing in a document or a task is never swallowed.
  */
 import { onMount } from 'svelte';
 import { api,ApiError } from './api';
 import type { ActionDescriptor,ActionParamType,LiveActivity,LiveRunState } from '../shared/actions';
 let {projectId=null,onclose=()=>{}}:{projectId:string|null;onclose:()=>void}=$props();
 let actions=$state<ActionDescriptor[]>([]),sessions=$state<{id:string;name:string;revision:number}[]>([]);
 let sessionId=$state(''),query=$state('');
 let loadState=$state<'loading'|'ready'|'error'>('loading'),loadError=$state('');
 let highlighted=$state(0),pending=$state<ActionDescriptor|null>(null);
 let values=$state<Record<string,string>>({}),running=$state(false);
 let message=$state(''),refusal=$state(''),result=$state('');
 // The live projection is fetched, never assumed: while it is missing, no revision is offered.
 let activity=$state<LiveActivity|null>(null),activityError=$state(''),activityRead=$state(false);
 let search=$state<HTMLInputElement>();
 const shown=$derived.by(()=>{
   const needle=query.trim().toLowerCase();
   if(needle==='')return actions;
   return actions.filter(action=>action.label.toLowerCase().includes(needle)||action.id.toLowerCase().includes(needle));
 });
 // The server filters by scope; the picker only decides which scope it asks in.
 async function load(){
   loadState='loading';loadError='';
   try{
     const view=await api.actions({...(projectId?{projectId}:{}),...(sessionId?{sessionId}:{})});
     actions=view.actions;highlighted=0;loadState='ready';
   }catch(error){actions=[];loadError=(error as Error).message;loadState='error';}
 }
 async function loadSessions(){
   if(!projectId){sessions=[];return;}
   try{const listed=await api.sessions(projectId);sessions=listed.sessions.map(session=>({id:session.id,name:session.name,revision:session.revision}));}
   catch{sessions=[];}
 }
 /** The live projection for this project, or the reason it could not be read. Nothing is inferred. */
 async function loadActivity(){
   activity=null;activityError='';activityRead=false;
   if(!projectId){activityRead=true;return;}
   try{activity=await api.actionActivity(projectId);}
   catch(error){activityError=(error as Error).message;}
   finally{activityRead=true;}
 }
 onMount(()=>{void loadSessions();void load();void loadActivity();queueMicrotask(()=>search?.focus());});
 /** A nested payload is entered as JSON text: an unparsable value is refused here, before the call. */
 const jsonTypes:ActionParamType[]=['session-link','session-links','session-model','approval-scope','approval-target'];
 function isJsonType(type:ActionParamType):boolean{return jsonTypes.includes(type);}
 function parseValue(action:ActionDescriptor,name:string,raw:string):unknown{
   const type=action.parameters.find(parameter=>parameter.name===name)?.type;
   const text=raw.trim();
   if(type==='revision')return Number(text);
   if(type!==undefined&&isJsonType(type))return JSON.parse(text);
   return text;
 }
 function parametersFor(action:ActionDescriptor):unknown{
   const params:Record<string,unknown>={};
   for(const parameter of action.parameters){
     const raw=(values[parameter.name]??'').trim();
     if(raw===''){if(parameter.required)throw new Error('The '+parameter.name+' parameter is required: '+parameter.description);continue;}
     params[parameter.name]=parseValue(action,parameter.name,raw);
   }
   return params;
 }
 async function execute(action:ActionDescriptor){
   running=true;refusal='';message='';result='';
   try{
     const params=parametersFor(action);
     const executed=await api.runAction(action.id,{params:params as Record<string,unknown>,scope:{...(projectId?{projectId}:{}),...(sessionId?{sessionId}:{})}});
     message='The handler returned this result for '+executed.action+'.';
     result=render(executed.result);
     // The picker and the projection may be stale after an action that changed a session or its
     // lifecycle; both are reads, and re-reading them shows the effect rather than assuming it.
     void loadSessions();void loadActivity();
   }catch(error){
     // The server's own refusal, in its own words. A network or session failure says so instead.
     refusal=error instanceof ApiError?'['+error.status+'] '+error.message:(error as Error).message;
   }finally{running=false;}
 }
 function render(value:unknown):string{
   let text:string;
   try{text=JSON.stringify(value,null,2)??String(value);}catch{text=String(value);}
   return text.length>4000?text.slice(0,4000)+'\n… (truncated for display)':text;
 }
 /** The run state of one session as the projection reports it, or null when it reports none. */
 function runOf(id:string):LiveRunState|null{
   return (activity?.sessions??[]).find(entry=>entry.sessionId===id)?.run??null;
 }
 /**
  * The revision the caller must send, read from the source the registry declares for it — and an
  * empty string when that read is unavailable, so the caller supplies it instead of the palette
  * guessing a number the server would refuse as a conflict.
  */
 function revisionFor(action:ActionDescriptor):string{
   const parameter=action.parameters.find(candidate=>candidate.name==='revision');
   if(parameter===undefined)return '';
   if(parameter.revisionSource==='session-lifecycle-revision')return sessionId===''?'':String(runOf(sessionId)?.revision??'');
   if(sessionId==='')return '';
   const listed=sessions.find(session=>session.id===sessionId);
   return listed===undefined?'':String(listed.revision);
 }
 /** Re-read the revision's source, so the form carries the value the store really holds right now. */
 async function refreshRevision(action:ActionDescriptor){
   const parameter=action.parameters.find(candidate=>candidate.name==='revision');
   if(parameter===undefined)return;
   if(parameter.revisionSource==='session-lifecycle-revision')await loadActivity();
   else await loadSessions();
   if(pending!==action)return;
   values[parameter.name]=revisionFor(action);
 }
 async function choose(action:ActionDescriptor){
   refusal='';message='';result='';
   if(action.parameters.length===0){void execute(action);return;}
   pending=action;values={};
   for(const parameter of action.parameters)values[parameter.name]=parameter.type==='revision'?revisionFor(action):'';
   await refreshRevision(action);
 }
 function keydown(event:KeyboardEvent){
   if(event.key==='Escape'){event.preventDefault();pending=null;onclose();return;}
   if(pending)return;
   if(event.key==='ArrowDown'||event.key==='ArrowUp'){
     event.preventDefault();
     if(shown.length===0)return;
     const step=event.key==='ArrowDown'?1:shown.length-1;
     highlighted=(highlighted+step)%shown.length;
     return;
   }
   if(event.key==='Enter'&&shown[highlighted]){event.preventDefault();void choose(shown[highlighted]);}
 }
 function minor(action:ActionDescriptor):string{return action.writes?'writes durable state':'read-only';}
 /** The run state the projection reports for the chosen session, or for the first few sessions. */
 function runSummary():string{
   const listed=activity?.sessions??[];
   if(listed.length===0)return 'No named session is registered for this project, so no run state is reported.';
   const chosen=sessionId===''?undefined:listed.find(entry=>entry.sessionId===sessionId);
   const shownSessions=chosen===undefined?listed.slice(0,3):[chosen];
   const parts=shownSessions.map(entry=>entry.run.recorded
     ?entry.name+': '+entry.run.state+' at revision '+entry.run.revision+', attempt '+entry.run.attempt+(entry.run.reason?' — '+entry.run.reason:'')+(entry.run.uncertain?' (interrupted, and not proven idempotent)':'')
     :entry.name+': no durable lifecycle row is recorded ('+entry.run.absenceReason+'). '+entry.run.absenceDetail);
   const hidden=listed.length-shownSessions.length;
   return 'Run state — '+parts.join(' · ')+(hidden>0?' · and '+hidden+' more session'+(hidden===1?'':'s')+'; choose one to see its state.':'');
 }
 /** What the harness reports about tool activity, or the named reason it reports none. */
 function harnessSummary():string{
   const tool=activity?.harness;
   if(!tool)return '';
   if(tool.state==='reported')return 'Tool activity: reported by '+tool.source+': '+tool.invocations.length+' call(s) and '+tool.results.length+' result(s)'+(tool.truncated?' (bounded: the most recent are shown)':'')+'. A call and a result are two lists: the view carries no call id, so nothing here pairs them.';
   return 'Tool activity: '+tool.state+' ('+tool.reason+') — '+tool.detail;
 }
 function instant(at:number|null):string{return at===null?'no instant reported':'at '+new Date(at).toISOString();}
</script>
<div class="palette-backdrop" role="presentation" onclick={(event)=>{if(event.target===event.currentTarget)onclose();}}>
 <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
  <header class="palette-head">
   <span class="popover-heading">COMMANDS</span>
   <span class="palette-scope">{projectId?'Project '+projectId.slice(0,8):'No project scope'}</span>
   <button class="icon-button" aria-label="Close command palette" onclick={onclose}>×</button>
  </header>
  <div class="palette-filters">
   <input bind:this={search} aria-label="Search actions" placeholder="Filter by label or action id" bind:value={query} onkeydown={keydown}>
   {#if projectId}
   <select aria-label="Session scope" bind:value={sessionId} onchange={()=>void load()}>
    <option value="">No session (project scope only)</option>
    {#each sessions as session}<option value={session.id}>{session.name}</option>{/each}
   </select>
   {/if}
  </div>
  {#if projectId}
  <section class="palette-activity" aria-label="Live projection">
   <span class="popover-heading">LIVE PROJECTION</span>
   {#if !activityRead}<p class="palette-note" role="status">Reading the live projection…</p>
   {:else if activityError}<p class="palette-note" role="status">The live projection could not be read, so no revision is offered and none is assumed: {activityError}</p>
   {:else if activity}
   <p class="palette-note" role="status">{runSummary()}</p>
   <p class="palette-note" role="status">{harnessSummary()}</p>
   {#if activity.harness.invocations.length||activity.harness.results.length}
   <ul class="palette-events">
    {#each activity.harness.invocations.slice(0,6) as invocation}
    <li><code>call</code> {invocation.name} {instant(invocation.at)}</li>
    {/each}
    {#each activity.harness.results.slice(0,6) as completed}
    <li><code>result</code> {completed.outcome} — {completed.errors} error(s), {completed.warnings} warning(s), {completed.notices} notice(s) {instant(completed.at)}</li>
    {/each}
    {#if activity.truncated||activity.harness.truncated}
    <li>Bounded: at most {activity.limits.sessions} sessions and {activity.limits.toolEvents} events per list are reported.</li>
    {/if}
   </ul>
   {/if}
   {/if}
  </section>
  {/if}
  {#if loadState==='loading'}<p class="palette-note" role="status">Reading the registry…</p>
  {:else if loadState==='error'}<p class="error" role="alert">{loadError}</p>
  {:else if pending}
  <form class="palette-form" onsubmit={(event)=>{event.preventDefault();void execute(pending!);}}>
   <p class="palette-note"><strong>{pending.label}</strong> · <code>{pending.id}</code> · {minor(pending)}</p>
   <p class="palette-note">{pending.description}</p>
   {#each pending.parameters as parameter}
   <label>{parameter.name}{parameter.required?' *':' (optional)'}
    {#if isJsonType(parameter.type)}
    <textarea rows="2" aria-label={parameter.name} bind:value={values[parameter.name]}></textarea>
    {:else}
    <input aria-label={parameter.name} bind:value={values[parameter.name]}>
    {/if}
    <small>{parameter.description}{parameter.validatedBy?' (validated by '+parameter.validatedBy+')':''}</small>
   </label>
   {/each}
   {#if pending.preconditions.length}
   <ul class="palette-preconditions">{#each pending.preconditions as precondition}<li><code>{precondition.code}</code> {precondition.description}</li>{/each}</ul>
   {/if}
   <div class="row">
    <button class="primary" type="submit" disabled={running}>{running?'Running…':'Execute action'}</button>
    <button type="button" onclick={()=>{pending=null;refusal='';message='';}}>Back to the list</button>
   </div>
  </form>
  {:else}
  {#if shown.length===0}<p class="palette-note" role="status">No action of the registry matches “{query}” in this scope.</p>
  {:else}
  <ul class="palette-list">
   {#each shown as action, index}
   <li><button class:highlighted={index===highlighted} aria-label={action.label} onclick={()=>void choose(action)}>
    <span class="palette-label">{action.label}</span>
    <code class="palette-id">{action.id}</code>
    <small>{action.description} · {minor(action)}{action.parameters.length?' · '+action.parameters.length+' parameter'+(action.parameters.length===1?'':'s'):' · no parameters'}</small>
   </button></li>
   {/each}
  </ul>
  {/if}
  {/if}
  {#if refusal}<p class="error" role="alert">{refusal}</p>{/if}
  {#if message}<p class="palette-note" role="status">{message}</p>{/if}
  {#if result}<pre class="palette-result" aria-label="Action result payload">{result}</pre>{/if}
 </div>
</div>
<style>
 .palette-backdrop{position:fixed;inset:0;z-index:80;background:#040b15b3;display:flex;justify-content:center;align-items:flex-start;padding:8vh 12px 12px}
 .palette{width:min(680px,96vw);max-height:80dvh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-top:2px solid var(--accent);border-radius:8px;box-shadow:var(--shadow);padding:14px}
 .palette-head{display:flex;align-items:center;gap:10px}
 .palette-head .popover-heading{padding:0}
 .palette-scope{margin-left:auto;font:9px var(--mono);color:var(--muted)}
 .palette-filters{display:flex;gap:8px;margin:10px 0}
 .palette-filters input{flex:1}
 .palette-filters select{width:auto;min-width:180px}
 .palette-activity{border:1px solid var(--line);border-radius:5px;background:var(--bg);padding:8px 10px;margin-bottom:8px;max-height:24dvh;overflow:auto}
 .palette-activity .popover-heading{padding:0}
 .palette-activity .palette-note{margin:4px 0}
 .palette-events{list-style:none;margin:0;padding:0;color:var(--muted);font:10px/1.7 var(--mono)}
 .palette-list{list-style:none;margin:0;padding:0;max-height:52dvh;overflow:auto}
 .palette-list button{display:flex;flex-direction:column;gap:3px;align-items:flex-start;width:100%;border:1px solid transparent;background:none;text-align:left;padding:8px}
 .palette-list button.highlighted{background:var(--raised);border-color:color-mix(in srgb,var(--accent) 30%,var(--line))}
 .palette-list small{color:var(--muted);font-size:10px}
 .palette-label{font-size:12px;color:var(--ink)}
 .palette-id{font:9px var(--mono);color:var(--accent)}
 .palette-form{display:flex;flex-direction:column}
 .palette-form label{color:var(--ink)}
 .palette-form label small{color:var(--muted);font-weight:400}
 .palette-note{color:var(--muted);font-size:11px;line-height:1.6;margin:6px 0}
 .palette-preconditions{margin:4px 0 10px;padding-left:18px;color:var(--muted);font-size:10px;line-height:1.7}
 .palette-result{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:10px;font:11px/1.5 var(--mono);overflow:auto;max-height:28dvh;color:var(--ink)}
</style>
