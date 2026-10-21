import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, symlink, writeFile, readFile, lstat, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireServiceLock, inspectServiceLock, type ProcessIdentity, type ProcessObservation, type ServiceLockHandle} from '../../src/server/service-lock';

const identity = {rootId:'logical-a', releaseId:'release-a', schemaId:'schema-1', purpose:'service' as const};
async function fixture() { return mkdtemp(join(tmpdir(), 'pilot-lock-')); }
const observer = (value: ProcessObservation) => () => value;

test('concurrent same-root exclusive acquisition admits exactly one owner; distinct roots are independent', async () => {
 const a=await fixture(), b=await fixture();
 try {
  const results=await Promise.allSettled([acquireServiceLock({root:a,...identity}),acquireServiceLock({root:a,...identity})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected').length,1);
  const owner=results.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireServiceLock>>>;
  const other=await acquireServiceLock({root:b,...identity}); await other.release(); await owner.value.release();
 } finally { await rm(a,{recursive:true,force:true}); await rm(b,{recursive:true,force:true}); }
});

test('release and reacquire; owner handle refuses different-inode replacement', async () => {
 const root=await fixture();
 try {
  const lock=await acquireServiceLock({root,...identity,nonce:()=> '11111111-1111-4111-8111-111111111111'});
  await lock.release(); await assert.rejects(lstat(join(root,'service.lock')));
  const next=await acquireServiceLock({root,...identity});
  const original=JSON.parse(await readFile(join(root,'service.lock'),'utf8'));
  await rename(join(root,'service.lock'),join(root,'old-lock-evidence'));
  await writeFile(join(root,'service.lock'),JSON.stringify({...original,nonce:'22222222-2222-4222-8222-222222222222'}));
  await assert.rejects(next.release(),/replacement|mismatched/);
  assert.equal((await inspectServiceLock(root)).classification,'ambiguous');
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('legacy, malformed, symlink, and nonregular evidence are ambiguous and block acquisition', async () => {
 const root=await fixture();
 try {
  for (const bytes of ['legacy lock\n','{broken']) {
   await writeFile(join(root,'service.lock'),bytes);
   assert.equal((await inspectServiceLock(root)).classification,'ambiguous');
   await assert.rejects(acquireServiceLock({root,...identity}));
   await rm(join(root,'service.lock'));
  }
  await writeFile(join(root,'target'),'{}'); await symlink(join(root,'target'),join(root,'service.lock'));
  assert.equal((await inspectServiceLock(root)).classification,'ambiguous');
  await assert.rejects(acquireServiceLock({root,...identity}));
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('observer distinguishes live, inaccessible, dead, reused identity, unknown boot, and expected mismatch', async () => {
 const root=await fixture();
 try {
  const lock=await acquireServiceLock({root,...identity,currentProcess:()=>({pid:456,startIdentity:'start-a',bootIdentity:'boot-a'})});
  assert.equal((await inspectServiceLock(root,undefined,{observeProcess:async()=>({state:'active',startIdentity:'start-a',bootIdentity:'boot-a'})})).classification,'active');
  assert.equal((await inspectServiceLock(root,undefined,{observeProcess:observer({state:'inaccessible'})})).classification,'ambiguous');
  assert.equal((await inspectServiceLock(root,undefined,{observeProcess:observer({state:'dead'})})).classification,'proven-dead');
  assert.equal((await inspectServiceLock(root,undefined,{observeProcess:async()=>({state:'active',startIdentity:'start-b',bootIdentity:'boot-a'})})).classification,'proven-dead');
  assert.equal((await inspectServiceLock(root,undefined,{observeProcess:async()=>({state:'active',startIdentity:'start-a'})})).classification,'ambiguous');
  const mismatch=await inspectServiceLock(root,{releaseId:'old-release',schemaId:'schema-1'});
  assert.equal(mismatch.classification,'ambiguous'); assert.equal(mismatch.expectedVersionMatch,false);
  await assert.rejects(acquireServiceLock({root,...identity}));
  await lock.release();
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('proven-dead locks are never age-cleaned or silently replaced', async () => {
 const root=await fixture();
 try {
  const lock=await acquireServiceLock({root,...identity,now:()=>new Date('2000-01-01T00:00:00Z')});
  const before=await readFile(join(root,'service.lock'),'utf8');
  assert.equal((await inspectServiceLock(root,undefined,{observeProcess:observer({state:'dead'})})).classification,'proven-dead');
  await assert.rejects(acquireServiceLock({root,...identity}));
  assert.equal(await readFile(join(root,'service.lock'),'utf8'),before);
  await lock.release();
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('root symlinks are rejected by inspection and acquisition', async () => {
 const parent=await fixture(), root=join(parent,'root'), alias=join(parent,'alias');
 try { await mkdir(root); await symlink(root,alias); await assert.rejects(acquireServiceLock({root:alias,...identity}),/Root/); await assert.rejects(inspectServiceLock(alias),/Root/); }
 finally { await rm(parent,{recursive:true,force:true}); }
});

test('same-inode nonce changes refuse release for the nonce reason and preserve evidence', async () => {
 const root=await fixture();
 try {
  const lock=await acquireServiceLock({root,...identity,nonce:()=> '11111111-1111-4111-8111-111111111111'});
  const path=join(root,'service.lock'), before=await lstat(path), data=JSON.parse(await readFile(path,'utf8'));
  data.nonce='22222222-2222-4222-8222-222222222222'; await writeFile(path,JSON.stringify(data)+'\n');
  const after=await lstat(path); assert.equal(after.dev,before.dev); assert.equal(after.ino,before.ino);
  // The fixture is well-formed JSON with otherwise valid metadata, so release's refusal can only
  // come from the nonce comparison, not from malformed or unreadable metadata.
  const rewritten=JSON.parse(await readFile(path,'utf8'));
  assert.equal(rewritten.nonce,'22222222-2222-4222-8222-222222222222');
  assert.equal(rewritten.process.pid,data.process.pid);
  const inspection=await inspectServiceLock(root);
  assert.equal(inspection.classification,'ambiguous');
  assert.equal(inspection.metadata?.nonce,'22222222-2222-4222-8222-222222222222');
  assert.ok(inspection.metadata,'rewritten record must be readable metadata, not malformed evidence');
  assert.doesNotMatch(inspection.reason,/malformed|unreadable/i);
  const evidence=await readFile(path,'utf8'); await assert.rejects(lock.release(),/mismatched ownership/); assert.equal(await readFile(path,'utf8'),evidence);
  // Restoring the original nonce lets the same handle release, proving the refusal was the nonce
  // comparison rather than an unreadable record or a permanently broken handle.
  await writeFile(path,JSON.stringify({...rewritten,nonce:'11111111-1111-4111-8111-111111111111'})+'\n');
  await lock.release(); await assert.rejects(lstat(path),/ENOENT/);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('directory lock evidence is ambiguous and blocks acquisition', async () => {
 const root=await fixture();
 try { await mkdir(join(root,'service.lock')); assert.equal((await inspectServiceLock(root)).classification,'ambiguous'); await assert.rejects(acquireServiceLock({root,...identity})); assert.equal((await lstat(join(root,'service.lock'))).isDirectory(),true); }
 finally { await rm(root,{recursive:true,force:true}); }
});

test('valid foreign-root metadata stays ambiguous and blocks acquisition without replacement', async () => {
 const root=await fixture();
 try {
  const held=await acquireServiceLock({root,...identity}); await held.release();
  const lock=await acquireServiceLock({root,...identity});
  // Build independently valid foreign-root evidence while preserving the lock path and inode.
  const file=join(root,'service.lock'), before=await lstat(file), m=JSON.parse(await readFile(file,'utf8')), originalRoot=m.root;
  m.root=join(root,'foreign');
  await writeFile(file,JSON.stringify(m)+'\n');
  assert.equal(JSON.parse(await readFile(file,'utf8')).root,join(root,'foreign'),'fixture must be well-formed JSON');
  const after=await lstat(file); assert.equal(after.dev,before.dev); assert.equal(after.ino,before.ino);
  const inspection=await inspectServiceLock(root);
  assert.equal(inspection.classification,'ambiguous');
  assert.equal(inspection.metadata?.root,join(root,'foreign'));
  assert.match(inspection.reason,/different canonical root/);
  const evidence=await readFile(file,'utf8');
  await assert.rejects(acquireServiceLock({root,...identity}));
  assert.equal(await readFile(file,'utf8'),evidence); await assert.rejects(lock.release(),/mismatched ownership/);
  assert.equal(await readFile(file,'utf8'),evidence);
  // Restoring the canonical root lets the same handle release, proving the refusal was the
  // ownership comparison rather than an unreadable record or a permanently broken handle.
  await writeFile(file,JSON.stringify({...m,root:originalRoot})+'\n');
  await lock.release(); await assert.rejects(lstat(file),/ENOENT/);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('oversized metadata is rejected before lock creation; acquired metadata remains readable and releasable', async () => {
 const root=await fixture();
 try {
  await assert.rejects(acquireServiceLock({root,...identity,releaseId:'é'.repeat(9000)}),/size limit/);
  await assert.rejects(lstat(join(root,'service.lock')));
  const lock=await acquireServiceLock({root,...identity}); assert.equal((await inspectServiceLock(root)).classification,'ambiguous');
  assert.equal((await inspectServiceLock(root,undefined,{observeProcess:observer({state:'active'})})).classification,'active');
  await lock.release(); await assert.equal((await inspectServiceLock(root)).classification,'absent');
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('initialization failure preserves created evidence and closes the opened handle', async () => {
 const root=await fixture(); let captured: import('node:fs/promises').FileHandle | undefined;
 try {
  await assert.rejects(acquireServiceLock({root,...identity,initialize:async(handle)=>{captured=handle; await handle.writeFile('partial'); throw new Error('injected initialization failure');}}),/injected initialization failure/);
  assert.equal(await readFile(join(root,'service.lock'),'utf8'),'partial');
  assert.equal((await inspectServiceLock(root)).classification,'ambiguous');
  await assert.rejects(captured!.writeFile('closed'),/closed|EBADF/);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('default observer does not claim current PID ownership without instance identity', async () => {
 const root=await fixture();
 try {
  const lock=await acquireServiceLock({root,...identity,now:()=>new Date('2000-01-01T00:00:00Z'),currentProcess:()=>({pid:process.pid})});
  assert.equal((await inspectServiceLock(root)).classification,'ambiguous'); await lock.release();
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('serialization-altered process identity cannot strand or leak a successful acquisition', async () => {
 const root=await fixture(), path=join(root,'service.lock');
 try {
  // Structurally valid dependency whose serialization would rewrite the recorded pid: a naive
  // spread keeps toJSON and writes pid 0, which inspection rejects and release cannot verify.
  const altered=(): ProcessIdentity => ({pid:4242,toJSON:()=>({pid:0})}) as unknown as ProcessIdentity;
  const lock=await acquireServiceLock({root,...identity,currentProcess:altered});
  const onDisk=JSON.parse(await readFile(path,'utf8'));
  assert.equal(onDisk.process.pid,4242,'only the declared pid field may be serialized');
  assert.deepEqual(onDisk,lock.metadata,'the returned handle metadata is exactly the stored record');
  const active=await inspectServiceLock(root,undefined,{observeProcess:observer({state:'active'})});
  assert.equal(active.classification,'active');
  assert.equal(active.metadata?.process.pid,4242);
  await lock.release();
  await assert.rejects(lstat(path));
  assert.equal((await inspectServiceLock(root)).classification,'absent');
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('identities that cannot produce a readable record are refused before any lock exists', async () => {
 const root=await fixture(), path=join(root,'service.lock');
 try {
  // A structurally valid identity whose serialization would rewrite the pid is deliberately absent
  // here: only declared fields are copied, so it acquires a readable lock (see the test above).
  const cases: Array<{label: string; options: Parameters<typeof acquireServiceLock>[0]}> = [
   {label:'zero pid', options:{root,...identity,currentProcess:()=>({pid:0})}},
   {label:'unsafe pid', options:{root,...identity,currentProcess:()=>({pid:Number.MAX_SAFE_INTEGER+1})}},
   {label:'non-string start identity', options:{root,...identity,currentProcess:()=>({pid:4242,startIdentity:7}) as unknown as ProcessIdentity}},
   {label:'non-uuid nonce', options:{root,...identity,nonce:()=> 'not-a-uuid'}},
   {label:'unparseable creation time', options:{root,...identity,now:()=>({toISOString:()=> 'not-a-date'}) as unknown as Date}},
  ];
  for (const {label,options} of cases) {
   await assert.rejects(acquireServiceLock(options),/Invalid|unreadable|diverges/,label+' must be refused');
   await assert.rejects(lstat(path),/ENOENT/,label+' must leave no lock behind');
   assert.equal((await inspectServiceLock(root)).classification,'absent',label);
   const probe=await acquireServiceLock({root,...identity}); await probe.release();
   await assert.rejects(lstat(path),/ENOENT/,label+' must not leave residue for the next acquisition');
  }
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('a serialization-altered record is refused before exclusive creation and leaves no lock', async () => {
 const root=await fixture(), path=join(root,'service.lock'), native=JSON.stringify;
 try {
  // Simulate any supported dependency whose serialization rewrites the record (the reviewer's
  // toJSON-changes-pid case, applied at the serialization boundary): the lock must not be created,
  // because inspection could never read it back and the handle could never be released.
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
   const record = value as {version?: unknown; process?: {pid?: unknown}} | null;
   return record && typeof record === 'object' && record.version === 1 && typeof record.process?.pid === 'number'
    ? native({...record, process: {...record.process, pid: 0}}, ...(rest as []))
    : native(value as never, ...(rest as []));
  }) as typeof JSON.stringify;
  await assert.rejects(acquireServiceLock({root,...identity}),/unreadable|diverges|Invalid/);
  await assert.rejects(lstat(path),/ENOENT/,'refusal must precede exclusive creation');
  assert.equal((await inspectServiceLock(root)).classification,'absent');
 } finally { JSON.stringify = native; await rm(root,{recursive:true,force:true}); }
});

test('returned metadata and nested process view are frozen and cannot affect release ownership', async () => {
 const root=await fixture();
 try {
  const lock=await acquireServiceLock({root,...identity});
  assert.equal(Object.isFrozen(lock.metadata),true); assert.equal(Object.isFrozen(lock.metadata.process),true);
  assert.throws(()=>Object.assign(lock.metadata,{nonce:'22222222-2222-4222-8222-222222222222'}));
  assert.throws(()=>Object.assign(lock.metadata.process,{pid:999}));
  assert.equal((await inspectServiceLock(root,undefined,{observeProcess:observer({state:'active'})})).metadata?.nonce,lock.metadata.nonce);
  await lock.release(); assert.equal((await inspectServiceLock(root)).classification,'absent');
 } finally { await rm(root,{recursive:true,force:true}); }
});

// Compile-time assertions: the exported view must be readonly at the type level, not only frozen at
// runtime. If either readonly disappears, the directive becomes unused and pnpm check fails.
function readonlyViewIsATypeError(handle: ServiceLockHandle): void {
 // @ts-expect-error metadata.nonce is readonly in the exported handle type
 handle.metadata.nonce = '22222222-2222-4222-8222-222222222222';
 // @ts-expect-error metadata.process.pid is readonly (nested process object)
 handle.metadata.process.pid = 1;
 // @ts-expect-error the nested process identity is deeply readonly
 handle.metadata.process.startIdentity = 'start-x';
 // @ts-expect-error metadata.root is readonly in the exported handle type
 handle.metadata.root = '/tmp/elsewhere';
}
void readonlyViewIsATypeError;
