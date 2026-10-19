<script lang="ts">
 import {BaseEdge,EdgeReconnectAnchor,getSmoothStepPath,type EdgeProps} from '@xyflow/svelte';
 let {id,sourceX,sourceY,targetX,targetY,sourcePosition,targetPosition,markerEnd,style,label,selected,data}:EdgeProps=$props();
 const path=$derived(getSmoothStepPath({sourceX,sourceY,targetX,targetY,sourcePosition,targetPosition}));
</script>
<BaseEdge {id} path={path[0]} {markerEnd} {style} {label} labelX={path[1]} labelY={path[2]}/>
{#if selected&&data?.editable}
 <EdgeReconnectAnchor type="source" position={{x:sourceX,y:sourceY}}><span class="anchor"></span></EdgeReconnectAnchor>
 <EdgeReconnectAnchor type="target" position={{x:targetX,y:targetY}}><span class="anchor"></span></EdgeReconnectAnchor>
{/if}
<style>.anchor{display:block;width:12px;height:12px;background:var(--accent);border:2px solid var(--panel);border-radius:50%;margin:6px}</style>
