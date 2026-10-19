<script lang="ts">
 import { api,agentStream } from './api';
 import type { AgentView } from '../shared/agent';
 import Icon from './Icon.svelte';
 let { projectId,onerror,onquestions }:{ projectId:string; onerror:(message:string)=>void; onquestions?:()=>void }=$props();
 let view=$state<AgentView|null>(null),enabled=$state(true),status=$state('Connecting…'),draft=$state(''),sending=$state(false),problem=$state('');
 let answers=$state<Record<string,string>>({}),answering=$state('');
 let transcript=$state<HTMLDivElement>();
 let controller:AbortController|null=null;
 $effect(()=>{
   const id=projectId;
   let cancelled=false;
   void (async()=>{
     try{
       const snapshot=await api.agents(id);
       if(cancelled)return;
       enabled=snapshot.enabled;view=snapshot.view;
       if(!snapshot.enabled){status='Agents are disabled on this instance';return;}
     }catch(e){if(!cancelled){status=(e as Error).message;onerror((e as Error).message);}return;}
     controller?.abort();
     controller=new AbortController();
     try{await agentStream(id,next=>{if(!cancelled){view=next;status='Live';}},controller.signal);}
     catch(e){if(!cancelled&&(e as Error).name!=='AbortError')status='Stream closed — '+(e as Error).message;}
   })();
   return ()=>{cancelled=true;controller?.abort();};
 });
 $effect(()=>{if(transcript&&view?.entries.length)transcript.scrollTop=transcript.scrollHeight;});
 // Tell the application inbox when the set of open questions changes, so its badge and
 // list never count a question that has just been answered.
 let notified=$state<number|null>(null);
 $effect(()=>{
   const open=(view?.questions??[]).filter(question=>!question.answer).length;
   if(notified===open)return;
   notified=open;
   onquestions?.();
 });
 async function send(mode:'followUp'|'steer'){
   const text=draft.trim();
   if(text===''||sending)return;
   sending=true;problem='';
   try{await api.agentInput(projectId,{text,mode,requestId:crypto.randomUUID()});draft='';}
   catch(e){problem=(e as Error).message;}
   finally{sending=false;}
 }
 async function answer(questionId:string){
   const text=(answers[questionId]??'').trim();
   if(text==='')return;
   answering=questionId;problem='';
   try{await api.agentAnswer(projectId,{questionId,text});answers={...answers,[questionId]:''};}
   catch(e){problem=(e as Error).message;}
   finally{answering='';}
 }
 async function stop(){
   problem='';
   try{await api.agentAbort(projectId);}
   catch(e){problem=(e as Error).message;}
 }
 const working=$derived(view?.working??false);
