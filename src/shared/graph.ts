import type { Board,Task } from './model';
/**
 * Advisory only: whether a work item points at documentation that exists.
 * 'linked' means at least one referenced document is present, 'broken' means none
 * is, and 'unlinked' means the task records no specification link. Readiness is
 * never changed by this — it is a prompt to write the spec, not a gate.
 */
export function specState(task: Task, known: ReadonlySet<string>): 'linked' | 'unlinked' | 'broken' {
  if (!task.specs.length) return 'unlinked';
  return task.specs.some(spec=>known.has(spec.path)) ? 'linked' : 'broken';
}
export function ranks(board: Board): Map<string, number> {
  const rank = new Map(board.tasks.map(t=>[t.id,0]));
  const indegree = new Map(board.tasks.map(t=>[t.id,0]));
  const next = new Map(board.tasks.map(t=>[t.id,[] as string[]]));
  for (const e of board.relationships.filter(e=>e.kind==='blocks')) {
    if (!indegree.has(e.source) || !indegree.has(e.target)) throw Error('Dangling relationship');
    indegree.set(e.target, indegree.get(e.target)!+1); next.get(e.source)!.push(e.target);
  }
  const queue = [...indegree].filter(([,n])=>n===0).map(([id])=>id).sort(); let seen=0;
  while(queue.length) {
    const id=queue.shift()!; seen++;
    for(const target of next.get(id)!.sort()) {
      rank.set(target,Math.max(rank.get(target)!,rank.get(id)!+1));
      indegree.set(target,indegree.get(target)!-1);
      if(indegree.get(target)===0) {queue.push(target);queue.sort();}
    }
  }
  if(seen!==board.tasks.length) throw Error('Blocking relationships must not form a cycle');
  return rank;
}
export function readiness(board: Board, id: string): 'done' | 'doing' | 'ready' | 'waiting' | 'out-of-scope' {
  const t=board.tasks.find(t=>t.id===id); if(!t) throw Error('Unknown task');
  if(t.status==='done') return 'done';
  if(t.archived || t.scope!=='active') return 'out-of-scope';
  if(t.status==='doing') return 'doing';
  if(t.status==='blocked' || t.gates.some(g=>g.state==='open')) return 'waiting';
  return board.relationships.some(e=>e.kind==='blocks' && e.target===id && board.tasks.find(t=>t.id===e.source)?.status!=='done') ? 'waiting':'ready';
}
export function trace(board: Board,id:string): Set<string> {
  const result=new Set([id]);
  for(const direction of ['source','target'] as const) {
    const queue=[id],visited=new Set([id]);
    while(queue.length) {
      const at=queue.shift()!;
      for(const e of board.relationships.filter(e=>e.kind==='blocks' && e[direction]===at)) {
        const other=e[direction==='source'?'target':'source'];
        if(!visited.has(other)) {visited.add(other);result.add(other);queue.push(other);}
      }
    }
  }
  return result;
}
