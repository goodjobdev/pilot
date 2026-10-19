import { createHash,randomUUID } from 'node:crypto';
import { open,readFile,rename,unlink,mkdir,readdir } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import type { Project,Snapshot } from '../shared/model';
import { applyOperation } from '../shared/schema';
import { parseBoard,serializeBoard } from '../shared/markdown';
import { safePath } from './paths';
export const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
export async function atomicWrite(path:string,text:string) {
  const tmp=path+'.'+randomUUID()+'.tmp';
  const file=await open(tmp,'wx',0o600);
  try {await file.writeFile(text);await file.sync();}finally{await file.close();}
  try {await rename(tmp,path);const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}}
  finally {await unlink(tmp).catch(()=>{});}
}
export class BoardStore {
  private tails=new Map<string,Promise<unknown>>();
  constructor(private dataRoot:string){}
  async serial<T>(key:string,fn:()=>Promise<T>):Promise<T> {
    const prev=this.tails.get(key)??Promise.resolve();
    const current=prev.catch(()=>{}).then(fn);this.tails.set(key,current);
    try{return await current;}finally{if(this.tails.get(key)===current)this.tails.delete(key);}
  }
  async drain(){await Promise.allSettled([...this.tails.values()]);}
  async raw(project:Project){const path=await safePath(project.path,'docs/dashboard/board.md');return readFile(path,'utf8');}
  async read(project:Project):Promise<Snapshot>{
    let raw:string;try{raw=await this.raw(project);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new HttpError(404,'Board missing; initialize only after confirming the location');throw e;}
    if(Buffer.byteLength(raw)>8*1024*1024)throw new HttpError(413,'Board exceeds size limit');
    try{return {board:parseBoard(raw),revision:hash(raw)};}catch(e){throw new HttpError(422,'Board is read-only: '+(e as Error).message);}
  }
  async initialize(project:Project,text:string){return this.serial(project.id,async()=>{
    const path=await safePath(project.path,'docs/dashboard/board.md',true);
    // Never replace an existing planning file.
    const f=await open(path,'wx',0o600);try{await f.writeFile(text);await f.sync();}finally{await f.close();}
    return this.read(project);
  });}
  async mutate(project:Project,revision:string,operation:unknown):Promise<Snapshot>{return this.serial(project.id,async()=>{
    const current=await this.read(project);
    if(current.revision!==revision)throw new HttpError(409,'Board changed on disk or in another tab. Reload and review; your draft is retained.');
    const board=applyOperation(current.board,operation), text=serializeBoard(board);
    const backupRoot=await safePath(this.dataRoot,'snapshots/'+project.id+'/sentinel',true);
    const dir=dirname(backupRoot);await atomicWrite(join(dir,Date.now()+'-'+randomUUID()+'.md'),await this.raw(project));
    const snapshots=(await readdir(dir)).filter(n=>n.endsWith('.md')).sort();
    for(const old of snapshots.slice(0,-20))await unlink(join(dir,old));
    const path=await safePath(project.path,'docs/dashboard/board.md');
    if(hash(await this.raw(project))!==revision)throw new HttpError(409,'External edit detected before commit');
    await atomicWrite(path,text);return {board,revision:hash(text)};
  });}
}
