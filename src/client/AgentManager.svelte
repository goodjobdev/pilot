<script lang="ts">
 import {onMount} from 'svelte';
 import {showModalWithFocusReturn} from './modal-focus';
 import {api,request,ApiError} from './api';
 import type {AgentDraftBody,AgentRegistryView,FileEditLedgerView,CommitTargetView,AcceptedActionHistoryView,ActionObservationsView,ActionObservation} from './api';
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
 let targetProject=$state(''),targetView=$state<CommitTargetView|null>(null),targetProblem=$state(''),targetBusy=$state(false),targetChoice=$state(false);
 let targetGeneration=0,historyGeneration=0;
 let actionHistory=$state<AcceptedActionHistoryView|null>(null),historyProblem=$state('');
 let observationId=$state(''),observationView=$state<ActionObservationsView|null>(null),observationChoice=$state<ActionObservation|''>(''),observationProblem=$state(''),observationBusy=$state(false),observationMessage=$state('');
 let observationGeneration=0;
 let problem=$state(''),message=$state(''),busy=$state(false);
 let selected=$state<string|null>(null),creating=$state(false);
 let requestsAccounted=$state<number|null>(null);
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
  problem=field&&['name','description','model','workspace','budgets','scopes'].includes(field)?'':shown;
  return field;
 }

 onMount(()=>{
  const close=showModalWithFocusReturn(dialog);
  void load();
  return close;
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
  creating=false;selected=id;requestsAccounted=null;fieldErrors={};problem='';message='';
  const record=registry?.agents.find(agent=>agent.id===id);
  if(record)draft={name:record.name,description:record.description,enabled:record.enabled,model:{...record.model},workspace:draftWorkspace(record.workspace),budgets:{...record.budgets},scopes:[...record.scopes]};
  await loadOne(id);
 }
 async function loadOne(id:string){
  try{
   const detail=await api.agent(id);
   if(selected!==id||creating)return;
   requestsAccounted=detail.budgetUsage.requestsAccounted;
   // The server is the authority: the form shows the record it just read back, never the draft alone.
   draft={name:detail.agent.name,description:detail.agent.description,enabled:detail.agent.enabled,model:{...detail.agent.model},workspace:draftWorkspace(detail.agent.workspace),budgets:{...detail.agent.budgets},scopes:[...detail.agent.scopes]};
   registry=registry?{...registry,agents:registry.agents.map(agent=>agent.id===id?detail.agent:agent)}:registry;
  }catch(e){problem=(e as Error).message;}
 }
 function startCreate(){
  creating=true;selected=null;requestsAccounted=null;fieldErrors={};problem='';message='';
  draft=blank();
  draft={...draft,workspace:{scope:projects[0]?{kind:'projects' as const,projectIds:[projects[0].id]}:{kind:'projects' as const,projectIds:[]},subpath:''},model:registry?.models[0]?{...registry.models[0]}:{provider:'',modelId:''}};
 }
 function scopeAvailable(scope:string):boolean{
  const entry=registry?.scopes.find(candidate=>candidate.scope===scope);
  return !!entry?.installed&&(scope!=='file_edit'||!!registry?.fileEdit.enabled);
 }
 /** Grant or remove every scope the interface may change, in one step on this draft.
  * An unavailable scope is never newly granted: it has no installed tool, and granting it would
  * record a capability the instance cannot honour. An existing unavailable grant is kept. */
 function grantAll(on:boolean):void{
   const grantable=(registry?.scopes??[]).filter(entry=>scopeAvailable(entry.scope)).map(entry=>entry.scope);
   draft={...draft,scopes:on?[...new Set([...draft.scopes,...grantable])]:draft.scopes.filter(scope=>!grantable.includes(scope))};
 }
 function toggleScope(scope:string,on:boolean){
  if(on&&!scopeAvailable(scope))return;
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
 async function loadTarget(projectId:string){
  const generation=++targetGeneration;targetView=null;targetProblem='';targetChoice=false;
  if(!projectId)return;
  try{const view=await api.commitTarget(projectId);if(generation!==targetGeneration)return;targetView=view;targetChoice=view.target?.enabled??false;}
  catch(e){if(generation===targetGeneration)targetProblem=(e as Error).message;}
 }
 async function loadHistory(projectId:string,before?:string){
  const generation=++historyGeneration;actionHistory=null;historyProblem='';observationId='';observationView=null;observationGeneration++;if(!projectId)return;
  try{const view=await api.actionHistory(projectId,before);if(generation===historyGeneration)actionHistory=view;}
  catch(e){if(generation===historyGeneration)historyProblem=(e as Error).message;}
 }
 async function loadObservations(id:string,preserve=false){
  const generation=++observationGeneration,projectId=targetProject;observationId=id;observationView=null;observationProblem='';observationMessage='';if(!preserve)observationChoice='';
  try{const view=await api.actionObservations(projectId,id);if(generation===observationGeneration)observationView=view;}
  catch(e){if(generation===observationGeneration)observationProblem=(e as Error).message;}
 }
 async function saveObservation(){
  if(observationBusy||!observationView||!observationChoice)return;
  const generation=observationGeneration,projectId=targetProject,id=observationId,view=observationView,choice=observationChoice;observationBusy=true;observationProblem='';observationMessage='';
  try{const saved=await api.recordActionObservation(projectId,id,view.action.revision,view.reviews.length,choice);if(generation===observationGeneration){observationView=saved;observationChoice='';observationMessage='Observation recorded. The action and any barrier remain unchanged.';}}
  catch(e){if(generation===observationGeneration)observationProblem=(e as Error).message+' Your selection is preserved; reload observations before trying again.';}
  finally{observationBusy=false;}
 }
 async function saveTarget(){
  if(!targetProject||!targetView||targetBusy)return;
  const projectId=targetProject,generation=targetGeneration;targetBusy=true;targetProblem='';
  try{const view=await api.saveCommitTarget(projectId,targetView.target?.revision??0,targetChoice);if(generation===targetGeneration)targetView=view;}
  catch(e){if(generation===targetGeneration)targetProblem=(e as Error).message+' Your selection is preserved; reload before retrying.';}
  finally{targetBusy=false;}
 }
 /** The recorded file edits of the selected agent's project, with their diffs. Read-only. */
 async function loadLedger(projectId:string){
  ledger=null;
  if(!projectId||!registry?.fileEdit.enabled)return;
  try{ledger=await api.fileEdits(projectId);}catch{ledger=null;}
 }
 $effect(()=>{const projectId=workspaceProject();if(registry?.fileEdit.enabled)void loadLedger(projectId);});
 const summary=(agent:AgentRecord)=>agent.scopes.length?agent.scopes.map(scope=>scopeAvailable(scope)?scope:scope+' (unavailable)').join(', '):'no scopes';
</script>
<dialog bind:this={dialog} oncancel={onclose} class="agent-manager" aria-labelledby="agent-manager-title">
 <header class="modal-head">
  <div><span class="eyebrow">PILOT SETTINGS</span><h2 id="agent-manager-title">Agents &amp; privileges</h2></div>
  <button aria-label="Close agent manager" onclick={onclose}>×</button>
 </header>
 <div class="manager-scroll">
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
    <label>Name<input aria-label="Agent name" aria-invalid={!!fieldErrors.name} aria-describedby={fieldErrors.name?'agent-name-error':undefined} bind:value={draft.name} maxlength="80" spellcheck="false"></label>
    {#if fieldErrors.name}<small id="agent-name-error" class="field-error" role="alert">{fieldErrors.name}</small>{/if}
    <label>Description<textarea aria-label="Agent description" aria-invalid={!!fieldErrors.description} aria-describedby={fieldErrors.description?'agent-description-error':undefined} bind:value={draft.description} maxlength="400"></textarea></label>
    {#if fieldErrors.description}<small id="agent-description-error" class="field-error" role="alert">{fieldErrors.description}</small>{/if}
    <label class="row"><input type="checkbox" aria-label="Agent enabled" checked={draft.enabled} onchange={e=>draft={...draft,enabled:e.currentTarget.checked}}>Enabled</label>
    <label>Model<select aria-label="Agent model" aria-invalid={!!fieldErrors.model} aria-describedby={fieldErrors.model?'agent-model-error':undefined} value={draft.model.provider+'/'+draft.model.modelId} onchange={e=>{const chosen=registry?.models.find(candidate=>candidate.provider+'/'+candidate.modelId===e.currentTarget.value);draft={...draft,model:chosen?{...chosen}:{provider:'',modelId:''}};}}>
     {#if !registry.models.length}<option value="">No model is offered on this instance</option>{/if}
     {#each registry.models as model (model.provider+'/'+model.modelId)}<option value={model.provider+'/'+model.modelId}>{model.provider} / {model.modelId}</option>{/each}
    </select></label>
    {#if fieldErrors.model}<small id="agent-model-error" class="field-error" role="alert">{fieldErrors.model}</small>{/if}
    <span class="popover-heading">PROJECT SCOPE</span>
    <small class="muted">Where this agent may act. A call that acts on a project outside this scope is refused server-side, even when the tool is otherwise permitted.</small>
    <label class="row"><input type="checkbox" aria-label="All projects" aria-invalid={!!fieldErrors.workspace} aria-describedby={fieldErrors.workspace?'agent-workspace-error':undefined} checked={draft.workspace.scope.kind==='all'} onchange={e=>setAllProjects(e.currentTarget.checked)}>All projects</label>
    {#if draft.workspace.scope.kind!=='all'}
    <div class="scopes" role="group" aria-label="Allowed projects">
     {#each projects as project (project.id)}
     <label class="scope"><input type="checkbox" aria-label={'Project '+project.name} aria-invalid={!!fieldErrors.workspace} aria-describedby={fieldErrors.workspace?'agent-workspace-error':undefined} checked={allowsProject(project.id)} onchange={e=>toggleProject(project.id,e.currentTarget.checked)}><span><strong>{project.name}</strong></span></label>
     {/each}
    </div>
    {/if}
    <label>Declared subpath inside each project<input aria-label="Agent workspace subpath" aria-invalid={!!fieldErrors.workspace} aria-describedby={fieldErrors.workspace?'agent-workspace-error':undefined} bind:value={draft.workspace.subpath} placeholder="empty is each project root" spellcheck="false"></label>
    <small class="muted">The subpath is recorded but does not confine coding or shell tools. Shell access can reach files beyond this project.</small>
    {#if fieldErrors.workspace}<small id="agent-workspace-error" class="field-error" role="alert">{fieldErrors.workspace}</small>{/if}
    <p class="muted" role="note">Named-agent session requests are counted across projects from when accounting was installed. The owner can change the request limit; raising it permits further requests without resetting the count. Owner-created workers use separate limits and are not included in this agent’s count. The jobs-per-hour limit is enforced for the test-execution tool (run_tests) through this agent’s durable ledger; no other job path uses it. These are not spending limits, and providers must honor the requested per-request token cap.</p>
    {#if requestsAccounted!==null&&!creating}<p class="muted">Accounted request reservations: {requestsAccounted}. Failed or uncertain attempts are included.</p>{/if}
    <div class="budgets">
     <label>Max accounted requests<input aria-label="Agent max requests" aria-invalid={!!fieldErrors.budgets} aria-describedby={fieldErrors.budgets?'agent-budgets-error':undefined} value={draft.budgets.maxRequests??''} inputmode="numeric" oninput={e=>budget('maxRequests',e.currentTarget.value)}></label>
     <label>Max output tokens per request<input aria-label="Agent max output tokens" aria-invalid={!!fieldErrors.budgets} aria-describedby={fieldErrors.budgets?'agent-budgets-error':undefined} value={draft.budgets.maxOutputTokens??''} inputmode="numeric" oninput={e=>budget('maxOutputTokens',e.currentTarget.value)}></label>
     <label>Jobs per hour (test execution)<input aria-label="Jobs per hour (test execution)" aria-invalid={!!fieldErrors.budgets} aria-describedby={fieldErrors.budgets?'agent-budgets-error':undefined} value={draft.budgets.maxJobsPerHour??''} inputmode="numeric" oninput={e=>budget('maxJobsPerHour',e.currentTarget.value)}></label>
    </div>
    {#if fieldErrors.budgets}<small id="agent-budgets-error" class="field-error" role="alert">{fieldErrors.budgets}</small>{/if}
    <div class="scopes-head"><span class="popover-heading">PRIVILEGE SCOPES</span>
     <div class="scopes-all">
      <button class="compact-button" aria-label="Grant every available scope" disabled={!registry.scopes.some(entry=>scopeAvailable(entry.scope)&&!draft.scopes.includes(entry.scope))} onclick={()=>grantAll(true)}>Select all available</button>
      <button class="compact-button" aria-label="Remove every scope from this draft" disabled={draft.scopes.length===0} onclick={()=>grantAll(false)}>Clear all</button>
     </div></div>
    <small class="muted">Installed tools require a grant. Unavailable scopes cannot be newly granted. Existing unavailable grants stay saved unless you remove them; they do not make tools available.</small>
    <div class="scopes" role="group" aria-label="Privilege scopes">
     {#each registry.scopes as entry (entry.scope)}
     {@const available=scopeAvailable(entry.scope)}
     {@const granted=draft.scopes.includes(entry.scope)}
     <label class="scope" class:unavailable={!available}><input type="checkbox" aria-label={'Scope '+entry.scope} aria-invalid={!!fieldErrors.scopes} aria-describedby={'scope-status-'+entry.scope+(fieldErrors.scopes?' agent-scopes-error':'')} checked={granted} disabled={!available&&!granted} onchange={e=>toggleScope(entry.scope,e.currentTarget.checked)}><span><strong>{entry.scope}</strong><small>{entry.description}</small><small id={'scope-status-'+entry.scope}>{available?'Installed and available':entry.scope==='file_edit'&&!registry.fileEdit.enabled?'Unavailable: optional file editing is disabled on this deployment.':'Unavailable: no tool is installed for this scope.'}{!available&&granted?' Existing grant; uncheck to remove.':''}</small></span></label>
     {/each}
    </div>
    {#if fieldErrors.scopes}<small id="agent-scopes-error" class="field-error" role="alert">{fieldErrors.scopes}</small>{/if}
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
 <section class="ledger" aria-label="Commit target configuration">
  <span class="popover-heading">COMMIT TARGET</span>
  <p class="muted">Configure the fixed Pilot branch for a project. This does not install a commit tool, grant an agent permission, or make any commit.</p>
  <label>Project<select aria-label="Commit target project" value={targetProject} onchange={e=>{targetProject=e.currentTarget.value;void loadTarget(targetProject);void loadHistory(targetProject);}}>
   <option value="">Choose a project</option>{#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}
  </select></label>
  {#if targetProblem}<p class="error" role="alert">{targetProblem}</p>{/if}
  {#if targetView}
   <p class="muted">{targetView.reason}</p>
   <p class="muted">{targetView.target?'Revision '+targetView.target.revision+' · '+targetView.target.definition.branch:'Not configured yet.'}</p>
   <label class="row"><input type="checkbox" aria-label="Enable commit target" bind:checked={targetChoice} disabled={targetBusy}>Enable target configuration</label>
   <div class="row"><button disabled={targetBusy} onclick={()=>void saveTarget()}>Save commit target</button><button disabled={targetBusy} onclick={()=>void loadTarget(targetProject)}>Reload target</button></div>
  {/if}
  {#if targetProject}
   <h3>Action history</h3>
   <p class="muted">Read-only durable intents for this project. Pending or uncertain effects may have happened; inspect the target before any new action. A recorded receipt is not independent verification. This list cannot retry or clear an action and may not include effects made outside this store.</p>
   <button onclick={()=>void loadHistory(targetProject)}>Reload action history</button>
   {#if historyProblem}<p class="error" role="alert">{historyProblem}</p>{/if}
   {#if actionHistory}
    {#if actionHistory.items.length===0}<p class="muted">No action intents recorded in this store.</p>{/if}
    {#each actionHistory.items as item (item.id)}
     <article class="action-history-item"><strong>{item.actionClass} · {item.state}</strong><p>Target {item.targetId} revision {item.targetRevision} · agent {item.agentId} · session {item.sessionId}</p><p>Artifact {item.artifact.revision}{item.artifact.commit?' · bound commit '+item.artifact.commit:''}{item.receiptCommit?' · reported commit '+item.receiptCommit:''}</p><small>Intent {item.id} · updated {item.updatedAt}</small><div><button aria-label={'Review observations for '+item.actionClass+' '+item.id} onclick={()=>void loadObservations(item.id)}>Review observations</button></div></article>
     {#if observationId===item.id}
      <div class="observation-panel">
       <p class="muted">An owner observation is an unverified statement about what was visible when checked. It does not establish that an effect stopped, clear a barrier, authorize a retry or alter the action.</p>
       {#if observationProblem}<p class="error" role="alert">{observationProblem}</p>{/if}
       {#if observationMessage}<p role="status">{observationMessage}</p>{/if}
       {#if observationView}
        <p>Action revision {observationView.action.revision} · {observationView.action.state}</p>
        {#each observationView.reviews as review (review.revision)}<p>Owner observation {review.revision}: {review.observation} · action revision {review.actionRevision} · {review.observedBy} · {review.observedAt}</p>{/each}
        <label>What did you observe?<select aria-label="Action observation" bind:value={observationChoice} disabled={observationBusy||observationView.reviews.length>=observationView.limit}>
         <option value="">Choose an observation</option><option value="checked-uncertain">Checked; outcome still uncertain</option><option value="checked-no-effect-visible">Checked; no effect visible</option><option value="checked-effect-visible">Checked; effect visible</option>
        </select></label>
        {#if observationView.reviews.length>=observationView.limit}<p class="muted">Observation limit reached; no more can be recorded here.</p>{/if}
        <div class="row"><button disabled={observationBusy||!observationChoice||observationView.reviews.length>=observationView.limit} onclick={()=>void saveObservation()}>Record observation</button><button disabled={observationBusy} onclick={()=>void loadObservations(item.id,true)}>Reload observations</button></div>
       {:else if observationProblem}<button onclick={()=>void loadObservations(item.id,true)}>Reload observations</button>{/if}
      </div>
     {/if}
    {/each}
    {#if actionHistory.nextBefore}<button onclick={()=>void loadHistory(targetProject,actionHistory?.nextBefore??undefined)}>Earlier actions</button><p class="muted">Showing up to 50 intents per page.</p>{/if}
   {/if}
  {/if}
 </section>
 <section class="ledger" aria-label="Recorded file edits">
  <span class="popover-heading">RECORDED FILE EDITS</span>
  {#if !registry?.fileEdit.enabled}
  <p class="muted">The bounded file-edit capability is disabled on this instance. It is optional and deployment-gated by <code>DASHBOARD_FILE_EDIT</code>; a scope grant alone cannot enable it.</p>
  {:else}
  <p class="muted">The mode in force comes from the acceptance policy and is <strong>{ledger?.mode??registry.fileEdit.mode??'propose-only'}</strong>. In propose-only the change and its diff are recorded and no file is written, so every change is reviewable before it lands.</p>
  {#if ledger?.edits.length}
  {#each ledger.edits.slice(-10).reverse() as edit (edit.id)}
  <details class="edit">
   <summary><strong>{edit.path}</strong> · {edit.mode} · {edit.applied===true?'write confirmed':edit.applied===null?'write outcome unknown':'proposed'} · {edit.changedBy.kind}</summary>
   <pre>{edit.diff}</pre>
  </details>
  {/each}
  {:else}<p class="muted">No file edit has been recorded for this project yet.</p>{/if}
  {/if}
 </section>
 </div>
 <footer class="row manager-footer"><button onclick={onclose}>Done</button></footer>
</dialog>
<style>
 /* A frame with a fixed header and footer: the middle scrolls, so the title, the close control and
  * the Done button are always reachable no matter how long the form is. */
 .agent-manager{width:min(1080px,calc(100vw - 24px));max-height:92dvh;overflow:hidden;display:flex;flex-direction:column}
 .agent-manager .modal-head{flex-shrink:0;border-bottom:1px solid var(--line)}
 .manager-scroll{flex:1;min-height:0;overflow:auto}
 .manager-footer{flex-shrink:0;border-top:1px solid var(--line);padding-top:8px}
 .scopes-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}
 .scopes-all{display:flex;gap:6px;flex-wrap:wrap}
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
 .scope.unavailable{border-style:dashed}
 .field-error{display:block;color:var(--danger);line-height:1.5;margin:4px 0 2px}
 .ledger{margin-top:14px;border:1px solid var(--line);border-radius:5px;padding:10px 12px}
 .action-history-item,.observation-panel{overflow-wrap:anywhere}
 .edit{margin-top:8px}
 .edit pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 var(--mono);max-height:220px;overflow:auto}
 small{color:var(--muted);line-height:1.6}
</style>
