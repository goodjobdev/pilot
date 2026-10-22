<script lang="ts">
 import {api} from './api';
 import type {AgentView} from '../shared/agent';
 import type {AgentRecord} from '../shared/agent-registry';
 import type {SessionBindingView,SessionOverview} from './api';
 import Icon from './Icon.svelte';
 import SessionDetails from './SessionDetails.svelte';

 /**
  * The session bar above the transcript: the one place the owner binds a session to an agent and
  * sees which agent and which scopes are actually in effect.
  *
  * It is deliberately explicit about the empty case. A session with no agent bound is shown as such,
  * with the reason the server reports, rather than leaving "no privileges" a mystery. The binding is
  * written through the durable, revision-checked route; a stale revision is refused in the server's
  * own words. The session list shows every named session with its agent, lifecycle, last activity and
  * linked work, and "New session" creates one with per-field validation.
  */
 let {projectId,sessionId,view=null,agentsVersion=0,onerror=()=>{},onsessionchange=()=>{}}:{projectId:string;sessionId:string;view?:AgentView|null;agentsVersion?:number;onerror?:(message:string)=>void;onsessionchange?:(sessionId:string)=>void}=$props();

 let sessions=$state<SessionOverview[]>([]);
 let agents=$state<AgentRecord[]>([]);
 let selectedId=$state('');
 let binding=$state<SessionBindingView|null>(null);
 let listOpen=$state(false),creating=$state(false);
 let newName=$state(''),nameError=$state('');
 let problem=$state(''),message=$state(''),busy=$state(false);

 const selected=$derived(sessions.find(session=>session.id===selectedId)??null);
 const authority=$derived(binding?.authority??null);
 const scopeText=$derived.by(()=>{
   if(authority===null)return'';
   if(authority.scopes===null)return'the owner\u2019s own dispatch (nothing narrowed)';
   if(authority.scopes.length===0)return'none — every tool is refused';
   const granted=authority.scopes;
   const installed=granted.filter(s=>['ask_question','record_note','read_notes'].includes(s));
   const uninstalled=granted.filter(s=>!['ask_question','record_note','read_notes'].includes(s));
   if(uninstalled.length===0)return granted.join(', ');
   const avail=installed.length>0?installed.join(', '):'(none)';
   const unavail=uninstalled.join(', ')+' [unavailable — no tool installed]';
   return avail+', '+unavail;
 });

 async function loadSessions(){
  problem='';
  try{sessions=(await api.sessions(projectId)).sessions;}catch(error){problem=(error as Error).message;onerror(problem);}
 }
 async function loadAgents(){
  try{agents=(await api.agentRegistry()).agents.filter(agent=>!agent.archived);}catch{agents=[];}
 }
 async function load(){await loadSessions();await loadAgents();}
 async function loadBinding(id:string){
  try{binding=await api.sessionBinding(projectId,id);}
  catch(error){binding=null;problem=(error as Error).message;}
 }
 $effect(()=>{void projectId;void load();});
 // Re-read the agents when the manager reports a change, so a just-created agent is selectable.
 $effect(()=>{void agentsVersion;void loadAgents();});
 $effect(()=>{const id=selectedId;if(id)void loadBinding(id);});
 // The live conversation is the session the transcript belongs to; make it the default selection.
 $effect(()=>{if(sessionId&&sessionId!==selectedId&&!binding){selectedId=sessionId;}});

 async function chooseAgent(value:string){
  if(busy)return;busy=true;problem='';message='';
  try{
   const revision=binding?.binding?.revision??0;
   const result=await api.bindSession(projectId,selectedId,{revision,agentId:value===''?null:value,actor:{kind:'owner',identity:'local'}});
   binding={...(binding??{projectId,sessionId:selectedId,agents}),binding:result.binding,authority:result.authority};
   message=value===''?'This session now has no agent: every tool is refused until one is bound.':('Bound agent '+value+' to this session.');
   await load();
  }catch(error){problem=(error as Error).message;}
  finally{busy=false;}
 }
 async function createSession(){
  if(busy)return;busy=true;nameError='';problem='';message='';
  try{
   const created=await api.createSession({projectId,name:newName});
   newName='';creating=false;selectedId=created.session.id;
   await load();await loadBinding(created.session.id);
   message='Created session '+created.session.name+'.';
  }catch(error){
   const text=(error as Error).message;
   nameError=/name/.test(text)?text:text;problem=/name/.test(text)?'':text;
  }finally{busy=false;}
 }
 function openSession(id:string){selectedId=id;listOpen=false;onsessionchange(id);}
 function linksOf(session:SessionOverview):string{
  if(!session.links.length)return 'no linked work';
  return session.links.map(link=>link.kind==='task'?'task '+link.taskId?.slice(0,8):link.kind==='document'?(link.path??'document'):'workspace').join(', ');
 }
 function lifecycleOf(session:SessionOverview):string{return session.lifecycle.recorded?(session.lifecycle.state??'unknown'):'no lifecycle record';}
