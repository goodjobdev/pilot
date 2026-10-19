<script lang="ts">
 import { untrack } from 'svelte';
 import type { Board,Task,Operation,Relationship } from '../shared/model';
 import { newTask } from '../shared/model';
 import { readiness } from '../shared/graph';
 import { normalizeDocPath } from '../shared/docs';
 import { request,download } from './api';
 let {board,id,projectId,disabled,onclose,onoperation,ondirty}:{board:Board;id:string;projectId:string;disabled:boolean;onclose:()=>void;onoperation:(op:Operation)=>Promise<void>;ondirty:(dirty:boolean)=>void}=$props();
 let draft=$state<Task>(newTask(crypto.randomUUID())),dirty=$state(false),error=$state(''),sourceText=$state('');
 let other=$state(''),direction=$state('prerequisite'),kind=$state<'blocks'|'related'>('blocks');
 $effect(()=>{const task=board.tasks.find(t=>t.id===id);if(task){draft=structuredClone($state.snapshot(task));dirty=false;error='';sourceText='';untrack(()=>ondirty(false));}});
 function changed(){dirty=true;ondirty(true);}
 async function save(){try{await onoperation({op:'putTask',task:structuredClone($state.snapshot(draft))});dirty=false;ondirty(false);error='';}catch(e){error=(e as Error).message;}}
 async function edge(){if(!other)return;await onoperation({op:'putEdge',edge:{id:crypto.randomUUID(),source:direction==='prerequisite'?other:id,target:direction==='prerequisite'?id:other,kind}});}
 async function source(sourceId:string){try{const result=await request<{text:string}>('/projects/'+projectId+'/sources/'+sourceId);sourceText=result.text;}catch(e){error=(e as Error).message;}}
 function parseSpec(value:string):{path:string;anchor:string|null}|null{
   const [path,anchor]=value.trim().split('#');
   try{return {path:normalizeDocPath(path),anchor:anchor&&anchor.trim()!==''?anchor.trim():null};}
   catch(e){error=(e as Error).message;return null;}
 }
 function remove(){const incident=board.relationships.filter(e=>e.source===id||e.target===id);if(confirm('Remove this task and '+incident.length+' incident relationships? Use Archive to preserve history instead.'))void onoperation({op:'removeTask',id,confirmEdges:true});}
