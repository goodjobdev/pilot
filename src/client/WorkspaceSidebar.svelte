<script lang="ts">
 import { untrack } from 'svelte';
 import { request,assetBlobUrl } from './api';
 import type { WorkspaceState,WorkspaceDocument,SaveCommit } from '../shared/workspace';
 import { commitMessage,isWorkspaceImagePath } from '../shared/workspace';
 import { isBrowsableDocPath } from '../shared/docs';
 import { PLAN_PATH } from '../shared/workspace';
 import Icon from './Icon.svelte';
 import RemoteChanges from './RemoteChanges.svelte';
 let {projectId,onclose,onopendoc,pendingEdits=false,onbusy=()=>{},onupdated=async()=>{}}:{projectId:string;onclose:()=>void;onopendoc:(path:string)=>void;pendingEdits?:boolean;onbusy?:(busy:boolean)=>void;onupdated?:()=>Promise<void>}=$props();
 let remoteBusy=$state(false);
 function remoteStatus(value:boolean){remoteBusy=value;onbusy(value);}
 async function remoteUpdated(){back();commit='';commitPaths=[];await load();await onupdated();}
 let workspace=$state<WorkspaceState|null>(null),tab=$state<'Files'|'Changes'>('Files'),query=$state(''),error=$state(''),busy=$state(false);
 let selected=$state(''),document=$state<WorkspaceDocument|null>(null),diff=$state<string|null>(null),commit=$state(''),commitPaths=$state<string[]>([]),message=$state('');
 let generation=0,selection=0,leasedImage='';
 let imageUrl=$state('');
 function dropImage(){if(leasedImage)URL.revokeObjectURL(leasedImage);leasedImage='';imageUrl='';}
 async function load(){if(remoteBusy)return;const mine=++generation,id=projectId;try{const fresh=await request<WorkspaceState>('/projects/'+id+'/workspace');if(mine===generation){workspace=fresh;error='';}}catch(e){if(mine===generation)error=(e as Error).message;}}
 $effect(()=>{void projectId;dropImage();workspace=null;selected='';document=null;diff=null;commit='';commitPaths=[];query='';selection++;generation++;untrack(()=>void load());const timer=setInterval(()=>void load(),8000);return()=>{clearInterval(timer);generation++;selection++;dropImage();};});
 async function open(path:string,changes=false){const mine=++selection,id=projectId;selected=path;document=null;diff=null;dropImage();error='';message='';busy=true;try{
  if(changes){const result=await request<{diff:string}>('/projects/'+id+'/workspace/diff?path='+encodeURIComponent(path)+(commit?'&commit='+encodeURIComponent(commit):''));if(mine===selection)diff=result.diff;}
  else if(isWorkspaceImagePath(path)){const url=await assetBlobUrl(id,path);if(mine!==selection){URL.revokeObjectURL(url);return;}leasedImage=url;imageUrl=url;}
  else{const result=await request<WorkspaceDocument>('/projects/'+id+'/workspace/file?path='+encodeURIComponent(path));if(mine===selection)document=result;}
 }catch(e){if(mine===selection)error=(e as Error).message;}finally{if(mine===selection)busy=false;}}
 async function history(hash:string){const mine=++selection,id=projectId;commit=hash;selected='';document=null;diff=null;commitPaths=[];error='';busy=true;try{const result=await request<{paths:string[]}>('/projects/'+id+'/workspace/commit-files?commit='+encodeURIComponent(hash));if(mine===selection)commitPaths=result.paths;}catch(e){if(mine===selection)error=(e as Error).message;}finally{if(mine===selection)busy=false;}}
 async function retry(){if(!document||!confirm('Commit the current saved version of '+document.path+' locally? This does not push or merge.'))return;const mine=selection,id=projectId,file=document;busy=true;try{const result=await request<{commit:SaveCommit}>('/projects/'+id+'/workspace/commit','POST',{path:file.path,revision:file.revision});if(mine===selection){message=commitMessage(result.commit)+(['failed','uncertain'].includes(result.commit.status)?': '+result.commit.message:'');await load();}}catch(e){if(mine===selection)error=(e as Error).message;}finally{if(mine===selection)busy=false;}}
 function back(){selection++;selected='';document=null;diff=null;dropImage();error='';message='';busy=false;}
 const files=$derived(workspace?.files.filter(file=>file.path.toLowerCase().includes(query.toLowerCase()))??[]);
 /**
  * The listing as a folder tree. A path is split into its folders and its name; folders sort before
  * files at every level, and the closed/open state is per folder path, so reopening the panel keeps
  * nothing hidden that a person had opened. Searching keeps the flat, matching list: a match inside
  * a closed folder would otherwise be invisible.
  */
 type TreeFile={readonly kind:'file';readonly path:string;readonly name:string;readonly bytes:number};
 type TreeFolder={readonly kind:'folder';readonly path:string;readonly name:string;readonly children:TreeRow[];readonly files:number;readonly bytes:number};
 type TreeRow=TreeFile|TreeFolder;
 const collapsed=$state<Record<string,boolean>>({});
 const tree=$derived.by(():TreeRow[]=>{
   const roots:TreeFolder={kind:'folder',path:'',name:'',children:[],files:0,bytes:0};
   const folders=new Map<string,TreeFolder>([['',roots]]);
   for(const file of workspace?.files??[]){
     const parts=file.path.split('/'),name=parts.pop() as string;
     let parent=roots,at='';
     for(const part of parts){
       at=at===''?part:at+'/'+part;
       let folder=folders.get(at);
       if(folder===undefined){folder={kind:'folder',path:at,name:part,children:[],files:0,bytes:0};folders.set(at,folder);parent.children.push(folder);}
       parent=folder;
     }
     parent.children.push({kind:'file',path:file.path,name,bytes:file.bytes});
   }
   const order=(rows:TreeRow[])=>[...rows].sort((left,right)=>left.kind===right.kind?left.name.localeCompare(right.name):left.kind==='folder'?-1:1);
   const total=(folder:TreeFolder):{files:number;bytes:number}=>{
     let count=0,size=0;
     for(const child of folder.children){
       if(child.kind==='file'){count+=1;size+=child.bytes;}
       else{const inner=total(child);count+=inner.files;size+=inner.bytes;}
     }
     (folder as {files:number;bytes:number}).files=count;
     (folder as {files:number;bytes:number}).bytes=size;
     return {files:count,bytes:size};
   };
   const walk=(folder:TreeFolder)=>{(folder as {children:TreeRow[]}).children=order(folder.children);for(const child of folder.children)if(child.kind==='folder')walk(child);};
   walk(roots);total(roots);
   return roots.children;
 });
 function toggle(path:string){collapsed[path]=!collapsed[path];}
 const size=(bytes:number)=>Math.ceil(bytes/1024)+' KB';
