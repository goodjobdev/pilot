import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,mkdir,readFile,readdir,rm,stat,symlink,unlink,writeFile} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const digestOf=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
import {archivePayload,backup,isPayloadPath,restore,promote,stagedTarget,verifyArchive,PAUSED_MARKER,DATABASE_COPY_METHOD} from '../../scripts/data-tools.mjs';
import {KDF_PARAMETERS,buildHeader,encodeRecord,writeArchive} from '../../scripts/backup-crypto.mjs';
import {Catalog} from '../../src/server/catalog';
import {BoardStore} from '../../src/server/board-store';
import {acquireServiceLock} from '../../src/server/service-lock';
import {ControlStore} from '../../src/server/state/control-store';
import {MediaStore} from '../../src/server/media-store';
import {emptyBoard,newTask} from '../../src/shared/model';
import type {Project} from '../../src/shared/model';
import {serializeBoard} from '../../src/shared/markdown';

const PASSPHRASE='a-sufficiently-long-backup-passphrase';
const archiveAt=(root:string,name='backup.pbkp')=>join(root,name);
const exists=(path:string)=>stat(path).then(()=>true).catch(()=>false);
const stagingLeftovers=async(root:string)=>(await readdir(root)).filter(name=>name.startsWith('.pilot-restore-'));
const projectId='11111111-1111-4111-8111-111111111111';
async function* body(records:Buffer[]) { for (const record of records) yield record; }
/**
 * The synthetic-archive helper the digest, duplicate-path and traversal cases are built from: one
 * manifest record, one file record and its bytes per entry, then the end record. The manifest is built
 * by the test, so an archive can name a path this tool would never write.
 */
function syntheticArchive(path:string,manifest:Record<string,unknown>,files:{path:string;bytes:Buffer}[]) {
  const records:Buffer[]=[encodeRecord({kind:'manifest',format:'pilot-backup',version:2,manifest})];
  for(const file of files){records.push(encodeRecord({kind:'file',path:file.path,size:file.bytes.length}),file.bytes);}
  records.push(encodeRecord({kind:'end',files:files.length}));
  return writeArchive(path,{
    header:buildHeader({created:new Date().toISOString(),kdf:KDF_PARAMETERS,salt:randomBytes(16),nonce:randomBytes(12),app:null}),
    body:body(records),
    passphrase:PASSPHRASE
  });
}
/** The manifest a synthetic archive carries, with the entries the caller hands it. */
const syntheticManifest=(files:{path:string;size:number;sha256:string}[])=>({
  format:'pilot-backup',version:2,created:new Date().toISOString(),
  root:{rootId:'fixture'},app:null,databaseCopyMethod:DATABASE_COPY_METHOD,files,excluded:[]
});
/** A data root holding nothing but an empty version-1 catalog. */
async function emptyRoot(prefix:string) {
  const root=await mkdtemp(join(tmpdir(),prefix)),data=join(root,'data');
  await mkdir(data,{recursive:true,mode:0o700});
  await writeFile(join(data,'catalog.json'),JSON.stringify({version:1,projects:[]})+ '\n');
  return {root,data};
}

test('a pristine catalog supports an offline encrypted backup and an isolated paused restore',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-bootstrap-')),data=join(root,'data'),c=new Catalog(data,[],new BoardStore(data));
 await mkdir(data,{recursive:true,mode:0o700});
 // The live service is the reviewed startup lock, not Catalog: that lock is what backup refuses.
 const held=await acquireServiceLock({root:data,purpose:'service',rootId:'fixture-root-id',releaseId:'fixture-release',schemaId:'pilot-state-1'});
 try{
  await c.init();assert.deepEqual(JSON.parse(await readFile(join(data,'catalog.json'),'utf8')),{version:1,projects:[]});
  const before=await readFile(join(data,'service.lock'),'utf8');
  await assert.rejects(backup(data,archiveAt(root,'blocked.pbkp'),{passphrase:PASSPHRASE}));
  assert.equal(await readFile(join(data,'service.lock'),'utf8'),before,'a refused backup leaves the holder\'s lock byte-identical');
  assert.equal(await exists(archiveAt(root,'blocked.pbkp')),false,'a refused backup writes no archive');
  await held.release();
  await c.close();
  const manifest=await backup(data,archiveAt(root),{passphrase:PASSPHRASE});
  assert.equal(manifest.files.length,1);
  assert.deepEqual(manifest.files.map((entry:{path:string})=>entry.path),['catalog.json']);
  assert.equal(manifest.formatVersion,2);
  assert.equal(manifest.databaseCopyMethod,DATABASE_COPY_METHOD);
  assert.ok(manifest.excluded.some((entry:{path:string})=>entry.path==='credentials/'),'the manifest states what it excluded');
  assert.ok(manifest.excluded.some((entry:{path:string})=>entry.path==='service.lock'));
  assert.equal(await exists(join(data,'service.lock')),false,'a completed backup releases the lock it took');
  // A restore refuses a live root and a non-empty destination, changing neither.
  const live=join(root,'live');await mkdir(live,{recursive:true,mode:0o700});
  await writeFile(join(live,'service.lock'),'evidence\n');
  await assert.rejects(restore(archiveAt(root),live,{passphrase:PASSPHRASE}),/service\.lock evidence/);
  assert.equal(await readFile(join(live,'service.lock'),'utf8'),'evidence\n');
  const occupied=join(root,'occupied');await mkdir(occupied,{recursive:true,mode:0o700});
  await writeFile(join(occupied,'keep.txt'),'keep\n');
  await assert.rejects(restore(archiveAt(root),occupied,{passphrase:PASSPHRASE}),/not empty/);
  assert.equal(await readFile(join(occupied,'keep.txt'),'utf8'),'keep\n');
  const result=await restore(archiveAt(root),join(root,'restored'),{passphrase:PASSPHRASE});
  assert.equal(result.projects,0);
  assert.equal(result.paused,true,'a restored root is explicitly paused');
  assert.deepEqual(JSON.parse(await readFile(join(root,'restored','catalog.json'),'utf8')),{version:1,projects:[]});
  const marker=JSON.parse(await readFile(join(root,'restored',PAUSED_MARKER),'utf8'));
  assert.equal(marker.format,'pilot-restore-pause');
  assert.equal(marker.archive.formatVersion,2);
  assert.equal(marker.archive.sha256,manifest.digest);
  assert.equal(marker.credentials,'absent');
  assert.equal(await exists(join(root,'restored','credentials')),false);
  assert.deepEqual(await stagingLeftovers(root),[],'no staging area survives a successful restore');
  const promoted=await promote(join(root,'restored'));
  assert.equal(promoted.promoted,true);
  assert.equal(await exists(join(root,'restored',PAUSED_MARKER)),false,'promotion removes the marker deliberately');
  await assert.rejects(promote(join(root,'restored')),/not a paused restored root/,'a root is promoted exactly once');
 }finally{await held.release();await c.close();await rm(root,{recursive:true,force:true});}
});

