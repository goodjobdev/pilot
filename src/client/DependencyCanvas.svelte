<script lang="ts">
 import { SvelteFlow,Controls,MiniMap,Background,MarkerType,type Node,type Edge,type Connection,type Viewport } from '@xyflow/svelte';
 import TaskNode from './TaskNode.svelte';
 import DependencyEdge from './DependencyEdge.svelte';
 import type { Board,Operation,Placement } from '../shared/model';
 import { arrange } from '../shared/layout';
 import { readiness,trace } from '../shared/graph';
 let {board,selected,search,domain,status,scope,theme,projectId,disabled,onselect,onoperation,onerror}:{board:Board;selected:string;search:string;domain:string;status:string;scope:string;theme:'dark'|'light';projectId:string;disabled:boolean;onselect:(id:string)=>void;onoperation:(op:Operation)=>Promise<void>;onerror:(message:string)=>void}=$props();
 let nodes=$state.raw<Node[]>([]),edges=$state.raw<Edge[]>([]),collapsed=$state(false),expanded=$state<string[]>([]),edgeKind=$state<'blocks'|'related'>('blocks');
 let viewport=$state<Viewport>({x:0,y:0,zoom:1});
 const nodeTypes={task:TaskNode};
 const edgeTypes={dependency:DependencyEdge};
 let initialized=false;
 $effect(()=>{if(!initialized&&board.tasks.length){collapsed=board.tasks.length>20;try{const v=JSON.parse(localStorage.getItem('dashboard.viewport.'+projectId)??'null');if(v&&Number.isFinite(v.x)&&Number.isFinite(v.y)&&v.zoom>=.1&&v.zoom<=2.5)viewport=v;}catch{/* defaults */}initialized=true;}});
 $effect(()=>{
   const visible=board.tasks.filter(t=>!t.archived&&(!search||t.title.toLowerCase().includes(search.toLowerCase()))&&(domain==='all'||t.domain===domain)&&(status==='all'||t.status===status)&&(scope==='all'||t.scope===scope));
   const ids=new Set(visible.map(t=>t.id));
   // Keep prerequisites as labeled context, even when excluded by a filter.
   let added=true;while(added){added=false;for(const e of board.relationships)if(e.kind==='blocks'&&ids.has(e.target)&&!ids.has(e.source)){ids.add(e.source);added=true;}}
   const chain=selected?trace(board,selected):new Set<string>(),positions=arrange(board),rendered:Node[]=[],mapping=new Map<string,string>();
   const groups=new Map<string,typeof board.tasks>();
   for(const t of board.tasks.filter(t=>ids.has(t.id)&&!t.archived)){
     if(collapsed&&!expanded.includes(t.domain)&&!chain.has(t.id)){const items=groups.get(t.domain)??[];items.push(t);groups.set(t.domain,items);mapping.set(t.id,'group:'+t.domain);continue;}
     mapping.set(t.id,t.id);const d=board.domains.find(d=>d.id===t.domain)!;
     rendered.push({id:t.id,type:'task',position:board.layout[t.id]??positions[t.id]??{x:0,y:0},selected:t.id===selected,draggable:!disabled,connectable:!disabled,data:{task:t,label:t.title,color:d.color,context:!visible.some(v=>v.id===t.id),focused:chain.has(t.id),readiness:readiness(board,t.id),milestone:board.milestones.find(m=>m.id===t.milestone)?.name,blockers:board.relationships.filter(e=>e.target===t.id&&e.kind==='blocks').length}});
   }
   for(const [id,tasks] of groups){const d=board.domains.find(d=>d.id===id)!;const at=board.domains.findIndex(d=>d.id===id);rendered.push({id:'group:'+id,type:'task',position:{x:180+(at%2)*350,y:Math.floor(at/2)*180+50},draggable:false,connectable:false,data:{label:d.name,color:d.color,group:true,count:tasks.length,done:tasks.filter(t=>t.status==='done').length,waiting:tasks.filter(t=>readiness(board,t.id)==='waiting').length}});}
   for(const d of board.domains){const tasks=rendered.filter(n=>(n.data.task as any)?.domain===d.id);if(tasks.length)rendered.push({id:'lane:'+d.id,type:'task',position:{x:Math.min(...tasks.map(n=>n.position.x))-175,y:Math.min(...tasks.map(n=>n.position.y))},draggable:false,selectable:false,connectable:false,data:{label:d.name,color:d.color,lane:true}});}
   const aggregate=new Map<string,Edge>();
   for(const e of board.relationships){const source=mapping.get(e.source),target=mapping.get(e.target);if(!source||!target||source===target)continue;const grouped=source.startsWith('group:')||target.startsWith('group:'),key=grouped?e.kind+':'+source+':'+target:e.id;
     const prior=aggregate.get(key);if(prior){prior.data!.count=Number(prior.data!.count)+1;prior.label=prior.data!.count+' links';continue;}
     const highlighted=chain.has(e.source)&&chain.has(e.target),color=e.kind==='related'?'#8999ae':highlighted?'#9bebc6':'#657b99';
     aggregate.set(key,{id:grouped?'aggregate:'+key:e.id,source,target,type:'dependency',label:grouped?'1':e.kind==='related'?'related':undefined,markerEnd:e.kind==='blocks'?{type:MarkerType.ArrowClosed,color}:undefined,style:'stroke:'+color+';stroke-width:'+(highlighted?2.4:1.5)+';opacity:'+(selected&&!highlighted ? .3 : 1)+(e.kind==='related'?';stroke-dasharray:5 5':''),data:{count:1,editable:!grouped&&!disabled}});
   }
   nodes=rendered;edges=[...aggregate.values()];
 });
 function choose(id:string){if(id.startsWith('group:')){expanded=[...expanded,id.slice(6)];return;}if(!id.startsWith('lane:'))onselect(id);}
 async function connect(c:Connection){try{await onoperation({op:'putEdge',edge:{id:crypto.randomUUID(),source:c.source,target:c.target,kind:edgeKind}});}catch(e){onerror((e as Error).message);}}
 async function drag(items:Node[]){const positions:Record<string,Placement>={};for(const n of items)if(board.tasks.some(t=>t.id===n.id))positions[n.id]={...n.position,pinned:true};if(Object.keys(positions).length)await onoperation({op:'layout',positions});}
 function saveViewport(value:Viewport){localStorage.setItem('dashboard.viewport.'+projectId,JSON.stringify(value));}
