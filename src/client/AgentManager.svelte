<script lang="ts">
 import {onMount} from 'svelte';
 import {api,request,ApiError} from './api';
 import type {AgentDraftBody,AgentRegistryView,FileEditLedgerView} from './api';
 import type {AgentRecord} from '../shared/agent-registry';
 import type {Project} from '../shared/model';
 import Icon from './Icon.svelte';

 /**
  * The agent management view: create agents and assign what each one may do.
  *
  * The interface is deliberately **not** the enforcement point. It reads the closed scope vocabulary
  * the server publishes — each scope beside the one line that describes it — and it sends what the
  * owner chose; every rule (the offered model, the workspace scope, the budget bounds, the duplicate
  * name, the governance decision) is decided by the server, and a refusal arrives in the server's own
  * words and is shown beside the field it names rather than as a generic failure.
  */
 let {onclose,onchanged}:{onclose:()=>void;onchanged?:(projectId:string)=>void}=$props();
 let dialog:HTMLDialogElement;
 let registry=$state<AgentRegistryView|null>(null),projects=$state<Project[]>([]);
 let ledger=$state<FileEditLedgerView|null>(null);
 let problem=$state(''),message=$state(''),busy=$state(false);
 let selected=$state<string|null>(null),creating=$state(false);
 /** The per-field refusals the server reported, keyed by the field name it named. */
 let fieldErrors=$state<Record<string,string>>({});
 /** The draft being edited: a new record, or a copy of the selected one. */
 let draft=$state<AgentDraftBody>(blank());
 let actorKind=$state<'owner'|'agent'>('owner'),actorIdentity=$state('local');

 function blank():AgentDraftBody{
  return {name:'',description:'',enabled:true,model:{provider:'',modelId:''},workspace:{scope:{kind:'projects',projectIds:[]},subpath:''},budgets:{maxRequests:null,maxOutputTokens:null,maxJobsPerHour:null},scopes:[]};
 }
 /** The first project the workspace names, or the workspace's own ledger project, for the file-edit read. */
 function workspaceProject():string{return draft.workspace.scope.kind==='projects'?draft.workspace.scope.projectIds[0]??'':projects[0]?.id??'';}
 /** Whether the workspace allows a project. 'all' allows every project. */
 function allowsProject(id:string):boolean{return draft.workspace.scope.kind==='all'||draft.workspace.scope.projectIds.includes(id);}
 function setAllProjects(on:boolean){
  draft={...draft,workspace:{...draft.workspace,scope:on?{kind:'all' as const}:{kind:'projects' as const,projectIds:[]}}};
 }
 function toggleProject(id:string,on:boolean){
  if(draft.workspace.scope.kind!=='projects')return;
  const current=draft.workspace.scope.projectIds;
  const next=on?[...current,id]:current.filter(candidate=>candidate!==id);
  draft={...draft,workspace:{...draft.workspace,scope:{kind:'projects' as const,projectIds:next}}};
 }
 /** A record's workspace as an editable draft (the stored project list is readonly; the draft's is not). */
 function draftWorkspace(workspace:AgentRecord['workspace']):AgentDraftBody['workspace']{
  return {scope:workspace.scope.kind==='all'?{kind:'all'}:{kind:'projects',projectIds:[...workspace.scope.projectIds]},subpath:workspace.subpath};
 }
 /** The owner-visible summary of an agent's project scope: every project, or the names it names. */
 function projectSummary(agent:AgentRecord):string{
  if(agent.workspace.scope.kind==='all')return 'all projects';
  const names=agent.workspace.scope.projectIds.map(id=>projects.find(project=>project.id===id)?.name??id);
  return names.length?names.join(', '):'no projects';
 }
 /** The field a server refusal names, so the error lands beside the input that caused it. */
 const FIELDS=['name','description','enabled','model','workspace','budgets','scopes','agentId','revision','patch','draft','actor','request'];
 function attribute(raw:string):{field:string;message:string}{
  const text=raw.replace(/^The (parameters for \S+|action scope) /,'').trim();
  const field=FIELDS.find(candidate=>text.startsWith(candidate+' ')||text.startsWith(candidate+' (')||text.startsWith('The '+candidate+' '));
  if(field==='model'||text.startsWith('The model '))return {field:'model',message:raw};
  if(field)return {field,message:raw};
  if(/already named/.test(raw))return {field:'name',message:raw};
  return {field:'',message:raw};
 }
 function report(error:unknown){
  const text=error instanceof ApiError?error.message:(error as Error).message;
  const {field,message:shown}=attribute(text);
  fieldErrors=field?{...fieldErrors,[field]:shown}:{};
  problem=field?'':shown;
  return field;
 }

 onMount(()=>{
  dialog.showModal();
  void load();
 });
 async function load(){
  problem='';
  try{
   registry=await api.agentRegistry();
   projects=await api.projects();
   if(draft.workspace.scope.kind==='projects'&&draft.workspace.scope.projectIds.length===0&&projects[0])draft={...draft,workspace:{...draft.workspace,scope:{kind:'projects' as const,projectIds:[projects[0].id]}}};
   if(!draft.model.provider&&registry.models.length)draft={...draft,model:{...registry.models[0]}};
   if(selected)await loadOne(selected);
   else if(!creating)selectFirst();
  }catch(e){problem=(e as Error).message;}
 }
 function selectFirst(){
  const first=registry?.agents.find(agent=>!agent.archived)??registry?.agents[0];
  if(first)void select(first.id);
 }
 async function select(id:string){
  creating=false;selected=id;fieldErrors={};problem='';message='';
  const record=registry?.agents.find(agent=>agent.id===id);
  if(record)draft={name:record.name,description:record.description,enabled:record.enabled,model:{...record.model},workspace:draftWorkspace(record.workspace),budgets:{...record.budgets},scopes:[...record.scopes]};
  await loadOne(id);
 }
 async function loadOne(id:string){
  try{
   const detail=await api.agent(id);
   // The server is the authority: the form shows the record it just read back, never the draft alone.
   draft={name:detail.agent.name,description:detail.agent.description,enabled:detail.agent.enabled,model:{...detail.agent.model},workspace:draftWorkspace(detail.agent.workspace),budgets:{...detail.agent.budgets},scopes:[...detail.agent.scopes]};
   registry=registry?{...registry,agents:registry.agents.map(agent=>agent.id===id?detail.agent:agent)}:registry;
  }catch(e){problem=(e as Error).message;}
 }
 function startCreate(){
  creating=true;selected=null;fieldErrors={};problem='';message='';
  draft=blank();
  draft={...draft,workspace:{scope:projects[0]?{kind:'projects' as const,projectIds:[projects[0].id]}:{kind:'projects' as const,projectIds:[]},subpath:''},model:registry?.models[0]?{...registry.models[0]}:{provider:'',modelId:''}};
 }
 function toggleScope(scope:string,on:boolean){
  draft={...draft,scopes:on?[...draft.scopes,scope]:draft.scopes.filter(candidate=>candidate!==scope)};
 }
 function budget(field:'maxRequests'|'maxOutputTokens'|'maxJobsPerHour',value:string){
  const trimmed=value.trim();
  const parsed=trimmed===''?null:Number(trimmed);
  draft={...draft,budgets:{...draft.budgets,[field]:parsed!==null&&Number.isFinite(parsed)?parsed:null}};
 }
 async function save(){
  if(busy)return;
  busy=true;fieldErrors={};problem='';message='';
  const actor={kind:actorKind,identity:actorIdentity};
  try{
   if(creating){
    const created=await api.createAgent({draft,actor});
    // The reload is what makes the form show the record the server really holds; the confirmation is
    // reported after it, so a reload never wipes it.
    creating=false;selected=created.agent.id;
    await load();
    message='Created '+created.agent.name+' at revision '+created.agent.revision+'.';
   }else{
    const current=registry?.agents.find(agent=>agent.id===selected);
    if(!current){problem='Choose an agent first.';return;}
    const updated=await api.updateAgent(current.id,{revision:current.revision,patch:draft,actor});
    await load();
    message='Saved '+updated.agent.name+' at revision '+updated.agent.revision+'.';
   }
   onchanged?.(workspaceProject());
  }catch(e){report(e);}
  finally{busy=false;}
 }
 /** Enable or disable one agent: the same revision-checked change, with one field. */
 async function setEnabled(enabled:boolean){
  if(busy)return;
  busy=true;fieldErrors={};problem='';message='';
  try{
   const current=registry?.agents.find(agent=>agent.id===selected);
   if(!current){problem='Choose an agent first.';return;}
   const updated=await api.updateAgent(current.id,{revision:current.revision,patch:{enabled},actor:{kind:actorKind,identity:actorIdentity}});
   draft={...draft,enabled:updated.agent.enabled};
   await load();
   message=(enabled?'Enabled ':'Disabled ')+updated.agent.name+' at revision '+updated.agent.revision+'.';
  }catch(e){report(e);}
  finally{busy=false;}
 }
 async function archive(){
  if(busy)return;
  const current=registry?.agents.find(agent=>agent.id===selected);
  if(!current)return;
  if(!confirm('Archive '+current.name+'? It keeps every field it holds and stops being in force; its name becomes free again.'))return;
  busy=true;fieldErrors={};problem='';message='';
  try{
   const archived=await api.archiveAgent(current.id,{revision:current.revision,actor:{kind:actorKind,identity:actorIdentity}});
   await load();
   message='Archived '+archived.agent.name+'.';
  }catch(e){report(e);}
  finally{busy=false;}
 }
 /** The recorded file edits of the selected agent's project, with their diffs. Read-only. */
 async function loadLedger(projectId:string){
  ledger=null;
  if(!projectId||!registry?.fileEdit.enabled)return;
  try{ledger=await api.fileEdits(projectId);}catch{ledger=null;}
 }
 $effect(()=>{const projectId=workspaceProject();if(registry?.fileEdit.enabled)void loadLedger(projectId);});
 const summary=(agent:AgentRecord)=>agent.scopes.length?agent.scopes.join(', '):'no scopes';