test('a managed project backs up its documentation and media; an external one only its board',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-backup-scope-')),data=join(root,'data'),c=new Catalog(data,[root],new BoardStore(data));await c.init();
 try{
  const managed=await c.register({name:'Managed',managed:true,confirm:true});
  await mkdir(join(managed.path,'docs','spec'),{recursive:true});
  await writeFile(join(managed.path,'docs','spec','alpha.md'),'# Alpha\n\nA spec the wiki owns.\n');
  await writeFile(join(managed.path,'docs','spec','mock.html'),'<!doctype html><html><body>mockup</body></html>\n');
  await writeFile(join(managed.path,'docs','spec','diagram.png'),Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  await mkdir(join(managed.path,'node_modules','pkg'),{recursive:true});
  await writeFile(join(managed.path,'node_modules','pkg','readme.md'),'# Vendored\n');
  const externalPath=join(root,'external');await mkdir(join(externalPath,'docs','dashboard'),{recursive:true});
  await writeFile(join(externalPath,'README.md'),'# Repository readme\n');
  await writeFile(join(externalPath,'docs','notes.md'),'# Repository notes\n');
  await writeFile(join(externalPath,'docs','dashboard','board.md'),'---\nversion: 1\n---\n');
  const external=await c.register({name:'External',path:externalPath,managed:false,confirm:true});
  await c.close();
  const manifest=await backup(data,archiveAt(root),{passphrase:PASSPHRASE});
  const paths=manifest.files.map((entry:{path:string})=>entry.path).sort();
  assert.ok(paths.includes('projects/'+managed.id+'/docs/spec/alpha.md'),'managed documentation is included');
  assert.ok(paths.includes('projects/'+managed.id+'/docs/spec/mock.html'),'a static mockup is included as media');
  assert.ok(paths.includes('projects/'+managed.id+'/docs/spec/diagram.png'),'an image is included as media');
  assert.ok(paths.includes('projects/'+managed.id+'/docs/dashboard/board.md'),'the managed board is included');
  assert.ok(!paths.some(path=>path.includes('node_modules')),'generated folders are excluded');
  assert.deepEqual(paths.filter(path=>path.startsWith('projects/'+external.id+'/')),['projects/'+external.id+'/docs/dashboard/board.md'],'an external project contributes only its board');
  await restore(archiveAt(root),join(root,'restored'),{passphrase:PASSPHRASE});
  const catalog=JSON.parse(await readFile(join(root,'restored','catalog.json'),'utf8'));
  const restoredManaged=catalog.projects.find((project:{id:string})=>project.id===managed.id).path;
  assert.ok(restoredManaged.startsWith(join(root,'restored','workspaces')),'a restored project points inside the restored root, never at the live one');
  assert.equal(await readFile(join(restoredManaged,'docs','spec','alpha.md'),'utf8'),'# Alpha\n\nA spec the wiki owns.\n');
  assert.deepEqual(await readFile(join(restoredManaged,'docs','spec','diagram.png')),Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  assert.equal(await readFile(join(restoredManaged,'docs','dashboard','board.md'),'utf8'),await readFile(join(managed.path,'docs','dashboard','board.md'),'utf8'));
  const restoredExternal=catalog.projects.find((project:{id:string})=>project.id===external.id).path;
  assert.equal(await readFile(join(restoredExternal,'docs','dashboard','board.md'),'utf8'),'---\nversion: 1\n---\n');
  assert.equal(await exists(join(restoredExternal,'README.md')),false,'a repository readme is not copied');
 }finally{await c.close().catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test('a version-1 plaintext directory backup still restores, and restores paused',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-backup-legacy-')),backupDir=join(root,'legacy');
 const id='11111111-1111-4111-8111-111111111111';
 await mkdir(join(backupDir,'projects',id,'sources'),{recursive:true});
 const board='---\nversion: 1\n---\n',source='snapshot text\n';
 await writeFile(join(backupDir,'projects',id,'board.md'),board);
 await writeFile(join(backupDir,'projects',id,'sources','22222222-2222-4222-8222-222222222222-'+'a'.repeat(64)+'.md'),source);
 const catalog={version:1,projects:[{id,name:'Legacy',path:'/gone',managed:true,repository:'',created:new Date().toISOString()}]};
 await writeFile(join(backupDir,'catalog.json'),JSON.stringify(catalog));
 const hash=async(value:string)=>digestOf(await readFile(value));
 const manifest={version:1,created:new Date().toISOString(),files:[
  {path:'catalog.json',sha256:await hash(join(backupDir,'catalog.json'))},
  {path:'projects/'+id+'/board.md',sha256:await hash(join(backupDir,'projects',id,'board.md'))},
  {path:'projects/'+id+'/sources/22222222-2222-4222-8222-222222222222-'+'a'.repeat(64)+'.md',sha256:await hash(join(backupDir,'projects',id,'sources','22222222-2222-4222-8222-222222222222-'+'a'.repeat(64)+'.md'))}
 ]};
 await writeFile(join(backupDir,'manifest.json'),JSON.stringify(manifest));
 const result=await restore(backupDir,join(root,'restored'));
 assert.equal(result.projects,1);
 assert.equal(result.formatVersion,1);
 assert.equal(result.paused,true);
 const restored=join(result.root,'workspaces',id);
 assert.equal(await readFile(join(restored,'docs','dashboard','board.md'),'utf8'),board);
 assert.equal(await readFile(join(restored,'docs','dashboard','sources','22222222-2222-4222-8222-222222222222-'+'a'.repeat(64)+'.md'),'utf8'),source);
 const marker=JSON.parse(await readFile(join(result.root,PAUSED_MARKER),'utf8'));
 assert.equal(marker.archive.formatVersion,1,'the marker records which format was restored');
 await rm(root,{recursive:true,force:true});
});

test('a commit that is still only in the WAL sidecar survives the round trip',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-backup-wal-')),data=join(root,'data');
 await mkdir(data,{recursive:true,mode:0o700});
 await writeFile(join(data,'catalog.json'),JSON.stringify({version:1,projects:[]})+ '\n');
 // The durable store stays open with committed rows the WAL has not checkpointed: a copy of the
 // database file alone would lose them, which is exactly what a consistent copy must not do.
 const store=new ControlStore(data);
 const admitted=store.admit({scope:{projectId,sessionId:'session-1'},idempotencyKey:'key-1',kind:'fixture.operation',input:{a:1},outbox:{kind:'fixture.event',payload:{b:2}}});
 store.acknowledgeOutbox(admitted.outbox.id,{projectId,sessionId:'session-1'},admitted.outbox.revision,{ok:true});
 assert.ok((await stat(join(data,'control.sqlite-wal'))).size>0,'the committed rows really are still only in the WAL sidecar');
 await writeFile(join(root,'naive.sqlite'),await readFile(join(data,'control.sqlite')));
 const naive=new DatabaseSync(join(root,'naive.sqlite'),{readOnly:true});
 let naiveRows:number;
 try { naiveRows=(naive.prepare('SELECT count(*) AS n FROM operations').get() as {n:number}).n; }
 catch { naiveRows=-1; }
 naive.close();
 assert.equal(naiveRows,0,'a byte copy of the database file alone holds none of the committed WAL rows');
 // The same question for an agent session database, whose committed row is still only in that
 // database's own WAL sidecar when the backup reads it.
 await mkdir(join(data,'agents',projectId),{recursive:true,mode:0o700});
 const sessions=new DatabaseSync(join(data,'agents',projectId,'session.sqlite'));
 sessions.exec('PRAGMA journal_mode=WAL');
 sessions.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL)');
 sessions.exec("INSERT INTO sessions(id,title) VALUES ('session-durable','A committed session')");
 assert.ok((await stat(join(data,'agents',projectId,'session.sqlite-wal'))).size>0,'the committed session row really is still only in the WAL sidecar');
 await writeFile(join(root,'naive-session.sqlite'),await readFile(join(data,'agents',projectId,'session.sqlite')));
 const naiveSession=new DatabaseSync(join(root,'naive-session.sqlite'),{readOnly:true});
 let naiveSessionTitle:string|null=null;
 try{naiveSessionTitle=(naiveSession.prepare('SELECT title FROM sessions WHERE id=?').get('session-durable') as {title:string}|undefined)?.title??null;}
 catch{naiveSessionTitle=null;}
 naiveSession.close();
 assert.equal(naiveSessionTitle,null,'a byte copy of the session database alone holds none of the committed WAL rows');
 try{
  const manifest=await backup(data,archiveAt(root),{passphrase:PASSPHRASE});
  assert.equal(manifest.databaseCopyMethod,'sqlite-vacuum-into');
  assert.deepEqual(manifest.storage.controlSchema,{state:'present',version:1});
  assert.ok(manifest.files.some((entry:{path:string})=>entry.path==='control.sqlite'),'the durable store is part of the archive');
  assert.ok(manifest.files.some((entry:{path:string})=>entry.path==='agents/'+projectId+'/session.sqlite'),'the agent session database is part of the archive');
  await restore(archiveAt(root),join(root,'restored'),{passphrase:PASSPHRASE});
  const copy=new DatabaseSync(join(root,'restored','control.sqlite'),{readOnly:true});
  assert.equal((copy.prepare('SELECT count(*) AS n FROM operations').get() as {n:number}).n,1,'the copied database holds the committed row');
  assert.equal((copy.prepare('SELECT id FROM operations').get() as {id:string}).id,admitted.operation.id);
  assert.equal((copy.prepare('SELECT state FROM outboxes').get() as {state:string}).state,'delivered');
  copy.close();
  const restoredSession=new DatabaseSync(join(root,'restored','agents',projectId,'session.sqlite'),{readOnly:true});
  assert.equal((restoredSession.prepare('SELECT title FROM sessions WHERE id=?').get('session-durable') as {title:string}).title,'A committed session','the committed agent session row survives the round trip');
  restoredSession.close();
  // Read through the application's own store: the restored database is a control store, not a file.
  const reopened=new ControlStore(join(root,'restored'));
  assert.equal(reopened.getOperation(admitted.operation.id,{projectId,sessionId:'session-1'}).state,'pending');
  reopened.close();
 }finally{
  sessions.close();
  store.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('credentials and device secrets are never in an archive, and a bad digest or a cut archive writes nothing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-backup-exclude-')),data=join(root,'data');
 await mkdir(join(data,'workspaces',projectId,'docs','dashboard'),{recursive:true,mode:0o700});
 await writeFile(join(data,'workspaces',projectId,'docs','dashboard','board.md'),serializeBoard(emptyBoard()));
 await writeFile(join(data,'catalog.json'),JSON.stringify({version:1,projects:[{id:projectId,name:'Fixture',path:join(data,'workspaces',projectId),managed:true,repository:'',created:new Date().toISOString()}]}));
 // A real board edit through the application's own store, so the bounded board-snapshot history the
 // application writes itself (snapshots/<projectId>/<timestamp>-<uuid>.md) really exists here.
 const project:Project={id:projectId,name:'Fixture',path:join(data,'workspaces',projectId),managed:true,repository:'',created:new Date().toISOString()};
 const boards=new BoardStore(data);
 const board=await boards.read(project);
 await boards.mutate(project,board.revision,{op:'putTask',task:newTask(randomUUID(),'Snapshot me')});
 assert.equal((await readdir(join(data,'snapshots',projectId))).length,1,'a board mutation writes one snapshot');
 await mkdir(join(data,'credentials','projects',projectId),{recursive:true,mode:0o700});
 await writeFile(join(data,'credentials','providers.json'),JSON.stringify({openai:{type:'api_key',key:'sk-SYNTHETIC-PROVIDER-SECRET'}}));
 await writeFile(join(data,'credentials','projects',projectId,'id_ed25519'),'-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC-DEPLOY-KEY\n');
 await mkdir(join(data,'alerts'),{recursive:true,mode:0o700});
 await writeFile(join(data,'alerts','vapid.json'),JSON.stringify({privateKey:'SYNTHETIC-VAPID-PRIVATE'}));
 const manifest=await backup(data,archiveAt(root),{passphrase:PASSPHRASE});
 assert.ok(!manifest.files.some((entry:{path:string})=>entry.path.startsWith('credentials')));
 assert.ok(!manifest.files.some((entry:{path:string})=>entry.path.startsWith('alerts')));
 for(const excluded of ['credentials/','alerts/','service.lock',PAUSED_MARKER,'snapshots/']) assert.ok(manifest.excluded.some((entry:{path:string})=>entry.path===excluded),excluded+' is stated as excluded');
 // The application's own snapshot history is named for what it is, never reported as an entry the
 // tool failed to recognise, and it is not in the archive.
 const snapshotExclusion=manifest.excluded.find((entry:{path:string;reason:string})=>entry.path==='snapshots/') as {reason:string};
 assert.match(snapshotExclusion.reason,/board revision history/,'the snapshot history has an honest reason of its own');
 assert.equal(manifest.excluded.some((entry:{reason:string})=>entry.reason.startsWith('not captured by this tool')),false,'nothing the application itself writes falls into the unrecognised-entry branch');
 assert.equal(manifest.files.some((entry:{path:string})=>entry.path.startsWith('snapshots/')),false,'the snapshot history is not captured');
 const bytes=await readFile(archiveAt(root));
 for(const secret of ['sk-SYNTHETIC-PROVIDER-SECRET','SYNTHETIC-DEPLOY-KEY','SYNTHETIC-VAPID-PRIVATE'])
  assert.equal(bytes.includes(Buffer.from(secret)),false,'the archive bytes never carry '+secret);
 await restore(archiveAt(root),join(root,'restored'),{passphrase:PASSPHRASE});
 for(const unwanted of ['credentials','alerts','snapshots']) assert.equal(await exists(join(root,'restored',unwanted)),false,unwanted+' is not restored');
 // A manifest whose digest the payload cannot match is refused, and nothing is written.
 const catalogBytes=await readFile(join(data,'catalog.json'));
 const good=digestOf(catalogBytes),wrong=(good[0]==='a'?'b':'a')+good.slice(1);
 await syntheticArchive(join(root,'bad-digest.pbkp'),syntheticManifest([{path:'catalog.json',size:catalogBytes.length,sha256:wrong}]),[{path:'catalog.json',bytes:catalogBytes}]);
 await assert.rejects(restore(join(root,'bad-digest.pbkp'),join(root,'refused'),{passphrase:PASSPHRASE}),/do not match the digest its manifest records/);
 assert.equal(await exists(join(root,'refused')),false,'a digest mismatch leaves no destination');
 // A cut archive is refused by authentication, and also leaves no destination.
 const full=await readFile(archiveAt(root));
 await writeFile(join(root,'cut.pbkp'),full.subarray(0,full.length-32));
 await assert.rejects(restore(join(root,'cut.pbkp'),join(root,'cut-root'),{passphrase:PASSPHRASE}),/did not authenticate|truncated|unreadable|readable manifest record/);
 assert.equal(await exists(join(root,'cut-root')),false,'a truncated archive leaves no destination');
 // A wrong passphrase is refused by the same authentication, with nothing written.
 await assert.rejects(restore(archiveAt(root),join(root,'wrong-pass'),{passphrase:'a-different-long-enough-passphrase'}),/did not authenticate|readable manifest record|unreadable/);
 assert.equal(await exists(join(root,'wrong-pass')),false,'a wrong passphrase leaves no destination');
 assert.deepEqual(await stagingLeftovers(root),[],'every failed restore removes its staging area');
});


test('the payload allowlist and the staging check refuse every path that could escape the destination',()=>{
 // What the allowlist admits is exactly the shape this tool writes.
 for(const allowed of ['catalog.json','control.sqlite','settings/models.json','agents/'+projectId+'/session.sqlite','projects/'+projectId+'/docs/dashboard/board.md','projects/'+projectId+'/docs/dashboard/sources/22222222-2222-4222-8222-222222222222-'+'a'.repeat(64)+'.md'])
  assert.equal(isPayloadPath(allowed),true,allowed+' is a path this tool writes');
 // A '.', '..' or empty segment is refused exactly as the legacy branch's safe() refuses it, and so is
 // a leading slash or a backslash anywhere.
 for(const refused of ['projects/'+projectId+'/../../../x.html','projects/'+projectId+'/../catalog.json','projects/'+projectId+'/./x.html','projects/'+projectId+'//x.html','/catalog.json','/etc/passwd','..','.','','catalog.json/..','projects/'+projectId+'/docs\\x.html'])
  assert.equal(isPayloadPath(refused),false,JSON.stringify(refused)+' is refused');
 // The second containment layer refuses the resolved escape even when it is handed a path directly,
 // which is what protects the write site if the allowlist ever drifts.
 assert.throws(()=>stagedTarget('/tmp/stage','projects/'+projectId+'/../../../x.html'),/outside the restore destination/);
 assert.throws(()=>stagedTarget('/tmp/stage','..'),/outside the restore destination/);
 assert.throws(()=>stagedTarget('/tmp/stage','.'),/outside the restore destination/);
 assert.equal(stagedTarget('/tmp/stage','catalog.json'),'/tmp/stage/catalog.json');
 assert.equal(stagedTarget('/tmp/stage','projects/'+projectId+'/docs/dashboard/board.md'),'/tmp/stage/workspaces/'+projectId+'/docs/dashboard/board.md');
 let refusal='';
 try{stagedTarget('/tmp/stage','projects/'+projectId+'/../../../x.html');}catch(error){refusal=(error as Error).message;}
 assert.equal(refusal.includes('x.html'),false,'the refusal names no path, so a crafted archive has no oracle');
});

test('a crafted archive entry that would escape the destination writes nothing outside it',async()=>{
 const {root,data}=await emptyRoot('dashboard-backup-traversal-');
 const catalogBytes=await readFile(join(data,'catalog.json'));
 const crafted='projects/'+projectId+'/../../../escaped.html';
 const escaped=Buffer.from('<!doctype html><html><body>escaped</body></html>\n');
 await syntheticArchive(join(root,'crafted.pbkp'),syntheticManifest([
  {path:'catalog.json',size:catalogBytes.length,sha256:digestOf(catalogBytes)},
  {path:crafted,size:escaped.length,sha256:digestOf(escaped)}
 ]),[{path:'catalog.json',bytes:catalogBytes},{path:crafted,bytes:escaped}]);
 const before=(await readdir(root)).sort();
 await assert.rejects(restore(join(root,'crafted.pbkp'),join(root,'restored'),{passphrase:PASSPHRASE}),/never writes/);
 assert.equal(await exists(join(root,'escaped.html')),false,'no file appears where the crafted entry pointed');
 assert.equal(await exists(join(root,'restored')),false,'a refused restore leaves no destination');
 assert.deepEqual((await readdir(root)).sort(),before,'the directory around the destination is unchanged');
 assert.deepEqual(await stagingLeftovers(root),[],'a refused restore removes its staging area');
 await rm(root,{recursive:true,force:true});
});

test('a source that changes under the archive fails the backup instead of writing an archive its own manifest disagrees with',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-backup-mutating-'));
 const source=join(root,'catalog.json');
 await writeFile(source,'A'.repeat(64));
 const entry={path:'catalog.json',size:64,sha256:digestOf(Buffer.from('A'.repeat(64))),source};
 // Same length, different bytes: a size check alone would let this through, so only the digest,
 // re-checked as the source is streamed, refuses it — with the documented error.
 await writeFile(source,'B'.repeat(64));
 assert.equal((await readFile(source)).length,entry.size,'both reads see the same length');
 await assert.rejects(async()=>{for await(const chunk of archivePayload({manifest:{format:'pilot-backup',version:2,files:[entry]},entries:[entry]}))void chunk;},/source changed while it was being archived/);
 await rm(root,{recursive:true,force:true});
});

