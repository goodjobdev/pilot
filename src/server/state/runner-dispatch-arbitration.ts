import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {closeSync, openSync} from 'node:fs';
import {canonicalJson} from '../../shared/control-state';
import {parseRunnerServiceRequest} from './runner-service-admission';

type Decision='closed-before-dispatch'|'dispatch-possible';
type RecordRow={job_id:string;request_json:string;evidence_digest:string;decision:Decision};
const hash=(json:string,decision:Decision)=>createHash('sha256').update(JSON.stringify([json,decision])).digest('hex');

/** Uninstalled arbitration experiment. The file must be private to the service; this class does not
 * establish filesystem protection, peer authentication, runtime identity, or termination. */
export class RunnerDispatchArbitration {
 private readonly db:DatabaseSync;
 /** Provision only a genuinely new path. Never use this as recovery for a lost journal. */
 static provision(file:string):RunnerDispatchArbitration{
  const fd=openSync(file,'wx',0o600);closeSync(fd);
  const db=new DatabaseSync(file);
  try{db.exec(`CREATE TABLE arbitration_jobs(job_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, evidence_digest TEXT NOT NULL, decision TEXT NOT NULL); PRAGMA user_version=1`);}finally{db.close();}
  return new RunnerDispatchArbitration(file);
 }
 constructor(file:string){
  // DatabaseSync otherwise creates a missing database. This is not an external identity anchor.
  const fd=openSync(file,'r+');closeSync(fd);
  this.db=new DatabaseSync(file);
  try{
   this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
   const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
   const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
   const columns=this.db.prepare('PRAGMA table_info(arbitration_jobs)').all() as {name:string;type:string;notnull:number;pk:number}[];
   if(version!==1||tables.length!==1||tables[0].name!=='arbitration_jobs'||columns.map(c=>`${c.name}:${c.type}:${c.notnull}:${c.pk}`).join(',')!=='job_id:TEXT:0:1,request_json:TEXT:1:0,evidence_digest:TEXT:1:0,decision:TEXT:1:0')throw new Error('Incompatible arbitration journal.');
   this.checkedRows();
   this.db.exec('COMMIT');
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}this.db.close();throw error;}
 }
 close(){this.db.close();}
 /** Only the first successful dispatch returns permission to invoke an effect, after the commit.
  * A crash or lost response after commit is uncertain and must never lead to another invocation. */
 dispatch(value:unknown):{decision:Decision;invoke:boolean}{return this.decide(value,'dispatch-possible');}
 /** A tombstone applies even if no dispatch has yet arrived. Dispatch-possible is always unknown,
  * including after close; this method neither terminates a runtime nor releases any barrier. */
 closeRequest(value:unknown):{decision:Decision;invoke:false}{
  const result=this.decide(value,'closed-before-dispatch');return {decision:result.decision,invoke:false};
 }
 private decide(value:unknown,wanted:Decision):{decision:Decision;invoke:boolean}{
  const request=parseRunnerServiceRequest(value),json=canonicalJson(request);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const rows=this.checkedRows();
   const existing=rows.find(row=>row.job_id===request.jobId);
   if(existing){
    if(existing.request_json!==json)throw new Error('Job identity is bound to different request content.');
    this.db.exec('COMMIT');return {decision:existing.decision,invoke:false};
   }
   // No verified terminal receipt or recovery exists: dispatch of any other job remains blocked.
   if(wanted==='dispatch-possible'&&rows.some(row=>row.decision==='dispatch-possible'))throw new Error('A previous dispatch remains unresolved.');
   this.db.prepare('INSERT INTO arbitration_jobs VALUES(?,?,?,?)').run(request.jobId,json,hash(json,wanted),wanted);
   this.db.exec('COMMIT');return {decision:wanted,invoke:wanted==='dispatch-possible'};
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
 }
 private checkedRows():RecordRow[]{
  const rows=this.db.prepare('SELECT * FROM arbitration_jobs').all() as RecordRow[];
  const identities=new Set<string>();
  for(const row of rows){
   try{
    const parsed=parseRunnerServiceRequest(JSON.parse(row.request_json));
    if(identities.has(row.job_id)||parsed.jobId!==row.job_id||canonicalJson(parsed)!==row.request_json||!['closed-before-dispatch','dispatch-possible'].includes(row.decision)||hash(row.request_json,row.decision)!==row.evidence_digest)throw Error();
    identities.add(row.job_id);
   }catch{throw new Error('Arbitration journal evidence is corrupt.');}
  }
  if(rows.filter(row=>row.decision==='dispatch-possible').length>1)throw new Error('Arbitration journal has conflicting dispatches.');
  return rows;
 }
}
