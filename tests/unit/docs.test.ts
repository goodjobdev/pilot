import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAssetPath,assertEditableDocPath,assetIsSandboxed,assetType,docKind,headings,isBrowsableDocPath,normalizeDocPath,openQuestions,specRefs,slug } from '../../src/shared/docs';

test('document paths stay repository-relative, Markdown and outside generated folders',()=>{
  assert.equal(normalizeDocPath('./docs/spec/product.md'),'docs/spec/product.md');
  assert.throws(()=>normalizeDocPath('../outside.md'),/Unsafe/);
  assert.throws(()=>normalizeDocPath('/etc/hosts'),/repository-relative/);
  assert.throws(()=>normalizeDocPath(''),/repository-relative/);
  const backslash='docs'+String.fromCharCode(92)+'spec'+String.fromCharCode(92)+'a.md';
  assert.throws(()=>normalizeDocPath(backslash),/repository-relative/);
  assert.throws(()=>assertEditableDocPath('notes.txt'),/Markdown/);
  assert.throws(()=>assertEditableDocPath('node_modules/pkg/readme.md'),/Generated/);
  assert.throws(()=>assertEditableDocPath('dist/readme.md'),/Generated/);
  assert.throws(()=>assertEditableDocPath('docs/dashboard/board.md'),/managed/);
  assert.throws(()=>assertEditableDocPath('docs/dashboard/sources/abc.md'),/managed/);
  assert.equal(isBrowsableDocPath('.github/CONTRIBUTING.md'),true);
  assert.equal(isBrowsableDocPath('.kilo/notes.md'),false);
  assert.equal(isBrowsableDocPath('docs/notes.mdx'),true);
  assert.equal(isBrowsableDocPath('docs/notes.txt'),false);
});

test('headings, slugs and fenced code',()=>{
  const text='# Title\n\n\u0060\u0060\u0060md\n# Not a heading\n\u0060\u0060\u0060\n\n## Open Questions!\n';
  const all=headings(text);
  assert.deepEqual(all.map(h=>h.title),['Title','Open Questions!']);
  assert.deepEqual(all.map(h=>h.line),[1,7]);
  assert.deepEqual(all.map(h=>h.level),[1,2]);
  assert.equal(slug('Open Questions!'),'open-questions');
  assert.equal(slug('   **Bold** `code`  '),'bold-code');
});

test('document kinds are inferred from path and content',()=>{
  assert.equal(docKind('README.md'),'guide');
  assert.equal(docKind('AGENTS.md'),'guide');
  assert.equal(docKind('docs/decisions/0001-host.md'),'decision');
  assert.equal(docKind('docs/notes.md','# Notes\n\n## Open questions\n\n- [ ] Which host?\n'),'question');
  assert.equal(docKind('docs/spec/product.md'),'spec');
  assert.equal(docKind('docs/design/flows.md','# Flows\n\n\u0060\u0060\u0060mermaid\nflowchart LR\nA-->B\n\u0060\u0060\u0060\n'),'visual');
  assert.equal(docKind('docs/random.md','# Random\n'),'note');
});

test('open questions come only from question sections and ignore fenced examples',()=>{
  const text=['# Plan','','## Open questions','','- [ ] Which host?','- [x] Old question','- plain note','','\u0060\u0060\u0060md','- [ ] Not real','\u0060\u0060\u0060','','## Next','- [ ] Out of section',''].join('\n');
  const found=openQuestions(text);
  assert.deepEqual(found.map(q=>[q.text,q.done,q.anchor]),[['Which host?',false,'open-questions'],['Old question',true,'open-questions']]);
  assert.deepEqual(openQuestions('- [ ] no section\n'),[]);
});

test('duplicate question text still gets unique ids',()=>{
  const found=openQuestions('## Open questions\n\n- [ ] Same\n- [ ] Same\n');
  assert.deepEqual(found.map(q=>q.id),['same','same-2']);
});

test('only images and static mockups are servable assets',()=>{
  assert.equal(assetType('docs/mockups/flow.png'),'image/png');
  assert.equal(assetType('docs/mockups/flow.PNG'),'image/png');
  assert.equal(assetType('docs/app.js'),null);
  assert.equal(assetIsSandboxed('docs/mockups/flow.html'),true);
  assert.equal(assetIsSandboxed('docs/mockups/flow.svg'),true);
  assert.equal(assetIsSandboxed('docs/mockups/flow.png'),false);
  assert.equal(assertAssetPath('./docs/mockups/flow.svg'),'docs/mockups/flow.svg');
  assert.throws(()=>assertAssetPath('docs/app.js'),/Only documentation images/);
  assert.throws(()=>assertAssetPath('docs/notes.md'),/Only documentation images/);
  assert.throws(()=>assertAssetPath('node_modules/pkg/logo.png'),/Generated/);
  assert.throws(()=>assertAssetPath('docs/dashboard/sources/a.png'),/managed/);
  assert.throws(()=>assertAssetPath('../secret.png'),/Unsafe/);
});

test('spec references are parsed outside code fences',()=>{
  const text=['spec: docs/spec/product.md#Acceptance','','\u0060\u0060\u0060','spec: docs/ignored.md','\u0060\u0060\u0060',''].join('\n');
  assert.deepEqual(specRefs(text),[{path:'docs/spec/product.md',anchor:'acceptance'}]);
});
