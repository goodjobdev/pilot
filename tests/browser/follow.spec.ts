import {test,expect,type Page} from '@playwright/test';

/**
 * Follow-scroll, the new-activity control and the phone layout of the session view.
 *
 * The transcript follows new activity only while the reader is at or near the bottom. A reader who
 * scrolled up keeps their position in a scroller that is never covered by another panel, a bounded
 * count of the entries that arrived meanwhile is shown in a reserved control row, and tapping it
 * returns to the bottom and resumes following. An admitted send returns to the bottom; a refused
 * send does not move the reader. A project or session switch resets the follow state and the count.
 *
 * Every scenario uses the scripted provider: no model is called and nothing is spent. The `[pause]`
 * marker holds a run open, which is the window in which a reader can scroll away while activity is
 * still arriving.
 */

async function addProject(page:Page,name:string){
 await page.goto('/');
 const showSidebar=page.getByRole('button',{name:'Show project sidebar'});
 if(await showSidebar.isVisible().catch(()=>false))await showSidebar.click();
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill(name);
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 const hideSidebar=page.getByRole('button',{name:'Hide project sidebar'});
 if(await hideSidebar.isVisible().catch(()=>false))await hideSidebar.click();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByLabel('Message the agent')).toBeVisible();
}

const transcriptOf=(page:Page)=>page.getByLabel('Agent transcript');
const scrollerOf=(page:Page)=>page.locator('.agent-transcript');
const indicatorOf=(page:Page)=>page.locator('[data-follow="indicator"]');
const liveOf=(page:Page)=>page.locator('[data-follow-status]');

interface Box{x:number;y:number;w:number;h:number;bottom:number;right:number}
function geometry(page:Page){
 return page.evaluate(()=>{
  const rect=(selector:string):{x:number;y:number;w:number;h:number;bottom:number;right:number}|null=>{
   const element=document.querySelector(selector) as HTMLElement|null;
   if(!element)return null;
   const r=element.getBoundingClientRect();
   return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom,right:r.right};
  };
  const scroller=document.querySelector('.agent-transcript') as HTMLElement;
  const section=document.querySelector('.agents') as HTMLElement;
  return {
   scroller:{scrollTop:scroller.scrollTop,clientHeight:scroller.clientHeight,scrollHeight:scroller.scrollHeight,rect:rect('.agent-transcript')},
   wrapper:rect('.agent-transcript-wrap'),
   row:rect('.new-activity-row'),
   button:rect('[data-follow="indicator"]'),
   composer:rect('.agent-composer'),
   section:{height:section.clientHeight,scrollHeight:section.scrollHeight,scrollTop:section.scrollTop,compact:section.classList.contains('compact')},
  };
 });
}
type Geometry=Awaited<ReturnType<typeof geometry>>;

const overlaps=(a:Box|null,b:Box|null)=>Boolean(a&&b)&&!(a!.right<=b!.x||b!.right<=a!.x||a!.bottom<=b!.y||b!.bottom<=a!.y);
async function expectAtBottom(page:Page){
 await expect.poll(async()=>{const g=await geometry(page);return g.scroller.scrollHeight-g.scroller.clientHeight-g.scroller.scrollTop;},{timeout:10000}).toBeLessThanOrEqual(2);
}
async function scrollUp(page:Page){
 await scrollerOf(page).hover();
 await page.mouse.wheel(0,-6000);
 await expect.poll(async()=>(await geometry(page)).scroller.scrollTop,{timeout:5000}).toBeLessThan(20);
}
async function send(page:Page,text:string){
 const composer=page.getByLabel('Message the agent');
 await composer.fill(text);
 await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled({timeout:15000});
 await composer.press('Enter');
}
async function seed(page:Page,count:number){
 for(let i=1;i<=count;i++){
  await send(page,'[note seed message '+i+']');
  await expect(page.locator('.agent-entry',{hasText:'Scripted test reply'})).toHaveCount(i,{timeout:20000});
 }
}

