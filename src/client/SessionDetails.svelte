<script lang="ts">
 import {api} from './api';
 import type {AgentView} from '../shared/agent';
 import type {SessionBindingView,SessionOverview} from './api';

 /**
  * The current session's details: what the owner asked Pi to work under.
  *
  * Every value is read, never invented. The effective model, the lifecycle state and the agent and
  * scopes in force come from the server; the usage counters come from the same usage projection the
  * transcript header already reads (extended with the provider-reported cache counters). A fact the
  * harness does not report is shown as a **named absence** ("not reported"), never as a fabricated zero.
  */
 let {projectId,sessionId,view=null,binding=null,session=null}:{
  projectId:string; sessionId:string; view?:AgentView|null;
  binding?:SessionBindingView|null; session?:SessionOverview|null;
 }=$props();

 let open=$state(false);

 /** The provider-reported usage detail the harness attaches to the shaped view, when present. */
 const detail=$derived((view as (AgentView & {usageDetail?:{input:number;output:number;cacheRead:number;cacheWrite:number;totalTokens:number;reasoning:number|null;cost:number;models:unknown[]}}) | null)?.usageDetail??null);
 const authority=$derived(binding?.authority??null);
 /** The project scope line: every project, or the explicit set. */
 const projectLine=$derived(authority===null?'':authority.projects===null?(authority.agentId===null?'every project (the owner\u2019s own dispatch)':'all projects'):authority.projects.join(', '));
</script>
<section class="session-details" aria-label="Session details">
 <button class="text-button details-toggle" aria-expanded={open} onclick={()=>open=!open}>{open?'Hide session details':'Session details'}</button>
 {#if open}
 <div class="details-body">
  <div class="detail"><span class="detail-label">Session</span><span class="detail-value">{session?.name??('conversation '+sessionId)}</span></div>
  <div class="detail"><span class="detail-label">Effective model</span><span class="detail-value">{view?.model?view.model.provider+' / '+view.model.modelId:'not reported by this harness'}</span></div>
  <div class="detail"><span class="detail-label">Lifecycle</span><span class="detail-value">{session?.lifecycle.recorded?(session.lifecycle.state+(session.lifecycle.reason?' — '+session.lifecycle.reason:'')):'no durable lifecycle record'}</span></div>
  <div class="detail"><span class="detail-label">Agent in force</span><span class="detail-value">{authority===null?'unknown (no binding read)':authority.agentId===null?(authority.emptyReason??'no agent is bound'):authority.agentId}</span></div>
  <div class="detail"><span class="detail-label">Scopes in effect</span><span class="detail-value">{authority===null?'unknown':authority.scopes===null?'the owner\u2019s own dispatch (nothing narrowed)':authority.scopes.length===0?'none — every tool is refused':(()=>{
      const B=['ask_question','record_note','read_notes'];
      const g=authority.scopes;
      const i=g.filter(s=>B.includes(s));
      const u=g.filter(s=>!B.includes(s));
      if(u.length===0)return g.join(', ');
      return (i.length?i.join(', '):'(none)')+'; '+u.join(', ')+' [unavailable]';
    })()}</span></div>
  <div class="detail"><span class="detail-label">Project scope</span><span class="detail-value">{projectLine||'unknown'}</span></div>
  <div class="detail"><span class="detail-label">Tokens in</span><span class="detail-value">{view?String(view.usage.input):'not reported'}</span></div>
  <div class="detail"><span class="detail-label">Tokens out</span><span class="detail-value">{view?String(view.usage.output):'not reported'}</span></div>
  <div class="detail"><span class="detail-label">Cache hits (read)</span><span class="detail-value">{detail?String(detail.cacheRead):'not reported by this harness'}</span></div>
  <div class="detail"><span class="detail-label">Cache writes</span><span class="detail-value">{detail?String(detail.cacheWrite):'not reported by this harness'}</span></div>
  <div class="detail"><span class="detail-label">Context usage</span><span class="detail-value">not reported by this harness</span></div>
  <div class="detail"><span class="detail-label">Cost</span><span class="detail-value">{detail&&detail.models.length>0?String(detail.cost):'not reported by the provider'}</span></div>
 </div>
 {/if}
</section>
<style>
 .session-details{display:flex;flex-direction:column;gap:8px}
 .details-toggle{align-self:flex-start}
 .details-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 14px;border:1px solid var(--line);border-radius:5px;background:var(--panel);padding:10px 12px}
 .detail{display:flex;flex-direction:column;gap:2px;min-width:0}
 .detail-label{font:9px var(--mono);letter-spacing:1px;color:var(--muted);text-transform:uppercase}
 .detail-value{font-size:12px;overflow-wrap:anywhere}
</style>
