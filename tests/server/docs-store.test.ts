import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,open,readFile,readdir,rename,stat,symlink,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DocStore,readBoundedRegularFile } from '../../src/server/docs-store';
import { BoardStore, HttpError } from '../../src/server/board-store';
import { LinuxProcfsReadError } from '../../src/server/linux-procfs-read';
import { createLinuxProcfsFileBeneath } from '../../src/server/linux-procfs-create';
import { Catalog } from '../../src/server/catalog';
import { safePath } from '../../src/server/paths';
import type { Project } from '../../src/shared/model';


async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'dashboard-docs-'));
  const project: Project={id:randomUUID(),name:'Fixture',path:dir,managed:false,repository:'',created:new Date().toISOString()};
  return {dir,project};
}

// Constructor-only disposable-test seam. Production construction always uses the Linux reader.
const testStore = (overrides: ConstructorParameters<typeof DocStore>[0] = {}, integrations?: ConstructorParameters<typeof DocStore>[1], opener?: ConstructorParameters<typeof DocStore>[2]) =>
  new DocStore(overrides, integrations, opener, async (root, relative, limit) => {
    const path = await safePath(root, relative);
    return readBoundedRegularFile(path, limit, opener);
  });

const linuxOnly = { skip: process.platform !== 'linux' ? 'requires Linux procfs descriptor-relative creation' : false };

test('Linux create pins parent descriptors across a deterministic parent swap before exclusive open', linuxOnly, async () => {
  const {dir,project}=await fixture();
  const parent=join(dir,'docs','swap'),moved=join(dir,'docs','moved');
  const outside=await mkdtemp(join(tmpdir(),'dashboard-docs-create-out-'));
  await mkdir(parent,{recursive:true});
  let swapped=false;
  const swapOpen:typeof open=async(path,flags,mode)=>{
    if(!swapped && typeof path==='string' && path.endsWith('/page.md')) {
      await rename(parent,moved);
      await symlink(outside,parent);
      swapped=true;
    }
    return open(path,flags,mode);
  };
  const store=new DocStore({},undefined,undefined,undefined,async(root,relative,fileMode,directoryMode)=>
    createLinuxProcfsFileBeneath(root,relative,fileMode,directoryMode,swapOpen));
  const created=await store.create(project,'docs/swap/page.md','# Pinned\n');
  assert.equal(swapped,true);
  assert.equal(created.text,'# Pinned\n');
  assert.equal(await readFile(join(moved,'page.md'),'utf8'),'# Pinned\n');
  assert.equal(await readFile(join(outside,'page.md'),'utf8').catch(()=>null),null);
});

test('Linux create reports post-open stat and directory-close failures as uncertain and closes the result', linuxOnly, async () => {
  for (const failure of ['stat','directory-close','stat-directory-close'] as const) {
    const {dir,project}=await fixture();
    let resultClosed=false;
    let injectedDirectoryClose=false;
    const injectedOpen:typeof open=async(path,flags,mode)=>{
      const handle=await open(path,flags,mode);
      if (typeof path==='string' && path.endsWith('/stat.md')) {
        const wrapped=handle as unknown as {stat:()=>Promise<unknown>;close:()=>Promise<void>};
        const close=handle.close.bind(handle),originalStat=handle.stat.bind(handle);
        if(failure==='stat'||failure==='stat-directory-close')wrapped.stat=async()=>{await originalStat();throw new Error('injected result stat failure');};
        wrapped.close=async()=>{resultClosed=true;await close();};
      } else if (path==='/') {
        const wrapped=handle as unknown as {close:()=>Promise<void>};
        const close=handle.close.bind(handle);
        wrapped.close=async()=>{
          if((failure==='directory-close'||failure==='stat-directory-close')&&!injectedDirectoryClose){injectedDirectoryClose=true;await close();throw new Error('injected directory close failure');}
          await close();
        };
      }
      return handle;
    };
    const store=new DocStore({},undefined,undefined,undefined,async(root,relative,fileMode,directoryMode)=>
      createLinuxProcfsFileBeneath(root,relative,fileMode,directoryMode,injectedOpen));
    const createError=await store.create(project,'docs/stat.md','data').then(()=>null,error=>error);
    assert.ok(createError instanceof HttpError);
    assert.equal(createError.status,503);
    assert.equal(createError.code,'DOC_CREATE_UNCERTAIN');
    assert.match(createError.message,/Do not retry automatically/);
    if(failure==='stat-directory-close') {
      const causes=(createError.cause as AggregateError).errors;
      assert.equal(causes.length,2);
      assert.match(String(causes[0]),/injected result stat failure/);
      assert.match(String(causes[1]),/injected directory close failure/);
    } else assert.match((createError.cause as Error).message,/injected/);
    assert.equal(resultClosed,true);
    assert.equal(await readFile(join(dir,'docs/stat.md'),'utf8'),'');
    await assert.rejects(store.create(project,'docs/stat.md','retry'),(error:unknown)=>error instanceof HttpError&&error.status===409);
  }
});

