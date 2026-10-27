<script lang="ts">
 import { onMount } from 'svelte';
 import { mediaBlobUrl } from './api';
 let {id}:{id:string}=$props();
 let url=$state(''),failed=$state(false),reservedHeight=$state(0);
 let host:HTMLDivElement;

 // Rows are keyed by their immutable attachment identity. Fetch only while visible, and release
 // offscreen blobs without collapsing their measured space or retaining the whole image history.
 onMount(()=>{
  let active=true,visible=false,generation=0;
  let controller:AbortController|null=null;
  function release(){
   generation++;controller?.abort();controller=null;
   if(url){reservedHeight=host.getBoundingClientRect().height;URL.revokeObjectURL(url);url='';}
  }
  async function load(){
   const request=++generation;
   controller=new AbortController();failed=false;
   try{
    const next=await mediaBlobUrl(id,controller.signal);
    if(!active||!visible||request!==generation){URL.revokeObjectURL(next);return;}
    url=next;
   }catch{if(active&&visible&&request===generation)failed=true;}
  }
  function visibility(next:boolean){
   if(!active||next===visible)return;
   visible=next;
   if(next)void load();else release();
  }
  let observer:IntersectionObserver|null=null;
  if('IntersectionObserver' in window){
   observer=new IntersectionObserver(entries=>{for(const entry of entries)visibility(entry.isIntersecting);});
   observer.observe(host);
  }else visibility(true);
  return()=>{active=false;observer?.disconnect();release();};
 });
</script>
<div class="transcript-image" bind:this={host} style:min-height={!url&&reservedHeight?reservedHeight+'px':undefined}>
 {#if url}<img src={url} alt="User attachment" onerror={()=>{failed=true;URL.revokeObjectURL(url);url='';}}/>
 {:else}<span class="transcript-image-placeholder" role="status">{failed?'Image unavailable':'Image attachment'}</span>{/if}
</div>
<style>
 .transcript-image{display:flow-root}
 img{display:block;max-width:min(100%,420px);max-height:320px;object-fit:contain;border-radius:6px;margin:8px 0}
 .transcript-image-placeholder{display:block;color:var(--muted);font-size:11px;margin:8px 0}
</style>
