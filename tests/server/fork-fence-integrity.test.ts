import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlStore,operationDigest} from '../../src/server/state/control-store';
import {ForkCreationFence} from '../../src/server/state/fork-creation-fence';
import {ForkLifecycleFence} from '../../src/server/state/fork-lifecycle-fence';

test('creation and lifecycle fences fail closed on corrupt latest records, audit and transitions',async()=>{
 for(const kind of ['creation','lifecycle'] as const)for(const corruption of ['input','outbox','state','kind','key','transition','missing-predecessor'] as const){
  const root=await mkdtemp(join(tmpdir(),'pilot-fence-integrity-')),store=new ControlStore(root);
  try{
   const creation=new ForkCreationFence(store),lifecycle=new ForkLifecycleFence(store);
   if(kind==='creation'){const held=creation.acquire('project','parent');creation.release('project',held);}
   else{const held=lifecycle.acquire('project','child');lifecycle.release('project','child',held);}
   const opKind=kind==='creation'?'fork.creation-fence':'fork.lifecycle-fence';
   const ops=store.db.prepare('SELECT id,kind,input_json FROM operations WHERE kind=? ORDER BY rowid').all(opKind) as {id:string;kind:string;input_json:string}[];
   const last=ops[1],out=store.db.prepare('SELECT id,kind,payload_json FROM outboxes WHERE operation_id=?').get(last.id) as {id:string;kind:string;payload_json:string};
   if(corruption==='input'){
    const value=JSON.parse(last.input_json);value.token='0'.repeat(36);store.db.prepare('UPDATE operations SET input_json=? WHERE id=?').run(JSON.stringify(value),last.id);
   }else if(corruption==='outbox')store.db.prepare('UPDATE outboxes SET payload_json=? WHERE id=?').run('{"version":1,"revision":3}',out.id);
   else if(corruption==='state')store.db.prepare("UPDATE operations SET state='failed' WHERE id=?").run(last.id);
   else if(corruption==='kind')store.db.prepare("UPDATE operations SET kind='fork.damaged' WHERE id=?").run(last.id);
   else if(corruption==='key')store.db.prepare("UPDATE operations SET idempotency_key='damaged' WHERE id=?").run(last.id);
   else if(corruption==='missing-predecessor'){
    store.db.prepare('DELETE FROM outboxes WHERE operation_id=?').run(ops[0].id);store.db.prepare('DELETE FROM operations WHERE id=?').run(ops[0].id);
   }else{
    // Recompute the ordinary integrity digest: the released record still cannot switch tokens or
    // (for creation) switch the parent reservation relative to the previous held record.
    const value=JSON.parse(last.input_json);value.token='0'.repeat(36);if(kind==='creation')value.parentSessionId='other-parent';
    const payload=JSON.parse(out.payload_json),hash=operationDigest(opKind,{input:value,outbox:{kind:out.kind,payload}});
    store.db.prepare('UPDATE operations SET input_json=?,input_digest=? WHERE id=?').run(JSON.stringify(value),hash,last.id);
   }
   const before=(store.db.prepare('SELECT COUNT(*) AS n FROM operations').get() as {n:number}).n;
   if(kind==='creation'){
    assert.throws(()=>creation.assertDispatchable('project','other'),/corrupt/);assert.throws(()=>creation.acquire('project','parent'),/corrupt/);
   }else{
    assert.throws(()=>lifecycle.assertDispatchable('project','child'),/corrupt/);assert.throws(()=>lifecycle.acquire('project','child'),/corrupt/);
   }
   assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM operations').get() as {n:number}).n,before,`${kind}/${corruption} did not admit another fence`);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
 }
});