test('a manifest that names a path twice, or collides after mapping, is refused with nothing written',async()=>{
 const {root,data}=await emptyRoot('dashboard-backup-duplicate-');
 const catalogBytes=await readFile(join(data,'catalog.json')),sha=digestOf(catalogBytes);
 const duplicate=syntheticManifest([{path:'catalog.json',size:catalogBytes.length,sha256:sha},{path:'catalog.json',size:catalogBytes.length,sha256:sha}]);
 await syntheticArchive(join(root,'duplicate.pbkp'),duplicate,[{path:'catalog.json',bytes:catalogBytes},{path:'catalog.json',bytes:catalogBytes}]);
 await assert.rejects(restore(join(root,'duplicate.pbkp'),join(root,'refused'),{passphrase:PASSPHRASE}),/names the same path twice/);
 assert.equal(await exists(join(root,'refused')),false,'a duplicate manifest path leaves no destination');
 assert.deepEqual(await stagingLeftovers(root),[]);
 // The version-1 branch canonicalises an older board path to docs/dashboard/board.md, so two distinct
 // legacy entries can collide on one restored file: that collision is refused before anything is written.
 const legacy=join(root,'legacy'),board=Buffer.from('---\nversion: 1\n---\n'),catalog=Buffer.from(JSON.stringify({version:1,projects:[]}));
 await mkdir(join(legacy,'projects',projectId),{recursive:true,mode:0o700});
 await writeFile(join(legacy,'projects',projectId,'board.md'),board);
 await writeFile(join(legacy,'catalog.json'),catalog);
 await writeFile(join(legacy,'manifest.json'),JSON.stringify({version:1,created:new Date().toISOString(),files:[
  {path:'catalog.json',sha256:digestOf(catalog)},
  {path:'projects/'+projectId+'/board.md',sha256:digestOf(board)},
  {path:'projects/'+projectId+'/docs/dashboard/board.md',sha256:digestOf(board)}
 ]}));
 await assert.rejects(restore(legacy,join(root,'legacy-root')),/names the same path twice/);
 assert.equal(await exists(join(root,'legacy-root')),false,'a colliding legacy path leaves no destination');
 await rm(root,{recursive:true,force:true});
});

