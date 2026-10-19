import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,stat,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DocStore } from '../../src/server/docs-store';
import { BoardStore } from '../../src/server/board-store';
import { Catalog } from '../../src/server/catalog';
import type { Project } from '../../src/shared/model';

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'dashboard-docs-'));
  const project: Project={id:randomUUID(),name:'Fixture',path:dir,managed:false,repository:'',created:new Date().toISOString()};
  return {dir,project};
}

test('document edits are revision-checked and survive a restart',async()=>{
  const {project}=await fixture(),store=new DocStore();
  const created=await store.create(project,'docs/spec/product.md','# Product\n\nIntent.\n');
  assert.equal(created.kind,'spec');
  await assert.rejects(store.create(project,'docs/spec/product.md','replacement'),/already exists/);
  const updated=await store.write(project,'docs/spec/product.md',created.revision,'# Product\n\nIntent updated.\n');
  assert.notEqual(updated.revision,created.revision);
  await assert.rejects(store.write(project,'docs/spec/product.md',created.revision,'# Rewritten\n'),/changed on disk/);
  assert.equal(await readFile(join(project.path,'docs/spec/product.md'),'utf8'),'# Product\n\nIntent updated.\n');
  const reopened=await new DocStore().read(project,'docs/spec/product.md');
  assert.equal(reopened.revision,updated.revision);
  assert.deepEqual(reopened.headings.map(h=>h.slug),['product']);
});

test('containment, extension allow-list and managed paths are refused',async()=>{
  const {dir,project}=await fixture(),store=new DocStore();
  const outside=await mkdtemp(join(tmpdir(),'dashboard-docs-out-'));
  await mkdir(join(dir,'docs'));
  await symlink(outside,join(dir,'docs','linked'));
  await assert.rejects(store.read(project,'../outside.md'),/Unsafe/);
  await assert.rejects(store.read(project,'/etc/hosts'),/repository-relative/);
  await assert.rejects(store.read(project,'notes.txt'),/Markdown/);
  await assert.rejects(store.read(project,'docs/linked/hidden.md'),/Symlinks/);
  await assert.rejects(store.read(project,'docs/dashboard/board.md'),/managed/);
  await assert.rejects(store.create(project,'docs/dashboard/board.md','# Nope\n'),/managed/);
  await assert.rejects(store.write(project,'node_modules/pkg/readme.md','x','y'),/Generated/);
  const nested=await store.create(project,'docs/missing/parent/page.md','# Nested\n');
  assert.equal(nested.path,'docs/missing/parent/page.md');
  await assert.rejects(store.create(project,'docs/linked/escape.md','# Nope\n'),/Symlinks/);
  assert.equal(await stat(join(outside,'escape.md')).then(()=>true).catch(()=>false),false);
});

test('listing skips generated folders, managed paths and symlinks; size limits hold',async()=>{
  const {dir,project}=await fixture(),store=new DocStore({listLimit:100,readLimit:1024,writeLimit:1024});
  await mkdir(join(dir,'docs'),{recursive:true});
  await mkdir(join(dir,'node_modules','pkg'),{recursive:true});
  await mkdir(join(dir,'docs','dashboard','sources'),{recursive:true});
  const outside=await mkdtemp(join(tmpdir(),'dashboard-docs-out-'));
  await symlink(outside,join(dir,'docs','linked'));
  await writeFile(join(dir,'README.md'),'# Root\n');
  await writeFile(join(dir,'docs','guide.md'),'# Guide\n');
  await writeFile(join(dir,'node_modules','pkg','readme.md'),'# Ignored\n');
  await writeFile(join(dir,'docs','dashboard','board.md'),'managed');
  await writeFile(join(dir,'docs','dashboard','sources','abc.md'),'snapshot');
  await writeFile(join(outside,'hidden.md'),'# Hidden\n');
  const listed=await store.list(project);
  assert.deepEqual(listed.map(e=>e.path),['README.md','docs/guide.md']);
  assert.equal(listed.find(e=>e.path==='README.md')?.kind,'guide');
  await writeFile(join(dir,'docs','big.md'),'x'.repeat(4096));
  await assert.rejects(store.read(project,'docs/big.md'),/size limit/);
  const guide=await store.read(project,'docs/guide.md');
  await assert.rejects(store.write(project,'docs/guide.md',guide.revision,'y'.repeat(4096)),/size limit/);
});

