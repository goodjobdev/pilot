<script lang="ts">
 import { onDestroy } from 'svelte';
 import Icon from './Icon.svelte';
 import { api,ApiError,mediaBlobUrl } from './api';
 import { ACCEPTED_IMAGE_TYPES,MAX_IMAGE_BYTES,MAX_IMAGES_PER_MESSAGE,type ImageDraft } from '../shared/images';
 /**
  * The image half of the composer: paste, drag and drop, and a file picker with `capture` so a phone
  * offers its camera. Every selected image goes through the server's upload path, which decides what
  * the bytes are and refuses with its own reason; this component only shows that reason.
  *
  * `items` is bound to the parent, which clears it after a send. `handle` hands the parent the one
  * way to feed files in, so the parent owns the single paste and drop handler for the whole composer
  * area and one gesture is enqueued once. `dragging` is the parent's reading of that same gesture.
  */
 let { projectId,sessionId,identity='',items=$bindable([]),dragging=false,handle,onchange }:{ projectId:string; sessionId?:string; identity?:string; items?:ImageDraft[]; dragging?:boolean; handle?:(handle:{add:(files:File[])=>void})=>void; onchange?:()=>void }=$props();
 let previews=$state<Record<string,string>>({});
 let busy=$derived(items.some(item=>item.status==='uploading'));
 // The identity is the draft this strip belongs to (project and session). Every asynchronous
 // result is checked against the identity it started under, so a late upload or lookup can never
 // write one session's image into another.
 $effect(()=>{handle?.({add:(files)=>void addFiles(files)});});
 function notify():void{onchange?.();}
 // A preview whose image was removed (or that the parent cleared after a send) is revoked.
 $effect(()=>{
   const live=new Set(items.map(item=>item.key));
   const stale=Object.keys(previews).filter(key=>!live.has(key));
   if(stale.length===0)return;
   const next={...previews};
   for(const key of stale){URL.revokeObjectURL(next[key]);delete next[key];}
   previews=next;
 });
 onDestroy(()=>{for(const url of Object.values(previews))URL.revokeObjectURL(url);});
 function human(bytes:number):string{
   if(bytes<1024)return bytes+' B';
   if(bytes<1024*1024)return (bytes/1024).toFixed(0)+' KB';
   return (bytes/(1024*1024)).toFixed(1)+' MB';
 }
 function patch(key:string,change:Partial<ImageDraft>,persist=true):void{items=items.map(item=>item.key===key?{...item,...change}:item);if(persist)notify();}
 async function base64(file:File):Promise<string>{
   const bytes=new Uint8Array(await file.arrayBuffer());
   let binary='';
   // 8 KiB at a time: a single fromCharCode call with megabytes of arguments overflows the stack.
   for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));
   return btoa(binary);
 }
 async function addFiles(files:File[]):Promise<void>{
   if(files.length===0)return;
   const identityAtStart=identity,projectAtStart=projectId,sessionAtStart=sessionId;
   let room=Math.max(0,MAX_IMAGES_PER_MESSAGE-items.length);
   for(const file of files){
     // The owner switched session while an earlier file was uploading: nothing this gesture has
     // left to do belongs to the session now on screen.
     if(identity!==identityAtStart)return;
     const key=crypto.randomUUID();
     const draft:ImageDraft={key,name:file.name||'pasted image',declaredBytes:file.size,status:'uploading'};
     items=[...items,draft];
     notify();
     if(room<=0){patch(key,{status:'refused',reason:'Only '+MAX_IMAGES_PER_MESSAGE+' images fit in one message.'});continue;}
     room-=1;
     if(file.size>MAX_IMAGE_BYTES){patch(key,{status:'refused',reason:human(file.size)+' is over the '+human(MAX_IMAGE_BYTES)+' limit for one image.'});continue;}
     // The upload and the preview are two separate conditions. An upload the server refused is a
     // refusal, with the server's own reason, per image: never a generic failure, never a silent drop.
     const data=await base64(file);
     // The project and session are the ones this gesture started in, even if the page moved on
     // while the bytes were being read. The identity check above then drops the result, so a late
     // upload can never be attached to the session now on screen.
     if(identity!==identityAtStart)return;
     const sent=await api.uploadImage(projectAtStart,{sessionId:sessionAtStart,data,name:file.name,declaredType:file.type}).catch((error:unknown)=>{
       if(identity!==identityAtStart)return null;
       // A refusal is the server's decision about these bytes. A network or sign-in failure is an
       // upload that is not known to have happened, so it is `failed` and can be retried or removed.
       const failed=error instanceof ApiError&&error.kind!=='http';
       patch(key,{status:failed?'failed':'refused',reason:error instanceof ApiError?error.message:'The image could not be uploaded. Try again.'});
       return null;
     });
     if(sent===null||identity!==identityAtStart)continue;
     // The server accepted and stored these bytes, so the image is part of this message from here on,
     // whatever happens to its preview. A preview that cannot be fetched is reported as its own
     // condition and never as a refusal, and it never removes an image that was accepted.
     patch(key,{status:'ready',id:sent.media.id,mimeType:sent.media.mimeType,bytes:sent.media.bytes,width:sent.media.width,height:sent.media.height,note:sent.media.note??undefined});
     const url=await mediaBlobUrl(sent.media.id).catch(()=>null);
     if(identity!==identityAtStart)continue;
     if(url===null)patch(key,{previewError:'The preview could not be loaded. The image itself is stored and will be sent.'});
     else previews={...previews,[key]:url};
   }
 }
 /**
  * Look up every stored reference that was restored from a draft. This is read-only: it fetches the
  * media object the server already has and never uploads or sends one.
  *
  * Only a 404 means the server does not have the object. A network, sign-in, permission or server
  * failure says nothing about the object, so the reference stays `checking`, its media id stays in
  * the saved draft, and the lookup is retried only when the person asks. Turning a transport fault
  * into `missing` would discard a valid reference and could lose the image from the message.
  */
 let probeGeneration=0;
 type ProbeResult={url:string}|{missing:true}|{error:string};
 $effect(()=>{
   const generation=++probeGeneration;
   const identityAtStart=identity;
   // An item with a probe error waits for an explicit retry; otherwise every items change would
   // start another lookup and a failing server would be hammered.
   const pending=items.filter(item=>item.status==='checking'&&item.id&&!item.probeError);
   if(pending.length===0)return;
   void (async()=>{
     const found=new Map<string,ProbeResult>();
     for(const item of pending){
       if(generation!==probeGeneration||identity!==identityAtStart)return;
       let result:ProbeResult;
       try{
         result={url:await mediaBlobUrl(item.id as string)};
       }catch(error){
         const status=error instanceof ApiError?error.status:-1;
         result=status===404?{missing:true}:{error:status>0?'The server could not confirm this image (HTTP '+status+'). The reference is kept.':'The server could not be reached, so this image could not be checked. The reference is kept.'};
       }
       found.set(item.key,result);
     }
     if(generation!==probeGeneration||identity!==identityAtStart)return;
     if(found.size===0)return;
     const nextPreviews={...previews};
     items=items.map(item=>{
       const result=found.get(item.key);
       if(!result)return item;
       if('url' in result){
         nextPreviews[item.key]=result.url;
         return {...item,status:'ready',probeError:undefined};
       }
       if('missing' in result)return {...item,status:'missing',reason:'The server no longer has this image, so it cannot be sent. Remove it and add the image again.',probeError:undefined};
       return {...item,probeError:result.error};
     });
     previews=nextPreviews;
   })();
 });
 /** Retry one stored reference's lookup without re-uploading anything. */
 function retryLookup(key:string):void{
   patch(key,{probeError:undefined},false);
 }
 function remove(key:string):void{
   const next={...previews};const url=next[key];delete next[key];previews=next;
   if(url)URL.revokeObjectURL(url);
   items=items.filter(item=>item.key!==key);
   notify();
 }