test('verify authenticates an archive and checks every payload digest while writing nothing',async()=>{
 const {root,data}=await emptyRoot('dashboard-backup-verify-');
 const archive=join(root,'backup.pbkp');
 const written=await backup(data,archive,{passphrase:PASSPHRASE});
 const before=(await readdir(root)).sort();
 const result=await verifyArchive(archive,{passphrase:PASSPHRASE});
 assert.equal(result.verified,true);
 assert.equal(result.files,written.files.length);
 assert.equal(result.archiveDigest,written.digest,'verify reports the digest of the bytes it authenticated');
 assert.deepEqual((await readdir(root)).sort(),before,'verification creates nothing beside the archive');
 assert.equal(digestOf(await readFile(archive)),written.digest,'verification leaves the archive byte-identical');
 assert.ok(result.excluded.some((entry:{path:string})=>entry.path==='credentials/'),'verify reports the exclusions the archive carries');
 // A wrong passphrase and a tampered archive are refused by the same authentication a restore runs.
 await assert.rejects(verifyArchive(archive,{passphrase:'a-different-long-enough-passphrase'}),/did not authenticate|readable manifest record|unreadable/);
 const bytes=await readFile(archive);
 await writeFile(join(root,'cut.pbkp'),bytes.subarray(0,bytes.length-32));
 await assert.rejects(verifyArchive(join(root,'cut.pbkp'),{passphrase:PASSPHRASE}),/did not authenticate|truncated|unreadable|readable manifest record/);
 // A digest the payload does not match is refused here too, with nothing written beside the archive.
 const catalogBytes=await readFile(join(data,'catalog.json'));
 await syntheticArchive(join(root,'bad-digest.pbkp'),syntheticManifest([{path:'catalog.json',size:catalogBytes.length,sha256:'0'.repeat(64)}]),[{path:'catalog.json',bytes:catalogBytes}]);
 await assert.rejects(verifyArchive(join(root,'bad-digest.pbkp'),{passphrase:PASSPHRASE}),/do not match the digest its manifest records/);
 // A plaintext version-1 directory is not an archive, and verify says so rather than guessing.
 await assert.rejects(verifyArchive(root,{passphrase:PASSPHRASE}),/single-file archive/);
 await rm(root,{recursive:true,force:true});
});

