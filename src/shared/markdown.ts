import { parse, stringify } from 'yaml';
import type { Board } from './model';
import { validateBoard } from './schema';
export function serializeBoard(board: Board): string {
  const {summary,...data}=validateBoard(board);
  const stable={...data,layout:Object.fromEntries(Object.entries(data.layout).sort(([a],[b])=>a.localeCompare(b)))};
  return '---\n'+stringify(stable,{lineWidth:0,aliasDuplicateObjects:false})+'---\n'+summary+'\n';
}
export function parseBoard(text:string): Board {
  const m=text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if(!m) throw Error('Board must contain YAML frontmatter');
  return validateBoard({...parse(m[1],{maxAliasCount:0}),summary:m[2].replace(/\n$/,'')});
}
