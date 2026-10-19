<script lang="ts">
 import { Handle,Position,type NodeProps } from '@xyflow/svelte';
 import type { Task } from '../shared/model';
 type Data={task?:Task;label:string;color:string;count?:number;done?:number;waiting?:number;context?:boolean;group?:boolean;lane?:boolean;milestone?:string;readiness?:string;blockers?:number;focused?:boolean};
 let {data,selected}:NodeProps=$props();
 let value=$derived(data as Data);
</script>
{#if value.lane}<div class="lane-label" style:color={value.color}>{value.label}</div>
{:else}
 <div class="task-card" class:selected class:context={value.context} class:focused={value.focused} class:group={value.group} style:--area={value.color}>
 <Handle type="target" position={Position.Left} isConnectable={!value.context&&!value.group}/>
 <div class="card-top"><span class="area-bar"></span><span>{value.group?'AREA OVERVIEW':value.task?.scope??'active'}</span>{#if value.context}<span class="context-label">FILTERED CONTEXT</span>{/if}</div>
 <div class="node-title">{value.label}</div>
 {#if value.group}<div class="group-stats"><strong>{value.count}</strong> tasks · {value.done} done · {value.waiting} waiting</div><small>Click to expand this area</small>
 {:else}<div class="card-bottom"><span class="status" class:done={value.task?.status==='done'} class:doing={value.task?.status==='doing'}>{value.task?.status==='done'?'✓':value.task?.status==='doing'?'◉':value.readiness==='waiting'?'⊘':'○'} {value.task?.status==='todo'?value.readiness:value.task?.status}</span>{#if value.blockers}<span>{value.blockers} prerequisite{value.blockers===1?'':'s'}</span>{/if}</div>{#if value.milestone}<div class="milestone">{value.milestone}</div>{/if}
 {/if}
 <Handle type="source" position={Position.Right} isConnectable={!value.context&&!value.group}/>
 </div>
{/if}
<style>
.task-card{width:265px;min-height:120px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--area);border-radius:5px;padding:14px 16px;box-shadow:0 4px 18px #0003;color:var(--ink)}.task-card.selected{outline:2px solid var(--accent);outline-offset:3px}.task-card.focused{border-color:var(--area)}.task-card.context{opacity:.65;border-style:dashed}.card-top{display:flex;align-items:center;gap:6px;font:8px var(--mono);letter-spacing:1.2px;text-transform:uppercase;color:var(--muted)}.area-bar{width:5px;height:5px;background:var(--area);border-radius:50%}.node-title{font-size:13px;line-height:1.5;font-weight:600;margin:10px 0;display:-webkit-box;-webkit-line-clamp:3;line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.card-bottom{display:flex;justify-content:space-between;font-size:9px;color:var(--muted);gap:8px}.status{text-transform:capitalize}.status.done{color:var(--accent)}.status.doing{color:#72baff}.milestone{font:8px var(--mono);margin-top:8px;color:var(--muted)}.context-label{letter-spacing:0;font-size:7px}.group-stats{font-size:11px;color:var(--muted);margin-bottom:8px}.group-stats strong{color:var(--ink);font-size:19px}.task-card small{font-size:9px;color:var(--muted)}.lane-label{width:150px;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:1.5px;border-top:1px solid var(--line);padding-top:12px}
</style>
