<script lang="ts">
 import { tick } from 'svelte';
 import Icon from './Icon.svelte';
 import { api,ApiError } from './api';
 import type { AlertState } from './push';
 import type { AttentionItem,AttentionApprovalItem,AttentionCounts,AttentionPage } from '../shared/attention';
 import { attentionAgeLabel } from '../shared/attention';
 import { APPROVAL_TARGET_FIELDS } from '../shared/approvals';
 import type { ApprovalView } from './api';
 let { projectId,questions=[],unlinked,alertState='off',alertBusy=false,alertMessage='',refreshKey=0,focusId=null,onopen,onopenquestion,onclose,oncount,onchanged,onenable,ondisable,ontest }:{
   projectId:string;
   questions:{ path:string; line:number; text:string; anchor:string|null; id:string }[];
   unlinked:number;
   alertState?:AlertState; alertBusy?:boolean; alertMessage?:string;
   refreshKey?:number;
   focusId?:string|null;
   onopen:(path:string,anchor:string|null)=>void;
   onopenquestion:(sessionId:string|null,questionId:string)=>void;
   onclose:()=>void;
   oncount?:(count:AttentionCounts)=>void;
   onchanged?:()=>void;
   onenable?:()=>void; ondisable?:()=>void; ontest?:()=>void;
 }=$props();
 let items=$state<AttentionItem[]>([]),count=$state<AttentionCounts|null>(null),page=$state<AttentionPage|null>(null);
 let sources=$state<{questions:string;approvals:string;lifecycle:string}|null>(null);
 let loading=$state(true),loadingMore=$state(false),problem=$state(''),message=$state('');
 let review=$state<AttentionApprovalItem|null>(null),reviewState=$state<ApprovalView|null>(null),reviewElement=$state<HTMLDivElement|null>(null);
 let busy=$state('');
 let now=$state(Date.now());
 let missing=$state(false);
 let focusTried='';
 // Every project or refresh gets a generation. A response from an older generation is discarded,
 // even if its component has been destroyed by the keyed panel.
 let generation=0;
 const KIND_LABEL:Record<string,string>={question:'Question',approval:'Approval',failure:'Failure',interrupted:'Interrupted'};
 const TONE:Record<string,string>={interrupted:'critical',failure:'danger',approval:'warning',question:'note'};

 /**
  * Loads one page. The response already carries the exact count computed from every open item, so
  * the panel does not run a second full projection. The count route stays for the badge alone.
  */
 async function load(run=generation){
   const id=projectId;
   loading=true;problem='';
   try{
     const list=await api.attention(id,{limit:20});
     if(run!==generation||id!==projectId)return;
     items=list.items;page=list.page;count=list.count;sources=list.sources;oncount?.(list.count);
     missing=false;
   }catch(e){
     if(run!==generation||id!==projectId)return;
     problem=(e as Error).message;
   }finally{
     if(run===generation)loading=false;
   }
 }
 /** The next page continues from the keyset cursor; the count does not change with paging. */
 async function more(){
   if(!page?.nextCursor||loadingMore)return;
   const run=generation,id=projectId;
   loadingMore=true;problem='';
   try{
     const next=await api.attention(id,{limit:page.limit,cursor:page.nextCursor});
     if(run!==generation||id!==projectId)return;
     items=[...items,...next.items.filter(item=>!items.some(existing=>existing.id===item.id))];
     page=next.page;count=next.count;oncount?.(next.count);
   }catch(e){
     if(run===generation&&id===projectId)problem=(e as Error).message;
   }finally{
     if(run===generation)loadingMore=false;
   }
 }
 $effect(()=>{
   void projectId;void refreshKey;
   // Clear the previous project at once. Until the new response arrives the panel shows its loading
   // state, never one project's items, count, review or missing-item notice under another project.
   const run=++generation;
   items=[];page=null;count=null;sources=null;review=null;reviewState=null;missing=false;problem='';message='';focusTried='';busy='';loadingMore=false;
   void load(run);
   // A destroyed or replaced panel must not report a late count to the shell either. Advancing the
   // generation in cleanup invalidates every response that was still in flight.
   return ()=>{if(run===generation)generation+=1;};
 });
 // The panel is a layer, so Back closes it. Age is measured against the load time and refreshed
 // only while the panel is mounted; no timer changes the route, the project or the session.
 $effect(()=>{now=Date.now();const timer=setInterval(()=>{now=Date.now();},30000);return()=>clearInterval(timer);});
 // A deep link names one exact item. Page until it is found (bounded), or say it is no longer present.
 $effect(()=>{
   void items;void loading;void focusId;
   if(!focusId||loading||focusTried===focusId)return;
   const found=items.some(item=>item.id===focusId);
   if(found){
     focusTried=focusId;missing=false;
     const element=document.querySelector<HTMLElement>('[data-attention-id="'+CSS.escape(focusId)+'"]');
     element?.scrollIntoView({block:'center'});
     return;
   }
   if(page?.hasMore){void more();return;}
   focusTried=focusId;missing=true;
 });
 function sessionLabel(sessionId:string|null):string{return sessionId===null?'Project scope':'Session '+sessionId;}
 function targetFields(item:AttentionApprovalItem):{field:string;value:string}[]{
   const target=item.target as unknown as Record<string,unknown>;
   return APPROVAL_TARGET_FIELDS[item.approvalKind].map(field=>({field,value:String(target[field]??'')}));
 }
 function scopeFields(item:AttentionApprovalItem):{field:string;value:string}[]{
   return (['projectId','sessionId','operation'] as const).flatMap(field=>{
     const value=item.scope[field];
     return value===undefined?[]:[{field,value:String(value)}];
   });
 }
 async function reviewItem(item:AttentionItem){
   if(item.kind!=='approval')return;
   const run=generation;
   review=item;reviewState=null;problem='';message='';
   // The review opens at the end of the scrolling panel, so bring it into view rather than leaving
   // the person to find it below the list on a phone.
   await tick();
   if(run!==generation)return;
   reviewElement?.scrollIntoView({block:'nearest'});
 }
 async function consume(){
   const item=review;if(!item)return;
   const run=generation;
   busy='consume';problem='';message='';
   try{
     const result=await api.consumeApproval(item.approvalId,{scope:item.scope,kind:item.approvalKind,target:item.target,consumedBy:'owner'});
     if(run!==generation)return;
     reviewState=result.approval;
     message='Consumption recorded at '+result.approval.consumedAt+'. It performed no commit, push, deploy, spend, provision or publish.';
     await load(run);onchanged?.();
   }catch(e){if(run===generation)problem=(e as Error).message;}
   finally{if(run===generation)busy='';}
 }
 async function revoke(){
   const item=review;if(!item)return;
   const run=generation;
   busy='revoke';problem='';message='';
   try{
     const result=await api.revokeApproval(item.approvalId,{scope:item.scope,revokedBy:'owner',reason:'Revoked from the attention surface'});
     if(run!==generation)return;
     reviewState=result.approval;
     message='The approval is revoked and can never be consumed.';
     await load(run);onchanged?.();
   }catch(e){if(run===generation)problem=(e as Error).message;}
   finally{if(run===generation)busy='';}
 }
 async function lifecycle(item:AttentionItem,action:'retry'|'resume'){
   if(item.kind!=='failure'&&item.kind!=='interrupted')return;
   const run=generation;
   busy=item.id+':'+action;problem='';message='';
   try{
     const result=await api.lifecycleAction(projectId,item.sessionId!,action,{revision:item.lifecycleRevision});
     if(run!==generation)return;
     message=action==='retry'?'Retry recorded as a new attempt.':'Resume requested under the original request identity.';
     if(result.outcome==='terminal')message=result.reason??'No additional work was started: the original request is already terminal.';
     else if(result.dispatched===false)message+=' This instance did not dispatch.';
     await load(run);onchanged?.();
   }catch(e){
     if(run!==generation)return;
     problem=(e as Error).message;
     if(e instanceof ApiError&&e.status===409)await load(run);
   }finally{if(run===generation)busy='';}
 }
 async function acknowledge(item:AttentionItem){
   if(item.kind!=='interrupted'||!item.uncertain||!item.sessionId)return;
   const run=generation;busy=item.id+':acknowledge';problem='';message='';
   try{
     const result=await api.acknowledgeUncertainty(projectId,item.sessionId,item.lifecycleRevision);
     if(run!==generation)return;
     message='Acknowledged after terminal status and conversation-idle verification. This does not undo the interrupted effect or replay it. New owner input is now allowed.';
     await load(run);onchanged?.();
   }catch(e){if(run===generation){problem=(e as Error).message;if(e instanceof ApiError&&e.status===409)await load(run);}}
   finally{if(run===generation)busy='';}
 }
 function openQuestion(item:AttentionItem){if(item.kind!=='question')return;onopenquestion(item.sessionId,item.questionId);}