test('open questions are extracted and a write keeps the file mode',async()=>{
  const {project}=await fixture(),store=new DocStore();
  const created=await store.create(project,'docs/notes.md','# Notes\n\n## Open questions\n\n- [ ] Which host?\n- [x] Old question\n');
  assert.equal(created.kind,'question');
  assert.deepEqual(created.questions.map(q=>[q.text,q.done]),[['Which host?',false],['Old question',true]]);
  const before=(await stat(join(project.path,'docs/notes.md'))).mode & 0o777;
  const written=await store.write(project,'docs/notes.md',created.revision,created.text+'\nMore.\n');
  const after=(await stat(join(project.path,'docs/notes.md'))).mode & 0o777;
  assert.equal(after,before);
  assert.equal(written.questions.length,2);
});

test('content search and documentation assets are bounded and contained',async()=>{
  const {dir,project}=await fixture(),store=new DocStore({searchMatches:2,searchBytes:100000,assetLimit:64});
  await mkdir(join(dir,'docs'),{recursive:true});
  await writeFile(join(dir,'docs','a.md'),'# A\n\nalpha needle\nbeta\nneedle again\n');
  await writeFile(join(dir,'docs','b.md'),'# B\n\nneedle here\n');
  const found=await store.search(project,'needle');
  assert.equal(found.length,2);
  assert.deepEqual(found.map(m=>m.path),['docs/a.md','docs/a.md']);
  assert.equal(found[0].line,3);
  assert.equal(found[0].text,'alpha needle');
  await assert.rejects(store.search(project,'n'),/at least two/);
  const png=Buffer.from('89504e470d0a1a0a','hex');
  await writeFile(join(dir,'docs','pixel.png'),png);
  const pixel=await store.asset(project,'docs/pixel.png');
  assert.equal(pixel.type,'image/png');assert.equal(pixel.sandboxed,false);assert.deepEqual(pixel.bytes,png);
  await writeFile(join(dir,'docs','mockup.html'),'<p>Static</p>');
  const mockup=await store.asset(project,'docs/mockup.html');
  assert.equal(mockup.sandboxed,true);assert.match(mockup.type,/text\/html/);
  await assert.rejects(store.asset(project,'docs/a.md'),/Only documentation images/);
  await assert.rejects(store.asset(project,'../outside.png'),/Unsafe/);
  await writeFile(join(dir,'docs','big.png'),Buffer.alloc(200));
  await assert.rejects(store.asset(project,'docs/big.png'),/size limit/);
  await assert.rejects(store.asset(project,'docs/missing.png'),/Asset not found/);
});

test('the questions inbox lists open questions across documents',async()=>{
  const {dir,project}=await fixture(),store=new DocStore();
  await mkdir(join(dir,'docs'),{recursive:true});
  await writeFile(join(dir,'docs','a.md'),'# A\n\n## Open questions\n\n- [ ] Ship date?\n- [x] Settled already\n');
  await writeFile(join(dir,'docs','b.md'),'# B\n\n## Needs me\n\n- [ ] Which provider?\n- [ ] Which provider?\n');
  const questions=await store.inbox(project);
  assert.deepEqual(questions.map(q=>q.path),['docs/a.md','docs/b.md','docs/b.md']);
  assert.deepEqual(questions.map(q=>q.text),['Ship date?','Which provider?','Which provider?']);
  assert.deepEqual(questions.map(q=>q.id),['ship-date','which-provider','which-provider-2']);
  assert.equal(questions[0].anchor,'open-questions');
  assert.equal(questions[0].line,5);
});

test('documents are edited through a registered project and app-managed paths stay out of the listing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dashboard-docs-catalog-'));
  const books=new BoardStore(dir),catalog=new Catalog(dir,[dir],books),docs=new DocStore();
  await catalog.init();
  try{
    const project=await catalog.register({name:'Fixture',path:dir,managed:false,confirm:true});
    const created=await docs.create(project,'docs/wiki/intent.md','# Intent\n\nWhy we build this.\n');
    const edited=await docs.write(project,'docs/wiki/intent.md',created.revision,'# Intent\n\nWhy we build this, revised.\n');
    assert.match(edited.text,/revised/);
    assert.equal((await docs.list(project)).some(e=>e.path.startsWith('docs/dashboard')),false);
  }finally{await catalog.close();}
});
