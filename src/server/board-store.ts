import { createHash,randomUUID } from 'node:crypto';
import { open,readFile,rename,unlink,mkdir,readdir } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import type { Project,Snapshot } from '../shared/model';
import { applyOperation } from '../shared/schema';
import { parseBoard,serializeBoard } from '../shared/markdown';
import { safePath } from './paths';
import type { WorkspaceStore } from './workspace';
import { PLAN_PATH } from '../shared/workspace';
export const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export class HttpError extends Error {constructor(public status:number,message:string,public code?:string){super(message);}}
export async function atomicWrite(path:string,text:string) {
  const tmp=path+'.'+randomUUID()+'.tmp';
  const file=await open(tmp,'wx',0o600);
  try {await file.writeFile(text);await file.sync();}finally{await file.close();}
  try {await rename(tmp,path);const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}}
  finally {await unlink(tmp).catch(()=>{});}
}
export class BoardStore {
  private tails=new Map<string,Promise<unknown>>();
  constructor(private dataRoot:string,private workspace?:WorkspaceStore){}
  private save<T extends object>(project:Project,paths:string[],write:()=>Promise<T>){return this.workspace?this.workspace.save(project,paths,write):write();}
  async serial<T>(key:string,fn:()=>Promise<T>):Promise<T> {
    const prev=this.tails.get(key)??Promise.resolve();
    const current=prev.catch(()=>{}).then(fn);this.tails.set(key,current);
    try{return await current;}finally{if(this.tails.get(key)===current)this.tails.delete(key);}
  }
  async drain(){await Promise.allSettled([...this.tails.values()]);}
  private async backup(project:Project,text:string){
    const backupRoot=await safePath(this.dataRoot,'snapshots/'+project.id+'/sentinel',true),dir=dirname(backupRoot);
    await atomicWrite(join(dir,Date.now()+'-'+randomUUID()+'.md'),text);
    const snapshots=(await readdir(dir)).filter(n=>n.endsWith('.md')).sort();
    for(const old of snapshots.slice(0,-20))await unlink(join(dir,old));
  }
  async raw(project:Project){const path=await safePath(project.path,'docs/dashboard/board.md');return readFile(path,'utf8');}
  async read(project:Project):Promise<Snapshot>{
    let raw:string;try{raw=await this.raw(project);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new HttpError(404,'Board missing; initialize only after confirming the location');throw e;}
    if(Buffer.byteLength(raw)>8*1024*1024)throw new HttpError(413,'Board exceeds size limit');
    try{return {board:parseBoard(raw),revision:hash(raw)};}catch(e){throw new HttpError(422,'Board is read-only: '+(e as Error).message);}
  }
  async initialize(project:Project,text:string){return this.serial(project.id,()=>this.save(project,[PLAN_PATH],async()=>{
    const path=await safePath(project.path,'docs/dashboard/board.md',true);
    // Never replace an existing planning file.
    const f=await open(path,'wx',0o600);try{await f.writeFile(text);await f.sync();}finally{await f.close();}
    return this.read(project);
  }));}
  async mutate(project:Project,revision:string,operation:unknown,additionalPaths:string[]=[],verify?:()=>Promise<void>,prepare?:()=>Promise<void>):Promise<Snapshot>{return this.serial(project.id,()=>this.save(project,[PLAN_PATH,...additionalPaths],async()=>{
    await verify?.();
    const current=await this.read(project);
    if(current.revision!==revision)throw new HttpError(409,'Board changed on disk or in another tab. Reload and review; your draft is retained.');
    const board=applyOperation(current.board,operation), text=serializeBoard(board);
    await prepare?.();await verify?.();
    await this.backup(project,await this.raw(project));
    const path=await safePath(project.path,'docs/dashboard/board.md');
    if(hash(await this.raw(project))!==revision)throw new HttpError(409,'External edit detected before commit');
    await atomicWrite(path,text);return {board,revision:hash(text)};
  }));}
  /** Wiki source editing and board operations share this revision/serialization boundary. */
  async writeDocument(project:Project,revision:string,text:string):Promise<Snapshot>{
    if(Buffer.byteLength(text)>8*1024*1024)throw new HttpError(413,'Plan exceeds size limit');
    let board;try{board=parseBoard(text);}catch{throw new HttpError(422,'Invalid plan document. Fix the YAML/board schema; your draft is retained.');}
    return this.serial(project.id,()=>this.save(project,[PLAN_PATH],async()=>{
      const before=await this.raw(project);
      if(hash(before)!==revision)throw new HttpError(409,'Plan changed. Reload and review; your draft is retained.');
      await this.backup(project,before);
      const path=await safePath(project.path,PLAN_PATH);
      if(hash(await this.raw(project))!==revision)throw new HttpError(409,'External edit detected before saving the plan');
      await atomicWrite(path,text);return {board,revision:hash(text)};
    }));
  }
}
