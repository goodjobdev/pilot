<script lang="ts">
 import Icon from './Icon.svelte';
import type { AlertState } from './push';
 let { questions, agents=[], unlinked, alertState='off', alertBusy=false, alertMessage='', onopen, onanswer, onenable, ondisable, ontest, onclose }:{
   questions:{ path:string; line:number; text:string; anchor:string|null; id:string }[];
   agents?:{ id:string; text:string }[];
   unlinked:number;
   alertState?:AlertState; alertBusy?:boolean; alertMessage?:string;
   onopen:(path:string,anchor:string|null)=>void; onanswer?:(id:string)=>void;
   onenable?:()=>void; ondisable?:()=>void; ontest?:()=>void; onclose:()=>void;
 }=$props();
</script>
<div class="popover-panel inbox-panel" role="group" aria-label="Needs me">
 <div class="popover-heading">NEEDS ME</div>
 {#if unlinked}<p class="inbox-hint"><Icon name="book" size={13}/><span>{unlinked} active {unlinked===1?'task has':'tasks have'} no specification link</span></p>{/if}
 {#if questions.length}
 {#each questions as question}
 <button class="inbox-item" onclick={()=>onopen(question.path,question.anchor)}>
  <span class="match-path">{question.path}:{question.line}</span>
  <span class="inbox-text">{question.text}</span>
 </button>
 {/each}
 {:else}
 <p class="inbox-empty">No open questions in this project's documentation.</p>
 {/if}
 {#if agents.length}
 <span class="popover-heading">AGENT QUESTIONS</span>
 {#each agents as question (question.id)}
 <button class="inbox-item" onclick={()=>onanswer?.(question.id)}><span class="match-path">agent</span><span class="inbox-text">{question.text}</span></button>
 {/each}
 {/if}
 <div class="inbox-alerts">
  <span class="popover-heading">PHONE ALERTS</span>
  {#if alertState==='unsupported'}
  <p class="inbox-empty">This browser cannot receive push alerts.</p>
  {:else if alertState==='blocked'}
  <p class="inbox-empty">Notifications are blocked for this site. Allow them in the browser's site settings, then try again.</p>
  {:else if alertState==='on'}
  <p class="inbox-hint"><Icon name="agent" size={13}/><span>Alerts are on for this device.</span></p>
  <div class="row"><button class="compact-button" disabled={alertBusy} onclick={ontest}>Send a test alert</button><button class="compact-button" disabled={alertBusy} onclick={ondisable}>Turn off</button></div>
  {:else}
  <p class="inbox-hint"><Icon name="agent" size={13}/><span>Get a notification when an agent asks a question or finishes.</span></p>
  <button class="primary compact-button" disabled={alertBusy} onclick={onenable}>Enable phone alerts</button>
  {/if}
  {#if alertMessage}<small class="doc-message">{alertMessage}</small>{/if}
 </div>
 <button class="text-button" onclick={onclose}>Close</button>
</div>
