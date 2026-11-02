<script lang="ts">
 import { onMount,tick } from 'svelte';
 import ProjectSidebar from './ProjectSidebar.svelte';
 import AddProjectDialog from './AddProjectDialog.svelte';
 import ImportReview from './ImportReview.svelte';
 import DependencyCanvas from './DependencyCanvas.svelte';
 import MilestoneTimeline from './MilestoneTimeline.svelte';
 import TaskList from './TaskList.svelte';
 import TaskInspector from './TaskInspector.svelte';
 import BoardSettings from './BoardSettings.svelte';
 import AttentionPanel from './AttentionPanel.svelte';
 import { alertState as readAlertState, disableAlerts, enableAlerts, onAlertNavigation } from './push';
 import type { AlertState } from './push';
 import DocBrowser from './DocBrowser.svelte';
 import DocView from './DocView.svelte';
 import DocEditor from './DocEditor.svelte';
 import AgentsView from './AgentsView.svelte';
 import ActionPalette from './ActionPalette.svelte';
 import ProviderSettings from './ProviderSettings.svelte';
 import ProjectConnection from './ProjectConnection.svelte';
 import AgentManager from './AgentManager.svelte';
 import WorkersPanel from './WorkersPanel.svelte';
 import { api,session,ApiError,download,whenSessionExpires } from './api';
 import { HistoryStack,isHomeScreen,isView,narrowView,parseRoute,sameRoute,urlForRoute,type RouteSnapshot,type View } from './navigation';
 import { readSelectedSession,writeSelectedSession } from './drafts';
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
 let view=$state<View>(window.innerWidth<750?'List':'Dependencies'),search=$state(''),domain=$state('all'),status=$state('all'),scope=$state('all'),selected=$state('');
 // The selected named session ('' is the project's root conversation) and the session list. Both
 // are part of the route or its layers, so Back and Forward move through them like any other layer.
 let sessionId=$state(''),sessionListOpen=$state(false);
 let narrowProjects=$state(window.innerWidth<=650),narrowDocs=$state(window.innerWidth<=900);
 let booted=$state(false);
 let stack:HistoryStack|null=null;
 let saving=$state(false),saveState=$state('Saved'),failed=$state(false),inspectorDirty=$state(false),undoStack=$state<Board[]>([]),redoStack=$state<Board[]>([]);
 let theme=$state<'dark'|'light'>(localStorage.getItem('dashboard.theme')==='light'?'light':'dark');
 let sidebarHidden=$state(localStorage.getItem('dashboard.sidebar.hidden')==='true'||(localStorage.getItem('dashboard.sidebar.hidden')===null&&window.innerWidth<900));
 let actionsMenu=$state<HTMLDivElement>(),filtersMenu=$state<HTMLDivElement>();
 let docs=$state<DocEntry[]>([]),doc=$state<DocSnapshot|null>(null),docDraft=$state(''),docEditing=$state(false),docDirty=$state(false),docConflict=$state(false),docSaving=$state(false),docMessage=$state(''),docsError=$state(''),treeOpen=$state(false);
 // The document the route names while its read is still pending. The address and the history
 // entry use this path from the first frame, so a direct document link writes one entry, not two.
 let requestedDoc=$state<string|null>(null);
 let actionsOpen=$state(false),filtersOpen=$state(false),inboxOpen=$state(false),paletteOpen=$state(false);
 let inbox=$state<{path:string;line:number;text:string;anchor:string|null;id:string}[]>([]),focusAnchor=$state<string|null>(null),inboxMenu=$state<HTMLDivElement>();
 let attentionCount=$state<number|null>(null),attentionCountComplete=$state(false),attentionChecked=$state(false),inboxRefresh=$state(0),attentionFocus=$state<string|null>(null),questionFocus=$state('');
 let alertState=$state<AlertState>('off'),alertBusy=$state(false),alertMessage=$state('');
 let sessionExpired=$state(false),providersOpen=$state(false),workersOpen=$state(false),connectionOpen=$state(false),agentManagerOpen=$state(false),agentsVersion=$state(0);
 let docPathSet=$derived(new Set(docs.map(d=>d.path)));
 let shell=$state<HTMLDivElement>();
 let unlinked=$derived(snapshot?snapshot.board.tasks.filter(t=>t.scope==='active'&&!t.archived&&specState(t,docPathSet)==='unlinked').length:0);
 let inboxCount=$derived(attentionChecked&&attentionCountComplete&&attentionCount!==null?inbox.length+attentionCount:null);
 let filterCount=$derived(Number(domain!=='all')+Number(status!=='all')+Number(scope!=='all'));
 let ready=$derived(snapshot?.board.tasks.filter(t=>readiness(snapshot!.board,t.id)==='ready').length??0);
 let waiting=$derived(snapshot?.board.tasks.filter(t=>readiness(snapshot!.board,t.id)==='waiting').length??0);
 let doing=$derived(snapshot?.board.tasks.filter(t=>t.status==='doing').length??0);
 let done=$derived(snapshot?.board.tasks.filter(t=>t.status==='done').length??0);
 let visible=$derived(snapshot?.board.tasks.filter(t=>!t.archived&&(!search||t.title.toLowerCase().includes(search.toLowerCase()))&&(domain==='all'||t.domain===domain)&&(status==='all'||t.status===status)&&(scope==='all'||t.scope===scope))??[]);

 /*
  * The layers above the route, oldest first. A layer key is all history stores: the application
  * owns what it means. The order puts a drawer under a panel, a panel under a menu, a menu under
  * a dialog and the palette on top, which is the order these can really be open in.
  */
 const LAYER_ORDER=['drawer:projects','drawer:docs','panel:inbox','menu:actions','menu:filters','panel:sessions','dialog:settings','dialog:import','dialog:add','dialog:providers','dialog:agentManager','dialog:workers','dialog:connection','dialog:palette'] as const;
 const VIEW_MODES:View[]=['Dependencies','Timeline','List','Wiki','Agents'];
 function currentLayers():string[]{
   const open:Record<string,boolean>={
     'drawer:projects':!sidebarHidden&&narrowProjects,
     'drawer:docs':treeOpen&&narrowDocs,
     'panel:inbox':inboxOpen,
     'menu:actions':actionsOpen,
     'menu:filters':filtersOpen,
     'panel:sessions':sessionListOpen,
     'dialog:settings':settings,
     'dialog:import':importing,
     'dialog:add':adding,
     'dialog:providers':providersOpen,
     'dialog:agentManager':agentManagerOpen,
     'dialog:workers':workersOpen,
     'dialog:connection':connectionOpen,
     'dialog:palette':paletteOpen,
   };
   return LAYER_ORDER.filter(key=>open[key]);
 }
 /** A route as history stores it. Layer contents are not part of the address. */
 function routeSnapshot():RouteSnapshot{
   return {project:project?.id??null,view,doc:requestedDoc??doc?.path??null,session:sessionId,layers:currentLayers()};
 }
 function setLayer(key:string,open:boolean):void{
   switch(key){
     case 'drawer:projects': sidebarHidden=!open;if(open&&narrowDocs)treeOpen=false;break;
     case 'drawer:docs': treeOpen=open;break;
     case 'panel:inbox': inboxOpen=open;break;
     case 'menu:actions': actionsOpen=open;break;
     case 'menu:filters': filtersOpen=open;break;
     case 'panel:sessions': sessionListOpen=open;break;
     case 'dialog:settings': if(open&&!snapshot)return;settings=open;break;
     case 'dialog:import': if(open&&!project)return;importing=open;break;
     case 'dialog:add': adding=open;break;
     case 'dialog:providers': providersOpen=open;break;
     case 'dialog:agentManager': agentManagerOpen=open;break;
     case 'dialog:workers': if(open&&!project)return;workersOpen=open;break;
     case 'dialog:connection': if(open&&!project)return;connectionOpen=open;break;
     case 'dialog:palette': paletteOpen=open;break;
   }
 }
 /** Close the layers the target does not name, then open the ones it adds, in order. */
 function applyLayers(target:string[]):void{
   for(const key of [...currentLayers()].reverse())if(!target.includes(key))setLayer(key,false);
   for(const key of target)if(!currentLayers().includes(key))setLayer(key,true);
 }
 /** Unsaved document text: an edit not yet saved, or a save the server has not accepted. */
 function docUnsaved():boolean{return Boolean(doc)&&(docDirty||(docEditing&&docDraft!==doc!.text));}
 function storedSession(id:string):string{
   const stored=readSelectedSession(typeof localStorage==='undefined'?null:localStorage,id);
   return stored.status==='selected'?stored.sessionId:'';
 }

 $effect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('dashboard.theme',theme);});
 $effect(()=>{if(project)localStorage.setItem('dashboard.filters.'+project.id,JSON.stringify({search,domain,status,scope,view}));});
 $effect(()=>{try{localStorage.setItem('dashboard.sidebar.hidden',String(sidebarHidden));}catch{/* UI preference is optional */}});
 // The narrow-screen project drawer starts below the header stack so it never covers
 // the command bar. The offset is measured because the header wraps on small screens.
 $effect(()=>{ void view; void project; void error; measureHeader(); });
 // Follow the application state with history. Reading the snapshot here is what subscribes the
 // effect to the route and the layer flags; no state change writes history by itself.
 $effect(()=>{const next=routeSnapshot();if(!booted||!stack)return;stack.sync(next);});
 function measureHeader(){
   const area=(shell?.querySelector('.view-area')??null) as HTMLElement|null;
   const top=area?Math.round(area.getBoundingClientRect().top):0;
   document.documentElement.style.setProperty('--header-h',(top>0?top:42)+'px');
 }
 onMount(()=>{const onResize=()=>measureHeader();window.addEventListener('resize',onResize);return()=>window.removeEventListener('resize',onResize);});
 onMount(()=>{
   // The two narrow layouts have their own drawers: the project rail below 650px and the document
   // tree below 900px. Reading them from a media query keeps the layer list right after a rotation.
   const projectQuery=matchMedia('(max-width:650px)'),docsQuery=matchMedia('(max-width:900px)');
   const onMedia=()=>{narrowProjects=projectQuery.matches;narrowDocs=docsQuery.matches;if(!docsQuery.matches)treeOpen=false;};
   onMedia();
   projectQuery.addEventListener('change',onMedia);
   docsQuery.addEventListener('change',onMedia);
   // One stack owns history for the whole application. The application state is the truth.
   stack=new HistoryStack({
     history:window.history,
     snapshot:routeSnapshot,
     apply:applyRoute,
     canLeave:canLeaveRoute,
     urlFor:(snapshot)=>urlForRoute(snapshot,location.pathname),
   });
   const onPop=(event:PopStateEvent)=>stack?.onPop(event.state);
   window.addEventListener('popstate',onPop);
   // Any request that meets the sign-in layer instead of the application reports here, and a
   // periodic probe warns before a form is filled in rather than after it fails.
   whenSessionExpires(()=>{sessionExpired=true;});
   const probe=setInterval(()=>{if(document.visibilityState==='visible')void checkSession();},300000);
   const onVisible=()=>{if(document.visibilityState==='visible')void checkSession();};
   document.addEventListener('visibilitychange',onVisible);
   void boot();
   const stopAlerts=onAlertNavigation(url=>void followAlert(url));
   return ()=>{clearInterval(probe);document.removeEventListener('visibilitychange',onVisible);stopAlerts();window.removeEventListener('popstate',onPop);projectQuery.removeEventListener('change',onMedia);docsQuery.removeEventListener('change',onMedia);};
 });
 async function checkSession(){
   try{await session();sessionExpired=false;}
   catch(e){if(e instanceof ApiError&&e.kind==='session')sessionExpired=true;}
 }
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
 /** Apply one history entry. It must leave the application showing exactly this route. */
 async function applyRoute(target:RouteSnapshot){
   // Flush a pending draft write before a session or view can unmount its composer.
   window.dispatchEvent(new Event('pilot:navigate'));
   // A layer the person opens while this apply is waiting is their intent, not part of the entry
   // being applied. Keep it after the route settles instead of closing it with the target's list.
   const layersAtStart=currentLayers();
   const p=target.project?projects.find(candidate=>candidate.id===target.project)??null:null;
   if(target.project&&!p){error='That project is no longer registered.';applyLayers([]);return;}
   if(p&&p.id!==project?.id){
     await select(p,{view:target.view,doc:target.doc,session:target.session,confirmed:true,fromRoute:true});
   }else if(p){
     if(target.view!==view)setView(target.view,{fromRoute:true});
     if(target.view==='Wiki'){
       if(target.doc&&target.doc!==(requestedDoc??doc?.path??null))await openDoc(target.doc,{force:true});
       else if(!target.doc&&(doc||requestedDoc))clearDoc();
     }else if(!target.doc&&(doc||requestedDoc)){
       // A direct link to a board view carries no document; do not keep one from the view just left.
       clearDoc();
     }
     sessionId=target.session;
   }else{
     // The route names no project: show the project control state rather than staying on the
     // project this page happened to show a moment ago.
     project=null;snapshot=null;loading=false;selected='';docs=[];docsError='';clearDoc();
     if(target.view!==view)setView(target.view,{fromRoute:true});
     sessionId=target.session;
   }
   // A layer opened during the apply is intent to keep. A layer closed during the apply is intent
   // to keep closed, even when the entry being applied names it. The reconciliation is symmetric.
   const now=currentLayers();
   const opened=now.filter(key=>!layersAtStart.includes(key));
   const closed=layersAtStart.filter(key=>!now.includes(key));
   applyLayers([
     ...target.layers.filter(key=>!closed.includes(key)),
     ...opened.filter(key=>!target.layers.includes(key)&&!closed.includes(key)),
   ]);
 }
 /** Refuse a traversal that would throw away text the person has not saved. */
 function canLeaveRoute(current:RouteSnapshot,target:RouteSnapshot):boolean{
   if(sameRoute(current,target))return true;
   if(docUnsaved()&&(target.project!==current.project||target.doc!==current.doc))return confirm('Discard unsaved document edits?');
   if(inspectorDirty&&(target.project!==current.project||target.view!==current.view))return confirm('Discard unapplied task edits? Export the task draft first if needed.');
   if((saving||failed)&&target.project!==current.project)return confirm('A board save is pending or conflicted. Export the draft before leaving. Discard these edits?');
   return true;
 }
 /** The application's selected session changed (a person chose one, or fell back). */
 function sessionChanged(id:string):void{
   sessionId=id;sessionListOpen=false;questionFocus='';
   if(project)writeSelectedSession(localStorage,project.id,id||null);
 }
 /** A direct session link named a session this project does not have: root, with its list open. */
 function sessionUnavailable():void{
   sessionId='';
   stack?.replaceCurrent(routeSnapshot());
 }
 /** An alert tap names the project and the view that needs attention, in one history step. */
 async function followAlert(url:string){
   try{
     const params=new URL(url,location.origin).searchParams;
     const projectId=params.get('project');
     const requested=params.get('view');
     const requestedSession=params.get('session');
     const attention=params.get('attention');
     const target=isView(requested)?requested:null;
     const found=projectId?projects.find(candidate=>candidate.id===projectId):undefined;
     if(projectId&&!found){
       error='The project in this notification is not registered. Nothing was opened.';
       return;
     }
     const current=routeSnapshot();
     const next:RouteSnapshot={...current,project:found?.id??current.project,view:target??current.view,session:requestedSession??current.session,layers:[]};
     // A notification is not a reason to throw away unsaved text. A refusal changes nothing.
     if(!canLeaveRoute(current,next))return;
     if(found&&found.id!==project?.id)await select(found,{view:target??undefined,session:requestedSession??undefined,confirmed:true});
     else{
       if(target)setView(target);
       if(requestedSession!==null)sessionId=requestedSession;
     }
     openAttentionDeepLink(attention);
     error='';
   }catch{/* a malformed alert link is ignored */}
 }
 function command(action:()=>void){actionsOpen=false;action();}
 function outside(e:MouseEvent){if(!(e.target instanceof Node))return;if(actionsOpen&&!actionsMenu?.contains(e.target))actionsOpen=false;if(filtersOpen&&!filtersMenu?.contains(e.target))filtersOpen=false;if(inboxOpen&&!inboxMenu?.contains(e.target))inboxOpen=false;}
 function keys(e:KeyboardEvent){
   if(e.key==='Escape'){if(paletteOpen){paletteOpen=false;e.preventDefault();return;}if(actionsOpen){actionsOpen=false;actionsMenu?.querySelector('button')?.focus();e.preventDefault();}if(filtersOpen){filtersOpen=false;filtersMenu?.querySelector('button')?.focus();e.preventDefault();}if(inboxOpen){inboxOpen=false;inboxMenu?.querySelector('button')?.focus();e.preventDefault();}return;}
   // The command palette (⌘/Ctrl K). While a text field or an editor has focus the shortcut is not
   // swallowed, exactly like the sidebar toggle above: typing a document must never open a dialog.
   if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='k'){
     if(paletteOpen){paletteOpen=false;e.preventDefault();return;}
     if(e.target instanceof Element&&e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
     e.preventDefault();paletteOpen=true;return;
   }
   if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='b'&&!(e.target instanceof Element&&e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))){e.preventDefault();toggleSidebar();}
 }
 function leave(){return !(saving||failed||inspectorDirty||docUnsaved())||confirm('There are unsaved edits. Export your draft before leaving. Discard these edits?');}
 interface SelectOptions {view?:View;doc?:string|null;session?:string|null;confirmed?:boolean;fromRoute?:boolean}
 async function boot(){
   try{
     await session();
     projects=await api.projects();
     const link=parseRoute(location.search);
     const deepAttention=new URLSearchParams(location.search).get('attention');
     const remembered=localStorage.getItem('dashboard.project');
     const named=link.project?projects.find(candidate=>candidate.id===link.project):undefined;
     // A project named by the address must exist. A silent fallback could send an edit to the wrong
     // project, so an unknown one shows an error and selects nothing; the person chooses instead.
     if(link.project&&!named){
       view=narrowView(link.view??(window.innerWidth<750?'List':'Dependencies'),window.innerWidth<750);
       error='The project in this link is not registered. Choose a project from the sidebar.';
     }else{
       const p=named??projects.find(candidate=>candidate.id===remembered)??projects[0];
       if(p)await select(p,{view:link.view??undefined,doc:link.doc,session:link.session??undefined,confirmed:true});
       else view=narrowView(link.view??(window.innerWidth<750?'List':'Dependencies'),window.innerWidth<750);
       openAttentionDeepLink(deepAttention);
     }
   }catch(e){error=(e as Error).message;}
   finally{
     // Write the resolved route once, in place. Nothing before this point is a navigation.
     booted=true;
     stack?.start({homeScreen:isHomeScreen()});
   }
 }
 async function select(p:Project,opts:SelectOptions={}){
   if(!opts.confirmed&&!leave())return;project=p;snapshot=null;error='';missingBoard=false;loading=true;selected='';failed=false;inspectorDirty=false;saveState='Saved';undoStack=[];redoStack=[];doc=null;docDraft='';docEditing=false;docDirty=false;docConflict=false;docMessage='';docsError='';docs=[];requestedDoc=null;inbox=[];attentionCount=null;attentionCountComplete=false;attentionChecked=false;attentionFocus=null;questionFocus='';inboxRefresh+=1;if(!opts.fromRoute){treeOpen=false;sessionListOpen=false;}localStorage.setItem('dashboard.project',p.id);
   let remembered:View|undefined;
   try{const filters=JSON.parse(localStorage.getItem('dashboard.filters.'+p.id)??'null');if(filters){search=filters.search??'';domain=filters.domain??'all';status=filters.status??'all';scope=filters.scope??'all';if(isView(filters.view))remembered=filters.view;}else{search='';domain='all';status='all';scope='all';}}catch{/* defaults */}
   const narrow=window.innerWidth<750;
   view=opts.view?narrowView(opts.view,narrow):(narrow?'List':remembered??'Dependencies');
   // Name the requested document before the read, so the route and the address carry it at once.
   requestedDoc=view==='Wiki'?(opts.doc??null):null;
   sessionId=opts.session??storedSession(p.id);
   try{const v=await api.board(p.id);if(project?.id===p.id)snapshot=v;}catch(e){if(project?.id===p.id){error=(e as Error).message;missingBoard=e instanceof ApiError&&e.status===404;}}finally{loading=false;void loadDocs();void loadInbox();}
   if(view==='Wiki'&&opts.doc)void openDoc(opts.doc,{force:true});
 }
 async function created(p:Project){adding=false;projects=await api.projects();await select(p);if(p.repository)connectionOpen=true;}
 async function connected(){const id=project?.id;projects=await api.projects();const p=projects.find(p=>p.id===id);if(p)await select(p);}
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
 /** Pick up board changes made by the agent or another client without overwriting local edits. */
 async function refreshBoard(){
   if(!project||!snapshot||saving||failed||inspectorDirty)return;
   const id=project.id,revision=snapshot.revision;
   try{
     const fresh=await api.board(id);
     if(project?.id!==id||saving||failed||inspectorDirty||snapshot?.revision!==revision)return;
     if(fresh.revision!==revision){
       snapshot=fresh;undoStack=[];redoStack=[];saveState='Saved';
       if(selected&&!fresh.board.tasks.some(task=>task.id===selected))selected='';
     }
   }catch(e){if(project?.id===id&&!saving&&!failed)error=(e as Error).message;}
 }
 function setView(mode:View,opts:{fromRoute?:boolean;openTree?:boolean}={}){
   view=mode;
   if(mode==='Dependencies'||mode==='Timeline'||mode==='List')void refreshBoard();
   sessionListOpen=false;
   if(mode==='Wiki'){
     if(project)void loadDocs();
     // One drawer at a time: on a narrow screen the document tree takes the place of the project drawer.
     // The tree is a layer of its own, so it opens after the view's entry exists. Opening both in
     // one update would write one entry for two layers, and Back would skip the view.
     if(narrowDocs){
       sidebarHidden=true;
       if(!opts.fromRoute&&opts.openTree!==false)void tick().then(()=>{if(view==='Wiki'&&narrowDocs)treeOpen=true;});
     }
   }else{
     treeOpen=false;
   }
 }
 function toggleSidebar(){
   sidebarHidden=!sidebarHidden;
   if(!sidebarHidden&&narrowDocs)treeOpen=false;
 }
 async function loadDocs(){
   if(!project)return;
   try{docsError='';docs=(await api.docs(project.id)).documents;}
   catch(e){docsError=(e as Error).message;docs=[];}
 }
 /** The documentation questions of the project, and the count of the attention projection. */
 async function loadDocInbox(){
   if(!project)return;
   // A response for the project this page has since left is discarded, so a switch cannot show one
   // project's count for another.
   const id=project.id;
   try{const loaded=(await api.inbox(id)).questions;if(project?.id===id)inbox=loaded;}catch{if(project?.id===id)inbox=[];}
 }
 async function loadAttentionCount(){
   if(!project)return;
   const id=project.id;
   // An incomplete count is not an exact zero. The badge shows that state instead of hiding work.
   try{
     const loaded=(await api.attentionCount(id)).count;
     if(project?.id===id){attentionCount=loaded.open;attentionCountComplete=loaded.complete;attentionChecked=true;}
   }catch{
     if(project?.id===id){attentionCount=null;attentionCountComplete=false;attentionChecked=true;}
   }
 }
 async function loadInbox(){await Promise.all([loadDocInbox(),loadAttentionCount()]);}
 /**
  * A push or deep link names one exact attention item. A question opens its session and the answer
  * UI; every other kind opens the attention layer with the item focused. The address value is
  * validated before it is used and is never echoed into the interface.
  */
 function openAttentionDeepLink(value:string|null|undefined){
   if(!value)return;
   const separator=value.indexOf(':');
   if(separator<1)return;
   const kind=value.slice(0,separator),identity=value.slice(separator+1);
   if(!['question','approval','failure','interrupted'].includes(kind))return;
   if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(identity))return;
   if(kind==='question'){
     questionFocus=identity;attentionFocus=null;inboxOpen=false;
     return;
   }
   attentionFocus=value;inboxRefresh+=1;inboxOpen=true;
 }
 function openQuestion(path:string,anchor:string|null){
   inboxOpen=false;focusAnchor=anchor;
   if(view!=='Wiki')setView('Wiki',{openTree:false});
   void openDoc(path);
 }
 async function openDoc(path:string,opts:{force?:boolean}={}){
   if(!project)return;
   if(!opts.force&&docUnsaved()&&!confirm('Discard unsaved document edits?'))return;
   requestedDoc=path;
   try{docsError='';const loaded=await api.doc(project.id,path);doc=loaded;docDraft=loaded.text;docEditing=false;docDirty=false;docConflict=false;docMessage='';treeOpen=false;requestedDoc=null;}
   catch(e){docsError=(e as Error).message;/* the address keeps the requested path, and the error says why */}
 }
 function clearDoc(){doc=null;requestedDoc=null;docDraft='';docEditing=false;docDirty=false;docConflict=false;docMessage='';focusAnchor=null;}
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
<svelte:window onkeydown={keys} onclick={outside} onbeforeunload={(e)=>{if(saving||failed||inspectorDirty||docUnsaved()){e.preventDefault();e.returnValue='';}}}/>
<div class="shell" bind:this={shell}>
 <ProjectSidebar {projects} selected={project?.id??''} hidden={sidebarHidden} ready={booted} onselect={select} onadd={()=>{if(leave())adding=true;}}/>
 <main class="workspace">
 <header class="appbar">
  <button class="icon-button sidebar-toggle" aria-label={sidebarHidden?'Show project sidebar':'Hide project sidebar'} aria-expanded={!sidebarHidden} aria-controls="project-sidebar" title="Toggle project sidebar (⌘/Ctrl B)" onclick={toggleSidebar}><Icon name="sidebar"/></button>
  <span class="appbar-divider"></span>
  <div class="workspace-identity"><span class="workspace-prefix">WORKSPACE /</span><h1>{project?.name??'Pilot'}</h1></div>
  <div class="appbar-end">
   <button class="icon-button" aria-label="Agents and privileges" title="Agents &amp; privileges" onclick={()=>agentManagerOpen=true}><Icon name="agent"/></button>
   <button class="icon-button" aria-label="Workers" title="Bounded workers" disabled={!project} onclick={()=>workersOpen=true}><Icon name="graph"/></button>
   <button class="icon-button" aria-label="Providers & models" title="Providers & models" onclick={()=>providersOpen=true}><Icon name="settings"/></button>
   <button class="icon-button" onclick={()=>theme=theme==='dark'?'light':'dark'} aria-label="Toggle theme" title="Toggle light / dark theme"><Icon name={theme==='dark'?'sun':'moon'}/></button>
   {#if project}
   <div class="popover actions-popover" bind:this={actionsMenu}>
    <button class="icon-button" aria-label="Board actions" title="Board actions" aria-expanded={actionsOpen} aria-controls="board-commands" onclick={()=>{actionsOpen=!actionsOpen;filtersOpen=false;}}><Icon name="more"/></button>
    <div id="board-commands" hidden={!actionsOpen} class="popover-panel action-list" role="group" aria-label="Board actions">
     <span class="popover-heading">PROJECT & BOARD</span>
     <button onclick={()=>command(()=>connectionOpen=true)}><Icon name="shield"/>Repository & deploy key</button>
     <button disabled={!snapshot||saving||failed||inspectorDirty} onclick={()=>command(()=>importing=true)}><Icon name="import"/>Import documents</button>
     <button disabled={!snapshot||saving||failed||inspectorDirty} onclick={()=>command(()=>settings=true)}><Icon name="settings"/>Areas & milestones</button>
     <button disabled={!snapshot} onclick={()=>command(exported)}><Icon name="export"/>Export board</button>
     <button aria-label="Commands" onclick={()=>command(()=>{paletteOpen=true;})}><Icon name="more"/>Commands… <small style="margin-left:auto;color:var(--muted)">⌘/Ctrl K</small></button>
     <button disabled={saving} onclick={()=>command(()=>{void select(project!);})}><Icon name="refresh"/>Reload</button>
     {#if snapshot?.board.adoption==='mirror'}
     <div class="menu-separator"></div>
     <button disabled={saving||failed||inspectorDirty} onclick={()=>command(()=>{if(confirm('Adopt this board as the task-planning source? Original evidence/specs remain authoritative.'))void mutate({op:'adopt'});})}><Icon name="shield"/>Adopt board…</button>
     {/if}
     <div class="menu-separator"></div>
     <button class="danger-command" aria-label="Unregister project" onclick={()=>command(()=>{void remove();})}><Icon name="close"/>Unregister project…</button>
    </div>
   </div>
   {:else}<button class="small-button" aria-label="＋ Add project" disabled={!booted} onclick={()=>adding=true}><Icon name="plus"/>Add project</button>{/if}
   {#if project}
   <div class="popover" bind:this={inboxMenu}>
    <button class="icon-button" aria-label={inboxCount===null?'Needs me (count incomplete)':inboxCount?'Needs me ('+inboxCount+')':'Needs me'} title={inboxCount===null?'Open questions and missing specifications. The attention count is incomplete because a source is unavailable.':'Open questions and missing specifications'} aria-expanded={inboxOpen} onclick={()=>{inboxOpen=!inboxOpen;actionsOpen=false;filtersOpen=false;if(inboxOpen){attentionFocus=null;void loadDocInbox();void loadDocs();}else{attentionFocus=null;}}}><Icon name="book"/> {#if inboxCount}<span class="inbox-count">{inboxCount}</span>{:else if attentionChecked&&!attentionCountComplete}<span class="inbox-count" aria-hidden="true">?</span>{/if}</button>
    {#if inboxOpen}{#key project.id}<AttentionPanel projectId={project.id} questions={inbox} {unlinked} {alertState} {alertBusy} {alertMessage} refreshKey={inboxRefresh} focusId={attentionFocus} onopen={openQuestion} onopenquestion={(session,questionId)=>{inboxOpen=false;attentionFocus=null;questionFocus=questionId;setView('Agents');sessionId=session??'';if(project)writeSelectedSession(localStorage,project.id,session??'');}} oncount={(loaded)=>{attentionCount=loaded.open;attentionCountComplete=loaded.complete;attentionChecked=true;}} onchanged={()=>{void loadDocInbox();}} onenable={()=>void enablePhoneAlerts()} ondisable={()=>void disablePhoneAlerts()} ontest={()=>void testPhoneAlert()} onclose={()=>{inboxOpen=false;attentionFocus=null;}}/>{/key}{/if}
   </div>
   {/if}
  </div>
 </header>
 {#if sessionExpired}
 <div class="error workspace-error" role="alert">Your sign-in has expired. Reload to sign in again; nothing you saved has been lost.<div class="row"><button class="primary" onclick={()=>location.reload()}>Reload and sign in</button></div></div>
 {/if}
 {#if project}
 {#if error}<div class="error workspace-error" role="alert">{error}<div class="row">{#if failed}<button onclick={exported}>Export unsaved draft</button><button onclick={()=>select(project!)}>Reload & review</button>{:else if !snapshot}<button onclick={locate}>Locate folder</button>{#if missingBoard}<button onclick={initialize}>Confirm & initialize board</button>{/if}{/if}</div></div>{/if}
 <div class="commandbar">
  <div class="view-switch" aria-label="Board views">
   {#each VIEW_MODES as mode}
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
  {/if}
 </div>
 <div class="view-area">
 {#if view==='Wiki'}
 <aside class="wiki-tree" class:open={treeOpen} id="wiki-tree">
  {#if docsError}<p class="error doc-message" role="alert">{docsError}</p>{/if}
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
 <AgentsView projectId={project.id} {agentsVersion} sessionId={sessionId} onsessionchange={sessionChanged} sessionListOpen={sessionListOpen} onsessionlistchange={(open)=>sessionListOpen=open} onmissing={sessionUnavailable} onerror={(message)=>error=message} focusQuestion={questionFocus} onquestions={()=>{void loadInbox();inboxRefresh+=1;}}/>
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
 {#if view!=='Agents'}
 <footer class="statusbar">
 {#if view==='Wiki'}
  <span class="file-state">{doc?doc.path:'No document selected'} · {docs.length} documents</span>
  <span class="save-indicator" class:dirty={docConflict||docDirty} role="status">{docConflict?'Conflict':docDirty?'Unapplied edits':docMessage||'Saved'}</span>
 {:else}
  <span class="file-state">Persistent markdown · {snapshot?.board.tasks.length??0} tasks · {visible.length} matching</span>
  <div class="readiness-summary" title="Task checkpoints, not whole-project acceptance"><span><i class="indicator ready"></i>{ready} ready</span><span><i class="indicator doing"></i>{doing} in progress</span><span><i class="indicator waiting"></i>{waiting} waiting</span><span>{done} complete</span></div>
  <span class="save-indicator" class:dirty={failed||inspectorDirty} role="status">{inspectorDirty?'Unapplied edits':saveState}</span>
 {/if}
 </footer>
 {/if}
 {:else if !booted}<div class="empty" role="status"><p>Opening Pilot…</p></div>
 {:else}<div class="empty"><div class="empty-mark"><Icon name="graph" size={36}/></div><span class="eyebrow">PROJECT CONTROL</span><h2>A workspace for the work.</h2><p>Dependencies, milestones and persistent Markdown. Add a project to start.</p><button class="primary" disabled={!booted} onclick={()=>adding=true}>＋ Add project</button>{#if error}<p role="alert" class="error">{error}</p>{/if}</div>{/if}
 </main>
</div>
{#if settings&&snapshot}<BoardSettings board={snapshot.board} onclose={()=>settings=false} onoperation={mutate}/>{/if}
{#if importing&&project}<ImportReview projectId={project.id} onclose={()=>importing=false} onapplied={imported}/>{/if}
{#if adding}<AddProjectDialog onclose={()=>adding=false} oncreated={created}/>{/if}
{#if providersOpen}<ProviderSettings onclose={()=>providersOpen=false}/>{/if}
{#if agentManagerOpen}<AgentManager onclose={()=>agentManagerOpen=false} onchanged={()=>{agentsVersion+=1;const id=project?.id;if(id)void loadInbox();}}/>{/if}
{#if workersOpen&&project}<WorkersPanel projectId={project.id} onclose={()=>workersOpen=false}/>{/if}
{#if connectionOpen&&project}<ProjectConnection {project} onclose={()=>connectionOpen=false} onconnected={()=>void connected()}/>{/if}
{#if paletteOpen}<ActionPalette projectId={project?.id??null} onclose={()=>paletteOpen=false}/>{/if}
