import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const digestOf=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {backup,restore} from '../../scripts/data-tools.mjs';
import {Catalog} from '../../src/server/catalog';
import {BoardStore} from '../../src/server/board-store';
test('pristine catalog supports an offline bootstrap backup and isolated restore',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-bootstrap-')),data=join(root,'data'),c=new Catalog(data,[],new BoardStore(data));
 try{
  await c.init();assert.deepEqual(JSON.parse(await readFile(join(data,'catalog.json'),'utf8')),{version:1,projects:[]});
  await assert.rejects(backup(data,join(root,'blocked')));
  await c.close();const manifest=await backup(data,join(root,'backup'));assert.equal(manifest.files.length,1);
  const result=await restore(join(root,'backup'),join(root,'restored'));assert.equal(result.projects,0);
  assert.deepEqual(JSON.parse(await readFile(join(root,'restored/catalog.json'),'utf8')),{version:1,projects:[]});
 }finally{await c.close();await rm(root,{recursive:true,force:true});}
});

test('a managed project backs up its documentation and an external one only its board',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-backup-scope-')),data=join(root,'data'),c=new Catalog(data,[root],new BoardStore(data));await c.init();
 try{
  const managed=await c.register({name:'Managed',managed:true,confirm:true});
  await mkdir(join(managed.path,'docs','spec'),{recursive:true});
  await writeFile(join(managed.path,'docs','spec','alpha.md'),'# Alpha\n\nA spec the wiki owns.\n');
  await mkdir(join(managed.path,'node_modules','pkg'),{recursive:true});
  await writeFile(join(managed.path,'node_modules','pkg','readme.md'),'# Vendored\n');
  const externalPath=join(root,'external');await mkdir(join(externalPath,'docs','dashboard'),{recursive:true});
  await writeFile(join(externalPath,'README.md'),'# Repository readme\n');
  await writeFile(join(externalPath,'docs','notes.md'),'# Repository notes\n');
  await writeFile(join(externalPath,'docs','dashboard','board.md'),'---\nversion: 1\n---\n');
  const external=await c.register({name:'External',path:externalPath,managed:false,confirm:true});
  await c.close();
  const manifest=await backup(data,join(root,'backup')) as { files: { path: string; sha256: string }[] };
  const paths=manifest.files.map(entry=>entry.path).sort();
  assert.ok(paths.includes('projects/'+managed.id+'/docs/spec/alpha.md'),'managed documentation is included');
  assert.ok(paths.includes('projects/'+managed.id+'/docs/dashboard/board.md'),'the managed board is included');
  assert.ok(!paths.some(path=>path.includes('node_modules')),'generated folders are excluded');
  assert.deepEqual(paths.filter(path=>path.startsWith('projects/'+external.id+'/')),['projects/'+external.id+'/docs/dashboard/board.md'],'an external project contributes only its board');
  await restore(join(root,'backup'),join(root,'restored'));
  const catalog=JSON.parse(await readFile(join(root,'restored','catalog.json'),'utf8')) as { projects: { id: string; path: string }[] };
  const restoredManaged=catalog.projects.find(project=>project.id===managed.id)!.path;
  assert.equal(await readFile(join(restoredManaged,'docs','spec','alpha.md'),'utf8'),'# Alpha\n\nA spec the wiki owns.\n');
  assert.equal(await readFile(join(restoredManaged,'docs','dashboard','board.md'),'utf8'),await readFile(join(managed.path,'docs','dashboard','board.md'),'utf8'));
  const restoredExternal=catalog.projects.find(project=>project.id===external.id)!.path;
  assert.equal(await readFile(join(restoredExternal,'docs','dashboard','board.md'),'utf8'),'---\nversion: 1\n---\n');
  assert.equal(await stat(join(restoredExternal,'README.md')).then(()=>true).catch(()=>false),false,'a repository readme is not copied');
 }finally{await c.close().catch(()=>{});await rm(root,{recursive:true,force:true});}
});

test('a backup written before the wiki still restores its board',async()=>{
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
 const result=await restore(backupDir,join(root,'restored')) as { projects: number; root: string };
 assert.equal(result.projects,1);
 const restored=join(result.root,'workspaces',id);
 assert.equal(await readFile(join(restored,'docs','dashboard','board.md'),'utf8'),board);
 assert.equal(await readFile(join(restored,'docs','dashboard','sources','22222222-2222-4222-8222-222222222222-'+'a'.repeat(64)+'.md'),'utf8'),source);
 await rm(root,{recursive:true,force:true});
});
test('offline backup refuses live service; isolated restore matches board bytes; tampering rejected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-backup-')),data=join(root,'data'),c=new Catalog(data,[],new BoardStore(data));await c.init();
 const p=await c.register({name:'Backup fixture',managed:true,confirm:true}),original=await readFile(join(p.path,'docs/dashboard/board.md'));
 await assert.rejects(backup(data,join(root,'blocked')));
 await c.close();
 await backup(data,join(root,'backup'));await restore(join(root,'backup'),join(root,'restored'));
 const catalog=JSON.parse(await readFile(join(root,'restored/catalog.json'),'utf8')),target=catalog.projects[0].path;
 assert.deepEqual(await readFile(join(target,'docs/dashboard/board.md')),original);
 await writeFile(join(root,'backup/projects',p.id,'docs/dashboard/board.md'),'tampered');
 await assert.rejects(restore(join(root,'backup'),join(root,'tampered-restore')),/checksum/);
});