test('Linux create reports write, sync and close failures as uncertain without deleting or retrying', linuxOnly, async () => {
  for (const failure of ['write','sync','close','write-close'] as const) {
    const {dir,project}=await fixture();
    let closeCalled=0;
    const store=new DocStore({},undefined,undefined,undefined,async(root,relative,fileMode,directoryMode)=>{
      const handle=await createLinuxProcfsFileBeneath(root,relative,fileMode,directoryMode);
      const wrapped=handle as unknown as {writeFile:(text:string)=>Promise<void>;sync:()=>Promise<void>;close:()=>Promise<void>};
      const closeOriginal=handle.close.bind(handle),syncOriginal=handle.sync.bind(handle);
      if(failure==='write'||failure==='write-close')wrapped.writeFile=async(text)=>{
        const partial=Buffer.from(text.slice(0,7));
        await handle.write(partial,0,partial.length,null);
        throw new Error('injected write failure after partial write');
      };
      if(failure==='sync')wrapped.sync=async()=>{await syncOriginal();throw new Error('injected sync failure after sync');};
      wrapped.close=async()=>{closeCalled++;await closeOriginal();if(failure==='close'||failure==='write-close')throw new Error('injected close failure');};
      return handle;
    });
    const createError=await store.create(project,'docs/uncertain.md','partial content').then(()=>null,error=>error);
    assert.ok(createError instanceof HttpError);
    assert.equal(createError.status,503);
    assert.equal(createError.code,'DOC_CREATE_UNCERTAIN');
    assert.match(createError.message,/Do not retry automatically/);
    if(failure==='write-close')assert.ok((createError.cause as AggregateError).errors.length===2);
    else assert.ok(createError.cause instanceof Error);
    assert.equal(closeCalled,1);
    assert.equal(await readFile(join(dir,'docs/uncertain.md'),'utf8').catch(()=>'<missing>'),failure==='write'||failure==='write-close'?'partial': 'partial content');
    await assert.rejects(store.create(project,'docs/uncertain.md','retry'),(error:unknown)=>error instanceof HttpError&&error.status===409);
  }
});

test('Linux create refuses symlink/non-directory parents, preserves 409, creates nested parents and closes descriptors', linuxOnly, async () => {
  const {dir,project}=await fixture(),store=new DocStore();
  const outside=await mkdtemp(join(tmpdir(),'dashboard-docs-create-link-'));
  await mkdir(join(dir,'docs'),{recursive:true});
  await symlink(outside,join(dir,'docs','linked'));
  await writeFile(join(outside,'hidden.md'),'outside');
  await symlink(join(outside,'hidden.md'),join(dir,'docs','linked-file.md'));
  await writeFile(join(dir,'docs','file.md'),'file');
  execFileSync('mkfifo',[join(dir,'docs','fifo.md')]);
  await assert.rejects(store.create(project,'docs/linked/escape.md','x'),(error:unknown)=>error instanceof HttpError&&error.status===422);
  await assert.rejects(store.create(project,'docs/linked-file.md','replacement'),(error:unknown)=>error instanceof HttpError&&error.status===409);
  await assert.rejects(store.create(project,'docs/fifo.md','replacement'),(error:unknown)=>error instanceof HttpError&&error.status===409);
  assert.equal(await readFile(join(outside,'hidden.md'),'utf8'),'outside');
  await assert.rejects(store.create(project,'docs/file.md','x'),(error:unknown)=>error instanceof HttpError&&error.status===409);
  await assert.rejects(store.create(project,'docs/file.md/child.md','x'),(error:unknown)=>error instanceof HttpError&&error.status===422);
  const before=(await readdir('/proc/self/fd')).length;
  const created=await store.create(project,'docs/a/b/page.md','# Nested\n');
  const after=(await readdir('/proc/self/fd')).length;
  assert.equal(created.path,'docs/a/b/page.md');
  assert.equal(await readFile(join(dir,'docs/a/b/page.md'),'utf8'),'# Nested\n');
  assert.equal((await stat(join(dir,'docs/a/b'))).mode&0o777,0o755);
  assert.equal((await stat(join(dir,'docs/a/b/page.md'))).mode&0o777,0o644);
  assert.equal(after,before);
});