</script>
<section class="agents">
 <header class="agents-head">
  <div>
   <span class="eyebrow">SCRIPTED TEST PROVIDER</span>
   <h2>{view?.model?view.model.provider+' / '+view.model.modelId:'Agent'}</h2>
  </div>
  <span class="pill" title="No model is called and nothing is spent: replies come from a deterministic local provider.">no model called</span>
  <span class="agent-state" class:busy={working} role="status">{working?'Working…':'Idle'}</span>
  <button class="compact-button" aria-label="Stop the agent" disabled={!working} onclick={()=>void stop()}><Icon name="close" size={14}/><span>Stop</span></button>
 </header>
 {#if !enabled}
 <div class="empty"><div class="empty-mark"><Icon name="agent" size={32}/></div><h2>Agents are off here.</h2><p>This instance does not enable the agent harness, so nothing can run. Set <code>DASHBOARD_AGENTS=on</code> to enable it.</p></div>
 {:else}
 {#if problem}<p class="error agents-problem" role="alert">{problem}</p>{/if}
 {#if view?.questions.length}
 <section class="agent-questions" aria-label="Questions for me">
  <span class="popover-heading">QUESTIONS FOR ME</span>
  {#each view.questions as question (question.id)}
  <article class="agent-question" class:answered={Boolean(question.answer)} id={'question-'+question.id}>
   <p>{question.text}</p>
   {#if question.answer}
   <p class="agent-answer"><span class="pill">answered</span>{question.answer.text}</p>
   {:else}
   <div class="row">
    <input aria-label={'Answer to: '+question.text} value={answers[question.id]??''} placeholder="Your answer" oninput={(event)=>answers={...answers,[question.id]:(event.currentTarget as HTMLInputElement).value}}>
    <button class="primary compact-button" aria-label="Send answer" disabled={answering===question.id||(answers[question.id]??'').trim()===''} onclick={()=>void answer(question.id)}>Answer once</button>
   </div>
   {/if}
  </article>
  {/each}
 </section>
 {/if}
 <!-- svelte-ignore a11y_no_static_element_interactions -->
 <div class="agent-transcript" bind:this={transcript} aria-label="Agent transcript">
  {#if !view?.entries.length}<p class="agent-empty">No messages yet. Send one below — the scripted provider answers without calling a model.</p>{/if}
  {#each view?.entries??[] as entry (entry.id)}
  <article class="agent-entry {entry.kind}">
   <span class="agent-role">{entry.kind==='user'?'You':entry.kind==='assistant'?'Agent':entry.kind==='tool'?'Tool':entry.kind}</span>
   {#if entry.thinking}<details class="agent-thinking"><summary>Reasoning</summary><pre>{entry.thinking}</pre></details>{/if}
   {#if entry.tools.length}<div class="agent-tools">{#each entry.tools as tool}<span class="pill">{tool.name}</span>{/each}</div>{/if}
   <pre class="agent-text">{entry.text || (entry.tools.length?'(tool call)':'(no text)')}</pre>
   {#if entry.stopReason&&entry.stopReason!=='stop'}<small class="agent-note">stopped: {entry.stopReason}</small>{/if}
   {#if entry.error}<small class="agent-note error-inline">{entry.error}</small>{/if}
  </article>
  {/each}
 </div>
 {#if view?.inbox.length}
 <div class="agent-queue" aria-label="Queued messages">
  <span class="popover-heading">QUEUED</span>
  {#each view.inbox as item (item.id)}<p><span class="pill">{item.mode}</span>{item.text}</p>{/each}
 </div>
 {/if}
 <div class="agent-composer">
  <label>Message the agent<textarea aria-label="Message the agent" bind:value={draft} placeholder="Ask for something, or include [pause] to hold the run open while you steer or stop it."></textarea></label>
  <div class="row">
   <button class="primary compact-button" aria-label="Send message" disabled={sending||draft.trim()===''} onclick={()=>void send('followUp')}><Icon name="arrow" size={14}/><span>{working?'Queue follow-up':'Send'}</span></button>
   <button class="compact-button" aria-label="Steer the run" disabled={sending||!working||draft.trim()===''} onclick={()=>void send('steer')}>Steer current run</button>
   <small class="agent-status">{status}{view?.usage.input?(' · '+view.usage.input+' in / '+view.usage.output+' out'):''}</small>
  </div>
 </div>
 {/if}
</section>
<style>
 .agents{flex:1;min-height:0;display:flex;flex-direction:column}
 .agents-head{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
 .agents-head h2{margin:3px 0 0;font-size:13px}
 .agent-state{font:9px var(--mono);color:var(--muted)}.agent-state.busy{color:var(--accent)}
 .agents-problem{margin:10px 12px 0}
 .agent-questions{margin:10px 12px 0;padding:10px 12px;border:1px solid color-mix(in srgb,#d6b879 32%,var(--line));background:color-mix(in srgb,#d6b879 5%,transparent);border-radius:5px}
 .agent-question{margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
 .agent-question p{margin:0 0 8px;font-size:12px;line-height:1.6}
 .agent-question .row{flex-wrap:nowrap}.agent-question input{min-width:0}
 .agent-answer{display:flex;gap:7px;align-items:center;color:var(--muted);font-size:11px}
 .agent-question.answered{opacity:.75}
 .agent-transcript{flex:1;min-height:0;overflow:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:12px}
 .agent-empty{color:var(--muted);font-size:12px;line-height:1.7}
 .agent-entry{border:1px solid var(--line);border-left:2px solid var(--muted);border-radius:5px;background:var(--panel);padding:10px 12px}
 .agent-entry.user{border-left-color:var(--accent)}
 .agent-entry.assistant{border-left-color:#7aafff}
 .agent-entry.tool{border-left-color:#d6b879}
 .agent-role{font:9px var(--mono);letter-spacing:1px;color:var(--muted);text-transform:uppercase}
 .agent-text{margin:7px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--mono)}
 .agent-thinking{margin-top:7px}.agent-thinking pre{white-space:pre-wrap;font-size:11px;color:var(--muted)}
 .agent-tools{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
 .agent-note{display:block;margin-top:6px;color:var(--muted);font-size:10px}.error-inline{color:var(--danger)}
 .agent-queue{margin:0 12px;padding:10px 12px;border:1px solid color-mix(in srgb,#d6b879 30%,var(--line));background:color-mix(in srgb,#d6b879 5%,transparent);border-radius:5px}
 .agent-queue p{margin:6px 0 0;font-size:12px;display:flex;gap:7px;align-items:center}
 .agent-composer{border-top:1px solid var(--line);background:var(--panel);padding:10px 12px}
 .agent-composer textarea{min-height:80px;font:12px/1.6 var(--mono)}
 .agent-status{color:var(--muted)}
</style>
