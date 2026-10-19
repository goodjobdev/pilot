<script lang="ts">
 import type { DocEntry } from '../shared/docs';
 import { api } from './api';
 import Icon from './Icon.svelte';
 let { docs, selected, projectId, onselect, oncreate, onclose }:{
   docs: DocEntry[]; selected: string; projectId: string;
   onselect:(path:string)=>void; oncreate:(path:string)=>void; onclose?:()=>void;
 }=$props();
 let query=$state(''),matches=$state<{path:string;line:number;text:string}[]>([]),searching=$state(false),message=$state('');
 let collapsed=$state<Record<string,boolean>>({});
 let filtered=$derived(docs.filter(d=>query===''||matches.length>0||d.path.toLowerCase().includes(query.toLowerCase())||d.kind.includes(query.toLowerCase())));
 let groups=$derived.by(()=>{
   const map=new Map<string,DocEntry[]>();
   for(const doc of filtered){const folder=doc.path.includes('/')?doc.path.slice(0,doc.path.indexOf('/')):'(root)';map.set(folder,[...(map.get(folder)??[]),doc]);}
   return [...map.entries()].sort((a,b)=>a[0]==='(root)'?-1:b[0]==='(root)'?1:a[0].localeCompare(b[0]));
 });
 async function search(){
   if(query.trim().length<2){await Promise.resolve();matches=[];message=query.trim()===''?'':'Enter at least two characters to search contents';return;}
   searching=true;message='';
   try{matches=(await api.searchDocs(projectId,query)).matches;if(!matches.length)message='No matches in document contents';}
   catch(e){message=(e as Error).message;matches=[];}
   finally{searching=false;}
 }
 function clear(){matches=[];query='';message='';}
 function create(){
   const path=prompt('New document path','docs/'+'');
   if(!path)return;
   oncreate(path.trim());
 }
 function pick(path:string){matches=[];onselect(path);onclose?.();}
</script>
<div class="doc-browser">
 <div class="doc-controls">
  <label class="search"><Icon name="search" size={14}/><input aria-label="Search documents" placeholder="Find documents" bind:value={query} onkeydown={(e)=>{if(e.key==='Enter')void search();if(e.key==='Escape')clear();}}></label>
  <button class="compact-button" aria-label="New page" title="Create a Markdown page" onclick={create}><Icon name="plus" size={14}/></button>
  {#if onclose}<button class="compact-button wiki-tree-close" aria-label="Hide documents" onclick={onclose}><Icon name="close" size={14}/></button>{/if}
 </div>
 <div class="doc-actions"><button class="text-button" onclick={()=>void search()} disabled={searching}>{searching?'Searching…':'Search contents'}</button>{#if query}<button class="text-button" onclick={clear}>Clear</button>{/if}</div>
 {#if message}<small class="doc-message">{message}</small>{/if}
 {#if matches.length}
  <div class="doc-matches" aria-label="Content search results">
   <span class="popover-heading">{matches.length} MATCHES</span>
   {#each matches as match}
   <button onclick={()=>pick(match.path)}><span class="match-path">{match.path}:{match.line}</span><small>{match.text}</small></button>
   {/each}
  </div>
 {/if}
 <nav class="doc-tree" aria-label="Documents">
  {#each groups as [folder,list]}
  <div class="doc-group">
   <button class="doc-folder" aria-expanded={!collapsed[folder]} onclick={()=>collapsed={...collapsed,[folder]:!collapsed[folder]}}>
    <Icon name="chevron" size={12}/><span>{folder}</span><em>{list.length}</em>
   </button>
   {#if !collapsed[folder]}
   {#each list as doc}
   <button class="doc-item" class:current={doc.path===selected} aria-current={doc.path===selected?'true':undefined} onclick={()=>pick(doc.path)}>
    <span class="doc-name">{doc.path.slice(folder==='(root)'?0:folder.length+1)}</span><span class="kind-badge">{doc.kind}</span>
   </button>
   {/each}
   {/if}
  </div>
  {/each}
  {#if !docs.length}<p class="doc-empty">No Markdown documents in this project yet. Use ＋ to create one.</p>
  {:else if !filtered.length}<p class="doc-empty">No document names match “{query}”. Search contents instead.</p>{/if}
 </nav>
</div>
