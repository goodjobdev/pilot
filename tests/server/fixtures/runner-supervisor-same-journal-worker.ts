import {ControlStore} from '../../../src/server/state/control-store';
import {RunnerSupervisorJournal} from '../../../src/server/state/runner-supervisor-journal';
import {RunnerSupervisor,type RunnerSupervisorRuntime} from '../../../src/server/state/runner-supervisor';

const [root,point,json]=process.argv.slice(2);
const request=JSON.parse(json);
const control=new ControlStore(`${root}/control`);
const journal=new RunnerSupervisorJournal(`${root}/supervisor`);
const pause=(stage:string)=>new Promise<void>(resolve=>{
 if(stage!==point){resolve();return;}
 process.send?.({stage});
 process.once('message',()=>resolve());
});
const runtime:RunnerSupervisorRuntime={
 async create(input){await pause('create');return {runtimeId:'synthetic-runtime',requestDigest:input.requestDigest};},
 async start(input){await pause('start');return {runtimeId:input.runtimeId,requestDigest:input.requestDigest,started:true};},
 async inspect(input){return {runtimeId:input.runtimeId,requestDigest:'unused',state:'unavailable'};}
};
process.send?.({stage:'ready'});
process.once('message',async()=>{
 try{const result=await new RunnerSupervisor(control,journal,runtime,()=>1000).submit(request);process.send?.({stage:'result',status:result.status});}
 catch(error){process.send?.({stage:'error',message:String(error)});}
 finally{journal.close();control.close();process.disconnect?.();}
});
