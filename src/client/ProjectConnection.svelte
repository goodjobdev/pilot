<script lang="ts">
 import {onMount} from 'svelte';
 import {request} from './api';
 import type {Project} from '../shared/model';
 import type {RepositoryConnection} from '../shared/settings';
 let {project,onclose,onconnected}:{project:Project;onclose:()=>void;onconnected:()=>void}=$props();
 let dialog:HTMLDialogElement,connection=$state<RepositoryConnection|null>(null),busy=$state(false),problem=$state(''),message=$state(''),confirmed=$state(false);
 const base=$derived('/projects/'+project.id+'/repository');
 const settingsUrl=$derived(/^https:\/\/github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/.test(project.repository)?project.repository.replace(/\.git$/,'')+'/settings/keys':/^git@github\.com:[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(project.repository)?'https://github.com/'+project.repository.slice(15).replace(/\.git$/,'')+'/settings/keys':null);
 onMount(()=>{dialog.showModal();void action(async()=>{connection=await request(base);});});
 async function action(work:()=>Promise<void>){busy=true;problem='';message='';try{await work();}catch(e){problem=(e as Error).message;}finally{busy=false;}}
 async function generate(){await action(async()=>{connection=await request(base+'/key','POST',{});});}
 async function copy(){try{await navigator.clipboard.writeText(connection?.publicKey??'');message='Public key copied.';}catch{message='Select and copy the public key below.';}}
 async function check(){await action(async()=>{const result=await request<{message:string}>(base+'/test','POST',{});message=result.message;});}
 async function connect(){await action(async()=>{connection=await request(base+'/connect','POST',{confirm:true});message='Worktree connected. Main was not edited; no install, commit or push was run.';onconnected();});}
 async function remove(){
  if(!confirm('Remove the private key from Pilot? Also revoke its public key in GitHub to complete revocation. Existing files are kept.'))return;
  await action(async()=>{connection=await request(base+'/key','DELETE',{});message='Key removed from Pilot. Revoke it in GitHub as well.';});
 }
</script>
<dialog bind:this={dialog} oncancel={e=>{if(busy)e.preventDefault();else onclose();}} class="project-connection">
 <header class="modal-head"><div><span class="eyebrow">PROJECT SETTINGS</span><h2>Repository &amp; deploy key</h2></div><button aria-label="Close project connection" onclick={onclose} disabled={busy}>×</button></header>
 <p><strong>{project.name}</strong><br><code>{project.repository||'No repository URL on this project. Add a new managed project with its GitHub URL.'}</code></p>
 <p class="muted">Pilot creates one Ed25519 key per project. The private key stays on the server, outside project files and ordinary backups. Only the public key is displayed.</p>
 {#if connection?.publicKey}
  <label>Project public deploy key<textarea readonly value={connection.publicKey} rows="3"></textarea></label>
  <small>{connection.fingerprint}</small>
  <div class="row"><button onclick={()=>void copy()}>Copy public key</button><button onclick={()=>void remove()} disabled={busy}>Remove key</button></div>
 {:else}<button onclick={()=>void generate()} disabled={busy||!project.repository}>Generate project deploy key</button>{/if}
 <ol>
  <li>{#if settingsUrl}<a href={settingsUrl} target="_blank" rel="noreferrer">Open GitHub deploy keys ↗</a>{:else}Open the repository's GitHub Settings → Deploy keys.{/if}</li>
  <li>Add the public key. Tick <strong>Allow write access</strong> only if you want this project to be push-capable.</li>
  <li>Check access, then explicitly connect the worktree. Pilot does not install dependencies, commit or push automatically.</li>
 </ol>
 <p class="callout">Write access lets a shell-capable agent use that key to push. It is scoped to this repository, not to a branch. Prefer repository rules or pull-request review for main. Removing the key in GitHub revokes access.</p>
 <div class="row"><button onclick={()=>void check()} disabled={busy||!connection?.publicKey}>Check repository access</button></div>
 {#if connection?.connected}
  <p role="status">Connected on <code>{connection.branch}</code>. Pilot edits the agent worktree; main stays untouched.</p>
 {:else}
  <label class="row"><input type="checkbox" bind:checked={confirmed} disabled={busy}>Connect a separate worktree on a review branch. Keep the existing planning folder as a safety copy.</label>
  <button class="primary" onclick={()=>void connect()} disabled={busy||!connection?.publicKey||!confirmed}>{busy?'Working…':'Connect repository worktree'}</button>
  <small>Stop the agent first. Conflicting files are never overwritten; an incomplete attempt is retained for operator review.</small>
 {/if}
 {#if problem}<p role="alert" class="error">{problem}</p>{/if}
 {#if message}<p role="status">{message}</p>{/if}
 <footer class="row"><button onclick={onclose} disabled={busy}>Done</button></footer>
</dialog>
<style>
 .project-connection{width:min(640px,calc(100vw - 24px));max-height:90dvh;overflow:auto}
 code,textarea{overflow-wrap:anywhere}small{display:block;color:var(--muted);margin:8px 0;line-height:1.6}
 li{margin:8px 0;line-height:1.6}a{color:var(--accent)}input[type=checkbox]{width:auto;flex-shrink:0}
</style>
