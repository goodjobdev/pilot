import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { appendFile,mkdtemp,open,rename,rm,symlink,unlink,writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BoundedFileReadError,readBoundedFile } from '../../src/server/bounded-file-read';
const execFile=promisify(execFileCallback);

test('FIFO reads return an explicit refusal instead of blocking the caller',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-bounded-fifo-'));
 try{
  const fifo=join(root,'pipe');
  if(!(constants.O_NOFOLLOW>0&&constants.O_NONBLOCK>0)){t.skip('required no-follow and nonblocking open flags are unavailable');return;}
  try{await execFile('mkfifo',[fifo],{timeout:2000});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){t.skip('mkfifo is unavailable on this platform');return;}throw error;}
  const moduleUrl=pathToFileURL(join(process.cwd(),'src/server/bounded-file-read.ts')).href;
  const source=`import(${JSON.stringify(moduleUrl)}).then(async ({readBoundedFile,BoundedFileReadError})=>{try{await readBoundedFile(${JSON.stringify(fifo)},32);console.error('unexpected read');process.exitCode=1;}catch(error){if(error instanceof BoundedFileReadError&&error.code==='NOT_REGULAR'){console.log('EXPECTED:'+error.code);process.exitCode=0;}else{console.error(error);process.exitCode=2;}}});`;
  const child=await execFile(process.execPath,['--import=tsx','--input-type=module','-e',source],{timeout:3000,killSignal:'SIGKILL'});
  assert.equal(child.stdout,'EXPECTED:NOT_REGULAR\n','the child exits successfully only after nonblocking open and fstat report a non-regular file');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('bounded opened-file reads cap bytes, refuse non-files and do not reuse stale handles',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-bounded-read-'));
 try{
  const sparse=join(root,'sparse');const fh=await open(sparse,'w');await fh.truncate(8*1024*1024);await fh.close();
  await assert.rejects(readBoundedFile(sparse,128),(e:unknown)=>e instanceof BoundedFileReadError&&e.code==='OVERSIZE');
  const growing=join(root,'growing');await writeFile(growing,'x'.repeat(64));
  const growingHandle=await open(growing,'r+');const bytes=Buffer.alloc(17);const result=await growingHandle.read(bytes,0,17,0);assert.equal(result.bytesRead,17);await growingHandle.close();
  const link=join(root,'leaf-link');await symlink(growing,link);
  await assert.rejects(readBoundedFile(link,128),(e:unknown)=>e instanceof BoundedFileReadError&&e.code==='SYMLINK');
  await assert.rejects(readBoundedFile(root,128),(e:unknown)=>e instanceof BoundedFileReadError&&e.code==='NOT_REGULAR');
  assert.equal((await readBoundedFile(growing,128)).length,64);
  await appendFile(growing,'y'.repeat(128));
  await assert.rejects(readBoundedFile(growing,128),(e:unknown)=>e instanceof BoundedFileReadError&&e.code==='OVERSIZE','a file that grows beyond the cap is refused rather than truncated');
  const replacement=join(root,'replacement');await writeFile(replacement,'new');await rename(replacement,growing);
  assert.equal((await readBoundedFile(growing,128)).toString(),'new','a later call opens the leaf currently at the path rather than reusing an earlier handle');
  await unlink(link);await symlink(growing,link);await assert.rejects(readBoundedFile(link,128),(e:unknown)=>e instanceof BoundedFileReadError&&e.code==='SYMLINK');
 }finally{await rm(root,{recursive:true,force:true});}
});
