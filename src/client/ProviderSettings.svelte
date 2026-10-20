<script lang="ts">
 import {onMount} from 'svelte';
 import {request} from './api';
 import {modelKey,type ProviderSettings,type ModelPreferences,type LoginView} from '../shared/settings';
 let {onclose}:{onclose:()=>void}=$props();
 let dialog:HTMLDialogElement;
 let settings=$state<ProviderSettings|null>(null),provider=$state('openai'),key=$state(''),query=$state(''),busy=$state(false),message=$state(''),problem=$state('');
 let login=$state<LoginView|null>(null),answer=$state('');
 const selected=$derived(settings?.providers.find(p=>p.id===provider));
 const filtered=$derived((settings?.models??[]).filter(m=>m.configured&&(!query||(m.name+' '+modelKey(m)).toLowerCase().includes(query.toLowerCase()))));
 onMount(()=>{
  dialog.showModal();void load();
  const timer=setInterval(()=>{if(login?.status==='pending')void poll(login.id);},1000);
  return ()=>{clearInterval(timer);key='';if(login?.status==='pending')void request('/settings/logins/'+login.id,'DELETE',{}).catch(()=>{});};
 });
 async function load(){try{settings=await request('/settings/providers');}catch(e){problem=(e as Error).message;}}
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
</script>
<dialog bind:this={dialog} oncancel={onclose} class="provider-settings">
 <header class="modal-head"><div><span class="eyebrow">PILOT SETTINGS</span><h2>Providers &amp; models</h2></div><button aria-label="Close provider settings" onclick={onclose}>×</button></header>
 <p class="muted">Credentials stay on this server, outside projects and ordinary backups. They are never returned to this form. Use provider-side spending limits.</p>
 <fieldset disabled={busy}>
  <legend>Connect a provider</legend>
  <label>Provider<select bind:value={provider} onchange={()=>{key='';message='';}}>{#each settings?.providers??[] as p}<option value={p.id}>{p.name}{p.configured?' · connected':''}</option>{/each}</select></label>
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
</style>
