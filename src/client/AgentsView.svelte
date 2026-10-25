<script lang="ts">
 import { api,ApiError,download,reportSessionExpired } from './api';
 import { openAgentStream,type ConnectionStatus } from './stream';
 import type { AgentView } from '../shared/agent';
 import { uniqueImageFiles,type ImageCapability,type ImageDraft } from '../shared/images';
 import ImageComposer from './ImageComposer.svelte';
 import { DraftStore,attemptFor,clearSaveFailure,draftSaveMessage,droppedFailureMessage,markSaveFailure,readSaveFailure,readSelectedSession,restoredImageItems,sessionKeyOf,storedAttachments,writeSelectedSession,type StoredAttempt,type StoredDraft } from './drafts';
 type Capability={state:'known';provider:string;modelId:string;acceptsImages:boolean}|{state:'unknown';reason:string};
 type CachedDraft={text:string;media:ImageDraft[];attempt:StoredAttempt|null;savedAt:number|null;unsaved:boolean};
 import Icon from './Icon.svelte';
 import {request} from './api';
 import {modelKey,type ProviderSettings} from '../shared/settings';
 import type {ActionDescriptor} from '../shared/actions';
 import {slashMatches} from './slash';
 import SessionBar from './SessionBar.svelte';
 let { projectId,onerror,onquestions,agentsVersion=0 }:{ projectId:string; onerror:(message:string)=>void; onquestions?:()=>void; agentsVersion?:number }=$props();
 let view=$state<AgentView|null>(null),enabled=$state(true),draft=$state(''),sending=$state(false),problem=$state('');
 // The stream's own state. `lastViewAt` is when a full snapshot was accepted, which is
 // different from transport freshness: an idle session stays `live` on keep-alives.
 let connection=$state<ConnectionStatus>({state:'connecting',detail:'Connecting…',attempt:0,lastFrameAt:null,lastViewAt:null});
 let reconnectNonce=$state(0),clock=$state(Date.now()),streamedSessionId='';
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
 let lastProject='';
 // Return to the session the owner was last reading. The selection is only a preference: it is
 // validated against the server's session list, and an unknown one falls back to the root
 // conversation instead of opening a session that no longer exists.
 $effect(()=>{
   const project=projectId;
   if(project===lastProject)return;
   lastProject=project;
   const stored=readSelectedSession(draftStorage,project);
   if(stored.status!=='selected')return;
   selectedSessionId=stored.sessionId;
   void api.sessions(project).then(list=>{
     if(project!==projectId||selectedSessionId!==stored.sessionId)return;
     if(!list.sessions.some(session=>session.id===stored.sessionId)){
       selectedSessionId='';
       writeSelectedSession(draftStorage,project,null);
     }
   }).catch(()=>{ /* the server still decides; the draft stays keyed by the selected id */ });
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
   window.addEventListener('pagehide',flush);
   document.addEventListener('visibilitychange',hidden);
   return()=>{window.removeEventListener('pagehide',flush);document.removeEventListener('visibilitychange',hidden);flushPendingSave();};
 }); function selectSession(id:string):void{
   selectedSessionId=id;
   writeSelectedSession(draftStorage,projectId,id||null);
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
 let streamGeneration=0;
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
   // A session switch starts from an empty view; a reconnect of the same session keeps
   // the last confirmed snapshot visible until its replacement arrives.
   if(sessionId!==streamedSessionId){streamedSessionId=sessionId;view=null;}
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
<section class="agents">
 {#if view?.conversationId||selectedSessionId}<SessionBar {projectId} sessionId={selectedSessionId||view?.conversationId||''} {view} {agentsVersion} onerror={(message)=>onerror(message)} onsessionchange={(id)=>selectSession(id)}/>{/if}
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
  <label>Message the agent<textarea aria-label="Message the agent" value={draft} oninput={(event)=>{draft=(event.currentTarget as HTMLTextAreaElement).value;persistDraft();}} onkeydown={(event)=>composerKey(event)} placeholder="Ask for something, type / for commands, or include [pause]. Enter sends; Shift+Enter adds a newline."></textarea></label>
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
  <div class="draft-local-actions"><button class="compact-button" aria-label="Clear local drafts" onclick={clearLocalDrafts}>Clear local drafts</button></div>
  {#if slashRefusal}<p class="error" role="alert">{slashRefusal}</p>{/if}
  {#if slashResult}<p class="agent-status" role="status">{slashResult}</p>{/if}
  <div class="row">
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
</style>
