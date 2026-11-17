<script lang="ts">
 import { onMount } from 'svelte';
 import {showModalWithFocusReturn} from './modal-focus';
 import { request } from './api';
 import { MAX_MODEL_TURNS_CEILING,THINKING_LEVELS } from '../shared/agent';
 import { MAX_OUTPUT_TOKENS_CEILING } from '../shared/harness-settings';
 import type { HarnessSettingsView } from '../shared/harness-settings';
 import { ACCEPTANCE_ACTION_CLASSES } from '../shared/acceptance';
 import type { AcceptancePolicy, AcceptanceMode, AcceptanceClassDecision, AcceptanceActionClass } from '../shared/acceptance';
 let {onclose}:{onclose:()=>void}=$props();
 let dialog:HTMLDialogElement,view=$state<HarnessSettingsView|null>(null);
 let maxModelTurns=$state(40),maxOutputTokens=$state(32000),defaultThinking=$state(''),capabilities=$state({codingTools:true,shell:true,fileEdit:true});
 let busy=$state(false),problem=$state(''),message=$state('');
 let policy=$state<AcceptancePolicy|null>(null), policyMode=$state<AcceptanceMode>('owner-only'), agentEvidenceRecording=$state<boolean|null>(null);
 let decisions=$state<Record<AcceptanceActionClass,AcceptanceClassDecision>>({commit:'ask',push:'ask',deploy:'ask',spend:'ask',provision:'ask',publish:'ask'});
 let policyBusy=$state(false),policyProblem=$state(''),policyMessage=$state('');
 onMount(()=>{const close=showModalWithFocusReturn(dialog);void Promise.all([load(),loadPolicy()]);return close;});
 async function loadPolicy(){
  try { const result=await request<{policy:AcceptancePolicy;agentEvidenceRecording?:boolean}>('/acceptance/policy'); agentEvidenceRecording=result.agentEvidenceRecording??null; policy=result.policy; policyMode=result.policy.mode; decisions={...result.policy.actionClasses}; policyProblem=''; }
  catch(e){policyProblem=(e as Error).message;}
 }
 async function savePolicy(){
  if(!policy||policyBusy)return; policyBusy=true;policyProblem='';policyMessage='';
  try { const result=await request<{policy:AcceptancePolicy}>('/acceptance/policy','POST',{revision:policy.revision,policy:{mode:policyMode,actionClasses:decisions}}); policy=result.policy;policyMode=result.policy.mode;decisions={...result.policy.actionClasses};policyMessage='Acceptance policy saved.'; }
  catch(e){policyProblem=(e as Error).message+' Your selections are still here; reload the policy to discard them and retry.';} finally {policyBusy=false;}
 }
 async function load(){
   try{
     const next=await request<HarnessSettingsView>('/settings/harness');
     view=next;maxModelTurns=next.settings.preferences.maxModelTurns;maxOutputTokens=next.settings.preferences.maxOutputTokens;defaultThinking=next.settings.preferences.defaultThinking??'';capabilities={...next.settings.capabilities};
   }catch(e){problem=(e as Error).message;}
 }
 async function save(){
   if(!view||busy)return;busy=true;problem='';message='';
   try{
     const next=await request<HarnessSettingsView>('/settings/harness','POST',{revision:view.revision,settings:{preferences:{maxModelTurns:Number(maxModelTurns),maxOutputTokens:Number(maxOutputTokens),defaultThinking:defaultThinking===''?null:defaultThinking},capabilities}});
     view=next;message='Saved. It applies to the next request; no restart.';maxModelTurns=next.settings.preferences.maxModelTurns;maxOutputTokens=next.settings.preferences.maxOutputTokens;defaultThinking=next.settings.preferences.defaultThinking??'';capabilities={...next.settings.capabilities};
   }catch(e){problem=(e as Error).message;await load();}
   finally{busy=false;}
 }
 /** One capability row: what the deployment offers, what the owner allows, and the result. */
 const row=(name:'codingTools'|'shell'|'fileEdit')=>view?.effective.capabilities[name];