/** The control row and the composer must never cover the transcript, and its centre must hit it. */
async function expectTranscriptUncovered(page:Page,g:Geometry){
 expect(overlaps(g.scroller.rect,g.row)).toBe(false);
 expect(overlaps(g.scroller.rect,g.composer)).toBe(false);
 const hit=await page.evaluate(()=>{
  const element=document.querySelector('.agent-transcript') as HTMLElement;
  const r=element.getBoundingClientRect();
  const target=document.elementFromPoint(r.x+r.width/2,r.y+Math.min(20,r.height/2));
  return Boolean(target&&target.closest('.agent-transcript'));
 });
 expect(hit).toBe(true);
}

test('client caps a synthetic 507-row stream snapshot, marks the gap, and preserves stats and questions',async({page})=>{
 const ids=Array.from({length:507},(_,i)=>'synthetic-'+i);
 await page.route('**/api/projects/*/agents/stream',async route=>{
  const snapshot={conversationId:'synthetic-conversation',working:false,attempt:null,entries:ids.map((id,i)=>({id,kind:'user',rawKind:'pi.user',at:null,text:'synthetic row '+i,thinking:'',tools:[],stopReason:null,error:null,data:null,toolResult:null})),partial:'',inbox:[],usage:{input:123,output:456,cost:7},model:null,questions:[{id:'pending-outside-window',text:'Still actionable?',askedAt:null,answer:null}],updatedAt:new Date().toISOString()};
  await route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify(snapshot)+'\n\n'});
 });
 await addProject(page,'Transcript cap fixture');
 const transcript=transcriptOf(page);
 await expect(transcript).toContainText('synthetic row 506',{timeout:10000});
 await expect(transcript).toContainText('7 older rows are not shown');
 await expect(transcript.locator('.agent-entry')).toHaveCount(500);
 await expect(transcript.locator('.agent-text').filter({hasText:/^synthetic row 6$/})).toHaveCount(0);
 await expect(transcript).toContainText('synthetic row 123');
 await expect(page.getByRole('region',{name:'Questions for me'})).toContainText('Still actionable?');

 // Reload opens a fresh snapshot. The same cap and honest gap must remain, with no send or replay.
 await page.reload();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 const reconnected=transcriptOf(page);
 await expect(reconnected.locator('.agent-entry')).toHaveCount(500);
 await expect(reconnected).toContainText('7 older rows are not shown');
 await expect(page.getByRole('region',{name:'Questions for me'})).toContainText('Still actionable?');
});

test('a paused reader keeps a visible anchor when a 500-row window evicts 20 rows and appends 20',async({page})=>{
 const makeView=(last:number)=>({conversationId:'synthetic-eviction-session',working:false,attempt:null,entries:Array.from({length:last+1},(_,i)=>({id:'evict-'+i,kind:'user',rawKind:'pi.user',at:null,text:'transcript row '+String(i).padStart(3,'0'),thinking:'',tools:[],stopReason:null,error:null,data:null,toolResult:null})),partial:'',inbox:[],usage:{input:12,output:34,cost:0.5},model:null,questions:[],updatedAt:new Date().toISOString()});
 await page.addInitScript(({first,second}:{first:ReturnType<typeof makeView>;second:ReturnType<typeof makeView>})=>{
  const global=window as typeof window&{__emitTranscriptNext?:()=>void};
  const original=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
   const url=typeof input==='string'?input:input instanceof Request?input.url:String(input);
   if(!url.includes('/agents/stream'))return original(input,init);
   let controller:ReadableStreamDefaultController<Uint8Array>;
   const encoder=new TextEncoder();
   const stream=new ReadableStream<Uint8Array>({start(next){
    controller=next;
    next.enqueue(encoder.encode('data: '+JSON.stringify(first)+'\n\n'));
    global.__emitTranscriptNext=()=>controller.enqueue(encoder.encode('data: '+JSON.stringify(second)+'\n\n'));
   }});
   return new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}});
  };
 },{first:makeView(506),second:makeView(526)});
 await addProject(page,'Capped eviction fixture');
 const transcript=transcriptOf(page),scroller=scrollerOf(page),rows=transcript.locator('.agent-entry');
 await expect(rows).toHaveCount(500);
 await expect(transcript).toContainText('7 older rows are not shown');
 const anchor=transcript.locator('[data-entry-id="evict-100"]');
 await anchor.evaluate(row=>{
  const scroller=row.closest('.agent-transcript') as HTMLElement;
  scroller.scrollTop+=row.getBoundingClientRect().top-scroller.getBoundingClientRect().top-40;
  scroller.dispatchEvent(new Event('scroll'));
 });
 await expect(indicatorOf(page)).toContainText('Jump to newest');
 const before=await anchor.boundingBox();
 expect(before).not.toBeNull();
 await page.evaluate(()=>{
  const global=window as typeof window&{__emitTranscriptNext?:()=>void};
  global.__emitTranscriptNext?.();
 });
 await expect(transcript).toContainText('transcript row 526');
 await expect(rows).toHaveCount(500);
 await expect(transcript).toContainText('27 older rows are not shown');
 const after=await anchor.boundingBox();
 expect(after).not.toBeNull();
 expect(Math.abs(after!.y-before!.y)).toBeLessThanOrEqual(1);
 await expect(indicatorOf(page)).toContainText('20 new activities');
 await expect(page.getByText('12 in / 34 out')).toBeVisible();
 expect(await scroller.evaluate(element=>(element as HTMLElement).scrollTop)).toBeGreaterThan(0);
});

