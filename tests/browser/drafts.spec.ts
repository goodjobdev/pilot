import {test,expect} from '@playwright/test';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';

/**
 * The composer's per-session drafts, seen the way a person sees them: text survives a session switch
 * and a reload, a send that fails keeps the message, text typed while a send awaits is not lost, and
 * an image reference is never moved into another session or sent without being stored.
 *
 * The limits used by the store are proposed defaults; these tests assert the behaviour of the
 * implementation, not an accepted product policy.
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
async function imageFile(name:string):Promise<string>{
 const directory=await mkdtemp(join(tmpdir(),'pilot-browser-drafts-'));
 const path=join(directory,name);
 await writeFile(path,png(8,6));
 return path;
}
async function addProject(page:import('@playwright/test').Page,name:string){
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill(name);
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.locator('.agent-state')).toHaveText('Idle');
}
async function newSession(page:import('@playwright/test').Page,name:string){
 await page.getByRole('button',{name:'New session'}).click();
 await page.getByLabel('New session name').fill(name);
 await page.getByRole('button',{name:'Create session'}).click();
 // Creation now navigates to the new session. Wait for that navigation instead of opening
 // the list during its pending callback, which can close the list before its row is clicked.
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText(name);
 await expect(page.getByLabel('Message the agent')).toHaveValue('');
}
async function openSession(page:import('@playwright/test').Page,name:string){
 await page.getByRole('button',{name:'Sessions'}).click();
 await page.getByLabel('Named sessions').getByRole('button',{name:new RegExp(name)}).click();
}
async function draftRecords(page:import('@playwright/test').Page):Promise<{key:string;record:Record<string,unknown>}[]>{
 return page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('pilot.draft.v1:')).map(key=>({key,record:JSON.parse(localStorage.getItem(key) as string) as Record<string,unknown>})));
}
/**
 * A reload or a route removal can cancel a request while a route handler still holds it. Only
 * those cancellations, and a route another path already handled, are benign. Every other error is
 * rethrown, so a genuine failure is not hidden.
 */
function isRouteCancellation(error:unknown):boolean{
 const message=error instanceof Error?error.message:String(error);
 return /Target page, context or browser has been closed|Request context disposed|net::ERR_ABORTED|Route is already handled|Test ended|Browser has been closed/i.test(message);
}
/** Replace only the vision field of a real agent view, without losing the real body. */
async function fulfilWithTextOnlyVision(route:import('@playwright/test').Route):Promise<void>{
 let response;
 try{
  response=await route.fetch();
 }catch(error){
  if(isRouteCancellation(error))return;
  throw error;
 }
 // A non-JSON body is a genuine failure and is deliberately not caught.
 const body=await response.json() as Record<string,unknown>;
 body.vision={provider:'faux',modelId:'text-only',acceptsImages:false};
 try{
  await route.fulfill({response,body:JSON.stringify(body)});
 }catch(error){
  if(isRouteCancellation(error))return;
  throw error;
 }
}

test('switching sessions and reloading restore each session’s own draft',async({page})=>{
 await addProject(page,'Draft switch fixture');
 const composer=page.getByLabel('Message the agent');
 await composer.fill('root draft');
 await newSession(page,'Alpha');
 await composer.fill('alpha draft');
 await newSession(page,'Beta');
 await composer.fill('beta draft');

 await openSession(page,'Alpha');
 await expect(composer).toHaveValue('alpha draft');
 // The switch restores the in-memory latest, so the saved-time label names the session.
 await expect(page.locator('.draft-saved')).toContainText('Draft saved for session');
 await openSession(page,'Beta');
 await expect(composer).toHaveValue('beta draft');

 // A reload returns to the session that was open, with its text and its image references.
 await page.reload();
 await expect(composer).toHaveValue('beta draft');
 await expect(page.locator('.draft-notice').filter({hasText:'Draft restored'})).toContainText('Draft restored for session');
 await openSession(page,'Alpha');
 await expect(composer).toHaveValue('alpha draft');

 // Every stored draft names the project and session it belongs to, and carries no image bytes.
 const records=await draftRecords(page);
 expect(records.length).toBeGreaterThanOrEqual(3);
 for(const {key,record} of records){
  expect(key).toMatch(/^pilot\.draft\.v1:[^:]+:[^:]+$/);
  expect(record.projectId).toBeTruthy();
  expect(record.session).toBeTruthy();
  const serialized=JSON.stringify(record);
  expect(serialized).not.toContain('data:image');
  expect(serialized).not.toContain('base64');
 }
});

