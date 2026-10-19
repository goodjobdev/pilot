import { z } from 'zod';
import { ranks } from './graph';
import { isBrowsableDocPath,normalizeDocPath } from './docs';
import type { Board, Operation } from './model';
const text=z.string().max(20000), id=z.string().uuid();
const domain=z.strictObject({id:z.string().regex(/^[a-z0-9-]{1,60}$/),name:z.string().min(1).max(80),color:z.string().regex(/^#[a-fA-F0-9]{6}$/)});
const milestone=z.strictObject({id:z.string().min(1).max(60),name:z.string().min(1).max(120),order:z.number().int().min(0).max(10000)});
const source=z.strictObject({id,name:z.string().min(1).max(300),path:z.string().regex(/^docs\/dashboard\/sources\/[a-f0-9-]{36}-[a-f0-9]{64}\.md$/,'Source path must address an inert managed snapshot'),locator:text,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),captured:z.string().datetime()});
const gate=z.strictObject({id,label:z.string().min(1).max(500),state:z.enum(['open','satisfied']),evidence:text});
// A spec link points at documentation in the repository; it never contains the requirement itself.
const specRef=z.strictObject({
  path:z.string().min(1).max(400).refine(value=>{try{return isBrowsableDocPath(normalizeDocPath(value));}catch{return false;}},'Specification must be a browsable Markdown path'),
  anchor:z.string().max(120).nullable()
});
export const taskSchema=z.strictObject({id,title:z.string().min(1).max(500),description:text,domain:z.string(),tags:z.array(z.string().max(80)).max(30),milestone:z.string().nullable(),status:z.enum(['todo','doing','done','blocked']),scope:z.enum(['active','deferred','design-only','historical']),acceptance:text,gates:z.array(gate).max(50),sources:z.array(id).max(50),specs:z.array(specRef).max(50).default([]),archived:z.boolean()});
export const edgeSchema=z.strictObject({id,source:id,target:id,kind:z.enum(['blocks','related'])});
export const placementSchema=z.strictObject({x:z.number().finite().min(-1e7).max(1e7),y:z.number().finite().min(-1e7).max(1e7),pinned:z.boolean()});
const boardSchema=z.strictObject({version:z.literal(1),adoption:z.enum(['mirror','adopted']),domains:z.array(domain).min(1).max(50),milestones:z.array(milestone).max(100),tasks:z.array(taskSchema).max(5000),relationships:z.array(edgeSchema).max(20000),sources:z.array(source).max(10000),layout:z.record(z.string(),placementSchema),summary:text});
function unique(ids:string[], label:string) {if(new Set(ids).size!==ids.length) throw Error('Duplicate '+label);}
export function validateBoard(value: unknown): Board {
  const b=boardSchema.parse(value);
  for(const [list,label] of [[b.tasks,'task'],[b.relationships,'relationship'],[b.sources,'source'],[b.domains,'domain'],[b.milestones,'milestone']] as const) unique(list.map(x=>x.id),label);
  const tasks=new Set(b.tasks.map(t=>t.id)), domains=new Set(b.domains.map(d=>d.id)), milestones=new Set(b.milestones.map(m=>m.id)), sources=new Set(b.sources.map(s=>s.id));
  for(const t of b.tasks) {
    if(!domains.has(t.domain) || (t.milestone!==null && !milestones.has(t.milestone)) || t.sources.some(s=>!sources.has(s))) throw Error('Unknown task domain, milestone or source');
    unique(t.gates.map(g=>g.id),'gate');
  }
  const connections=new Set<string>();
  for(const e of b.relationships) {
    if(!tasks.has(e.source)||!tasks.has(e.target)||e.source===e.target) throw Error('Missing task or self relationship');
    const key=e.kind+':'+e.source+':'+e.target;
    if(connections.has(key)) throw Error('Duplicate relationship'); connections.add(key);
  }
  if(Object.keys(b.layout).some(id=>!tasks.has(id))) throw Error('Unknown layout task');
  ranks(b);return b;
}
export const operationSchema=z.discriminatedUnion('op',[
  z.strictObject({op:z.literal('putTask'),task:taskSchema}),
  z.strictObject({op:z.literal('removeTask'),id,confirmEdges:z.boolean()}),
  z.strictObject({op:z.literal('putEdge'),edge:edgeSchema}),
  z.strictObject({op:z.literal('removeEdge'),id}),
  z.strictObject({op:z.literal('layout'),positions:z.record(z.string(),placementSchema)}),
  z.strictObject({op:z.literal('metadata'),domains:z.array(domain),milestones:z.array(milestone)}),
  z.strictObject({op:z.literal('adopt')}),
  z.strictObject({op:z.literal('restore'),board:boardSchema})
]);
export function applyOperation(board: Board, value: unknown): Board {
  const op=operationSchema.parse(value) as Operation; let b=JSON.parse(JSON.stringify(board)) as Board;
  switch(op.op) {
    case 'putTask': {const i=b.tasks.findIndex(t=>t.id===op.task.id);if(i<0)b.tasks.push(op.task);else b.tasks[i]=op.task;break;}
    case 'removeTask': if(!op.confirmEdges && b.relationships.some(e=>e.source===op.id||e.target===op.id)) throw Error('Review incident relationships before removal'); b.tasks=b.tasks.filter(t=>t.id!==op.id);b.relationships=b.relationships.filter(e=>e.source!==op.id&&e.target!==op.id);delete b.layout[op.id];break;
    case 'putEdge': {const i=b.relationships.findIndex(e=>e.id===op.edge.id);if(i<0)b.relationships.push(op.edge);else b.relationships[i]=op.edge;break;}
    case 'removeEdge':b.relationships=b.relationships.filter(e=>e.id!==op.id);break;
    case 'layout':b.layout={...b.layout,...op.positions};break;
    case 'metadata':b.domains=op.domains;b.milestones=op.milestones;break;
    case 'adopt':b.adoption='adopted';break;
    case 'restore':b=op.board;break;
  }
  return validateBoard(b);
}
