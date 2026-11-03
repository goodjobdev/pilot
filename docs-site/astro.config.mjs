import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
export default defineConfig({
 integrations:[starlight({title:'Pilot',description:'Design Documentation Driven Development, from intent to verified delivery.',
  components:{PageTitle:'./src/components/PageTitle.astro'},
  sidebar:[{label:'Start here',items:[{label:'Overview',slug:''},{label:'Vision',slug:'start/vision'},{label:'First project',slug:'start/first-project'}]},
   {label:'Using Pilot',items:[{label:'Settings',slug:'guides/settings'},{label:'Planning',slug:'guides/planning'},{label:'Files and history',slug:'guides/files-history'},{label:'Remote updates (unreleased)',slug:'guides/remote-updates'},{label:'Agents',slug:'guides/agents'},{label:'Design direction',slug:'guides/design'}]},
   {label:'Documentation handbook',items:[{label:'Documentation contract',slug:'handbook/documentation'},{label:'Feature template',slug:'handbook/feature-template'},{label:'Design template',slug:'handbook/design-template'},{label:'Repository update contract',slug:'specs/repository-updates'},
    {label:'Coding tools contract',slug:'specs/coding-tools'}]}]
 })],
});
