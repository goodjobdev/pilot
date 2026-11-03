<script lang="ts">
 import { onMount } from 'svelte';
 import { request } from './api';
 import { MAX_MODEL_TURNS_CEILING,THINKING_LEVELS } from '../shared/agent';
 import type { HarnessSettingsView } from '../shared/harness-settings';
 let {onclose}:{onclose:()=>void}=$props();
 let dialog:HTMLDialogElement,view=$state<HarnessSettingsView|null>(null);
 let maxModelTurns=$state(40),defaultThinking=$state(''),capabilities=$state({codingTools:true,shell:true,fileEdit:true});
 let busy=$state(false),problem=$state(''),message=$state('');
 onMount(async()=>{dialog.showModal();await load();});
 async function load(){
   try{
     const next=await request<HarnessSettingsView>('/settings/harness');
     view=next;maxModelTurns=next.settings.preferences.maxModelTurns;defaultThinking=next.settings.preferences.defaultThinking??'';capabilities={...next.settings.capabilities};
   }catch(e){problem=(e as Error).message;}
 }
 async function save(){
   if(!view||busy)return;busy=true;problem='';message='';
   try{
     const next=await request<HarnessSettingsView>('/settings/harness','POST',{revision:view.revision,settings:{preferences:{maxModelTurns:Number(maxModelTurns),defaultThinking:defaultThinking===''?null:defaultThinking},capabilities}});
     view=next;message='Saved. It applies to the next request; no restart.';maxModelTurns=next.settings.preferences.maxModelTurns;defaultThinking=next.settings.preferences.defaultThinking??'';capabilities={...next.settings.capabilities};
   }catch(e){problem=(e as Error).message;await load();}
   finally{busy=false;}
 }
 /** One capability row: what the deployment offers, what the owner allows, and the result. */
 const row=(name:'codingTools'|'shell'|'fileEdit')=>view?.effective.capabilities[name];
</script>
<dialog bind:this={dialog} oncancel={onclose} class="harness-settings">
 <header class="modal-head"><div><span class="eyebrow">PILOT SETTINGS</span><h2>Harness</h2></div><button aria-label="Close harness settings" onclick={onclose}>×</button></header>
 <div class="harness-scroll">
  <p class="muted">How the agent harness runs on this instance. Preferences apply to the next request. A capability can be switched <strong>off</strong> here; switching one on is a deployment decision, because it decides whether the tool exists in the process at all.</p>
  {#if problem}<p class="error" role="alert">{problem}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if !view}<p class="muted">Loading…</p>{:else}
  <h3>Preferences</h3>
  <label class="field">Most model requests in a row for one message
   <input type="number" min="1" max={MAX_MODEL_TURNS_CEILING} bind:value={maxModelTurns} aria-label="Most model requests in a row for one message">
   <small>1 to {MAX_MODEL_TURNS_CEILING}. When the bound is reached the run stops, says so, and sending another message continues from the transcript.</small>
  </label>
  <label class="field">Thinking level for a new conversation
   <select bind:value={defaultThinking} aria-label="Thinking level for a new conversation">
    <option value="">Host default</option>
    {#each THINKING_LEVELS as level}<option value={level}>{level}</option>{/each}
   </select>
   <small>A session can still override this for itself in the composer.</small>
  </label>
  <h3>Capabilities</h3>
  {#each [['codingTools','Coding tools (read, write)','Read and write files inside the project’s connected worktree.'],['shell','Shell (bash)','Runs commands as the application user and is not contained. Switching this off refuses the tool from the next call.'],['fileEdit','Bounded file edit','Propose or apply one edit, governed by the acceptance policy.']] as [name,title,detail]}
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
