<script lang="ts">
 import { onDestroy,onMount } from 'svelte';
 import { request } from './api';
 import type { RemoteReview,RemoteApplied } from '../shared/remote';
 let {projectId,available=false,pendingEdits=false,localHead='',onbusy,onupdated,onchecked=async()=>{}}:{projectId:string;available?:boolean;pendingEdits?:boolean;localHead?:string;onbusy:(busy:boolean)=>void;onupdated:()=>Promise<void>;onchecked?:()=>Promise<void>}=$props();
 let review=$state<RemoteReview|null>(null),busy=$state(false),loadingDiff=$state(false),approved=$state(false),error=$state(''),message=$state(''),path=$state(''),patch=$state<string|null>(null);
 let clock=$state(Date.now());
 onMount(()=>{const timer=setInterval(()=>clock=Date.now(),1000);return()=>clearInterval(timer);});
 const expired=$derived(review!==null&&clock>=Date.parse(review.expiresAt));
 const stale=$derived(review!==null&&localHead!==''&&review.head!==localHead);
 let comparison=$state<'incoming'|'result'>('incoming');
 const paths=$derived(review?(comparison==='result'?review.resultPaths:review.paths):[]);
 const total=$derived(review?(comparison==='result'?review.totalResultPaths:review.totalPaths):0);
 function compare(value:'incoming'|'result'){comparison=value;diffGeneration++;path='';patch=null;loadingDiff=false;}
 let generation=0,diffGeneration=0;
 onDestroy(()=>{generation++;diffGeneration++;onbusy(false);});
 async function check(){
  if(busy)return;const mine=++generation,id=projectId;diffGeneration++;busy=true;onbusy(true);review=null;approved=false;comparison='incoming';error='';message='';path='';patch=null;
  try{const result=await request<RemoteReview>('/projects/'+id+'/workspace/remote/check','POST',{});if(mine===generation){review=result;clock=Date.now();onbusy(false);await onchecked();}}
  catch(e){if(mine===generation)error=(e as Error).message;}
  finally{if(mine===generation){busy=false;onbusy(false);}}
 }
 async function incoming(value:string){
  if(!review)return;const token=review.token,id=projectId,mine=++diffGeneration;path=value;patch=null;loadingDiff=true;error='';
  try{const result=await request<{diff:string}>('/projects/'+id+'/workspace/remote/diff?token='+encodeURIComponent(token)+'&path='+encodeURIComponent(value)+'&comparison='+comparison);if(mine===diffGeneration)patch=result.diff;}
  catch(e){if(mine===diffGeneration)error=(e as Error).message;}
  finally{if(mine===diffGeneration)loadingDiff=false;}
 }
 async function apply(){
  if(!review||!approved||!review.canApply||pendingEdits||expired||stale||busy)return;
  const pinned=review,id=projectId;
  if(!confirm((pinned.mode==='merge'?'Create the reviewed two-parent merge':'Fast-forward the Pilot branch')+' to '+pinned.branch+' at '+pinned.target.slice(0,12)+'? This updates all reviewed repository paths, including those without a preview. No push, install, stash or reset.'))return;
  const mine=++generation;busy=true;onbusy(true);error='';message='';approved=false;diffGeneration++;
  try{const result=await request<RemoteApplied>('/projects/'+id+'/workspace/remote/apply','POST',{token:pinned.token,confirm:true});if(mine===generation){review=null;patch=null;path='';message=result.message+' HEAD '+result.head.slice(0,12);onbusy(false);await onupdated();}}
  catch(e){if(mine===generation){review=null;error=(e as Error).message;}}
  finally{if(mine===generation){busy=false;onbusy(false);}}
 }
