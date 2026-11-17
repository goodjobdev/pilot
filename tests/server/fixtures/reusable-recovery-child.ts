import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { HarnessHost } from '../../../src/server/agents/harness-host';
import { ProviderStore } from '../../../src/server/providers';
import { ControlStore } from '../../../src/server/state/control-store';
import { ReusableToolStore } from '../../../src/server/state/reusable-tools';

const [root,phase,mode,tool='define']=process.argv.slice(2),projectId='33333333-3333-4333-8333-333333333333';
const control=new ControlStore(join(root,'control')),store=new ReusableToolStore(control);
const fake=fauxProvider({provider:'recovery-projection',models:[{id:'fixture'}]}),providers=new ProviderStore(root,[fake.provider]);
await providers.savePreferences({defaultModel:{provider:'recovery-projection',modelId:'fixture'},favourites:[],allowRealModels:true});
const freeze=()=>{writeFileSync(join(root,'entered'),phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);};
const host=new HarnessHost({dataRoot:root,enabled:true,providers,privileges:{authority:async()=>({agentId:'agent',model:null,scopes:['reusable_tools'],projects:[projectId],emptyReason:null})},reusableTools:{
 list:x=>store.list(x.projectId,x.agentId),
 write:x=>{if(mode==='reopen')writeFileSync(join(root,'replayed'),'define');const result=store.write({...x,guard:()=>{if(mode==='run'&&phase==='before')freeze();}});if(mode==='run'&&phase==='after')freeze();return result;},
 invoke:x=>{if(mode==='reopen')writeFileSync(join(root,'replayed'),'invoke');if(mode==='run'&&phase==='before')freeze();const result=store.invoke(x.projectId,x.agentId,x.name,x.json);if(mode==='run'&&phase==='after')freeze();return result;}
}});
const project={id:projectId,name:'Fixture',path:root,managed:true,repository:'',created:''};
if(mode==='run'){
 if(tool==='invoke')store.write({projectId,agentId:'agent',name:'pick',revision:0,fields:['name'],guard:()=>{}});
 const call=tool==='invoke'?fauxToolCall('reusable_invoke',{name:'pick',json:'{"name":"Ada"}'}):fauxToolCall('reusable_define',{name:'pick',revision:0,fields:['name']});
 fake.setResponses([()=>fauxAssistantMessage([call],{stopReason:'toolUse'}),()=>fauxAssistantMessage('run finished')]);
 await host.submit(project,{text:'Create projection',mode:'followUp'});
 await new Promise(resolve=>setTimeout(resolve,30000));
} else {
 fake.setResponses([()=>fauxAssistantMessage('recovery finished')]);
 const until=Date.now()+10000;
 for(;;){const view=await host.view(project);const interrupted=view.entries.find(entry=>entry.kind==='tool'&&/interrupted/i.test(entry.text));if(interrupted){console.log(JSON.stringify({interrupted:interrupted.text,definitions:store.list(projectId,'agent')}));break;}if(Date.now()>until)throw Error('interrupted tool result not observed');await new Promise(resolve=>setTimeout(resolve,25));}
 await host.close();await providers.close();control.close();
}
