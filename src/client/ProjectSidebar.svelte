<script lang="ts">
 import type { Project } from '../shared/model';
 import Icon from './Icon.svelte';
 let { projects, selected, hidden=false, onselect, onadd }: {projects:Project[];selected:string;hidden?:boolean;onselect:(p:Project)=>void;onadd:()=>void}=$props();
 let search=$state('');
</script>
<aside id="project-sidebar" class="sidebar" aria-label="Project sidebar" {hidden}>
 <div class="brand"><span class="brandmark"><Icon name="graph" size={18}/></span><div>Pilot<small>PLANNING &amp; AGENTS</small></div></div>
 <label class="search"><Icon name="search" size={14}/><input aria-label="Search projects" placeholder="Find a project…" bind:value={search}></label>
 <div class="eyebrow sidebar-label">PROJECTS <span>{String(projects.length).padStart(2,'0')}</span></div>
 <nav aria-label="Projects">
 {#each projects.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())) as project}
 <button class:current={selected===project.id} aria-current={selected===project.id?'page':undefined} onclick={()=>onselect(project)}><span class="project-icon">{project.name.slice(0,1).toUpperCase()}</span><span>{project.name}<small>{project.state==='available'?'Planning workspace':project.state}</small></span></button>
 {/each}
 </nav>
 <button class="add-project" onclick={onadd} aria-label="＋ Add project"><Icon name="plus" size={15}/>Add project</button>
 <div class="sidebar-foot" title="Private planning · persistent Markdown · no automatic Git sync"><Icon name="shield" size={13}/><span>PRIVATE / LOCAL FILES</span><span class="live-dot"></span></div>
</aside>