</script>
<div class="popover-panel inbox-panel attention-panel" data-project={projectId} role="group" aria-label="Needs me">
 <div class="attention-head">
  <div class="popover-heading">NEEDS ME</div>
  <button class="text-button" aria-label="Close needs me" onclick={onclose}>Close</button>
 </div>
 <div class="attention-count" role="status" aria-live="polite">
  {#if loading}<span>Loading attention…</span>
  {:else if count}<span><strong>{count.open}</strong> open{count.complete?'':' (count incomplete)'}</span>
  {:else}<span>Attention is unavailable.</span>{/if}
  {#if count?.capped}<span class="attention-cap">At most {page?.listedCap??100} open items are listed in this pass; {count.complete?count.open+' are open':'at least '+count.open+' are open'}.</span>{/if}
 </div>
 {#if problem}<p class="error doc-message" role="alert">{problem}</p>{/if}
 {#if message}<p class="inbox-hint" role="status">{message}</p>{/if}
 {#if missing}<p class="inbox-empty" role="status">That item is no longer present. It may have been answered, consumed or resolved.</p>{/if}

 {#each items as item (item.id)}
 <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
 <article class="attention-item" data-kind={item.kind} data-attention-id={item.id} class:inbox-item={item.kind==='question'} class:critical={TONE[item.kind]==='critical'} class:danger={TONE[item.kind]==='danger'} role={item.kind==='question'?'button':undefined} tabindex={item.kind==='question'?0:undefined} onclick={item.kind==='question'?()=>openQuestion(item):undefined} onkeydown={item.kind==='question'?(event:KeyboardEvent)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openQuestion(item);}}:undefined}>
  <div class="attention-meta">
   <span class="pill attention-kind {TONE[item.kind]}">{KIND_LABEL[item.kind]}</span>
   <span class="attention-age">{attentionAgeLabel(item.at,now)}</span>
  </div>
  <span class="match-path">{sessionLabel(item.sessionId)}</span>
  <p class="attention-context">{item.context}</p>
  {#if item.kind==='question'}
   <span class="attention-open" aria-hidden="true">Open question →</span>
  {:else if item.kind==='approval'}
   <div class="row">
    <button class="compact-button" aria-label={'Review approval: '+item.approvalKind} onclick={()=>reviewItem(item)}>Review target…</button>
   </div>
  {:else if item.kind==='failure'}
   <div class="row">
    <button class="compact-button" aria-label={'Retry session '+item.sessionId} disabled={busy!==''} onclick={()=>void lifecycle(item,'retry')}>Retry</button>
   </div>
  {:else if item.kind==='interrupted'}
   {#if item.uncertain}
    <p class="attention-refusal" role="note">Operator attention: the effect cannot be proven, so it is not replayed. Review the conversation and the affected project files first. Acknowledgement only records that review; it does not undo the effect. New owner input is allowed only after acknowledgement. If verification fails, open this conversation in Agents and wait for it to settle. Clear or cancel queued and failed Pilot entries, release then cancel claimed entries, and reconcile submitted entries before you try again.</p>
    <div class="row"><button class="compact-button" aria-label={'Acknowledge interrupted work for session '+item.sessionId} disabled={busy!==''} onclick={()=>void acknowledge(item)}>Acknowledge interrupted work</button></div>
   {:else}
    <div class="row"><button class="compact-button" aria-label={'Resume session '+item.sessionId} disabled={busy!==''} onclick={()=>void lifecycle(item,'resume')}>Resume</button></div>
   {/if}
  {/if}
 </article>
 {:else}
 {#if !loading&&!missing&&count!==null&&count.complete&&count.open===0&&questions.length===0}<p class="inbox-empty">Nothing needs you. Questions, approvals, failures and interrupted runs appear here.</p>{/if}
 {/each}

 {#if page?.hasMore}
 <div class="row attention-more"><button class="compact-button" disabled={loadingMore} onclick={()=>void more()}>{loadingMore?'Loading…':'Show older items'}</button></div>
 {/if}
 {#if page}<p class="attention-limits">Limits: {page.limit} per page, {page.listedCap} listed. These are proposed defaults; owner policy is still pending.</p>{/if}
 {#if count?.capped&&page&&!page.hasMore}<p class="attention-limits">The list is capped at {page.listedCap} items. {count.complete?'The open count above includes every item.':'The count above is a floor while a source is unavailable.'}</p>{/if}

 {#if sources && (sources.questions==='unavailable'||sources.approvals==='unavailable'||sources.lifecycle==='unavailable')}
 <p class="attention-limits" role="note">Some sources are unavailable in this instance: {[sources.questions==='unavailable'?'questions':null,sources.approvals==='unavailable'?'approvals':null,sources.lifecycle==='unavailable'?'session states':null].filter(Boolean).join(', ')}. Nothing is guessed at.</p>
 {/if}

 {#if review}
 <div class="attention-review" role="group" aria-label="Approval review" bind:this={reviewElement}>
  <div class="attention-head"><span class="popover-heading">REVIEW APPROVAL</span><button class="text-button" aria-label="Close approval review" onclick={()=>review=null}>Close</button></div>
  <p class="attention-context"><strong>{review.approvalKind}</strong> · {reviewState?.state??'pending'} · expires {review.expiresAt}</p>
  <span class="popover-heading">EXACT TARGET</span>
  {#each targetFields(review) as field}
   <p class="attention-field"><span>{field.field}</span><code>{field.value}</code></p>
  {/each}
  <span class="popover-heading">SCOPE</span>
  {#each scopeFields(review) as field}
   <p class="attention-field"><span>{field.field}</span><code>{field.value}</code></p>
  {/each}
  <p class="inbox-hint">Consuming records who consumed this grant and returns the exact target. It performs no commit, push, deploy, spend, provision or publish by itself.</p>
  {#if reviewState && reviewState.state!=='pending'}
   <p class="inbox-hint" role="status">This approval is {reviewState.state} and cannot be consumed again.</p>
  {:else}
   <div class="row">
    <button class="primary compact-button" aria-label="Consume approval grant" disabled={busy!==''} onclick={()=>void consume()}>Consume grant</button>
    <button class="compact-button" aria-label="Revoke approval" disabled={busy!==''} onclick={()=>void revoke()}>Revoke</button>
   </div>
  {/if}
 </div>
 {/if}

 {#if unlinked}<p class="inbox-hint"><Icon name="book" size={13}/><span>{unlinked} active {unlinked===1?'task has':'tasks have'} no specification link</span></p>{/if}
 {#if questions.length}
 <span class="popover-heading">DOCUMENT QUESTIONS</span>
 {#each questions as question}
 <button class="inbox-item" onclick={()=>onopen(question.path,question.anchor)}>
  <span class="match-path">{question.path}:{question.line}</span>
  <span class="inbox-text">{question.text}</span>
 </button>
 {/each}
 {:else if !items.length&&!loading}
 <p class="inbox-empty">No open questions in this project's documentation.</p>
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
</div>
