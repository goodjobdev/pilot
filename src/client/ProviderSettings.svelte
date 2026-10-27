<script lang="ts">
 import {onMount} from 'svelte';
 import {request,ApiError} from './api';
 import {modelKey,type ProviderSettings,type ModelPreferences,type LoginView,type ModelChoice} from '../shared/settings';
 import type {WorkerModelPolicyView} from '../shared/model-policy';
 import {WORKER_MODEL_POLICY_READBACK_UNCERTAIN} from '../shared/model-policy-codes';
 let {onclose}:{onclose:()=>void}=$props();
 let dialog:HTMLDialogElement;
 let settings=$state<ProviderSettings|null>(null),provider=$state('openai'),key=$state(''),query=$state(''),busy=$state(false),message=$state(''),problem=$state('');
 let login=$state<LoginView|null>(null),answer=$state('');
 type RebaseDiff={serverOnly:string[];draftOnly:string[];serverDefault:string;draftDefault:string};
 let policyView=$state<WorkerModelPolicyView|null>(null),policyAllowed=$state<ModelChoice[]>([]),policyDefault=$state<ModelChoice|null>(null),policyRevision=$state(0),policyToAdd=$state(''),policyProblem=$state(''),policyMessage=$state(''),policyReloadOffered=$state(false),policyRebase=$state<WorkerModelPolicyView|null>(null);
 const policyRebaseDiff=$derived(policyRebase?describeRebase(policyRebase):null);
 const selected=$derived(settings?.providers.find(p=>p.id===provider));
 const filtered=$derived((settings?.models??[]).filter(m=>m.configured&&(!query||(m.name+' '+modelKey(m)).toLowerCase().includes(query.toLowerCase()))));
 onMount(()=>{
  dialog.showModal();void load();
  const timer=setInterval(()=>{if(login?.status==='pending')void poll(login.id);},1000);
  return ()=>{clearInterval(timer);key='';if(login?.status==='pending')void request('/settings/logins/'+login.id,'DELETE',{}).catch(()=>{});};
 });
 async function load(){try{settings=await request('/settings/providers');}catch(e){problem=(e as Error).message;return;}if(policyView===null)await loadPolicy();}
 async function loadPolicy(){policyProblem='';policyReloadOffered=false;policyRebase=null;try{applyPolicy(await request<WorkerModelPolicyView>('/settings/model-policy'));}catch(e){policyProblem=(e as Error).message;}}
 function applyPolicy(view:WorkerModelPolicyView){policyView=view;policyRevision=view.revision;policyAllowed=view.policy?[...view.policy.allowedWorkerModels]:[];policyDefault=view.policy?.defaultWorkerModel??null;policyToAdd='';policyReloadOffered=false;policyRebase=null;}
 async function action(work:()=>Promise<void>){if(busy)return;busy=true;problem='';message='';try{await work();}catch(e){problem=(e as Error).message;}finally{busy=false;}}
 async function saveKey(){await action(async()=>{await request('/settings/providers/'+provider+'/key','POST',{key});key='';message='Credential saved on the server. No model call was made.';await load();});}
 async function disconnect(){await action(async()=>{await request('/settings/providers/'+provider,'DELETE',{});key='';await load();message='Provider disconnected.';});}
 async function signin(){await action(async()=>{login=await request('/settings/providers/'+provider+'/login','POST',{});answer='';});}
 async function poll(id:string){
  try{const next=await request<LoginView>('/settings/logins/'+id);if(login?.id!==id)return;if(next.prompt?.id!==login.prompt?.id)answer='';login=next;if(next.status==='done')await load();}
  catch(e){problem=(e as Error).message;}
 }
 async function reply(){if(!login?.prompt)return;const id=login.id,promptId=login.prompt.id;await action(async()=>{await request('/settings/logins/'+id,'POST',{promptId,answer});answer='';await poll(id);});}
 async function cancelLogin(){if(!login)return;const id=login.id;await action(async()=>{await request('/settings/logins/'+id,'DELETE',{});await poll(id);});}
 async function preference(change:Partial<ModelPreferences>){
  if(!settings)return;
  const next={...$state.snapshot(settings.preferences),...change};
  await action(async()=>{await request('/settings/models','POST',next);await load();message='Model preferences saved.';});
 }
 async function favourite(index:number){
  if(!settings)return;const m=filtered[index],exists=settings.preferences.favourites.some(c=>modelKey(c)===modelKey(m));
  await preference({favourites:exists?settings.preferences.favourites.filter(c=>modelKey(c)!==modelKey(m)):[...settings.preferences.favourites,{provider:m.provider,modelId:m.modelId}]});
 }
 function addWorkerModel(){
  if(!policyView||!policyToAdd)return;
  const option=policyView.models.find(model=>modelKey(model)===policyToAdd);
  if(!option||!option.known||policyAllowed.some(model=>modelKey(model)===modelKey(option)))return;
  policyAllowed=[...policyAllowed,{provider:option.provider,modelId:option.modelId}];
  policyToAdd='';
 }
 function removeWorkerModel(key:string){policyAllowed=policyAllowed.filter(model=>modelKey(model)!==key);}
 function clearWorkerDefault(){policyDefault=null;}
 async function reloadPolicy(){await loadPolicy();policyMessage='';}
 function keepDraft(){policyReloadOffered=false;policyRebase=null;}
 function cancelRebase(){policyRebase=null;}
 function describeRebase(latest:WorkerModelPolicyView):RebaseDiff{const latestKeys=latest.policy?.allowedWorkerModels.map(modelKey)??[],draftKeys=policyAllowed.map(modelKey);return{serverOnly:latestKeys.filter(key=>!draftKeys.includes(key)),draftOnly:draftKeys.filter(key=>!latestKeys.includes(key)),serverDefault:latest.policy?.defaultWorkerModel?modelKey(latest.policy.defaultWorkerModel):'none',draftDefault:policyDefault?modelKey(policyDefault):'none'};}
 async function prepareRebase(){if(busy)return;busy=true;policyProblem='';policyMessage='';try{const latest=await request<WorkerModelPolicyView>('/settings/model-policy');policyRebase=latest;}catch(e){policyProblem='The latest revision could not be read. Your draft is preserved. '+(e as Error).message;}finally{busy=false;}}
 async function confirmRebase(){if(!policyRebase)return;policyRevision=policyRebase.revision;policyView=policyRebase;policyRebase=null;await savePolicy();}
 async function savePolicy(){
  if(busy)return;
  busy=true;policyProblem='';policyMessage='';policyReloadOffered=false;policyRebase=null;
  try{
   const next=await request<WorkerModelPolicyView>('/settings/model-policy','POST',{
    revision:policyRevision,
    policy:{allowedWorkerModels:$state.snapshot(policyAllowed),defaultWorkerModel:policyDefault?{...policyDefault}:null}
   });
   applyPolicy(next);
   policyMessage='Worker model policy saved. Owner-created workers use this allowed set and default. Existing workers keep their pinned model.';
  }catch(e){
   const detail=(e as Error).message;
   if(e instanceof ApiError&&e.status===409){
    policyProblem='Revision conflict. Your draft is preserved. '+detail;
    policyReloadOffered=true;
   }else if(e instanceof ApiError&&e.status===500){
    const ambiguous=e.code===WORKER_MODEL_POLICY_READBACK_UNCERTAIN;
    policyProblem=(ambiguous?'The write result is uncertain. Your draft is preserved. ':'The worker model policy could not be read or saved. Your draft is preserved. ')+detail;
    policyReloadOffered=ambiguous;
   }else{
    policyProblem=detail;
   }
  }finally{busy=false;}
 }
