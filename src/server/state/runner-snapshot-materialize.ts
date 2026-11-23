import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,open,readdir,realpath,chmod} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {validateRunnerSnapshot} from './runner-snapshot';

/**
 * Experimental service-side materialization. `privateRoot` and `applicationUid` are trusted
 * deployment configuration, NEVER request fields. No runtime or IPC uses this function yet.
 *
 * This checks conventional POSIX ownership/mode bits and rejects unsafe writable ancestors. It cannot
 * inspect every ACL, mount, namespace or same-UID writer. The service operator must independently
 * establish those properties and a genuinely separate application principal; a read-only container
 * mount and runtime isolation are still required. The returned path is internal, not an API value.
 * Failed/cancelled partial directories remain private for operator cleanup, never automatic replay.
 */
export async function materializeRunnerSnapshot(config:{privateRoot:string;applicationUid:number},input:unknown,expectedDigest:string,signal?:AbortSignal):Promise<{directory:string;digest:string}>{
 const snapshot=validateRunnerSnapshot(input);
 if(!/^[a-f0-9]{64}$/.test(expectedDigest)||snapshot.digest!==expectedDigest)throw Error('Snapshot bytes do not match the requested identity.');
 const uid=process.getuid?.();
 if(uid===undefined||uid===0||process.geteuid?.()!==uid||!Number.isSafeInteger(config.applicationUid)||config.applicationUid<=0||config.applicationUid===uid||!isAbsolute(config.privateRoot)||resolve(config.privateRoot)!==config.privateRoot||config.privateRoot==='/')throw Error('The runner service identity or private root is invalid.');
 if(!constants.O_NOFOLLOW)throw Error('This platform cannot enforce the required file-open flags.');
 const checkAbort=()=>{if(signal?.aborted)throw Error('Snapshot materialization was cancelled; no execution was started.');};
 try{
  checkAbort();
  if(await realpath(config.privateRoot)!==config.privateRoot)throw Error('noncanonical root');
  for(let current=config.privateRoot;;current=dirname(current)){
   const stat=await lstat(current);
   const unsafeWritable=(stat.mode&0o022)!==0&&(stat.mode&0o1000)===0;
   if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.uid!==uid&&stat.uid!==0)||unsafeWritable)throw Error('untrusted ancestor');
   if(current===config.privateRoot&&(stat.uid!==uid||(stat.mode&0o7777)!==0o700))throw Error('root not private');
   if(current==='/')break;
  }
  checkAbort();
  const directory=await mkdtemp(join(config.privateRoot,'snapshot-'));
  const dirs=new Set<string>([directory]);
  for(const file of snapshot.files){
   checkAbort();const parts=file.path.split('/'),name=parts.pop()!;let parent=directory;
   for(const part of parts){
    const next=join(parent,part);
    try{await mkdir(next,{mode:0o700});dirs.add(next);}
    catch(error){
     if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
     const stat=await lstat(next);
     if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||!(await readdir(parent)).includes(part)||!dirs.has(next))throw Error('directory collision');
    }
    parent=next;
   }
   const path=join(parent,name),handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{
    if(!(await readdir(parent)).includes(name))throw Error('filename changed by filesystem');
    await handle.writeFile(Buffer.from(file.base64,'base64'));
    await handle.chmod(file.mode==='100755'?0o555:0o444);
    await handle.sync();
    const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==file.bytes)throw Error('invalid materialized file');
    const bytes=Buffer.alloc(file.bytes);let offset=0;
    while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw Error('short file read');offset+=read.bytesRead;}
    if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('materialized content mismatch');
   }finally{await handle.close();}
  }
  checkAbort();
  // Parents last, so creation never needs write access to a finalized directory.
  for(const dir of [...dirs].sort((a,b)=>b.length-a.length))await chmod(dir,0o555);
  return {directory,digest:snapshot.digest};
 }catch{
  if(signal?.aborted)throw Error('Snapshot materialization was cancelled; no execution was started.');
  throw Error('Snapshot materialization failed; no execution was started. A private partial snapshot may require operator cleanup.');
 }
}