</script>
<section class="session-bar" aria-label="Session">
 <div class="session-current">
  <span class="eyebrow">SESSION</span>
  <strong>{selected?.name??('conversation '+selectedId)}</strong>
  <span class="pill" class:live={selectedId===sessionId}>{selectedId===sessionId?'live conversation':'not the live conversation'}</span>
  <span class="session-life">{selected?lifecycleOf(selected):'no lifecycle record'}</span>
 </div>
 <label class="agent-picker">Agent for this session
  <select aria-label="Agent for this session" value={binding?.authority.agentId??''} disabled={busy} onchange={e=>void chooseAgent(e.currentTarget.value)}>
   <option value="">No agent (unbound — no privileges)</option>
   {#each agents as agent (agent.id)}<option value={agent.id}>{agent.name}{agent.enabled?'':' (disabled)'}</option>{/each}
  </select>
 </label>
 <span class="session-scopes" role="status">Scopes in effect: {scopeText}{binding?.authority.emptyReason&&!binding.authority.scopes?.length?' — '+binding.authority.emptyReason:''}</span>
 <div class="session-actions">
  <button class="compact-button" aria-label="Sessions" aria-expanded={listOpen} onclick={()=>{listOpen=!listOpen;creating=false;}}><Icon name="list" size={14}/><span>Sessions</span></button>
  <button class="compact-button" aria-label="New session" onclick={()=>{creating=!creating;listOpen=false;nameError='';}}><Icon name="plus" size={14}/><span>New session</span></button>
 </div>
</section>
{#if message}<p class="session-message" role="status">{message}</p>{/if}
{#if problem}<p class="error session-problem" role="alert">{problem}</p>{/if}
{#if creating}
<form class="session-create" onsubmit={(event)=>{event.preventDefault();void createSession();}}>
 <label>Session name<input aria-label="New session name" bind:value={newName} maxlength="80" spellcheck="false" placeholder="e.g. Invoice export"></label>
 {#if nameError}<small class="field-error" role="alert">{nameError}</small>{/if}
 <button class="primary compact-button" type="submit" disabled={busy||newName.trim()===''}>Create session</button>
</form>
{/if}
{#if listOpen}
<div class="session-list" aria-label="Named sessions">
 {#if sessions.length===0}<p class="muted">No named session is registered for this project yet.</p>{/if}
 {#each sessions as session (session.id)}
 <button class="session-row" class:active={session.id===selectedId} aria-pressed={session.id===selectedId} onclick={()=>openSession(session.id)}>
  <span class="session-name">{session.name}{session.id===sessionId?' · live':''}</span>
  <span class="session-meta">agent: {session.agent.id??'none'} · {lifecycleOf(session)} · last activity {session.updatedAt}</span>
  <span class="session-meta">{linksOf(session)}</span>
 </button>
 {/each}
</div>
{/if}
<SessionDetails {projectId} sessionId={selectedId} view={selectedId===sessionId?view:null} {binding} session={selected}/>
<style>
 .session-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--bg)}
 .session-current{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
 .session-current .eyebrow{padding:0}
 .session-life{font:9px var(--mono);color:var(--muted)}
 .agent-picker{min-width:200px;font-size:10px}
 .session-scopes{font-size:11px;color:var(--muted);flex:1 1 240px;min-width:0;overflow-wrap:anywhere}
 .session-actions{display:flex;gap:6px;margin-left:auto}
 .session-message{color:var(--muted);font-size:11px;margin:4px 12px}
 .session-problem{margin:6px 12px}
 .session-create{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line)}
 .session-create label{min-width:220px}
 .session-list{border-bottom:1px solid var(--line);padding:8px 12px;display:flex;flex-direction:column;gap:6px;max-height:30dvh;overflow:auto}
 .session-row{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:4px;padding:7px 8px}
 .session-row.active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
 .session-name{font-size:12px;font-weight:600;overflow-wrap:anywhere}
 .session-meta{font:10px var(--mono);color:var(--muted);overflow-wrap:anywhere}
 .pill.live{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,var(--line))}
 .field-error{display:block;color:var(--danger);line-height:1.5}
</style>