</script>
<dialog bind:this={dialog} oncancel={onclose} class="provider-settings">
 <header class="modal-head"><div><span class="eyebrow">PILOT SETTINGS</span><h2>Providers &amp; models</h2></div><button aria-label="Close provider settings" onclick={onclose}>×</button></header>
 <p class="muted">Credentials stay on this server, outside projects and ordinary backups. They are never returned to this form. Use provider-side spending limits.</p>
 <fieldset disabled={busy}>
  <legend>Connect a provider</legend>
  <label>Provider<select aria-label="Provider" bind:value={provider} onchange={()=>{key='';message='';}}>{#each settings?.providers??[] as p}<option value={p.id}>{p.name}{p.configured?' · connected':''}</option>{/each}</select></label>
  {#if selected?.configured}<p role="status">Connected via {selected.credentialType==='oauth'?'sign-in':'API key'}.</p>{/if}
  {#if selected?.apiKey}
   <form onsubmit={e=>{e.preventDefault();void saveKey();}}>
    <label>Provider API key<input type="password" autocomplete="new-password" bind:value={key} spellcheck="false" required></label>
    <button type="submit" disabled={!key.trim()||busy}>{selected.configured?'Replace API key':'Save API key'}</button>
   </form>
  {/if}
  <div class="row">
   {#if selected?.oauth}<button onclick={()=>void signin()} disabled={login?.status==='pending'}>Sign in with {provider==='openai-codex'?'Codex':'ChatGPT'}</button>{/if}
   {#if selected?.configured}<button onclick={()=>void disconnect()}>Disconnect provider</button>{/if}
  </div>
 </fieldset>
 {#if login}
  <section class="callout" aria-label="Provider sign-in">
   <strong>{login.message}</strong>
   {#if login.url}<a href={login.url} target="_blank" rel="noreferrer">Open provider sign-in ↗</a>{/if}
   {#if login.userCode}<code>{login.userCode}</code>{/if}
   {#if login.status==='pending'}
    {#if login.prompt}
     <form onsubmit={e=>{e.preventDefault();void reply();}}>
      <label>{login.prompt.message}
       {#if login.prompt.type==='select'}
        <select bind:value={answer}><option value="">Choose a login method…</option>{#each login.prompt.options??[] as option}<option value={option.id}>{option.label}</option>{/each}</select>
       {:else}<input type="password" autocomplete="off" bind:value={answer} placeholder={login.prompt.type==='manual_code'?'Paste the final callback URL here':''}>{/if}
      </label>
      <button type="submit" disabled={busy||!answer}>Continue sign-in</button>
     </form>
    {/if}
    <small>On a phone or remote host, prefer Codex's device-code method. For browser login, paste the final localhost callback URL back here; do not share it in chat.</small>
    <button onclick={()=>void cancelLogin()} disabled={busy}>Cancel sign-in</button>
   {/if}
  </section>
 {/if}
 {#if settings}
 <fieldset disabled={busy}>
  <legend>Model defaults</legend>
  <label class="row"><input type="checkbox" checked={settings.preferences.allowRealModels} onchange={e=>void preference({allowRealModels:e.currentTarget.checked})}>Allow real model calls (may incur charges or use subscription quota)</label>
  <small>Off by default. Saving a key, signing in, choosing a default or starring a model does not call a model. Calls are capped at 4,096 output tokens per request and eight model turns between user inputs, with automatic retries and compaction disabled. These are not a dollar spending cap.</small>
  <p>Default for <strong>new sessions</strong>: <strong>{settings.preferences.defaultModel?modelKey(settings.preferences.defaultModel):'Scripted test provider (free)'}</strong></p>
  <button onclick={()=>void preference({defaultModel:null})}>Use scripted default</button>
  <label>Search models<input type="search" bind:value={query} placeholder="Connected providers · favourites first"></label>
  <div class="model-list" aria-label="Models">
   {#each filtered.slice(0,150) as m,index (modelKey(m))}
    <div class="model-row">
     <button aria-label={(settings.preferences.favourites.some(c=>modelKey(c)===modelKey(m))?'Unfavourite ':'Favourite ')+modelKey(m)} aria-pressed={settings.preferences.favourites.some(c=>modelKey(c)===modelKey(m))} onclick={()=>void favourite(index)}>{settings.preferences.favourites.some(c=>modelKey(c)===modelKey(m))?'★':'☆'}</button>
     <span><strong>{m.name}</strong><small>{modelKey(m)}</small></span>
     <button aria-label={'Set default '+modelKey(m)} onclick={()=>void preference({defaultModel:{provider:m.provider,modelId:m.modelId}})} disabled={settings.preferences.defaultModel&&modelKey(settings.preferences.defaultModel)===modelKey(m)}>Set default</button>
    </div>
   {/each}
   {#if !filtered.length}<p class="muted">Connect a provider to see its models.</p>{/if}
   {#if filtered.length>150}<small>Showing 150 of {filtered.length}. Search to narrow the list.</small>{/if}
  </div>
 </fieldset>
 {/if}
 {#if settings}
 <fieldset disabled={busy} class="worker-policy">
  <legend>Worker model policy</legend>
  <p class="muted">The <strong>default for new sessions</strong> above is the model a new session starts with. An existing session or a bound agent may use a different model. Owner-created workers use the allowed set and default below. Existing workers keep their pinned model. This view does not measure worker cost or perform a provider health probe.</p>
  <p>New-session default: <strong>{settings.preferences.defaultModel?modelKey(settings.preferences.defaultModel):'Scripted test provider (built-in default)'}</strong></p>
  <p class="muted">A model marked available means only that a provider credential is saved, or that it is the built-in scripted provider. It is not a health check, and this page makes no provider probe.</p>
  {#if policyView}
   <h3>Allowed worker models</h3>
   {#if policyAllowed.length===0}<p class="muted">No worker model is allowed yet. An empty set is valid and is not replaced with a default.</p>{/if}
   <ul class="worker-list" aria-label="Allowed worker models">
    {#each policyAllowed as model (modelKey(model))}
     {@const option=policyView.models.find(candidate=>modelKey(candidate)===modelKey(model))}
     <li data-model-key={modelKey(model)}>
      <span><strong>{option?.name??model.modelId}</strong><small>{modelKey(model)}{#if option?.credentialNote} · {option.credentialNote}{/if}</small></span>
      <button aria-label={'Remove worker model '+modelKey(model)} onclick={()=>removeWorkerModel(modelKey(model))}>Remove</button>
     </li>
    {/each}
   </ul>
   <div class="row">
    <label>Add a catalog model<select aria-label="Worker model to add" bind:value={policyToAdd}>
     <option value="">Choose a model…</option>
     {#each policyView.models.filter(model=>model.known&&!policyAllowed.some(allowed=>modelKey(allowed)===modelKey(model))) as model (modelKey(model))}
      <option value={modelKey(model)}>{model.name} · {modelKey(model)}{model.available?'':' · unavailable'}</option>
     {/each}
    </select></label>
    <button aria-label="Add worker model" onclick={addWorkerModel} disabled={!policyToAdd}>Add</button>
   </div>
   <p class="muted">A model from a disconnected provider can be saved and inspected. It is marked unavailable. It is never replaced with another model.</p>
   <h3>Default worker model</h3>
   <div class="row">
    <label>Default for future workers<select aria-label="Default worker model" value={policyDefault?modelKey(policyDefault):''} onchange={e=>{const key=e.currentTarget.value;policyDefault=key?policyAllowed.find(model=>modelKey(model)===key)??null:null;}}>
     <option value="">No worker default</option>
     {#each policyAllowed as model (modelKey(model))}<option value={modelKey(model)}>{modelKey(model)}</option>{/each}
    </select></label>
    <button aria-label="Clear worker default" onclick={clearWorkerDefault} disabled={!policyDefault}>Clear worker default</button>
   </div>
   {#if policyDefault&&!policyAllowed.some(model=>modelKey(model)===modelKey(policyDefault!))}<p class="error" role="alert">The default {modelKey(policyDefault!)} is not in the allowed worker set. Clear it explicitly or add it back. Saving will refuse rather than choose another model.</p>{/if}
   <div class="row"><button aria-label="Save worker model policy" onclick={()=>void savePolicy()} disabled={busy}>Save worker policy</button></div>
   {#if policyReloadOffered}
    <div class="row">
     <button aria-label="Reload current policy and discard my draft" onclick={()=>void reloadPolicy()}>Reload current policy (discard draft)</button>
     <button aria-label="Review latest revision" onclick={()=>void prepareRebase()} disabled={busy}>Review latest revision</button>
     <button aria-label="Keep my draft" onclick={keepDraft}>Keep my draft</button>
    </div>
   {/if}
   {#if policyRebase&&policyRebaseDiff}
    <div class="callout" role="group" aria-label="Latest revision review">
     <strong>Latest server revision: {policyRebase.revision}. Your draft is based on revision {policyRevision}.</strong>
     <small>Your draft is preserved until you choose. <strong>Use latest revision and save my choices</strong> replaces the newer server choices with your draft. This is a deliberate overwrite of the newer choices.</small>
     {#if policyRebaseDiff.serverOnly.length}<small>Server choices not in your draft: {policyRebaseDiff.serverOnly.join(', ')}</small>{:else}<small>No allowed worker model is on the server and missing from your draft.</small>{/if}
     {#if policyRebaseDiff.draftOnly.length}<small>Your draft choices not on the server: {policyRebaseDiff.draftOnly.join(', ')}</small>{:else}<small>No allowed worker model is in your draft and missing from the server.</small>{/if}
     {#if policyRebaseDiff.serverDefault!==policyRebaseDiff.draftDefault}<small>Server default: {policyRebaseDiff.serverDefault}. Your draft default: {policyRebaseDiff.draftDefault}.</small>{:else}<small>Both default to {policyRebaseDiff.draftDefault}.</small>{/if}
     <div class="row">
      <button aria-label="Use latest revision and save my choices" onclick={()=>void confirmRebase()} disabled={busy}>Use latest revision and save my choices</button>
      <button aria-label="Cancel rebase" onclick={cancelRebase} disabled={busy}>Cancel</button>
     </div>
    </div>
   {/if}
   {#if policyMessage}<p role="status">{policyMessage}</p>{/if}
   {#if policyProblem}<p class="error" role="alert">{policyProblem}</p>{/if}
  {:else if policyProblem}
   <p class="error" role="alert">{policyProblem}</p>
  {/if}
 </fieldset>
 {/if}
 {#if problem}<p class="error" role="alert">{problem}</p>{/if}
 {#if message}<p role="status">{message}</p>{/if}
 <footer class="row"><button onclick={onclose}>Done</button></footer>
</dialog>
<style>
 .provider-settings{width:min(760px,calc(100vw - 24px));max-height:90dvh;overflow:auto}
 fieldset{border:1px solid var(--line);border-radius:5px;margin:14px 0;padding:12px;min-width:0}
 legend{font-weight:600}small{display:block;color:var(--muted);line-height:1.6}
 input[type=checkbox]{width:auto;flex-shrink:0}.model-list{max-height:320px;overflow:auto}
 .model-row{display:flex;gap:9px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
 .model-row span{flex:1;min-width:0;overflow-wrap:anywhere}.model-row small{font-size:10px}.model-row>button{flex-shrink:0}
 .callout{display:flex;flex-direction:column;gap:10px}.callout a{color:var(--accent)}
 .worker-list{list-style:none;margin:0;padding:0}
 .worker-list li{display:flex;gap:9px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--line)}
 .worker-list li span{flex:1 1 180px;min-width:0;overflow-wrap:anywhere}.worker-list small{font-size:10px;overflow-wrap:anywhere}
 .worker-list button{flex-shrink:0}
 .worker-policy label,.worker-policy select{min-width:0;max-width:100%}
</style>