</script>
<!-- This strip has no paste or drop handler of its own: the composer area around it owns the one
     handler for a gesture, so a drop or a paste that lands here is handled exactly once. -->
<div class="image-composer" class:dragging role="group" aria-label="Images for this message">
 <div class="image-actions">
  <label class="compact-button image-pick">
   <Icon name="image" size={14}/><span>Add image</span>
   <input type="file" accept={ACCEPTED_IMAGE_TYPES.join(',')} capture="environment" multiple aria-label="Add an image"
          onchange={(event)=>{const element=event.currentTarget as HTMLInputElement;const files=[...(element.files??[])];element.value='';void addFiles(files);}} />
  </label>
  <small class="image-hint">Paste, drop, or use the camera · JPEG, PNG or WebP · up to {human(MAX_IMAGE_BYTES)} each</small>
 </div>
 {#each items as item (item.key)}
  <div class="image-item" class:refused={item.status==='refused'} class:failed={item.status==='failed'} class:missing={item.status==='missing'} class:checking={item.status==='checking'}>
   {#if previews[item.key]}<img class="image-preview" alt={item.name} src={previews[item.key]} />{:else}<span class="image-blank" aria-hidden="true"><Icon name="image" size={14}/></span>{/if}
   <span class="image-facts">
    <span class="image-name">{item.name}</span>
    {#if item.status==='refused'||item.status==='failed'||item.status==='missing'}<small class="image-refusal" role="alert">{item.reason??'This image is not stored, so it cannot be sent.'}</small>
    {:else if item.status==='uploading'}<small>Checking…</small>
    {:else if item.status==='checking'}{#if item.probeError}<small class="image-refusal">{item.probeError}</small>{:else}<small>Checking the stored image…</small>{/if}
    {:else}<small>{human(item.bytes??item.declaredBytes)} · {item.width}×{item.height}{item.note?(' · '+item.note):''}</small>{/if}
    {#if item.previewError}<small class="image-preview-problem">{item.previewError}</small>{/if}
   </span>
   {#if item.probeError}<button type="button" class="compact-button" aria-label={'Retry lookup for '+item.name} onclick={()=>retryLookup(item.key)}>Retry lookup</button>{/if}
   <button type="button" class="compact-button" aria-label={'Remove image '+item.name} disabled={busy&&item.status==='uploading'} onclick={()=>remove(item.key)}><Icon name="close" size={12}/></button>
  </div>
 {/each}
</div>
<style>
 .image-composer{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
 .image-composer.dragging{outline:1px dashed var(--accent);outline-offset:2px;border-radius:5px}
 .image-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
 .image-pick{position:relative;cursor:pointer}
 .image-pick input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
 .image-hint{color:var(--muted)}
 .image-item{display:flex;align-items:center;gap:8px;padding:4px 6px;border:1px solid var(--line);border-radius:5px;background:var(--panel)}
 .image-item.refused,.image-item.failed,.image-item.missing{border-color:var(--danger)}
 .image-item.checking{border-style:dashed}
 .image-preview{max-width:96px;max-height:72px;border-radius:4px;object-fit:contain}
 .image-blank{display:inline-flex;width:24px;justify-content:center;color:var(--muted)}
 .image-facts{display:flex;flex-direction:column;min-width:0;flex:1}
 .image-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .image-facts small{color:var(--muted)}
 .image-refusal{color:var(--danger)}
 .image-preview-problem{color:var(--muted)}
</style>
