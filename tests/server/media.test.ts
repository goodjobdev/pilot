import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod,mkdir,mkdtemp,readFile,readdir,rename,rm,stat,symlink,unlink,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { createApp } from '../../src/server/main';
import { ControlStore } from '../../src/server/state/control-store';
import { localConfig } from '../../src/server/security';
import { MEDIA_CONTAINER_CODE,MediaContainerError,MediaReadUnavailableError,MediaStore,MAX_PREPARED_BASE64_BYTES,MAX_STORED_MEDIA_BYTES } from '../../src/server/media-store';
import { readLinuxProcfsRegularFileBeneathForTest } from '../../src/server/linux-procfs-read';
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node';
import { MAX_IMAGE_BYTES,MAX_IMAGE_DIMENSION,readImageSize,scanImageMetadata,sniffImageType,uniqueImageFiles } from '../../src/shared/images';

/**
 * Every image here is generated in the test; no binary fixture is committed. PNG, JPEG and WebP are
 * built from bytes, and the WebP is a hand-built 1x1 lossless (VP8L) file: no encoder for WebP ships
 * with the pinned packages, so it is written here and its decodability is proven by this suite.
 */
function crc32(bytes:Uint8Array):number{let crc=~0;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(0xEDB88320&-(crc&1));}return (~crc)>>>0;}
function chunk(type:string,data:Uint8Array):Uint8Array{
  const out=new Uint8Array(12+data.length);
  const view=new DataView(out.buffer);
  view.setUint32(0,data.length);out.set(new TextEncoder().encode(type),4);out.set(data,8);
  view.setUint32(8+data.length,crc32(out.subarray(4,8+data.length)));
  return out;
}
function concat(...parts:Uint8Array[]):Uint8Array{const total=parts.reduce((sum,part)=>sum+part.length,0);const out=new Uint8Array(total);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;}
/** A solid-colour PNG of a chosen size, with optional extra chunks before IEND. */
function png(width:number,height:number,extra:Uint8Array[]=[]):Uint8Array{
  const header=new Uint8Array(13);const view=new DataView(header.buffer);
  view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=2;
  const raw=new Uint8Array(height*(1+width*3));
  for(let y=0;y<height;y++){raw[y*(1+width*3)]=0;for(let x=0;x<width;x++){raw[y*(1+width*3)+1+x*3]=0x33;raw[y*(1+width*3)+2+x*3]=0x99;raw[y*(1+width*3)+3+x*3]=0xcc;}}
  return concat(new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),...extra,chunk('IEND',new Uint8Array(0)));
}
/** A PNG header that claims a pixel count without any image data at all. */
function pngHeaderOnly(width:number,height:number):Uint8Array{
  const header=new Uint8Array(13);const view=new DataView(header.buffer);
  view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=2;
  return concat(new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header));
}
/** A 1x1 lossless WebP (VP8L) with a single-symbol huffman code for each of the five groups. */
function webp():Uint8Array{
  const bits=[0,0,0];for(let i=0;i<5;i++)bits.push(1,0,1,0,0,0,0,0,0,0,0);
  const out:number[]=[];let current=0,count=0;
  for(const bit of bits){current|=bit<<count;count++;if(count===8){out.push(current);current=0;count=0;}}
  if(count)out.push(current);
  const header=new Uint8Array([0x2f,0,0,0,0]);
  const payload=concat(header,new Uint8Array(out));
  const body=concat(new TextEncoder().encode('VP8L'),(()=>{const size=new Uint8Array(4);new DataView(size.buffer).setUint32(0,payload.length);return size;})(),payload);
  const head=new Uint8Array(4);new DataView(head.buffer).setUint32(0,body.length+4);
  return concat(new TextEncoder().encode('RIFF'),head,new TextEncoder().encode('WEBP'),body);
}
/** One IFD with a single short tag: EXIF orientation (0x0112) or the GPS IFD pointer (0x8825). */
function tiff(tag:number):Uint8Array{
  const out=new Uint8Array(8+2+12+4);const view=new DataView(out.buffer);
  out[0]=0x49;out[1]=0x49;view.setUint16(2,0x2a,true);view.setUint32(4,8,true);
  view.setUint16(8,1,true);
  view.setUint16(10,tag,true);view.setUint16(12,3,true);view.setUint32(14,1,true);view.setUint16(18,6,true);
  return out;
}
const textEncoder=new TextEncoder();
function exifPng(width:number,height:number,tag=0x0112):Uint8Array{return png(width,height,[chunk('eXIf',tiff(tag))]);}
let processor:ReturnType<typeof createNodePhotonImages>|undefined;
async function jpeg():Promise<Uint8Array>{
  // The documented processor is the only JPEG encoder available without adding a dependency, and it
  // only re-encodes, so a source larger than the requested size becomes a real baseline JPEG.
  processor??=createNodePhotonImages({worker:false});
  const prepared=await (await processor).prepare(new Uint8Array(png(8,8)),'image/jpeg',{maxWidth:1,maxHeight:1,maxBytes:4_500_000});
  assert.ok(prepared,'the processor produced a JPEG fixture');
  return new Uint8Array(Buffer.from(prepared.data,'base64'));
}

