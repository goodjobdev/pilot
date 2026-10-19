<script lang="ts">
 import { onMount } from 'svelte';
 import ProjectSidebar from './ProjectSidebar.svelte';
 import AddProjectDialog from './AddProjectDialog.svelte';
 import ImportReview from './ImportReview.svelte';
 import DependencyCanvas from './DependencyCanvas.svelte';
 import MilestoneTimeline from './MilestoneTimeline.svelte';
 import TaskList from './TaskList.svelte';
 import TaskInspector from './TaskInspector.svelte';
 import BoardSettings from './BoardSettings.svelte';
 import QuestionInbox from './QuestionInbox.svelte';
 import { alertState as readAlertState, disableAlerts, enableAlerts, onAlertNavigation } from './push';
 import type { AlertState } from './push';
 import DocBrowser from './DocBrowser.svelte';
 import DocView from './DocView.svelte';
 import DocEditor from './DocEditor.svelte';
 import AgentsView from './AgentsView.svelte';
 import { api,session,ApiError,download } from './api';
 import type { Board,Operation,Project,Snapshot } from '../shared/model';
 import type { DocEntry,DocSnapshot } from '../shared/docs';
 import { newTask } from '../shared/model';
 import { applyOperation } from '../shared/schema';
 import { serializeBoard } from '../shared/markdown';
 import { readiness,specState } from '../shared/graph';
 import Icon from './Icon.svelte';
 import './theme.css';
 let projects=$state<Project[]>([]),project=$state<Project|null>(null),snapshot=$state<Snapshot|null>(null);
 let adding=$state(false),importing=$state(false),settings=$state(false),error=$state(''),loading=$state(false),missingBoard=$state(false);
 let view=$state(window.innerWidth<750?'List':'Dependencies'),search=$state(''),domain=$state('all'),status=$state('all'),scope=$state('all'),selected=$state('');
 let saving=$state(false),saveState=$state('Saved'),failed=$state(false),inspectorDirty=$state(false),undoStack=$state<Board[]>([]),redoStack=$state<Board[]>([]);
 let theme=$state<'dark'|'light'>(localStorage.getItem('dashboard.theme')==='light'?'light':'dark');
 let sidebarHidden=$state(localStorage.getItem('dashboard.sidebar.hidden')==='true'||(localStorage.getItem('dashboard.sidebar.hidden')===null&&window.innerWidth<900));
 let actionsMenu=$state<HTMLDivElement>(),filtersMenu=$state<HTMLDivElement>();
 let docs=$state<DocEntry[]>([]),doc=$state<DocSnapshot|null>(null),docDraft=$state(''),docEditing=$state(false),docDirty=$state(false),docConflict=$state(false),docSaving=$state(false),docMessage=$state(''),docsError=$state(''),treeOpen=$state(false);
 let actionsOpen=$state(false),filtersOpen=$state(false),inboxOpen=$state(false);
 let inbox=$state<{path:string;line:number;text:string;anchor:string|null;id:string}[]>([]),focusAnchor=$state<string|null>(null),inboxMenu=$state<HTMLDivElement>();
 let agentQuestions=$state<{id:string;text:string}[]>([]);
 let alertState=$state<AlertState>('off'),alertBusy=$state(false),alertMessage=$state('');
 let docPathSet=$derived(new Set(docs.map(d=>d.path)));
 let shell=$state<HTMLDivElement>();
 let unlinked=$derived(snapshot?snapshot.board.tasks.filter(t=>t.scope==='active'&&!t.archived&&specState(t,docPathSet)==='unlinked').length:0);
 let inboxCount=$derived(inbox.length+agentQuestions.length);
 let filterCount=$derived(Number(domain!=='all')+Number(status!=='all')+Number(scope!=='all'));
 let ready=$derived(snapshot?.board.tasks.filter(t=>readiness(snapshot!.board,t.id)==='ready').length??0);
 let waiting=$derived(snapshot?.board.tasks.filter(t=>readiness(snapshot!.board,t.id)==='waiting').length??0);
 let doing=$derived(snapshot?.board.tasks.filter(t=>t.status==='doing').length??0);
 let done=$derived(snapshot?.board.tasks.filter(t=>t.status==='done').length??0);
 let visible=$derived(snapshot?.board.tasks.filter(t=>!t.archived&&(!search||t.title.toLowerCase().includes(search.toLowerCase()))&&(domain==='all'||t.domain===domain)&&(status==='all'||t.status===status)&&(scope==='all'||t.scope===scope))??[]);
 $effect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('dashboard.theme',theme);});
 $effect(()=>{if(project)localStorage.setItem('dashboard.filters.'+project.id,JSON.stringify({search,domain,status,scope,view}));});
 $effect(()=>{try{localStorage.setItem('dashboard.sidebar.hidden',String(sidebarHidden));}catch{/* UI preference is optional */}});
 // The narrow-screen project drawer starts below the header stack so it never covers
 // the command bar. The offset is measured because the header wraps on small screens.
 $effect(()=>{ void view; void project; void error; measureHeader(); });
 function measureHeader(){
   const area=(shell?.querySelector('.view-area')??null) as HTMLElement|null;
   const top=area?Math.round(area.getBoundingClientRect().top):0;
   document.documentElement.style.setProperty('--header-h',(top>0?top:42)+'px');
 }
 onMount(()=>{const onResize=()=>measureHeader();window.addEventListener('resize',onResize);return()=>window.removeEventListener('resize',onResize);});
 onMount(()=>{void boot();return onAlertNavigation(url=>void followAlert(url));});
 $effect(()=>{void refreshAlertState();});
 async function refreshAlertState(){
   try{alertState=await readAlertState();}catch{alertState='unsupported';}
 }
 async function enablePhoneAlerts(){
   alertBusy=true;alertMessage='';
   try{const result=await enableAlerts();alertState='on';alertMessage='Alerts enabled on '+result.count+' device'+(result.count===1?'':'s')+'.';}
   catch(e){alertMessage=(e as Error).message;await refreshAlertState();}
   finally{alertBusy=false;}
 }
 async function disablePhoneAlerts(){
   alertBusy=true;alertMessage='';
   try{const result=await disableAlerts();alertState='off';alertMessage='Alerts turned off ('+result.count+' device'+(result.count===1?'':'s')+' left).';}
   catch(e){alertMessage=(e as Error).message;}
   finally{alertBusy=false;}
 }
 async function testPhoneAlert(){
   alertBusy=true;alertMessage='';
   try{const result=await api.testAlert();alertMessage=result.sent?'Test alert sent.':(result.skipped?'No device is registered yet.':'The push service refused it ('+result.failed+' failed).');}
   catch(e){alertMessage=(e as Error).message;}
   finally{alertBusy=false;}
 }
 function readDeepLink():{projectId:string|null;view:string|null}{
   const params=new URLSearchParams(location.search);
   const projectId=params.get('project'),view=params.get('view');
   if(projectId!==null||view!==null)history.replaceState({},'',location.pathname);
   return {projectId,view};
 }
 /** An alert tap names the project and the view that needs attention. */
 async function followAlert(url:string){
   try{
     const params=new URL(url,location.origin).searchParams;
     const projectId=params.get('project');
     if(projectId){const found=projects.find(candidate=>candidate.id===projectId);if(found&&found.id!==project?.id)await select(found);}
     const view=params.get('view');
     if(view&&['Dependencies','Timeline','List','Wiki','Agents'].includes(view))setView(view);
   }catch{/* a malformed alert link is ignored */}
 }
 function command(action:()=>void){actionsOpen=false;action();}
 function outside(e:MouseEvent){if(!(e.target instanceof Node))return;if(actionsOpen&&!actionsMenu?.contains(e.target))actionsOpen=false;if(filtersOpen&&!filtersMenu?.contains(e.target))filtersOpen=false;if(inboxOpen&&!inboxMenu?.contains(e.target))inboxOpen=false;}
 function keys(e:KeyboardEvent){
   if(e.key==='Escape'){if(actionsOpen){actionsOpen=false;actionsMenu?.querySelector('button')?.focus();e.preventDefault();}if(filtersOpen){filtersOpen=false;filtersMenu?.querySelector('button')?.focus();e.preventDefault();}if(inboxOpen){inboxOpen=false;inboxMenu?.querySelector('button')?.focus();e.preventDefault();}return;}
   if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='b'&&!(e.target instanceof Element&&e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))){e.preventDefault();toggleSidebar();}
 }
 function leave(){return !(saving||failed||inspectorDirty||docDirty)||confirm('There are unsaved edits. Export your draft before leaving. Discard these edits?');}
 async function boot(){
   try{
     await session();
     projects=await api.projects();
     const link=readDeepLink();
     const id=link.projectId??localStorage.getItem('dashboard.project');
     const p=projects.find(candidate=>candidate.id===id)??projects[0];
     if(p)await select(p);
     if(link.view&&['Dependencies','Timeline','List','Wiki','Agents'].includes(link.view))setView(link.view);
   }catch(e){error=(e as Error).message;}
 }
 async function select(p:Project){
   if(!leave())return;project=p;snapshot=null;error='';missingBoard=false;loading=true;selected='';failed=false;inspectorDirty=false;saveState='Saved';undoStack=[];redoStack=[];doc=null;docDraft='';docEditing=false;docDirty=false;docConflict=false;docMessage='';docsError='';docs=[];localStorage.setItem('dashboard.project',p.id);
   try{const filters=JSON.parse(localStorage.getItem('dashboard.filters.'+p.id)??'null');if(filters){search=filters.search??'';domain=filters.domain??'all';status=filters.status??'all';scope=filters.scope??'all';view=window.innerWidth<750?'List':filters.view??'Dependencies';}else{search='';domain='all';status='all';scope='all';}}catch{/* defaults */}
   try{const v=await api.board(p.id);if(project?.id===p.id)snapshot=v;}catch(e){if(project?.id===p.id){error=(e as Error).message;missingBoard=e instanceof ApiError&&e.status===404;}}finally{loading=false;void loadDocs();void loadInbox();}
 }
 async function created(p:Project){adding=false;projects=await api.projects();await select(p);}
 async function initialize(){if(!project)return;try{snapshot=await api.initialize(project.id);error='';missingBoard=false;}catch(e){error=(e as Error).message;}}
 async function remove(){if(!project||!leave()||!confirm('Unregister this project? Planning files will NOT be deleted.'))return;try{await api.remove(project.id);projects=await api.projects();project=null;snapshot=null;if(projects[0])await select(projects[0]);}catch(e){error=(e as Error).message;}}
 async function locate(){if(!project)return;const path=prompt('Approved folder on the dashboard server',project.path);if(!path)return;try{await api.relocate(project.id,path);projects=await api.projects();await select(projects.find(p=>p.id===project!.id)!);}catch(e){error=(e as Error).message;}}
 function choose(id:string){if(inspectorDirty&&!confirm('Discard unapplied task edits? Export the task draft first if needed.'))return;selected=id;inspectorDirty=false;}
 async function mutate(op:Operation,record=true){
   if(!project||!snapshot||saving||failed){error='Save is pending or conflicted. Export/reload before continuing.';return;}
   if(inspectorDirty&&!(op.op==='putTask'&&op.task.id===selected)){error='Save or export unapplied task edits before changing the board.';return;}
   let board:Board;try{board=applyOperation(snapshot.board,op);}catch(e){error=(e as Error).message;return;}
   const previous=structuredClone($state.snapshot(snapshot.board)),revision=snapshot.revision,pid=project.id;
   saving=true;saveState='Saving…';error='';snapshot={board,revision};inspectorDirty=false;
   try{const saved=await api.mutate(pid,revision,op);if(project?.id===pid){snapshot=saved;saveState='Saved';if(record){undoStack=[...undoStack.slice(-49),previous];redoStack=[];}if(selected&&!saved.board.tasks.some(t=>t.id===selected))selected='';}}
   catch(e){failed=true;saveState=e instanceof ApiError&&e.status===409?'Conflict':'Unsaved';error=(e as Error).message;}
   finally{saving=false;}
 }
 async function addTask(){if(!snapshot)return;const task=newTask(crypto.randomUUID());task.domain=snapshot.board.domains[0].id;await mutate({op:'putTask',task});if(!failed&&snapshot.board.tasks.some(t=>t.id===task.id))choose(task.id);}
 async function undo(){if(!snapshot||!undoStack.length)return;const before=structuredClone($state.snapshot(snapshot.board)),target=undoStack.at(-1)!;await mutate({op:'restore',board:target},false);if(!failed){undoStack=undoStack.slice(0,-1);redoStack=[...redoStack,before];}}
 async function redo(){if(!snapshot||!redoStack.length)return;const before=structuredClone($state.snapshot(snapshot.board)),target=redoStack.at(-1)!;await mutate({op:'restore',board:target},false);if(!failed){redoStack=redoStack.slice(0,-1);undoStack=[...undoStack,before];}}
 function exported(){if(snapshot)download(failed?'unsaved-board.md':'board.md',serializeBoard($state.snapshot(snapshot.board)),'text/markdown');}
 function imported(s:Snapshot){snapshot=s;undoStack=[];redoStack=[];saveState='Saved';selected='';}
 function setView(mode:string){
   view=mode;
   if(mode==='Wiki'){
     if(project)void loadDocs();
     // One drawer at a time: on a narrow screen the document tree takes the place of the project drawer.
     if(window.innerWidth<900){sidebarHidden=true;treeOpen=true;}
   }
 }
 function toggleSidebar(){
   sidebarHidden=!sidebarHidden;
   if(!sidebarHidden&&window.innerWidth<900)treeOpen=false;
 }
 async function loadDocs(){
   if(!project)return;
   try{docsError='';docs=(await api.docs(project.id)).documents;}
   catch(e){docsError=(e as Error).message;docs=[];}
 }
 async function loadInbox(){
   if(!project)return;
   try{inbox=(await api.inbox(project.id)).questions;}catch{inbox=[];}
   try{
     const agents=await api.agents(project.id);
     agentQuestions=agents.enabled&&agents.view?agents.view.questions.filter(question=>!question.answer).map(question=>({id:question.id,text:question.text})):[];
   }catch{agentQuestions=[];}
 }
 function openQuestion(path:string,anchor:string|null){
   inboxOpen=false;focusAnchor=anchor;
   if(view!=='Wiki')setView('Wiki');
   void openDoc(path);
 }
 async function openDoc(path:string){
   if(!project)return;
   if(docDirty&&!confirm('Discard unsaved document edits?'))return;
   try{docsError='';const loaded=await api.doc(project.id,path);doc=loaded;docDraft=loaded.text;docEditing=false;docDirty=false;docConflict=false;docMessage='';treeOpen=false;}
   catch(e){docsError=(e as Error).message;}
 }
 function editDoc(){if(doc){docEditing=true;docMessage='';}}
 function discardDoc(){docEditing=false;docDirty=false;docConflict=false;docDraft=doc?.text??'';}
 async function reloadDoc(){
   if(!doc||!project)return;
   try{const loaded=await api.doc(project.id,doc.path);doc=loaded;docDraft=loaded.text;docEditing=false;docDirty=false;docConflict=false;docMessage='Reloaded from disk.';}
   catch(e){docsError=(e as Error).message;}
 }
 async function saveDoc(text:string){
   if(!doc||!project)return;
   docSaving=true;docConflict=false;docMessage='';
   try{
     const saved=await api.saveDoc(project.id,{path:doc.path,text,revision:doc.revision});
     doc=saved;docDraft=saved.text;docEditing=false;docDirty=false;docMessage='Saved '+saved.path;
     await loadDocs();
   }
   catch(e){
     if(e instanceof ApiError&&e.status===409){docConflict=true;docMessage='This document changed on disk. Your draft is still here.';}
     else docMessage=(e as Error).message;
   }
   finally{docSaving=false;}
 }
 async function createDoc(path:string){
   if(!project)return;
   const title=path.split('/').pop()?.replace(/\.mdx?$/i,'')??'Document';
   try{await api.saveDoc(project.id,{path,text:'# '+title+'\n\n'});await loadDocs();await openDoc(path);editDoc();}
   catch(e){docsError=(e as Error).message;}
 }
 function createDocPrompt(){const path=prompt('New document path','docs/');if(path&&path.trim())void createDoc(path.trim());}