test('more than 500 pending questions warn on omission and keep an omitted inbox item answerable by exact id',async({page})=>{
 const questions=Array.from({length:505},(_,i)=>({id:'synthetic-question-'+i,text:'Synthetic pending question '+i+'?',askedAt:null,answer:null}));
 const snapshot={conversationId:'synthetic-question-session',working:false,attempt:null,entries:[],partial:'',inbox:[],usage:{input:5,output:6,cost:0},model:null,questions,updatedAt:new Date().toISOString()};
 let answerBody:Record<string,unknown>|null=null,answerPosts=0;
 await page.route('**/api/projects/*/agents/stream',async route=>{
  await route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify(snapshot)+'\n\n'});
 });
 await page.route('**/api/projects/*/agents',async route=>{
  if(new URL(route.request().url()).pathname.endsWith('/agents'))await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({enabled:true,view:snapshot,vision:null})});
  else await route.continue();
 });
 await page.route('**/api/projects/*/attention*',async route=>{
  if(new URL(route.request().url()).pathname.endsWith('/attention')){
   const projectId=new URL(route.request().url()).pathname.split('/')[3]!;
   const item={id:'question:synthetic-question-0',kind:'question',severity:3,projectId,sessionId:null,at:null,context:'Synthetic pending question 0?',actions:['open'],questionId:'synthetic-question-0'};
   const count={open:1,byKind:{question:1,approval:0,failure:0,interrupted:0},capped:false,complete:true};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({projectId,items:[item],count,page:{limit:20,returned:1,hasMore:false,nextCursor:null,listedCap:100,capped:false},limits:{perPage:20,listedCap:100,policy:'proposed'},sources:{questions:'read',approvals:'empty',lifecycle:'read'}})});
  }else await route.continue();
 });
 await page.route('**/api/projects/*/agents/answer',async route=>{
  answerPosts++;answerBody=route.request().postDataJSON() as Record<string,unknown>;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({submissionId:'synthetic-answer'})});
 });
 await addProject(page,'Question window fixture');
 const warning=page.getByRole('alert').filter({hasText:'5 questions are outside'});
 await expect(warning).toBeVisible();
 await expect(warning).toContainText('do not treat this view as showing no other questions');
 const attention=page.getByRole('button',{name:/Needs me/});
 await attention.click();
 const omittedItem=page.locator('[data-attention-id="question:synthetic-question-0"]');
 await expect(omittedItem).toBeVisible();
 await omittedItem.click();
 const question=page.locator('#question-synthetic-question-0');
 await expect(question).toBeVisible();
 expect(answerPosts).toBe(0);
 await question.getByLabel(/^Answer to:/).fill('Keep this question identity');
 await question.getByRole('button',{name:'Send answer'}).click();
 await expect.poll(()=>answerPosts).toBe(1);
 expect(answerBody).toMatchObject({questionId:'synthetic-question-0',text:'Keep this question identity'});
 await expect(question.getByLabel(/^Answer to:/)).toHaveValue('');
});