test('a destination inside a live data root is refused, and nothing is created inside it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-backup-inside-'));
 const other=join(root,'other'),live=join(root,'live');
 for(const dir of [other,live]){await mkdir(dir,{recursive:true,mode:0o700});await writeFile(join(dir,'catalog.json'),JSON.stringify({version:1,projects:[]})+ '\n');}
 const lock='lock evidence held by the live service\n';
 await writeFile(join(live,'service.lock'),lock);
 const archive=join(root,'backup.pbkp');
 await backup(other,archive,{passphrase:PASSPHRASE});
 const before=(await readdir(live)).sort(),inside=join(live,'restored');
 let refusal='';
 await assert.rejects(restore(archive,inside,{passphrase:PASSPHRASE}),(error:Error)=>{refusal=error.message;return /inside a data root that carries lock evidence/.test(error.message);});
 assert.equal(await exists(inside),false,'nothing is created inside the live data root');
 assert.deepEqual((await readdir(live)).sort(),before,'the live root is unchanged');
 assert.equal(await readFile(join(live,'service.lock'),'utf8'),lock,'the live lock is byte-identical after the refusal');
 assert.equal(refusal.includes(live),false,'the refusal names no path');
 assert.deepEqual(await stagingLeftovers(root),[],'the refusal happens before any staging area exists');
 await rm(root,{recursive:true,force:true});
});

