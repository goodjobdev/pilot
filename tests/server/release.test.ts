import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore,ControlStoreError } from '../../src/server/state/control-store';
import {
  RELEASE_MANIFEST_ENV,UNRELEASED_LOCAL,SUPPORTED_SCHEMA_IDS,defaultReleaseManifestPath,
  loadReleaseManifest,observeStorageSchema,parseReleaseManifest,releaseManifestPath,
  resolveRelease,schemaVersionForId
} from '../../src/server/release';

const valid={version:'1.2.3',releaseId:'v1.2.3',schemaId:'pilot-state-1',createdAt:'2026-01-01T00:00:00.000Z'};
const text=(value:unknown)=>JSON.stringify(value);

test('a valid manifest parses to a frozen, exactly-typed record',()=>{
 const parsed=parseReleaseManifest(valid);
 assert.deepEqual(parsed,valid);
 assert.ok(Object.isFrozen(parsed));
 const withOptionals=parseReleaseManifest({...valid,sourceDigest:'a'.repeat(40),buildId:'build-42'});
 assert.equal(withOptionals.sourceDigest,'a'.repeat(40));
 assert.equal(withOptionals.buildId,'build-42');
 assert.deepEqual(Object.keys(parsed).sort(),['createdAt','releaseId','schemaId','version']);
});

test('unknown, missing, malformed and path-like manifest values all fail closed with a clear message',()=>{
 const rejects:readonly (readonly [unknown,RegExp])[]=[
  [{...valid,extra:true},/Invalid release manifest/],
  [{releaseId:'v1',schemaId:'pilot-state-1',createdAt:valid.createdAt},/Invalid release manifest/],
  [{...valid,version:'1.2'},/Invalid release manifest/],
  [{...valid,createdAt:'not-a-date'},/Invalid release manifest/],
  [{...valid,schemaId:'pilot-state-2'},/unsupported schema version/],
  [{...valid,releaseId:'../evil'},/Invalid release manifest/],
  [{...valid,releaseId:'/etc/passwd'},/Invalid release manifest/],
  [{...valid,releaseId:'..'},/Invalid release manifest/],
  [{...valid,releaseId:'./x'},/Invalid release manifest/],
  [{...valid,releaseId:'a/b'},/Invalid release manifest/],
  [{...valid,sourceDigest:'ZZZ'},/Invalid release manifest/],
  [null,/Invalid release manifest/]
 ];
 for(const [value,pattern] of rejects)assert.throws(()=>parseReleaseManifest(value),pattern,JSON.stringify(value));
 assert.deepEqual([...SUPPORTED_SCHEMA_IDS],['pilot-state-1']);
 assert.equal(schemaVersionForId('pilot-state-1'),1);
 assert.equal(schemaVersionForId('pilot-state-9'),undefined);
});

test('the manifest path defaults beside the build and rejects only traversal',()=>{
 assert.ok(defaultReleaseManifestPath().endsWith('release.json'));
 assert.equal(releaseManifestPath({}),defaultReleaseManifestPath());
 assert.equal(releaseManifestPath({'DASHBOARD_RELEASE_MANIFEST':''}),defaultReleaseManifestPath());
 assert.ok(releaseManifestPath({[RELEASE_MANIFEST_ENV]:'/tmp/x/release.json'}).startsWith('/tmp/x/'));
 assert.throws(()=>releaseManifestPath({[RELEASE_MANIFEST_ENV]:'../outside/release.json'}),/traversal/);
});

test('loadReleaseManifest reports absence, invalid JSON and validation failure as data, never throwing',async()=>{
 const read=(returns:string|undefined|Error)=>()=>returns instanceof Error?Promise.reject(returns):Promise.resolve(returns);
 const pathDefault=releaseManifestPath({});
 const absent=await loadReleaseManifest({},{readText:read(undefined)});
 assert.equal(absent.status,'absent');
 const notJson=await loadReleaseManifest({},{readText:read('{ nope')});
 assert.equal(notJson.status,'invalid');assert.match(notJson.reason,/not valid JSON/);
 const invalid=await loadReleaseManifest({},{readText:read(text({...valid,extra:1}))});
 assert.equal(invalid.status,'invalid');assert.match(invalid.reason,/Invalid release manifest/);
 const present=await loadReleaseManifest({},{readText:read(text(valid))});
 assert.equal(present.status,'present');assert.deepEqual(present.manifest,valid);
 const unreadable=await loadReleaseManifest({},{readText:read(Object.assign(new Error('EACCES'),{code:'EACCES'}))});
 assert.equal(unreadable.status,'invalid');assert.match(unreadable.reason,/could not be read/);
 assert.equal(present.path,pathDefault);
});

