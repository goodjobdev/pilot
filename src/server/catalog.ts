import { access,mkdir,open,readFile,realpath,stat,readdir,unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Project } from '../shared/model';
import { emptyBoard } from '../shared/model';
import { serializeBoard } from '../shared/markdown';
import { BoardStore,atomicWrite,HttpError } from './board-store';
import { approvedDirectory,safePath } from './paths';
const projectSchema=z.strictObject({id:z.string().uuid(),name:z.string().min(1).max(100),path:z.string(),managed:z.boolean(),repository:z.string().max(500),created:z.string().datetime()});
const catalogSchema=z.strictObject({version:z.literal(1),projects:z.array(projectSchema).max(1000)});
export class Catalog {
  projects:Project[]=[]; root='';private lockPath='';private lock:Awaited<ReturnType<typeof open>>|undefined;
  constructor(public requestedRoot:string,public browseRoots:string[],public boards:BoardStore){}
  async init(){
    await mkdir(this.requestedRoot,{recursive:true,mode:0o700});this.root=await realpath(this.requestedRoot);
    this.lockPath=join(this.root,'service.lock');
    try {this.lock=await open(this.lockPath,'wx',0o600);await this.lock.writeFile(JSON.stringify({pid:process.pid,started:new Date().toISOString()}));}
    catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('Catalog already locked. Verify prior service exit before manual stale-lock recovery.');throw e;}
    try {const path=await safePath(this.root,'catalog.json');this.projects=catalogSchema.parse(JSON.parse(await readFile(path,'utf8'))).projects;}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=='ENOENT'){await this.close();throw e;}
      // Persist an empty catalog so a pristine installation is recoverable before registration.
      try{await this.persist();}catch(writeError){await this.close();throw writeError;}
    }
  }
  async close(){if(this.lock){await this.lock.close();this.lock=undefined;await unlink(this.lockPath);}}
  private async persist(){await atomicWrite(await safePath(this.root,'catalog.json'),JSON.stringify({version:1,projects:this.projects},null,2)+'\n');}
  get(id:string){const p=this.projects.find(p=>p.id===id);if(!p)throw new HttpError(404,'Project not registered');return p;}
  async list(){return Promise.all(this.projects.map(async p=>{let state:Project['state']='available';try{await stat(p.path);await access(p.path,constants.W_OK);}catch(e){state=(e as NodeJS.ErrnoException).code==='ENOENT'?'missing':'read-only';}return {...p,state};}));}
  async preview(path:string){const canonical=await approvedDirectory(path,this.browseRoots);const detected:string[]=[];
    for(const file of ['docs/tasks.md','tasks.md','docs/tasks/release-plan/README.md','README.md']) {
      try{await access(await safePath(canonical,file));detected.push(file);}catch{/* not an approved regular path */}
    }
    return {path:canonical,boardPath:join(canonical,'docs/dashboard/board.md'),detected};
  }
  async register(input:unknown){const data=z.strictObject({name:z.string().min(1).max(100),path:z.string().optional(),managed:z.boolean(),repository:z.string().max(500).default(''),confirm:z.literal(true)}).parse(input);
    return this.boards.serial('catalog',async()=>{
      const id=randomUUID();let path:string;
      if(data.managed){path=await safePath(this.root,'workspaces/'+id+'/sentinel',true);path=join(this.root,'workspaces',id);}
      else {if(!data.path)throw Error('Folder required');path=await approvedDirectory(data.path,this.browseRoots);}
      if(this.projects.some(p=>p.path===path))throw new HttpError(409,'Project already registered');
      const project:Project={id,name:data.name,path,managed:data.managed,repository:data.repository,created:new Date().toISOString()};
      this.projects.push(project);try{await this.persist();}catch(e){this.projects.pop();throw e;}
      if(data.managed)await this.boards.initialize(project,serializeBoard(emptyBoard()));
      return project;
    });
  }
  async remove(id:string){await this.boards.serial('catalog',async()=>{this.get(id);const before=this.projects;this.projects=this.projects.filter(p=>p.id!==id);try{await this.persist();}catch(e){this.projects=before;throw e;}});}
  async relocate(id:string,path:string){await this.boards.serial('catalog',async()=>{const canonical=await approvedDirectory(path,this.browseRoots);if(this.projects.some(p=>p.id!==id&&p.path===canonical))throw Error('Folder already registered');const p=this.get(id),old=p.path;p.path=canonical;try{await this.persist();}catch(e){p.path=old;throw e;}});}
}