test('document edits are revision-checked and survive a restart',linuxOnly,async()=>{
  const {project}=await fixture(),store=testStore();
  const created=await store.create(project,'docs/spec/product.md','# Product\n\nIntent.\n');
  assert.equal(created.kind,'spec');
  await assert.rejects(store.create(project,'docs/spec/product.md','replacement'),/already exists/);
  const updated=await store.write(project,'docs/spec/product.md',created.revision,'# Product\n\nIntent updated.\n');
  assert.notEqual(updated.revision,created.revision);
  await assert.rejects(store.write(project,'docs/spec/product.md',created.revision,'# Rewritten\n'),/changed on disk/);
  assert.equal(await readFile(join(project.path,'docs/spec/product.md'),'utf8'),'# Product\n\nIntent updated.\n');
  const reopened=await testStore().read(project,'docs/spec/product.md');
  assert.equal(reopened.revision,updated.revision);
  assert.deepEqual(reopened.headings.map(h=>h.slug),['product']);
});


test('an injected backend failure maps to 503 without a pathname fallback (seam behavior only)',async()=>{
  const {project}=await fixture();
  let reads=0;
  const unavailable=async () => { reads++; throw new LinuxProcfsReadError('BACKEND_UNAVAILABLE'); };
  const store=new DocStore({},undefined,undefined,unavailable);
  const isUnavailable=(error:unknown)=>error instanceof HttpError && error.status===503;
  await assert.rejects(store.read(project,'docs/example.md'),isUnavailable);
  await assert.rejects(store.asset(project,'docs/example.png'),isUnavailable);
  assert.equal(reads,2);
});

test('the default reader reports unsupported platforms as unavailable', {skip:process.platform==='linux'}, async()=>{
  const {dir,project}=await fixture();
  await mkdir(join(dir,'docs'),{recursive:true});
  await writeFile(join(dir,'docs','entry.md'),'# Entry');
  const store=new DocStore();
  const isUnavailable=(error:unknown)=>error instanceof HttpError && error.status===503 && error.code==='DOC_READER_UNAVAILABLE';
  await assert.rejects(store.read(project,'docs/example.md'),isUnavailable);
  await assert.rejects(store.asset(project,'docs/example.png'),isUnavailable);
  await assert.rejects(store.search(project,'entry'),isUnavailable);
  await assert.rejects(store.inbox(project),isUnavailable);
});

test('search and inbox propagate injected typed reader failures, but skip unrelated document errors',async()=>{
  const {dir,project}=await fixture();
  await mkdir(join(dir,'docs'),{recursive:true});
  await writeFile(join(dir,'docs','entry.md'),'# Entry');
  const unavailable=new DocStore({},undefined,undefined,async()=>{throw new LinuxProcfsReadError('BACKEND_UNAVAILABLE');});
  const typedFailure=(error:unknown)=>error instanceof HttpError && error.status===503 && error.code==='DOC_READER_UNAVAILABLE';
  await assert.rejects(unavailable.search(project,'entry'),typedFailure);
  await assert.rejects(unavailable.inbox(project),typedFailure);
  const ordinaryFailure=new DocStore({},undefined,undefined,async()=>{throw new HttpError(503,'Unrelated document read failure','OTHER_503');});
  assert.deepEqual(await ordinaryFailure.search(project,'entry'),[]);
  assert.deepEqual(await ordinaryFailure.inbox(project),[]);
});

test('containment, extension allow-list and managed paths are refused',async()=>{
  const {dir,project}=await fixture(),store=testStore();
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
  await assert.rejects(store.create(project,'docs/linked/escape.md','# Nope\n'),/Parent folder cannot be created/);
  assert.equal(await stat(join(outside,'escape.md')).then(()=>true).catch(()=>false),false);
});

