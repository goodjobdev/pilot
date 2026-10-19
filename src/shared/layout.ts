import type { Board, Placement } from './model';
import { ranks } from './graph';
export function arrange(board: Board, preservePins=true): Record<string,Placement> {
  const rank=ranks(board), result:Record<string,Placement>={}, occupancy=new Map<string,number>();
  let top=0;
  for(const d of board.domains) {
    const tasks=board.tasks.filter(t=>t.domain===d.id && !t.archived).sort((a,b)=>a.id.localeCompare(b.id));
    let height=1;
    for(const t of tasks) {
      const column=rank.get(t.id)!;const key=d.id+':'+column;const row=occupancy.get(key)??0;occupancy.set(key,row+1);height=Math.max(height,row+1);
      result[t.id]=preservePins&&board.layout[t.id]?.pinned ? board.layout[t.id]:{x:column*340+180,y:top+row*150+50,pinned:false};
    }
    top+=height*150+100;
  }
  return result;
}
