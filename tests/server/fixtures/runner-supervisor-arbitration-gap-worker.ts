import {ControlStore} from '../../../src/server/state/control-store';
import {RunnerSupervisorJournal} from '../../../src/server/state/runner-supervisor-journal';
import {RunnerSupervisor,type RunnerSupervisorRuntime} from '../../../src/server/state/runner-supervisor';

const [root,point,json]=process.argv.slice(2);
const request=JSON.parse(json);
const control=new ControlStore(`${root}/control`);
const journal=new RunnerSupervisorJournal(`${root}/supervisor`);
const pause=async(stage:string)=>{
 if(stage===point){process.send?.({stage});await new Promise<never>(()=>{});}
};
const runtime:RunnerSupervisorRuntime={
 async create(input){await pause('create');return {runtimeId:'synthetic-runtime',requestDigest:input.requestDigest};},
 async start(input){await pause('start');return {runtimeId:input.runtimeId,requestDigest:input.requestDigest,started:true};},
 async inspect(input){return {runtimeId:input.runtimeId,requestDigest:'unused',state:'unavailable'};}
};
process.send?.({stage:'ready'});
process.once('message',async()=>{
 try{await new RunnerSupervisor(control,journal,runtime,()=>1000).submit(request);process.send?.({stage:'unexpected-completion'});}
 catch(error){process.send?.({stage:'error',message:String(error)});}
});