test('the format is taken from the bytes: JPEG, PNG and WebP are accepted and nothing else is',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-'));
  const store=new MediaStore(root);
  try{
    const pngBytes=png(6,4),jpegBytes=await jpeg(),webpBytes=webp();
    assert.equal(sniffImageType(pngBytes),'image/png');
    assert.equal(sniffImageType(jpegBytes),'image/jpeg');
    assert.equal(sniffImageType(webpBytes),'image/webp');
    for(const [bytes,type] of [[pngBytes,'image/png'],[jpegBytes,'image/jpeg'],[webpBytes,'image/webp']] as const){
      const accepted=await store.accept(bytes);
      assert.equal(accepted.ok,true,type+' is accepted');
      if(accepted.ok)assert.equal(accepted.mimeType,type);
    }
    assert.equal((await readdir(join(root,'media'))).length,3,'the three accepted formats are stored');
    const stored=async()=>(await readdir(join(root,'media'))).sort();
    const before=await stored();
    // A text file renamed '.png' is refused on its bytes, never on its name or a declared type.
    const renamed=await store.accept(textEncoder.encode('this is not an image at all'));
    assert.equal(renamed.ok,false);
    if(!renamed.ok){assert.equal(renamed.code,'type');assert.match(renamed.reason,/JPEG, PNG and WebP/);}
    // A truncated image carries the magic bytes but cannot be verified, and is refused rather than stored.
    const truncated=await store.accept(png(6,4).subarray(0,10));
    assert.equal(truncated.ok,false);
    if(!truncated.ok)assert.equal(truncated.code,'decode');
    const headerOnly=await store.accept(pngHeaderOnly(6,4));
    assert.equal(headerOnly.ok,false);
    if(!headerOnly.ok)assert.equal(headerOnly.code,'decode');
    // An empty body is not an image either.
    const empty=await store.accept(new Uint8Array(0));
    assert.equal(empty.ok,false);
    if(!empty.ok)assert.equal(empty.code,'type');
    assert.deepEqual(await stored(),before,'a refusal writes nothing');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('bytes, pixels and dimensions are refused with distinct reasons',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-limits-'));
  const store=new MediaStore(root);
  try{
    // Bytes: one over the documented per-image cap.
    const oversize=new Uint8Array(MAX_IMAGE_BYTES+1);oversize.set(png(6,4).subarray(0,8));
    const tooManyBytes=await store.accept(oversize);
    assert.equal(tooManyBytes.ok,false);
    if(!tooManyBytes.ok){assert.equal(tooManyBytes.code,'bytes');assert.match(tooManyBytes.reason,/4 MB/);}
    // Pixels: the header declares the size, and the check happens before anything is decoded.
    const huge=pngHeaderOnly(30_000,30_000);
    const tooManyPixels=await store.accept(huge);
    assert.equal(tooManyPixels.ok,false);
    if(!tooManyPixels.ok){assert.equal(tooManyPixels.code,'pixels');assert.match(tooManyPixels.reason,/megapixels/);}
    // A wide image is resized to the documented maximum on either side, and says so.
    const wide=await store.accept(png(2100,8));
    assert.equal(wide.ok,true);
    if(wide.ok){assert.equal(wide.width,MAX_IMAGE_DIMENSION);assert.ok(wide.height<=MAX_IMAGE_DIMENSION);assert.equal(wide.reencoded,true);assert.match(wide.note??'',/resized to 2000/);}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('an EXIF-bearing image is re-encoded with its metadata gone, or refused outright',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-exif-'));
  const store=new MediaStore(root);
  const stored=async():Promise<string[]>=>{try{return await readdir(join(root,'media'));}catch{return [];}};
  try{
    // Upright and small: the processor returns the bytes unchanged, so EXIF orientation survives and
    // the image is refused rather than stored while claiming a stripping that did not happen.
    const orientation=await store.accept(exifPng(6,4,0x0112));
    assert.equal(orientation.ok,false);
    if(!orientation.ok){assert.equal(orientation.code,'metadata');assert.match(orientation.reason,/orientation/);}
    const gps=await store.accept(exifPng(6,4,0x8825));
    assert.equal(gps.ok,false);
    if(!gps.ok){assert.equal(gps.code,'metadata');assert.match(gps.reason,/location/);}
    assert.deepEqual(await stored(),[],'a refused image is never stored');
    // Large enough to be resized: the processor re-encodes from pixels, so the EXIF is gone and the
    // refusal no longer applies.
    const large=await store.accept(exifPng(2100,8,0x0112));
    assert.equal(large.ok,true);
    if(large.ok){
      assert.equal(large.reencoded,true);
      assert.match(large.note??'',/EXIF removed by re-encoding/);
      const bytes=new Uint8Array(await readFile(join(root,'media',large.id+'.bin')));
      assert.equal(scanImageMetadata(bytes,'image/png').exif,false,'the stored bytes carry no EXIF');
      assert.equal(new TextDecoder().decode(bytes).includes('Exif'),false,'no EXIF marker survives the re-encode');
    }
    // Benign annotation chunks, no GPS and no orientation: passed through unchanged, and no stripping
    // is claimed for it. This is the honest limitation, stated rather than glossed over.
    const annotated=png(6,4,[chunk('tEXt',textEncoder.encode('Comment\0hello'))]);
    const kept=await store.accept(annotated);
    assert.equal(kept.ok,true);
    if(kept.ok){
      assert.equal(kept.reencoded,false);
      assert.equal(kept.note,'');
      assert.deepEqual(new Uint8Array(await readFile(join(root,'media',kept.id+'.bin'))),annotated,'the bytes were passed through unchanged');
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('identical bytes are one object, and an existing object is never overwritten',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-cas-'));
  const store=new MediaStore(root);
  try{
    const bytes=png(6,4);
    const first=await store.accept(bytes),second=await store.accept(new Uint8Array(bytes));
    assert.equal(first.ok,true);assert.equal(second.ok,true);
    if(!first.ok||!second.ok)return;
    assert.equal(first.id,second.id,'identical bytes map to one object');
    assert.equal(first.id,createHash('sha256').update(bytes).digest('hex'));
    const entries=await readdir(join(root,'media'));
    assert.deepEqual(entries,[first.id+'.bin']);
    const info=await stat(join(root,'media',first.id+'.bin'));
    assert.equal(info.mode&0o777,0o600,'a stored object is owner-only');
    // A pre-existing object at that path is not rewritten, whatever it holds.
    await rm(join(root,'media'),{recursive:true,force:true});
    await mkdir(join(root,'media'),{mode:0o700});
    await writeFile(join(root,'media',first.id+'.bin'),'tampered',{mode:0o600});
    const again=await store.accept(bytes);
    assert.equal(again.ok,true);
    if(again.ok)assert.equal(again.id,first.id);
    assert.equal(await readFile(join(root,'media',first.id+'.bin'),'utf8'),'tampered','an existing object is never overwritten');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a media id is never a path, and a symlink is never followed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-escape-'));
  const outside=await mkdtemp(join(tmpdir(),'dashboard-media-outside-'));
  const store=new MediaStore(root);
  try{
    const accepted=await store.accept(png(6,4));
    assert.equal(accepted.ok,true);
    if(!accepted.ok)return;
    const {id}=accepted;
    // Shapes that could be read as a path are not ids at all.
    assert.equal(await store.get('../../etc/passwd'),null);
    assert.equal(await store.get('..%2f..%2fetc%2fpasswd'),null);
    assert.equal(await store.get(id+'/../../etc/passwd'),null);
    assert.equal(await store.get(id.toUpperCase()),null);
    assert.equal(await store.get('a'.repeat(64)),null);
    assert.equal((await store.get(id))?.mimeType,'image/png','a real id still resolves');
    // An object replaced by a symlink to a file outside the media directory is refused.
    await mkdir(join(root,'media'),{recursive:true,mode:0o700});
    await rm(join(root,'media',id+'.bin'),{force:true});
    await writeFile(join(outside,'stolen.png'),png(6,4));
    await symlink(join(outside,'stolen.png'),join(root,'media',id+'.bin'));
    assert.equal(await store.get(id),null,'a symlinked object is refused');
    // The media directory itself as a symlink is refused just the same.
    await rm(join(root,'media'),{recursive:true,force:true});
    await mkdir(join(outside,'media'),{recursive:true,mode:0o700});
    await writeFile(join(outside,'media',id+'.bin'),png(6,4));
    await symlink(join(outside,'media'),join(root,'media'));
    assert.equal(await store.get(id),null,'a symlinked media directory is refused');
  }finally{
    await rm(root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

/**
 * The container is validated, never assumed. A `media` that is a symbolic link is never followed, one
 * that is not a directory is not read as an empty store, and one this process cannot write is refused
 * up front — each with its own reason and its own code, before any image work, so a broken data root is
 * never reported as a raw filesystem error the owner cannot act on.
 */
test('a media container that is not a usable directory is refused by name, and nothing is written through it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-container-'));
  const outside=await mkdtemp(join(tmpdir(),'dashboard-media-container-outside-'));
  const refused=(reason:RegExp)=>(error:Error)=>error instanceof MediaContainerError&&error.code===MEDIA_CONTAINER_CODE&&reason.test(error.message);
  try{
    // A symlinked container: never followed on read, and refused by name on write.
    await writeFile(join(outside,'kept.png'),png(6,4));
    await symlink(outside,join(root,'media'));
    const store=new MediaStore(root);
    await assert.rejects(()=>store.accept(png(6,4)),refused(/symbolic link/),'an upload into a symlinked container is refused by name');
    const id=createHash('sha256').update(png(6,4)).digest('hex');
    assert.equal(await store.get(id),null,'a symlinked container is never read through');
    assert.deepEqual(await readdir(outside),['kept.png'],'nothing was written outside the data root');
    await unlink(join(root,'media'));
    // A container that is not a directory cannot hold an object, and is not read as an empty one.
    await writeFile(join(root,'media'),'not a directory');
    await assert.rejects(()=>store.accept(png(6,4)),refused(/not a directory/),'a file named media is refused by name');
    await unlink(join(root,'media'));
    // A container this process cannot write: refused before the image is decoded, naming the rule.
    await mkdir(join(root,'media'),{mode:0o500});
    await assert.rejects(()=>store.accept(png(6,4)),refused(/not writable/),'an unwritable container is refused by name');
    await chmod(join(root,'media'),0o700);
    // A usable container still accepts, and none of the refusals above stored anything.
    const accepted=await store.accept(png(6,4));
    assert.equal(accepted.ok,true,'a real directory still accepts');
    if(accepted.ok)assert.deepEqual(await readdir(join(root,'media')),[accepted.id+'.bin'],'only the accepted image is on disk');
  }finally{
    await rm(root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

test('default MediaStore.get is descriptor-pinned, size-bounded, regular-file-only, and closes descriptors',async(t)=>{
  if(process.platform!=='linux'){t.skip('requires Linux procfs');return;}
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-get-'));
  const outside=await mkdtemp(join(tmpdir(),'dashboard-media-out-'));
  try{
    await mkdir(join(root,'media'));
    const bytes=png(6,4),id=createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(root,'media',id+'.bin'),bytes);
    const store=new MediaStore(root);
    const before=(await readdir('/proc/self/fd')).length;
    for(let i=0;i<8;i++)assert.deepEqual(await store.get(id),{bytes,mimeType:'image/png'});
    assert.ok((await readdir('/proc/self/fd')).length<=before+1,'successful reads close all descriptors');

    await writeFile(join(outside,'linked.bin'),bytes);
    const linkedId='a'.repeat(64);
    await symlink(join(outside,'linked.bin'),join(root,'media',linkedId+'.bin'));
    assert.equal(await store.get(linkedId),null,'leaf symlinks are ordinary misses');
    await rm(join(root,'media'),{recursive:true,force:true});
    await symlink(outside,join(root,'media'));
    assert.equal(await store.get(linkedId),null,'symlinked media parents are ordinary misses');
    await unlink(join(root,'media'));
    await mkdir(join(root,'media'));

    const oversized='b'.repeat(64);
    await writeFile(join(root,'media',oversized+'.bin'),Buffer.alloc(MAX_STORED_MEDIA_BYTES+1,0x41));
    assert.equal(await store.get(oversized),null,'oversized records are refused without an unbounded read');
    const fifo='c'.repeat(64);
    execFileSync('mkfifo',[join(root,'media',fifo+'.bin')]);
    assert.equal(await store.get(fifo),null,'special files are refused without blocking');
    assert.ok((await readdir('/proc/self/fd')).length<=before+1,'refusal paths close all descriptors');
  }finally{
    await rm(root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

test('procfs reads stay pinned across deterministic parent and leaf swaps',async(t)=>{
  if(process.platform!=='linux'){t.skip('requires Linux procfs');return;}
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-pinned-'));
  const outside=await mkdtemp(join(tmpdir(),'dashboard-media-pinned-out-'));
  try{
    const original=png(6,4),replacement=png(7,5),id=createHash('sha256').update(original).digest('hex');
    await mkdir(join(root,'media'));
    await writeFile(join(root,'media',id+'.bin'),original);
    await writeFile(join(outside,id+'.bin'),replacement);
    let parentSwapped=false;
    const parentRead=await readLinuxProcfsRegularFileBeneathForTest(root,'media/'+id+'.bin',MAX_STORED_MEDIA_BYTES,{
      afterDirectoryPinned:async(path)=>{
        if(path!==join(root,'media')||parentSwapped)return;
        parentSwapped=true;
        await rename(join(root,'media'),join(root,'media-pinned'));
        await symlink(outside,join(root,'media'));
      }
    });
    assert.equal(parentSwapped,true);
    assert.deepEqual(Buffer.from(parentRead),Buffer.from(original),'the read stays anchored to the pinned directory');
    await unlink(join(root,'media'));
    await rename(join(root,'media-pinned'),join(root,'media'));

    let leafSwapped=false;
    const leafRead=await readLinuxProcfsRegularFileBeneathForTest(root,'media/'+id+'.bin',MAX_STORED_MEDIA_BYTES,{
      afterLeafPinned:async()=>{
        if(leafSwapped)return;
        leafSwapped=true;
        await rename(join(root,'media',id+'.bin'),join(root,'media',id+'.saved'));
        await symlink(join(outside,id+'.bin'),join(root,'media',id+'.bin'));
      }
    });
    assert.equal(leafSwapped,true);
    assert.deepEqual(Buffer.from(leafRead),Buffer.from(original),'the read stays anchored to the pinned leaf');
  }finally{
    await rm(root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

test('procfs backend failures return 503 on GET, queue image resolution, and image submission',{
  skip:process.env.PILOT_TEST_EXPECT_PROCFS_UNAVAILABLE!=='1'?'run via scripts/test-linux-media-seccomp.sh with the deny-statfs profile':false
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-unavailable-'));
  const security=localConfig('http://127.0.0.1:0');
  const control=new ControlStore(root);
  const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',agentPauseMs:100,control});
  try {
    await new Promise<void>((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',()=>{app.server.removeListener('error',reject);resolve();});});
    const address=app.server.address();
    if(!address||typeof address==='string')throw new Error('Test server did not bind a TCP port');
    security.origin='http://127.0.0.1:'+address.port;
    const token={'x-dashboard-token':security.token},headers={...token,'content-type':'application/json',origin:security.origin};
    const post=(path:string,body:unknown)=>fetch(security.origin+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const project=await (await post('/api/projects',{name:'Seccomp media',managed:true,confirm:true})).json() as {id:string};
    const base='/api/projects/'+project.id+'/agents';
    const uploaded=await post(base+'/media',{data:Buffer.from(png(6,4)).toString('base64')});
    const uploadText=await uploaded.text();
    assert.equal(uploaded.status,201,uploadText);
    const media=(JSON.parse(uploadText) as {media:{id:string}}).media;
    const store=new MediaStore(root);
    await assert.rejects(store.get(media.id),MediaReadUnavailableError);
    const mediaGet=await fetch(security.origin+'/api/media/'+media.id,{headers:token,signal:AbortSignal.timeout(5000)});
    const mediaGetBody=await mediaGet.json() as {code?:string};
    assert.equal(mediaGet.status,503);
    assert.equal(mediaGetBody.code,'media-read-unavailable');
    const session=await (await post('/api/sessions',{projectId:project.id,name:'Seccomp queue'})).json() as {session:{id:string}};
    const queue=await post('/api/sessions/'+session.session.id+'/queue/append',{projectId:project.id,revision:0,text:'queued image',images:[media.id]});
    const queueBody=await queue.json() as {code?:string};
    assert.equal(queue.status,503);
    assert.equal(queueBody.code,'media-read-unavailable','queue image resolution surfaces the media backend failure');
    const submitted=await post(base+'/input',{text:'submitted image',images:[media.id],mode:'followUp'});
    const submittedBody=await submitted.json() as {code?:string};
    assert.equal(submitted.status,503);
    assert.equal(submittedBody.code,'media-read-unavailable','submission surfaces the media backend failure');
  }finally{
    try {
      app.server.closeAllConnections();
      let closed=false;
      const close=app.close().then(()=>{closed=true;});
      let shutdownTimer:NodeJS.Timeout|undefined;
      try {
        await Promise.race([close,new Promise((_,reject)=>{shutdownTimer=setTimeout(()=>reject(new Error('Test app shutdown exceeded 10 seconds')),10_000);})]);
      } finally { if(shutdownTimer)clearTimeout(shutdownTimer); }
      assert.equal(closed,true,'the test app and its stores must close before removing their data root');
    } finally {
      try { control.close(); }
      finally { await rm(root,{recursive:true,force:true}); }
    }
  }
});

test('the media routes upload on the bytes, serve authenticated and immutable, and leak no path',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dashboard-media-api-'));
  const security=localConfig('http://127.0.0.1:0');
  const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',agentPauseMs:100});
  await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));
  security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
  try{
    const url=security.origin,token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:url};
    const project=await (await fetch(url+'/api/projects',{method:'POST',headers:writes,body:JSON.stringify({name:'Media',managed:true,confirm:true})})).json() as {id:string};
    const upload=(body:unknown)=>fetch(url+'/api/projects/'+project.id+'/agents/media',{method:'POST',headers:writes,body:JSON.stringify(body)});
    const base64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
    // A wrong declared type and a misleading name are ignored: the bytes decide.
    const sent=await upload({data:base64(png(6,4)),name:'plot.jpg',declaredType:'image/jpeg'});
    assert.equal(sent.status,201);
    const media=(await sent.json()).media as {id:string;mimeType:string;width:number;height:number;bytes:number;requires:string[]};
    assert.equal(media.mimeType,'image/png');
    assert.equal(media.width,6);assert.equal(media.height,4);
    assert.deepEqual(media.requires,['image']);
    assert.match(media.id,/^[a-f0-9]{64}$/);
    // The object is served by the sniffed type, with nosniff and an immutable cache header.
    assert.equal((await fetch(url+'/api/media/'+media.id)).status,401,'serving media needs the owner session');
    const wrongHost=await new Promise<number>((ok,fail)=>{const req=request({host:'127.0.0.1',port:new URL(url).port,path:'/api/media/'+media.id,headers:{host:'evil.example','x-dashboard-token':security.token}},res=>{res.resume();ok(res.statusCode??0);});req.on('error',fail);req.end();});
    assert.equal(wrongHost,403,'the unchanged Host check applies to media');
    const served=await fetch(url+'/api/media/'+media.id,{headers:token});
    assert.equal(served.status,200);
    assert.equal(served.headers.get('content-type'),'image/png');
    assert.equal(served.headers.get('x-content-type-options'),'nosniff');
    assert.match(served.headers.get('cache-control')??'',/immutable/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()),Buffer.from(png(6,4)));
    // Identical bytes are the same object: the second upload returns the same id and stores nothing new.
    assert.equal(((await (await upload({data:base64(png(6,4))})).json()).media as {id:string}).id,media.id);
    assert.deepEqual(await readdir(join(root,'media')),[media.id+'.bin'],'identical bytes are one object on disk');
    // Distinct refusals, each with its own reason and code, and nothing stored for them.
    const renamed=await upload({data:base64(textEncoder.encode('not an image')),name:'photo.png',declaredType:'image/png'});
    assert.equal(renamed.status,422);
    assert.equal((await renamed.json()).code,'type');
    const bytes=await upload({data:Buffer.alloc(MAX_IMAGE_BYTES+1,0x41).toString('base64')});
    assert.equal(bytes.status,422);
    assert.equal((await bytes.json()).code,'bytes');
    const pixels=await upload({data:base64(pngHeaderOnly(30_000,30_000))});
    assert.equal(pixels.status,422);
    assert.equal((await pixels.json()).code,'pixels');
    const metadata=await upload({data:base64(exifPng(6,4))});
    assert.equal(metadata.status,422);
    assert.equal((await metadata.json()).code,'metadata');
    // An id that is not a media id, or one that does not exist, is simply unknown.
    assert.equal((await fetch(url+'/api/media/..%2f..%2fetc%2fpasswd',{headers:token})).status,404);
    assert.equal((await fetch(url+'/api/media/'+'a'.repeat(64),{headers:token})).status,404);
    assert.equal((await fetch(url+'/api/media/'+media.id,{method:'POST',headers:writes,body:'{}'})).status,405);
    assert.equal((await fetch(url+'/api/projects/'+project.id+'/agents/media',{method:'POST',headers:writes,body:JSON.stringify({data:base64(png(6,4)),extra:true})})).status,400);
    // A media container that is not a usable directory is a named refusal with its own code and reason
    // on the route too, never an unclassified 500, and it stores nothing at all.
    await rm(join(root,'media'),{recursive:true,force:true});
    await writeFile(join(root,'media'),'not a directory');
    const broken=await upload({data:base64(png(6,4))});
    assert.equal(broken.status,503);
    const refusal=await broken.json() as {code?:string;error:string};
    assert.equal(refusal.code,MEDIA_CONTAINER_CODE);
    assert.match(refusal.error,/is not a directory/);
    assert.equal(await readFile(join(root,'media'),'utf8'),'not a directory','a refused upload writes nothing at all');
  }finally{
    await app.close();
    await rm(root,{recursive:true,force:true});
  }
});

/**
 * One gesture is one enqueue: the composer gesture's own guard, tested where it can be tested
 * exactly. A drop or a paste that hands the same file over twice would otherwise become two items
 * and two uploads. A file-picker selection is not this: it is what the user chose, taken as given.
 */
test('one gesture enqueues a file once, however the gesture lists it',()=>{
  const bytes=new Uint8Array([1,2,3]);
  const file=new File([bytes],'same.png',{type:'image/png',lastModified:1});
  const twin=new File([bytes],'same.png',{type:'image/png',lastModified:1});
  assert.deepEqual(uniqueImageFiles([]),[],'an empty gesture enqueues nothing');
  assert.equal(uniqueImageFiles([file,file]).length,1,'the same File object is taken once');
  assert.equal(uniqueImageFiles([file,twin]).length,1,'the same named bytes are taken once, even as two objects');
  assert.equal(uniqueImageFiles([file,new File([new Uint8Array([9])],'other.png',{type:'image/png',lastModified:1})]).length,2,'a genuinely different file is kept');
  assert.equal(uniqueImageFiles([file,new File([bytes],'same.png',{type:'image/jpeg',lastModified:1})]).length,2,'a different declared type is a different file');
});

/**
 * The honesty claims are locked to the code they describe: the prepared-base64 comment and the
 * constant agree exactly, the document states the same value, and the orientation claim is per
 * format — JPEG is where it applies, and PNG is not described as orientation-bearing.
 */
test('the media limits, their comments and the per-format orientation truth agree',async()=>{
  const source=await readFile(new URL('../../src/server/media-store.ts',import.meta.url),'utf8');
  const document=await readFile(new URL('../../docs/MEDIA.md',import.meta.url),'utf8');
  const declaration=/\/\*\*([\s\S]*?)\*\/\s*export const MAX_PREPARED_BASE64_BYTES\s*=\s*([\d_]+);/.exec(source);
  assert.ok(declaration,'the prepared-base64 constant is declared under its comment');
  const comment=declaration[1],value=Number(declaration[2].replaceAll('_',''));
  assert.equal(value,MAX_PREPARED_BASE64_BYTES);
  const characters=/([\d,]+) characters/.exec(comment);
  assert.ok(characters,'the comment states the value in characters');
  assert.equal(Number(characters[1].replaceAll(',','')),value,'the comment states exactly the value it declares');
  const mib=/([\d.]+) MiB/.exec(comment);
  assert.ok(mib,'the comment states the value in MiB');
  assert.equal(Number(mib[1]),Math.round((value/1048576)*100)/100,'the MiB the comment states is the value it declares');
  assert.match(comment,/4,718,592/,'the comment names the pinned package default it is below');
  assert.equal(/matching the pinned package default/.test(comment),false,'the comment claims no match it does not have');
  assert.match(document,/\| Base64 the processor may produce for one image \| 4,500,000 bytes \|/,'the document states the same value');
  assert.match(document,/JPEG is the case where it applies/);
  assert.match(document,/WebP carries its orientation in an `EXIF` chunk/);
  assert.match(document,/PNG has no EXIF orientation in this path/);
  assert.equal(document.includes('and the image is turned upright by its EXIF orientation'),false,'the false claim that a PNG is turned upright by an EXIF orientation is gone');
});
