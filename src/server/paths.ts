import { lstat,mkdir,realpath,readdir,stat } from 'node:fs/promises';
import { resolve,relative,join } from 'node:path';
export function within(root:string,path:string):boolean {const r=relative(root,path);return r==='' || (!r.startsWith('..')&&!r.startsWith('/'));}
export async function safePath(root:string,path:string,createParents=false):Promise<string> {
  if(path.startsWith('/') || path.split(/[\\/]/).some(p=>p==='..'||p==='') || path.includes('\\')) throw Error('Unsafe relative path');
  const parts=path.split('/');let at=root;
  for(let i=0;i<parts.length;i++) {
    at=join(at,parts[i]);
    try {const s=await lstat(at);if(s.isSymbolicLink())throw Error('Symlinks are not permitted in managed paths');if(i<parts.length-1&&!s.isDirectory())throw Error('Parent is not a directory');}
    catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(i<parts.length-1&&createParents)await mkdir(at,{mode:0o700});}
  }
  return at;
}
export async function approvedDirectory(path:string,roots:string[]):Promise<string> {
  const canonical=await realpath(resolve(path));
  if(!(await stat(canonical)).isDirectory())throw Error('Select a directory');
  const allowed=await Promise.all(roots.map(r=>realpath(r)));
  if(!allowed.some(root=>within(root,canonical)))throw Error('Folder is outside configured browse roots');
  return canonical;
}
export async function browse(path:string,roots:string[]) {
  const dir=await approvedDirectory(path,roots);
  const entries=(await readdir(dir,{withFileTypes:true})).filter(e=>e.isDirectory()&&!e.name.startsWith('.')&&!['node_modules','dist','build','target','out'].includes(e.name)).slice(0,200);
  return {path:dir,entries:entries.map(e=>({name:e.name,path:join(dir,e.name)})),roots};
}
