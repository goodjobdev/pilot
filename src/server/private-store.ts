import { readFile,chmod } from 'node:fs/promises';
import { atomicWrite } from './board-store';
import { safePath } from './paths';

/** One app process owns the data root (Catalog's service.lock). All private JSON
 * read-modify-writes share a queue, including credential refresh and logout. */
export class PrivateStore<T> {
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private root:string,private relative:string,private initial:()=>T,private validate:(input:unknown)=>T){}
 private async readNow():Promise<T>{
  const path=await safePath(this.root,this.relative,true);
  try{await chmod(path,0o600);return this.validate(JSON.parse(await readFile(path,'utf8')));}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return this.initial();throw Error('Private settings could not be read');}
 }
 async read(){await this.tail.catch(()=>{});return this.readNow();}
 async update<R>(work:(value:T)=>Promise<R>):Promise<R>{
  const current=this.tail.catch(()=>{}).then(async()=>{
   const value=await this.readNow(),result=await work(value);
   await atomicWrite(await safePath(this.root,this.relative,true),JSON.stringify(value)+'\n');
   return result;
  });
  this.tail=current;return current;
 }
 async drain(){await this.tail.catch(()=>{});}
}
