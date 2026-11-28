import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyBoard } from '../../src/shared/model';
import { previewImport,applyImport } from '../../src/server/importer';
test('identity survives reorder and manual edits are not silently applied',()=>{
 const b=emptyBoard(),docs=[{name:'tasks.md',content:'# Now\n- [ ] Storage first\n- [x] UI done'}];
 const p=previewImport(b,docs),next=applyImport(b,p,p.candidates.map(c=>c.id),[]);next.tasks[0].title='My custom title';
 const reordered=previewImport(next,[{name:'tasks.md',content:'# Now\n- [x] UI done\n- [ ] Storage first'}]);
 assert.equal(reordered.candidates[1].task.id,next.tasks[0].id);assert.equal(reordered.candidates[1].change,'unchanged');
 assert.equal(next.tasks[0].title,'My custom title');
 const changed=previewImport(next,[{name:'tasks.md',content:'# Now\n- [x] Storage first'}]);assert.equal(changed.candidates[0].change,'changed');
});
test('M6 design deliverable has explicit M1 dependency, not M5',()=>{
 const docs=[{name:'M1.md',content:'# M1 — Documentation\nStatus: complete.'},{name:'M2.md',content:'# M2 — Safety\nStatus: in progress. Depends: M1.'},{name:'M6.md',content:'# M6 — Sharing design\nStatus: design-only deliverable complete; implementation unauthorized. Depends: M1.'}];
 const p=previewImport(emptyBoard(),docs),b=applyImport(emptyBoard(),p,p.candidates.map(c=>c.id),p.relationships.map(e=>e.id));
 assert.equal(b.relationships.length,2);assert.equal(b.tasks.find(t=>t.milestone==='M6')?.scope,'design-only');assert.equal(b.tasks.find(t=>t.milestone==='M6')?.status,'done');
});
test('wrapped current tasks keep caveats, nested checkboxes stay separate and legacy marker is forward-only',()=>{
 const docs=[{name:'docs/tasks.md',content:'# Tasks\n## Current authorized release plan\n- [x] Build local tooling\n  with synthetic placeholders, not installed acceptance.\n  - [ ] Real installed upgrade remains\nLegacy checklist below is historical; release plan is authoritative.\n## Now\n- [x] Older checkpoint\n## Backlog\n* [ ] Old deferred idea'}];
 const p=previewImport(emptyBoard(),docs);assert.equal(p.candidates.length,4);
 assert.equal(p.candidates[0].task.scope,'active');assert.match(p.candidates[0].task.description,/not installed acceptance/);
 assert.equal(p.candidates[1].task.scope,'active');assert.equal(p.candidates[1].task.status,'todo');
 assert.equal(p.candidates[2].task.scope,'historical');assert.equal(p.candidates[3].task.scope,'historical');
 const b=applyImport(emptyBoard(),p,p.candidates.map(c=>c.id),[]);
 const rewrapped=previewImport(b,[{name:'docs/tasks.md',content:docs[0].content.replace('Build local tooling\n  with','Build local tooling with')}]);
 assert.equal(rewrapped.candidates[0].change,'unchanged');assert.equal(rewrapped.candidates[0].task.id,b.tasks[0].id);
});
test('plain or bold status preserves blockers and prerequisite suggestions, with M6 separate from implementation',()=>{
 const docs=[{name:'M1.md',content:'# M1 — Documentation\n**Status: complete (docs scope).**'},{name:'M2.md',content:'# M2 — Safety\nStatus: in progress. Depends: M1.'},{name:'M3.md',content:'# M3 — Desktop\nStatus: local tooling implemented; activation blocked by M2 safety gates.\nExternal blockers: authorized repository and signing keys.\nApple notarization and Windows signing are separate gates.\nEvidence: synthetic only.'},{name:'M6.md',content:'# M6 — Sharing design\nStatus: design-only deliverable complete; implementation unauthorized. Depends: M1.'}];
 const p=previewImport(emptyBoard(),docs),b=applyImport(emptyBoard(),p,p.candidates.map(c=>c.id),p.relationships.map(e=>e.id));
 assert.equal(b.tasks.find(t=>t.milestone==='M1')?.status,'done');assert.equal(b.tasks.find(t=>t.milestone==='M2')?.status,'doing');
 const desktop=b.tasks.find(t=>t.milestone==='M3')!;assert.equal(desktop.status,'blocked');assert.equal(desktop.gates[0].state,'open');assert.match(desktop.gates[0].label,/signing keys/);assert.match(desktop.gates[0].label,/Apple notarization/);assert.doesNotMatch(desktop.gates[0].label,/synthetic only/);
 assert.equal(b.relationships.length,3);assert.equal(b.tasks.find(t=>t.milestone==='M6')?.scope,'design-only');
});
test('legacy JSON extraction ignores commented examples and raw-text lookalikes without altering JSON strings',()=>{
 const html='<!-- Generated: the <script id="dash-data"> example is not data. -->\n<style>/* <script id="dash-data">fake</script> */</style>\n<script type="application/json" id="dash-data">{"tasks":[{"id":"OL01","title":"Preserve <!-- literal --> text","status":"done"}]}</script>';
 const p=previewImport(emptyBoard(),[{name:'generated.html',content:html}]);assert.equal(p.candidates.length,1);assert.equal(p.candidates[0].task.title,'Preserve <!-- literal --> text');assert.equal(p.candidates[0].task.status,'done');
 assert.throws(()=>previewImport(emptyBoard(),[{name:'ambiguous.html',content:html+html}]),/exactly one/);
 assert.throws(()=>previewImport(emptyBoard(),[{name:'comment-only.html',content:'<!-- <script id="dash-data">{"tasks":[]}</script> -->'}]),/exactly one/);
});
test('legacy scripts are inert; unsafe names and unsupported formats rejected',()=>{
 const p=previewImport(emptyBoard(),[{name:'legacy.html',content:'<script>alert(1)</script><script id="dash-data" type="application/json">{"tasks":[{"id":"t1","title":"Old","status":"todo"}]}</script>'}]);assert.equal(p.candidates.length,1);assert.equal(p.warnings.length,1);
 assert.throws(()=>previewImport(emptyBoard(),[{name:'../secret.md',content:''}]));
 assert.throws(()=>previewImport(emptyBoard(),[{name:'x.zip',content:''}]));
});
test('stable task IDs survive renames and file moves, with explicit dependencies and no duplicates',()=>{
 const first=previewImport(emptyBoard(),[{name:'docs/plan.md',content:'# Work\n- [ ] Add storage <!-- pilot:task STORE -->\n- [ ] Add UI <!-- pilot:task UI --> <!-- pilot:depends STORE -->'}]);
 const board=applyImport(emptyBoard(),first,first.candidates.map(c=>c.id),first.relationships.map(e=>e.id));
 assert.equal(board.tasks.length,2);assert.equal(board.relationships.length,1);assert.equal(board.tasks[1].title,'Add UI');assert.doesNotMatch(board.tasks[1].description,/pilot:/);
 const next=previewImport(board,[{name:'docs/moved.md',content:'# Renamed section\n- [x] Store the data <!-- pilot:task STORE -->\n- [ ] Add UI <!-- pilot:task UI --> <!-- pilot:depends STORE -->'}]);
 assert.equal(next.candidates[0].task.id,board.tasks[0].id);assert.equal(next.candidates[0].change,'changed');assert.equal(next.candidates[0].task.status,'done');assert.equal(next.relationships.length,0);
 const applied=applyImport(board,next,next.candidates.map(c=>c.id),[]);assert.equal(applied.tasks.length,2);assert.equal(applied.tasks[0].title,'Store the data');
 assert.throws(()=>previewImport(board,[{name:'a.md',content:'- [ ] One <!-- pilot:task SAME -->\n- [ ] Two <!-- pilot:task SAME -->'}]),/Duplicate/);
});
test('sync ignores fenced/commented examples and reports missing dependency IDs',()=>{
 const preview=previewImport(emptyBoard(),[{name:'docs/work.md',content:'```md\n- [ ] Example\n```\n<!--\n- [ ] Hidden example\n-->\n- [ ] Actual <!-- pilot:task ACTUAL --> <!-- pilot:depends MISSING -->'}]);
 assert.equal(preview.candidates.length,1);assert.equal(preview.candidates[0].task.title,'Actual');assert.equal(preview.relationships.length,0);assert.match(preview.warnings[0],/MISSING/);
});
test('milestone metadata ignores commented examples and nested fence demonstrations',()=>{
 const hidden=previewImport(emptyBoard(),[{name:'examples.md',content:'# Examples\n````md\n```md\n# M9 — Not a milestone\nStatus: done\n```\n````\n<!--\n# M8 — Also not a milestone\nStatus: done\n-->\n- [ ] Actual work <!-- pilot:task REAL -->\n'}]);
 assert.equal(hidden.milestones.length,0);assert.equal(hidden.candidates.length,1);assert.equal(hidden.candidates[0].task.status,'todo');
 const real=previewImport(emptyBoard(),[{name:'m1.md',content:'# M1 — Real milestone\n<!-- Status: done -->\n```md\nStatus: done\n```\nStatus: pending\n- [ ] Child work\n'}]);
 assert.equal(real.milestones.length,1);assert(real.candidates.every(candidate=>candidate.task.status==='todo'));
});