test('promotion re-checks the archive a root was restored from',async()=>{
 const {root,data}=await emptyRoot('dashboard-backup-promote-');
 const archive=join(root,'backup.pbkp');
 await backup(data,archive,{passphrase:PASSPHRASE});
 const restored=join(root,'restored');
 const result=await restore(archive,restored,{passphrase:PASSPHRASE});
 assert.equal(result.marker.archive.path,archive,'the marker names the archive it was restored from');
 assert.equal(result.marker.complete,true,'a finished restore marks its root complete');
 const bytes=await readFile(archive);
 const tampered=Buffer.from(bytes);tampered[tampered.length-1]^=0x01;
 await writeFile(archive,tampered);
 await assert.rejects(promote(restored),/no longer matches the digest its restore marker recorded/);
 assert.equal(await exists(join(restored,PAUSED_MARKER)),true,'a refused promotion leaves the marker in place');
 await writeFile(archive,bytes);
 const promoted=await promote(restored);
 assert.equal(promoted.promoted,true,'the same root promotes once its archive matches again');
 await rm(root,{recursive:true,force:true});
});

test('a backup never touches a file it did not create',async()=>{
 const {root,data}=await emptyRoot('dashboard-backup-existing-');
 const archive=join(root,'backup.pbkp');
 await writeFile(archive,'a file that was already here\n');
 await assert.rejects(backup(data,archive,{passphrase:PASSPHRASE}),/already exists/);
 assert.equal(await readFile(archive,'utf8'),'a file that was already here\n','an existing file at the archive path is never overwritten or removed');
 assert.deepEqual((await readdir(root)).sort(),['backup.pbkp','data'],'a refused backup leaves no archive and no scratch file');
 await rm(root,{recursive:true,force:true});
});

