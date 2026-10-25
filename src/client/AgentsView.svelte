<script lang="ts">
 import { api,ApiError,download,reportSessionExpired } from './api';
 import { openAgentStream,type ConnectionStatus } from './stream';
 import type { AgentView } from '../shared/agent';
 import { uniqueImageFiles,type ImageCapability,type ImageDraft } from '../shared/images';
 import ImageComposer from './ImageComposer.svelte';
 import { DraftStore,attemptFor,clearSaveFailure,draftSaveMessage,droppedFailureMessage,markSaveFailure,readSaveFailure,restoredImageItems,sessionKeyOf,storedAttachments,type StoredAttempt,type StoredDraft } from './drafts';
 type Capability={state:'known';provider:string;modelId:string;acceptsImages:boolean}|{state:'unknown';reason:string};
 type CachedDraft={text:string;media:ImageDraft[];attempt:StoredAttempt|null;savedAt:number|null;unsaved:boolean};
 import Icon from './Icon.svelte';
 import {request} from './api';
 import {modelKey,type ProviderSettings} from '../shared/settings';
 import type {ActionDescriptor} from '../shared/actions';
 import {slashMatches} from './slash';
 import {activityArrived,arrivalAfterFrame,countLabel,followIdentity,indicatorLabel,initialFollow,isNearBottom,readerScrolled,readerStillFollowing,type FollowState} from './follow';
 import SessionBar from './SessionBar.svelte';
 import SessionActivity from './SessionActivity.svelte';
 let { projectId,sessionId='',onsessionchange=()=>{},sessionListOpen=false,onsessionlistchange=()=>{},onmissing=()=>{},onerror,onquestions,agentsVersion=0,focusQuestion='' }:{
   projectId:string; sessionId?:string; onsessionchange?:(id:string)=>void;
   sessionListOpen?:boolean; onsessionlistchange?:(open:boolean)=>void; onmissing?:()=>void;
   onerror:(message:string)=>void; onquestions?:()=>void; agentsVersion?:number;
   /** An exact question an attention deep link names; the view scrolls to it once it is rendered. */
   focusQuestion?:string;
 }=$props();
 let view=$state<AgentView|null>(null),enabled=$state(true),draft=$state(''),sending=$state(false),problem=$state('');
 // A deep link names one exact question. It is only a scroll target: it opens nothing and answers
 // nothing, and an id this transcript does not hold simply has no target.
 $effect(()=>{const id=focusQuestion,loaded=view;if(!id||!loaded)return;const target=document.getElementById('question-'+id);target?.scrollIntoView({block:'center'});});
 // The stream's own state. `lastViewAt` is when a full snapshot was accepted, which is
 // different from transport freshness: an idle session stays `live` on keep-alives.
 let connection=$state<ConnectionStatus>({state:'connecting',detail:'Connecting…',attempt:0,lastFrameAt:null,lastViewAt:null});
 let reconnectNonce=$state(0),clock=$state(Date.now()),streamedIdentity='';
 // The session whose transcript the stream should follow. The route owns this value: the shell
 // passes the session named by the address or remembered for the project, and Back or Forward
 // changes it. An empty value means the project's root conversation.
 let selectedSessionId=$state('');
 // A direct link to a session this project does not have falls back to the root conversation and
 // opens the named-session list, instead of showing an empty transcript with no explanation.
 let sessionFallback=$state('');
 let answers=$state<Record<string,string>>({}),answering=$state('');
 // The images attached to the next message, and the one way the composer's upload path is fed.
 let media=$state<ImageDraft[]>([]),composerApi=$state<{add:(files:File[])=>void}|null>(null),composerDragging=$state(false);
 const readyImages=$derived(media.filter(item=>item.status==='ready'&&item.id).map(item=>item.id as string));
 // An image that is still uploading is not part of `readyImages` and its bytes are not stored yet, so
 // a send now would leave it out of the message and then clear the strip. The send waits for it, and
 // this is the one reading both the buttons and the sender use.
 const uploadingImages=$derived(media.some(item=>item.status==='uploading'));
 // A restored reference is not sendable until the composer has looked it up on the server.
 const checkingImages=$derived(media.some(item=>item.status==='checking'));
 const unsettledImages=$derived(uploadingImages||checkingImages);
 /**
  * Per-project, per-session drafts in browser storage, plus an in-memory cache of the latest text.
  *
  * The store is browser-local working state: it is not a second source of truth, it holds image
  * references but never image bytes, and it adds no credential of its own (the text is whatever the
  * person typed and may itself contain a secret). A save failure never discards the text in this
  * tab: the cache below keeps the latest state across session switches, and the person can copy or
  * download it. Only an admitted send, an explicit clear, or a newer save of the same key removes a
  * draft. No age, clock or count rule deletes a valid draft.
  */
 const draftStorage=typeof localStorage==='undefined'?null:localStorage;
 const drafts=new DraftStore(draftStorage);
 const draftCache=new Map<string,CachedDraft>();
 let pendingWrite:{project:string;session:string}|null=null;
 let writeTimer:ReturnType<typeof setTimeout>|null=null;
 let draftGeneration=0;
 let currentIdentityKey='';
 const identityKey=$derived(projectId+':'+sessionKeyOf(selectedSessionId));
 const currentSessionLabel=$derived(sessionKeyOf(selectedSessionId)==='root'?'the root conversation':'session '+sessionKeyOf(selectedSessionId));
 let restoredNotice=$state(''),storageNotice=$state(''),draftSavedAt=$state<number|null>(null);
 let latestUnsaved=$state(false),markerAt=$state<number|null>(null);
 let pendingAttempt=$state<StoredAttempt|null>(null);
 // `unknown` means it could not be read; the server still checks at admission and dispatch.
 let capability=$state<Capability>({state:'unknown',reason:'Image support has not been checked for this session yet.'});
 // The model key the current capability belongs to, the last streamed key already looked up, and a
 // revision that discards a lookup which started before a newer model reading.
 let capabilityModel='',capabilityRequested='',capabilityRevision=0;
 /**
  * The warning used before a send whose attempt record could not be saved. A rejected local save
  * during the catch phase must not replace it with a generic quota message: the admission may
  * already have happened while the reply was lost.
  */
 const UNSAVED_SEND_WARNING='The message and its request identity could not be saved locally. Admission can still succeed if the reply is lost, and a reload may not recognise it as already sent. Check the transcript before resending. Copying or downloading keeps the text only; it does not prevent a duplicate.';
 const imageCapabilityBlocked=$derived(readyImages.length>0&&capability.state==='known'&&capability.acceptsImages===false);
 const sendHoldReason=$derived(uploadingImages?'An image is still uploading: the message is held until it is stored':checkingImages?'A stored image is still being checked: the message is held until it is ready':imageCapabilityBlocked?'The model for this session does not accept images':'');
 // A session id is bounded by the server's own rule before it is used for a request or shown.
 const SESSION_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
 const SESSION_FALLBACK='The session named in this link is not in this project. Choose a session from the list.';
 function sessionMissing():void{
   selectedSessionId='';
   sessionFallback=SESSION_FALLBACK;
   onsessionchange('');
   onsessionlistchange(true);
   onmissing();
 }
 // Follow the route's session. The shell resolves the remembered selection at boot and on a
 // project change; this component never writes a different session into the route by itself.
 let fallbackProject='';
 $effect(()=>{
   const project=projectId;
   if(project!==fallbackProject){fallbackProject=project;sessionFallback='';}
   if(sessionId===selectedSessionId)return;
   if(sessionId&&!SESSION_ID.test(sessionId)){sessionMissing();return;}
   selectedSessionId=sessionId;sessionFallback='';
 });
 // A named session is only a preference until the server confirms it exists in this project.
 // A malformed id never reaches the server: the effect above already fell back.
 $effect(()=>{
   const project=projectId,wanted=sessionId;
   if(!wanted||!SESSION_ID.test(wanted))return;
   let current=true;
   void api.sessions(project).then(list=>{
     if(!current||project!==projectId||selectedSessionId!==wanted)return;
     if(!list.sessions.some(session=>session.id===wanted))sessionMissing();
   }).catch(()=>{ /* the server still decides; the draft stays keyed by the selected id */ });
   return ()=>{current=false;};
 });
 $effect(()=>{
   // An upload cannot follow the screen into another session: its callback is dropped when the
   // identity changes. Any image still uploading for the identity being left is therefore named
   // missing in that identity's own draft, rather than shown as "Checking…" forever or moved.
   const previous=currentIdentityKey;
   if(previous&&previous!==identityKey){
     const entry=draftCache.get(previous);
     if(entry){
       let changed=false;
       entry.media=entry.media.map(item=>{
         if(item.status!=='uploading')return item;
         changed=true;
         return {...item,status:'missing',reason:'The upload did not finish before this session was left, so the image was not attached here. Add it again or remove it.'};
       });
       if(changed)entry.unsaved=false;
     }
   }
   // Finish the previous identity's pending write before the screen changes, so a switch never
   // loses the last keystrokes to a debounce that has not fired yet.
   flushPendingSave();
   currentIdentityKey=identityKey;
   // Reading both values is what makes a project switch and a session switch restore that
   // identity's own draft, and nothing else.
   const project=projectId;
   const session=sessionKeyOf(selectedSessionId);
   const generation=++draftGeneration;
   draft='';media=[];sending=false;problem='';restoredNotice='';storageNotice='';draftSavedAt=null;latestUnsaved=false;markerAt=null;pendingAttempt=null;
   capability={state:'unknown',reason:'Image support has not been checked for this session yet.'};
   capabilityModel='';capabilityRequested='';capabilityRevision+=1;
   const cached=draftCache.get(identityKey);
   if(cached){
     // The latest text lives in this tab even when the last save was refused. A switch back
     // shows it, not the older record that managed to reach storage.
     draft=cached.text;media=cached.media.map(item=>({...item}));pendingAttempt=cached.attempt;draftSavedAt=cached.savedAt;latestUnsaved=cached.unsaved;
     if(cached.unsaved)storageNotice='This tab holds text that could not be saved locally. Copy or download it before reloading or closing the tab; neither prevents a duplicate admission, so check the transcript before resending.';
   }else{
     const loaded=drafts.load(project,session);
     const label=session==='root'?'the root conversation':'session '+session;
     if(loaded.status==='loaded'){
       draft=loaded.draft.text;
       media=restoredImageItems(loaded.draft.attachments);
       pendingAttempt=loaded.draft.attempt;
       draftSavedAt=loaded.draft.updatedAt;
       if(loaded.draft.text!==''||loaded.draft.attachments.length>0)
         restoredNotice='Draft restored for '+label+', saved '+new Date(loaded.draft.updatedAt).toLocaleString()+'.';
     }else if(loaded.status==='corrupt'){
       // The record is left in place: its bytes may still be recoverable, and a new save of this
       // identity replaces it. Nothing is silently deleted by a read.
       restoredNotice='A stored draft for '+label+' could not be read. It was left in this browser and is not shown here; typing replaces it.';
     }else if(loaded.status==='unavailable'){
       storageNotice=draftSaveMessage({ok:false,reason:'unavailable',detail:''});
     }
     const marker=readSaveFailure(draftStorage,project,session);
     if(marker.status==='present'){
       markerAt=marker.at;
       const when=marker.at>0?new Date(marker.at).toLocaleString():'earlier';
       const hasSaved=draft!==''||media.length>0;
       storageNotice='A later local save failed in this browser at '+when+'. '
         +(hasSaved?'The text below is the last saved version and may be older than what you typed.':'No saved version is available here. ')
         +'Check the transcript before resending, because a message you sent may already be admitted. Copying or downloading keeps the text only; it does not prevent a duplicate.';
     }
   }
   // Recovery is read-only: local text now, and a media lookup the image strip performs itself.
   // No upload, no send, no model call and no session action starts here.
 });
 /** Apply the image capability the server reported with a view. */
 function applyCapability(vision:ImageCapability|null):void{
   capabilityRevision+=1;
   if(vision){
     capability={state:'known',...vision};
     capabilityModel=modelKey({provider:vision.provider,modelId:vision.modelId});
   }else{
     capability={state:'unknown',reason:'The server did not report image support for this session.'};
     capabilityModel='';
   }
 }
 /** Keep the latest composer state for this identity in memory, whatever storage does. */
 function rememberCurrent():void{
   if(!projectId)return;
   draftCache.set(identityKey,{text:draft,media:media.map(item=>({...item})),attempt:pendingAttempt,savedAt:draftSavedAt,unsaved:latestUnsaved});
 }
 /** Build the record a save would write, or null when the composer is empty. */
 function recordOf(project:string,session:string,entry:CachedDraft):StoredDraft|null{
   const ids=entry.media.filter(item=>item.status==='ready'&&item.id).map(item=>item.id as string);
   const attempt=attemptFor(entry.attempt,entry.text.trim(),ids);
   if(entry.text===''&&entry.media.length===0&&attempt===null)return null;
   return {v:1,projectId:project,session,text:entry.text,updatedAt:Date.now(),attachments:storedAttachments(entry.media),attempt};
 }
 /**
  * Write one identity's latest state. A refusal marks the cache unsaved, keeps the last successful
  * save time, and writes a small best-effort warning marker for the next load. No draft is removed
  * because a write failed.
  */
 function writeNow(project:string,session:string):void{
   const key=project+':'+session;
   const entry=draftCache.get(key);
   if(!entry)return;
   const record=recordOf(project,session,entry);
   if(record===null){
     drafts.remove(project,session);
     entry.savedAt=null;entry.unsaved=false;
     if(key===identityKey){
       draftSavedAt=null;latestUnsaved=false;markerAt=null;
       if(storageNotice!=='')storageNotice='';
     }
   }else{
     const result=drafts.save(record);
     if(result.ok){
       entry.savedAt=Date.now();entry.unsaved=false;markerAt=null;
       clearSaveFailure(draftStorage,project,session);
       if(key===identityKey)draftSavedAt=entry.savedAt;
       if(key===identityKey){
         if(result.droppedFailureNotes>0)storageNotice=droppedFailureMessage(result.droppedFailureNotes);
         else if(storageNotice!=='')storageNotice='';
       }
     }else{
       entry.unsaved=true;
       const marked=markSaveFailure(draftStorage,project,session,Date.now());
       if(key===identityKey){
         latestUnsaved=true;
         storageNotice=draftSaveMessage(result)+(marked?'':' The warning marker could not be written either.');
       }
     }
   }
   if(key===identityKey){latestUnsaved=entry.unsaved;if(entry.unsaved)markerAt=Date.now();}
 }
 /** Flush the pending debounced write now. Called before a send, a switch and on page hide. */
 function flushPendingSave():void{
   if(writeTimer!==null){clearTimeout(writeTimer);writeTimer=null;}
   const pending=pendingWrite;
   pendingWrite=null;
   if(pending)writeNow(pending.project,pending.session);
 }
 /** Save now, or after a short quiet period for typing. */
 function persistDraft(immediate=false):void{
   const project=projectId,session=sessionKeyOf(selectedSessionId);
   if(!project)return;
   rememberCurrent();
   pendingWrite={project,session};
   if(immediate){flushPendingSave();return;}
   if(writeTimer!==null)clearTimeout(writeTimer);
   writeTimer=setTimeout(()=>{writeTimer=null;flushPendingSave();},200);
 }
 /** Copy the latest text, including references to stored images. */
 async function copyDraft():Promise<void>{
   const ids=media.filter(item=>item.status==='ready'&&item.id).map(item=>item.id as string);
   const text=draft+(ids.length?'\n\nStored image references:\n'+ids.join('\n'):'');
   try{
     await navigator.clipboard.writeText(text);
     restoredNotice='Draft copied to the clipboard.';
   }catch{
     problem='The browser refused to copy the draft. Select the text and copy it, or use Download draft.';
   }
 }
 /** Download the latest text and its stored image references as a plain file. */
 function downloadDraft():void{
   const ids=media.filter(item=>item.status==='ready'&&item.id).map(item=>item.id as string);
   const text=draft+(ids.length?'\n\nStored image references:\n'+ids.join('\n'):'');
   download('pilot-draft-'+sessionKeyOf(selectedSessionId)+'.txt',text);
   restoredNotice='Draft downloaded.';
 }
 /** Remove every draft this browser holds. Deliberate, confirmed and local only. */
 function clearLocalDrafts():void{
   if(!confirm('Clear every draft saved in this browser? Text and image references in all projects and sessions will be removed. Nothing on the server changes.'))return;
   const removed=drafts.clearAll();
   draftCache.clear();
   pendingWrite=null;
   if(writeTimer!==null){clearTimeout(writeTimer);writeTimer=null;}
   draft='';media=[];pendingAttempt=null;draftSavedAt=null;latestUnsaved=false;markerAt=null;
   restoredNotice='';storageNotice=removed>0?'Cleared local drafts. Nothing on the server changed.':'No local draft was stored.';
 }
 // A phone can hide or close the tab without another event. Flush the pending write then.
 $effect(()=>{
   const flush=()=>flushPendingSave();
   const hidden=()=>{if(document.visibilityState==='hidden')flush();};
   // A navigation flushes before the session or view can change, so the last keystrokes are in
   // storage and not only in this component.
   const navigating=()=>flush();
   window.addEventListener('pagehide',flush);
   window.addEventListener('pilot:navigate',navigating);
   document.addEventListener('visibilitychange',hidden);
   return()=>{window.removeEventListener('pagehide',flush);window.removeEventListener('pilot:navigate',navigating);document.removeEventListener('visibilitychange',hidden);flushPendingSave();};
 }); function selectSession(id:string):void{
   sessionFallback='';
   selectedSessionId=id;
   // The shell writes the remembered selection and the address; this component follows the route.
   onsessionchange(id);
 }
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
 let composerElement=$state<HTMLDivElement>();
 let streamGeneration=0;
 /**
  * Follow-scroll state for the transcript shown here.
  *
  * The state and the entry count belong to one project and session. A switch starts from the default
  * (following, nothing counted) and bumps a generation, so a scroll, resize or stream callback that
  * was queued for the previous identity can neither move this transcript nor add to this count.
  */
 let follow=$state<FollowState>(initialFollow());
 let followKey='';
 let followGeneration=0;
 let seenEntryCount=0;
 /** The position this page last scrolled the transcript to, or null when it never has. */
 let lastFollowScrollTop:number|null=null;
 /** Set while this page's own scroll is in flight, so its event is never read as reader input. */
 let programmaticScroll=false;
 /**
  * Compact chrome on a phone or a short screen, and the sparser variant that also gives up the
  * activity timeline and scrolls the whole section so the composer stays docked. Both are decided
  * from the section's measured width and height, so the conversation keeps a usable height instead
  * of being squeezed to nothing by fixed panels. The decision never reads the transcript's own
  * resulting height, so a layout change can never feed back into it.
  */
 let shell=$state<HTMLElement>();
 let chromeCompact=$state(false);
 const COMPACT_WIDTH=620,COMPACT_HEIGHT=700;
 function metricsOf(element:HTMLElement):{scrollTop:number;clientHeight:number;scrollHeight:number}{
   return {scrollTop:element.scrollTop,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight};
 }
 /** Scroll the transcript to its newest content. Always instant: no jump is ever animated. */
 function scrollToBottom():void{
   const element=transcript;
   if(!element)return;
   programmaticScroll=true;
   element.scrollTop=element.scrollHeight;
   lastFollowScrollTop=element.scrollTop;
   // A scroll that was already at the bottom emits no event, so the flag is cleared next frame.
   requestAnimationFrame(()=>{programmaticScroll=false;});
 }
 /** Resume following and show the newest content. Used by the indicator and by an admitted send. */
 function showNewest():void{
   follow=initialFollow();
   scrollToBottom();
 }
 /**
  * The reader moved the transcript: at the bottom follows, above it pauses and keeps its place.
  *
  * Only this page's own scroll is excluded, and it is marked before it happens. Every other scroll
  * that moved the position up and away from the bottom pauses, including one made by a script or by
  * assistive technology; such a scroll is never ignored. A scroll that left the position where this
  * page put it is a layout change below the reader (the browser grew the content or clamped the
  * end), not a move by the reader, and the resize observer then decides.
  */
 function onTranscriptScroll():void{
   const element=transcript;
   if(!element)return;
   if(programmaticScroll){programmaticScroll=false;return;}
   const live=metricsOf(element);
   if(isNearBottom(live)){
     lastFollowScrollTop=live.scrollTop;
     if(!follow.following)follow=initialFollow();
     return;
   }
   if(readerStillFollowing(live,lastFollowScrollTop))return;
   const next=readerScrolled(follow,live);
   if(next!==follow)follow=next;
 }
 /**
  * Compact chrome when the section is narrow or short. Secondary content is moved into a native
  * disclosure, never deleted, and the transcript keeps its floor: when the section cannot fit the
  * floor plus the chrome, the section itself scrolls in normal flow.
  */
 function updateChromeBudget():void{
   const element=shell;
   if(!element)return;
   const width=element.clientWidth,height=element.clientHeight;
   if(width<=0||height<=0)return;
   const compact=width<=COMPACT_WIDTH||height<COMPACT_HEIGHT;
   if(chromeCompact!==compact)chromeCompact=compact;
 }
 $effect(()=>{
   const element=shell;
   if(!element)return;
   const observer=new ResizeObserver(()=>updateChromeBudget());
   observer.observe(element);
   updateChromeBudget();
   return ()=>observer.disconnect();
 });
 let modelSettings=$state<ProviderSettings|null>(null),selectedModel=$state(''),modelBusy=$state(false);
 async function loadModels(){try{modelSettings=await request('/settings/providers');}catch(e){problem=(e as Error).message;}}
 async function chooseModel(){
  if(modelBusy)return;modelBusy=true;problem='';
  const m=modelSettings?.models.find(m=>modelKey(m)===selectedModel);
  try{
    // The response carries the capability of the model now in force, so the composer does not
    // keep an older reading after a model change.
    const next=await request<AgentView&{vision:ImageCapability|null}>('/projects/'+projectId+'/agents/model','POST',{sessionId:selectedSessionId||undefined,model:m?{provider:m.provider,modelId:m.modelId}:null});
    view=next;
    applyCapability(next.vision??null);
  }
  catch(e){problem=(e as Error).message;}
  finally{modelBusy=false;}
 }
 $effect(()=>{
   const id=projectId;
   const sessionId=selectedSessionId;
   // Reading the nonce makes a manual reconnect restart this effect. Every run owns one
   // generation and one abort controller, so an older stream can never write this view.
   const nonce=reconnectNonce;
   const generation=++streamGeneration;
   const controller=new AbortController();
   let cancelled=false;
   const current=()=>!cancelled&&generation===streamGeneration&&!controller.signal.aborted;
   // A project or session switch starts from an empty view, so no entry of the conversation just
   // left can be measured or scrolled against the new one. A reconnect of the same conversation
   // keeps the last confirmed snapshot visible until its replacement arrives.
   const streamIdentity=id+'\u0000'+sessionId;
   if(streamIdentity!==streamedIdentity){streamedIdentity=streamIdentity;view=null;}
   connection={state:'connecting',detail:nonce>0?'Reconnecting…':'Connecting…',attempt:0,lastFrameAt:null,lastViewAt:null};
   void (async()=>{
     try{
       const snapshot=await api.agents(id,sessionId||undefined);
       if(!current())return;
       enabled=snapshot.enabled;
       if(sessionId===''){view=snapshot.view;}
       applyCapability(snapshot.vision??null);
       selectedModel=view?.model?.provider==='faux'?'':view?.model?modelKey(view.model):'';
       await loadModels();
       if(!snapshot.enabled)return;
     }catch(e){
       if(current())connection={state:'server-error',detail:(e as Error).message,attempt:0,lastFrameAt:null,lastViewAt:null};
       if(!cancelled)onerror((e as Error).message);
       return;
     }
     try{
       await openAgentStream({
         projectId:id,
         sessionId:sessionId||undefined,
         signal:controller.signal,
         onView:next=>{
           if(!current())return;
           view=next;
           // A model chosen by another client changes the model in the streamed view. Read the
           // capability once for that model through the same view request: no model dispatch, no
           // retry loop (the key is attempted once per stream run), and no capability guess.
           const streamed=next.model?modelKey(next.model):'';
           if(streamed&&streamed!==capabilityModel&&streamed!==capabilityRequested){
             capabilityRequested=streamed;
             // A newer model reading (a model change, for example) bumps the revision, so this
             // answer cannot overwrite it when it returns late.
             const revision=++capabilityRevision;
             void api.agents(id,sessionId||undefined).then(snapshot=>{
               if(!current()||revision!==capabilityRevision)return;
               if(snapshot.vision)applyCapability(snapshot.vision);
             }).catch(()=>{ /* keep the previous reading; admission and dispatch still check */ });
           }
         },
         onStatus:next=>{if(current())connection=next;},
         onAuthExpired:()=>reportSessionExpired()
       });
     }catch(e){
       if(current())connection={state:'server-error',detail:(e as Error).message,attempt:0,lastFrameAt:null,lastViewAt:null};
     }
   })();
   return ()=>{cancelled=true;controller.abort();};
 });
 $effect(()=>{const timer=setInterval(()=>{clock=Date.now();},5000);return()=>clearInterval(timer);});
 const snapshotAge=$derived(connection.lastViewAt===null?null:Math.max(0,Math.floor((clock-connection.lastViewAt)/1000)));
 const snapshotAgeText=$derived(snapshotAge===null?'':' · last snapshot '+(snapshotAge<5?'just now':snapshotAge+'s ago'));
 // Only a terminal state needs an owner action. While retrying, the manager owns the loop.
 const canReconnect=$derived(connection.state==='offline'||connection.state==='stale'||connection.state==='server-error');
 function reconnect(){reconnectNonce+=1;}
 // New entries: follow them only when the reader is following, otherwise count them (bounded).
 // The live position decides, so a reader whose move has not been handled as an event yet is not
 // dragged to the bottom by the next frame. Reading the identity makes a project or session switch
 // reset the follow state and the count, so the previous session's number can never appear here.
 $effect(()=>{
   const key=followIdentity(projectId,sessionKeyOf(selectedSessionId));
   const count=view?.entries.length??0;
   const element=transcript;
   if(key!==followKey){
     followKey=key;followGeneration+=1;
     follow=initialFollow();seenEntryCount=count;lastFollowScrollTop=null;
     // A newly selected conversation opens at its newest entry. This is not a jump inside it.
     if(count>0&&element)scrollToBottom();
     return;
   }
   if(count===seenEntryCount)return;
   const previous=seenEntryCount;
   seenEntryCount=count;
   const live=element?metricsOf(element):null;
   const next=live?arrivalAfterFrame(follow,previous,count,live,lastFollowScrollTop):activityArrived(follow,previous,count);
   if(next!==follow)follow=next;
   if(next.following)scrollToBottom();
 });
 // A layout change the entry count cannot see — the phone keyboard, a rotation, an image that
 // finished decoding, streamed text that rewrapped — must not steal a paused reader's place. When
 // the reader is following, it keeps them at the bottom. A callback owned by a previous identity is
 // dropped, so a resize can never scroll another session's transcript.
 $effect(()=>{
   const element=transcript;
   if(!element)return;
   const key=followKey;
   const generation=followGeneration;
   const observer=new ResizeObserver(()=>{
     if(generation!==followGeneration||key!==followKey)return;
     if(!follow.following)return;
     const live=metricsOf(element);
     if(!readerStillFollowing(live,lastFollowScrollTop))return;
     scrollToBottom();
   });
   observer.observe(element);
   const body=element.firstElementChild;
   if(body)observer.observe(body);
   return ()=>observer.disconnect();
 });
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
   // A message needs text or an image; a refused, failed or missing image is never sent, and stays
   // visible until it is removed or recovered.
   if((text===''&&images.length===0)||sending)return;
   // An upload in flight or a reference being checked is not a stored image. Sending here would
   // send the text without it and then leave it behind, so the message is held with its own reason.
   // The Send and Steer buttons are disabled on this very condition, with the state named next to
   // them, so a person never reaches this branch without being told why.
   if(uploadingImages){problem='An image is still uploading. Wait for it to finish, then send — sending now would leave it out of the message.';return;}
   if(checkingImages){problem='A stored image is still being checked with the server. Wait for it to finish, then send.';return;}
   if(images.length>0&&capability.state==='known'&&capability.acceptsImages===false){problem='The model '+capability.provider+' / '+capability.modelId+' does not accept images, so this message is not sent with them. Remove the images or choose a model that accepts images.';return;}
   const generation=draftGeneration,identityAtSend=identityKey;
   const sentText=text,sentKeys=media.filter(item=>item.status==='ready'&&item.id).map(item=>item.key),sentImages=[...images];
   // The same message retries under the same request identity, so an ambiguous network failure
   // cannot become two admissions. An edited message is a new message and a new identity.
   const attempt=attemptFor(pendingAttempt,sentText,sentImages)??{requestId:crypto.randomUUID(),text:sentText,images:sentImages};
   pendingAttempt=attempt;
   // Persist the attempt before the request: a reload while it is in flight keeps the identity, so
   // sending it again after the reload is one admission rather than two.
   persistDraft(true);
   const unsavedAttempt=latestUnsaved;
   if(unsavedAttempt){
     // Without the attempt record, a reload cannot prove this send was already admitted. The
     // message can still succeed while its reply is lost, so say so rather than implying a
     // downloaded copy removes the risk of a duplicate.
     storageNotice=UNSAVED_SEND_WARNING;
   }
   sending=true;problem='';
   try{
     await api.agentInput(projectId,{text,mode,requestId:attempt.requestId,sessionId:selectedSessionId||undefined,images});
     // A switch while this was in flight means the result belongs to the old identity, and the new
     // session's draft, text and images are not touched.
     if(generation!==draftGeneration||identityKey!==identityAtSend)return;
     // Only an admitted message returns the reader to the newest content and resumes following. A
     // refused or failed send leaves the reading position exactly where the person left it.
     showNewest();
     // Text typed while the send awaited is the person's work, not part of what was admitted.
     if(draft.trim()===sentText)draft='';
     else restoredNotice='The message was sent. The text you typed while it was sending was kept.';
     // Only the images that were submitted leave the strip. An image added while the send awaited
     // stays, and a failed, refused or missing one is never silently dropped.
     const sent=new Set(sentKeys);
     media=media.filter(item=>!sent.has(item.key));
     pendingAttempt=null;
     persistDraft(true);
   }catch(e){
     if(generation===draftGeneration&&identityKey===identityAtSend){
       problem=(e as Error).message;
       // The draft and its request identity stay. A rejection admitted nothing, and a network
       // failure may have been admitted, so a retry of the same text is the same request.
       persistDraft(true);
       // The catch-phase save can fail too and replace the notice with a generic quota message.
       // Put the explicit ambiguity warning back when it still applies, so the person knows the
       // reply may be lost rather than only that local storage is full.
       const ambiguous=!(e instanceof ApiError)||e.kind!=='http'||e.status>=500||e.status===0;
       if(unsavedAttempt&&ambiguous&&latestUnsaved)storageNotice=UNSAVED_SEND_WARNING;
     }
   }finally{
     if(generation===draftGeneration&&identityKey===identityAtSend)sending=false;
   }
 }
 async function answer(questionId:string){
   const text=(answers[questionId]??'').trim();
   if(text==='')return;
   answering=questionId;problem='';
   try{await api.agentAnswer(projectId,{questionId,text,sessionId:selectedSessionId||undefined});answers={...answers,[questionId]:''};}
   catch(e){problem=(e as Error).message;}
   finally{answering='';}
 }
 async function stop(){
   problem='';
   try{await api.agentAbort(projectId,selectedSessionId||undefined);}
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
   try{actions=(await api.actions({projectId,...(view?.conversationId?{sessionId:selectedSessionId||view.conversationId}:{})})).actions;}
   catch{actions=[];}
 }
 async function runSlash(action:ActionDescriptor){
   slashRefusal='';slashResult='';
   try{
     const executed=await api.runAction(action.id,{scope:{projectId,...(view?.conversationId?{sessionId:selectedSessionId||view.conversationId}:{})}});
     slashResult='Ran '+executed.action+': '+JSON.stringify(executed.result).slice(0,300);
     draft='';pendingAttempt=null;persistDraft(true);
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
   try{await api.dismissQuestion(projectId,{questionId,reason,sessionId:selectedSessionId||undefined});dismissOpen=null;dismissReason='';}
   catch(e){problem=(e as Error).message;}
   finally{dismissing='';}
 }
</script>
<section class="agents" class:compact={chromeCompact} bind:this={shell}>
 {#if view?.conversationId||selectedSessionId}<SessionBar {projectId} sessionId={selectedSessionId||view?.conversationId||''} {view} {agentsVersion} compact={chromeCompact} listOpen={sessionListOpen} onlistchange={onsessionlistchange} onerror={(message)=>onerror(message)} onsessionchange={(id)=>selectSession(id)}/>{/if}
 {#if sessionFallback}<p class="error agents-problem" role="alert">{sessionFallback}</p>{/if}
 {#snippet modelIdentity()}
 <div class="model-identity">
  <span class="eyebrow">{!view?.model||view.model.provider==='faux'?'SCRIPTED TEST PROVIDER':'MODEL PROVIDER'}</span>
  <h2>{view?.model?view.model.provider+' / '+view.model.modelId:'Agent'}</h2>
  <span class="pill" title="No model is called and nothing is spent: replies come from a deterministic local provider.">no model called</span>
 </div>
 {/snippet}
 {#if enabled}
 <!-- The activity timeline is a native disclosure at every width: open on a roomy screen, closed
      on a phone so it cannot grow and squeeze the conversation. Its content is never removed. -->
 <details class="activity-more" open={!chromeCompact}>
  <summary>Activity</summary>
  <SessionActivity {projectId} sessionId={selectedSessionId} {view}/>
 </details>
 {/if}
 <header class="agents-head">
  {#if chromeCompact}
  <details class="head-more"><summary>Model &amp; provider</summary>{@render modelIdentity()}</details>
  {:else}
  {@render modelIdentity()}
  {/if}
  <label class="model-picker">Session model<select aria-label="Session model" bind:value={selectedModel} disabled={working||modelBusy} onfocus={()=>void loadModels()} onchange={()=>void chooseModel()}>
   <option value="">Scripted test provider (free)</option>
   {#each modelSettings?.models.filter(m=>m.configured)??[] as m (modelKey(m))}<option value={modelKey(m)}>{modelSettings?.preferences.favourites.some(c=>modelKey(c)===modelKey(m))?'★ ':''}{m.provider} / {m.name}</option>{/each}
  </select></label>
  <span class="agent-state" class:busy={working} role="status">{working?'Working…':'Idle'}</span>
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
 <!-- The transcript is a scrollable region, so it is keyboard-reachable and its own input is
      read as reader movement. Svelte's a11y rules do not model that scroll-region pattern. -->
 <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
 <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
 <div class="agent-transcript-wrap">
  <!-- The control has its own reserved row below the scroller, so it never covers text and the
       scroller simply becomes shorter while it is shown. -->
  <div class="agent-transcript" role="region" aria-label="Agent transcript" bind:this={transcript} tabindex="0" onscroll={onTranscriptScroll}>
  <div class="agent-transcript-body">
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
  </div>
  <!-- A live region that exists from the first frame, so both a count and a plain jump are announced
       when they appear. The control is outside it, because an interactive element inside a live
       region is re-announced by some screen readers. -->
  <span class="sr-only" role="status" aria-live="polite" data-follow-status>{follow.following?'':(follow.missed>0?countLabel(follow.missed)+' while scrolled up':'Newer activity is below')}</span>
  {#if !follow.following}
  <div class="new-activity-row">
   <button class="new-activity" data-follow="indicator" aria-label={indicatorLabel(follow)+' and resume following'} onclick={()=>showNewest()}>{follow.missed>0?'↓ '+countLabel(follow.missed):'↓ Jump to newest'}</button>
  </div>
  {/if}
 </div>
 {#if view?.inbox.length}
 <div class="agent-queue" aria-label="Queued messages">
  <span class="popover-heading">QUEUED</span>
  {#each view.inbox as item (item.id)}<p><span class="pill">{item.mode}</span>{item.text}</p>{/each}
 </div>
 {/if}
 <!-- svelte-ignore a11y_no_static_element_interactions -->
 <div class="agent-composer" bind:this={composerElement} onpaste={(event)=>composerEvent(event)} ondrop={(event)=>composerEvent(event)}
      ondragover={(event)=>{event.preventDefault();composerDragging=true;}} ondragleave={()=>composerDragging=false}>
  <ImageComposer projectId={projectId} sessionId={selectedSessionId||undefined} identity={identityKey} bind:items={media} dragging={composerDragging} handle={(composer)=>{composerApi=composer;}} onchange={()=>persistDraft(true)}/>
  {#if slashPicks}
  <div class="slash-list" aria-label="Slash commands">
   <span class="popover-heading">SLASH COMMANDS — from the action registry</span>
   {#if slashPicks.length===0}<p class="muted">No registry action matches. Type a message, or / to list commands.</p>{/if}
   {#each slashPicks as action,index (action.id)}
   <button class="slash-row" class:highlighted={index===slashHighlight} aria-label={'Run '+action.label} onclick={()=>void runSlash(action)}><code>/{action.id}</code><span>{action.label}</span></button>
   {/each}
  </div>
  {/if}
  {#if restoredNotice}<p class="agent-status draft-notice" role="status">{restoredNotice}</p>{/if}
  {#if storageNotice}<p class="error draft-notice" role="alert">{storageNotice}</p>{/if}
  <label>Message the agent<textarea aria-label="Message the agent" value={draft} onfocus={()=>composerElement?.scrollIntoView({block:'nearest'})} oninput={(event)=>{draft=(event.currentTarget as HTMLTextAreaElement).value;persistDraft();}} onkeydown={(event)=>composerKey(event)} placeholder="Ask for something, type / for commands, or include [pause]. Enter sends; Shift+Enter adds a newline."></textarea></label>
  {#if media.length>0&&capability.state==='known'&&capability.acceptsImages===false}
  <p class="image-capability" role="alert">The model {capability.provider} / {capability.modelId} does not accept images. Remove the images or choose a model that accepts images before sending.</p>
  {:else if media.length>0&&capability.state==='unknown'}
  <p class="image-capability" role="status">Image support for this session could not be checked: {capability.reason} The server checks again when you send.</p>
  {/if}
  {#if latestUnsaved}
  <div class="draft-unsaved" role="alert">
   <small>Not saved locally. {draftSavedAt?('Last saved at '+new Date(draftSavedAt).toLocaleTimeString()+'.'):'Nothing has been saved yet.'} The latest text is kept in this tab only.</small>
   <button class="compact-button" aria-label="Copy the unsaved draft" onclick={()=>void copyDraft()}>Copy draft</button>
   <button class="compact-button" aria-label="Download the unsaved draft" onclick={downloadDraft}>Download draft</button>
  </div>
  {:else if draftSavedAt}<small class="draft-saved">Draft saved for {currentSessionLabel} at {new Date(draftSavedAt).toLocaleTimeString()} · kept in this browser only</small>{/if}
  {#if chromeCompact}
  <details class="draft-more"><summary>Draft tools</summary>
   <div class="draft-local-actions"><button class="compact-button" aria-label="Clear local drafts" onclick={clearLocalDrafts}>Clear local drafts</button></div>
  </details>
  {:else}
  <div class="draft-local-actions"><button class="compact-button" aria-label="Clear local drafts" onclick={clearLocalDrafts}>Clear local drafts</button></div>
  {/if}
  {#if slashRefusal}<p class="error" role="alert">{slashRefusal}</p>{/if}
  {#if slashResult}<p class="agent-status" role="status">{slashResult}</p>{/if}
  <div class="row">
   <!-- Stop belongs with the other primary controls, so a short screen finds it beside Send and
        Steer instead of only in the header above the transcript. -->
   <button class="compact-button" aria-label="Stop the agent" disabled={!working} onclick={()=>void stop()}><Icon name="close" size={14}/><span>Stop</span></button>
   <button class="primary compact-button" aria-label="Send message" disabled={sending||unsettledImages||imageCapabilityBlocked||(draft.trim()===''&&readyImages.length===0)} title={sendHoldReason||undefined} onclick={()=>void send('followUp')}><Icon name="arrow" size={14}/><span>{working?'Queue follow-up':'Send'}</span></button>
   <button class="compact-button" aria-label="Steer the run" disabled={sending||unsettledImages||imageCapabilityBlocked||!working||(draft.trim()===''&&readyImages.length===0)} title={sendHoldReason||undefined} onclick={()=>void send('steer')}>Steer current run</button>
   {#if unsettledImages}<small class="agent-upload-state" role="status">{uploadingImages?'Uploading an image — the message is held until it is stored':'Checking a stored image — the message is held until it is ready'}</small>{/if}
   <small class="agent-status connection" data-connection={connection.state} title={connection.lastFrameAt===null?'No frame received on this attempt':('Last transport frame '+new Date(connection.lastFrameAt).toLocaleTimeString())}>
    <span class="connection-dot {connection.state}" aria-hidden="true"></span>
    <span role="status" aria-live="polite">{connection.state==='live'?'Live':connection.detail}</span>
    <span aria-hidden="true">{snapshotAgeText}</span>
   </small>
   {#if connection.state==='auth-required'}
   <button class="compact-button" aria-label="Reload to sign in" onclick={()=>location.reload()}>Reload to sign in</button>
   {:else if canReconnect}
   <button class="compact-button" aria-label="Reconnect the agent stream" onclick={reconnect}>Reconnect</button>
   {/if}
   {#if view?.usage.input}<small class="agent-status">{view.usage.input} in / {view.usage.output} out</small>{/if}
  </div>
 </div>
 {/if}
</section>
<style>
 /* The section scrolls in normal flow when the floor plus the chrome does not fit. Nothing is
    docked or overlaid, so the composer can never cover the conversation. */
 .agents{flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto;scroll-padding-bottom:calc(8px + var(--safe-bottom,0px))}
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
 .agent-transcript-wrap{flex:1 1 0;min-height:160px;display:flex;flex-direction:column;min-width:0}
 .agent-transcript{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px 20px}
 .agent-transcript-body{display:flex;flex-direction:column;gap:12px}
 .new-activity-row{flex:0 0 auto;display:flex;justify-content:center;padding:6px 12px;background:var(--bg);border-top:1px solid var(--line)}
 .sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
 .new-activity{min-height:44px;min-width:44px;border:1px solid color-mix(in srgb,var(--accent) 45%,var(--line));border-radius:999px;background:var(--raised);color:var(--ink);font:12px var(--mono);padding:10px 18px}
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
 /* The composer stays in normal flow. The bottom inset is added as padding, never as an overlay,
    so a phone's home indicator cannot cover the controls and the transcript is never covered. */
 .agent-composer{border-top:1px solid var(--line);background:var(--panel);padding:10px 12px calc(10px + var(--safe-bottom,0px))}
 .agent-composer textarea{min-height:80px;font:12px/1.6 var(--mono)}
 .agent-status{color:var(--muted)}
 .agent-status.connection{display:inline-flex;align-items:center;gap:5px}
 .connection-dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
 .connection-dot.live{background:#5fbf7f}.connection-dot.stale,.connection-dot.offline{background:#d6b879}.connection-dot.auth-required,.connection-dot.server-error{background:var(--danger)}
 .agent-upload-state{color:var(--accent)}
 .draft-notice{margin:0 0 6px;font-size:11px;line-height:1.6}
 .draft-saved{display:block;color:var(--muted);margin-top:2px}
 .draft-unsaved{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px}
 .draft-unsaved small{color:var(--danger);flex:1 1 240px}
 .draft-local-actions{display:flex;justify-content:flex-end;margin-top:2px}
 .image-capability{color:var(--danger);font-size:11px;margin:0 0 6px;line-height:1.6}
 .agent-question.dismissed{opacity:.7;border-left:2px solid var(--danger)}
 .slash-list{border:1px solid var(--line);border-radius:5px;background:var(--bg);padding:8px 10px;margin-bottom:8px;max-height:24dvh;overflow:auto;display:flex;flex-direction:column;gap:4px}
 .slash-row{display:flex;gap:8px;align-items:baseline;text-align:left;background:none;border:1px solid transparent;border-radius:4px;padding:5px 6px}
 .slash-row.highlighted{border-color:color-mix(in srgb,var(--accent) 30%,var(--line));background:var(--raised)}
 .slash-row code{font:9px var(--mono);color:var(--accent)}
 /*
  * Compact chrome. The transcript is the work; the panels around it give up height on a phone and
  * on any short screen so the conversation stays usable. updateChromeBudget chooses these from the
  * transcript's measured height, so the layout answers the real geometry, not a device guess.
  */
 .agents.compact :global(.session-bar){padding:4px 8px;gap:4px}
 .agents.compact :global(.session-bar .session-current .eyebrow){display:none}
 .agents.compact :global(.session-bar .session-actions){margin-left:0}
 .agents.compact .agents-head{padding:4px 8px;gap:6px}
 .agents.compact .model-picker{min-width:110px;flex:1 1 120px;font-size:9px}
 .agents.compact .agent-composer{padding:6px 8px calc(6px + var(--safe-bottom,0px))}
 .agents.compact .agent-composer .row .compact-button{min-height:36px}
 .agents.compact .agent-composer textarea{min-height:44px}
 .agents.compact .agent-composer .row{gap:6px}
 /* Secondary content is disclosed, never deleted: each summary is a native, focusable control. */
 .model-identity{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
 .head-more,.activity-more,.session-more,.draft-more{min-width:0}
 .head-more summary,.activity-more summary,.draft-more summary{cursor:pointer;color:var(--muted);font:10px var(--mono);letter-spacing:1px;text-transform:uppercase}
 .activity-more{margin:6px 12px 0;min-width:0}
 .draft-more{margin-top:2px}
 .draft-more summary{margin-bottom:4px}
</style>
