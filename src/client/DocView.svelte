<script lang="ts">
 import DOMPurify from 'dompurify';
 import { marked } from 'marked';
 import { slug,type DocSnapshot } from '../shared/docs';
 import { assetBlobUrl,assetText } from './api';
 import Icon from './Icon.svelte';
 import { PLAN_PATH } from '../shared/workspace';
 import { parseBoard } from '../shared/markdown';
 let { doc, projectId, theme, focusAnchor=null, onedit, onopen }:{
   doc: DocSnapshot; projectId: string; theme: 'dark'|'light'; focusAnchor?: string|null;
   onedit:()=>void; onopen:(path:string)=>void;
 }=$props();
 const plan=$derived.by(()=>{if(doc.path!==PLAN_PATH)return null;try{return parseBoard(doc.text);}catch{return null;}});
 const planGroups=$derived(plan?[...[...plan.milestones].sort((a,b)=>a.order-b.order).map(m=>({name:m.name,tasks:plan!.tasks.slice(0,500).filter(task=>task.milestone===m.id)})),{name:'Independent',tasks:plan.tasks.slice(0,500).filter(task=>task.milestone===null)}]:[]);
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
   const raw=marked.parse(doc.path===PLAN_PATH?'':doc.text,{gfm:true,async:false}) as string;
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
 <div class="doc-body markdown" bind:this={container}>
 {#if plan}
 <p class="callout">Canonical project plan. Dependencies, Timeline and List read this exact document. Edit its source or use the board; saves update this file and create a local Git commit when available.</p>
 {#if plan.summary}<pre class="plan-prose">{plan.summary}</pre>{/if}
 {#if plan.tasks.length>500}<p class="callout">Showing the first 500 tasks. The YAML source contains all {plan.tasks.length} tasks.</p>{/if}
 {#each planGroups as group}<h2>{group.name}</h2>
 {#each group.tasks as task}
 <article class="plan-task"><h3>{task.title}</h3><p><strong>{task.status}</strong> · {plan.domains.find(domain=>domain.id===task.domain)?.name??task.domain} · {plan.milestones.find(milestone=>milestone.id===task.milestone)?.name??'Independent'}{task.archived?' · archived':''}</p>
 {#if task.description}<pre class="plan-prose">{task.description}</pre>{/if}{#if task.acceptance}<p>Acceptance: {task.acceptance}</p>{/if}
 {#each plan.relationships.filter(edge=>edge.target===task.id&&edge.kind==='blocks') as edge}<p>Blocked by: {plan.tasks.find(other=>other.id===edge.source)?.title??edge.source}</p>{/each}
 {#each task.specs as spec}<button class="text-button" onclick={()=>onopen(spec.path)}>{spec.path}{spec.anchor?'#'+spec.anchor:''}</button>{/each}
 </article>
 {/each}
 {/each}
 <details><summary>Canonical YAML source</summary><pre>{doc.text}</pre></details>
 {:else if doc.path===PLAN_PATH}<p class="error" role="alert">The plan source is invalid. Board updates are blocked. Edit this document to repair its YAML and task references.</p><pre>{doc.text}</pre>
 {:else}{@html html}{/if}
 </div>
</div>
<style>.plan-task{border-bottom:1px solid var(--line);padding:12px 0}.plan-task h3{margin:8px 0}.plan-task .text-button{display:block;overflow-wrap:anywhere}.markdown .plan-prose{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;background:transparent;padding:0}</style>
