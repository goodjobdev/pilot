import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod,mkdir,mkdtemp,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore,ControlStoreError,operationDigest } from '../../src/server/state/control-store';
import { CONTROL_MAX_JSON_BYTES,boundedJson,canonicalJson } from '../../src/shared/control-state';

const scope={projectId:'project-a',sessionId:'session-a'};
function admission(key='request-1', input:unknown={text:'hello'}) {
  return {scope,idempotencyKey:key,kind:'agent.input',input,outbox:{kind:'agent.delivery',payload:{text:'hello'}}};
}
async function fixture(fn:(root:string)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'pilot-control-'));
  try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}
}
function malformedSchema(path:string,kind:'partial'|'composite'|'affinity'|'foreign') {
 const db=new DatabaseSync(path);
 const opId=kind==='affinity'?'id INTEGER NOT NULL':'id TEXT NOT NULL';
 const opPk=kind==='composite'?'PRIMARY KEY(id,project_id)':'PRIMARY KEY(id)';
 db.exec(`CREATE TABLE control_schema(version INTEGER PRIMARY KEY); INSERT INTO control_schema VALUES(1);
 CREATE TABLE operations(${opId},project_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,kind TEXT NOT NULL,input_digest TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,${opPk});
 CREATE TABLE outboxes(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(${kind==='foreign'?'project_id':'id'}),project_id TEXT NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 ${kind==='partial'?'CREATE UNIQUE INDEX scoped_partial ON operations(project_id,session_id,idempotency_key) WHERE 0;':'CREATE UNIQUE INDEX scoped ON operations(project_id,session_id,idempotency_key);'}`);
 db.close();
}

test('a freshly admitted record carries no receipt evidence, before and after reopen',async()=>{
 await fixture(async root=>{
  let store=new ControlStore(root);
  const first=store.admit(admission('absent-evidence'));
  assert.equal(first.existing,false);
  assert.equal(first.operation.receiptPresent,false);
  assert.equal(first.operation.receipt,null);
  assert.equal(first.outbox.receiptPresent,false);
  assert.equal(first.outbox.receipt,null);
  const read=store.getOperation(first.operation.id,scope),readOut=store.getOutbox(first.outbox.id,scope);
  // Absent evidence is reported as absent, not merely as a null that could be a parsed null.
  assert.equal('receipt' in read,true);assert.equal(read.receiptPresent,false);assert.equal(read.receipt,null);
  assert.equal(readOut.receiptPresent,false);assert.equal(readOut.receipt,null);
  assert.notEqual(JSON.stringify(read.receiptPresent),'undefined');
  store.close();
  store=new ControlStore(root);
  const reopenedOp=store.getOperation(first.operation.id,scope),reopenedOut=store.getOutbox(first.outbox.id,scope);
  assert.equal(reopenedOp.receiptPresent,false);assert.equal(reopenedOp.receipt,null);
  assert.equal(reopenedOut.receiptPresent,false);assert.equal(reopenedOut.receipt,null);
  store.close();
 });
});

test('operation and outbox survive close/reopen; acknowledgement receipt persists on reopen',async()=>{
 await fixture(async root=>{
  let store=new ControlStore(root);
  const admitted=store.admit(admission());
  assert.equal(admitted.existing,false);
  store.close();
  store=new ControlStore(root);
  const op=store.getOperation(admitted.operation.id,scope), out=store.getOutbox(admitted.outbox.id,scope);
  assert.equal(op.id,admitted.operation.id);assert.equal(out.operationId,op.id);
  const ack=store.acknowledgeOutbox(out.id,scope,out.revision,{deliveryId:'synthetic-1'});
  assert.equal(ack.outbox.state,'delivered');assert.deepEqual(ack.operation.receipt,{deliveryId:'synthetic-1'});
  const retry=store.acknowledgeOutbox(out.id,scope,1,{deliveryId:'synthetic-1'});
  assert.equal(retry.outbox.revision,2);
  assert.throws(()=>store.acknowledgeOutbox(out.id,scope,1,{deliveryId:'other'}),/conflicts/);
  store.close();
  store=new ControlStore(root);
  assert.deepEqual(store.getOperation(op.id,scope).receipt,{deliveryId:'synthetic-1'});
  assert.deepEqual(store.getOutbox(out.id,scope).receipt,{deliveryId:'synthetic-1'});
  store.close();
 });
});