/**
 * The media store is application state, so it is part of the complete state a backup captures. A
 * restore that did not carry it would silently lose every stored image: this is the round trip that
 * says it does not.
 */
test('a stored image survives a backup and a restore, and credentials still do not',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-backup-media-')),data=join(root,'data');
  await mkdir(data,{recursive:true,mode:0o700});
  await writeFile(join(data,'catalog.json'),JSON.stringify({version:1,projects:[]})+ '\n');
  // A stored image in the store's own layout: content-addressed by the sha256 of the bytes, 0600
  // inside a 0700 media directory. The id is the digest, so this is the object the store would have
  // written for these bytes.
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwnnkGAAKbAZnxMlgqAAAAAElFTkSuQmCC','base64');
  const id=digestOf(image);
  await mkdir(join(data,'media'),{recursive:true,mode:0o700});
  await writeFile(join(data,'media',id+'.bin'),image,{mode:0o600});
  await mkdir(join(data,'credentials','projects'),{recursive:true,mode:0o700});
  await writeFile(join(data,'credentials','providers.json'),JSON.stringify({openai:{type:'api_key',key:'sk-SYNTHETIC-PROVIDER-SECRET'}}));
  const manifest=await backup(data,archiveAt(root),{passphrase:PASSPHRASE});
  const entry=manifest.files.find((file:{path:string})=>file.path==='media/'+id+'.bin');
  assert.ok(entry,'the stored image is a manifest entry of the archive');
  assert.equal(entry.sha256,id,'the manifest records the bytes the object is named for');
  assert.equal(entry.size,image.length);
  assert.equal(manifest.excluded.some((exclusion:{path:string})=>exclusion.path==='media'),false,'media/ is a captured source, not an unrecognised entry');
  assert.ok(!manifest.files.some((file:{path:string})=>file.path.startsWith('credentials')),'credentials are still excluded');
  assert.ok(!(await readFile(archiveAt(root))).includes(Buffer.from('sk-SYNTHETIC-PROVIDER-SECRET')),'the archive bytes still carry no credential');
  const restored=join(root,'restored');
  await restore(archiveAt(root),restored,{passphrase:PASSPHRASE});
  assert.deepEqual(await readFile(join(restored,'media',id+'.bin')),image,'the stored bytes survive the round trip');
  assert.equal((await stat(join(restored,'media',id+'.bin'))).mode&0o777,0o600,'a restored object is owner-only, as the store wrote it');
  assert.equal(await exists(join(restored,'credentials')),false,'the restored root still has no credentials');
  // Read back through the application's own store: the restored object is served, not just present.
  const served=await new MediaStore(restored).get(id);
  assert.ok(served,'the restored root serves the stored image');
  assert.equal(served.mimeType,'image/png');
  assert.deepEqual(Buffer.from(served.bytes),image);
  await rm(root,{recursive:true,force:true});
});

