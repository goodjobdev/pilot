<script lang="ts">
 import { onMount } from 'svelte';
 import { request } from './api';
 import type { Snapshot } from '../shared/model';
 import type { ImportPreview } from '../server/importer';
 import type { DocEntry } from '../shared/docs';
 import { PLAN_PATH } from '../shared/workspace';
 let {projectId,onclose,onapplied,repositoryMode=false}:{projectId:string;onclose:()=>void;onapplied:(s:Snapshot)=>void;repositoryMode?:boolean}=$props();
 let repoDocs=$state<DocEntry[]>([]),paths=$state<string[]>([]);
 let dialog:HTMLDialogElement;
 let docs=$state<{name:string;content:string}[]>([]),preview=$state<ImportPreview|null>(null),token=$state(''),selected=$state<string[]>([]),edges=$state<string[]>([]),error=$state(''),busy=$state(false);
 onMount(()=>{dialog.showModal();if(repositoryMode)void loadSources();});
 async function loadSources(){try{repoDocs=(await request<{documents:DocEntry[]}>('/projects/'+projectId+'/docs')).documents.filter(doc=>doc.path!==PLAN_PATH);paths=repoDocs.filter(doc=>/(?:plan|roadmap|tasks|milestone)/i.test(doc.path)).map(doc=>doc.path);}catch(e){error=(e as Error).message;}}
 async function files(event:Event){const list=(event.currentTarget as HTMLInputElement).files;if(!list)return;error='';try{
   const added=await Promise.all([...list].map(async f=>{if(f.size>2*1024*1024)throw Error('Document too large: '+f.name);return {name:f.name,content:await f.text()};}));
   docs=[...docs,...added];preview=null;
 }catch(e){error=(e as Error).message;}}
 async function inspect(){busy=true;try{const result=await request<{preview:ImportPreview;token:string}>('/projects/'+projectId+(repositoryMode?'/plan/preview':'/import/preview'),'POST',repositoryMode?{paths}:{documents:docs});preview=result.preview;token=result.token;selected=preview.candidates.filter(c=>c.change==='new').map(c=>c.id);edges=[];error='';}catch(e){error=(e as Error).message;}finally{busy=false;}}
 async function apply(){busy=true;try{const s=await request<Snapshot>('/projects/'+projectId+'/import/apply','POST',{token,selected,edgeIds:edges});onapplied(s);onclose();}catch(e){error=(e as Error).message;}finally{busy=false;}}
 function toggle(id:string){selected=selected.includes(id)?selected.filter(x=>x!==id):[...selected,id];}
</script>
<dialog class="import-dialog" bind:this={dialog} oncancel={onclose}>
 <header class="modal-head"><div><span class="eyebrow">REVIEW BEFORE WRITING</span><h2>{repositoryMode?'Sync plan':'Import planning documents'}</h2></div><button aria-label="Close import" onclick={onclose}>×</button></header>
 {#if repositoryMode}
 <p class="muted">Preview task checklists and explicit milestone dependencies from repository docs. Apply reviewed changes to the canonical plan document in one local commit. Source specs remain evidence, not a second task-status database. Prose-only specs need interpretation by your agent.</p>
 <fieldset class="source-picker"><legend>Source documents</legend>{#each repoDocs as doc}<label><input type="checkbox" checked={paths.includes(doc.path)} onchange={()=>{paths=paths.includes(doc.path)?paths.filter(path=>path!==doc.path):[...paths,doc.path];preview=null;}}>{doc.path}</label>{/each}{#if !repoDocs.length}<p>No source documents available.</p>{/if}</fieldset>
 {:else}
 <p class="muted">Selected source snapshots only. Nothing is executed, and original files are never edited.</p>
 <label>Markdown or legacy dashboard files<input type="file" multiple accept=".md,.mdx,.html" onchange={files}></label>
 {#each docs as doc,i}<div class="row"><label class="source-name">Source name / relative path<input bind:value={doc.name} onchange={()=>preview=null}></label><button onclick={()=>{docs=docs.filter((_,at)=>at!==i);preview=null;}}>Remove</button></div>{/each}
 {/if}
 <button disabled={!(repositoryMode?paths.length:docs.length)||busy} onclick={inspect}>{busy?'Working…':repositoryMode?'Preview sync':'Preview import'}</button>
 {#if error}<p role="alert" class="error">{error}</p>{/if}
 {#if preview}
 <h3 class="review-heading">{preview.candidates.length} candidates · {preview.milestones.length} milestones</h3>
 {#each preview.warnings as warning}<p class="callout">{warning}</p>{/each}
 <div class="row"><button onclick={()=>selected=preview!.candidates.filter(c=>c.change==='new').map(c=>c.id)}>Select new only</button><button onclick={()=>selected=[]}>Select none</button></div>
 <div class="candidates">{#each preview.candidates as candidate}
 <article><label><input type="checkbox" checked={selected.includes(candidate.id)} onchange={()=>toggle(candidate.id)}>{candidate.task.title}</label>
 <div class="row"><span class="pill">{candidate.change}</span><span class="pill">{candidate.task.status}</span><span class="pill">{candidate.task.domain}</span><span class="pill">{candidate.task.scope}</span></div>
 <p class="muted">{candidate.reason}</p>
 {#if candidate.change==='changed'}<p class="error">Current: {candidate.previous?.status} · {candidate.previous?.title}. Source status: {candidate.task.status}. Applying is an explicit overwrite of these imported fields.</p>{/if}
 <details><summary>Source and proposed description</summary><pre>{candidate.documentName}\n{candidate.source.locator}\n{candidate.task.description}</pre></details>
 </article>{/each}</div>
 {#if preview.relationships.length}<h3>Explicit dependency suggestions</h3><p class="muted">Only from source Depends fields. Review each arrow; not selected automatically.</p>{/if}
 {#each preview.relationships as e}<label><input type="checkbox" checked={edges.includes(e.id)} onchange={()=>edges=edges.includes(e.id)?edges.filter(x=>x!==e.id):[...edges,e.id]}>{preview.candidates.find(c=>c.task.id===e.source)?.task.title??e.source} → {preview.candidates.find(c=>c.task.id===e.target)?.task.title??e.target}</label>{/each}
 {#if preview.removed.length}<p class="callout">{preview.removed.length} source mappings are absent. No task will be removed automatically.</p>{/if}
 <footer class="row"><button onclick={onclose}>Cancel</button><button class="primary" disabled={busy||!selected.length} onclick={apply}>Apply {selected.length} reviewed tasks</button></footer>
 {/if}
</dialog>
<style>.source-picker{max-height:200px;overflow:auto;border:1px solid var(--line);padding:10px;margin:10px 0}.source-picker label{overflow-wrap:anywhere}.import-dialog{width:min(900px,94vw)}.source-name{flex:1;margin:8px 0}.review-heading{margin-top:24px}.candidates{max-height:45vh;overflow:auto;margin:15px 0}.candidates article{border-bottom:1px solid var(--line);padding:10px}.candidates label{color:var(--ink);line-height:1.6}.candidates p{font-size:11px;line-height:1.5;margin-top:8px}.candidates pre{white-space:pre-wrap;font-size:11px;color:var(--muted);overflow-wrap:anywhere}.candidates details{font-size:11px;color:var(--muted)}</style>