test.beforeEach(async({page})=>{
 await page.setViewportSize({width:390,height:844});
});

test('a phone keeps a usable transcript, and every condensed control is reachable by expansion',async({page})=>{
 await addProject(page,'Follow chrome fixture');
 await seed(page,6);
 await page.waitForTimeout(500);

 const g=await geometry(page);
 console.log('PHONE_GEOMETRY '+JSON.stringify(g));
 expect(g.section.compact).toBe(true);
 expect(g.scroller.clientHeight).toBeGreaterThanOrEqual(240);
 await expectTranscriptUncovered(page,g);

 // The scope line and the agent picker are one expansion away, and never deleted.
 const binding=page.locator('details.session-more');
 await expect(binding.locator('summary')).toBeVisible();
 await binding.locator('summary').click();
 await expect(binding).toContainText('Scopes in effect');
 await expect(binding.getByLabel('Agent for this session')).toBeVisible();
 await binding.locator('summary').click();

 // Session details carries the same scopes at every width.
 await page.getByRole('button',{name:'Session details'}).click();
 await expect(page.getByRole('region',{name:'Session details'})).toContainText('Scopes in effect');
 await page.getByRole('button',{name:'Hide session details'}).click();

 // The model identity and the model state are one expansion away.
 const model=page.locator('details.head-more');
 await expect(model.locator('summary')).toBeVisible();
 await model.locator('summary').click();
 await expect(model).toContainText('no model called');
 await model.locator('summary').click();

 // The activity timeline is bounded by disclosure: open it after several turns and the transcript
 // still keeps its floor, without the composer covering it.
 const activity=page.locator('details.activity-more');
 await activity.locator('summary').click();
 const activityRegion=page.getByRole('region',{name:'Session activity',exact:true});
 await expect(activityRegion).toContainText('record_note',{timeout:20000});
 const expanded=await geometry(page);
 console.log('PHONE_ACTIVITY_OPEN '+JSON.stringify(expanded));
 // The floor belongs to the transcript wrapper; the scroller itself gives up the control row when
 // the reader has paused. Either way the composer never covers it.
 expect(expanded.wrapper!.h).toBeGreaterThanOrEqual(160);
 expect(expanded.scroller.clientHeight).toBeGreaterThanOrEqual(96);
 await expectTranscriptUncovered(page,expanded);
 await activity.locator('summary').click();

 // The draft tools are one expansion away, and the action itself is unchanged.
 const draftTools=page.locator('details.draft-more');
 await expect(draftTools.locator('summary')).toBeVisible();
 await draftTools.locator('summary').click();
 await expect(draftTools.getByRole('button',{name:'Clear local drafts'})).toBeVisible();
});

test('the new-activity control is announced, reserved and never covers text',async({page})=>{
 await addProject(page,'Follow control fixture');
 const live=liveOf(page);
 await seed(page,6);
 await expectAtBottom(page);
 await expect(indicatorOf(page)).toHaveCount(0);

 await scrollUp(page);
 const indicator=indicatorOf(page);
 await expect(indicator).toBeVisible();
 await expect(indicator).toContainText('Jump to newest');
 // A plain jump is announced too, not only a count.
 await expect(live).toHaveText('Newer activity is below');
 const paused=await geometry(page);
 expect(paused.row).not.toBeNull();
 expect(paused.button!.h).toBeGreaterThanOrEqual(44);
 expect(paused.button!.w).toBeGreaterThanOrEqual(44);
 expect(paused.row!.y).toBeGreaterThanOrEqual(paused.scroller.rect!.bottom-0.5);
 expect(paused.row!.bottom).toBeLessThanOrEqual(paused.wrapper!.bottom+0.5);
 await expectTranscriptUncovered(page,paused);
 await expect(page.locator('.new-activity-row')).toHaveCSS('position','static');

 await send(page,'[pause] control row pause');
 await expectAtBottom(page);
 await scrollUp(page);
 await expect(indicator).toContainText(/^↓ \d+ new activit/,{timeout:20000});
 await expect(live).toHaveText(/\d+ new activit(y|ies) while scrolled up/);

 await indicator.click();
 await expectAtBottom(page);
 await expect(indicator).toHaveCount(0);
 await expect(live).toHaveText('');
});

