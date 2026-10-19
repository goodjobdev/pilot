<script lang="ts">
 import {SvelteFlow,Controls,MiniMap,Background,MarkerType,type Node,type Edge} from '@xyflow/svelte';
 import TaskNode from './TaskNode.svelte';
 import type {Board} from '../shared/model';
 import {readiness,trace} from '../shared/graph';
 let {board,selected,search,domain,status,scope,theme,onselect}:{board:Board;selected:string;search:string;domain:string;status:string;scope:string;theme:'dark'|'light';onselect:(id:string)=>void}=$props();
 let nodes=$state.raw<Node[]>([]),edges=$state.raw<Edge[]>([]),expanded=$state<string[]>([]);
 const nodeTypes={task:TaskNode};
 $effect(()=>{
   const milestones=[...board.milestones].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)),columns=[...milestones.map(m=>({id:m.id,name:m.name})),{id:null,name:'Independent / unassigned'}];
   const visible=board.tasks.filter(t=>!t.archived&&(!search||t.title.toLowerCase().includes(search.toLowerCase()))&&(domain==='all'||t.domain===domain)&&(status==='all'||t.status===status)&&(scope==='all'||t.scope===scope));
   const ids=new Set(visible.map(t=>t.id));let added=true;while(added){added=false;for(const e of board.relationships)if(e.kind==='blocks'&&ids.has(e.target)&&!ids.has(e.source)){ids.add(e.source);added=true;}}
   const chain=selected?trace(board,selected):new Set<string>(),rendered:Node[]=[],map=new Map<string,string>();let top=100;
   columns.forEach((m,i)=>rendered.push({id:'column:'+i,type:'task',position:{x:i*340+180,y:15},draggable:false,selectable:false,connectable:false,data:{label:m.name,color:'#a1adbf',lane:true}}));
   for(const d of board.domains){let rows=1;
     for(let ci=0;ci<columns.length;ci++){
       const col=columns[ci],items=board.tasks.filter(t=>ids.has(t.id)&&!t.archived&&t.domain===d.id&&t.milestone===col.id).sort((a,b)=>a.id.localeCompare(b.id));
       const key='group:'+d.id+':'+ci,collapse=items.length>5&&!expanded.includes(key)&&!items.some(t=>chain.has(t.id));
       if(collapse){items.forEach(t=>map.set(t.id,key));rendered.push({id:key,type:'task',position:{x:ci*340+180,y:top},draggable:false,connectable:false,data:{label:d.name,color:d.color,group:true,count:items.length,done:items.filter(t=>t.status==='done').length,waiting:items.filter(t=>readiness(board,t.id)==='waiting').length}});}
       else {rows=Math.max(rows,items.length);items.forEach((t,row)=>{map.set(t.id,t.id);rendered.push({id:t.id,type:'task',position:{x:ci*340+180,y:top+row*150},selected:selected===t.id,draggable:false,connectable:false,data:{task:t,label:t.title,color:d.color,context:!visible.some(v=>v.id===t.id),focused:chain.has(t.id),readiness:readiness(board,t.id),blockers:board.relationships.filter(e=>e.target===t.id&&e.kind==='blocks').length}});});}
     }
     if(board.tasks.some(t=>ids.has(t.id)&&t.domain===d.id)){rendered.push({id:'area:'+d.id,type:'task',position:{x:0,y:top},draggable:false,selectable:false,connectable:false,data:{label:d.name,color:d.color,lane:true}});top+=rows*150+80;}
   }
   const aggregate=new Map<string,Edge>();
   for(const e of board.relationships){const source=map.get(e.source),target=map.get(e.target);if(!source||!target||source===target)continue;const key=e.kind+':'+source+':'+target,prior=aggregate.get(key);if(prior){prior.data!.count=Number(prior.data!.count)+1;prior.label=prior.data!.count+' links';continue;}
     const focused=chain.has(e.source)&&chain.has(e.target),color=focused?'#9bebc6':'#657b99';aggregate.set(key,{id:e.id,source,target,type:'smoothstep',label:e.kind==='related'?'related':undefined,markerEnd:e.kind==='blocks'?{type:MarkerType.ArrowClosed,color}:undefined,style:'stroke:'+color+';opacity:'+(selected&&!focused ? .3 : 1)+(e.kind==='related'?';stroke-dasharray:5 5':''),data:{count:1}});
   }
   nodes=rendered;edges=[...aggregate.values()];
 });
</script>
<div class="timeline-shell"><div class="sequence-note">MILESTONE TIMELINE <span>Sequence, not dates or duration. Arrows alone indicate blockers.</span></div>
<SvelteFlow bind:nodes bind:edges {nodeTypes} nodesDraggable={false} nodesConnectable={false} deleteKey={null} onlyRenderVisibleElements colorMode={theme} fitView minZoom={.1} maxZoom={2.5} onnodeclick={({node})=>{if(node.id.startsWith('group:'))expanded=[...expanded,node.id];else if(board.tasks.some(t=>t.id===node.id))onselect(node.id);}}>
<Background gap={22}/><Controls showLock={false}/><MiniMap pannable zoomable style="width:144px;height:96px" maskColor="color-mix(in srgb,var(--bg) 65%,transparent)" bgColor="var(--panel)" nodeColor={n=>String(n.data.color??'#64748b')}/>
</SvelteFlow></div>
<style>.timeline-shell{height:100%;position:relative}.sequence-note{position:absolute;top:10px;left:16px;z-index:5;font:9px var(--mono);color:var(--accent);background:var(--panel);border:1px solid var(--line);padding:7px 10px;border-radius:4px}.sequence-note span{color:var(--muted);margin-left:15px;font-size:9px}@media(max-width:850px){.sequence-note span{display:block;margin-left:0;margin-top:4px}}</style>
