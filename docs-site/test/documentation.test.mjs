import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../prepare.mjs';
import { validate } from '../validate.mjs';
import { pilotMetadata } from '../schema.mjs';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'pilot-public-docs-')),manifest=join(root,'pages.json'),output=join(root,'generated');await mkdir(join(root,'docs/manual'),{recursive:true});t.after(()=>rm(root,{recursive:true,force:true}));const page=(id,body='Body')=>`---\ntitle: Test\ndescription: Test page\npilot:\n  schema: 1\n  id: ${id}\n  kind: how-to\n  doc_status: draft\n  feature_status: planned\n  verified_release: null\n---\n${body}\n`;return {root,manifest,output,page,run:()=>prepare(root,manifest,output),set:async pages=>writeFile(manifest,JSON.stringify(pages))};}
test('only explicit public sources publish and canonical relative Markdown links become site links',async t=>{
 const f=await fixture(t);await f.set([{source:'docs/manual/index.md',slug:'index'},{source:'docs/manual/next.md',slug:'guides/next'}]);await writeFile(join(f.root,'docs/manual/index.md'),f.page('home','[Next](./next.md#step)'));await writeFile(join(f.root,'docs/manual/next.md'),f.page('next','## Step'));await writeFile(join(f.root,'docs/manual/private.md'),'Never publish implicitly');assert.equal((await f.run()).pages,2);assert.match(await readFile(join(f.output,'index.md'),'utf8'),/\/guides\/next\/#step/);await assert.rejects(()=>readFile(join(f.output,'private.md')),/ENOENT/);
});
test('runtime plans, operations, arbitrary files and path traversal cannot enter the allowlist',async t=>{
 const f=await fixture(t);for(const source of ['docs/dashboard/board.md','operations/release.md','README.md','../outside.md','docs/manual/../private.md']){await f.set([{source,slug:'index'}]);await assert.rejects(f.run,/explicit public Markdown/);}
});
test('duplicate source, slug and metadata identifiers are rejected',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'docs/manual/a.md'),f.page('same'));await writeFile(join(f.root,'docs/manual/b.md'),f.page('same'));for(const pages of [[{source:'docs/manual/a.md',slug:'one'},{source:'docs/manual/a.md',slug:'two'}],[{source:'docs/manual/a.md',slug:'same'},{source:'docs/manual/b.md',slug:'same'}],[{source:'docs/manual/a.md',slug:'one'},{source:'docs/manual/b.md',slug:'two'}]]){await f.set(pages);await assert.rejects(f.run,/Duplicate/);}
});
test('symlinked canonical sources and credential-like content fail before output changes',async t=>{
 const f=await fixture(t);await f.set([{source:'docs/manual/a.md',slug:'index'}]);const outside=join(f.root,'outside.md');await writeFile(outside,f.page('a'));await symlink(outside,join(f.root,'docs/manual/a.md'));await assert.rejects(f.run,/symlinks/);await rm(join(f.root,'docs/manual/a.md'));await writeFile(join(f.root,'docs/manual/a.md'),f.page('a','-----BEGIN PRIVATE KEY-----'));await assert.rejects(f.run,/credential/);
});
test('unpublished links and implicit image copies fail without deleting previous generated output',async t=>{
 const f=await fixture(t);await f.set([{source:'docs/manual/index.md',slug:'index'}]);await mkdir(f.output);await writeFile(join(f.output,'retain.txt'),'last good output');for(const body of ['[Private](./private.md)','![Image](./private.png)']){await writeFile(join(f.root,'docs/manual/index.md'),f.page('home',body));await assert.rejects(f.run,/unpublished source|explicit reviewed asset/);assert.equal(await readFile(join(f.output,'retain.txt'),'utf8'),'last good output');}
});
test('examples in fences are not rewritten as source links',async t=>{
 const f=await fixture(t);await f.set([{source:'docs/manual/index.md',slug:'index'}]);await writeFile(join(f.root,'docs/manual/index.md'),f.page('home','```md\n[Example](./not-real.md)\n```'));await f.run();assert.match(await readFile(join(f.output,'index.md'),'utf8'),/\.\/not-real\.md/);
});
test('available features require release evidence; unknown metadata fields and statuses fail',()=>{
 const good={schema:1,id:'sample',kind:'how-to',doc_status:'accepted',feature_status:'available',verified_release:'fd3fa6f'};assert.equal(pilotMetadata.safeParse(good).success,true);for(const bad of [{...good,verified_release:null},{...good,feature_status:'done'},{...good,schema:2},{...good,template:'splash'}])assert.equal(pilotMetadata.safeParse(bad).success,false);
});
test('built link validator checks destinations and anchors, not external sites',async t=>{
 const f=await fixture(t);await mkdir(f.output);await writeFile(join(f.output,'index.html'),'<a href="/next/#step">Next</a><a href="https://example.invalid/no-network">External</a>');await mkdir(join(f.output,'next'));await writeFile(join(f.output,'next/index.html'),'<h1 id="step">Step</h1>');assert.deepEqual(await validate(f.output),{pages:2,links:1});await writeFile(join(f.output,'next/index.html'),'<h1>Missing anchor</h1>');await assert.rejects(()=>validate(f.output),/Broken built anchor/);
});
