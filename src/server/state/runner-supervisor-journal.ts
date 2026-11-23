import {createHash} from 'node:crypto';
import {chmodSync,closeSync,lstatSync,mkdirSync,openSync,realpathSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join,resolve} from 'node:path';
import {canonicalJson} from '../../shared/control-state';
import {parseRunnerServiceRequest,type RunnerServiceRequest} from './runner-service-admission';

export type RunnerSupervisorStage='admitted'|'create-intent'|'create-dispatched'|'identity-recorded'|'start-intent'|'start-dispatched'|'running'|'uncertain';
export type RunnerSupervisorJob={jobId:string;request:RunnerServiceRequest;requestDigest:string;integrityDigest:string;deadlineMs:number;stage:RunnerSupervisorStage;runtimeId:string|null;revision:number};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const integrity=(jobId:string,requestDigest:string,deadlineMs:number,stage:RunnerSupervisorStage,runtimeId:string|null,revision:number)=>digest(canonicalJson({jobId,requestDigest,deadlineMs,stage,runtimeId,revision}));
const states:RunnerSupervisorStage[]=['admitted','create-intent','create-dispatched','identity-recorded','start-intent','start-dispatched','running','uncertain'];
const runtimeIdSchema=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/**
 * Uninstalled durable stage journal. This is deliberately a separate SQLite file from ControlStore:
 * the existing control schema has no intermediate create/identity/start transitions. Store ownership,
 * peer authentication, runtime provenance and host isolation remain external assumptions.
 */
