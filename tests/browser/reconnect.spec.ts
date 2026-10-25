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
