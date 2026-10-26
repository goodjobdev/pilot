import {test,expect,type Page} from '@playwright/test';

/**
 * The reconnect states a phone user must be able to trust: a dropped stream says so and comes
 * back by itself, and a sign-in refusal stops the loop instead of retrying forever.
 *
 * The connection states are recorded by an observer before the stream opens, so the assertion
 * does not depend on catching a short-lived state between two polls.
 */
async function addProject(page:Page,name:string){
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill(name);
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await expect(page.getByRole('heading',{name})).toBeVisible();
}

async function observeStates(page:Page){
 await page.evaluate(()=>{
  const states:string[]=[];
  const read=()=>{
   const element=document.querySelector('[data-connection]');
   if(!element)return;
   const state=element.getAttribute('data-connection');
   if(state&&states[states.length-1]!==state)states.push(state);
  };
  new MutationObserver(read).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-connection']});
  read();
  (window as unknown as {__connectionStates:string[]}).__connectionStates=states;
 });
}

test('a dropped agent stream shows offline, reconnects once and returns to live',async({page})=>{
 let streams=0;
 await page.route('**/api/projects/*/agents/stream*',async route=>{
  streams+=1;
  if(streams===1){await route.abort('failed');return;}
  await route.continue();
 });
 await addProject(page,'Reconnect drop fixture');
 await observeStates(page);
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByLabel('Message the agent')).toBeVisible();
 const status=page.locator('[data-connection]');
 await expect(status).toHaveAttribute('data-connection','live',{timeout:15000});
 const states=await page.evaluate(()=>(window as unknown as {__connectionStates:string[]}).__connectionStates);
 expect(states).toContain('offline');
 expect(states.lastIndexOf('live')).toBeGreaterThan(states.indexOf('offline'));
 expect(streams).toBeGreaterThan(1);
});

test('a sign-in refusal stops the stream loop and names the sign-in state',async({page})=>{
 let streams=0;
 await page.route('**/api/projects/*/agents/stream*',async route=>{
  streams+=1;
  await route.fulfill({status:401,contentType:'application/json',body:'{}'});
 });
 await addProject(page,'Reconnect auth fixture');
 await observeStates(page);
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByLabel('Message the agent')).toBeVisible();
 const status=page.locator('[data-connection]');
 await expect(status).toHaveAttribute('data-connection','auth-required');
 await expect(page.getByRole('button',{name:'Reload to sign in'})).toBeVisible();
 // A retry loop would increment this; a sign-in refusal is terminal until the owner reloads.
 await page.waitForTimeout(1_500);
 expect(streams).toBe(1);
 const states=await page.evaluate(()=>(window as unknown as {__connectionStates:string[]}).__connectionStates);
 expect(states).toContain('auth-required');
 expect(states).not.toContain('offline');
});

test('a reload while the network is down shows the failure and recovers with one fresh snapshot, sending nothing',async({page})=>{
 let offline=false;
 // Every agent GET is recorded, so the final assertion cannot pass on an empty list. Every non-GET
 // is recorded after the project exists, so a write during the offline phase or the reconnect
 // would be named rather than missed.
 const agentGets:string[]=[];
 const nonGet:string[]=[];
 page.on('request',request=>{
  const url=request.url();
  if(url.includes('/agents')&&request.method()==='GET')agentGets.push(url);
  if(request.method()!=='GET')nonGet.push(request.method()+' '+url);
 });
 // While offline, both the view snapshot and the stream fail. When the owner reconnects after the
 // network returns, a normal stream answers again.
 await page.route(/\/api\/projects\/[^/]+\/agents(\?.*)?$/,async route=>{
  if(offline){await route.abort('failed');return;}
  await route.continue();
 });
 await page.route('**/api/projects/*/agents/stream*',async route=>{
  if(offline){await route.abort('failed');return;}
  await route.continue();
 });
 await addProject(page,'Reload offline fixture');
 nonGet.length=0;
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 const status=page.locator('[data-connection]');
 await expect(status).toHaveAttribute('data-connection','live',{timeout:15000});

 offline=true;
 await page.reload();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(status).toHaveAttribute('data-connection','server-error',{timeout:15000});
 // The failure is named on the connection status; nothing is sent while the view is unusable.
 expect(nonGet).toEqual([]);

 // The network returns. One owner action is one fresh snapshot and one stream subscription, and
 // only a GET is sent. The live state and the fresh transcript are the awaited events.
 offline=false;
 await page.getByRole('button',{name:'Reconnect the agent stream'}).click();
 await expect(status).toHaveAttribute('data-connection','live',{timeout:15000});
 await expect(page.getByLabel('Agent transcript')).toContainText('No messages yet');
 expect(agentGets.length).toBeGreaterThan(0);
 expect(agentGets.some(url=>url.includes('/agents/stream'))).toBe(true);
 expect(nonGet).toEqual([]);
});