</script>
<section class="remote-changes" aria-label="Remote changes" aria-busy={busy}>
 <h3>Remote changes</h3>
 <p>Refresh reads local files. Checking remote changes fetches the repository’s default branch without updating working files.</p>
 <button disabled={busy||!available} onclick={()=>void check()}>{busy?'Repository operation in progress…':'Check remote changes'}</button>
 {#if !available}<p>Connect a managed GitHub worktree in Repository & deploy key first.</p>{/if}
 {#if busy}<p role="status">Please wait. No automatic push, stash, reset or install.</p>{/if}
 {#if error}<p role="alert" class="error">{error}</p>{/if}
 {#if message}<p role="status">{message}</p>{/if}
 {#if review}
 <dl><dt>Remote default branch</dt><dd>{review.branch}</dd><dt>Checked</dt><dd>{new Date(review.checkedAt).toLocaleString()}</dd><dt>Review expires</dt><dd>{new Date(review.expiresAt).toLocaleTimeString()}</dd><dt>Local HEAD</dt><dd><code>{review.head.slice(0,12)}</code></dd><dt>Remote target</dt><dd><code>{review.target.slice(0,12)}</code></dd></dl>
 <p><strong>{review.mode} · {review.ahead} ahead · {review.behind} behind</strong></p>
 <p role="status">{review.message}</p>
 {#if review.commits.length}<h4>Incoming commits</h4><ul>{#each review.commits as entry}<li><code>{entry.hash.slice(0,8)}</code> {entry.subject}</li>{/each}</ul>{#if review.commitsTruncated}<p>Showing the first 20 incoming commits.</p>{/if}{/if}
 <div class="comparisons" aria-label="Remote comparison"><button aria-pressed={comparison==='incoming'} disabled={busy} onclick={()=>compare('incoming')}>Incoming changes</button><button aria-pressed={comparison==='result'} disabled={busy||!review.resultAvailable} onclick={()=>compare('result')}>Proposed result</button></div>
 <h4>{comparison==='result'?'Proposed result paths':'Incoming paths'} · {total}</h4>
 <p>{comparison==='result'?'Diffs compare your pinned local HEAD with the exact proposed result, including clean merge resolutions.':'Diffs show remote changes since the common ancestor, not your local documentation commits.'}</p>
 {#if total>paths.length}<p>{total-paths.length} paths are not previewable here. An update still includes them; review externally if needed.</p>{/if}
 <div class="incoming-paths">{#each paths as value}<button disabled={busy} onclick={()=>void incoming(value)}>{value}</button>{/each}</div>
 {#if path}<div class="incoming-patch"><strong>{path}</strong>{#if loadingDiff}<p role="status">Loading incoming diff…</p>{:else if patch!==null}<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard-scrollable patch.) --><pre tabindex="0" role="region" aria-label={comparison==='result'?'Proposed file diff':'Incoming file diff'}>{patch||'No textual changes.'}</pre>{/if}</div>{/if}
 {#if expired||stale}<p role="status">{expired?'This review expired.':'Local history changed since review.'} Check remote changes again before applying.</p>{/if}
 {#if pendingEdits}<p role="status">Save or close document/task edits before applying. Your drafts are retained.</p>{/if}
 {#if review.canApply}<label class="approval"><input type="checkbox" bind:checked={approved} disabled={busy||pendingEdits||expired||stale}> I reviewed the pinned update and all affected paths.</label><button disabled={busy||!approved||pendingEdits||expired||stale} onclick={()=>void apply()}>{review.mode==='merge'?'Approve reviewed merge':'Update workspace'}</button>{/if}
 {/if}
</section>
<style>
 .remote-changes{border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0 14px;min-width:0;font-size:12px;overflow-wrap:anywhere}
 .comparisons{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.comparisons button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent)}
 h3,h4{font-size:12px;margin:4px 0 8px}h4{margin-top:14px}p,li,dd,dt,label{font-size:11px;line-height:1.6}p{color:var(--muted)}button{font-size:11px;max-width:100%;white-space:normal}dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:5px;font-size:11px}dt{color:var(--muted)}dd{margin:0;min-width:0}ul{padding-left:16px}code{font:10px var(--mono)}.incoming-paths button{display:block;width:100%;text-align:left;font:11px var(--mono);margin:4px 0;overflow-wrap:anywhere}.approval{display:flex;align-items:flex-start;gap:8px;margin:14px 0}.approval input{flex-shrink:0;margin-top:3px;width:auto}.incoming-patch{min-width:0;max-width:100%;margin:12px 0}.incoming-patch strong{font:11px var(--mono)}pre{overflow:auto;max-height:320px;max-width:100%;white-space:pre;padding:8px;background:var(--bg);font:11px/1.6 var(--mono)}
</style>
