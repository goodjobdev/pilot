import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  boundedJson, canonicalJson, CONTROL_MAX_JSON_BYTES, CONTROL_RECORD_VERSION, exceedsJsonLimit,
  isLegalOperationTransition,
  type ControlScope, type OperationRecord, type OperationState, type OutboxRecord,
  type OutboxState, validateOperationRecord, validateOutboxRecord, validateScope
} from '../../shared/control-state';

/** The on-disk control schema version, tied to the record version this build reads and writes. */
export const CONTROL_SCHEMA_VERSION = CONTROL_RECORD_VERSION;
const SCHEMA_VERSION = CONTROL_SCHEMA_VERSION;
export class ControlStoreError extends Error {
  constructor(message:string, public code:'CONFLICT'|'NOT_FOUND'|'SCOPE'|'SCHEMA'|'CORRUPT'|'INVALID'='INVALID') { super(message); }
}
type Admission = {
  scope:ControlScope; idempotencyKey:string; kind:string; input:unknown;
  outbox:{kind:string;payload:unknown};
};
function parseJson(value:string,label:string):unknown {
  try { return JSON.parse(value); } catch { throw new ControlStoreError(`Corrupt ${label} JSON`,'CORRUPT'); }
}
/** The size cap applies to the stored bytes, so an oversized column is refused before it is parsed. */
function jsonText(value:unknown,label:string):string {
  if(typeof value!=='string') throw new ControlStoreError(`Corrupt ${label}: not a JSON text value`,'CORRUPT');
  if(exceedsJsonLimit(value)) throw new ControlStoreError(`Corrupt ${label}: exceeds ${CONTROL_MAX_JSON_BYTES} bytes`,'CORRUPT');
  return value;
}
function now(){return new Date().toISOString();}
export function operationDigest(kind:string,input:unknown):string {
  if(!/^[a-z][a-z0-9.-]{0,79}$/.test(kind))throw new Error('Invalid operation kind');
  const canonical=canonicalJson({kind,input:JSON.parse(boundedJson(input))});
  return createHash('sha256').update(canonical).digest('hex');
}