test('tampered valid JSON is refused on idempotent admission and on reopen',async()=>{
 for(const column of ['input_json','payload_json'] as const)await fixture(async root=>{
  const store=new ControlStore(root),result=store.admit(admission());
  if(column==='input_json')store.db.prepare('UPDATE operations SET input_json=? WHERE id=?').run('{"text":"tampered"}',result.operation.id);
  else store.db.prepare('UPDATE outboxes SET payload_json=? WHERE id=?').run('{"text":"tampered"}',result.outbox.id);
  assert.throws(()=>store.admit(admission()),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT');
  store.close();assert.throws(()=>new ControlStore(root),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT'&&/digest/.test(e.message));
 });
});

test('duplicate admission refuses a delivered outbox without a receipt',async()=>{
 await fixture(async root=>{
  const store=new ControlStore(root),result=store.admit(admission());
  store.db.prepare("UPDATE outboxes SET state='delivered' WHERE id=?").run(result.outbox.id);
  assert.throws(()=>store.admit(admission()),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT');
  store.close();assert.throws(()=>new ControlStore(root),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT');
 });
});

test('HEAD-format fixture reopens historically reachable states with every record field preserved',async()=>{
 await fixture(async root=>{
  const path=join(root,'control.sqlite'),db=new DatabaseSync(path);
  // Provenance: git show 0cc6b82:src/server/state/control-store.ts. The schema and records
  // below are constructed from its initializeNew(), admit(), updateOperation(), and
  // acknowledgeOutbox() SQL/formulas. This is not an execution of the historical TypeScript.
  // Reachability: each row starts at admit()'s (operation,outbox) revisions (1,1). The settled
  // row applies updateOperation('succeeded') => (2,1). The delivered row acknowledges first
  // => (2,2) with matching receipt, then updateOperation('succeeded') => (3,2), retaining it.
  db.exec(`CREATE TABLE control_schema(version INTEGER PRIMARY KEY CHECK(version = 1));
   CREATE TABLE operations(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    kind TEXT NOT NULL, input_digest TEXT NOT NULL, input_json TEXT NOT NULL, state TEXT NOT NULL,
    revision INTEGER NOT NULL, receipt_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(project_id,session_id,idempotency_key));
   CREATE TABLE outboxes(
    id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), project_id TEXT NOT NULL,
    session_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
    revision INTEGER NOT NULL, receipt_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   INSERT INTO control_schema(version) VALUES(1);`);
  const createdAt='2025-01-02T03:04:05.000Z',deliveredAt='2025-01-02T03:05:05.000Z',settledAt='2025-01-02T03:06:05.000Z';
  const rows=[
   {id:'historical-pending',key:'historical-pending',digest:'34946665b5cb93a1abc42545ae947f810d33481f66d40e96e4315919c2f528d9',state:'pending',revision:1,updatedAt:createdAt,outState:'pending',outRevision:1,outUpdatedAt:createdAt,receipt:null},
   {id:'historical-settled',key:'historical-settled',digest:'abcafd5b03a62a1ffd509c4fb72bc887a7b5a94c5a931ea6bbd14bf33f897c58',state:'succeeded',revision:2,updatedAt:settledAt,outState:'pending',outRevision:1,outUpdatedAt:createdAt,receipt:null},
   {id:'historical-delivered',key:'historical-delivered',digest:'98689167b13d58e9df93712c3059006e936a0410f235e94733f0f6092d546c0e',state:'succeeded',revision:3,updatedAt:settledAt,outState:'delivered',outRevision:2,outUpdatedAt:deliveredAt,receipt:{deliveryId:'historical-receipt'}}
  ];
  for(const row of rows){
   const input={text:row.key},payload={text:'hello'},outboxKind='agent.delivery';
   const receipt=row.receipt===null?null:JSON.stringify(row.receipt);
   db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,scope.projectId,scope.sessionId,row.key,'agent.input',row.digest,JSON.stringify(input),row.state,row.revision,receipt,createdAt,row.updatedAt);
   db.prepare('INSERT INTO outboxes VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('outbox-'+row.id,row.id,scope.projectId,scope.sessionId,outboxKind,JSON.stringify(payload),row.outState,row.outRevision,receipt,createdAt,row.outUpdatedAt);
  }
  db.close();await chmod(path,0o600);
  const reopened=new ControlStore(root);
  for(const row of rows){
   const op=reopened.getOperation(row.id,scope),out=reopened.getOutbox('outbox-'+row.id,scope);
   assert.equal(op.id,row.id);assert.equal(op.projectId,scope.projectId);assert.equal(op.sessionId,scope.sessionId);
   assert.equal(op.idempotencyKey,row.key);assert.equal(op.kind,'agent.input');assert.equal(op.inputDigest,row.digest);
   assert.deepEqual(op.input,{text:row.key});assert.equal(op.state,row.state);assert.equal(op.revision,row.revision);
   assert.equal(op.createdAt,createdAt);assert.equal(op.updatedAt,row.updatedAt);
   assert.equal(op.receiptPresent,row.receipt!==null);assert.deepEqual(op.receipt,row.receipt);
   assert.equal(out.id,'outbox-'+row.id);assert.equal(out.operationId,op.id);
   assert.equal(out.projectId,scope.projectId);assert.equal(out.sessionId,scope.sessionId);
   assert.equal(out.kind,'agent.delivery');assert.deepEqual(out.payload,{text:'hello'});
   assert.equal(out.state,row.outState);assert.equal(out.revision,row.outRevision);
   assert.equal(out.createdAt,createdAt);assert.equal(out.updatedAt,row.outUpdatedAt);
   assert.equal(out.receiptPresent,row.receipt!==null);assert.deepEqual(out.receipt,row.receipt);
  }
  reopened.close();
 });
});

test('tampered valid JSON is refused on idempotent admission and on reopen',async()=>{
 for(const column of ['input_json','payload_json'] as const)await fixture(async root=>{
  const store=new ControlStore(root),result=store.admit(admission());
  if(column==='input_json')store.db.prepare('UPDATE operations SET input_json=? WHERE id=?').run('{"text":"tampered"}',result.operation.id);
  else store.db.prepare('UPDATE outboxes SET payload_json=? WHERE id=?').run('{"text":"tampered"}',result.outbox.id);
  assert.throws(()=>store.admit(admission()),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT');
  store.close();assert.throws(()=>new ControlStore(root),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT'&&/digest/.test(e.message));
 });
});

test('duplicate admission refuses a delivered outbox without a receipt',async()=>{
 await fixture(async root=>{
  const store=new ControlStore(root),result=store.admit(admission());
  store.db.prepare("UPDATE outboxes SET state='delivered' WHERE id=?").run(result.outbox.id);
  assert.throws(()=>store.admit(admission()),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT');
  store.close();assert.throws(()=>new ControlStore(root),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT');
 });
});

test('stable scoped idempotency returns existing record and conflicting content rejects',async()=>{
 await fixture(async root=>{
  const store=new ControlStore(root);
  const first=store.admit(admission());
  const duplicate=store.admit(admission());
  assert.equal(duplicate.existing,true);assert.equal(duplicate.operation.id,first.operation.id);
  assert.throws(()=>store.admit(admission('request-1',{text:'changed'})),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CONFLICT');
  assert.throws(()=>store.admit({...admission(),outbox:{kind:'agent.delivery',payload:{text:'changed'}}}),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CONFLICT');
  assert.notEqual(operationDigest('agent.input',{b:2,a:1}),operationDigest('agent.input',{b:2,a:2}));
  assert.equal(canonicalJson({b:2,a:1}),canonicalJson({a:1,b:2}));
  store.close();
 });
});

test('operation revisions enforce legal transitions and prevent cross-scope access',async()=>{
 await fixture(async root=>{
  const store=new ControlStore(root), result=store.admit(admission());
  assert.throws(()=>store.getOperation(result.operation.id,{projectId:'project-b',sessionId:'session-a'}),/outside requested scope/);
  assert.throws(()=>store.getOutbox(result.outbox.id,{projectId:'project-a',sessionId:'session-b'}),/outside requested scope/);
  assert.throws(()=>store.updateOperation(result.operation.id,scope,2,'succeeded'),/Stale/);
  const changed=store.updateOperation(result.operation.id,scope,1,'unknown');
  assert.equal(changed.revision,2);
  assert.throws(()=>store.updateOperation(result.operation.id,scope,2,'pending'),/Illegal/);
  const reconciled=store.updateOperation(result.operation.id,scope,2,'succeeded',{receipt:'resolved'});
  assert.equal(reconciled.state,'succeeded');assert.equal(reconciled.revision,3);
  store.close();
 });
});

test('failed operation/outbox transaction leaves neither admitted',async()=>{
 await fixture(async root=>{
  const store=new ControlStore(root);
  store.db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON outboxes BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END;");
  assert.throws(()=>store.admit(admission()),/synthetic outbox failure/);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM operations').get() as {n:number}).n,0);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM outboxes').get() as {n:number}).n,0);
  store.close();
 });
});

test('newer, duplicate-marker, missing-marker and incompatible schemas fail closed without reset',async()=>{
 await fixture(async root=>{
  const path=join(root,'control.sqlite'), db=new DatabaseSync(path);
  db.exec('CREATE TABLE control_schema(version INTEGER NOT NULL); INSERT INTO control_schema VALUES(99);');
  db.close(); await chmod(path,0o600);
  const before=await readFile(path);
  assert.throws(()=>new ControlStore(root),/newer than this Pilot build/);
  assert.deepEqual(await readFile(path),before);
  const check=new DatabaseSync(path);assert.equal((check.prepare('SELECT version FROM control_schema').get() as {version:number}).version,99);check.close();
 });
 await fixture(async root=>{
  const path=join(root,'control.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE operations(id TEXT);');db.close();await chmod(path,0o600);
  assert.throws(()=>new ControlStore(root),/Unmarked control database/);
 });
 await fixture(async root=>{
  const path=join(root,'control.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE control_schema(version); INSERT INTO control_schema VALUES(0);');db.close();await chmod(path,0o600);
  assert.throws(()=>new ControlStore(root),/Unsupported control schema version/);
 });
});

test('duplicate or mixed markers and incomplete schemas reject without modifying bytes',async()=>{
 await fixture(async root=>{
  const path=join(root,'control.sqlite'),db=new DatabaseSync(path);
  db.exec('CREATE TABLE control_schema(version INTEGER NOT NULL); INSERT INTO control_schema VALUES(1),(99);');db.close();await chmod(path,0o600);
  const before=await readFile(path);
  assert.throws(()=>new ControlStore(root),/duplicate or corrupt/);
  assert.deepEqual(await readFile(path),before);
 });
 await fixture(async root=>{
  const path=join(root,'control.sqlite'),db=new DatabaseSync(path);
  db.exec('CREATE TABLE control_schema(version INTEGER); INSERT INTO control_schema VALUES(1); CREATE TABLE operations(id TEXT); CREATE TABLE outboxes(id TEXT);');db.close();await chmod(path,0o600);
  const before=await readFile(path);
  assert.throws(()=>new ControlStore(root),/(Incomplete|Nullable required column)/);
  assert.deepEqual(await readFile(path),before);
 });
 await fixture(async root=>{
  const path=join(root,'control.sqlite'),db=new DatabaseSync(path);
  db.exec(`CREATE TABLE control_schema(version INTEGER PRIMARY KEY); INSERT INTO control_schema VALUES(1);
    CREATE TABLE operations(id TEXT NOT NULL,project_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,kind TEXT NOT NULL,input_digest TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE outboxes(id TEXT NOT NULL,operation_id TEXT NOT NULL,project_id TEXT NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  db.close();await chmod(path,0o600);
  assert.throws(()=>new ControlStore(root),/constraints/);
 });
});

test('read-only schema compatibility rejects partial uniqueness, composite PK, wrong affinity and malformed FK unchanged',async()=>{
 for(const kind of ['partial','composite','affinity','foreign'] as const) await fixture(async root=>{
  const path=join(root,'control.sqlite');malformedSchema(path,kind);await chmod(path,0o600);
  const before=await readFile(path);
  assert.throws(()=>new ControlStore(root),/Incompatible control schema constraints|Wrong control column type/);
  assert.deepEqual(await readFile(path),before);
 });
});

test('a NOT NULL receipt column is refused up front instead of being accepted and then failing every admission',async()=>{
 for(const table of ['operations','outboxes'] as const) await fixture(async root=>{
  const path=join(root,'control.sqlite'),db=new DatabaseSync(path);
  const operations=`CREATE TABLE operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,kind TEXT NOT NULL,input_digest TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,receipt_json TEXT${table==='operations'?' NOT NULL':''},created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,session_id,idempotency_key))`;
  const outboxes=`CREATE TABLE outboxes(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id),project_id TEXT NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,receipt_json TEXT${table==='outboxes'?' NOT NULL':''},created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`;
  db.exec('CREATE TABLE control_schema(version INTEGER PRIMARY KEY); INSERT INTO control_schema VALUES(1);'+operations+';'+outboxes+';');
  db.close();await chmod(path,0o600);
  const before=await readFile(path);
  // A required receipt would accept the schema and then reject the first admission, so the reopen
  // predicate requires the evidence column to be nullable.
  assert.throws(()=>new ControlStore(root),(e:unknown)=>e instanceof ControlStoreError&&e.code==='SCHEMA'&&new RegExp('Required receipt column in control table: '+table).test((e as Error).message));
  assert.deepEqual(await readFile(path),before);
 });
});

test('WITHOUT ROWID control tables are a schema verdict, not a raw driver error',async()=>{
 await fixture(async root=>{
  const path=join(root,'control.sqlite'),db=new DatabaseSync(path);
  // Every column predicate holds, but there is no rowid for the record scan; without an explicit
  // rejection this would surface as an untyped SqliteError from the constructor.
  db.exec(`CREATE TABLE control_schema(version INTEGER PRIMARY KEY) WITHOUT ROWID;
   CREATE TABLE operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,kind TEXT NOT NULL,input_digest TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,session_id,idempotency_key)) WITHOUT ROWID;
   CREATE TABLE outboxes(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id),project_id TEXT NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,receipt_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL) WITHOUT ROWID;
   INSERT INTO control_schema VALUES(1);`);
  db.close();await chmod(path,0o600);
  const before=await readFile(path);
  assert.throws(()=>new ControlStore(root),(e:unknown)=>e instanceof ControlStoreError&&e.code==='SCHEMA'&&/WITHOUT ROWID/.test((e as Error).message));
  assert.deepEqual(await readFile(path),before);
 });
});

test('an oversized stored column is refused on its raw bytes before any parse',async()=>{
 await fixture(async root=>{
  let store=new ControlStore(root);
  const first=store.admit(admission('raw-cap'));
  // Deliberately not JSON at all: a parse-first implementation would report malformed JSON, while
  // the size cap must be decided on the stored text.
  const oversized='x'.repeat(CONTROL_MAX_JSON_BYTES+1);
  store.db.prepare('UPDATE outboxes SET payload_json=? WHERE id=?').run(oversized,first.outbox.id);
  assert.throws(()=>store.getOutbox(first.outbox.id,scope),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT'&&/exceeds 65536 bytes/.test((e as Error).message)&&!/JSON/.test((e as Error).message));
  store.close();
  const path=join(root,'control.sqlite'),before=await readFile(path);
  assert.throws(()=>new ControlStore(root),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CORRUPT'&&/exceeds 65536 bytes/.test((e as Error).message));
  assert.deepEqual(await readFile(path),before);
 });
});

test('database and SQLite sidecar symlinks/nonregular paths fail before target mutation',async()=>{
 await fixture(async root=>{
  const outside=await mkdtemp(join(tmpdir(),'pilot-control-outside-'));
  try {
   const target=join(outside,'target.sqlite'),db=new DatabaseSync(target);db.close();await chmod(target,0o600);
   const before=await readFile(target);await symlink(target,join(root,'control.sqlite'));
   assert.throws(()=>new ControlStore(root),/Unsafe control database/);
   assert.deepEqual(await readFile(target),before);
  } finally {await rm(outside,{recursive:true,force:true});}
 });
 await fixture(async root=>{
  const outside=await mkdtemp(join(tmpdir(),'pilot-control-sidecar-'));
  try {
   const target=join(outside,'sidecar'),db=new DatabaseSync(join(root,'control.sqlite'));db.close();
   await chmod(join(root,'control.sqlite'),0o600);await symlink(target,join(root,'control.sqlite-wal'));
   assert.throws(()=>new ControlStore(root),/Unsafe control database/);
   await assert.rejects(()=>readFile(target),{code:'ENOENT'});
  } finally {await rm(outside,{recursive:true,force:true});}
 });
 await fixture(async root=>{
  const path=join(root,'control.sqlite'); await mkdir(path);
  assert.throws(()=>new ControlStore(root),/Unsafe control database/);
 });
 await fixture(async root=>{
  const linked=join(root,'linked-root');await symlink(root,linked,'dir');
  assert.throws(()=>new ControlStore(linked),/real directory/);
 });
 await fixture(async root=>{
  const path=join(root,'control.sqlite'),db=new DatabaseSync(path);db.close();await chmod(path,0o644);
  assert.throws(()=>new ControlStore(root),/private permissions/);
 });
});

test('canonical JSON preserves dangerous own keys and bounds them before identity',async()=>{
 const dangerous=JSON.parse('{"__proto__":{"value":1},"constructor":2,"0":"zero"}');
 assert.equal(canonicalJson(dangerous),'{"0":"zero","__proto__":{"value":1},"constructor":2}');
 assert.notEqual(operationDigest('agent.input',JSON.parse('{"__proto__":{"value":1}}')),operationDigest('agent.input',JSON.parse('{"__proto__":{"value":2}}')));
 await fixture(async root=>{
  const store=new ControlStore(root);
  const first=store.admit(admission('proto',JSON.parse('{"__proto__":{"value":1}}')));
  assert.deepEqual(JSON.parse(JSON.stringify(first.operation.input)),JSON.parse('{"__proto__":{"value":1}}'));
  assert.throws(()=>store.admit(admission('proto',JSON.parse('{"__proto__":{"value":2}}'))),(e:unknown)=>e instanceof ControlStoreError&&e.code==='CONFLICT');
  store.close();
 });
 const oversize=JSON.parse('{"__proto__":"'+('x'.repeat(CONTROL_MAX_JSON_BYTES))+'"}');
 assert.throws(()=>boundedJson(oversize),/exceeds/);
});

test('receipt evidence conflicts in either write order without partial updates; equal evidence reconciles',async()=>{
 await fixture(async root=>{
  const store=new ControlStore(root), first=store.admit(admission('receipt-a'));
  const op=store.updateOperation(first.operation.id,scope,1,'failed',{proof:'A'});
  const out=store.getOutbox(first.outbox.id,scope);
  assert.deepEqual(out.receipt,{proof:'A'});
  assert.throws(()=>store.acknowledgeOutbox(out.id,scope,out.revision,{proof:'B'}),/Receipt conflicts/);
  assert.deepEqual(store.getOperation(op.id,scope),op);
  assert.deepEqual(store.getOutbox(out.id,scope),out);
  const same=store.acknowledgeOutbox(out.id,scope,out.revision,{proof:'A'});
  assert.deepEqual(same.operation.receipt,{proof:'A'});
  assert.deepEqual(same.outbox.receipt,{proof:'A'});
  store.close();
 });
 await fixture(async root=>{
  const store=new ControlStore(root), first=store.admit(admission('receipt-b'));
  const ack=store.acknowledgeOutbox(first.outbox.id,scope,first.outbox.revision,{proof:'A'});
  assert.throws(()=>store.updateOperation(ack.operation.id,scope,ack.operation.revision,'failed',{proof:'B'}),/Receipt conflicts/);
  assert.deepEqual(store.getOperation(ack.operation.id,scope),ack.operation);
  assert.deepEqual(store.getOutbox(ack.outbox.id,scope),ack.outbox);
  const same=store.updateOperation(ack.operation.id,scope,ack.operation.revision,'failed',{proof:'A'});
  assert.deepEqual(same.receipt,{proof:'A'});
  store.close();
 });
});

test('corrupt cross-scope links reject admission retries and acknowledgements without mutation',async()=>{
 for(const field of ['project_id','session_id'] as const) await fixture(async root=>{
  const store=new ControlStore(root), first=store.admit(admission('corrupt-'+field));
  store.db.prepare(`UPDATE outboxes SET ${field}=? WHERE id=?`).run(field==='project_id'?'project-b':'session-b',first.outbox.id);
  const before=store.db.prepare('SELECT * FROM outboxes WHERE id=?').get(first.outbox.id);
  assert.throws(()=>store.admit(admission('corrupt-'+field)),/linkage is corrupt/);
  assert.deepEqual(store.db.prepare('SELECT * FROM outboxes WHERE id=?').get(first.outbox.id),before);
  store.close();
 });
 for(const field of ['project_id','session_id'] as const) await fixture(async root=>{
  const store=new ControlStore(root), first=store.admit(admission('linked-'+field));
  store.db.prepare(`UPDATE operations SET ${field}=? WHERE id=?`).run(field==='project_id'?'project-b':'session-b',first.operation.id);
  const opBefore=store.db.prepare('SELECT * FROM operations WHERE id=?').get(first.operation.id);
  const outBefore=store.db.prepare('SELECT * FROM outboxes WHERE id=?').get(first.outbox.id);
  assert.throws(()=>store.acknowledgeOutbox(first.outbox.id,scope,first.outbox.revision,{proof:'x'}),/linkage is corrupt/);
  assert.deepEqual(store.db.prepare('SELECT * FROM operations WHERE id=?').get(first.operation.id),opBefore);
  assert.deepEqual(store.db.prepare('SELECT * FROM outboxes WHERE id=?').get(first.outbox.id),outBefore);
  store.close();
 });
});

test('null receipts are durable evidence, reconcile identically, and conflict in either write order',async()=>{
 for(const order of ['operation-first','outbox-first'] as const) await fixture(async root=>{
  let store=new ControlStore(root);const first=store.admit(admission('null-'+order));
  if(order==='operation-first') {
   store.updateOperation(first.operation.id,scope,1,'failed',null);
   const out=store.getOutbox(first.outbox.id,scope);
   const beforeOp=store.getOperation(first.operation.id,scope),beforeOut=out;
   assert.equal(beforeOp.receiptPresent,true);assert.equal(beforeOut.receiptPresent,true);
   assert.throws(()=>store.acknowledgeOutbox(out.id,scope,out.revision,{proof:'conflict'}),/Receipt conflicts/);
   assert.deepEqual(store.getOperation(beforeOp.id,scope),beforeOp);assert.deepEqual(store.getOutbox(out.id,scope),beforeOut);
   const same=store.acknowledgeOutbox(out.id,scope,out.revision,null);assert.equal(same.operation.receiptPresent,true);
   const deliveredRetry=store.acknowledgeOutbox(out.id,scope,out.revision,null);assert.deepEqual(deliveredRetry,same);
  } else {
   const ack=store.acknowledgeOutbox(first.outbox.id,scope,first.outbox.revision,null);
   const beforeOp=ack.operation,beforeOut=ack.outbox;
   assert.equal(beforeOp.receiptPresent,true);assert.equal(beforeOut.receiptPresent,true);
   assert.throws(()=>store.updateOperation(beforeOp.id,scope,beforeOp.revision,'failed',{proof:'conflict'}),/Receipt conflicts/);
   assert.deepEqual(store.getOperation(beforeOp.id,scope),beforeOp);assert.deepEqual(store.getOutbox(beforeOut.id,scope),beforeOut);
   const retry=store.acknowledgeOutbox(beforeOut.id,scope,1,null);assert.deepEqual(retry.operation,ack.operation);assert.deepEqual(retry.outbox,ack.outbox);
  }
  store.close();store=new ControlStore(root);
  const op=store.getOperation(first.operation.id,scope),out=store.getOutbox(first.outbox.id,scope);
  assert.equal(op.receiptPresent,true);assert.equal(out.receiptPresent,true);
  assert.equal(JSON.stringify(op.receipt),'null');assert.equal(JSON.stringify(out.receipt),'null');
  store.close();
 });
});

test('dangerous parsed receipt keys preserve identity and conflict symmetrically across reopen',async()=>{
 await fixture(async root=>{
  const one=JSON.parse('{"__proto__":{"nested":{"value":1}}}'),two=JSON.parse('{"__proto__":{"nested":{"value":2}}}');
  let store=new ControlStore(root);const first=store.admit(admission('proto-receipt'));
  const op=store.updateOperation(first.operation.id,scope,1,'unknown',one);
  assert.deepEqual(JSON.parse(JSON.stringify(op.receipt)),one);
  const out=store.getOutbox(first.outbox.id,scope),same=store.acknowledgeOutbox(out.id,scope,out.revision,one);
  assert.deepEqual(same.operation.receipt,one);assert.deepEqual(same.outbox.receipt,one);
  assert.throws(()=>store.acknowledgeOutbox(same.outbox.id,scope,same.outbox.revision,two),/Receipt conflicts/);
  assert.deepEqual(store.getOperation(op.id,scope),same.operation);assert.deepEqual(store.getOutbox(out.id,scope),same.outbox);
  store.close();store=new ControlStore(root);
  const reopenedOp=store.getOperation(op.id,scope),reopenedOut=store.getOutbox(out.id,scope);
  assert.deepEqual(JSON.parse(JSON.stringify(reopenedOp.receipt)),one);
  assert.throws(()=>store.updateOperation(op.id,scope,reopenedOp.revision,'succeeded',two),/Receipt conflicts/);
  assert.deepEqual(store.getOperation(op.id,scope),reopenedOp);assert.deepEqual(store.getOutbox(out.id,scope),reopenedOut);
  store.close();
 });
});

test('corrupt records and oversized or malformed payloads are rejected',async()=>{
 await fixture(async root=>{
  const store=new ControlStore(root);
  assert.throws(()=>store.admit(admission('large',{text:'x'.repeat(CONTROL_MAX_JSON_BYTES)})),/exceeds/);
  const circular:Record<string,unknown>={};circular.self=circular;
  assert.throws(()=>store.admit(admission('cycle',circular)),/bounded JSON/);
  assert.throws(()=>store.admit(admission('sparse',[,1])),/bounded JSON/);
  const accessor={};Object.defineProperty(accessor,'value',{get(){return 1;},enumerable:true});
  assert.throws(()=>store.admit(admission('accessor',accessor)),/bounded JSON/);
  let getterCalls=0;const array=[0];Object.defineProperty(array,'0',{get(){getterCalls++;return 1;},enumerable:true,configurable:true});
  assert.throws(()=>store.admit(admission('array-accessor',array)),/bounded JSON/);
  assert.equal(getterCalls,0);
  assert.equal((store.db.prepare("SELECT count(*) AS n FROM operations WHERE idempotency_key='array-accessor'").get() as {n:number}).n,0);
  assert.equal((store.db.prepare("SELECT count(*) AS n FROM outboxes").get() as {n:number}).n,0);
  const malformed=store.admit(admission());
  store.db.prepare("UPDATE operations SET input_json='{' WHERE id=?").run(malformed.operation.id);
  assert.throws(()=>store.getOperation(malformed.operation.id,scope),/Corrupt operation input JSON/);
  store.close();
 });
});

test('startup validation includes zero and negative operation and outbox rowids',async()=>{
 for(const rowid of [-1,0]) for(const corruption of ['none','operation','outbox'] as const) await fixture(async root=>{
  let store=new ControlStore(root);const first=store.admit(admission('nonpositive'));
  store.db.prepare('UPDATE operations SET rowid=? WHERE id=?').run(rowid,first.operation.id);
  store.db.prepare('UPDATE outboxes SET rowid=? WHERE id=?').run(rowid,first.outbox.id);
  if(corruption==='operation') store.db.prepare("UPDATE operations SET input_json='{' WHERE id=?").run(first.operation.id);
  if(corruption==='outbox') store.db.prepare("UPDATE outboxes SET payload_json='{' WHERE id=?").run(first.outbox.id);
  store.close();
  if(corruption==='none') {store=new ControlStore(root);assert.equal(store.getOperation(first.operation.id,scope).id,first.operation.id);store.close();}
  else assert.throws(()=>new ControlStore(root),/Corrupt/);
 });
});

test('startup validation reaches both sides of its 128-row page boundary',async()=>{
 for(const table of ['operations','outboxes'] as const) for(const index of [127,128]) await fixture(async root=>{
  const store=new ControlStore(root), rows=[];
  for(let i=0;i<130;i++) rows.push(store.admit(admission('page-'+i)));
  for(let i=0;i<130;i++) {
   store.db.prepare('UPDATE operations SET rowid=? WHERE id=?').run(i-130,rows[i].operation.id);
   store.db.prepare('UPDATE outboxes SET rowid=? WHERE id=?').run(i-130,rows[i].outbox.id);
  }
  if(table==='operations') store.db.prepare("UPDATE operations SET input_json='{' WHERE id=?").run(rows[index].operation.id);
  else store.db.prepare("UPDATE outboxes SET payload_json='{' WHERE id=?").run(rows[index].outbox.id);
  store.close();assert.throws(()=>new ControlStore(root),/Corrupt/);
 });
});

test('startup validation includes zero and negative operation and outbox rowids',async()=>{
 for(const rowid of [-1,0]) for(const corruption of ['none','operation','outbox'] as const) await fixture(async root=>{
  let store=new ControlStore(root);const first=store.admit(admission('nonpositive'));
  store.db.prepare('UPDATE operations SET rowid=? WHERE id=?').run(rowid,first.operation.id);
  store.db.prepare('UPDATE outboxes SET rowid=? WHERE id=?').run(rowid,first.outbox.id);
  if(corruption==='operation') store.db.prepare("UPDATE operations SET input_json='{' WHERE id=?").run(first.operation.id);
  if(corruption==='outbox') store.db.prepare("UPDATE outboxes SET payload_json='{' WHERE id=?").run(first.outbox.id);
  store.close();
  if(corruption==='none') {store=new ControlStore(root);assert.equal(store.getOperation(first.operation.id,scope).id,first.operation.id);store.close();}
  else assert.throws(()=>new ControlStore(root),/Corrupt/);
 });
});

test('startup validation reaches both sides of its 128-row page boundary',async()=>{
 for(const table of ['operations','outboxes'] as const) for(const index of [127,128]) await fixture(async root=>{
  const store=new ControlStore(root), rows=[];
  for(let i=0;i<130;i++) rows.push(store.admit(admission('page-'+i)));
  for(let i=0;i<130;i++) {
   store.db.prepare('UPDATE operations SET rowid=? WHERE id=?').run(i-130,rows[i].operation.id);
   store.db.prepare('UPDATE outboxes SET rowid=? WHERE id=?').run(i-130,rows[i].outbox.id);
  }
  if(table==='operations') store.db.prepare("UPDATE operations SET input_json='{' WHERE id=?").run(rows[index].operation.id);
  else store.db.prepare("UPDATE outboxes SET payload_json='{' WHERE id=?").run(rows[index].outbox.id);
  store.close();assert.throws(()=>new ControlStore(root),/Corrupt/);
 });
});

test('read-only reopen rejects malformed, oversized, orphaned and foreign-scope persisted evidence unchanged',async()=>{
 for(const corrupt of ['malformed','oversize','orphan','foreign'] as const) await fixture(async root=>{
  let store=new ControlStore(root);const first=store.admit(admission('reopen-'+corrupt));
  if(corrupt==='malformed') store.db.prepare("UPDATE operations SET input_json='{' WHERE id=?").run(first.operation.id);
  if(corrupt==='oversize') store.db.prepare('UPDATE outboxes SET payload_json=? WHERE id=?').run(JSON.stringify('x'.repeat(CONTROL_MAX_JSON_BYTES)),first.outbox.id);
  if(corrupt==='orphan') {store.db.exec('PRAGMA foreign_keys=OFF');store.db.prepare('DELETE FROM operations WHERE id=?').run(first.operation.id);}
  if(corrupt==='foreign') store.db.prepare("UPDATE outboxes SET session_id='foreign-session' WHERE id=?").run(first.outbox.id);
  store.close();const path=join(root,'control.sqlite'),before=await readFile(path);
  assert.throws(()=>new ControlStore(root),/Corrupt|exceeds|linkage/);
  assert.deepEqual(await readFile(path),before);
 });
});