/**
 * The container is validated before its contents are read, so the manifest can never claim a capture
 * of `media/` that did not happen. A symlinked `media` is never followed — following it would archive
 * objects from outside the data root — a `media` that is not a directory is not read as an empty
 * store, and one that cannot be read is not silently worth zero objects: each fails the whole backup
 * closed. A root that never stored an image simply has no container, and that is not a failure.
 */
test('a media container that is a symlink, a file or unreadable fails the backup instead of capturing nothing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-backup-media-container-')),data=join(root,'data');
  const outside=await mkdtemp(join(tmpdir(),'dashboard-backup-media-outside-'));
  await mkdir(data,{recursive:true,mode:0o700});
  await writeFile(join(data,'catalog.json'),JSON.stringify({version:1,projects:[]})+ '\n');
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwnnkGAAKbAZnxMlgqAAAAAElFTkSuQmCC','base64');
  try{
    // A symlinked container: the object behind it is never archived, and the backup fails closed.
    await writeFile(join(outside,digestOf(image)+'.bin'),image,{mode:0o600});
    await symlink(outside,join(data,'media'));
    await assert.rejects(()=>backup(data,archiveAt(root),{passphrase:PASSPHRASE}),/media is a symbolic link/);
    assert.equal(await exists(archiveAt(root)),false,'a refused backup leaves no archive');
    await unlink(join(data,'media'));
    // A media entry that is not a directory cannot hold objects, and reading it as an empty store would
    // be exactly the silent capture the manifest must never make.
    await writeFile(join(data,'media'),'not a directory');
    await assert.rejects(()=>backup(data,archiveAt(root),{passphrase:PASSPHRASE}),/media is not a directory/);
    assert.equal(await exists(archiveAt(root)),false,'a refused backup leaves no archive');
    await unlink(join(data,'media'));
    // A container that exists but cannot be read is not worth zero objects without a word.
    await mkdir(join(data,'media'),{mode:0o000});
    await assert.rejects(()=>backup(data,archiveAt(root),{passphrase:PASSPHRASE}),/media directory could not be read/);
    assert.equal(await exists(archiveAt(root)),false,'a refused backup leaves no archive');
    await chmod(join(data,'media'),0o700);
    // A root that never stored an image has no container at all: that is not a failure, and no media
    // entry is claimed for it.
    await rm(join(data,'media'),{recursive:true,force:true});
    const empty=await backup(data,archiveAt(root),{passphrase:PASSPHRASE});
    assert.equal(empty.files.some((file:{path:string})=>file.path.startsWith('media/')),false,'an absent container claims no media entry');
    assert.equal(empty.excluded.some((entry:{path:string})=>entry.path.startsWith('media')),false,'and it is not reported as an exclusion either');
  }finally{
    await rm(root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

/**
 * The shape of an entry under `media/` is validated as well: the one regular `<sha256>.bin` object is
 * captured, and anything else there is reported as an exclusion with its own reason rather than copied
 * blindly or dropped without a word.
 */
test('a media entry outside the documented object shape is reported as excluded, and the real object is captured',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-backup-media-shape-')),data=join(root,'data');
  await mkdir(data,{recursive:true,mode:0o700});
  await writeFile(join(data,'catalog.json'),JSON.stringify({version:1,projects:[]})+ '\n');
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwnnkGAAKbAZnxMlgqAAAAAElFTkSuQmCC','base64');
  const id=digestOf(image);
  await mkdir(join(data,'media'),{recursive:true,mode:0o700});
  await writeFile(join(data,'media',id+'.bin'),image,{mode:0o600});
  await mkdir(join(data,'media','subdir'),{mode:0o700});
  await writeFile(join(data,'media','notes.txt'),'not an object');
  try{
    const manifest=await backup(data,archiveAt(root),{passphrase:PASSPHRASE});
    assert.ok(manifest.files.some((file:{path:string})=>file.path==='media/'+id+'.bin'),'the real object is captured');
    const excluded=manifest.excluded.filter((entry:{path:string})=>entry.path.startsWith('media/'));
    assert.deepEqual(excluded.map((entry:{path:string})=>entry.path).sort(),['media/notes.txt','media/subdir'],'each entry outside the shape is reported');
    assert.ok(excluded.some((entry:{reason:string})=>entry.reason.includes('only regular media objects')),'a non-file states that reason');
    assert.ok(excluded.some((entry:{reason:string})=>entry.reason.includes('documented <sha256>.bin shape')),'a wrong name states that reason');
  }finally{await rm(root,{recursive:true,force:true});}
});
