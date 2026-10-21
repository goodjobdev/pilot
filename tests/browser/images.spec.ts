import {test,expect} from '@playwright/test';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';

/**
 * The composer's image path, driven the way a person drives it: the file picker (which carries
 * `capture` for a phone camera), a drop, and a paste. Every image goes through the same upload path,
 * and a refusal is shown on the image itself, never as one generic failure.
 */
function crc32(bytes:Uint8Array):number{let crc=~0;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(0xEDB88320&-(crc&1));}return (~crc)>>>0;}
function chunk(type:string,data:Uint8Array):Uint8Array{
  const out=new Uint8Array(12+data.length),view=new DataView(out.buffer);
  view.setUint32(0,data.length);out.set(new TextEncoder().encode(type),4);out.set(data,8);
  view.setUint32(8+data.length,crc32(out.subarray(4,8+data.length)));
  return out;
}
function png(width:number,height:number):Uint8Array{
  const header=new Uint8Array(13),view=new DataView(header.buffer);
  view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=2;
  const raw=new Uint8Array(height*(1+width*3));
  for(let y=0;y<height;y++){raw[y*(1+width*3)]=0;for(let x=0;x<width;x++){raw[y*(1+width*3)+1+x*3]=0x33;raw[y*(1+width*3)+2+x*3]=0x99;raw[y*(1+width*3)+3+x*3]=0xcc;}}
  return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',new Uint8Array(0))]));
}
async function withAgents(page:import('@playwright/test').Page,fixture:string){
  await page.goto('/');
  await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
  await page.getByLabel('Project name').fill(fixture);
  await page.getByRole('button',{name:'Confirm & add project'}).click();
  await page.getByRole('button',{name:'Agents',exact:true}).click();
  await expect(page.locator('.agent-state')).toHaveText('Idle');
}

test('the composer uploads a picked image, refuses a bad one per image, and clears after a send',async({page})=>{
  const directory=await mkdtemp(join(tmpdir(),'dashboard-browser-images-'));
  const good=join(directory,'shot.png');
  await writeFile(good,png(8,6));
  await withAgents(page,'Image composer fixture');

  // The picker is a real file input, and it offers the camera on a phone.
  const picker=page.locator('input[type=file]');
  await expect(picker).toHaveAttribute('capture','environment');
  await expect(picker).toHaveAttribute('accept','image/jpeg,image/png,image/webp');

  // A drop of a text file renamed '.png' is refused on its bytes, with the server's own reason.
  await page.locator('.agent-composer').evaluate((element)=>{
    const transfer=new DataTransfer();
    transfer.items.add(new File(['this is not an image'],'notes.png',{type:'image/png'}));
    element.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
  });
  await expect(page.locator('.image-item.refused .image-refusal')).toContainText('Only JPEG, PNG and WebP');

  // A paste of a truncated PNG is refused too, with its own reason rather than a generic failure.
  await page.locator('.agent-composer').evaluate((element)=>{
    const transfer=new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])],'pasted.png',{type:'image/png'}));
    element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  });
  await expect(page.locator('.image-item.refused')).toHaveCount(2);
  await expect(page.locator('.image-item.refused').last().locator('.image-refusal')).toContainText('not a readable PNG');
  // A refused image is never sent: with nothing sendable, Send stays disabled.
  await page.getByLabel('Message the agent').fill('');
  await expect(page.getByRole('button',{name:'Send message'})).toBeDisabled();
  await page.getByRole('button',{name:'Remove image notes.png'}).click();
  await page.getByRole('button',{name:'Remove image pasted.png'}).click();
  await expect(page.locator('.image-item')).toHaveCount(0);

  // The picker sends the same bytes through the same path: a bounded preview, the stored size and
  // the decoded dimensions, and no refusal.
  await picker.setInputFiles(good);
  const item=page.locator('.image-item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.image-name')).toHaveText('shot.png');
  await expect(item.locator('img.image-preview')).toBeVisible();
  await expect(item.locator('.image-facts')).toContainText('8×6');
  await expect(item.locator('.image-refusal')).toHaveCount(0);
  // A ready image can be sent without a caption, so Send is enabled again.
  await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();

  // Sending carries the image id and clears the strip; the run answers as it always did.
  await page.getByLabel('Message the agent').fill('what is in this picture');
  await page.getByRole('button',{name:'Send message'}).click();
  const transcript=page.getByLabel('Agent transcript');
  await expect(transcript).toContainText('Scripted test reply');
  await expect(transcript).toContainText('what is in this picture');
  await expect(page.locator('.image-item')).toHaveCount(0);
});

test('an image with no caption is sendable, and a second one past the limit is refused on itself',async({page})=>{
  const directory=await mkdtemp(join(tmpdir(),'dashboard-browser-images-captionless-'));
  const good=join(directory,'diagram.png');
  await writeFile(good,png(10,10));
  await withAgents(page,'Image captionless fixture');

  // A message needs text or an image: with a ready image, and no text, Send is enabled.
  await page.getByLabel('Message the agent').fill('');
  await expect(page.getByRole('button',{name:'Send message'})).toBeDisabled();
  await page.locator('input[type=file]').setInputFiles(good);
  await expect(page.locator('.image-item')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByLabel('Agent transcript')).toContainText('Scripted test reply');
  await expect(page.locator('.image-item')).toHaveCount(0);

  // Past the documented maximum, the extra image is refused on itself rather than silently dropped.
  await page.locator('input[type=file]').setInputFiles([good,good,good,good,good,good,good]);
  await expect(page.locator('.image-item')).toHaveCount(7);
  await expect(page.locator('.image-item.refused .image-refusal')).toContainText('one message');
});

