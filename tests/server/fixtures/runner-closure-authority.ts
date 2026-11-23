import {createHash} from 'node:crypto';
import {closeSync,openSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../../../src/shared/control-state';
import {parseRunnerServiceRequest} from '../../../src/server/state/runner-service-admission';

type Stage='admitted'|'create-intent'|'created'|'start-intent'|'started';
type Decision='closed-before-dispatch'|'dispatch-possible';
type Row={job_id:string;request_json:string;decision:Decision;deadline_ms:number|null;stage:Stage|null;evidence:string};
type Hooks={onStage?:(stage:Stage)=>Promise<void>|void;onEffect?:(effect:'create'|'start',jobId:string)=>void};
const hash=(row:Omit<Row,'evidence'>)=>createHash('sha256').update(canonicalJson(row)).digest('hex');
const stages:Stage[]=['admitted','create-intent','created','start-intent','started'];

/** Synthetic-only fixture; no host runtime or production supervisor is constructed. */
export function provisionClosureAuthority(file:string):void{
 const fd=openSync(file,'wx',0o600);closeSync(fd);
 const db=new DatabaseSync(file);
 try{db.exec(`CREATE TABLE synthetic_jobs(job_id TEXT PRIMARY KEY,request_json TEXT NOT NULL,decision TEXT NOT NULL,deadline_ms INTEGER,stage TEXT,evidence TEXT NOT NULL); PRAGMA user_version=1;`);}
 finally{db.close();}
}

/** Hooks are trusted test gates/observers, not runtime effect implementations. */
export function openClosureAuthority(file:string,hooks:Hooks={}){
 const fd=openSync(file,'r+');closeSync(fd);
 const db=new DatabaseSync(file);
 try{
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  const version=(db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  const columns=db.prepare('PRAGMA table_info(synthetic_jobs)').all() as {name:string;type:string;notnull:number;pk:number}[];
  if(version!==1||tables.length!==1||tables[0].name!=='synthetic_jobs'||columns.map(c=>`${c.name}:${c.type}:${c.notnull}:${c.pk}`).join(',')!=='job_id:TEXT:0:1,request_json:TEXT:1:0,decision:TEXT:1:0,deadline_ms:INTEGER:0:0,stage:TEXT:0:0,evidence:TEXT:1:0')throw Error('Incompatible synthetic authority schema.');
  checkedRows();
 }catch(error){db.close();throw error;}
 function checkedRows():Row[]{
  const rows=db.prepare('SELECT * FROM synthetic_jobs').all() as Row[];
  for(const row of rows){
   try{
    const parsed=parseRunnerServiceRequest(JSON.parse(row.request_json));
    const {evidence,...body}=row;
    if(parsed.jobId!==row.job_id||canonicalJson(parsed)!==row.request_json||hash(body)!==evidence||
     (row.decision==='closed-before-dispatch'?(row.deadline_ms!==null||row.stage!==null):
      row.decision!=='dispatch-possible'||!Number.isSafeInteger(row.deadline_ms)||row.deadline_ms!<0||!stages.includes(row.stage as Stage)))throw Error();
   }catch{throw Error('Synthetic authority evidence is corrupt.');}
  }
  if(rows.filter(r=>r.decision==='dispatch-possible').length>1)throw Error('Synthetic authority barrier is corrupt.');
  return rows;
 }
 function transaction<T>(operation:()=>T):T{
  db.exec('BEGIN IMMEDIATE');try{const value=operation();db.exec('COMMIT');return value;}
  catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
 }
 function decide(value:unknown,wanted:Decision):{decision:Decision;first:boolean;jobId:string}{
  const request=parseRunnerServiceRequest(value),json=canonicalJson(request);
  return transaction(()=>{
   const rows=checkedRows(),prior=rows.find(r=>r.job_id===request.jobId);
   if(prior){if(prior.request_json!==json)throw Error('Job identity is bound to different request content.');return {decision:prior.decision,first:false,jobId:request.jobId};}
   if(wanted==='dispatch-possible'&&rows.some(r=>r.decision==='dispatch-possible'))throw Error('A previous dispatch remains unresolved.');
   const deadline=wanted==='dispatch-possible'?Date.now()+request.limits.timeoutMs:null;
   if(deadline!==null&&!Number.isSafeInteger(deadline))throw Error('Invalid deadline.');
   const body={job_id:request.jobId,request_json:json,decision:wanted,deadline_ms:deadline,stage:wanted==='dispatch-possible'?'admitted' as const:null};
   db.prepare('INSERT INTO synthetic_jobs VALUES(?,?,?,?,?,?)').run(body.job_id,json,wanted,deadline,body.stage,hash(body));
   return {decision:wanted,first:wanted==='dispatch-possible',jobId:request.jobId};
  });
 }
 function advance(jobId:string,expected:Stage,next:Stage):void{
  transaction(()=>{
   const current=checkedRows().find(r=>r.job_id===jobId);
   if(!current||current.decision!=='dispatch-possible'||current.stage!==expected)throw Error('Synthetic stage changed.');
   if(current.deadline_ms===null||Date.now()>=current.deadline_ms)throw Error('Synthetic deadline expired.');
   const {evidence:_,...body}=current;body.stage=next;
   db.prepare('UPDATE synthetic_jobs SET stage=?,evidence=? WHERE job_id=?').run(next,hash(body),jobId);
  });
 }
 function checkDeadline(jobId:string,expected:Stage):void{
  transaction(()=>{
   const current=checkedRows().find(r=>r.job_id===jobId);
   if(!current||current.stage!==expected||current.decision!=='dispatch-possible')throw Error('Synthetic stage changed.');
   if(current.deadline_ms===null||Date.now()>=current.deadline_ms)throw Error('Synthetic deadline expired.');
  });
 }
 // These synthetic ports have no host effects and are never returned to callers.
 function syntheticCreate(jobId:string):{runtimeId:string}{
  hooks.onEffect?.('create',jobId);
  return {runtimeId:`synthetic:${jobId}`};
 }
 function syntheticStart(jobId:string,created:{runtimeId:string}):void{
  if(created.runtimeId!==`synthetic:${jobId}`)throw Error('Synthetic identity mismatch.');
  hooks.onEffect?.('start',jobId);
 }
 // Only this lexical continuation can invoke the synthetic effects. It is not returned to callers.
 async function submit(value:unknown):Promise<Decision>{
  const admission=decide(value,'dispatch-possible');
  if(!admission.first)return admission.decision;
  const id=admission.jobId;
  await hooks.onStage?.('admitted');
  advance(id,'admitted','create-intent');await hooks.onStage?.('create-intent');
  checkDeadline(id,'create-intent');const created=syntheticCreate(id);
  advance(id,'create-intent','created');await hooks.onStage?.('created');
  advance(id,'created','start-intent');await hooks.onStage?.('start-intent');
  checkDeadline(id,'start-intent');syntheticStart(id,created);
  advance(id,'start-intent','started');await hooks.onStage?.('started');
  return 'dispatch-possible';
 }
 return Object.freeze({
  submit,
  closeRequest(value:unknown):Decision{return decide(value,'closed-before-dispatch').decision;},
  dispose():void{db.close();}
 });
}