test('a run does not move a reader who scrolled up, and the control returns them to the newest activity',async({page})=>{
 await addProject(page,'Follow pause fixture');
 const transcript=transcriptOf(page),indicator=indicatorOf(page);
 await seed(page,6);
 await expectAtBottom(page);

 await scrollUp(page);
 await expect(indicator).toBeVisible();

 await send(page,'[pause] pause one');
 await send(page,'[pause] pause two');
 await expectAtBottom(page);
 await scrollUp(page);
 const readingAt=(await geometry(page)).scroller.scrollTop;

 await expect(transcript).toContainText('You said: pause one',{timeout:20000});
 await expect(indicator).toBeVisible({timeout:20000});
 await expect(indicator).toContainText(/^↓ \d+ new activit/);
 expect((await geometry(page)).scroller.scrollTop).toBe(readingAt);

 await indicator.click();
 await expectAtBottom(page);
 await expect(indicator).toHaveCount(0);

 await expect(transcript).toContainText('You said: pause two',{timeout:20000});
 await expectAtBottom(page);
 await expect(indicator).toHaveCount(0);
});

test('a frame that arrives while the reader move is still unhandled does not steal the position',async({page})=>{
 await addProject(page,'Follow race fixture');
 const transcript=transcriptOf(page),indicator=indicatorOf(page);
 await seed(page,4);
 await send(page,'[pause] race window');
 await expect(page.getByLabel('Message the agent')).toHaveValue('',{timeout:10000});
 await expectAtBottom(page);

 // Apply the reader's move but withhold its scroll event: the component still holds "following".
 await page.evaluate(()=>{
  const element=document.querySelector('.agent-transcript') as HTMLElement;
  window.addEventListener('scroll',event=>{if(event.target===element)event.stopPropagation();},{capture:true});
  element.scrollTop=0;
 });
 await expect(transcript).toContainText('You said: race window',{timeout:20000});
 await expect(indicator).toBeVisible({timeout:20000});
 await expect(indicator).toContainText('1 new activity');
 expect((await geometry(page)).scroller.scrollTop).toBe(0);
});

test('an admitted send returns to the bottom and a refused send does not move the reader',async({page})=>{
 await addProject(page,'Follow send fixture');
 const indicator=indicatorOf(page);
 await seed(page,4);
 await scrollUp(page);
 await expect(indicator).toBeVisible();

 await send(page,'a message from the bottom of the reading position');
 await expectAtBottom(page);
 await expect(indicator).toHaveCount(0);
 await expect(transcriptOf(page)).toContainText('a message from the bottom of the reading position');

 await scrollUp(page);
 await expect(indicator).toBeVisible();
 const before=(await geometry(page)).scroller.scrollTop;
 await page.route('**/api/projects/*/agents/input',route=>route.fulfill({status:500,contentType:'application/json',body:'{"error":"synthetic refusal"}'}));
 const composer=page.getByLabel('Message the agent');
 await composer.fill('this message is refused');
 await expect(page.getByRole('button',{name:'Send message'})).toBeEnabled();
 await composer.press('Enter');
 await expect(page.locator('.agents-problem')).toBeVisible({timeout:10000});
 expect((await geometry(page)).scroller.scrollTop).toBe(before);
 await expect(indicator).toBeVisible();
 await page.unroute('**/api/projects/*/agents/input');
});