</script>
<aside class="inspector" aria-label="Task inspector">
 <header class="row"><span class="eyebrow">TASK DETAILS</span><button aria-label="Close inspector" onclick={onclose}>×</button></header>
 <div class="row"><span class="pill">{readiness(board,id)}</span>{#if dirty}<span class="pill">Unapplied edits</span>{/if}</div>
 <form onsubmit={(e)=>{e.preventDefault();void save();}} oninput={changed} onchange={changed}><fieldset disabled={disabled}>
 <label>Task title<input required maxlength="500" bind:value={draft.title}></label>
 <div class="two"><label>Status<select bind:value={draft.status}>{#each ['todo','doing','done','blocked'] as status}<option value={status}>{status}</option>{/each}</select></label><label>Scope<select bind:value={draft.scope}>{#each ['active','deferred','design-only','historical'] as scope}<option value={scope}>{scope}</option>{/each}</select></label></div>
 <label>Primary area<select bind:value={draft.domain}>{#each board.domains as d}<option value={d.id}>{d.name}</option>{/each}</select></label>
 <label>Milestone<select bind:value={draft.milestone}><option value={null}>Independent / unassigned</option>{#each board.milestones as m}<option value={m.id}>{m.name}</option>{/each}</select></label>
 <label>Secondary area tags<input value={draft.tags.join(', ')} oninput={(e)=>draft.tags=e.currentTarget.value.split(',').map(t=>t.trim()).filter(Boolean)} placeholder="ui, mobile, storage"></label>
 <label>Description <small>(markdown, displayed safely as text)</small><textarea bind:value={draft.description} maxlength="20000"></textarea></label>
 <label>Acceptance / evidence note<textarea bind:value={draft.acceptance} maxlength="20000"></textarea></label>
 <h3>Specification links</h3>
 <p class="muted">Point at the documentation this task implements, for example <code>docs/spec/checkout.md#acceptance</code>. Advisory: a task without a link is flagged, never blocked.</p>
 {#each draft.specs as spec,i}
 <div class="spec-row">
  <input aria-label={'Specification '+(i+1)} value={spec.path+(spec.anchor?'#'+spec.anchor:'')} placeholder="docs/spec/example.md#acceptance" onchange={(e)=>{const parsed=parseSpec(e.currentTarget.value);if(parsed){draft.specs=draft.specs.map((current,index)=>index===i?parsed:current);changed();}}}>
  <button type="button" onclick={()=>{draft.specs=draft.specs.filter((_,index)=>index!==i);changed();}}>Remove link</button>
 </div>
 {/each}
 <button type="button" onclick={()=>{draft.specs=[...draft.specs,{path:'docs/',anchor:null}];changed();}}>＋ Link a specification</button>
 <h3>External gates</h3>
 {#each draft.gates as gate,i}<div class="gate"><label>Gate label<input bind:value={gate.label}></label><label>Gate state<select bind:value={gate.state}><option value="open">Open — still blocks readiness</option><option value="satisfied">Satisfied</option></select></label><label>Gate evidence<input bind:value={gate.evidence}></label><button type="button" onclick={()=>{draft.gates=draft.gates.filter((_,at)=>at!==i);changed();}}>Remove gate</button></div>{/each}
 <button type="button" onclick={()=>{draft.gates=[...draft.gates,{id:crypto.randomUUID(),label:'External prerequisite',state:'open',evidence:''}];changed();}}>＋ Add gate</button>
 <label><input type="checkbox" bind:checked={draft.archived}>Archive task (retain history and relationships)</label>
 {#if error}<p class="error" role="alert">{error}</p>{/if}
 <div class="row"><button type="submit" class="primary" disabled={disabled||!dirty}>Save task</button><button type="button" onclick={()=>download('task-draft.json',JSON.stringify($state.snapshot(draft),null,2))}>Export draft</button></div>
 </fieldset></form>
 <section><h3>Relationships</h3><p class="muted">A → B means A must finish before B. Related links do not block.</p>
 {#each board.relationships.filter(e=>e.source===id||e.target===id) as relation}
 <div class="relationship"><span>{relation.kind==='related'?'Related':relation.target===id?'Blocked by':'Blocks'}: {board.tasks.find(t=>t.id===(relation.source===id?relation.target:relation.source))?.title}</span>
 <label>Reconnect source<select value={relation.source} disabled={disabled||dirty} onchange={(e)=>onoperation({op:'putEdge',edge:{...relation,source:e.currentTarget.value}})}>{#each board.tasks as t}<option value={t.id}>{t.title}</option>{/each}</select></label>
 <label>Reconnect target<select value={relation.target} disabled={disabled||dirty} onchange={(e)=>onoperation({op:'putEdge',edge:{...relation,target:e.currentTarget.value}})}>{#each board.tasks as t}<option value={t.id}>{t.title}</option>{/each}</select></label>
 <button disabled={disabled||dirty} onclick={()=>onoperation({op:'removeEdge',id:relation.id})}>Remove relationship</button></div>
 {/each}
 <label>Other task<select bind:value={other}><option value="">Choose task…</option>{#each board.tasks.filter(t=>t.id!==id) as t}<option value={t.id}>{t.title}</option>{/each}</select></label>
 <div class="two"><label>Direction<select bind:value={direction}><option value="prerequisite">Other blocks this</option><option value="downstream">This blocks other</option></select></label><label>Type<select bind:value={kind}><option value="blocks">Blocks</option><option value="related">Related</option></select></label></div>
 <button disabled={!other||disabled||dirty} onclick={edge}>Add relationship</button></section>
 <section><h3>Source snapshots</h3>{#each draft.sources as sourceId}{@const s=board.sources.find(s=>s.id===sourceId)}<button class="source-link" onclick={()=>source(sourceId)}>{s?.name??sourceId}<small>{s?.captured.slice(0,10)} · {s?.locator}</small></button>{/each}{#if !draft.sources.length}<p class="muted">Created in the dashboard.</p>{/if}{#if sourceText}<pre class="source-text">{sourceText}</pre>{/if}</section>
 <footer><button class="danger" disabled={disabled||dirty} onclick={remove}>Remove task…</button><small>{id}</small></footer>
</aside>
<style>fieldset{border:0;padding:0;margin:0;min-width:0}.inspector{width:355px;flex-shrink:0;border-left:1px solid var(--line);background:var(--panel);overflow:auto;padding:20px}.inspector header{justify-content:space-between;margin-bottom:15px}.inspector header button{border:0;font-size:23px;padding:0 8px}.inspector h3{font-size:12px;margin:24px 0 8px}.inspector p{font-size:11px;line-height:1.6}.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.gate,.relationship{background:var(--bg);border:1px solid var(--line);padding:12px;margin-bottom:10px;border-radius:8px}.relationship>span{font-size:11px;line-height:1.7}.relationship button,.gate button{font-size:10px}.spec-row{display:grid;grid-template-columns:1fr auto;gap:6px;margin-bottom:6px}.spec-row input{font-size:11px}.spec-row button{font-size:10px}.inspector footer{border-top:1px solid var(--line);margin-top:25px;padding-top:16px}.inspector footer small{display:block;margin-top:12px;color:var(--muted);font-size:9px}.danger{color:var(--danger)}.source-link{font-size:10px;text-align:left;width:100%;margin-bottom:6px;overflow-wrap:anywhere}.source-link small{display:block;margin-top:5px;color:var(--muted);font-size:9px}.source-text{white-space:pre-wrap;font-size:10px;line-height:1.7;overflow-wrap:anywhere;max-height:300px;overflow:auto}@media(max-width:1000px){.inspector{width:305px}}@media(max-width:750px){.inspector{position:absolute;inset:0 0 0 auto;z-index:20;width:min(355px,100%);box-shadow:var(--shadow)}}</style>