test('listing skips generated folders, managed paths and symlinks; size limits hold',async()=>{
  const {dir,project}=await fixture(),store=testStore({listLimit:100,readLimit:1024,writeLimit:1024});
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

test('open questions are extracted and a write keeps the file mode',linuxOnly,async()=>{
  const {project}=await fixture(),store=testStore();
  const created=await store.create(project,'docs/notes.md','# Notes\n\n## Open questions\n\n- [ ] Which host?\n- [x] Old question\n');
  assert.equal(created.kind,'question');
  assert.deepEqual(created.questions.map(q=>[q.text,q.done]),[['Which host?',false],['Old question',true]]);
  const before=(await stat(join(project.path,'docs/notes.md'))).mode & 0o777;
  const written=await store.write(project,'docs/notes.md',created.revision,created.text+'\nMore.\n');
  const after=(await stat(join(project.path,'docs/notes.md'))).mode & 0o777;
  assert.equal(after,before);
  assert.equal(written.questions.length,2);
});

test('bounded reads reject sparse oversize, growth after validation and leaf symlinks',async()=>{
  const {dir,project}=await fixture();
  await mkdir(join(dir,'docs'),{recursive:true});
  const sparse=await open(join(dir,'docs','large.md'),'w'); await sparse.truncate(1024*1024); await sparse.close();
  await assert.rejects(testStore({readLimit:1024}).read(project,'docs/large.md'),/size limit/);

  await writeFile(join(dir,'docs','grow.md'),'small');
  const growOpen: typeof open = async(path,flags)=>{
    const handle=await open(path,flags),original=handle.stat.bind(handle);
    (handle as unknown as {stat:()=>ReturnType<typeof original>}).stat=async()=>{
      const initial=await original();
      if(initial.size===5){const mutate=await open(path,'r+');await mutate.truncate(2048);await mutate.close();}
      return initial;
    };
    return handle;
  };
  await assert.rejects(testStore({readLimit:1024},undefined,growOpen).read(project,'docs/grow.md'),/size limit|changed while/);

  const outside=await mkdtemp(join(tmpdir(),'dashboard-docs-leaf-'));
  await writeFile(join(outside,'hidden.md'),'# outside');
  const target=join(dir,'docs','swap.md');
  await writeFile(target,'# safe');
  const swapLeaf: typeof open = async(path,flags)=>{
    await rename(target,join(dir,'docs','moved.md'));
    await symlink(join(outside,'hidden.md'),target);
    return open(path,flags);
  };
  await assert.rejects(testStore({},undefined,swapLeaf).read(project,'docs/swap.md'));
});

test('bounded reader uses one size-bounded buffer across repeated short reads',async()=>{
  const {dir}=await fixture(),file=join(dir,'short-reads.md'),content='short reads stay in one allocation';
  await writeFile(file,content);
  const buffers:Buffer[]=[];
  const partialOpen:typeof open=async(path,flags)=>{
    const handle=await open(path,flags),original=handle.read.bind(handle);
    (handle as unknown as {read:(buffer:Buffer,offset:number,length:number,position:number)=>Promise<{bytesRead:number}>}).read=
      (buffer,offset,length,position)=>{buffers.push(buffer);return original(buffer,offset,Math.min(length,2),position);};
    return handle;
  };
  assert.equal((await readBoundedRegularFile(file,1024,partialOpen)).toString(),content);
  assert.ok(buffers.length>1);
  assert.ok(buffers.every(buffer=>buffer===buffers[0]));
  assert.equal(buffers[0].length,Buffer.byteLength(content)+1);
});

test('bounded reader refuses missing or zero no-follow/nonblocking flags',async()=>{
  let opened=false;
  const opener: typeof open=async()=>{opened=true;throw Error('should not open');};
  await assert.rejects(readBoundedRegularFile('/unused',10,opener,()=>({readOnly:0,noFollow:0,nonBlock:1})),/unsupported/);
  await assert.rejects(readBoundedRegularFile('/unused',10,opener,()=>({readOnly:0,noFollow:1,nonBlock:0})),/unsupported/);
  await assert.rejects(readBoundedRegularFile('/unused',10,opener,()=>({readOnly:0})),/unsupported/);
  assert.equal(opened,false);
});

test('FIFO opens do not block before the regular-file check',async()=>{
  const {dir}=await fixture(),fifo=join(dir,'blocked.fifo');
  execFileSync('mkfifo',[fifo]);
  const modulePath=resolve('src/server/docs-store.ts');
  execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',
    `import {readBoundedRegularFile} from ${JSON.stringify(modulePath)}; try { await readBoundedRegularFile(${JSON.stringify(fifo)},1024); process.exitCode=2; } catch (error) { process.exitCode=error?.message === 'File not found' ? 0 : 1; }`
  ],{timeout:3000,stdio:'pipe'});
});

test('content search and documentation assets are bounded and contained',async()=>{
  const {dir,project}=await fixture(),store=testStore({searchMatches:2,searchBytes:100000,assetLimit:64});
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
  const {dir,project}=await fixture(),store=testStore();
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

test('documents are edited through a registered project and app-managed paths stay out of the listing',linuxOnly,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dashboard-docs-catalog-'));
  const books=new BoardStore(dir),catalog=new Catalog(dir,[dir],books),docs=testStore();
  await catalog.init();
  try{
    const project=await catalog.register({name:'Fixture',path:dir,managed:false,confirm:true});
    const created=await docs.create(project,'docs/wiki/intent.md','# Intent\n\nWhy we build this.\n');
    const edited=await docs.write(project,'docs/wiki/intent.md',created.revision,'# Intent\n\nWhy we build this, revised.\n');
    assert.match(edited.text,/revised/);
    assert.equal((await docs.list(project)).some(e=>e.path.startsWith('docs/dashboard')),false);
  }finally{await catalog.close();}
});