test('a reader scroll during a held successful send response stays anchored and gets new activity',async({page})=>{
 await addProject(page,'Follow delayed response fixture');
 await seed(page,5);
 await expectAtBottom(page);
 let release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 let admitted!:()=>void;
 const wasAdmitted=new Promise<void>(resolve=>{admitted=resolve;});
 await page.route('**/api/projects/*/agents/input',async route=>{
  const response=await route.fetch();
  admitted();
  await held;
  await route.fulfill({response});
 });
 const releaseScrollEvent=()=>page.evaluate(()=>{
  const testWindow=window as typeof window&{__releasePendingReaderScroll?:()=>void};
  testWindow.__releasePendingReaderScroll?.();
 });
 try{
  const composer=page.getByLabel('Message the agent');
  await composer.fill('[pause] delayed response');
  await composer.press('Enter');
  await wasAdmitted;
  const anchor=page.locator('.agent-entry').nth(1);
  await page.evaluate(()=>{
   const element=document.querySelector('.agent-transcript') as HTMLElement;
   const hold=(event:Event)=>{if(event.target===element)event.stopPropagation();};
   window.addEventListener('scroll',hold,true);
   const testWindow=window as typeof window&{__releasePendingReaderScroll?:()=>void};
   testWindow.__releasePendingReaderScroll=()=>{
    window.removeEventListener('scroll',hold,true);
    element.dispatchEvent(new Event('scroll'));
    delete testWindow.__releasePendingReaderScroll;
   };
   const row=element.querySelectorAll('.agent-entry')[1] as HTMLElement;
   element.scrollTop+=row.getBoundingClientRect().top-element.getBoundingClientRect().top-24;
  });
  await expect(indicatorOf(page)).toBeVisible();
  const before=await anchor.boundingBox();
  const scrollTopBefore=(await geometry(page)).scroller.scrollTop;
  expect(before).not.toBeNull();
  release();
  await expect(composer).toHaveValue('',{timeout:10000});
  await releaseScrollEvent();
  await expect(transcriptOf(page)).toContainText('You said: delayed response',{timeout:20000});
  await expect(indicatorOf(page)).toContainText(/new activit/);
  const after=await anchor.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y-before!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs((await geometry(page)).scroller.scrollTop-scrollTopBefore)).toBeLessThanOrEqual(1);
  await indicatorOf(page).click();
  await expectAtBottom(page);
 }finally{
  release();
  await releaseScrollEvent();
  await page.unroute('**/api/projects/*/agents/input');
 }
});

test('a keyboard-short screen scrolls the section in normal flow and never covers the transcript',async({page})=>{
 await addProject(page,'Follow short fixture');
 await seed(page,5);

 await page.setViewportSize({width:390,height:500});
 await expect.poll(async()=>(await geometry(page)).scroller.clientHeight,{timeout:5000}).toBeGreaterThanOrEqual(160);
 const short=await geometry(page);
 console.log('SHORT_GEOMETRY '+JSON.stringify(short));
 expect(short.scroller.clientHeight).toBeGreaterThanOrEqual(160);
 expect(short.section.scrollHeight).toBeGreaterThan(short.section.height);
 expect(overlaps(short.scroller.rect,short.composer)).toBe(false);
 await expectTranscriptUncovered(page,short);

 // Every control is reachable by scrolling the section, including the composer and Send.
 await page.locator('.agent-composer').scrollIntoViewIfNeeded();
 await expect(page.getByRole('button',{name:'Send message'})).toBeVisible();
 const composerBox=await page.locator('.agent-composer').boundingBox();
 expect(composerBox).not.toBeNull();
 expect(composerBox!.y+composerBox!.height).toBeLessThanOrEqual(501);
 const reached=await geometry(page);
 expect(reached.section.scrollTop).toBeGreaterThan(0);
 expect(reached.scroller.clientHeight).toBeGreaterThanOrEqual(160);
});

test('a scroll clamped by a layout change keeps following',async({page})=>{
 await addProject(page,'Follow clamp fixture');
 await seed(page,4);
 await expectAtBottom(page);
 const before=(await geometry(page)).scroller.scrollTop;

 // A taller viewport clamps the scroll position: the maximum scrollTop falls while the reader is
 // still at the bottom. The next arrival must follow, not count.
 await page.setViewportSize({width:390,height:1000});
 await page.waitForTimeout(300);
 const clamped=await geometry(page);
 expect(clamped.scroller.scrollTop).toBeLessThanOrEqual(before);
 await expectAtBottom(page);

 await send(page,'a message after the clamp');
 await expectAtBottom(page);
 await expect(indicatorOf(page)).toHaveCount(0);
});