export class ControlStore {
  readonly db:DatabaseSync;
  private closed=false;
  readonly file:string;
  constructor(dataRoot:string) {
    const root=resolve(dataRoot);
    try { mkdirSync(root,{recursive:true,mode:0o700}); } catch(e) { if((e as NodeJS.ErrnoException).code!=='EEXIST') throw e; }
    const rootStat=lstatSync(root);
    if(rootStat.isSymbolicLink()||!rootStat.isDirectory())
      throw new Error('Control data root must be a real directory');
    const canonicalRoot=realpathSync(root);
    this.file=join(canonicalRoot,'control.sqlite');
    this.assertSafeDatabasePaths();
    let created=false;
    try { const fd=openSync(this.file,'wx',0o600); closeSync(fd); created=true; }
    catch(e) { if((e as NodeJS.ErrnoException).code!=='EEXIST') throw e; }
    this.assertSafeDatabasePaths();
    if(!created) {
      const check=new DatabaseSync(this.file,{readOnly:true});
      try { this.validateExistingSchema(check); }
      catch(error) {
        // A raw driver error (for example a scan over a layout the predicates happened to accept)
        // is still a schema verdict: never let it escape as an untyped SqliteError.
        if(error instanceof ControlStoreError) throw error;
        throw new ControlStoreError('Control schema validation failed: '+(error as Error).message,'SCHEMA');
      }
      finally { check.close(); }
    }
    this.db=new DatabaseSync(this.file);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      if(created) this.initializeNew();
      this.db.exec('PRAGMA journal_mode=WAL;');
      this.assertSafeDatabasePaths();
    } catch(e) { try{this.db.close();}catch{} this.closed=true; throw e; }
  }
  private assertSafeDatabasePaths() {
    for(const path of [this.file,`${this.file}-wal`,`${this.file}-shm`,`${this.file}-journal`]) {
      try {
        const stat=lstatSync(path);
        if(stat.isSymbolicLink() || (!stat.isFile() && path===this.file) || (path!==this.file && !stat.isFile()))
          throw new ControlStoreError('Unsafe control database or SQLite sidecar path','SCHEMA');
        if((stat.mode&0o077)!==0) throw new ControlStoreError('Control database files must have private permissions','SCHEMA');
      } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    }
  }
  private validateExistingSchema(db:DatabaseSync) {
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
    if(!tables.some(t=>t.name==='control_schema')) {
      if(tables.length) throw new ControlStoreError('Unmarked control database contains existing tables','SCHEMA');
      throw new ControlStoreError('Existing empty control database is not initialized','SCHEMA');
    }
    const markers=db.prepare('SELECT version FROM control_schema').all() as {version?:unknown}[];
    if(markers.length!==1 || !Number.isInteger(markers[0]?.version)) throw new ControlStoreError('Missing, duplicate or corrupt control schema marker','SCHEMA');
    const version=markers[0].version as number;
    if(version>SCHEMA_VERSION) throw new ControlStoreError('Control schema is newer than this Pilot build','SCHEMA');
    if(version!==SCHEMA_VERSION) throw new ControlStoreError('Unsupported control schema version','SCHEMA');
    this.verifyTables(db);
    this.validateStoredRecords(db);
  }
  private initializeNew() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE control_schema(version INTEGER PRIMARY KEY CHECK(version = ${SCHEMA_VERSION}));
        CREATE TABLE operations(
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          kind TEXT NOT NULL, input_digest TEXT NOT NULL, input_json TEXT NOT NULL, state TEXT NOT NULL,
          revision INTEGER NOT NULL, receipt_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(project_id,session_id,idempotency_key)
        );
        CREATE TABLE outboxes(
          id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), project_id TEXT NOT NULL,
          session_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
          revision INTEGER NOT NULL, receipt_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO control_schema(version) VALUES (${SCHEMA_VERSION});
      `);
      this.verifyTables(this.db);
      this.db.exec('COMMIT');
    } catch(e) { try{this.db.exec('ROLLBACK');}catch{} throw e; }
  }
  private verifyTables(db:DatabaseSync) {
    const expected:Record<string,Record<string,string>>={
      control_schema:{version:'INTEGER'},
      operations:{id:'TEXT',project_id:'TEXT',session_id:'TEXT',idempotency_key:'TEXT',kind:'TEXT',input_digest:'TEXT',input_json:'TEXT',state:'TEXT',revision:'INTEGER',receipt_json:'TEXT',created_at:'TEXT',updated_at:'TEXT'},
      outboxes:{id:'TEXT',operation_id:'TEXT',project_id:'TEXT',session_id:'TEXT',kind:'TEXT',payload_json:'TEXT',state:'TEXT',revision:'INTEGER',receipt_json:'TEXT',created_at:'TEXT',updated_at:'TEXT'}
    };
    const tableNames=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(x=>x.name);
    if(tableNames.join(',')!=='control_schema,operations,outboxes') throw new ControlStoreError('Unexpected control schema tables','SCHEMA');
    // A WITHOUT ROWID table has no rowid, so the record scan would fail with a raw driver error
    // after every column predicate passed. It is a schema incompatibility, rejected as one.
    const listed=db.prepare('PRAGMA table_list').all() as {schema:string;name:string;wr?:number}[];
    const withoutRowid=tableNames.filter(name=>listed.some(row=>row.schema==='main'&&row.name===name&&row.wr===1));
    if(withoutRowid.length) throw new ControlStoreError('WITHOUT ROWID control table is not supported: '+withoutRowid.join(', '),'SCHEMA');
    const infos:Record<string,{name:string;type:string;pk:number;notnull:number}[]>={};
    for(const [table,columns] of Object.entries(expected)) {
      const info=db.prepare(`PRAGMA table_info(${table})`).all() as {name:string;type:string;pk:number;notnull:number}[];
      infos[table]=info;
      if(info.length!==Object.keys(columns).length || Object.keys(columns).some(column=>!info.some(row=>row.name===column))) throw new ControlStoreError(`Incomplete control table: ${table}`,'SCHEMA');
      for(const row of info) {
        const wanted=columns[row.name];
        if(!wanted || row.type.trim().toUpperCase()!==wanted) throw new ControlStoreError(`Wrong control column type: ${table}.${row.name}`,'SCHEMA');
        if(row.name==='receipt_json') {
          // Absent receipt is evidence: a NOT NULL receipt column would be accepted here and then
          // make every admission fail, so the schema is refused instead.
          if(row.notnull!==0) throw new ControlStoreError(`Required receipt column in control table: ${table}`,'SCHEMA');
        } else if(row.notnull!==1 && row.pk===0) throw new ControlStoreError(`Nullable required column in control table: ${table}`,'SCHEMA');
      }
    }
    const solePk=(table:string,column:string)=>infos[table].filter(r=>r.pk>0).sort((a,b)=>a.pk-b.pk).map(r=>r.name).join(',')===column;
    const indexes=db.prepare('PRAGMA index_list(operations)').all() as {name:string;unique:number;partial:number}[];
    const hasScopeUnique=indexes.some(index=>index.unique===1 && index.partial===0 &&
      (db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as {name:string}[]).map(row=>row.name).join(',')==='project_id,session_id,idempotency_key');
    const foreignKeys=db.prepare('PRAGMA foreign_key_list(outboxes)').all() as {id:number;seq:number;table:string;from:string;to:string;on_update:string;on_delete:string;match:string}[];
    const fk=foreignKeys.length===1 && foreignKeys[0].id===0 && foreignKeys[0].seq===0 && foreignKeys[0].table==='operations' && foreignKeys[0].from==='operation_id' && foreignKeys[0].to==='id' && foreignKeys[0].on_update==='NO ACTION' && foreignKeys[0].on_delete==='NO ACTION' && foreignKeys[0].match==='NONE';
    if(!solePk('operations','id') || !solePk('outboxes','id') || !solePk('control_schema','version') || !hasScopeUnique || !fk)
      throw new ControlStoreError('Incompatible control schema constraints','SCHEMA');
  }
  private validateStoredRecords(db:DatabaseSync) {
    const page=128;
    let last=0;
    for(;;) {
      const rows=db.prepare('SELECT rowid,* FROM operations WHERE rowid>? ORDER BY rowid LIMIT ?').all(last,page) as Record<string,unknown>[];
      if(!rows.length) break;
      for(const raw of rows) {
        last=raw.rowid as number;
        const op=this.operationRow(raw)!;
        const links=db.prepare('SELECT rowid,* FROM outboxes WHERE operation_id=? ORDER BY rowid LIMIT 2').all(op.id) as Record<string,unknown>[];
        if(links.length!==1) throw new ControlStoreError('Corrupt operation/outbox linkage','CORRUPT');
        const out=this.outboxRow(links[0])!;
        if(out.operationId!==op.id || out.projectId!==op.projectId || out.sessionId!==op.sessionId || out.receiptPresent!==op.receiptPresent || (op.receiptPresent && boundedJson(out.receipt)!==boundedJson(op.receipt)))
          throw new ControlStoreError('Corrupt operation/outbox linkage','CORRUPT');
        if(out.state==='delivered' && !out.receiptPresent) throw new ControlStoreError('Delivered outbox has no receipt evidence','CORRUPT');
      }
      if(rows.length<page) break;
    }
    last=0;
    for(;;) {
      const rows=db.prepare('SELECT rowid,* FROM outboxes WHERE rowid>? ORDER BY rowid LIMIT ?').all(last,page) as Record<string,unknown>[];
      if(!rows.length) break;
      for(const raw of rows) {
        last=raw.rowid as number;
        const out=this.outboxRow(raw)!;
        const links=db.prepare('SELECT rowid,* FROM operations WHERE id=? LIMIT 2').all(out.operationId) as Record<string,unknown>[];
        if(links.length!==1) throw new ControlStoreError('Corrupt outbox operation linkage','CORRUPT');
        const op=this.operationRow(links[0])!;
        if(op.projectId!==out.projectId || op.sessionId!==out.sessionId || (out.receiptPresent!==op.receiptPresent) || (out.receiptPresent && boundedJson(out.receipt)!==boundedJson(op.receipt)))
          throw new ControlStoreError('Corrupt outbox operation linkage','CORRUPT');
      }
      if(rows.length<page) break;
    }
  }
  /**
   * The schema version recorded in this live database. Readiness reports this instead of opening a
   * second connection, so the answer describes the handle the process is actually serving from.
   */
  schemaVersion():number {
    try {
      if(this.closed) throw new ControlStoreError('Control store is closed','SCHEMA');
      const row=this.db.prepare('SELECT version FROM control_schema').get() as {version?:unknown}|undefined;
      if(!row || !Number.isInteger(row.version)) throw new ControlStoreError('Control schema marker is missing or corrupt','SCHEMA');
      return row.version as number;
    } catch(error) {
      if(error instanceof ControlStoreError) throw error;
      throw new ControlStoreError('Control schema is unreadable','SCHEMA');
    }
  }
  private assertOpen(){if(this.closed)throw new Error('Control store is closed');}
  private transaction<T>(fn:()=>T):T {
    this.assertOpen();this.assertSafeDatabasePaths();this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); if(result && typeof (result as {then?:unknown}).then==='function') throw new Error('SQLite transaction callback must be synchronous'); this.db.exec('COMMIT'); return result; }
    catch(e){try{this.db.exec('ROLLBACK');}catch{} throw e;}
  }
  private operationRow(row:Record<string,unknown>|undefined):OperationRecord|undefined {
    if(!row)return;
    const value={version:CONTROL_RECORD_VERSION,id:row.id,projectId:row.project_id,sessionId:row.session_id,
      idempotencyKey:row.idempotency_key,kind:row.kind,inputDigest:row.input_digest,input:parseJson(jsonText(row.input_json,'operation input'),'operation input'),
      state:row.state,revision:row.revision,receipt:row.receipt_json===null?null:parseJson(jsonText(row.receipt_json,'operation receipt'),'operation receipt'),receiptPresent:row.receipt_json!==null,
      createdAt:row.created_at,updatedAt:row.updated_at};
    try{return validateOperationRecord(value);}catch(e){throw new ControlStoreError('Corrupt operation record: '+(e as Error).message,'CORRUPT');}
  }
  private outboxRow(row:Record<string,unknown>|undefined):OutboxRecord|undefined {
    if(!row)return;
    const value={version:CONTROL_RECORD_VERSION,id:row.id,operationId:row.operation_id,projectId:row.project_id,sessionId:row.session_id,
      kind:row.kind,payload:parseJson(jsonText(row.payload_json,'outbox payload'),'outbox payload'),state:row.state,revision:row.revision,
      receipt:row.receipt_json===null?null:parseJson(jsonText(row.receipt_json,'outbox receipt'),'outbox receipt'),receiptPresent:row.receipt_json!==null,createdAt:row.created_at,updatedAt:row.updated_at};
    try{return validateOutboxRecord(value);}catch(e){throw new ControlStoreError('Corrupt outbox record: '+(e as Error).message,'CORRUPT');}
  }
  admit(input:Admission):{operation:OperationRecord;outbox:OutboxRecord;existing:boolean} {
    const scope=validateScope(input.scope);
    try {
      if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.idempotencyKey)) throw new Error('Invalid idempotency key');
      if(!/^[a-z][a-z0-9.-]{0,79}$/.test(input.outbox.kind)) throw new Error('Invalid outbox kind');
      const digest=operationDigest(input.kind,{input:input.input,outbox:input.outbox}), inputJson=boundedJson(input.input);
      const payloadJson=boundedJson(input.outbox.payload);
      return this.transaction(()=>{
        const found=this.operationRow(this.db.prepare('SELECT * FROM operations WHERE project_id=? AND session_id=? AND idempotency_key=?').get(scope.projectId,scope.sessionId,input.idempotencyKey) as Record<string,unknown>|undefined);
        if(found) {
          if(found.inputDigest!==digest || found.kind!==input.kind) throw new ControlStoreError('Idempotency key was already used with different content','CONFLICT');
          const out=this.outboxRow(this.db.prepare('SELECT * FROM outboxes WHERE operation_id=?').get(found.id) as Record<string,unknown>|undefined);
          if(!out) throw new ControlStoreError('Operation has no corresponding outbox evidence','CORRUPT');
          if(out.operationId!==found.id || out.projectId!==scope.projectId || out.sessionId!==scope.sessionId)
            throw new ControlStoreError('Operation/outbox linkage is corrupt','CORRUPT');
          return {operation:found,outbox:out,existing:true};
        }
        const timestamp=now(), operationId=randomUUID(), outboxId=randomUUID();
        this.db.prepare('INSERT INTO operations(id,project_id,session_id,idempotency_key,kind,input_digest,input_json,state,revision,receipt_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,\'pending\',1,NULL,?,?)')
          .run(operationId,scope.projectId,scope.sessionId,input.idempotencyKey,input.kind,digest,inputJson,timestamp,timestamp);
        this.db.prepare('INSERT INTO outboxes(id,operation_id,project_id,session_id,kind,payload_json,state,revision,receipt_json,created_at,updated_at) VALUES(?,?,?,?,?,?,\'pending\',1,NULL,?,?)')
          .run(outboxId,operationId,scope.projectId,scope.sessionId,input.outbox.kind,payloadJson,timestamp,timestamp);
        const operation=this.operationRow(this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId) as Record<string,unknown>)!;
        const outbox=this.outboxRow(this.db.prepare('SELECT * FROM outboxes WHERE id=?').get(outboxId) as Record<string,unknown>)!;
        return {operation,outbox,existing:false};
      });
    } catch(e) { if(e instanceof ControlStoreError)throw e; throw new ControlStoreError((e as Error).message,'INVALID'); }
  }
  getOperation(id:string, scope:ControlScope):OperationRecord {
    this.assertOpen(); const s=validateScope(scope);
    const row=this.operationRow(this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Record<string,unknown>|undefined);
    if(!row) throw new ControlStoreError('Operation not found','NOT_FOUND');
    if(row.projectId!==s.projectId||row.sessionId!==s.sessionId) throw new ControlStoreError('Operation is outside requested scope','SCOPE');
    return row;
  }
  getOutbox(id:string, scope:ControlScope):OutboxRecord {
    this.assertOpen(); const s=validateScope(scope);
    const row=this.outboxRow(this.db.prepare('SELECT * FROM outboxes WHERE id=?').get(id) as Record<string,unknown>|undefined);
    if(!row) throw new ControlStoreError('Outbox not found','NOT_FOUND');
    if(row.projectId!==s.projectId||row.sessionId!==s.sessionId) throw new ControlStoreError('Outbox is outside requested scope','SCOPE');
    return row;
  }
  updateOperation(id:string,scope:ControlScope,expectedRevision:number,state:OperationState,receipt?:unknown):OperationRecord {
    const s=validateScope(scope), hasReceipt=receipt!==undefined, receiptJson=hasReceipt?boundedJson(receipt!):null;
    return this.transaction(()=>{
      const row=this.operationRow(this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Record<string,unknown>|undefined);
      if(!row)throw new ControlStoreError('Operation not found','NOT_FOUND');
      if(row.projectId!==s.projectId||row.sessionId!==s.sessionId)throw new ControlStoreError('Operation is outside requested scope','SCOPE');
      if(row.revision!==expectedRevision)throw new ControlStoreError('Stale operation revision','CONFLICT');
      if(!isLegalOperationTransition(row.state,state))throw new ControlStoreError('Illegal operation state transition','CONFLICT');
      let linkedOutbox:OutboxRecord|undefined;
      if(hasReceipt) {
        linkedOutbox=this.outboxRow(this.db.prepare('SELECT * FROM outboxes WHERE operation_id=?').get(row.id) as Record<string,unknown>|undefined);
        if(!linkedOutbox || linkedOutbox.operationId!==row.id || linkedOutbox.projectId!==s.projectId || linkedOutbox.sessionId!==s.sessionId)
          throw new ControlStoreError('Operation/outbox linkage is corrupt','CORRUPT');
        if((row.receiptPresent && boundedJson(row.receipt)!==receiptJson) ||
          (linkedOutbox.receiptPresent && boundedJson(linkedOutbox.receipt)!==receiptJson))
          throw new ControlStoreError('Receipt conflicts with existing evidence','CONFLICT');
      }
      const timestamp=now();this.db.prepare('UPDATE operations SET state=?,revision=revision+1,receipt_json=COALESCE(?,receipt_json),updated_at=? WHERE id=? AND revision=?')
        .run(state,receiptJson,timestamp,id,expectedRevision);
      if(hasReceipt && linkedOutbox && !linkedOutbox.receiptPresent)
        this.db.prepare('UPDATE outboxes SET receipt_json=?,revision=revision+1,updated_at=? WHERE id=?').run(receiptJson,timestamp,linkedOutbox.id);
      return this.operationRow(this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Record<string,unknown>)!;
    });
  }
  acknowledgeOutbox(id:string,scope:ControlScope,expectedRevision:number,receipt:unknown):{outbox:OutboxRecord;operation:OperationRecord} {
    const s=validateScope(scope),receiptJson=boundedJson(receipt);
    return this.transaction(()=>{
      const out=this.outboxRow(this.db.prepare('SELECT * FROM outboxes WHERE id=?').get(id) as Record<string,unknown>|undefined);
      if(!out)throw new ControlStoreError('Outbox not found','NOT_FOUND');
      if(out.projectId!==s.projectId||out.sessionId!==s.sessionId)throw new ControlStoreError('Outbox is outside requested scope','SCOPE');
      const op=this.operationRow(this.db.prepare('SELECT * FROM operations WHERE id=?').get(out.operationId) as Record<string,unknown>|undefined);
      if(!op || op.projectId!==s.projectId || op.sessionId!==s.sessionId || out.operationId!==op.id)
        throw new ControlStoreError('Outbox operation linkage is corrupt','CORRUPT');
      if((out.receiptPresent && boundedJson(out.receipt)!==receiptJson) ||
        (op.receiptPresent && boundedJson(op.receipt)!==receiptJson))
        throw new ControlStoreError('Receipt conflicts with existing evidence','CONFLICT');
      if(out.state==='delivered') {
        if(!out.receiptPresent) throw new ControlStoreError('Delivered outbox has no receipt evidence','CORRUPT');
        if(!op.receiptPresent) {
          const timestamp=now();
          this.db.prepare('UPDATE operations SET receipt_json=?,revision=revision+1,updated_at=? WHERE id=?').run(receiptJson,timestamp,op.id);
          return {outbox:out,operation:this.operationRow(this.db.prepare('SELECT * FROM operations WHERE id=?').get(op.id) as Record<string,unknown>)!};
        }
        return {outbox:out,operation:op};
      }
      if(out.revision!==expectedRevision)throw new ControlStoreError('Stale outbox revision','CONFLICT');
      const timestamp=now();
      this.db.prepare("UPDATE outboxes SET state='delivered',revision=revision+1,receipt_json=?,updated_at=? WHERE id=? AND revision=?")
        .run(receiptJson,timestamp,id,expectedRevision);
      this.db.prepare('UPDATE operations SET receipt_json=?,revision=revision+1,updated_at=? WHERE id=?').run(receiptJson,timestamp,op.id);
      return {outbox:this.outboxRow(this.db.prepare('SELECT * FROM outboxes WHERE id=?').get(id) as Record<string,unknown>)!,
        operation:this.operationRow(this.db.prepare('SELECT * FROM operations WHERE id=?').get(op.id) as Record<string,unknown>)!};
    });
  }
  close(){if(!this.closed){this.db.close();this.closed=true;}}
}