test('a rejected send and a network failure keep the draft, and the retry reuses one request identity',async({page})=>{
 await addProject(page,'Draft failure fixture');
 const composer=page.getByLabel('Message the agent');
 const transcript=page.getByLabel('Agent transcript');
 const input='**/api/projects/*/agents/input';
 const requestIds:string[]=[];

 // An ambiguous network failure: the request leaves the page but no answer arrives.
 let attempts=0;
 await page.route(input,async route=>{
  attempts+=1;
  requestIds.push((route.request().postDataJSON() as {requestId:string}).requestId);
  if(attempts===1){await route.abort('failed');return;}
  await route.continue();
 });
 await composer.fill('retry me');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('.agents-problem')).toContainText('could not be reached');
 await expect(composer).toHaveValue('retry me');

 // The retry of the same text is the same request identity, so admission cannot happen twice.
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(transcript).toContainText('retry me');
 await expect(composer).toHaveValue('');
 expect(requestIds).toHaveLength(2);
 expect(requestIds[1]).toBe(requestIds[0]);
 await page.unroute(input);
 const stored=await draftRecords(page);
 const recorded=stored.find(entry=>entry.record.session==='root');
 expect(recorded, 'the admitted draft is cleared from storage').toBeUndefined();

 // A definite rejection is not an admission: the text stays.
 await page.route(input,async route=>{
  requestIds.push((route.request().postDataJSON() as {requestId:string}).requestId);
  await route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:'This message was refused for the test.'})});
 });
 await composer.fill('refused message');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('.agents-problem')).toContainText('refused for the test');
 await expect(composer).toHaveValue('refused message');
 await page.unroute(input);
});

