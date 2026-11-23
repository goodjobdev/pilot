<script lang="ts">
 import { api } from './api';
 import type { AgentView } from '../shared/agent';
 import { toolOutcomeLabel } from '../shared/activity';
 import type { LiveActivity, LiveRunState } from '../shared/actions';

 /**
  * The compact activity timeline of the session on screen.
  *
  * Every value comes from the live projection: the durable run state of the selected named session
  * and the tool events the harness really recorded for its conversation. The component adds no
  * event, attributes no result to a call and never invents an instant or a duration. A value the
  * projection does not report is shown with the reason it names.
  *
  * The request carries the selected session id, and a generation guard discards a response that
  * belongs to a session the reader has already left. A session switch clears the previous timeline
  * before the new request starts.
  */
 let { projectId,sessionId='',view=null }:{
  projectId:string; sessionId?:string; view?:AgentView|null;
 }=$props();

 /** The smallest useful bound on a phone; the payload itself is bounded separately at 50 per list. */
 const DISPLAY_LIMIT=2;
 let activity=$state<LiveActivity|null>(null),error=$state(''),reading=$state(false);
 let generation=0,timer:ReturnType<typeof setTimeout>|null=null;

 function schedule():void{
  if(timer!==null)clearTimeout(timer);
  timer=setTimeout(()=>{timer=null;void load();},150);
 }
 async function load():Promise<void>{
  const mine=++generation;
  reading=true;error='';
  try{
   const next=await api.actionActivity(projectId,sessionId||undefined);
   if(mine!==generation)return;
   activity=next;
  }catch(caught){
   if(mine!==generation)return;
   activity=null;error=(caught as Error).message;
  }finally{
   if(mine===generation)reading=false;
  }
 }
 // A project or session change is a new identity: drop the old projection at once and discard any
 // response still in flight for it.
 $effect(()=>{
  void projectId;void sessionId;
  activity=null;error='';generation+=1;
  if(timer!==null){clearTimeout(timer);timer=null;}
  schedule();
  return()=>{if(timer!==null){clearTimeout(timer);timer=null;}};
 });
 // The streamed view is the transcript's own progress signal: re-read the projection when a commit
 // lands. The timer keeps a burst of frames to one request.
 $effect(()=>{void view?.updatedAt;void view?.working;schedule();});

 const run=$derived<LiveRunState|null>(sessionId===''?null:(activity?.sessions.find(entry=>entry.sessionId===sessionId)?.run??null));
 const harness=$derived(activity?.harness??null);
 const calls=$derived([...(harness?.invocations??[])].slice(-DISPLAY_LIMIT).reverse());
 const results=$derived([...(harness?.results??[])].slice(-DISPLAY_LIMIT).reverse());
 const omittedCalls=$derived((harness?.omitted.invocations??0)+Math.max(0,(harness?.invocations.length??0)-DISPLAY_LIMIT));
 const omittedResults=$derived((harness?.omitted.results??0)+Math.max(0,(harness?.results.length??0)-DISPLAY_LIMIT));
 const newestAt=$derived.by(()=>{
  const instants=[...(harness?.invocations??[]),...(harness?.results??[])].flatMap(entry=>entry.at===null?[]:[entry.at]);
  return instants.length===0?null:Math.max(...instants);
 });

 function instant(at:number|null,reason:string|null):string{
  return at===null?'no instant ('+(reason??'no reason reported')+')':new Date(at).toISOString();
 }
 /** A call's instant is the assistant message that carried it, never a separately recorded tool start. */
 function callInstant(at:number|null,reason:string|null):string{
  return at===null?'assistant message instant not reported ('+(reason??'no reason reported')+')':'assistant message recorded at '+new Date(at).toISOString();
 }
 function recorded(value:string|null):string{return value===null?'no instant reported by the durable record':'at '+value;}
 function duration(ms:number|null,reason:string|null):string{
  return ms===null?'no duration ('+(reason??'no reason reported')+')':ms+' ms';
 }