export class RunnerSupervisorJournal {
 readonly db:DatabaseSync;
 readonly file:string;
 constructor(directory:string){
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});
  const st=lstatSync(root);if(st.isSymbolicLink()||!st.isDirectory())throw new Error('Supervisor journal root must be a real directory.');
  const canonical=realpathSync(root);this.file=join(canonical,'runner-supervisor.sqlite');
  try{const fd=openSync(this.file,'wx',0o600);closeSync(fd);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const fileStat=lstatSync(this.file);if(fileStat.isSymbolicLink()||!fileStat.isFile()||(fileStat.mode&0o077)!==0)throw new Error('Supervisor journal file must be a private regular file.');
  this.db=new DatabaseSync(this.file);this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  chmodSync(this.file,0o600);
  const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  if(tables.length===0&&version===0){this.db.exec(`CREATE TABLE supervisor_jobs(
   job_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, request_digest TEXT NOT NULL, integrity_digest TEXT NOT NULL,
   deadline_ms INTEGER NOT NULL, stage TEXT NOT NULL, runtime_id TEXT, revision INTEGER NOT NULL
  ); CREATE TABLE supervisor_closures(job_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, evidence_digest TEXT NOT NULL); PRAGMA user_version=5;`);}
  else{
   const columns=this.db.prepare('PRAGMA table_info(supervisor_jobs)').all() as {name:string;type:string}[];
   const expected='job_id,request_json,request_digest,integrity_digest,deadline_ms,stage,runtime_id,revision';
   const closureColumns=this.db.prepare('PRAGMA table_info(supervisor_closures)').all() as {name:string;type:string}[];
   if(version!==5||tables.length!==2||!tables.some(t=>t.name==='supervisor_jobs')||!tables.some(t=>t.name==='supervisor_closures')||closureColumns.map(c=>`${c.name}:${c.type.toUpperCase()}`).join(',')!=='job_id:TEXT,request_json:TEXT,evidence_digest:TEXT'||columns.map(c=>c.name).join(',')!==expected||columns.some(c=>c.type.toUpperCase()!==({'job_id':'TEXT','request_json':'TEXT','request_digest':'TEXT','integrity_digest':'TEXT','deadline_ms':'INTEGER','stage':'TEXT','runtime_id':'TEXT','revision':'INTEGER'} as Record<string,string>)[c.name])){this.db.close();throw new Error('Incompatible supervisor journal schema.');}
  }
  try{this.checkedClosures();for(const row of this.db.prepare('SELECT * FROM supervisor_jobs').all() as Record<string,unknown>[])this.parseRow(row);}
  catch(error){this.db.close();throw error;}
 }
 close(){this.db.close();}
 admit(value:unknown,clockOrNow?:number|(()=>number)):{job:RunnerSupervisorJob;first:boolean}{
  const request=parseRunnerServiceRequest(value);
  const requestJson=canonicalJson(request),requestDigest=digest(requestJson);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const closure=this.checkedClosures().find(row=>row.job_id===request.jobId);
   if(closure){if(closure.request_json!==requestJson)throw new Error('Job identity is bound to different request content.');throw new Error('Job was closed before dispatch.');}
   const prior=this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(request.jobId) as Record<string,unknown>|undefined;
   if(prior){const job=this.parseRow(prior);if(job.requestDigest!==requestDigest)throw new Error('Job identity was already admitted with different request content.');this.db.exec('COMMIT');return {job,first:false};}
   // No settlement/removal path exists: the first admitted row blocks all distinct jobs forever,
   // including when inspection observes an exited runtime. Inspection does not release this barrier.
   const barrier=this.db.prepare('SELECT job_id FROM supervisor_jobs LIMIT 1').get() as {job_id:string}|undefined;
   if(barrier)throw new Error('A previous runner job remains unresolved; operator review is required.');
   const nowMs=typeof clockOrNow==='function'?clockOrNow():(clockOrNow??Date.now());
   if(!Number.isSafeInteger(nowMs)||nowMs<0)throw new Error('Invalid supervisor clock.');
   const deadlineMs=nowMs+request.limits.timeoutMs;if(!Number.isSafeInteger(deadlineMs))throw new Error('Invalid supervisor deadline.');
   const integrityDigest=integrity(request.jobId,requestDigest,deadlineMs,'admitted',null,1);
   this.db.prepare('INSERT INTO supervisor_jobs(job_id,request_json,request_digest,integrity_digest,deadline_ms,stage,runtime_id,revision) VALUES(?,?,?,?,?,\'admitted\',NULL,1)').run(request.jobId,requestJson,requestDigest,integrityDigest,deadlineMs);
   const job=this.parseRow(this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(request.jobId) as Record<string,unknown>);
   this.db.exec('COMMIT');return {job,first:true};
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
 }
 /** Internal journal experiment only: this does not fence the separately exported stage mutators. */
 closeRequest(value:unknown):'closed-before-dispatch'|'dispatch-possible'{
  const request=parseRunnerServiceRequest(value),json=canonicalJson(request);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const closure=this.checkedClosures().find(row=>row.job_id===request.jobId);
   if(closure){if(closure.request_json!==json)throw new Error('Job identity is bound to different request content.');this.db.exec('COMMIT');return 'closed-before-dispatch';}
   const row=this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(request.jobId) as Record<string,unknown>|undefined;
   if(row){const job=this.parseRow(row);if(canonicalJson(job.request)!==json)throw new Error('Job identity is bound to different request content.');this.db.exec('COMMIT');return 'dispatch-possible';}
   this.db.prepare('INSERT INTO supervisor_closures VALUES(?,?,?)').run(request.jobId,json,digest(canonicalJson([json,'closed-before-dispatch'])));
   this.db.exec('COMMIT');return 'closed-before-dispatch';
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
 }
 private checkedClosures():{job_id:string;request_json:string;evidence_digest:string}[]{
  const rows=this.db.prepare('SELECT * FROM supervisor_closures').all() as {job_id:string;request_json:string;evidence_digest:string}[];
  for(const row of rows){
   try{const request=parseRunnerServiceRequest(JSON.parse(row.request_json));
    if(request.jobId!==row.job_id||canonicalJson(request)!==row.request_json||row.evidence_digest!==digest(canonicalJson([row.request_json,'closed-before-dispatch']))||this.db.prepare('SELECT 1 FROM supervisor_jobs WHERE job_id=?').get(row.job_id))throw Error();
   }catch{throw new Error('Supervisor closure evidence is corrupt or inconsistent.');}
  }
  return rows;
 }
 dispatchCreate<T>(jobId:string,clock:()=>number,authorize:()=>boolean,invoke:()=>Promise<T>):{job:RunnerSupervisorJob;effect:Promise<T>}{
  return this.dispatch(jobId,'create-intent','create-dispatched',clock,authorize,invoke);
 }
 dispatchStart<T>(jobId:string,clock:()=>number,authorize:()=>boolean,invoke:()=>Promise<T>):{job:RunnerSupervisorJob;effect:Promise<T>}{
  return this.dispatch(jobId,'start-intent','start-dispatched',clock,authorize,invoke);
 }
 /** Linearize policy/cancellation checks against the synchronous runtime-port invocation under the writer lock. */
 private dispatch<T>(jobId:string,expected:RunnerSupervisorStage,next:RunnerSupervisorStage,clock:()=>number,authorize:()=>boolean,invoke:()=>Promise<T>):{job:RunnerSupervisorJob;effect:Promise<T>}{

  this.db.exec('BEGIN IMMEDIATE');let effect:Promise<T>|undefined;
  try{
   const row=this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(jobId) as Record<string,unknown>|undefined;
   if(!row)throw new Error('Supervisor job not found.');const current=this.parseRow(row);
   if(current.stage!==expected)throw new Error('Supervisor job was cancelled or dispatched before this effect.');
   const nowMs=clock();if(!Number.isSafeInteger(nowMs)||nowMs<0)throw new Error('Invalid supervisor clock.');
   if(nowMs>=current.deadlineMs)throw new Error('Supervisor deadline expired before runtime dispatch.');
   if(authorize()!==true)throw new Error('Runner service policy refused immediately before runtime dispatch.');
   // Invoke synchronously while holding the durable writer lock: a cancellation that commits first
   // prevents invocation; one that follows cannot retract an already-invoked effect. The Promise
   // type cannot bound the invocation's synchronous prefix; a blocking port stalls this lock/event loop.
   try{effect=Promise.resolve(invoke());}catch(error){effect=Promise.reject(error);}
   const revision=current.revision+1,integrityDigest=integrity(jobId,current.requestDigest,current.deadlineMs,next,current.runtimeId,revision);
   this.db.prepare('UPDATE supervisor_jobs SET stage=?,revision=?,integrity_digest=? WHERE job_id=? AND revision=?').run(next,revision,integrityDigest,jobId,current.revision);
   const updated=this.parseRow(this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(jobId) as Record<string,unknown>);
   this.db.exec('COMMIT');return {job:updated,effect};
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}if(effect)void effect.catch(()=>{});throw error;}
 }
 transition(jobId:string,expected:RunnerSupervisorStage,next:RunnerSupervisorStage,runtimeId?:string):RunnerSupervisorJob{
  const permitted:Record<RunnerSupervisorStage,RunnerSupervisorStage[]>={admitted:['create-intent','uncertain'],'create-intent':['uncertain'],'create-dispatched':['identity-recorded','uncertain'],'identity-recorded':['start-intent','uncertain'],'start-intent':['uncertain'],'start-dispatched':['running','uncertain'],'running':['uncertain'],uncertain:[]};
  if(!permitted[expected].includes(next))throw new Error('Illegal supervisor journal transition.');
  if(next==='identity-recorded'&&(typeof runtimeId!=='string'||!runtimeIdSchema.test(runtimeId)))throw new Error('Invalid immutable runtime identity.');
  if(next!=='identity-recorded'&&runtimeId!==undefined)throw new Error('Unexpected runtime identity.');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const row=this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(jobId) as Record<string,unknown>|undefined;
   if(!row)throw new Error('Supervisor job not found.');const current=this.parseRow(row);
   if(current.stage!==expected)throw new Error('Supervisor stage changed concurrently.');
   if(current.runtimeId!==null&&next!=='uncertain'&&next!=='running'&&next!=='start-intent'&&next!=='start-dispatched')throw new Error('Runtime identity cannot be replaced.');
   if(current.runtimeId!==null&&runtimeId!==undefined&&current.runtimeId!==runtimeId)throw new Error('Runtime identity cannot be replaced.');
   const newId=next==='identity-recorded'?runtimeId!:current.runtimeId,revision=current.revision+1;
   const integrityDigest=integrity(jobId,current.requestDigest,current.deadlineMs,next,newId,revision);
   this.db.prepare('UPDATE supervisor_jobs SET stage=?,runtime_id=?,revision=?,integrity_digest=? WHERE job_id=? AND revision=?').run(next,newId,revision,integrityDigest,jobId,current.revision);
   const updated=this.parseRow(this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(jobId) as Record<string,unknown>);
   this.db.exec('COMMIT');return updated;
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
 }
 markUncertain(jobId:string):RunnerSupervisorJob{
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const row=this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(jobId) as Record<string,unknown>|undefined;
   if(!row)throw new Error('Supervisor job not found.');const current=this.parseRow(row);
   if(current.stage==='uncertain'){this.db.exec('COMMIT');return current;}
   const revision=current.revision+1,integrityDigest=integrity(jobId,current.requestDigest,current.deadlineMs,'uncertain',current.runtimeId,revision);
   this.db.prepare("UPDATE supervisor_jobs SET stage='uncertain',revision=?,integrity_digest=? WHERE job_id=? AND revision=?").run(revision,integrityDigest,jobId,current.revision);
   const updated=this.parseRow(this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(jobId) as Record<string,unknown>);
   this.db.exec('COMMIT');return updated;
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
 }
 inspect(jobId:string):RunnerSupervisorJob|null{
  const row=this.db.prepare('SELECT * FROM supervisor_jobs WHERE job_id=?').get(jobId) as Record<string,unknown>|undefined;
  return row?this.parseRow(row):null;
 }
 private parseRow(row:Record<string,unknown>):RunnerSupervisorJob{
  try{
   const requestJson=row.request_json;if(typeof requestJson!=='string')throw Error();
   const request=parseRunnerServiceRequest(JSON.parse(requestJson)),requestDigest=String(row.request_digest),integrityDigest=String(row.integrity_digest),stage=row.stage as RunnerSupervisorStage;
   const runtimeId=row.runtime_id===null?null:String(row.runtime_id),deadlineMs=Number(row.deadline_ms),revision=Number(row.revision);
   const expectedRevision:Partial<Record<RunnerSupervisorStage,number>>={admitted:1,'create-intent':2,'create-dispatched':3,'identity-recorded':4,'start-intent':5,'start-dispatched':6,running:7};
   const requiredIdentity=stage==='identity-recorded'||stage==='start-intent'||stage==='start-dispatched'||stage==='running';
   const uncertainRevision=stage==='uncertain'&&revision>=2&&revision<=8;
   const validRevision=stage==='uncertain'?uncertainRevision:revision===expectedRevision[stage];
   const validIdentity=runtimeId===null||runtimeIdSchema.test(runtimeId);
   const uncertainIdentity=stage==='uncertain'&&((revision===2||revision===3||revision===4)?runtimeId===null:(revision>=5&&revision<=8&&runtimeId!==null&&runtimeIdSchema.test(runtimeId)));
   if(!states.includes(stage)||request.jobId!==row.job_id||canonicalJson(request)!==requestJson||digest(requestJson)!==requestDigest||integrity(request.jobId,requestDigest,deadlineMs,stage,runtimeId,revision)!==integrityDigest||!Number.isSafeInteger(deadlineMs)||deadlineMs<0||!Number.isSafeInteger(revision)||!validRevision||!validIdentity||(requiredIdentity&&runtimeId===null)||((stage==='admitted'||stage==='create-intent'||stage==='create-dispatched')&&runtimeId!==null)||(stage==='uncertain'&&!uncertainIdentity))throw Error();
   return {jobId:request.jobId,request,requestDigest,integrityDigest,deadlineMs,stage,runtimeId,revision};
  }catch{throw new Error('Supervisor journal evidence is corrupt or inconsistent.');}
 }
}
