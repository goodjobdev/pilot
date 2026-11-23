import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { AcceptanceStore } from '../../src/server/state/acceptance-store';
import { setFullAutoPolicy } from '../../scripts/full-auto-policy';

test('offline full-auto policy is audited, revision checked, and refuses lock and restore evidence',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-operator-policy-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 let db=new ControlStore(root);db.close();
 await writeFile(join(root,'service.lock'),'existing evidence');
 await assert.rejects(()=>setFullAutoPolicy(root,0,'owner'),/exist/i);
 await unlink(join(root,'service.lock'));
 await writeFile(join(root,'RESTORE-PAUSED.json'),'{}');
 await assert.rejects(()=>setFullAutoPolicy(root,0,'owner'),/paused restore/i);
 await unlink(join(root,'RESTORE-PAUSED.json'));
 const changed=await setFullAutoPolicy(root,0,'owner');
 assert.equal(changed.revision,1);assert.equal(changed.mode,'agent-may-accept');
 assert.deepEqual(Object.values(changed.actionClasses),Array(6).fill('full-auto'));
 await assert.rejects(()=>setFullAutoPolicy(root,0,'owner'),/revision changed/);
 db=new ControlStore(root);
 try {const policy=new AcceptanceStore(db,{projectRoot:()=>undefined}).readPolicy();assert.equal(policy.revision,1);assert.equal(policy.updatedBy,'owner');}
 finally {db.close();}
});