test('resolveRelease fails closed for hosted, allows unreleased local, and rejects corruption in both modes',async()=>{
 const absent=await resolveRelease({},'local',{readText:async()=>undefined});
 assert.equal(absent.state,'unreleased-local');
 assert.equal(absent.identity.releaseId,UNRELEASED_LOCAL);
 assert.equal(absent.identity.schemaId,'pilot-state-1');
 assert.equal(absent.identity.version,'0.0.0-unreleased');
 assert.equal(absent.identity.source,'unreleased-local');
 assert.ok(Object.isFrozen(absent.identity));
 const missing=await resolveRelease({},'hosted',{readText:async()=>undefined});
 assert.equal(missing.state,'missing');
 const invalidLocal=await resolveRelease({},'local',{readText:async()=>text({...valid,schemaId:'bad-!id'})});
 assert.equal(invalidLocal.state,'invalid');
 const invalidHosted=await resolveRelease({},'hosted',{readText:async()=>text({...valid,extra:1})});
 assert.equal(invalidHosted.state,'invalid');
 const released=await resolveRelease({},'hosted',{readText:async()=>text(valid)});
 assert.equal(released.state,'released');
 assert.equal(released.identity.releaseId,'v1.2.3');
 assert.equal(released.identity.schemaId,'pilot-state-1');
 assert.equal(released.identity.createdAt,valid.createdAt);
});

test('observeStorageSchema distinguishes transient contention from corruption and reads a live store',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-release-live-'));
 const lockedRoot=await mkdtemp(join(tmpdir(),'dashboard-release-locked-'));
 try{
  // A store that is open and serving stays observable: readiness must not need the writer to close.
  const live=new ControlStore(root);
  assert.deepEqual(observeStorageSchema(root),{state:'present',version:1});
  assert.equal(live.schemaVersion(),1);
  live.close();
  // A closed handle is no evidence, and says so as a typed schema verdict.
  assert.throws(()=>live.schemaVersion(),(e:unknown)=>e instanceof ControlStoreError&&e.code==='SCHEMA');
  // A rollback-journal database held under an exclusive lock is contention, not corruption.
  const writer=new DatabaseSync(join(lockedRoot,'control.sqlite'));
  writer.exec('CREATE TABLE control_schema(version INTEGER PRIMARY KEY); INSERT INTO control_schema VALUES(1);');
  writer.exec('BEGIN EXCLUSIVE');
  assert.deepEqual(observeStorageSchema(lockedRoot,{busyTimeoutMs:50}),{state:'busy',reason:'storage schema is temporarily locked by another writer'});
  writer.exec('ROLLBACK');
  writer.close();
  assert.deepEqual(observeStorageSchema(lockedRoot,{busyTimeoutMs:50}),{state:'present',version:1});
 }finally{
  await rm(root,{recursive:true,force:true});
  await rm(lockedRoot,{recursive:true,force:true});
 }
});
test('observeStorageSchema is read-only: absent, present, malformed and an unsupported version',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-release-schema-'));
 try{
  assert.deepEqual(observeStorageSchema(root),{state:'absent'});
  const store=new ControlStore(root);store.close();
  const observed=observeStorageSchema(root);
  assert.deepEqual(observed,{state:'present',version:1});
  const laterRoot=await mkdtemp(join(tmpdir(),'dashboard-release-schema2-'));
  try{
   const db=new DatabaseSync(join(laterRoot,'control.sqlite'));
   db.exec('CREATE TABLE control_schema(version INTEGER PRIMARY KEY);');
   db.exec('INSERT INTO control_schema(version) VALUES (2);');
   db.close();
   assert.deepEqual(observeStorageSchema(laterRoot),{state:'present',version:2});
  }finally{await rm(laterRoot,{recursive:true,force:true});}
  const malformed=await mkdtemp(join(tmpdir(),'dashboard-release-schema3-'));
  try{
   await writeFile(join(malformed,'control.sqlite'),'not a database');
   const bad=observeStorageSchema(malformed);
   assert.equal(bad.state,'malformed');
  }finally{await rm(malformed,{recursive:true,force:true});}
 }finally{await rm(root,{recursive:true,force:true});}
});