</script>
<section class="session-activity" aria-label="Session activity">
 <div class="activity-head">
  <span class="eyebrow">ACTIVITY</span>
  {#if reading}<span class="activity-reading" role="status">reading the projection…</span>{/if}
 </div>
 {#if error}
 <p class="activity-absence" role="status">The activity projection could not be read, so no run state or tool event is assumed: {error}</p>
 {:else if sessionId===''}
 <p class="activity-absence" role="status">No session is selected, so no durable run state is reported. Tool activity for the conversation in this scope is shown when the harness reports it.</p>
 {:else if activity&&run===null}
 <p class="activity-absence" role="status">{activity.truncated?'The projection reached its session bound and does not include the session in this scope, so no run state is reported.':'The projection reports no run state for this scope.'}</p>
 {:else if run}
  {#if run.recorded}
  <p class="activity-run"><strong>{run.state}</strong> · revision {run.revision} · attempt {run.attempt}{run.reason?' · '+run.reason:''}{run.uncertain?' · uncertain interruption':''}</p>
  <p class="activity-meta">Last durable activity {recorded(run.activityAt)} · record updated {recorded(run.updatedAt)}</p>
  {:else}
  <p class="activity-absence" role="status">No run state is reported: {run.absenceReason}. {run.absenceDetail}</p>
  {/if}
 {/if}
 {#if harness}
  {#if harness.state==='reported'}
   <p class="activity-meta">Newest recorded call or result instant: {newestAt===null?'none reported':new Date(newestAt).toISOString()} · source {harness.source}</p>
   {#if calls.length}
   <ul class="activity-events" aria-label="Recent tool calls">
    {#each calls as call,index (index)}
    <li><code>call</code> {call.name} · {callInstant(call.at,call.atReason)}</li>
    {/each}
   </ul>
   {/if}
   {#if results.length}
   <ul class="activity-events" aria-label="Recent tool results">
    {#each results as result,index (index)}
    <li><code>result</code> {result.name??'tool'} · {toolOutcomeLabel(result)} · {result.errors} error(s), {result.warnings} warning(s), {result.notices} notice(s) · {duration(result.durationMs,result.durationReason)} · {instant(result.at,result.atReason)}</li>
    {/each}
   </ul>
   {/if}
   {#if omittedCalls>0||omittedResults>0}
   <p class="activity-limit" role="status">Bounded: showing the {calls.length} most recent call(s) and {results.length} most recent result(s). {omittedCalls} older call(s) and {omittedResults} older result(s) are not shown.</p>
   {/if}
   <p class="activity-meta">Calls and results are separate records from {harness.source}; this projection carries no call identity, so they are not paired. A call instant is the assistant message's recorded time, not a tool start.</p>
  {:else}
   <p class="activity-absence" role="status">No tool activity: {harness.reason} — {harness.detail}</p>
  {/if}
  <p class="activity-meta">Bounds: at most {activity?.limits.toolEvents??0} events per list and {activity?.limits.sessions??0} sessions. Working: {harness.working===null?'not reported':harness.working?'yes':'no'}.</p>
 {/if}
</section>
<style>
 .session-activity{border-bottom:1px solid var(--line);background:var(--panel);padding:6px 12px;max-height:18dvh;overflow:auto}
 .activity-head{display:flex;align-items:center;gap:8px}
 .activity-reading{font:9px var(--mono);color:var(--muted)}
 .session-activity p{margin:3px 0;font-size:11px;overflow-wrap:anywhere}
 .activity-run{color:var(--text)}
 .activity-meta{color:var(--muted);font:10px var(--mono)}
 .activity-absence{color:var(--muted)}
 .activity-events{list-style:none;margin:3px 0;padding:0;display:flex;flex-direction:column;gap:2px}
 .activity-events li{font:10px var(--mono);overflow-wrap:anywhere}
 .activity-limit{color:var(--muted);font:10px var(--mono)}
</style>