</script>
<aside class="workspace-sidebar" class:preview={selected!==''} aria-label="Project files and changes">
 <header><strong>Workspace</strong><button class="icon-button" aria-label="Close files and changes" onclick={onclose}><Icon name="close"/></button></header>
 <div class="tabs" role="tablist" aria-label="Workspace sidebar views">{#each ['Files','Changes'] as name}<button role="tab" aria-selected={tab===name} onclick={()=>{tab=name as 'Files'|'Changes';back();commit='';commitPaths=[];}}>{name}{#if name==='Changes'&&workspace?.changes.length}<small>{workspace.changes.length}</small>{/if}</button>{/each}<button class="icon-button" aria-label="Refresh files and changes" onclick={()=>void load()}><Icon name="refresh" size={14}/></button></div>
 {#if error}<p class="error" role="alert">{error}</p>{/if}
 {#if message}<p role="status" class="sidebar-message">{message}</p>{/if}
 {#if selected}
 <div class="preview-toolbar"><button aria-label="Back to files and changes" onclick={back}>← Back</button><strong>{selected}</strong></div>
 <div class="preview-actions">
 {#if diff!==null}<button disabled={busy} onclick={()=>void open(selected)}>Open current file</button>{:else if (document||imageUrl)&&workspace?.git}<button disabled={busy} onclick={()=>{commit='';void open(selected,true);}}>Show changes</button>{/if}
 {#if document&&(isBrowsableDocPath(selected)||selected===PLAN_PATH)}<button onclick={()=>onopendoc(selected)}>Edit in Doc</button>{#if workspace?.git}<button disabled={busy} onclick={()=>void retry()}>Commit saved file</button>{/if}{/if}
 </div>
 {#if busy}<p role="status">Loading…</p>{/if}
 <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable code preview must support keyboard scrolling.) -->
 <div class="preview-content" tabindex="0" role="region" aria-label={diff!==null?'File diff':'File contents'}>
 {#if imageUrl}<img class="file-image" src={imageUrl} alt={selected} onerror={()=>error='The image could not be rendered. The file has not been changed.'}>{:else if document}<pre>{document.text}</pre>{:else if diff!==null}{#if diff}<pre class="diff">{#each diff.split('\n') as line}<span class:added={line.startsWith('+')&&!line.startsWith('+++')} class:removed={line.startsWith('-')&&!line.startsWith('---')}>{line||' '}</span>{/each}</pre>{:else}<p>No changes for this file.</p>{/if}{/if}
 </div>
 {:else if tab==='Files'}
 <input class="file-search" aria-label="Find project files" placeholder="Find a file…" bind:value={query}>
 <div class="file-list">
  {#if query!==''}
  {#each files as file}<button title={file.path} onclick={()=>void open(file.path)}>{file.path}<small>{size(file.bytes)}</small></button>{/each}{#if workspace&&!files.length}<p>No matching previewable files.</p>{/if}
  {:else}
  {#snippet rows(list:TreeRow[],depth:number)}
   {#each list as row (row.kind==='folder'?row.path:row.path)}
   {#if row.kind==='folder'}
   <button class="file-folder" style="--depth:{depth}" aria-expanded={!collapsed[row.path]} title={row.path} onclick={()=>toggle(row.path)}>
    <span class="folder-mark" aria-hidden="true">{collapsed[row.path]?'▸':'▾'}</span><span class="folder-name">{row.name}</span><small>{row.files} · {size(row.bytes)}</small>
   </button>
   {#if !collapsed[row.path]}{@render rows(row.children,depth+1)}{/if}
   {:else}
   <button class="file-leaf" style="--depth:{depth}" title={row.path} onclick={()=>void open(row.path)}><span class="file-name">{row.name}</span><small>{size(row.bytes)}</small></button>
   {/if}
   {/each}
  {/snippet}
  {@render rows(tree,0)}
  {#if workspace&&!tree.length}<p>No previewable files.</p>{/if}
  {/if}
 </div>
 {:else}
 <div class="file-list">
 {#if commit}<div class="history-head"><button onclick={()=>{commit='';commitPaths=[];}}>← Working changes</button><code>{commit.slice(0,8)}</code></div>{#each commitPaths as path}<button onclick={()=>void open(path,true)}>{path}</button>{/each}{#if !busy&&!commitPaths.length}<p>No previewable files in this commit.</p>{/if}
 {:else}
 <RemoteChanges {projectId} available={workspace?.remoteAvailable??false} localHead={workspace?.commits[0]?.hash??''} onchecked={load} {pendingEdits} onbusy={remoteStatus} onupdated={remoteUpdated}/>
 <h3>Uncommitted changes</h3>{#each workspace?.changes??[] as change}<button onclick={()=>void open(change.path,true)}><code>{change.status}</code>{change.path}</button>{/each}{#if workspace?.git&&!workspace.changes.length}<p>No previewable changes.</p>{/if}
 <h3>Recent commits</h3>{#each workspace?.commits??[] as entry}<button class="commit-row" onclick={()=>void history(entry.hash)}><code>{entry.hash.slice(0,8)}</code><span>{entry.subject}</span></button>{/each}
 {/if}
 </div>
 {/if}
 <footer>{#if !workspace&&!error}Loading workspace…{:else if workspace}{workspace.branch??'No branch'} · {workspace.message}<p>Credentials, generated files and managed source snapshots are omitted.</p>{#if workspace.truncated}<p role="status">The file or change list reached its limit. This is not a complete listing.</p>{/if}{/if}</footer>
</aside>
<style>
 .file-image{display:block;max-width:100%;max-height:70dvh;object-fit:contain;margin:auto}
 .workspace-sidebar{width:330px;min-width:0;flex-shrink:0;display:flex;flex-direction:column;background:var(--panel);border-left:1px solid var(--line);overflow:hidden;z-index:25}
 .workspace-sidebar.preview{width:min(650px,60vw)}header,.tabs,.preview-toolbar,.preview-actions,.history-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line)}header{justify-content:space-between}header strong{font-size:12px}.tabs button{font-size:12px}.tabs button[aria-selected=true]{background:var(--accent-soft);color:var(--accent)}.tabs small{margin-left:6px}.tabs .icon-button{margin-left:auto}
 .file-search{margin:10px;width:calc(100% - 20px)}
 .file-list .file-folder,.file-list .file-leaf{display:flex;width:100%;gap:8px;align-items:baseline;text-align:left;overflow-wrap:anywhere;font:11px var(--mono);margin-bottom:2px;padding:7px 9px;padding-left:calc(9px + var(--depth,0) * 12px)}
 .file-list .file-folder{background:transparent;border:0;color:var(--muted)}.file-list .file-folder .folder-name{color:var(--ink);font-weight:600}
 .file-list .file-leaf .file-name{min-width:0}.file-list,.preview-content{overflow:auto;flex:1;min-height:0}.file-list{padding:6px 10px}.file-list>button{display:flex;width:100%;gap:8px;text-align:left;overflow-wrap:anywhere;font:11px var(--mono);margin-bottom:4px;padding:9px}.file-list small{color:var(--muted);margin-left:auto;white-space:nowrap}.file-list h3{font-size:11px;margin:14px 0 8px}.file-list p,.preview-content p{color:var(--muted);font-size:12px;padding:8px}.commit-row span{font-family:var(--sans);min-width:0}.preview-toolbar strong{font:11px var(--mono);overflow-wrap:anywhere;min-width:0}.preview-toolbar button{flex-shrink:0}.preview-actions{flex-wrap:wrap}.preview-actions button{font-size:11px}.preview-content pre{margin:0;padding:12px;font:12px/1.6 var(--mono);white-space:pre;tab-size:2;min-width:max-content}.diff span{display:block;min-width:100%}.diff .added{background:color-mix(in srgb,var(--accent) 12%,transparent)}.diff .removed{background:color-mix(in srgb,var(--danger) 12%,transparent)}footer{border-top:1px solid var(--line);padding:10px;font:10px/1.5 var(--mono);color:var(--muted)}.error,.sidebar-message{padding:8px 12px;font-size:12px;overflow-wrap:anywhere}
 @media(max-width:1100px){.workspace-sidebar,.workspace-sidebar.preview{position:absolute;right:0;top:0;bottom:0;width:min(650px,100%);box-shadow:var(--shadow)}}
</style>