</script>
<svelte:window onkeydown={keys} onclick={outside} onbeforeunload={(e)=>{if(saving||failed||inspectorDirty||docDirty){e.preventDefault();e.returnValue='';}}}/>
<div class="shell" bind:this={shell}>
 <ProjectSidebar {projects} selected={project?.id??''} hidden={sidebarHidden} onselect={select} onadd={()=>{if(leave())adding=true;}}/>
 <main class="workspace">
 <header class="appbar">
  <button class="icon-button sidebar-toggle" aria-label={sidebarHidden?'Show project sidebar':'Hide project sidebar'} aria-expanded={!sidebarHidden} aria-controls="project-sidebar" title="Toggle project sidebar (⌘/Ctrl B)" onclick={toggleSidebar}><Icon name="sidebar"/></button>
  <span class="appbar-divider"></span>
  <div class="workspace-identity"><span class="workspace-prefix">WORKSPACE /</span><h1>{project?.name??'Pilot'}</h1></div>
  {#if project}<span class="authority-badge" class:adopted={snapshot?.board.adoption==='adopted'} title={snapshot?.board.adoption==='adopted'?'Adopted task planning; original specs/evidence remain authoritative.':'Original documents remain authoritative. This board is a planning mirror.'}>{snapshot?.board.adoption==='adopted'?'Adopted board':'Planning mirror'}</span>{/if}
  <div class="appbar-end">
   <button class="icon-button" onclick={()=>theme=theme==='dark'?'light':'dark'} aria-label="Toggle theme" title="Toggle light / dark theme"><Icon name={theme==='dark'?'sun':'moon'}/></button>
   {#if project}
   <div class="popover actions-popover" bind:this={actionsMenu}>
    <button class="icon-button" aria-label="Board actions" title="Board actions" aria-expanded={actionsOpen} aria-controls="board-commands" onclick={()=>{actionsOpen=!actionsOpen;filtersOpen=false;}}><Icon name="more"/></button>
    <div id="board-commands" hidden={!actionsOpen} class="popover-panel action-list" role="group" aria-label="Board actions">
     <span class="popover-heading">BOARD COMMANDS</span>
     <button disabled={!snapshot||saving||failed||inspectorDirty} onclick={()=>command(()=>importing=true)}><Icon name="import"/>Import documents</button>
     <button disabled={!snapshot||saving||failed||inspectorDirty} onclick={()=>command(()=>settings=true)}><Icon name="settings"/>Areas & milestones</button>
     <button disabled={!snapshot} onclick={()=>command(exported)}><Icon name="export"/>Export board</button>
     <button disabled={saving} onclick={()=>command(()=>{void select(project!);})}><Icon name="refresh"/>Reload</button>
     {#if snapshot?.board.adoption==='mirror'}
     <div class="menu-separator"></div>
     <button disabled={saving||failed||inspectorDirty} onclick={()=>command(()=>{if(confirm('Adopt this board as the task-planning source? Original evidence/specs remain authoritative.'))void mutate({op:'adopt'});})}><Icon name="shield"/>Adopt board…</button>
     {/if}
     <div class="menu-separator"></div>
     <button class="danger-command" aria-label="Unregister project" onclick={()=>command(()=>{void remove();})}><Icon name="close"/>Unregister project…</button>
    </div>
   </div>
   {:else}<button class="small-button" aria-label="＋ Add project" onclick={()=>adding=true}><Icon name="plus"/>Add project</button>{/if}
   {#if project}
   <div class="popover" bind:this={inboxMenu}>
    <button class="icon-button" aria-label={inboxCount?'Needs me ('+inboxCount+')':'Needs me'} title="Open questions and missing specifications" aria-expanded={inboxOpen} onclick={()=>{inboxOpen=!inboxOpen;actionsOpen=false;filtersOpen=false;if(inboxOpen){void loadInbox();void loadDocs();}}}><Icon name="book"/> {#if inboxCount}<span class="inbox-count">{inboxCount}</span>{/if}</button>
    {#if inboxOpen}<QuestionInbox questions={inbox} agents={agentQuestions} {unlinked} {alertState} {alertBusy} {alertMessage} onopen={openQuestion} onanswer={()=>{inboxOpen=false;setView('Agents');}} onenable={()=>void enablePhoneAlerts()} ondisable={()=>void disablePhoneAlerts()} ontest={()=>void testPhoneAlert()} onclose={()=>inboxOpen=false}/>{/if}
   </div>
   {/if}
  </div>
 </header>
 {#if project}
 {#if error}<div class="error workspace-error" role="alert">{error}<div class="row">{#if failed}<button onclick={exported}>Export unsaved draft</button><button onclick={()=>select(project!)}>Reload & review</button>{:else if !snapshot}<button onclick={locate}>Locate folder</button>{#if missingBoard}<button onclick={initialize}>Confirm & initialize board</button>{/if}{/if}</div></div>{/if}
 <div class="commandbar">
  <div class="view-switch" aria-label="Board views">
   {#each ['Dependencies','Timeline','List','Wiki','Agents'] as mode}
   <button class:active={view===mode} aria-pressed={view===mode} aria-label={mode} title={mode} onclick={()=>setView(mode)}><Icon name={mode==='Dependencies'?'graph':mode==='Timeline'?'timeline':mode==='List'?'list':mode==='Wiki'?'book':'agent'} size={14}/><span class="view-label">{mode}</span></button>
   {/each}
  </div>
  {#if view!=='Wiki'&&view!=='Agents'}
  <span class="command-divider"></span>
  <label class="search task-search"><Icon name="search" size={14}/><input aria-label="Search tasks" placeholder="Search tasks" bind:value={search}></label>
  <div class="popover filters-popover" bind:this={filtersMenu}>
   <button class="compact-button" aria-label="Filters" aria-expanded={filtersOpen} aria-controls="task-filters" onclick={()=>{filtersOpen=!filtersOpen;actionsOpen=false;}}><Icon name="filters" size={14}/><span>Filters</span>{#if filterCount}<span class="filter-count">{filterCount}</span>{/if}</button>
   <div id="task-filters" hidden={!filtersOpen} class="popover-panel filter-panel" role="group" aria-label="Task filters">
    <div class="filter-heading"><span class="popover-heading">FILTER TASKS</span><button class="text-button" onclick={()=>{domain='all';status='all';scope='all';}}>Reset</button></div>
    <label>Area<select aria-label="Filter area" bind:value={domain}><option value="all">All areas</option>{#each snapshot?.board.domains??[] as d}<option value={d.id}>{d.name}</option>{/each}</select></label>
    <label>Status<select aria-label="Filter status" bind:value={status}><option value="all">All statuses</option>{#each ['todo','doing','done','blocked'] as state}<option value={state}>{state}</option>{/each}</select></label>
    <label>Scope<select aria-label="Filter scope" bind:value={scope}><option value="all">All work incl. history</option>{#each ['active','deferred','design-only','historical'] as s}<option value={s}>{s}</option>{/each}</select></label>
    <small>Hidden prerequisites still affect readiness.</small>
   </div>
  </div>
  <div class="commandbar-end">
   <div class="history-controls">
    <button class="icon-button" aria-label="Undo" title="Undo board change" disabled={!undoStack.length||saving||failed||inspectorDirty} onclick={undo}><Icon name="undo" size={15}/></button>
    <button class="icon-button" aria-label="Redo" title="Redo board change" disabled={!redoStack.length||saving||failed||inspectorDirty} onclick={redo}><Icon name="redo" size={15}/></button>
   </div>
   <button class="primary compact-button" aria-label="＋ Task" disabled={!snapshot||saving||failed||inspectorDirty} onclick={addTask}><Icon name="plus" size={15}/><span>Task</span></button>
  </div>
  {:else if view==='Wiki'}
  <span class="wiki-hint">Documentation is the source of work: write the intent, then link the work to it.</span>
  <div class="commandbar-end"><button class="compact-button wiki-tree-toggle" aria-label="Show documents" onclick={()=>treeOpen=true}><Icon name="book" size={14}/><span>Documents</span></button></div>
  {:else}
  <span class="wiki-hint">Scripted test provider: replies are deterministic and no model is called. Put [pause] in a message to hold the run open while you steer or stop it.</span>
  {/if}
 </div>
 <div class="view-area">
 {#if view==='Wiki'}
 <aside class="wiki-tree" class:open={treeOpen} id="wiki-tree">
  {#if docsError}<p class="error doc-message">{docsError}</p>{/if}
  <DocBrowser {docs} selected={doc?.path??''} projectId={project.id} onselect={(path)=>void openDoc(path)} oncreate={(path)=>void createDoc(path)} onclose={()=>treeOpen=false}/>
 </aside>
 <section class="wiki-doc">
  {#if docEditing&&doc}
  <DocEditor {doc} draft={docDraft} conflict={docConflict} saving={docSaving} message={docMessage} ondraft={(text)=>docDraft=text} onsave={(text)=>{docDirty=true;void saveDoc(text);}} oncancel={discardDoc} onreload={()=>void reloadDoc()}/>
  {:else if doc}
  <DocView {doc} projectId={project.id} {theme} {focusAnchor} onedit={editDoc} onopen={(path)=>void openDoc(path)}/>
  {:else}
  <div class="empty"><div class="empty-mark"><Icon name="book" size={36}/></div><span class="eyebrow">DOCUMENTATION</span><h2>Write the intent first.</h2><p>{docs.length?docs.length+' documents in this project. Choose one, or add a page for a spec, decision or open question.':'No Markdown documents yet. Create a spec page and let the work follow it.'}</p><button disabled={!project} onclick={createDocPrompt}>＋ New page</button></div>
  {/if}
 </section>
 {:else if view==='Agents'}
 <AgentsView projectId={project.id} onerror={(message)=>error=message} onquestions={()=>void loadInbox()}/>
 {:else}
 <div class="view-content">
 {#if loading}<div class="empty"><p>Loading board…</p></div>
 {:else if snapshot&&snapshot.board.tasks.length}
 {#if view==='Dependencies'}{#key project.id}<DependencyCanvas board={snapshot.board} {selected} {search} {domain} {status} {scope} {theme} projectId={project.id} disabled={saving||failed||inspectorDirty} onselect={choose} onoperation={mutate} onerror={(message)=>error=message}/>{/key}
 {:else if view==='Timeline'}<MilestoneTimeline board={snapshot.board} {selected} {search} {domain} {status} {scope} {theme} onselect={choose}/>
 {:else}<TaskList board={snapshot.board} {selected} {search} {domain} {status} {scope} docPaths={docPathSet} onselect={choose}/>{/if}
 {:else}<div class="empty"><div class="empty-mark"><Icon name="graph" size={36}/></div><span class="eyebrow">EMPTY WORKSPACE</span><h2>Start with the work.</h2><p>Add tasks or import planning documents to build your map.</p><div class="row"><button class="primary" disabled={!snapshot} onclick={addTask}>＋ Create a task</button><button disabled={!snapshot} onclick={()=>importing=true}>Import documents</button></div></div>{/if}
 </div>
 {#if snapshot&&selected&&snapshot.board.tasks.some(t=>t.id===selected)}<TaskInspector board={snapshot.board} id={selected} projectId={project.id} disabled={saving||failed} onclose={()=>choose('')} onoperation={mutate} ondirty={(dirty)=>inspectorDirty=dirty}/>{/if}
 {/if}
 </div>
 <footer class="statusbar">
 {#if view==='Wiki'}
  <span class="file-state">{doc?doc.path:'No document selected'} · {docs.length} documents</span>
  <span class="save-indicator" class:dirty={docConflict||docDirty} role="status">{docConflict?'Conflict':docDirty?'Unapplied edits':docMessage||'Saved'}</span>
 {:else if view==='Agents'}
  <span class="file-state">Agent harness · one durable SQLite session per project</span>
  <span class="save-indicator" role="status">Scripted provider</span>
 {:else}
  <span class="file-state">Persistent markdown · {snapshot?.board.tasks.length??0} tasks · {visible.length} matching</span>
  <div class="readiness-summary" title="Task checkpoints, not whole-project acceptance"><span><i class="indicator ready"></i>{ready} ready</span><span><i class="indicator doing"></i>{doing} in progress</span><span><i class="indicator waiting"></i>{waiting} waiting</span><span>{done} complete</span></div>
  <span class="save-indicator" class:dirty={failed||inspectorDirty} role="status">{inspectorDirty?'Unapplied edits':saveState}</span>
 {/if}
 </footer>
 {:else}<div class="empty"><div class="empty-mark"><Icon name="graph" size={36}/></div><span class="eyebrow">PROJECT CONTROL</span><h2>A workspace for the work.</h2><p>Dependencies, milestones and persistent Markdown. Add a project to start.</p><button class="primary" onclick={()=>adding=true}>＋ Add project</button>{#if error}<p role="alert" class="error">{error}</p>{/if}</div>{/if}
 </main>
</div>
{#if settings&&snapshot}<BoardSettings board={snapshot.board} onclose={()=>settings=false} onoperation={mutate}/>{/if}
{#if importing&&project}<ImportReview projectId={project.id} onclose={()=>importing=false} onapplied={imported}/>{/if}
{#if adding}<AddProjectDialog onclose={()=>adding=false} oncreated={created}/>{/if}
