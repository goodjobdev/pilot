<script lang="ts">
 import {onMount} from 'svelte';
 import type {Board,Operation,Domain,Milestone} from '../shared/model';
 let {board,onclose,onoperation}:{board:Board;onclose:()=>void;onoperation:(op:Operation)=>Promise<void>}=$props();
 let dialog:HTMLDialogElement,domains=$state<Domain[]>([]),milestones=$state<Milestone[]>([]);
 onMount(()=>{domains=structuredClone($state.snapshot(board.domains));milestones=structuredClone($state.snapshot(board.milestones));dialog.showModal();});
</script>
<dialog bind:this={dialog} oncancel={onclose}><header class="modal-head"><h2>Areas & milestones</h2><button aria-label="Close settings" onclick={onclose}>×</button></header>
 <p class="muted">Milestone order is a timeline sequence, not an automatic dependency. Removing a referenced area or milestone is rejected.</p>
 <h3>Areas</h3>{#each domains as d,i}<div class="row"><label class="grow">Area name<input bind:value={d.name}></label><label>Accent<input type="color" bind:value={d.color}></label><button onclick={()=>domains=domains.filter((_,at)=>at!==i)}>Remove</button></div>{/each}<button onclick={()=>domains=[...domains,{id:'area-'+crypto.randomUUID(),name:'New area',color:'#94a3b8'}]}>＋ Area</button>
 <h3>Milestones</h3>{#each milestones as m,i}<div class="row"><label class="grow">Milestone name<input bind:value={m.name}></label><label>Order<input type="number" min="0" max="10000" bind:value={m.order}></label><button onclick={()=>milestones=milestones.filter((_,at)=>at!==i)}>Remove</button></div>{/each}<button onclick={()=>milestones=[...milestones,{id:crypto.randomUUID(),name:'Next milestone',order:milestones.length+1}]}>＋ Milestone</button>
 <footer class="row"><button onclick={onclose}>Cancel</button><button class="primary" onclick={async()=>{await onoperation({op:'metadata',domains:$state.snapshot(domains),milestones:$state.snapshot(milestones)});onclose();}}>Save configuration</button></footer>
</dialog>
<style>.grow{flex:1}.row>label:not(.grow){width:70px}h3{margin-top:25px}label{margin:5px 0}.row button{font-size:10px}</style>