</script>
<dialog bind:this={dialog} oncancel={onclose} class="agent-manager">
 <header class="modal-head">
  <div><span class="eyebrow">PILOT SETTINGS</span><h2>Agents &amp; privileges</h2></div>
  <button aria-label="Close agent manager" onclick={onclose}>×</button>
 </header>
 <p class="muted">Each agent holds an explicit allowlist of privilege scopes. The server enforces it at dispatch, on every tool call, and the interface is never the enforcement point.</p>
 {#if problem}<p class="error" role="alert">{problem}</p>{/if}
 {#if message}<p role="status">{message}</p>{/if}
 <div class="manager">
  <section class="agent-list" aria-label="Agents">
   <div class="list-head"><span class="popover-heading">AGENTS</span><button class="compact-button" aria-label="New agent" onclick={startCreate}><Icon name="plus" size={14}/><span>New</span></button></div>
   {#if !registry}<p class="muted">Loading…</p>
   {:else if registry.agents.length===0}<p class="muted">No agents yet. Create one and assign what it may do.</p>
   {/if}
   {#each registry?.agents??[] as agent (agent.id)}
   <button class="agent-row" class:active={selected===agent.id&&!creating} aria-pressed={selected===agent.id&&!creating} onclick={()=>void select(agent.id)}>
    <span class="agent-name">{agent.name}</span>
    <span class="agent-scopes">{summary(agent)}</span>
    <span class="agent-scopes">projects: {projectSummary(agent)}</span>
    <span class="pills">
     {#if agent.archived}<span class="pill">archived</span>{:else if agent.enabled}<span class="pill on">enabled</span>{:else}<span class="pill">disabled</span>{/if}
     <span class="pill">r{agent.revision}</span>
    </span>
   </button>
   {/each}
  </section>
  <section class="agent-form" aria-label={creating?'New agent':'Agent record'}>
   {#if registry}
   <fieldset disabled={busy}>
    <legend>{creating?'New agent':(selected?'Change this agent':'Choose an agent')}</legend>
    <label>Name<input aria-label="Agent name" bind:value={draft.name} maxlength="80" spellcheck="false"></label>
    {#if fieldErrors.name}<small class="field-error" role="alert">{fieldErrors.name}</small>{/if}
    <label>Description<textarea aria-label="Agent description" bind:value={draft.description} maxlength="400"></textarea></label>
    {#if fieldErrors.description}<small class="field-error" role="alert">{fieldErrors.description}</small>{/if}
    <label class="row"><input type="checkbox" aria-label="Agent enabled" checked={draft.enabled} onchange={e=>draft={...draft,enabled:e.currentTarget.checked}}>Enabled</label>
    <label>Model<select aria-label="Agent model" value={draft.model.provider+'/'+draft.model.modelId} onchange={e=>{const chosen=registry?.models.find(candidate=>candidate.provider+'/'+candidate.modelId===e.currentTarget.value);draft={...draft,model:chosen?{...chosen}:{provider:'',modelId:''}};}}>
     {#if !registry.models.length}<option value="">No model is offered on this instance</option>{/if}
     {#each registry.models as model (model.provider+'/'+model.modelId)}<option value={model.provider+'/'+model.modelId}>{model.provider} / {model.modelId}</option>{/each}
    </select></label>
    {#if fieldErrors.model}<small class="field-error" role="alert">{fieldErrors.model}</small>{/if}
    <span class="popover-heading">PROJECT SCOPE</span>
    <small class="muted">Where this agent may act. A call that acts on a project outside this scope is refused server-side, even when the tool is otherwise permitted.</small>
    <label class="row"><input type="checkbox" aria-label="All projects" checked={draft.workspace.scope.kind==='all'} onchange={e=>setAllProjects(e.currentTarget.checked)}>All projects</label>
    {#if draft.workspace.scope.kind!=='all'}
    <div class="scopes" aria-label="Allowed projects">
     {#each projects as project (project.id)}
     <label class="scope"><input type="checkbox" aria-label={'Project '+project.name} checked={allowsProject(project.id)} onchange={e=>toggleProject(project.id,e.currentTarget.checked)}><span><strong>{project.name}</strong></span></label>
     {/each}
    </div>
    {/if}
    <label>Subpath inside each project<input aria-label="Agent workspace subpath" bind:value={draft.workspace.subpath} placeholder="empty is each project root" spellcheck="false"></label>
    {#if fieldErrors.workspace}<small class="field-error" role="alert">{fieldErrors.workspace}</small>{/if}
    <div class="budgets">
     <label>Max requests<input aria-label="Agent max requests" value={draft.budgets.maxRequests??''} inputmode="numeric" oninput={e=>budget('maxRequests',e.currentTarget.value)}></label>
     <label>Max output tokens<input aria-label="Agent max output tokens" value={draft.budgets.maxOutputTokens??''} inputmode="numeric" oninput={e=>budget('maxOutputTokens',e.currentTarget.value)}></label>
     <label>Max jobs per hour<input aria-label="Agent max jobs per hour" value={draft.budgets.maxJobsPerHour??''} inputmode="numeric" oninput={e=>budget('maxJobsPerHour',e.currentTarget.value)}></label>
    </div>
    {#if fieldErrors.budgets}<small class="field-error" role="alert">{fieldErrors.budgets}</small>{/if}
    <span class="popover-heading">PRIVILEGE SCOPES</span>
    <small class="muted">An agent has only what its allowlist names. Everything else is refused at dispatch.</small>
    <div class="scopes" aria-label="Privilege scopes">
     {#each registry.scopes as entry (entry.scope)}
     {@const installed=['ask_question','record_note','read_notes'].includes(entry.scope)}
     <label class="scope" class:unavailable={!installed} title={installed?'':'This scope has no tool installed in this build and cannot be used by any agent'}><input type="checkbox" aria-label={'Scope '+entry.scope} checked={draft.scopes.includes(entry.scope)} onchange={e=>toggleScope(entry.scope,e.currentTarget.checked)}><span><strong>{entry.scope}</strong><small>{entry.description}{!installed?' — no tool installed, unavailable':''}</small></span></label>
     {/each}
    </div>
    {#if fieldErrors.scopes}<small class="field-error" role="alert">{fieldErrors.scopes}</small>{/if}
    <div class="row">
     <button class="primary" aria-label={creating?'Create agent':'Save agent'} disabled={busy||!selected&&!creating} onclick={()=>void save()}>{creating?'Create agent':'Save'}</button>
     {#if !creating&&selected}
     <button aria-label={draft.enabled?'Disable agent':'Enable agent'} onclick={()=>void setEnabled(!draft.enabled)}>{draft.enabled?'Disable':'Enable'}</button>
     <button class="danger-command" aria-label="Archive agent" onclick={()=>void archive()}>Archive</button>
     {/if}
    </div>
   </fieldset>
   {/if}
  </section>
 </div>
 <section class="ledger" aria-label="Recorded file edits">
  <span class="popover-heading">RECORDED FILE EDITS</span>
  {#if !registry?.fileEdit.enabled}
  <p class="muted">The bounded file-edit capability is disabled on this instance, so no file is proposed or written. Set <code>DASHBOARD_FILE_EDIT=on</code> to enable it.</p>
  {:else}
  <p class="muted">The mode in force comes from the acceptance policy and is <strong>{ledger?.mode??registry.fileEdit.mode??'propose-only'}</strong>. In propose-only the change and its diff are recorded and no file is written, so every change is reviewable before it lands.</p>
  {#if ledger?.edits.length}
  {#each ledger.edits.slice(-10).reverse() as edit (edit.id)}
  <details class="edit">
   <summary><strong>{edit.path}</strong> · {edit.mode} · {edit.applied?'written':'proposed'} · {edit.changedBy.kind}</summary>
   <pre>{edit.diff}</pre>
  </details>
  {/each}
  {:else}<p class="muted">No file edit has been recorded for this project yet.</p>{/if}
  {/if}
 </section>
 <footer class="row"><button onclick={onclose}>Done</button></footer>
</dialog>
<style>
 .agent-manager{width:min(1080px,calc(100vw - 24px));max-height:92dvh;overflow:auto}
 .manager{display:grid;grid-template-columns:minmax(200px,280px) 1fr;gap:14px;align-items:start}
 @media (max-width:820px){.manager{grid-template-columns:1fr}}
 .agent-list{border:1px solid var(--line);border-radius:5px;padding:8px;min-width:0}
 .list-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
 .agent-row{display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:4px;padding:7px 8px;margin-top:6px}
 .agent-row.active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
 .agent-name{font-size:12px;font-weight:600;overflow-wrap:anywhere}
 .agent-scopes{font:10px var(--mono);color:var(--muted);overflow-wrap:anywhere}
 .pills{display:flex;gap:6px;flex-wrap:wrap}
 .pill.on{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,var(--line))}
 fieldset{border:1px solid var(--line);border-radius:5px;margin:0;padding:12px;min-width:0}
 legend{font-weight:600}
 .budgets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
 .scopes{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:6px;margin-top:6px}
 .scope{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--line);border-radius:4px;padding:6px 8px}
 .scope input{width:auto;flex-shrink:0;margin-top:3px}
 .scope small{display:block;color:var(--muted);line-height:1.5}
 .field-error{display:block;color:var(--danger);line-height:1.5;margin:4px 0 2px}
 .ledger{margin-top:14px;border:1px solid var(--line);border-radius:5px;padding:10px 12px}
 .edit{margin-top:8px}
 .edit pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 var(--mono);max-height:220px;overflow:auto}
 small{color:var(--muted);line-height:1.6}
</style>
