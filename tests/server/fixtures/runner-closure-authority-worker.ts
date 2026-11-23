import {appendFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {openClosureAuthority} from './runner-closure-authority';
const [file,point,json]=process.argv.slice(2);
let records=0;
const authority=openClosureAuthority(file,{
 async onStage(stage){
  if(stage===point){process.send?.({stage});await new Promise<void>(resolve=>process.once('message',()=>resolve()));}
 },
 onEffect(effect,jobId){
  if(++records>8)throw Error('Synthetic invocation evidence limit exceeded.');
  // Independent read-only connection: the stage must have committed before this boundary.
  const observer=new DatabaseSync(file,{readOnly:true});
  try{
   const row=observer.prepare('SELECT stage,decision,request_json,deadline_ms FROM synthetic_jobs WHERE job_id=?').get(jobId);
   if(!row)throw Error('Synthetic invocation has no admitted row.');
   appendFileSync(`${file}.effects`,JSON.stringify({effect,jobId,...row})+'\n',{mode:0o600});
  }finally{observer.close();}
 }
});
process.send?.({stage:'ready'});
process.once('message',async()=>{
 try{process.send?.({stage:'result',decision:await authority.submit(JSON.parse(json))});}
 catch(error){process.send?.({stage:'error',message:String(error)});}
 finally{authority.dispose();process.disconnect?.();}
});