test('text typed while a send awaits is kept, and only the submitted images leave the strip',async({page})=>{
 await addProject(page,'Draft concurrent fixture');
 const composer=page.getByLabel('Message the agent');
 const image=await imageFile('while-sending.png');
 await page.locator('input[type=file]').setInputFiles(image);
 await expect(page.locator('.image-item .image-facts')).toContainText('8×6');

 let release=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/projects/*/agents/input',async route=>{
  await gate;
  await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({submissionId:'test-submission',queued:false})});
 });
 await composer.fill('base message');
 await page.getByRole('button',{name:'Send message'}).click();
 // The request is in flight; the person keeps typing.
 await composer.fill('base message plus more');
 release();
 await expect(page.locator('.draft-notice')).toContainText('text you typed while it was sending was kept');
 await expect(composer).toHaveValue('base message plus more');
 // The submitted image left the strip; nothing else was cleared.
 await expect(page.locator('.image-item')).toHaveCount(0);
 await page.unroute('**/api/projects/*/agents/input');
});

test('an upload that finishes after a session switch never appears in the other session',async({page})=>{
 await addProject(page,'Draft stale fixture');
 const composer=page.getByLabel('Message the agent');
 const image=await imageFile('late.png');
 await newSession(page,'Alpha');
 await composer.fill('alpha text');
 await newSession(page,'Beta');
 await composer.fill('beta text');

 // Return to Alpha and start an upload that the server answers slowly.
 await openSession(page,'Alpha');
 await expect(composer).toHaveValue('alpha text');
 await page.route('**/api/projects/*/agents/media',async route=>{
  await new Promise(resolve=>setTimeout(resolve,1200));
  await route.continue();
 });
 await page.locator('input[type=file]').setInputFiles(image);
 await expect(page.locator('.image-item')).toHaveCount(1);
 // Switch before the upload is answered.
 await openSession(page,'Beta');
 await expect(composer).toHaveValue('beta text');
 await page.waitForTimeout(1600);
 await expect(page.locator('.image-item')).toHaveCount(0);
 await expect(composer).toHaveValue('beta text');
 await page.unroute('**/api/projects/*/agents/media');

 // Alpha names the upload that did not finish, instead of hiding it or sending it elsewhere.
 await openSession(page,'Alpha');
 await expect(page.locator('.image-item.missing')).toContainText('did not finish');
 await page.getByRole('button',{name:/Remove image/}).click();
 await expect(page.locator('.image-item')).toHaveCount(0);
});

test('a reload recovers a stored image reference, and a reference the server lost is named',async({page})=>{
 await addProject(page,'Draft image fixture');
 const composer=page.getByLabel('Message the agent');
 const image=await imageFile('recovered.png');
 await composer.fill('with an image');
 await page.locator('input[type=file]').setInputFiles(image);
 await expect(page.locator('.image-item .image-facts')).toContainText('8×6');

 // Recovery after a reload is read-only: no input and no upload leaves the page.
 const writes:string[]=[];
 page.on('request',request=>{
  if(request.method()!=='GET')writes.push(request.method()+' '+new URL(request.url()).pathname);
 });
 await page.reload();
 await expect(composer).toHaveValue('with an image');
 await expect(page.locator('.image-item .image-facts')).toContainText('8×6');
 expect(writes.filter(entry=>entry.includes('/agents/input')||entry.includes('/agents/media'))).toEqual([]);
 await expect(page.locator('.image-item .image-refusal')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();

 // Replace the stored reference with one the server does not have. Recovery must name it.
 await expect(page.locator('.draft-saved')).toBeVisible();
 await page.evaluate(()=>{
  for(const key of Object.keys(localStorage)){
   if(!key.startsWith('pilot.draft.v1:'))continue;
   const record=JSON.parse(localStorage.getItem(key) as string);
   record.attachments=[{key:'gone',name:'gone.png',status:'ready',mediaId:'f'.repeat(64),declaredBytes:10}];
   localStorage.setItem(key,JSON.stringify(record));
  }
 });
 await page.reload();
 await expect(composer).toHaveValue('with an image');
 await expect(page.locator('.image-item.missing')).toContainText('server no longer has this image');
 await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();
 // Sending the text does not silently drop the named missing image.
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.getByLabel('Agent transcript')).toContainText('with an image');
 await expect(page.locator('.image-item.missing')).toHaveCount(1);
});

test('a refused or failed upload stays visible after a send and can be removed',async({page})=>{
 await addProject(page,'Draft failed upload fixture');
 const composer=page.getByLabel('Message the agent');
 // A refusal is the server's decision about the bytes.
 await page.locator('.agent-composer').evaluate(element=>{
  const transfer=new DataTransfer();
  transfer.items.add(new File(['this is not an image'],'notes.png',{type:'image/png'}));
  element.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
 });
 await expect(page.locator('.image-item.refused')).toContainText('Only JPEG, PNG and WebP');
 // A failure is an upload that never reached the server; its bytes are not known to be stored.
 const uploadRoute='**/api/projects/*/agents/media';
 await page.route(uploadRoute,async route=>{
  if(route.request().method()==='POST'){await route.abort('failed');return;}
  await route.continue();
 });
 await page.locator('input[type=file]').setInputFiles(await imageFile('network.png'));
 await expect(page.locator('.image-item.failed')).toContainText('could not be reached');

 await composer.fill('text without an image');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.getByLabel('Agent transcript')).toContainText('text without an image');
 // Neither non-ready image is sent, and neither is silently dropped.
 await expect(page.locator('.image-item.refused')).toHaveCount(1);
 await expect(page.locator('.image-item.failed')).toHaveCount(1);
 await page.getByRole('button',{name:'Remove image notes.png'}).click();
 await page.getByRole('button',{name:'Remove image network.png'}).click();
 await expect(page.locator('.image-item')).toHaveCount(0);
 await page.unroute(uploadRoute);
});

test('a stored image is checked before it can be sent, and the check holds the message',async({page})=>{
 await addProject(page,'Draft checking fixture');
 const composer=page.getByLabel('Message the agent');
 await composer.fill('wait for the check');
 await page.locator('input[type=file]').setInputFiles(await imageFile('checking.png'));
 await expect(page.locator('.image-item .image-facts')).toContainText('8×6');

 // A read of the stored object that is slow must hold the send, not send without the image.
 await page.route('**/api/media/*',async route=>{
  await new Promise(resolve=>setTimeout(resolve,900));
  await route.continue();
 });
 await page.reload();
 await expect(composer).toHaveValue('wait for the check');
 await expect(page.locator('.image-item')).toContainText('Checking the stored image');
 await expect(page.getByRole('button',{name:'Send message'})).toBeDisabled();
 await expect(page.locator('.image-item .image-facts')).toContainText('8×6',{timeout:5000});
 await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();
 await page.unroute('**/api/media/*');
});

test('the model capability comes with the view, blocks a send, and refreshes after a model change',async({page})=>{
 await addProject(page,'Draft capability fixture');
 const composer=page.getByLabel('Message the agent');
 const image=await imageFile('capability.png');
 await composer.fill('needs a vision model');
 await page.locator('input[type=file]').setInputFiles(image);
 await expect(page.locator('.image-item .image-facts')).toContainText('8×6');
 await expect(page.locator('.draft-saved')).toBeVisible();

 // The capability travels with the agent view, which is the same request the screen already
 // makes. The vision is replaced here, not the view.
 const viewRoute=/\/api\/projects\/[^/]+\/agents(\?.*)?$/;
 await page.route(viewRoute,async route=>{
  if(route.request().method()!=='GET'){
   try{await route.continue();}catch(error){if(!isRouteCancellation(error))throw error;}
   return;
  }
  await fulfilWithTextOnlyVision(route);
 });
 await page.reload();
 await expect(composer).toHaveValue('needs a vision model');
 await expect(page.locator('.image-capability')).toContainText('does not accept images');
 await expect(page.locator('.image-capability')).toContainText('faux / text-only');
 await expect(page.getByRole('button',{name:'Send message'})).toBeDisabled();
 const transcript=page.getByLabel('Agent transcript');
 await expect(transcript).not.toContainText('needs a vision model');

 // A model change answers with the capability now in force, so the stale reading is replaced.
 await page.unroute(viewRoute);
 await page.evaluate(()=>{
  const select=document.querySelector<HTMLSelectElement>('select[aria-label="Session model"]');
  if(!select)throw new Error('model select missing');
  select.value='';
  select.dispatchEvent(new Event('change',{bubbles:true}));
 });
 await expect(page.locator('.image-capability')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();

 // The session query is bounded everywhere else, and the view query is bounded too.
 const projectId=await page.evaluate(()=>Object.keys(localStorage).find(key=>key.startsWith('pilot.draft.v1:'))?.split(':')[1]??'');
 expect(projectId).not.toBe('');
 const status=await page.evaluate(async({projectId})=>{
  const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')?.content??'';
  const res=await fetch('/api/projects/'+projectId+'/agents?sessionId='+'x'.repeat(201),{headers:{'x-dashboard-token':token}});
  return res.status;
 },{projectId});
 expect(status).toBe(422);
});

test('a corrupt stored draft is named and left in place, and typing works again',async({page})=>{
 await addProject(page,'Draft corrupt fixture');
 const composer=page.getByLabel('Message the agent');
 await composer.fill('will not survive');
 await expect(page.locator('.draft-saved')).toBeVisible();
 await page.evaluate(()=>{
  for(const key of Object.keys(localStorage)){
   if(key.startsWith('pilot.draft.v1:'))localStorage.setItem(key,'{ broken json');
  }
 });
 await page.reload();
 await expect(composer).toHaveValue('');
 await expect(page.locator('.draft-notice')).toContainText('could not be read');
 await composer.fill('typed after the loss');
 await expect(page.locator('.draft-saved')).toContainText('Draft saved for the root conversation');
 await page.reload();
 await expect(composer).toHaveValue('typed after the loss');
});

test('a failed image lookup keeps the reference and can be retried, while only 404 means missing',async({page})=>{
 await addProject(page,'Draft lookup failure fixture');
 const composer=page.getByLabel('Message the agent');
 await composer.fill('image under a failing lookup');
 await page.locator('input[type=file]').setInputFiles(await imageFile('lookup.png'));
 await expect(page.locator('.image-item .image-facts')).toContainText('8×6');
 await expect(page.locator('.draft-saved')).toBeVisible();

 // A sign-in refusal says nothing about the stored object, so it must not become `missing`.
 await page.route('**/api/media/*',async route=>{
  await route.fulfill({status:401,contentType:'application/json',body:'{}'});
 });
 await page.reload();
 await expect(composer).toHaveValue('image under a failing lookup');
 await expect(page.locator('.image-item.checking')).toContainText('could not confirm this image (HTTP 401)');
 await expect(page.getByRole('button',{name:/Retry lookup for/})).toBeVisible();
 await expect(page.getByRole('button',{name:'Send message'})).toBeDisabled();
 // The server id stays in the saved draft, so a reload can retry the same reference.
 const ids=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('pilot.draft.v1:')).flatMap(key=>{
  const record=JSON.parse(localStorage.getItem(key) as string) as {attachments?:{mediaId?:string}[]};
  return (record.attachments??[]).map(attachment=>attachment.mediaId??'');
 }));
 expect(ids).toHaveLength(1);
 expect(ids[0]).toMatch(/^[a-f0-9]{64}$/);

 await page.unroute('**/api/media/*');
 await page.getByRole('button',{name:/Retry lookup for/}).click();
 await expect(page.locator('.image-item .image-facts')).toContainText('8×6');
 await expect(page.locator('.image-item .image-refusal')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();
});

test('a reconnect keeps a draft and a stored image without a second upload or a send',async({page})=>{
 let streams=0,mediaPosts=0,inputPosts=0;
 await page.route('**/api/projects/*/agents/stream*',async route=>{
  streams+=1;
  if(streams===1){await route.abort('failed');return;}
  await route.continue();
 });
 page.on('request',request=>{
  if(request.method()!=='POST')return;
  const path=new URL(request.url()).pathname;
  if(path.endsWith('/agents/media'))mediaPosts+=1;
  if(path.endsWith('/agents/input'))inputPosts+=1;
 });
 await addProject(page,'Draft reconnect fixture');
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 const composer=page.getByLabel('Message the agent');
 await expect(composer).toBeVisible();
 await composer.fill('draft across a reconnect');
 await page.locator('input[type=file]').setInputFiles(await imageFile('reconnect.png'));
 await expect(page.locator('.image-item .image-facts')).toContainText('8×6');

 // The first stream was aborted; the client reconnects on its own. Recovery is read-only.
 await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection','live',{timeout:15000});
 expect(mediaPosts).toBe(1);
 expect(inputPosts).toBe(0);
 await expect(composer).toHaveValue('draft across a reconnect');
 await expect(page.locator('.image-item')).toHaveCount(1);

 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.getByLabel('Agent transcript')).toContainText('draft across a reconnect');
 expect(inputPosts).toBe(1);
 await expect(page.locator('.agent-entry.user')).toHaveCount(1);
});

test('a refused local save keeps the latest text in this tab, warns after reload, and can be exported or cleared',async({page})=>{
 await addProject(page,'Draft refused save fixture');
 const composer=page.getByLabel('Message the agent');
 await newSession(page,'Alpha');
 await composer.fill('saved baseline');
 await expect(page.locator('.draft-saved')).toContainText('Draft saved');

 // Only the draft record fails to save. The small failure marker can still be written.
 await page.evaluate(()=>{
  const original=Storage.prototype.setItem;
  Storage.prototype.setItem=function(key,value){
   if(String(key).startsWith('pilot.draft.v1:'))throw Object.assign(new Error('full'),{name:'QuotaExceededError'});
   return original.call(this,key,value);
  };
 });
 await composer.fill('newer text that cannot be saved');
 await expect(page.locator('.draft-unsaved')).toContainText('Not saved locally');

 // A send whose attempt record cannot be saved, and whose reply is lost, keeps the explicit
 // ambiguity warning. A generic storage message must not replace it.
 await page.route('**/api/projects/*/agents/input',async route=>{await route.abort('failed');});
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('.draft-notice[role="alert"]')).toContainText('Admission can still succeed if the reply is lost');
 await expect(page.locator('.draft-notice[role="alert"]')).toContainText('Check the transcript before resending');
 await expect(page.locator('.draft-notice[role="alert"]')).toContainText('does not prevent a duplicate');
 await expect(composer).toHaveValue('newer text that cannot be saved');
 await page.unroute('**/api/projects/*/agents/input');

 // The latest text lives in memory across a switch away and back, even though storage has only
 // the older baseline.
 await newSession(page,'Beta');
 await openSession(page,'Alpha');
 await expect(composer).toHaveValue('newer text that cannot be saved');
 await expect(page.locator('.draft-unsaved')).toContainText('Not saved locally');

 // The export action carries the latest text, not the stored version.
 const downloadPromise=page.waitForEvent('download');
 await page.getByRole('button',{name:'Download the unsaved draft'}).click();
 const download=await downloadPromise;
 expect(download.suggestedFilename()).toContain('pilot-draft-');

 // A reload loses the unsaved text, shows the last saved version, and warns that it may be older.
 await page.reload();
 await expect(composer).toHaveValue('saved baseline');
 await expect(page.locator('.draft-notice[role="alert"]')).toContainText('later local save failed');
 await expect(page.locator('.draft-notice[role="alert"]')).toContainText('Check the transcript before resending');
 await expect(page.locator('.draft-notice[role="alert"]')).toContainText('does not prevent a duplicate');

 // An explicit clear removes drafts and failure markers; nothing on the server changes.
 page.on('dialog',dialog=>void dialog.accept());
 await page.getByRole('button',{name:'Clear local drafts'}).click();
 await expect(composer).toHaveValue('');
 const remaining=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('pilot.draft.')));
 expect(remaining).toEqual([]);
});
