import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyBoard,newTask } from '../../src/shared/model';
import { validateBoard,applyOperation } from '../../src/shared/schema';
import { readiness,specState,trace } from '../../src/shared/graph';
import { arrange } from '../../src/shared/layout';
import { serializeBoard,parseBoard } from '../../src/shared/markdown';
function fixture(){const b=emptyBoard();b.tasks=[newTask(randomUUID(),'A'),newTask(randomUUID(),'B')];b.relationships=[{id:randomUUID(),source:b.tasks[0].id,target:b.tasks[1].id,kind:'blocks' as const}];return b;}
test('DAG, readiness and transitive selection',()=>{const b=fixture();assert.equal(readiness(b,b.tasks[1].id),'waiting');b.tasks[0].status='done';assert.equal(readiness(b,b.tasks[1].id),'ready');b.tasks[1].scope='design-only';assert.equal(readiness(b,b.tasks[1].id),'out-of-scope');assert.equal(trace(b,b.tasks[0].id).size,2);});
test('reject dangling, duplicate IDs, cycle, self and unknown version',()=>{const b=fixture();assert.throws(()=>validateBoard({...b,version:2}));assert.throws(()=>validateBoard({...b,tasks:[...b.tasks,b.tasks[0]]}));assert.throws(()=>validateBoard({...b,relationships:[...b.relationships,{...b.relationships[0],id:randomUUID(),source:b.tasks[1].id,target:b.tasks[0].id}]}));assert.throws(()=>validateBoard({...b,relationships:[{...b.relationships[0],target:b.tasks[0].id}]}));assert.throws(()=>validateBoard({...b,relationships:[{...b.relationships[0],target:randomUUID()}]}));});
test('nonblocking related links and gates',()=>{const b=fixture();b.relationships[0].kind='related';b.tasks[1].gates=[{id:randomUUID(),label:'Signer',state:'open',evidence:''}];assert.equal(readiness(b,b.tasks[1].id),'waiting');b.tasks[1].gates[0].state='satisfied';assert.equal(readiness(b,b.tasks[1].id),'ready');b.tasks[1].status='blocked';assert.equal(readiness(b,b.tasks[1].id),'waiting');});
test('deterministic markdown and layout; pinned coordinates survive',()=>{const b=fixture();const text=serializeBoard(b);assert.deepEqual(parseBoard(text),b);assert.equal(serializeBoard(parseBoard(text)),text);assert.deepEqual(arrange(b),arrange(b));b.layout[b.tasks[0].id]={x:-12,y:16,pinned:true};assert.deepEqual(arrange(b)[b.tasks[0].id],b.layout[b.tasks[0].id]);});
test('specification links are validated, optional and never change readiness',()=>{
 const b=fixture();
 assert.throws(()=>validateBoard({...b,tasks:[{...b.tasks[0],specs:[{path:'node_modules/pkg/readme.md',anchor:null}]},b.tasks[1]]}));
 assert.throws(()=>validateBoard({...b,tasks:[{...b.tasks[0],specs:[{path:'../escape.md',anchor:null}]},b.tasks[1]]}));
 assert.throws(()=>validateBoard({...b,tasks:[{...b.tasks[0],specs:[{path:'docs/spec/a.md',anchor:null,extra:true}]},b.tasks[1]]}));
 const linked=validateBoard({...b,tasks:[{...b.tasks[0],specs:[{path:'docs/spec/a.md',anchor:'acceptance'}]},b.tasks[1]]});
 assert.deepEqual(linked.tasks[0].specs,[{path:'docs/spec/a.md',anchor:'acceptance'}]);
 const legacy=JSON.parse(JSON.stringify(b)) as {tasks:{specs?:unknown}[]};
 delete legacy.tasks[0].specs;
 const parsed=validateBoard(legacy);
 assert.deepEqual(parsed.tasks[0].specs,[]);
 assert.equal(readiness(parsed,parsed.tasks[1].id),'waiting');
 assert.equal(specState(parsed.tasks[0],new Set()),'unlinked');
 parsed.tasks[0].specs=[{path:'docs/spec/a.md',anchor:null}];
 assert.equal(specState(parsed.tasks[0],new Set(['docs/spec/a.md'])),'linked');
 assert.equal(specState(parsed.tasks[0],new Set(['docs/other.md'])),'broken');
 assert.equal(readiness(parsed,parsed.tasks[1].id),'waiting');
});
test('board markdown round-trips specification links',()=>{
 const b=fixture();
 b.tasks[0].specs=[{path:'docs/spec/a.md',anchor:'acceptance'}];
 const text=serializeBoard(b);
 assert.deepEqual(parseBoard(text).tasks[0].specs,b.tasks[0].specs);
 assert.equal(serializeBoard(parseBoard(text)),text);
});
test('removal reviews incident edges and rejects malformed operations',()=>{const b=fixture();assert.throws(()=>applyOperation(b,{op:'removeTask',id:b.tasks[0].id,confirmEdges:false}));assert.equal(applyOperation(b,{op:'removeTask',id:b.tasks[0].id,confirmEdges:true}).relationships.length,0);assert.throws(()=>applyOperation(b,{op:'shell',command:'x'}));});
