<script lang="ts">
 import { api,agentStream } from './api';
 import type { AgentView } from '../shared/agent';
 import { uniqueImageFiles,type ImageDraft } from '../shared/images';
 import ImageComposer from './ImageComposer.svelte';
 import Icon from './Icon.svelte';
 import {request} from './api';
 import {modelKey,type ProviderSettings} from '../shared/settings';
 import type {ActionDescriptor} from '../shared/actions';
 import {slashMatches} from './slash';
 import SessionBar from './SessionBar.svelte';
 let { projectId,onerror,onquestions,agentsVersion=0 }:{ projectId:string; onerror:(message:string)=>void; onquestions?:()=>void; agentsVersion?:number }=$props();
 let view=$state<AgentView|null>(null),enabled=$state(true),status=$state('Connecting…'),draft=$state(''),sending=$state(false),problem=$state('');
 // The session whose transcript the stream should follow. Updated when the owner selects a session
 // in the session bar. An empty or absent value means the root (legacy project) conversation.
 let selectedSessionId=$state('');
 let answers=$state<Record<string,string>>({}),answering=$state('');
 // The images attached to the next message, and the one way the composer's upload path is fed.
 let media=$state<ImageDraft[]>([]),composerApi=$state<{add:(files:File[])=>void}|null>(null),composerDragging=$state(false);
 const readyImages=$derived(media.filter(item=>item.status==='ready'&&item.id).map(item=>item.id as string));
 // An image that is still uploading is not part of `readyImages` and its bytes are not stored yet, so
 // a send now would leave it out of the message and then clear the strip. The send waits for it, and
 // this is the one reading both the buttons and the sender use.
 const uploadingImages=$derived(media.some(item=>item.status==='uploading'));
 /**
  * The one paste and drop handler for the whole composer area, which is what makes a gesture handled
  * exactly once: the strip inside it has no handler of its own, an event another handler has already
  * taken is left alone, and the default is prevented once per gesture that really carries a file.
  */
 function composerEvent(event:ClipboardEvent|DragEvent){
   if(event.defaultPrevented||!composerApi)return;
   let files:File[];
   if(event instanceof ClipboardEvent){
     const fromItems=[...(event.clipboardData?.items??[])].filter(entry=>entry.kind==='file').map(entry=>entry.getAsFile()).filter((file):file is File=>file!==null);
     // A clipboard that lists its files only in `files` is read there instead, never as well.
     files=fromItems.length?fromItems:[...(event.clipboardData?.files??[])];
   }else{
     files=[...(event.dataTransfer?.files??[])];
   }
   if(files.length===0)return;
   event.preventDefault();
   composerDragging=false;
   // One gesture is one enqueue: a file this gesture lists twice (through items and through files, or
   // twice over) is taken once, so one drop or paste can never become two items and two uploads.
   composerApi.add(uniqueImageFiles(files));
 }
 let transcript=$state<HTMLDivElement>();
 let controller:AbortController|null=null;
 let modelSettings=$state<ProviderSettings|null>(null),selectedModel=$state(''),modelBusy=$state(false);
 async function loadModels(){try{modelSettings=await request('/settings/providers');}catch(e){problem=(e as Error).message;}}
 async function chooseModel(){
  if(modelBusy)return;modelBusy=true;problem='';
  const m=modelSettings?.models.find(m=>modelKey(m)===selectedModel);
  try{view=await request('/projects/'+projectId+'/agents/model','POST',{model:m?{provider:m.provider,modelId:m.modelId}:null});}
  catch(e){problem=(e as Error).message;}
  finally{modelBusy=false;}
 }
 $effect(()=>{
   const id=projectId;
   const sessionId=selectedSessionId;
   let cancelled=false;
   void (async()=>{
     try{
       const snapshot=await api.agents(id);
       if(cancelled)return;
       enabled=snapshot.enabled;view=snapshot.view;selectedModel=view?.model?.provider==='faux'?'':view?.model?modelKey(view.model):'';
       await loadModels();
       if(!snapshot.enabled){status='Agents are disabled on this instance';return;}
     }catch(e){if(!cancelled){status=(e as Error).message;onerror((e as Error).message);}return;}
     controller?.abort();
     controller=new AbortController();
     try{await agentStream(id,next=>{if(!cancelled){view=next;status='Live';}},controller.signal,sessionId||undefined);}
     catch(e){if(!cancelled&&(e as Error).name!=='AbortError')status='Stream closed — '+(e as Error).message;}
   })();
   return ()=>{cancelled=true;controller?.abort();};
 });
 $effect(()=>{if(transcript&&view?.entries.length)transcript.scrollTop=transcript.scrollHeight;});
 // Tell the application inbox when the set of open questions changes, so its badge and
 // list never count a question that has just been answered.
 let notified=$state<number|null>(null);
 $effect(()=>{
   const dismissed=(view as unknown as {dismissals?:Record<string,unknown>})?.dismissals??{};
   const open=(view?.questions??[]).filter(question=>!question.answer&&!(question.id in dismissed)).length;
   if(notified===open)return;
   notified=open;
   onquestions?.();
 });
 async function send(mode:'followUp'|'steer'){
   const text=draft.trim(),images=readyImages;
   // A message needs text or an image; a refused image is never sent, and stays visible until removed.
   if((text===''&&images.length===0)||sending)return;
   // An upload in flight is not a stored image. Sending here would send the text without it and then
   // wipe the strip, silently leaving an accepted image behind, so the message is held with its own
   // reason instead. The Send and Steer buttons are disabled on this very condition, with the state
   // named next to them, so a person never reaches this branch without being told why.
   if(uploadingImages){problem='An image is still uploading. Wait for it to finish, then send — sending now would leave it out of the message.';return;}
   sending=true;problem='';
   try{await api.agentInput(projectId,{text,mode,requestId:crypto.randomUUID(),images});draft='';media=[];}
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

 /**
  * The slash command surface: the same typed action registry the palette uses.
  *
  * The composer never hardcodes a command. It asks the server for the actions this scope may use and
  * offers the slash-eligible ones (see src/client/slash.ts); the chosen action runs through the same
  * /api/actions/execute path the palette calls, in this project's and session's own scope.
  */
 let actions=$state<ActionDescriptor[]>([]);
 let slashResult=$state(''),slashRefusal=$state('');
 const slashPicks=$derived(slashMatches(actions,draft));
 let slashHighlight=$state(0);
 $effect(()=>{void view?.conversationId;void projectId;void loadActions();});
 async function loadActions(){
   try{actions=(await api.actions({projectId,...(view?.conversationId?{sessionId:view.conversationId}:{})})).actions;}
   catch{actions=[];}
 }
 async function runSlash(action:ActionDescriptor){
   slashRefusal='';slashResult='';
   try{
     const executed=await api.runAction(action.id,{scope:{projectId,...(view?.conversationId?{sessionId:view.conversationId}:{})}});
     slashResult='Ran '+executed.action+': '+JSON.stringify(executed.result).slice(0,300);
     draft='';
   }catch(error){slashRefusal=(error as Error).message;}
 }
 /**
  * Enter sends; Shift+Enter (and Cmd/Ctrl+Enter) insert a newline. An IME composition is never
  * interrupted, so a candidate-selection Enter is left to the input method. While the slash list is
  * open, Enter chooses the highlighted action instead — the list is a command surface, not a send.
  */
 function composerKey(event:KeyboardEvent){
   if((event as unknown as {isComposing?:boolean}).isComposing||event.keyCode===229)return;
   const picks=slashPicks;
   if(picks){
     if(event.key==='ArrowDown'){event.preventDefault();slashHighlight=(slashHighlight+1)%Math.max(picks.length,1);return;}
     if(event.key==='ArrowUp'){event.preventDefault();slashHighlight=(slashHighlight-1+picks.length)%Math.max(picks.length,1);return;}
     if(event.key==='Enter'&&!event.shiftKey&&!event.metaKey&&!event.ctrlKey){event.preventDefault();const pick=picks[slashHighlight];if(pick)void runSlash(pick);return;}
   }
   if(event.key==='Enter'&&!event.shiftKey&&!event.metaKey&&!event.ctrlKey){event.preventDefault();void send('followUp');}
 }

 /** The dismissed-question markers the harness attaches to the shaped view, keyed by question id. */
 const dismissals=$derived(((view as unknown as {dismissals?:Record<string,{reason:string;dismissedAt:number|null;dismissedBy:string}>})?.dismissals)??{});
 let dismissOpen=$state<string|null>(null),dismissReason=$state(''),dismissing=$state('');
 async function dismiss(questionId:string){
   const reason=dismissReason.trim();
   if(reason===''){problem='Enter a reason for dismissing this question.';return;}
   dismissing=questionId;problem='';
   try{await api.dismissQuestion(projectId,{questionId,reason});dismissOpen=null;dismissReason='';}
   catch(e){problem=(e as Error).message;}
   finally{dismissing='';}
 }
</script>
<section class="agents">
 {#if view?.conversationId}<SessionBar {projectId} sessionId={view.conversationId} {view} {agentsVersion} onerror={(message)=>onerror(message)} onsessionchange={(id)=>{selectedSessionId=id;}}/>{/if}
 <header class="agents-head">
  <div>
   <span class="eyebrow">{!view?.model||view.model.provider==='faux'?'SCRIPTED TEST PROVIDER':'MODEL PROVIDER'}</span>
   <h2>{view?.model?view.model.provider+' / '+view.model.modelId:'Agent'}</h2>
  </div>
  <label class="model-picker">Session model<select aria-label="Session model" bind:value={selectedModel} disabled={working||modelBusy} onfocus={()=>void loadModels()} onchange={()=>void chooseModel()}>
   <option value="">Scripted test provider (free)</option>
   {#each modelSettings?.models.filter(m=>m.configured)??[] as m (modelKey(m))}<option value={modelKey(m)}>{modelSettings?.preferences.favourites.some(c=>modelKey(c)===modelKey(m))?'★ ':''}{m.provider} / {m.name}</option>{/each}
  </select></label>
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
  {#if dismissals[question.id]}
  <article class="agent-question dismissed" id={'question-'+question.id}>
   <p>{question.text}</p>
   <p class="agent-answer"><span class="pill">dismissed</span>{dismissals[question.id].reason}<small> — {dismissals[question.id].dismissedBy}</small></p>
  </article>
  {:else}
  <article class="agent-question" class:answered={Boolean(question.answer)} id={'question-'+question.id}>
   <p>{question.text}</p>
   {#if question.answer}
   <p class="agent-answer"><span class="pill">answered</span>{question.answer.text}</p>
   {:else}
   <div class="row">
    <input aria-label={'Answer to: '+question.text} value={answers[question.id]??''} placeholder="Your answer" oninput={(event)=>answers={...answers,[question.id]:(event.currentTarget as HTMLInputElement).value}}>
    <button class="primary compact-button" aria-label="Send answer" disabled={answering===question.id||(answers[question.id]??'').trim()===''} onclick={()=>void answer(question.id)}>Answer once</button>
    <button class="compact-button" aria-label={'Dismiss question: '+question.text} onclick={()=>{dismissOpen=dismissOpen===question.id?null:question.id;dismissReason='';}}>Dismiss…</button>
   </div>
   {#if dismissOpen===question.id}
   <div class="row">
    <input aria-label={'Dismissal reason for: '+question.text} value={dismissReason} placeholder="Why are you dismissing this?" oninput={(event)=>dismissReason=(event.currentTarget as HTMLInputElement).value}>
    <button class="danger-command compact-button" aria-label="Confirm dismissal" disabled={dismissing===question.id||dismissReason.trim()===''} onclick={()=>void dismiss(question.id)}>Record dismissal</button>
   </div>
   {/if}
   {/if}
  </article>
  {/if}
  {/each}
 </section>
 {/if}
 <!-- svelte-ignore a11y_no_static_element_interactions -->
 <div class="agent-transcript" bind:this={transcript} aria-label="Agent transcript">
  {#if !view?.entries.length}<p class="agent-empty">No messages yet. The scripted provider is free. A real model uses the connected provider account; existing tools are question and note operations only.</p>{/if}
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
 <!-- svelte-ignore a11y_no_static_element_interactions -->
 <div class="agent-composer" onpaste={(event)=>composerEvent(event)} ondrop={(event)=>composerEvent(event)}
      ondragover={(event)=>{event.preventDefault();composerDragging=true;}} ondragleave={()=>composerDragging=false}>
  <ImageComposer projectId={projectId} bind:items={media} dragging={composerDragging} handle={(composer)=>{composerApi=composer;}}/>
  {#if slashPicks}
  <div class="slash-list" aria-label="Slash commands">
   <span class="popover-heading">SLASH COMMANDS — from the action registry</span>
   {#if slashPicks.length===0}<p class="muted">No registry action matches. Type a message, or / to list commands.</p>{/if}
   {#each slashPicks as action,index (action.id)}
   <button class="slash-row" class:highlighted={index===slashHighlight} aria-label={'Run '+action.label} onclick={()=>void runSlash(action)}><code>/{action.id}</code><span>{action.label}</span></button>
   {/each}
  </div>
  {/if}
  <label>Message the agent<textarea aria-label="Message the agent" bind:value={draft} onkeydown={(event)=>composerKey(event)} placeholder="Ask for something, type / for commands, or include [pause]. Enter sends; Shift+Enter adds a newline."></textarea></label>
  {#if slashRefusal}<p class="error" role="alert">{slashRefusal}</p>{/if}
  {#if slashResult}<p class="agent-status" role="status">{slashResult}</p>{/if}
  <div class="row">
   <button class="primary compact-button" aria-label="Send message" disabled={sending||uploadingImages||(draft.trim()===''&&readyImages.length===0)} title={uploadingImages?'An image is still uploading: the message is held until it is stored':undefined} onclick={()=>void send('followUp')}><Icon name="arrow" size={14}/><span>{working?'Queue follow-up':'Send'}</span></button>
   <button class="compact-button" aria-label="Steer the run" disabled={sending||uploadingImages||!working||(draft.trim()===''&&readyImages.length===0)} title={uploadingImages?'An image is still uploading: the message is held until it is stored':undefined} onclick={()=>void send('steer')}>Steer current run</button>
   {#if uploadingImages}<small class="agent-upload-state" role="status">Uploading an image — the message is held until it is stored</small>{/if}
   <small class="agent-status">{status}{view?.usage.input?(' · '+view.usage.input+' in / '+view.usage.output+' out'):''}</small>
  </div>
 </div>
 {/if}
</section>
<style>
 .agents{flex:1;min-height:0;display:flex;flex-direction:column}
 .agents-head{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
 .model-picker{min-width:180px;max-width:100%;font-size:10px}.model-picker select{max-width:100%}
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
 .agent-upload-state{color:var(--accent)}
 .agent-question.dismissed{opacity:.7;border-left:2px solid var(--danger)}
 .slash-list{border:1px solid var(--line);border-radius:5px;background:var(--bg);padding:8px 10px;margin-bottom:8px;max-height:24dvh;overflow:auto;display:flex;flex-direction:column;gap:4px}
 .slash-row{display:flex;gap:8px;align-items:baseline;text-align:left;background:none;border:1px solid transparent;border-radius:4px;padding:5px 6px}
 .slash-row.highlighted{border-color:color-mix(in srgb,var(--accent) 30%,var(--line));background:var(--raised)}
 .slash-row code{font:9px var(--mono);color:var(--accent)}
</style>