test('two tabs keep one subscription each, one send reaches both once, and closing one leaves the other live',async({page,context})=>{
 await addProject(page,'Two tabs fixture');
 const streams=new Map<string,string[]>();
 const posts=new Map<string,number>();
 const watch=(tab:Page,label:string)=>{
  const urls:string[]=[];streams.set(label,urls);posts.set(label,0);
  tab.on('request',request=>{
   if(request.url().includes('/agents/stream'))urls.push(request.url());
   if(request.method()==='POST'&&request.url().includes('/agents/input'))posts.set(label,(posts.get(label)??0)+1);
  });
 };
 watch(page,'first');
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 const first=page.locator('[data-connection]');
 await expect(first).toHaveAttribute('data-connection','live',{timeout:15000});
 const other=await context.newPage();
 watch(other,'second');
 try{
  await other.goto('/');
  await other.getByRole('button',{name:'Agents',exact:true}).click();
  const second=other.locator('[data-connection]');
  await expect(second).toHaveAttribute('data-connection','live',{timeout:15000});
  await expect(page.getByLabel('Agent transcript')).toBeVisible();

  // One view owns one stream. The send and its delivery in both tabs are the awaited events, so
  // the request counts are read after real traffic, not after a fixed sleep.
  await page.getByLabel('Message the agent').fill('one message from the first tab');
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByLabel('Agent transcript')).toContainText('one message from the first tab');
  await expect(other.getByLabel('Agent transcript')).toContainText('one message from the first tab');
  expect(streams.get('first')?.length).toBe(1);
  expect(streams.get('second')?.length).toBe(1);
  expect(posts.get('second')).toBe(0);
  expect(posts.get('first')).toBe(1);

  // Closing the second tab disposes its own subscription on the server; the server test
  // `two live streams hold one subscription each` asserts that disposal count directly. Here the
  // awaited event is the tab's close, then a message that the first tab still receives.
  const closed=new Promise<void>(resolve=>{other.once('close',()=>resolve());});
  await other.close();
  await closed;
  await expect(first).toHaveAttribute('data-connection','live');
  await page.getByLabel('Message the agent').fill('after the other tab closed');
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByLabel('Agent transcript')).toContainText('after the other tab closed');
  await expect(page.getByLabel('Agent transcript')).toContainText('one message from the first tab');
  expect(streams.get('first')?.length).toBe(1);
  expect(posts.get('first')).toBe(2);
 }finally{
  if(!other.isClosed())await other.close();
 }
});

/** A full view the interface could render, used to prove an old response never reaches it. */
const lateView={
 conversationId:'late-a',working:false,attempt:null,
 entries:[{id:'late-entry',kind:'assistant',rawKind:'pi.assistant',at:1,text:'LATE FROM A',thinking:'',tools:[],stopReason:null,error:null,data:null}],
 partial:'',inbox:[],usage:{input:0,output:0,cost:0},model:null,questions:[],updatedAt:'2026-01-01T00:00:00.000Z'
};