</script>
<dialog bind:this={dialog} oncancel={onclose} class="harness-settings" aria-labelledby="harness-settings-title">
 <header class="modal-head"><div><span class="eyebrow">PILOT SETTINGS</span><h2 id="harness-settings-title">Harness</h2></div><button aria-label="Close harness settings" onclick={onclose}>×</button></header>
 <div class="harness-scroll">
  <p class="muted">How the agent harness runs on this instance. Preferences apply to the next request. A capability can be switched <strong>off</strong> here; switching one on is a deployment decision, because it decides whether the tool exists in the process at all.</p>
  {#if problem}<p class="error" role="alert">{problem}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if !view}<p class="muted">Loading…</p>{:else}
  <h3>Preferences</h3>
  <label class="field">Most model requests in a row for one message
   <input type="number" min="0" max={MAX_MODEL_TURNS_CEILING} bind:value={maxModelTurns} aria-label="Most model requests in a row for one message">
   <small>0 disables the turn limit for continuous runs; 1 to {MAX_MODEL_TURNS_CEILING} stops a run at that many requests. An unlimited run can continue using model credits until it finishes or is stopped.</small>
  </label>
  <label class="field">Most tokens one request may produce
   <input type="number" min="1" max={MAX_OUTPUT_TOKENS_CEILING} bind:value={maxOutputTokens} aria-label="Most tokens one request may produce">
   <small>1 to {MAX_OUTPUT_TOKENS_CEILING}. Reasoning is spent from this same budget: at a higher thinking level a small bound cuts the answer off, and a tool call whose arguments are long can arrive truncated. The old build capped every request at 4,096.</small>
  </label>
  <label class="field">Thinking level for a new conversation
   <select bind:value={defaultThinking} aria-label="Thinking level for a new conversation">
    <option value="">Host default</option>
    {#each THINKING_LEVELS as level}<option value={level}>{level}</option>{/each}
   </select>
   <small>A session can still override this for itself in the composer.</small>
  </label>
  <h3>Acceptance and file edits</h3>
  <p class="muted">The policy is instance-wide. Agent acceptance records a decision; it does not itself run a command, deploy or publish. Test results and diffs in evidence are claims, not independently verified; the record does not identify whether an owner or an agent produced them. The separate write, edit and shell tools can change files or run commands directly when granted.</p>
  <p class="muted">Agent evidence recording: {agentEvidenceRecording===null?'status unavailable':agentEvidenceRecording?'enabled by deployment; agents also need the accept scope':'not enabled by deployment'}. Enabling it permits new self-reported evidence writes.</p>
  {#if policyProblem}<p class="error" role="alert">{policyProblem}</p>{/if}
  {#if policyMessage}<p role="status">{policyMessage}</p>{/if}
  {#if policy}
   <label class="field">Who may accept work
    <select aria-label="Acceptance mode" bind:value={policyMode}><option value="owner-only">Owner only · file_edit proposes changes</option><option value="agent-may-accept">Agents may accept · file_edit applies changes</option></select>
    <small>Changes use the policy revision shown when you opened this panel. A conflict leaves the newer policy intact.</small>
   </label>
   <div class="row"><button type="button" onclick={()=>{policyMode='agent-may-accept';decisions=Object.fromEntries(ACCEPTANCE_ACTION_CLASSES.map(action=>[action,'full-auto'])) as Record<AcceptanceActionClass,AcceptanceClassDecision>;}}>Set all to full auto</button></div>
   <small class="muted">This fills the policy controls; select Save acceptance policy to apply them. Agent tool grants remain per agent.</small>
   {#each ACCEPTANCE_ACTION_CLASSES as action}
    <label class="field">{action}
     <select aria-label={'Acceptance for '+action} value={decisions[action]} onchange={event=>decisions={...decisions,[action]:event.currentTarget.value as AcceptanceClassDecision}}><option value="ask">Ask owner</option><option value="full-auto">Agent may decide</option></select>
    </label>
   {/each}
   <div class="row"><button disabled={policyBusy} onclick={()=>void savePolicy()}>Save acceptance policy</button><button disabled={policyBusy} onclick={()=>void loadPolicy()}>Reload policy</button></div>
  {/if}
  <h3>Capabilities</h3>
  {#each [['codingTools','Coding tools (read, write, edit)','Read and write files inside the project’s connected worktree.'],['shell','Shell (bash)','Runs commands as the application user and is not contained. Switching this off refuses the tool from the next call.'],['fileEdit','Bounded file edit','Propose or apply one edit, governed by the acceptance policy.']] as [name,title,detail]}
   {@const state=row(name as 'codingTools'|'shell'|'fileEdit')}
   <label class="capability">
    <input type="checkbox" aria-label={title} checked={capabilities[name as 'codingTools']} disabled={!state?.deployed} onchange={(event)=>capabilities={...capabilities,[name as string]:event.currentTarget.checked}}>
    <span><strong>{title}</strong><small>{detail}</small><small data-capability-state={name}>{!state?.deployed?'Not offered by this deployment: it needs a deployment switch and a restart.':state.enabled?'Enabled':'Switched off here.'}</small></span>
   </label>
  {/each}
  {/if}
 </div>
 <footer class="row"><button onclick={onclose}>Close</button><button class="primary" disabled={busy||!view} onclick={()=>void save()}>Save harness settings</button></footer>
</dialog>
<style>
 .harness-settings{width:min(680px,calc(100vw - 24px));max-height:92dvh;overflow:hidden;display:flex;flex-direction:column}
 .harness-settings .modal-head{flex-shrink:0;border-bottom:1px solid var(--line)}
 .harness-scroll{flex:1;min-height:0;overflow:auto}
 .harness-settings footer{flex-shrink:0;border-top:1px solid var(--line);padding-top:8px}
 h3{font-size:12px;margin:18px 0 8px}
 .field{display:block;margin:10px 0}
 .field small,.capability small{display:block;color:var(--muted);font-size:11px;line-height:1.5}
 .capability{display:flex;gap:8px;align-items:flex-start;margin:10px 0}
 .capability input{width:auto;margin-top:3px;flex-shrink:0}
</style>
