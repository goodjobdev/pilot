<script lang="ts">
 import { onMount } from 'svelte';
 import { api,request } from './api';
 import type { Project } from '../shared/model';
 let { onclose,oncreated }:{onclose:()=>void;oncreated:(p:Project)=>void}=$props();
 let dialog:HTMLDialogElement;
 let name=$state(''),repository=$state(''),managed=$state(true),path=$state(''),error=$state(''),busy=$state(false);
 let preview=$state<{path:string;boardPath:string;detected:string[]}|null>(null);
 let folders=$state<{name:string;path:string}[]>([]),roots=$state<string[]>([]);
 let suggestions=$state<{name:string;path:string;remote:string}[]>([]);
 onMount(()=>{dialog.showModal();void request<string[]>('/roots').then(v=>roots=v);void request<typeof suggestions>('/suggestions').then(v=>suggestions=v).catch(()=>{});});
 async function browse(next:string){try{const v=await request<{path:string;entries:typeof folders}>('/browse?path='+encodeURIComponent(next));path=v.path;folders=v.entries;preview=null;}catch(e){error=(e as Error).message;}}
 async function inspect(){try{preview=await request('/preview','POST',{path});error='';}catch(e){error=(e as Error).message;}}
 async function submit(){
   busy=true;error='';try {const project=await api.register({name:name.trim(),managed,repository,path:managed?undefined:path,confirm:true});oncreated(project);}
   catch(e){error=(e as Error).message;}finally{busy=false;}
 }
</script>
<dialog bind:this={dialog} oncancel={onclose}>
 <header class="modal-head"><div><span class="eyebrow">NEW WORKSPACE</span><h2>Add a project</h2></div><button aria-label="Close dialog" onclick={onclose}>×</button></header>
 <p class="muted">One dashboard, all your projects. Code checkouts are optional.</p>
 <form onsubmit={(e)=>{e.preventDefault();void submit();}}>
 <label>Project name<input required maxlength="100" bind:value={name} placeholder="e.g. Runway"></label>
 {#if suggestions.length}<label>Start from workspace inventory<select onchange={(e)=>{const p=suggestions[Number(e.currentTarget.value)];if(p){name=p.name;repository=p.remote;}}}><option value="-1">Choose a suggestion…</option>{#each suggestions as p,i}<option value={i}>{p.name} · {p.path} (source path only)</option>{/each}</select></label>{/if}
 <label>Repository URL <small>(optional, never cloned automatically)</small><input bind:value={repository} placeholder="Descriptive link only"></label>
 <div class="segmented"><button type="button" class:active={managed} onclick={()=>managed=true}>Managed workspace</button><button type="button" class:active={!managed} onclick={()=>managed=false}>Existing server folder</button></div>
 {#if managed}<div class="callout">Creates a persistent planning folder on the dashboard server. No code, install, account or Git setup needed. Your board starts empty; import selected documents afterward.</div>
 {:else}
 <label>Folder on server<input bind:value={path} placeholder="/approved/root/project"></label>
 <div class="row">{#each roots as root}<button type="button" onclick={()=>browse(root)}>Browse {root}</button>{/each}<button type="button" onclick={inspect}>Preview folder</button></div>
 {#if folders.length}<div class="folder-list">{#each folders as f}<button type="button" onclick={()=>browse(f.path)}>▸ {f.name}</button>{/each}</div>{/if}
 {#if preview}<div class="callout"><strong>Planning file</strong><code>{preview.boardPath}</code><small>Detected: {preview.detected.join(', ')||'No common task documents'}. Original files will not be rewritten.</small></div>{/if}
 {/if}
 {#if error}<p role="alert" class="error">{error}</p>{/if}
 <footer class="row"><button type="button" onclick={onclose}>Cancel</button><button class="primary" type="submit" disabled={busy||!name.trim()||(!managed&&!preview)}>{busy?'Creating…':'Confirm & add project'}</button></footer>
 </form>
</dialog>