test('switching sessions resets the follow state and never shows the previous count',async({page})=>{
 await addProject(page,'Follow switch fixture');
 const transcript=transcriptOf(page),indicator=indicatorOf(page);
 await seed(page,4);

 await send(page,'[pause] pause before the switch');
 await scrollUp(page);
 await expect(transcript).toContainText('You said: pause before the switch',{timeout:20000});
 await expect(indicator).toBeVisible({timeout:20000});
 await expect(indicator).toContainText(/new activit/);

 await page.getByRole('button',{name:'New session'}).click();
 await page.getByLabel('New session name').fill('Fresh follow session');
 await page.getByRole('button',{name:'Create session'}).click();
 await expect(page.getByText('Created session Fresh follow session')).toBeVisible();
 await page.getByRole('button',{name:'Sessions'}).click();
 await page.getByRole('button',{name:/Fresh follow session/}).click();
 await expect(transcript).toContainText('No messages yet',{timeout:20000});
 await expect(indicator).toHaveCount(0);
 expect(await transcript.innerText()).not.toContain('new activit');
});

/** Switch project from the sidebar and open the agents view again (a switch leaves that view). */
async function switchProject(page:Page,name:string){
 await page.getByRole('button',{name:'Show project sidebar'}).click();
 await page.getByRole('button',{name:new RegExp(name)}).click();
 const hide=page.getByRole('button',{name:'Hide project sidebar'});
 if(await hide.isVisible().catch(()=>false))await hide.click();
 await expect(page.getByRole('heading',{name})).toBeVisible({timeout:20000});
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByLabel('Message the agent')).toBeVisible({timeout:20000});
}

test('a project switch between equal-length conversations resets the follow state and the content',async({page})=>{
 await addProject(page,'Project Alpha');
 const transcript=transcriptOf(page),indicator=indicatorOf(page);
 await seed(page,1);
 await scrollUp(page);
 await expect(indicator).toBeVisible();
 await expect(transcript).toContainText('[note seed message 1]');

 // A second project with its own conversation of exactly the same number of entries.
 await page.getByRole('button',{name:'Show project sidebar'}).click();
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Project Beta');
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 const hide=page.getByRole('button',{name:'Hide project sidebar'});
 if(await hide.isVisible().catch(()=>false))await hide.click();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(transcript).toContainText('No messages yet',{timeout:20000});
 await expect(indicator).toHaveCount(0);
 await seed(page,1);

 // Paused in Beta, then back to Alpha: no count of Beta may appear, and Alpha opens at its newest.
 await scrollUp(page);
 await expect(indicator).toBeVisible();
 await switchProject(page,'Project Alpha');
 await expect(transcript).toContainText('[note seed message 1]',{timeout:20000});
 await expect(page.getByRole('heading',{name:'Project Alpha'})).toBeVisible();
 await expectAtBottom(page);
 await expect(indicator).toHaveCount(0);

 // And back to Beta, which must equally reset instead of carrying Alpha's state.
 await switchProject(page,'Project Beta');
 await expect(transcript).toContainText('[note seed message 1]',{timeout:20000});
 await expectAtBottom(page);
 await expect(indicator).toHaveCount(0);
});

test('a reconnect snapshot of the selected session shows no phantom count from the session before it',async({page})=>{
 await addProject(page,'Follow reconnect fixture');
 const transcript=transcriptOf(page),indicator=indicatorOf(page);
 await seed(page,4);

 await send(page,'[pause] pause before reconnect');
 await scrollUp(page);
 await expect(transcript).toContainText('You said: pause before reconnect',{timeout:20000});
 await expect(indicator).toBeVisible({timeout:20000});
 await page.getByRole('button',{name:'New session'}).click();
 await page.getByLabel('New session name').fill('Reconnect session');
 await page.getByRole('button',{name:'Create session'}).click();
 await expect(page.getByText('Created session Reconnect session')).toBeVisible();
 await page.getByRole('button',{name:'Sessions'}).click();
 await page.getByRole('button',{name:/Reconnect session/}).click();
 await expect(transcript).toContainText('No messages yet',{timeout:20000});

 await page.reload();
 await expect(page.getByRole('heading',{name:'Follow reconnect fixture'})).toBeVisible({timeout:20000});
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByLabel('Message the agent')).toBeVisible({timeout:20000});
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Reconnect session',{timeout:20000});
 await expect(transcript).toContainText('No messages yet',{timeout:20000});
 await expect(indicator).toHaveCount(0);
 expect(await transcript.innerText()).not.toContain('new activit');
});
