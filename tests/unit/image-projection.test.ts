import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectStoredImage } from '../../src/server/agents/image-projection';
import { MediaStore } from '../../src/server/media-store';
import { agentEntryView, agentViewFrom } from '../../src/shared/agent';
import { MAX_IMAGE_BYTES, MAX_IMAGE_BASE64_CHARS, MAX_IMAGES_PER_MESSAGE } from '../../src/shared/images';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwnnkGAAKbAZnxMlgqAAAAAElFTkSuQmCC','base64');
const data=png.toString('base64');
const image={type:'image',data,mimeType:'image/png'};
const resolve=(block:unknown)=>{
 const value=block as {data?:unknown;mimeType?:unknown};
 return projectStoredImage(value.data,value.mimeType);
};

test('historical provider image bytes resolve to an existing immutable media id without inline data',()=>{
 const expected={id:createHash('sha256').update(png).digest('hex'),mimeType:'image/png'};
 assert.deepEqual(projectStoredImage(data,'image/png'),expected);
 const entry=agentEntryView({id:'historical',kind:'pi.user',model:[{content:[image]}]},resolve)!;
 assert.deepEqual(entry.images,[expected]);
 assert.equal(JSON.stringify(entry).includes(data),false);
 assert.deepEqual(agentEntryView({kind:'pi.user',model:[{content:[image]}]})?.images,[]);
});

test('projection recovers the media store id after upload processing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-image-projection-'));
 try{
  const store=new MediaStore(root);
  const accepted=await store.accept(png);
  assert.equal(accepted.ok,true,JSON.stringify(accepted));
  if(!accepted.ok)return;
  const stored=await store.get(accepted.id);
  assert.ok(stored);
  assert.deepEqual(projectStoredImage(Buffer.from(stored.bytes).toString('base64'),stored.mimeType),{id:accepted.id,mimeType:stored.mimeType});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('malformed, noncanonical, oversized, mismatched and unsupported blocks are refused',()=>{
 for(const [body,mime] of [
  [undefined,'image/png'],[data,undefined],['','image/png'],['!!!!','image/png'],
  [data+'\n','image/png'],[data.slice(0,-1),'image/png'],['Zh==','image/png'],
  [data,'image/jpeg'],[data,'image/gif'],[data,'image/svg+xml'],
  [Buffer.from('<svg/>').toString('base64'),'image/png'],
  [Buffer.from('RIFF0000WAVE').toString('base64'),'image/webp'],
  [Buffer.from('GIF89a000000').toString('base64'),'image/gif'],
  ['A'.repeat(MAX_IMAGE_BASE64_CHARS+4),'image/png']
 ])assert.equal(projectStoredImage(body,mime),null);
 const tooManyBytes=Buffer.alloc(MAX_IMAGE_BYTES+1);png.copy(tooManyBytes);
 assert.equal(projectStoredImage(tooManyBytes.toString('base64'),'image/png'),null);
 const excessiveDimensions=Buffer.from(png);excessiveDimensions.writeUInt32BE(2001,16);
 assert.equal(projectStoredImage(excessiveDimensions.toString('base64'),'image/png'),null);
});

test('a large bounded canonical base64 block does not overflow the validator',()=>{
 const large=Buffer.alloc(MAX_IMAGE_BYTES);png.copy(large);
 assert.deepEqual(projectStoredImage(large.toString('base64'),'image/png'),{
  id:createHash('sha256').update(large).digest('hex'),mimeType:'image/png'
 });
});

test('text does not consume the image budget and projection stops at the shared image limit',()=>{
 let calls=0;
 const content=[{type:'text',text:'six attachments'},...Array.from({length:MAX_IMAGES_PER_MESSAGE+2},()=>image)];
 const view=agentViewFrom({entries:[{id:'many',kind:'pi.user',model:[{content}]}]},undefined,block=>{calls++;return resolve(block);});
 assert.equal(view.entries[0].images?.length,MAX_IMAGES_PER_MESSAGE);
 assert.equal(calls,MAX_IMAGES_PER_MESSAGE);
 assert.equal(view.entries[0].text,'six attachments');
 assert.equal(JSON.stringify(view).includes(data),false);
 assert.deepEqual(agentEntryView({kind:'pi.assistant',model:[{content}]},()=>{throw Error('Assistant images must not resolve');})?.images,[]);
});