/**
 * One gesture is handled once. A drop or a paste that lands on the image strip used to be taken by
 * both the strip's own handler and the composer area's, which produced two items and two uploads.
 */
test('one drop or paste gesture yields exactly one preview item and exactly one upload',async({page})=>{
  await withAgents(page,'One gesture fixture');
  const uploads:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/agents/media'))uploads.push(request.url());});
  // A drop on the strip itself: the strip has no handler of its own, so the one handler for the
  // whole composer area takes the gesture exactly once.
  await page.locator('.image-composer').evaluate((element,bytes)=>{
    const transfer=new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)],'dropped.png',{type:'image/png'}));
    element.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
  },Array.from(png(8,6)));
  await expect(page.locator('.image-item')).toHaveCount(1);
  // The stored facts appear only once the upload answered, so this is also the wait for that answer.
  await expect(page.locator('.image-item').first().locator('.image-facts')).toContainText('8×6');
  expect(uploads,'one drop is one upload').toHaveLength(1);
  await expect(page.locator('.image-item').first().locator('.image-name')).toHaveText('dropped.png');

  // A paste on the same strip: the other half of the same bug.
  await page.locator('.image-composer').evaluate((element,bytes)=>{
    const transfer=new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)],'pasted.png',{type:'image/png'}));
    element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  },Array.from(png(10,10)));
  await expect(page.locator('.image-item')).toHaveCount(2);
  await expect(page.locator('.image-item').last().locator('.image-facts')).toContainText('10×10');
  expect(uploads,'one paste is one more upload, and no more').toHaveLength(2);
  await expect(page.locator('.image-item').last().locator('.image-name')).toHaveText('pasted.png');
});

/**
 * An upload in flight is not a stored image. A message typed while an image was still uploading used to
 * be sent with the text alone, and the strip was then cleared, so an accepted image was silently left
 * out of the message. The send is held until the image is stored, and the state is named.
 */
test('a send is held until an image that is still uploading has been stored',async({page})=>{
  const directory=await mkdtemp(join(tmpdir(),'dashboard-browser-images-uploading-'));
  const good=join(directory,'slow.png');
  await writeFile(good,png(8,6));
  await withAgents(page,'Upload race fixture');
  const sent:Record<string,unknown>[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/agents/input'))sent.push(JSON.parse(request.postData()??'{}'));});
  // The upload answers only when this test says so: a real upload is fast, and the race is not.
  let release:()=>void=()=>{};
  const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/agents/media',async route=>{await held;await route.continue();});
  await page.getByLabel('Message the agent').fill('this caption must not go without the image');
  await page.locator('input[type=file]').setInputFiles(good);
  await expect(page.locator('.image-item')).toHaveCount(1);
  await expect(page.locator('.image-item .image-facts')).toContainText('Checking');
  // Nothing is stored yet, so the message is held: Send is disabled, the state says why, and no
  // submission reaches the server with the image left out.
  await expect(page.getByRole('button',{name:'Send message'})).toBeDisabled();
  await expect(page.locator('.agent-upload-state')).toContainText('Uploading an image');
  expect(sent,'nothing is sent while the image is still uploading').toHaveLength(0);
  release();
  await expect(page.locator('.image-item .image-facts')).toContainText('8×6');
  await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByLabel('Agent transcript')).toContainText('this caption must not go without the image');
  await expect.poll(()=>sent.length).toBe(1);
  expect(sent[0].images,'the image is part of the message the send carried').toHaveLength(1);
  await expect(page.locator('.image-item')).toHaveCount(0);
});

/**
 * A preview fetch and an upload are two conditions. A preview that cannot be fetched is reported as
 * its own condition, is never described as a refusal, and never removes an image the server accepted.
 */
test('a preview that cannot be fetched is its own condition and never removes the accepted image',async({page})=>{
  const directory=await mkdtemp(join(tmpdir(),'dashboard-browser-images-preview-'));
  const good=join(directory,'kept.png');
  await writeFile(good,png(8,6));
  await withAgents(page,'Image preview fixture');
  const sent:Record<string,unknown>[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/agents/input'))sent.push(JSON.parse(request.postData()??'{}'));});
  // The upload itself succeeds; only the owner-only fetch of the stored bytes fails.
  await page.route('**/api/media/**',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'not available'})}));
  await page.locator('input[type=file]').setInputFiles(good);
  const item=page.locator('.image-item');
  await expect(item).toHaveCount(1);
  // The server accepted the bytes, so the image is ready: its stored facts are shown, nothing is
  // reported as a refusal, and the preview problem is a condition of its own.
  await expect(item.locator('.image-facts')).toContainText('8×6');
  await expect(item.locator('.image-preview-problem')).toContainText('stored');
  await expect(item.locator('.image-refusal')).toHaveCount(0);
  await expect(item).not.toHaveClass(/refused/);
  // An accepted image is still sendable, and the send really carries its id.
  await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();
  await page.getByLabel('Message the agent').fill('keep this image');
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByLabel('Agent transcript')).toContainText('keep this image');
  await expect.poll(()=>sent.length).toBe(1);
  expect(sent[0].images,'the accepted image is still part of the message').toHaveLength(1);
  expect(sent[0].text).toBe('keep this image');
});
