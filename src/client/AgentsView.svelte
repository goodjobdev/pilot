<script lang="ts">
 import DOMPurify from 'dompurify';
 import { marked } from 'marked';
 function renderMessage(text:string):string {
  return DOMPurify.sanitize(marked.parse(text,{gfm:true,async:false}) as string,{
   ALLOWED_TAGS:['p','br','strong','em','del','s','blockquote','pre','code','ul','ol','li','h1','h2','h3','h4','h5','h6','hr','a','table','thead','tbody','tr','th','td'],
   ALLOWED_ATTR:['href','title','start'],ALLOW_DATA_ATTR:false
  });
 }
 import {tick} from 'svelte';
 import { api,ApiError,download,reportSessionExpired } from './api';
 import { openAgentStream,type ConnectionStatus } from './stream';
 import { MESSAGE_DOCUMENT_THRESHOLD,MESSAGE_MAX_CHARS,THINKING_LEVELS,type AgentView,type ThinkingLevel } from '../shared/agent';
 import { transcriptRows as transcriptRowsOf } from '../shared/transcript';
 import { uniqueImageFiles,type ImageCapability,type ImageDraft } from '../shared/images';
 import ImageComposer from './ImageComposer.svelte';
 import TranscriptImage from './TranscriptImage.svelte';
 import { DraftStore,attemptFor,clearSaveFailure,draftSaveMessage,droppedFailureMessage,markSaveFailure,readSaveFailure,restoredImageItems,sessionKeyOf,storedAttachments,type StoredAttempt,type StoredDraft } from './drafts';
 type Capability={state:'known';provider:string;modelId:string;acceptsImages:boolean}|{state:'unknown';reason:string};
 type CachedDraft={text:string;media:ImageDraft[];attempt:StoredAttempt|null;savedAt:number|null;unsaved:boolean};
 import Icon from './Icon.svelte';
 import {request} from './api';
 import {modelKey,type ProviderSettings} from '../shared/settings';
 import type {ActionDescriptor} from '../shared/actions';
 import {slashMatches} from './slash';
 import {activityArrived,activityCountUnknown,arrivalAfterFrame,countLabel,followIdentity,indicatorLabel,initialFollow,isNearBottom,readerScrolled,readerStillFollowing,NEAR_BOTTOM_PX,type FollowState} from './follow';
 import {appendedTranscriptRows,retainedAgentView} from './transcript-window';
 import SessionBar from './SessionBar.svelte';
 import SessionActivity from './SessionActivity.svelte';
 let { projectId,sessionId='',onsessionchange=()=>{},sessionListOpen=false,onsessionlistchange=()=>{},onmissing=()=>{},onerror,onquestions,agentsVersion=0,focusQuestion='',onopenproviders=()=>{},chips=[],onopenchip=()=>{} }:{
   projectId:string; sessionId?:string; onsessionchange?:(id:string)=>void;
   sessionListOpen?:boolean; onsessionlistchange?:(open:boolean)=>void; onmissing?:()=>void;
   onerror:(message:string)=>void; onquestions?:()=>void; agentsVersion?:number;
   /** An exact question an attention deep link names; the view scrolls to it once it is rendered. */
   focusQuestion?:string;
   /** Open the providers screen from the model panel, for a model that is not configured yet. */
   onopenproviders?:()=>void;
   /** The documents and board revision of this project, shown as chips beside the session. */
   chips?:readonly {label:string;path:string}[];
   onopenchip?:(path:string)=>void;
 }=$props();
 let view=$state<AgentView|null>(null),enabled=$state(true),draft=$state(''),sending=$state(false),problem=$state('');
 /** The server's own limits, stated once here: the hard maximum for one message, and the smaller
  * size past which the interface offers to keep the text as a document instead. */
 const MESSAGE_LIMIT=MESSAGE_MAX_CHARS;
 const DOCUMENT_THRESHOLD=MESSAGE_DOCUMENT_THRESHOLD;
 // A deep link names one exact question. If the bounded projection omitted it, read the
 // authoritative session view and retain that identity within the same 500-question cap.
 let focusedQuestionRequest='',focusedQuestionGeneration=0;
 $effect(()=>{
   const id=focusQuestion,project=projectId,session=selectedSessionId,loaded=view;
   if(!id){focusedQuestionRequest='';return;}
   if(loaded?.questions.some(question=>question.id===id)){
     void tick().then(()=>{const element=document.getElementById('question-'+id);const disclosure=element?.closest('details');if(disclosure)disclosure.open=true;element?.scrollIntoView({block:'center'});});
     return;
   }
   const key=project+'\u0000'+session+'\u0000'+id;
   if(key===focusedQuestionRequest)return;
   focusedQuestionRequest=key;
   const generation=++focusedQuestionGeneration;
   void api.agents(project,session||undefined).then(snapshot=>{
     if(generation!==focusedQuestionGeneration||projectId!==project||selectedSessionId!==session||focusQuestion!==id||!snapshot.view)return;
     view=retainedAgentView(snapshot.view,id);thinking=snapshot.view.thinkingLevel??'';
   }).catch(()=>{});
 });
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
   draft='';media=[];attachments=[];attachmentProblem='';thinking='';sending=false;problem='';restoredNotice='';storageNotice='';draftSavedAt=null;latestUnsaved=false;markerAt=null;pendingAttempt=null;
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
 // Reader intent changes on every transcript scroll, including one during a pending send.
 // A send may follow only if that intent is unchanged when its admission response arrives.
 let readerIntentRevision=0;
 let seenEntryCount=0;
 let seenEntryIds:string[]=[];
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
 type TranscriptAnchor={id:string;offset:number};
 function captureTranscriptAnchor(nextIds:readonly string[]):TranscriptAnchor|null{
   const element=transcript;
   if(!element)return null;
   const allowed=new Set(nextIds),top=element.getBoundingClientRect().top;
   const rows=[...element.querySelectorAll<HTMLElement>('[data-entry-id]')];
   const visible=rows.find(row=>row.getBoundingClientRect().bottom>top&&allowed.has(row.dataset.entryId??''));
   return visible?{id:visible.dataset.entryId??'',offset:visible.getBoundingClientRect().top-top}:null;
 }
 function restoreTranscriptAnchor(anchor:TranscriptAnchor):void{
   const element=transcript;
   if(!element)return;
   const row=[...element.querySelectorAll<HTMLElement>('[data-entry-id]')].find(item=>item.dataset.entryId===anchor.id);
   if(!row)return;
   const offset=row.getBoundingClientRect().top-element.getBoundingClientRect().top;
   element.scrollTop+=offset-anchor.offset;
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
   const live=metricsOf(element);
   if(programmaticScroll&&Math.abs(live.scrollTop-(lastFollowScrollTop??live.scrollTop))<=1){programmaticScroll=false;return;}
   readerIntentRevision+=1;
   if(programmaticScroll)programmaticScroll=false;
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
 /** The session's thinking level, as the view reports it: '' means the host default is in force. */
 let thinking=$state(''),thinkingBusy=$state(false);
 /** The model and thinking panel: one place for the two choices that shape every request. */
 let modelOpen=$state(false),modelQuery=$state('');
 const thinkingChoices=[{value:'',label:'default'},...THINKING_LEVELS.filter(level=>['off','low','medium','high','max'].includes(level)).map(level=>({value:level,label:level}))];
 const filteredModels=$derived((modelSettings?.models??[]).filter(m=>m.configured&&(modelQuery.trim()===''||(m.name+' '+m.provider+' '+m.modelId).toLowerCase().includes(modelQuery.trim().toLowerCase()))).slice(0,40));
 const currentModelLabel=$derived.by(()=>{
   if(selectedModel==='')return 'Scripted test provider';
   const m=modelSettings?.models.find(candidate=>modelKey(candidate)===selectedModel);
   return m===undefined?selectedModel.split('/').slice(1).join('/'):m.provider+' / '+m.name;
 });
 /** Choose a model for this session: the server records it here and applies it at the next request. */
 async function pickModel(key:string){if(working||modelBusy)return;selectedModel=key;await chooseModel();}
 async function pickThinking(level:string){if(working||thinkingBusy)return;thinking=level;await chooseThinking();}
 /** Make the chosen model this instance's default for new sessions. */
 async function makeDefault(){
   if(!modelSettings||selectedModel==='')return;modelBusy=true;problem='';
   try{
     const m=modelSettings.models.find(candidate=>modelKey(candidate)===selectedModel);
     await request('/settings/models','POST',{...$state.snapshot(modelSettings.preferences),defaultModel:m?{provider:m.provider,modelId:m.modelId}:null});
     await loadModels();restoredNotice='Default for new sessions: '+(m?m.provider+' / '+m.name:'Scripted test provider')+'.';
   }catch(e){problem=(e as Error).message;}
   finally{modelBusy=false;}
 }
 /**
  * Dictation, where the browser offers it. Speech recognition is a browser capability, not a Pilot
  * one: the button appears only when the browser really implements it, and the transcript is appended
  * to the draft as it is heard. Nothing is sent to a provider by dictation itself.
  */
 type SpeechRecognitionLike={lang:string;continuous:boolean;interimResults:boolean;start:()=>void;stop:()=>void;
   onresult:((event:{resultIndex:number;results:{length:number;[index:number]:{isFinal:boolean;[index:number]:{transcript:string}}}})=>void)|null;
   onend:(()=>void)|null;onerror:(()=>void)|null};
 const speechSupported=typeof window!=='undefined'&&Boolean((window as unknown as {SpeechRecognition?:unknown;webkitSpeechRecognition?:unknown}).SpeechRecognition??(window as unknown as {webkitSpeechRecognition?:unknown}).webkitSpeechRecognition);
 let listening=$state(false),recognition=$state<SpeechRecognitionLike|null>(null);
 function dictate(){
   if(!speechSupported)return;
   if(listening){recognition?.stop();return;}
   const ctor=(window as unknown as {SpeechRecognition?:new()=>SpeechRecognitionLike;webkitSpeechRecognition?:new()=>SpeechRecognitionLike});
   const engine=new (ctor.SpeechRecognition??ctor.webkitSpeechRecognition!)();
   engine.lang=navigator.language||'en-US';engine.continuous=true;engine.interimResults=false;
   engine.onresult=(event)=>{let heard='';for(let i=event.resultIndex;i<event.results.length;i+=1)if(event.results[i].isFinal)heard+=event.results[i][0].transcript;if(heard)draft=(draft?draft+' ':'')+heard.trim();};
   engine.onend=()=>{listening=false;recognition=null;persistDraft(true);};
   engine.onerror=()=>{listening=false;recognition=null;};
   recognition=engine;listening=true;engine.start();
 }
 /** Files attached to the next message, already stored in the project's worktree. */
 let attachments=$state<{path:string;name:string;bytes:number}[]>([]),attachmentBusy=$state(false),attachmentProblem=$state('');
 async function chooseThinking(){
   if(thinkingBusy)return;thinkingBusy=true;problem='';
   try{
     const next=await request<AgentView>('/projects/'+projectId+'/agents/thinking','POST',{sessionId:selectedSessionId||undefined,thinkingLevel:(thinking===''?null:thinking) as ThinkingLevel|null});
     view=retainedAgentView(next);thinking=next.thinkingLevel??'';thinking=next.thinkingLevel??'';
   }catch(e){problem=(e as Error).message;}
   finally{thinkingBusy=false;}
 }
 /**
  * One attach control, split by what the bytes are: an image goes to the media store, so the model
  * receives it as an image, and anything else is written into the worktree, so the message names a
  * path the agent can read. The split is decided by the browser's own type for the file and the
  * server re-checks an image's bytes; a file the browser calls an image but the server refuses is
  * reported, not silently sent as something else.
  */
 async function attachAny(files:File[]){
   const images=files.filter(file=>file.type.startsWith('image/'));
   const others=files.filter(file=>!file.type.startsWith('image/'));
   if(images.length)composerApi?.add(images);
   if(others.length)await attachFiles(others);
 }
 /** Store one file in the worktree, so the message can name it. The bytes are the owner's own and
  * are never interpreted here: the agent reads the file through its ordinary contained read. */
 async function attachFiles(list:FileList|File[]){
   const files=[...list];if(!files.length)return;
   attachmentBusy=true;attachmentProblem='';
   try{
     for(const file of files){
       const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('The file could not be read in this browser.'));reader.onload=()=>{const result=String(reader.result??'');resolve(result.slice(result.indexOf(',')+1));};reader.readAsDataURL(file);});
       const stored=await api.uploadAttachment(projectId,{data,name:file.name});
       attachments=[...attachments,stored.attachment];
     }
   }catch(e){attachmentProblem=(e as Error).message;}
   finally{attachmentBusy=false;}
 }
 /** Keep the current text as a document in the worktree, and leave the message a pointer to it. */
 async function saveDraftAsDocument(){
   const text=draft;
   if(text.trim()===''||attachmentBusy)return;
   attachmentBusy=true;attachmentProblem='';
   try{
     const name='pasted-'+new Date().toISOString().replace(/[:.]/g,'-')+'.md';
     const data=btoa(String.fromCharCode(...new TextEncoder().encode(text)));
     const stored=await api.uploadAttachment(projectId,{data,name});
     attachments=[...attachments,stored.attachment];
     draft='';
     restoredNotice='Saved as '+stored.attachment.path+'. The message will name it.';
     persistDraft(true);
   }catch(e){attachmentProblem=(e as Error).message;}
   finally{attachmentBusy=false;}
 }
 const attachmentLine=$derived(attachments.length===0?'':'Attached files, saved into this project\u2019s repository worktree (read them from there): '+attachments.map(item=>item.path).join(', '));
 async function loadModels(){try{modelSettings=await request('/settings/providers');}catch(e){problem=(e as Error).message;}}
 async function chooseModel(){
  if(modelBusy)return;modelBusy=true;problem='';
  const m=modelSettings?.models.find(m=>modelKey(m)===selectedModel);
  try{
    // The response carries the capability of the model now in force, so the composer does not
    // keep an older reading after a model change.
    const next=await request<AgentView&{vision:ImageCapability|null}>('/projects/'+projectId+'/agents/model','POST',{sessionId:selectedSessionId||undefined,model:m?{provider:m.provider,modelId:m.modelId}:null});
    view=retainedAgentView(next);
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
       if(snapshot.view){view=retainedAgentView(snapshot.view);thinking=snapshot.view.thinkingLevel??'';}
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
         onView:async(next,meta)=>{
           if(!current())return;
           const retained=retainedAgentView(next,focusQuestion);
           const anchor=!follow.following?captureTranscriptAnchor(retained.entries.map(entry=>entry.id)):null;
           if(meta.initialSnapshot){
             // A fresh reconnect snapshot can shift its history window. Establish a new baseline;
             // it is not a live row arrival and must not fabricate an activity badge.
             seenEntryCount=retained.entries.length;
             seenEntryIds=retained.entries.map(entry=>entry.id);
           }
           view=retained;
           if(anchor){await tick();if(current())restoreTranscriptAnchor(anchor);}
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
   const currentIds=view?.entries.map(entry=>entry.id)??[];
   const count=currentIds.length;
   const element=transcript;
   if(key!==followKey){
       followKey=key;followGeneration+=1;
     follow=initialFollow();seenEntryCount=count;seenEntryIds=currentIds;lastFollowScrollTop=null;
     // A newly selected conversation opens at its newest entry. This is not a jump inside it.
     if(count>0&&element)scrollToBottom();
     return;
   }
   const previous=seenEntryCount;
   const previousIds=seenEntryIds;
   if(count===previous&&currentIds.every((id,index)=>id===previousIds[index]))return;
   seenEntryCount=count;
   seenEntryIds=currentIds;
   const appended=appendedTranscriptRows(previousIds,currentIds);
   const live=element?metricsOf(element):null;
   let next=live?arrivalAfterFrame(follow,previous,previous+appended.count,live,lastFollowScrollTop):activityArrived(follow,previous,previous+appended.count);
   if(!appended.exact)next=activityCountUnknown(next);
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
 let notified=$state<string|null>(null);
 $effect(()=>{
   const dismissed=(view as unknown as {dismissals?:Record<string,unknown>})?.dismissals??{};
   const open=(view?.questions??[]).filter(question=>!question.answer&&!(question.id in dismissed)).length;
   const omitted=view?.transcriptWindow?.questionsOmitted??0;
   const signature=open+':'+omitted;
   if(notified===signature)return;
   notified=signature;
   // An incomplete client projection always asks the parent to refresh its authoritative inbox;
   // this row count is not presented as the complete pending-question count.
   onquestions?.();
 });
 async function send(mode:'followUp'|'steer'){
   // A message that only carries files still needs text to send, so the paths become its text.
   const text=[draft.trim(),attachmentLine].filter(Boolean).join('\n\n'),images=readyImages;
   // A message needs text or an image; a refused, failed or missing image is never sent, and stays
   // visible until it is removed or recovered.
   if((text===''&&images.length===0&&attachments.length===0)||sending)return;
   if(attachmentBusy){problem='A file is still being stored. Wait for it to finish, then send — sending now would leave it out of the message.';return;}
   // An upload in flight or a reference being checked is not a stored image. Sending here would
   // send the text without it and then leave it behind, so the message is held with its own reason.
   // The Send and Steer buttons are disabled on this very condition, with the state named next to
   // them, so a person never reaches this branch without being told why.
   if(uploadingImages){problem='An image is still uploading. Wait for it to finish, then send — sending now would leave it out of the message.';return;}
   if(checkingImages){problem='A stored image is still being checked with the server. Wait for it to finish, then send.';return;}
   if(text.length>MESSAGE_LIMIT){problem='This message is '+text.length.toLocaleString()+' characters. The limit for one message is '+MESSAGE_LIMIT.toLocaleString()+', so it was not sent — nothing was lost, and your text is still in the box. Split it into shorter messages, or save long content into a file in the worktree (the agent can read it) and send the path.';return;}
   if(images.length>0&&capability.state==='known'&&capability.acceptsImages===false){problem='The model '+capability.provider+' / '+capability.modelId+' does not accept images, so this message is not sent with them. Remove the images or choose a model that accepts images.';return;}
   const generation=draftGeneration,identityAtSend=identityKey;
   const followIdentityAtSend=followKey,followGenerationAtSend=followGeneration;
   const readerIntentAtSend=readerIntentRevision;
   const sendScrollTop=transcript?.scrollTop??null;
   const sentText=text,sentAttachments=[...attachments],sentKeys=media.filter(item=>item.status==='ready'&&item.id).map(item=>item.key),sentImages=[...images];
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
     // The response belongs to the original transcript, and it may follow only if the reader has
     // not moved since send began. In particular, a deliberate scroll during the request wins.
     const element=transcript;
     const live=element?metricsOf(element):null;
     const measuredMovement=live!==null&&sendScrollTop!==null&&Number.isFinite(live.scrollTop)&&live.scrollTop<sendScrollTop-NEAR_BOTTOM_PX;
     if(followKey===followIdentityAtSend&&followGeneration===followGenerationAtSend&&readerIntentRevision===readerIntentAtSend&&!measuredMovement)showNewest();
     // Text typed while the send awaited is the person's work, not part of what was admitted.
     if(draft.trim()===sentText)draft='';
     else restoredNotice='The message was sent. The text you typed while it was sending was kept.';
     // Only the images that were submitted leave the strip. An image added while the send awaited
     // stays, and a failed, refused or missing one is never silently dropped.
     const sent=new Set(sentKeys);
     media=media.filter(item=>!sent.has(item.key));
     // The files that were named in the message leave the strip; one attached while the send awaited
     // stays, because it is not part of what was admitted.
     const sentPaths=new Set(sentAttachments.map(item=>item.path));
     attachments=attachments.filter(item=>!sentPaths.has(item.path));
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
 /** The transcript as readable rows, with runs of tool results folded. The rule itself is pure and
  * tested on its own in `src/shared/transcript.ts`. */
 const transcriptRows=$derived(transcriptRowsOf(view?.entries??[]));

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
 {#if chips.length}
 <div class="session-chips" role="group" aria-label="Project documents">
  {#each chips as chip (chip.path+chip.label)}
  <button class="compact-button session-chip" title={chip.path} onclick={()=>onopenchip(chip.path)}><Icon name="book" size={12}/><span>{chip.label}</span></button>
  {/each}
 </div>
 {/if}
 {#if view?.conversationId||selectedSessionId}<SessionBar {projectId} sessionId={selectedSessionId||view?.conversationId||''} {view} {agentsVersion} compact={chromeCompact} listOpen={sessionListOpen} onlistchange={onsessionlistchange} onerror={(message)=>onerror(message)} onsessionchange={(id)=>selectSession(id)}/>{/if}
 {#if sessionFallback}<p class="error agents-problem" role="alert">{sessionFallback}</p>{/if}
 {#if view?.transcriptWindow?.questionsOmitted}
  <p class="agent-gap" role="alert">{view.transcriptWindow.questionsOmitted} questions are outside this client's 500-question action window. The full durable question state is unchanged; do not treat this view as showing no other questions.</p>
 {/if}
 {#if enabled}
 <details class="activity-more">
  <summary>Activity <span class="agent-state" class:busy={working} role="status">{working?'Working…':'Idle'}</span></summary>
  <SessionActivity {projectId} sessionId={selectedSessionId} {view}/>
 </details>
 {/if}
 {#if !enabled}
 <div class="empty"><div class="empty-mark"><Icon name="agent" size={32}/></div><h2>Agents are off here.</h2><p>This instance does not enable the agent harness, so nothing can run. Set <code>DASHBOARD_AGENTS=on</code> to enable it.</p></div>
 {:else}
 {#if problem}<p class="error agents-problem" role="alert">{problem}</p>{/if}
 {#if view?.questions.some(question=>!question.answer&&!dismissals[question.id])}
 <section class="agent-questions" aria-label="Questions for me">
  <span class="popover-heading">QUESTIONS FOR ME</span>
  {#each view.questions as question (question.id)}
  {#if !question.answer&&!dismissals[question.id]}
  <article class="agent-question" id={'question-'+question.id}>
   <p>{question.text}</p>
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
  {#if view?.transcriptWindow?.omitted}
   <p class="agent-gap" role="note">Showing the newest {view.transcriptWindow.limit} transcript rows. {view.transcriptWindow.omitted} older rows are not shown in this client view. The durable transcript and its history are unchanged.</p>
  {/if}
  {#if view?.questions.some(question=>question.answer||dismissals[question.id])}
  <details class="question-history"><summary>Resolved questions</summary>
   {#each view.questions.filter(question=>question.answer||dismissals[question.id]) as question (question.id)}
   <article class="agent-question" id={'question-'+question.id}><p>{question.text}</p><p class="agent-answer">{#if question.answer}<span class="pill">answered</span>{question.answer.text}{:else}<span class="pill">dismissed</span>{dismissals[question.id].reason} — {dismissals[question.id].dismissedBy}{/if}</p></article>
   {/each}
  </details>
  {/if}
  {#if !view?.entries.length}<p class="agent-empty">No messages yet. Ask the agent to read this project’s documents and turn them into tasks, dependencies, and milestones. Its available tools depend on the permissions you grant.</p>{/if}
  {#each transcriptRows as row (row.kind==='tools'?row.id:row.entry.id)}
  {#if row.kind==='tools'}
  <details class="agent-tool-run">
   <summary>{row.entries.length} tool calls</summary>
   {#each row.entries as entry (entry.id)}
   <article class="agent-entry tool" data-entry-id={entry.id}>
    <span class="agent-role">Tool</span>{#if entry.at}<time class="agent-time" datetime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString()}</time>{/if}
    {#if entry.tools.length}<div class="agent-tools">{#each entry.tools as tool}<span class="pill">{tool.name}</span>{/each}</div>{/if}
    <details class="agent-tool-result"><summary>{entry.toolResult?.name??'Tool result'}{entry.toolResult?.isError?' · failed':''}</summary><pre class="agent-text">{entry.text}</pre></details>
   </article>
   {/each}
  </details>
  {:else}
  <article class="agent-entry {row.entry.kind}" data-entry-id={row.entry.id}>
   <span class="agent-role">{row.entry.kind==='user'?'You':row.entry.kind==='assistant'?'Agent':row.entry.kind==='tool'?'Tool':row.entry.kind}</span>{#if row.entry.at}<time class="agent-time" datetime={new Date(row.entry.at).toISOString()}>{new Date(row.entry.at).toLocaleTimeString()}</time>{/if}
   {#if row.entry.thinking}<details class="agent-thinking"><summary>Reasoning</summary><pre>{row.entry.thinking}</pre></details>{/if}
   {#if row.entry.tools.length}<div class="agent-tools">{#each row.entry.tools as tool}<span class="pill">{tool.name}</span>{/each}</div>{/if}
   {#if row.entry.kind==='assistant'}<div class="agent-text markdown">{@html renderMessage(row.entry.text)}</div>
   {:else if row.entry.kind==='tool'}<details class="agent-tool-result"><summary>{row.entry.toolResult?.name??'Tool result'}{row.entry.toolResult?.isError?' · failed':''}</summary><pre class="agent-text">{row.entry.text}</pre></details>
   {:else}<pre class="agent-text">{row.entry.text}</pre>{/if}
   {#each row.entry.images??[] as image, imageIndex (`${image.id}-${imageIndex}`)}<TranscriptImage id={image.id}/>{/each}
   {#if row.entry.stopReason&&row.entry.stopReason!=='stop'&&row.entry.stopReason!=='toolUse'}
   <small class="agent-note">{#if row.entry.stopReason==='length'}stopped: the model hit this instance’s output limit for one request. Raise “Most tokens one request may produce” in Harness settings, or lower the thinking level, which spends the same budget.{:else}stopped: {row.entry.stopReason}{/if}</small>
   {/if}
   {#if row.entry.error}<small class="agent-note error-inline">{row.entry.error}</small>{/if}
  </article>
  {/if}
  {/each}
  </div>
  </div>
  <!-- A live region that exists from the first frame, so both a count and a plain jump are announced
       when they appear. The control is outside it, because an interactive element inside a live
       region is re-announced by some screen readers. -->
  <span class="sr-only" role="status" aria-live="polite" data-follow-status>{follow.following?'':(follow.countUnknown?'New activity arrived; its count is unavailable':follow.missed>0?countLabel(follow.missed)+' while scrolled up':'Newer activity is below')}</span>
  {#if !follow.following}
  <div class="new-activity-row">
   <button class="new-activity" data-follow="indicator" aria-label={indicatorLabel(follow)+' and resume following'} onclick={()=>showNewest()}>{follow.countUnknown?'↓ New activity · count unavailable':follow.missed>0?'↓ '+countLabel(follow.missed):'↓ Jump to newest'}</button>
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
  <span class="sr-only" id="composer-help">Enter sends. Shift+Enter adds a newline. Type slash for commands.</span>
  <textarea aria-label="Message the agent" aria-describedby="composer-help" data-over-limit={draft.length>MESSAGE_LIMIT?'true':'false'} value={draft} onfocus={()=>composerElement?.scrollIntoView({block:'nearest'})} oninput={(event)=>{draft=(event.currentTarget as HTMLTextAreaElement).value;persistDraft();}} onkeydown={(event)=>composerKey(event)} placeholder="Message the agent…"></textarea>
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
  {/if}
  {#if draft.length>MESSAGE_LIMIT}
  <p class="message-limit" role="alert" data-message-limit="over">{draft.length.toLocaleString()} of {MESSAGE_LIMIT.toLocaleString()} characters. Send is refused until this is shorter; nothing has been lost. Save it as a document to send all of it.</p>
  {:else if draft.length>MESSAGE_LIMIT-2000}
  <p class="message-limit" role="status" data-message-limit="near">{draft.length.toLocaleString()} of {MESSAGE_LIMIT.toLocaleString()} characters.</p>
  {/if}
  {#if attachments.length||attachmentBusy||attachmentProblem||draft.length>DOCUMENT_THRESHOLD}
  <div class="attachment-strip" role="group" aria-label="Attachments">
   {#each attachments as item (item.path)}
   <span class="attachment-chip"><code title={item.path}>{item.name}</code><small>{Math.ceil(item.bytes/1024)} KB</small><button aria-label={'Remove attachment '+item.name} onclick={()=>attachments=attachments.filter(candidate=>candidate.path!==item.path)}>×</button></span>
   {/each}
   {#if attachmentBusy}<small role="status">Storing the file into the project worktree…</small>{/if}
   {#if draft.length>DOCUMENT_THRESHOLD}
   <span class="attachment-offer">
    <small role="status">{draft.length.toLocaleString()} characters is long for a message. Keep it as a document instead: it is written into the worktree and the message names the path, so an agent reads it from there.</small>
    <button class="compact-button" aria-label="Save the message text as a document in the worktree" disabled={attachmentBusy} onclick={()=>void saveDraftAsDocument()}>Save as document</button>
   </span>
   {/if}
  </div>
  {/if}
  {#if attachmentProblem}<p class="error" role="alert">{attachmentProblem}</p>{/if}
  {#if slashRefusal}<p class="error" role="alert">{slashRefusal}</p>{/if}
  {#if slashResult}<p class="agent-status" role="status">{slashResult}</p>{/if}
  <div class="composer-toolbar">
  <label class="attach-picker" title="Attach an image or any other file"><span class="sr-only">Attach a file</span><Icon name="attach" size={14}/>
   <input type="file" multiple aria-label="Attach a file or image" disabled={attachmentBusy||sending}
    onchange={(event)=>{const chosen=[...(event.currentTarget.files??[])];event.currentTarget.value='';void attachAny(chosen);}}>
   <span class="attach-label">{attachmentBusy?'Attaching…':'Attach'}</span>
  </label>
  {#if speechSupported}
  <button class="compact-button mic-button" class:listening aria-label={listening?'Stop dictating':'Dictate the message'} aria-pressed={listening} title="Dictate the message with this device’s speech recognition" onclick={dictate}><Icon name={listening?'close':'mic'} size={14}/></button>
  {/if}
  <ImageComposer projectId={projectId} sessionId={selectedSessionId||undefined} identity={identityKey} bind:items={media} dragging={composerDragging} handle={(composer)=>{composerApi=composer;}} onchange={()=>persistDraft(true)}/>
   <!-- One control for the two choices that always belong together: which model, and how hard it
        should think. The chip names both; the panel searches, lists and sets them. -->
   <div class="model-menu">
    <button class="model-chip" aria-label="Model and thinking" aria-expanded={modelOpen} aria-controls="model-panel" onclick={()=>{modelOpen=!modelOpen;if(modelOpen)void loadModels();}}>
     <span>{currentModelLabel}</span><small>· {thinking===''?'default thinking':thinking}</small>
    </button>
    {#if modelOpen}
    <div class="popover-panel model-panel" id="model-panel" role="group" aria-label="Model and thinking">
     <div class="panel-head"><span class="popover-heading">MODEL</span><button class="text-button" aria-label="Open Providers and models" onclick={()=>{modelOpen=false;onopenproviders();}}>Providers</button></div>
     <label class="model-search"><Icon name="search" size={14}/><input aria-label="Search models" placeholder="Search models…" bind:value={modelQuery}></label>
     <div class="model-list">
      <button class="model-row" class:current={selectedModel===''} disabled={working||modelBusy} onclick={()=>void pickModel('')}>
       <span class="model-name">Scripted test provider (free)</span><small>the free stand-in</small>{#if selectedModel===''}<span class="model-check" aria-hidden="true">✓</span>{/if}
      </button>
      {#each filteredModels as m (modelKey(m))}
      <button class="model-row" class:current={selectedModel===modelKey(m)} disabled={working||modelBusy} onclick={()=>void pickModel(modelKey(m))}>
       <span class="model-name">{m.name}</span><small>{m.provider}{modelSettings?.preferences.favourites.some(c=>modelKey(c)===modelKey(m))?' · ★':''}</small>{#if selectedModel===modelKey(m)}<span class="model-check" aria-hidden="true">✓</span>{/if}
      </button>
      {/each}
      {#if !filteredModels.length}<p class="muted">No configured model matches.</p>{/if}
     </div>
     <div class="panel-head"><span class="popover-heading">THINKING</span></div>
     <div class="thinking-row" role="group" aria-label="Thinking level">
      {#each thinkingChoices as choice}
      <button class="compact-button" aria-pressed={thinking===choice.value} disabled={thinkingBusy||working} onclick={()=>void pickThinking(choice.value)}>{choice.label}</button>
      {/each}
     </div>
     <div class="panel-foot"><button class="compact-button" aria-label="Make the selected model the default for new sessions" disabled={modelBusy||!selectedModel} onclick={()=>void makeDefault()}>Make default</button></div>
    </div>
    {/if}
   </div>
   {#if draftSavedAt||latestUnsaved}
   <!-- The draft footer is only in the way when there is something to say about the local draft. -->
   <details class="draft-more"><summary>Draft saved locally</summary>
    {#if draftSavedAt}<small class="draft-saved">Draft saved for {currentSessionLabel} at {new Date(draftSavedAt).toLocaleTimeString()} · kept in this browser only</small>{/if}
    <div class="draft-local-actions"><button class="compact-button" aria-label="Clear local drafts" onclick={clearLocalDrafts}>Clear local drafts</button></div>
   </details>
   {/if}
   <span class="toolbar-spacer"></span>
   <!-- Stop belongs with the other primary controls, so a short screen finds it beside Send and
        Steer instead of only in the header above the transcript. -->
   {#if working}<button class="compact-button" aria-label="Stop the agent" disabled={!working} onclick={()=>void stop()}><Icon name="close" size={14}/><span>Stop</span></button>{/if}
   <button class="primary compact-button" aria-label="Send message" disabled={sending||unsettledImages||imageCapabilityBlocked||attachmentBusy||(draft.trim()===''&&readyImages.length===0&&attachments.length===0)} title={sendHoldReason||undefined} onclick={()=>void send('followUp')}><Icon name="arrow" size={14}/><span>{working?'Queue follow-up':'Send'}</span></button>
   {#if working}<button class="compact-button" aria-label="Steer the run" disabled={sending||unsettledImages||imageCapabilityBlocked||!working||(draft.trim()===''&&readyImages.length===0)} title={sendHoldReason||undefined} onclick={()=>void send('steer')}>Steer</button>{/if}
  </div>
  <div class="composer-status">
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
 .agent-transcript-body{display:flex;flex-direction:column;gap:18px;width:100%;max-width:960px;margin:0 auto}
 .new-activity-row{flex:0 0 auto;display:flex;justify-content:center;padding:6px 12px;background:var(--bg);border-top:1px solid var(--line)}
 .sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
 .new-activity{min-height:44px;min-width:44px;border:1px solid color-mix(in srgb,var(--accent) 45%,var(--line));border-radius:999px;background:var(--raised);color:var(--ink);font:12px var(--mono);padding:10px 18px}
 .agent-empty{color:var(--muted);font-size:12px;line-height:1.7}
 .agent-gap{margin:0;padding:10px 12px;border:1px solid var(--border);border-radius:10px;color:var(--muted);font-size:12px;line-height:1.6;background:var(--surface)}
 .agent-entry{min-width:0;border:0;border-radius:12px;padding:10px 14px}
 .agent-entry.user{align-self:flex-end;max-width:90%;background:var(--raised);border:1px solid var(--line)}
 .agent-entry.assistant{background:transparent}
 .agent-entry.tool{border-left:2px solid var(--line);border-radius:0;color:var(--muted);padding:6px 12px}
 .agent-entry.system,.agent-entry.other{font-size:11px;color:var(--muted)}
 .agent-role{font:9px var(--mono);letter-spacing:1px;color:var(--muted);text-transform:uppercase}
 .agent-text{margin:7px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--mono)}
 .session-chips{display:flex;flex-wrap:wrap;gap:6px;padding:6px 12px 0;min-width:0}
 .session-chip{font:10px var(--mono);max-width:100%;overflow:hidden;text-overflow:ellipsis}
 .agent-time{margin-left:8px;font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}
 .agent-tool-run{margin:8px 0;border-left:2px solid var(--line);padding-left:8px}
 .agent-tool-run>summary{cursor:pointer;font-size:11px;color:var(--muted)}
 .agent-tool-run .agent-entry{margin:6px 0}
 .attachment-strip{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}
 .attachment-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:11px;max-width:100%}
 .attachment-chip code{font:10px var(--mono);overflow-wrap:anywhere}
 .attachment-chip small{color:var(--muted)}
 .attachment-chip button{border:0;background:transparent;font-size:13px;line-height:1;padding:0 2px}
 .attachment-offer{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
 .attachment-offer small{color:var(--muted);font-size:11px;max-width:44ch}
 .attach-picker{display:inline-flex;align-items:center}
 .model-menu{position:relative}
 .model-chip{display:inline-flex;align-items:baseline;gap:4px;font-size:11px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;background:transparent;max-width:44vw;overflow:hidden;text-overflow:ellipsis}
 .model-chip small{color:var(--muted)}
 .model-panel{width:min(340px,calc(100vw - 24px));right:auto;left:0}
 .model-panel .panel-head{display:flex;align-items:baseline;justify-content:space-between}
 .model-search{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:6px;padding:4px 8px;margin:0 0 8px}
 .model-search input{border:0;background:transparent;font-size:12px;width:100%}
 .model-list{max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:2px}
 .model-row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;text-align:left;border:0;background:transparent;padding:7px 8px;border-radius:6px;font-size:12px}
 .model-row:hover{background:var(--raised)}
 .model-row.current{background:var(--accent-soft)}
 .model-row .model-name{min-width:0;overflow-wrap:anywhere}
 .model-row small{color:var(--muted);font-size:10px}
 .model-check{grid-row:1 / span 2;align-self:center;color:var(--accent)}
 .thinking-row{display:flex;flex-wrap:wrap;gap:4px}
 .thinking-row button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent)}
 .panel-foot{margin-top:8px;border-top:1px solid var(--line);padding-top:8px}
 .mic-button.listening{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,var(--line))}
 .attach-picker{gap:4px;cursor:pointer;border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:11px}
 .attach-picker input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
 .attach-picker .attach-label{font-size:11px}
 .message-limit{margin:4px 0;font-size:11px}
 .message-limit[data-message-limit=over]{color:var(--danger)}
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
 .agents.compact .agent-composer{padding:6px 8px calc(6px + var(--safe-bottom,0px))}
 .agents.compact .composer-toolbar .compact-button{min-height:36px}
 .agents.compact .agent-composer textarea{min-height:44px}
 .agents.compact .agent-composer .row{gap:6px}
 /* Secondary content is disclosed, never deleted: each summary is a native, focusable control. */
 .model-identity{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
 .head-more,.activity-more,.session-more,.draft-more{min-width:0}
 .head-more summary,.activity-more summary,.draft-more summary{cursor:pointer;color:var(--muted);font:10px var(--mono);letter-spacing:1px;text-transform:uppercase}
 .activity-more{margin:6px 12px 0;min-width:0}
 .draft-more{margin-top:2px}
 .draft-more summary{margin-bottom:4px}
 .agent-composer{align-self:center;width:calc(100% - 24px);max-width:1000px;margin:8px 12px calc(8px + var(--safe-bottom,0px));padding:8px 12px;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:0 2px 8px #00000008}
 .agent-composer:focus-within{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
 .agents.compact .agent-composer{width:calc(100% - 16px);padding:8px;margin:6px 8px calc(6px + var(--safe-bottom,0px))}
 .agent-composer textarea,.agents.compact .agent-composer textarea{height:52px;min-height:48px;max-height:200px;width:100%;border:0;background:transparent;resize:vertical;font-family:inherit;font-size:14px;line-height:1.5;box-shadow:none}
 .composer-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
 .toolbar-spacer{flex:1;min-width:0}
 .composer-status{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;font-size:10px;padding-top:4px}
 .draft-more{max-width:100%;margin:0}
 .draft-more summary{margin:0;font:11px inherit;text-transform:none;letter-spacing:0;padding:6px}
 .draft-more[open]{flex-basis:100%;order:5;padding:4px 0}
 .agents.compact .draft-more:not([open]) summary{font-size:0;min-width:26px;text-align:center}
 .agents.compact .draft-more:not([open]) summary::after{content:'⋯';font:18px var(--mono)}
 .question-history{color:var(--muted);font-size:12px}
 .question-history summary{cursor:pointer}
 .agent-text.markdown{font-family:inherit;font-size:14px;line-height:1.65;white-space:normal}
 .agent-text.markdown :global(p){margin:0 0 .7em}
 .agent-text.markdown :global(pre){overflow:auto;white-space:pre;padding:10px;background:var(--bg);border-radius:6px}
 .agent-text.markdown :global(code){font-family:var(--mono)}
 .agent-text.markdown :global(table){display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:12px 0}
 .agent-text.markdown :global(th),.agent-text.markdown :global(td){border:1px solid var(--line);padding:6px 10px;text-align:left}
 .agent-text.markdown :global(h1),.agent-text.markdown :global(h2),.agent-text.markdown :global(h3){font-size:1.15em;margin:1em 0 .5em}
 .agent-tool-result summary{font-size:12px;cursor:pointer;color:var(--muted)}
 .activity-more{margin:4px 12px}
</style>