test('a held response for the previous session cannot replace the new transcript',async({page})=>{
 await addProject(page,'Rapid switch fixture');
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByLabel('Message the agent')).toBeVisible();
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('live conversation');
 await page.getByRole('button',{name:'New session'}).click();
 await page.getByLabel('New session name').fill('Late A');
 await page.getByRole('button',{name:'Create session'}).click();
 await expect(page.getByText('Created session Late A')).toBeVisible();
 await page.getByRole('button',{name:'New session'}).click();
 await page.getByLabel('New session name').fill('Current B');
 await page.getByRole('button',{name:'Create session'}).click();
 await expect(page.getByText('Created session Current B')).toBeVisible();

 // Hold the first session-scoped stream before it reaches the server. Every later
 // stream, including the one for the session selected next, continues normally.
 let release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 let heldRoute:import('@playwright/test').Route|undefined;
 let first=true;
 await page.route('**/api/projects/*/agents/stream*',async route=>{
  if(first&&route.request().url().includes('sessionId=')){first=false;heldRoute=route;release();return;}
  await route.continue();
 });

 // Open the first session, then switch while its stream is still pending.
 await page.getByRole('button',{name:'Sessions'}).click();
 const list=page.getByLabel('Named sessions');
 await list.getByRole('button',{name:/Late A/}).click();
 await Promise.race([held,page.waitForTimeout(5_000)]);
 expect(heldRoute).toBeTruthy();
 await page.getByRole('button',{name:'Sessions'}).click();
 await list.getByRole('button',{name:/Current B/}).click();
 const status=page.locator('[data-connection]');
 await expect(status).toHaveAttribute('data-connection','live',{timeout:15000});
 const transcript=page.getByLabel('Agent transcript');
 await page.getByLabel('Message the agent').fill('this belongs to B');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(transcript).toContainText('this belongs to B');

 // The aborted request is answered late. It must not replace B's transcript.
 await heldRoute!.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify(lateView)+'\n\n'}).catch(()=>undefined);
 await page.waitForTimeout(500);
 await expect(transcript).not.toContainText('LATE FROM A');
 await expect(transcript).toContainText('this belongs to B');
});

test('a slow first snapshot stays connecting instead of claiming stale',async({page})=>{
 await page.route('**/api/projects/*/agents/stream*',async route=>{
  await new Promise(resolve=>setTimeout(resolve,600));
  await route.continue();
 });
 await addProject(page,'Slow snapshot fixture');
 await observeStates(page);
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByLabel('Message the agent')).toBeVisible();
 await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection','live',{timeout:15000});
 const states=await page.evaluate(()=>(window as unknown as {__connectionStates:string[]}).__connectionStates);
 expect(states).toContain('connecting');
 expect(states).not.toContain('stale');
 expect(states).not.toContain('offline');
});

test('a delayed initial snapshot from the previous session cannot change the new view',async({page})=>{
 await addProject(page,'Stale generation fixture');
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByLabel('Message the agent')).toBeVisible();
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('live conversation');
 await page.getByRole('button',{name:'New session'}).click();
 await page.getByLabel('New session name').fill('Stale A');
 await page.getByRole('button',{name:'Create session'}).click();
 await expect(page.getByText('Created session Stale A')).toBeVisible();
 await page.getByRole('button',{name:'New session'}).click();
 await page.getByLabel('New session name').fill('Fresh B');
 await page.getByRole('button',{name:'Create session'}).click();
 await expect(page.getByText('Created session Fresh B')).toBeVisible();

 // Hold the next initial `/agents` snapshot. It is not abortable, so it will resolve
 // after the switch; only the generation guard can stop it from changing this view.
 let release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 let heldRoute:import('@playwright/test').Route|undefined;
 let heldOnce=false;
 // The view request now names its session, so the query is part of the match as well.
 await page.route(/\/api\/projects\/[^/]+\/agents(\?.*)?$/,async route=>{
  if(!heldOnce){heldOnce=true;heldRoute=route;release();return;}
  await route.continue();
 });

 await page.getByRole('button',{name:'Sessions'}).click();
 const list=page.getByLabel('Named sessions');
 await list.getByRole('button',{name:/Stale A/}).click();
 await Promise.race([held,page.waitForTimeout(5_000)]);
 expect(heldRoute).toBeTruthy();
 await page.getByRole('button',{name:'Sessions'}).click();
 await list.getByRole('button',{name:/Fresh B/}).click();
 await expect(page.locator('[data-connection]')).toHaveAttribute('data-connection','live',{timeout:15000});
 const transcript=page.getByLabel('Agent transcript');
 await page.getByLabel('Message the agent').fill('this belongs to Fresh B');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(transcript).toContainText('this belongs to Fresh B');

 // Release the previous selection's snapshot with a disabled view. Without the
 // generation guard it would replace the enabled state of the new selection.
 await heldRoute!.fulfill({status:200,contentType:'application/json',body:JSON.stringify({enabled:false,view:null})}).catch(()=>undefined);
 await page.waitForTimeout(400);
 await expect(page.getByText('Agents are off here.')).toHaveCount(0);
 await expect(page.getByLabel('Message the agent')).toBeVisible();
 await expect(transcript).toContainText('this belongs to Fresh B');
});
