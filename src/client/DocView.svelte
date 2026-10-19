<script lang="ts">
 import DOMPurify from 'dompurify';
 import { marked } from 'marked';
 import { slug,type DocSnapshot } from '../shared/docs';
 import { assetBlobUrl,assetText } from './api';
 import Icon from './Icon.svelte';
 let { doc, projectId, theme, focusAnchor=null, onedit, onopen }:{
   doc: DocSnapshot; projectId: string; theme: 'dark'|'light'; focusAnchor?: string|null;
   onedit:()=>void; onopen:(path:string)=>void;
 }=$props();
 let html=$state(''),container=$state<HTMLDivElement>(),diagrams=$state(0),rendered=$state('');
 // Object URLs the DOM is currently using, the ones an in-flight render has created, and the
 // key of that render. URLs are revoked only once the newer render is in the DOM, so a live
 // image is never revoked out from under the browser.
 let liveUrls:string[]=[];
 let pendingUrls:string[]=[];
 let buildingKey='';
 function localTarget(source: string): string | null {
   const clean=source.split('#')[0].split('?')[0];
   if(clean===''||clean.startsWith('//')||/^[a-z][a-z0-9+.-]*:/i.test(clean))return null;
   const base=doc.path.includes('/')?doc.path.slice(0,doc.path.lastIndexOf('/')):'';
   const raw=clean.startsWith('/')?clean.slice(1):(base?base+'/'+clean:clean);
   const parts:string[]=[];
   for(const segment of raw.split('/')){
     if(segment===''||segment==='.')continue;
     if(segment==='..'){if(!parts.length)return null;parts.pop();continue;}
     parts.push(segment);
   }
   return parts.join('/');
 }
 /** Heading anchors so open questions and deep links can land on the right section. */
 function anchorHeadings(parsed:Document){
   const used=new Set<string>();
   for(const heading of Array.from(parsed.querySelectorAll('h1,h2,h3,h4,h5,h6'))){
     const base=slug(heading.textContent??'')||'section';
     let id=base,count=1;
     while(used.has(id)){count+=1;id=base+'-'+count;}
     used.add(id);
     heading.id=id;
   }
 }
 /**
  * Renders the document.
  *
  * Markdown is sanitised, diagrams are left for Mermaid, and local images and static
  * mockups are fetched with the session header here — an <img> or <iframe> request
  * cannot carry one, so referencing them by URL would only work behind a proxy that
  * injects identity. Images become blob URLs; mockups become srcdoc inside a sandbox.
  */
 async function build(key:string){
   pendingUrls=[];
   const raw=marked.parse(doc.text,{gfm:true,async:false}) as string;
   const clean=DOMPurify.sanitize(raw,{USE_PROFILES:{html:true},FORBID_TAGS:['style','form','iframe','object','embed','script','link','meta','base']});
   const parsed=new DOMParser().parseFromString(clean,'text/html');
   for(const image of Array.from(parsed.querySelectorAll('img'))){
     const source=image.getAttribute('src')??'';
     if(source.startsWith('data:')||/^https?:/i.test(source))continue;
     const target=localTarget(source);
     if(target===null){image.remove();continue;}
     image.removeAttribute('src');
     if(/\.html?$/i.test(target)){
       // A static mockup: fetched as text and shown inside a sandboxed frame.
       const frame=parsed.createElement('iframe');
       frame.className='doc-mockup';
       frame.setAttribute('data-mockup',target);
       frame.setAttribute('sandbox','');
       frame.setAttribute('title',image.getAttribute('alt')??'Static mockup');
       image.replaceWith(frame);
     } else image.setAttribute('data-asset',target);
   }
   for(const code of Array.from(parsed.querySelectorAll('code.language-mermaid'))){
     const holder=parsed.createElement('div');holder.className='mermaid';holder.textContent=code.textContent??'';
     (code.closest('pre')??code).replaceWith(holder);
   }
   for(const image of Array.from(parsed.querySelectorAll('img[data-asset]'))){
     const target=image.getAttribute('data-asset');
     if(!target)continue;
     try{const url=await assetBlobUrl(projectId,target);if(key!==buildingKey){URL.revokeObjectURL(url);return;}pendingUrls.push(url);image.setAttribute('src',url);}
     catch{image.setAttribute('data-missing','true');}
   }
   for(const frame of Array.from(parsed.querySelectorAll('iframe[data-mockup]'))){
     const target=frame.getAttribute('data-mockup');
     if(!target)continue;
     try{const markup=await assetText(projectId,target);if(key!==buildingKey)return;frame.setAttribute('srcdoc',markup);}
     catch{frame.setAttribute('data-missing','true');}
   }
   if(key!==buildingKey)return;
   anchorHeadings(parsed);
   diagrams=parsed.querySelectorAll('.mermaid').length;
   const stale=liveUrls;
   liveUrls=pendingUrls;
   pendingUrls=[];
   html=parsed.body.innerHTML;
   rendered=key;
   buildingKey='';
   for(const url of stale)URL.revokeObjectURL(url);
 }
 $effect(()=>{
   const key=doc.revision+'|'+theme;
   if(rendered===key||buildingKey===key)return;
   buildingKey=key;
   void build(key);
 });
 $effect(()=>{ if(!diagrams||!container||rendered==='')return; void draw(container); });
 $effect(()=>()=>{for(const url of [...liveUrls,...pendingUrls])URL.revokeObjectURL(url);});
 async function draw(node:HTMLDivElement){
   const mermaid=(await import('mermaid')).default;
   mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:theme==='dark'?'dark':'default'});
   try{await mermaid.run({nodes:Array.from(node.querySelectorAll('.mermaid')) as HTMLElement[]});}catch{/* a broken diagram must not break the page */}
 }
 function links(event:MouseEvent){
   const anchor=(event.target as Element|null)?.closest('a');
   if(!anchor)return;
   const href=anchor.getAttribute('href')??'';
   if(!/\.mdx?($|#)/i.test(href))return;
   const target=localTarget(href);
   if(!target)return;
   event.preventDefault();onopen(target);
 }
 // Documentation links stay inside the wiki; the listener is attached imperatively so the
 // rendered body needs no interaction semantics of its own.
 $effect(()=>{
   const node=container;
   if(!node)return;
   const handler=(event:MouseEvent)=>links(event);
   node.addEventListener('click',handler);
   return ()=>node.removeEventListener('click',handler);
 });
 // Arriving from the questions list lands on the heading that asked the question.
 $effect(()=>{
   const node=container,target=focusAnchor;
   if(!node||!target||rendered==='')return;
   (node.querySelector('#'+CSS.escape(target)) as HTMLElement|null)?.scrollIntoView({block:'start'});
 });
 const open=()=>doc.questions.filter(q=>!q.done);
</script>
<div class="doc-view">
 <header class="doc-head">
  <div class="doc-title"><span class="eyebrow">{doc.kind.toUpperCase()}</span><h2>{doc.path}</h2></div>
  <span class="kind-badge">{doc.headings.length} headings</span>
  <button class="primary compact-button" aria-label="Edit document" onclick={onedit}><Icon name="edit" size={14}/><span>Edit</span></button>
 </header>
 {#if open().length}
 <section class="doc-questions" aria-label="Open questions">
  <span class="popover-heading">OPEN QUESTIONS</span>
  {#each open() as question}
  <p><a href={'#'+question.anchor}>{question.text}</a></p>
  {/each}
 </section>
 {/if}
 <div class="doc-body markdown" bind:this={container}>{@html html}</div>
</div>