</script>
<div class="canvas-shell">
 <div class="canvas-tools row"><button onclick={()=>{collapsed=!collapsed;expanded=[];}}>{collapsed?'Expand all':'Collapse areas'}</button><button disabled={disabled} onclick={()=>onoperation({op:'layout',positions:arrange(board)})}>Arrange</button><button disabled={disabled} onclick={()=>{if(confirm('Reset manual positions and arrange all tasks?'))void onoperation({op:'layout',positions:arrange(board,false)});}}>Reset positions</button><label>New connector<select bind:value={edgeKind}><option value="blocks">Blocks →</option><option value="related">Related ┄</option></select></label></div>
 <SvelteFlow bind:nodes bind:edges bind:viewport {nodeTypes} {edgeTypes} fitView minZoom={0.1} maxZoom={2.5} onlyRenderVisibleElements nodesDraggable={!disabled} nodesConnectable={!disabled} deleteKey={null} colorMode={theme} onnodeclick={({node})=>choose(node.id)} onnodedragstop={({nodes})=>{void drag(nodes);}} onconnect={connect} onreconnect={(edge,connection)=>{const original=board.relationships.find(e=>e.id===edge.id);if(original)void onoperation({op:'putEdge',edge:{...original,source:connection.source,target:connection.target}});}} onedgeclick={({edge})=>{const original=board.relationships.find(e=>e.id===edge.id);if(original)onselect(original.target);}} onmoveend={(_,viewport)=>saveViewport(viewport)}>
 <Background gap={22} size={1}/><Controls/><MiniMap pannable zoomable style="width:144px;height:96px" maskColor="color-mix(in srgb,var(--bg) 65%,transparent)" bgColor="var(--panel)" nodeColor={(n)=>String(n.data.color??'#64748b')}/>
 </SvelteFlow>
 <div class="canvas-legend"><span>→ blocks</span><span>┄ related</span><span>Dashed cards: filtered prerequisites</span><span>Placement never changes task order</span></div>
</div>
<style>.canvas-shell{height:100%;position:relative;background:var(--bg)}.canvas-tools{position:absolute;top:10px;left:12px;z-index:5;gap:4px;padding:4px;background:var(--panel);border:1px solid var(--line);border-radius:5px;box-shadow:0 4px 16px #0002}.canvas-tools button{font-size:10px;padding:5px 7px;border-color:transparent;background:transparent}.canvas-tools button:hover{background:var(--raised)}.canvas-tools label{margin:0 4px;font:9px var(--mono);color:var(--muted)}.canvas-tools select{display:inline;width:auto;padding:4px;margin:0 0 0 5px;font-family:inherit}.canvas-legend{position:absolute;bottom:12px;left:58px;display:flex;gap:14px;color:var(--muted);font:8px var(--mono);background:var(--panel);padding:6px 8px;border:1px solid var(--line);border-radius:4px;pointer-events:none}:global(.svelte-flow__controls-button){background:var(--panel);color:var(--ink);border-color:var(--line)}:global(.svelte-flow__minimap){background:var(--panel);border:1px solid var(--line);border-radius:4px;overflow:hidden}@media(max-width:850px){.canvas-tools{max-width:calc(100% - 24px);flex-wrap:wrap}.canvas-legend{display:none}}</style>
