import {test,expect,type Page} from '@playwright/test';

/**
 * The phone Back stack, direct routes and the bottom controls.
 *
 * Every view and every layer above it is one history entry, so Back closes the newest layer and
 * leaves the application only after the route under it. Forward restores the entry. The address
 * carries the route (project, view, document, session) so a direct link and a reload open the same
 * route; layers stay in history state. The composer, Send, Steer, Stop and Add image stay in normal
 * flow with the bottom safe-area inset, so a short screen scrolls to them instead of covering the
 * transcript. Every scenario uses the scripted provider: no model is called and nothing is spent.
 */

async function addProject(page:Page,name:string){
 await page.goto('/');
 const show=page.getByRole('button',{name:'Show project sidebar'});
 if(await show.isVisible().catch(()=>false))await show.click();
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill(name);
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await expect(page.getByRole('heading',{name})).toBeVisible();
 const hide=page.getByRole('button',{name:'Hide project sidebar'});
 if(await hide.isVisible().catch(()=>false))await hide.click();
}

async function createDoc(page:Page,path:string,title:string){
 await page.getByRole('button',{name:'Doc',exact:true}).click();
 page.once('dialog',dialog=>void dialog.accept(path));
 await page.getByRole('button',{name:'New page',exact:true}).click();
 await page.getByLabel('Document body').fill('# '+title+'\n\nThe intent for this flow.');
 await page.getByRole('button',{name:'Save document',exact:true}).click();
 await expect(page.locator('.doc-body h1')).toHaveText(title);
}

async function openAgents(page:Page){
 await page.getByRole('button',{name:'Session',exact:true}).click();
 await expect(page.getByLabel('Message the agent')).toBeVisible();
}

async function createSession(page:Page,name:string){
 await page.getByRole('button',{name:'New session',exact:true}).click();
 await page.getByLabel('New session name').fill(name);
 await page.getByRole('button',{name:'Create session'}).click();
 await expect(page.getByText('Created session '+name+'.')).toBeVisible();
}

async function openSession(page:Page,name:string){
 await page.getByRole('button',{name:'Sessions',exact:true}).click();
 const list=page.getByLabel('Named sessions');
 await expect(list).toContainText(name);
 await list.locator('.session-row').filter({hasText:name}).click();
 await expect(page.getByLabel('Named sessions')).toHaveCount(0);
}

async function fixtureIds(page:Page,projectName:string){
 return page.evaluate(async (name)=>{
  const token=(document.querySelector('meta[name="dashboard-token"]') as HTMLMetaElement).content;
  const headers={'X-Dashboard-Token':token};
  const projects=await (await fetch('/api/projects',{headers})).json() as {id:string;name:string}[];
  const project=projects.find(candidate=>candidate.name===name)!;
  const listed=await (await fetch('/api/sessions?projectId='+encodeURIComponent(project.id),{headers})).json() as {sessions:{id:string;name:string}[]};
  return {project:project.id,sessions:listed.sessions};
 },projectName);
}

const marker=async(page:Page)=>page.evaluate(()=>((window as unknown as {__navMarker?:string}).__navMarker));

test('on a phone, Back closes the newest layer one at a time and only then leaves the app',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 // A real previous page, so leaving the app is observable rather than the end of history.
 await page.goto('/healthz');
 await addProject(page,'Back stack fixture');
 const fixture=await fixtureIds(page,'Back stack fixture');
 // Start from a page outside the app, then the fixture's own route, so the entry under the app
 // is deterministic even when earlier tests registered projects. One Back from the base leaves.
 await page.goto('/healthz');
 await page.goto('/?project='+fixture.project+'&view=List');
 await expect(page.getByRole('button',{name:'Task',exact:true})).toHaveClass(/active/);

 // The document tree is its own layer above the Wiki view.
 await page.getByRole('button',{name:'Doc',exact:true}).click();
 await expect(page.locator('.wiki-tree')).toHaveClass(/open/);
 await page.goBack();
 await expect(page.locator('.wiki-tree')).not.toHaveClass(/open/);
 await expect(page.getByRole('button',{name:'Doc',exact:true})).toHaveClass(/active/);
 await page.goForward();
 await expect(page.locator('.wiki-tree')).toHaveClass(/open/);

 await createDoc(page,'docs/alpha.md','Alpha');
 await page.evaluate(()=>{(window as unknown as {__navMarker?:string}).__navMarker='alive';});
 const writes:string[]=[];
 page.on('request',request=>{
  if(request.method()==='GET')return;
  const path=new URL(request.url()).pathname;
  if(path.startsWith('/api/'))writes.push(request.method()+' '+path);
 });

 // The dialog is the newest layer; the document is under it.
 await page.getByRole('button',{name:'Agents and privileges'}).click();
 await expect(page.getByRole('dialog')).toBeVisible();

 await page.goBack();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.locator('.doc-body h1')).toHaveText('Alpha');
 expect(await marker(page)).toBe('alive');

 await page.goBack();
 await expect(page.locator('.doc-body h1')).toHaveCount(0);
 // Opening the document closed the tree, so the entry under it is the Wiki view.
 await expect(page.getByRole('button',{name:'Doc',exact:true})).toHaveClass(/active/);
 expect(await marker(page)).toBe('alive');

 await page.goBack();
 await expect(page.getByRole('button',{name:'Task',exact:true})).toHaveClass(/active/);
 expect(await marker(page)).toBe('alive');
 // Traversing the stack sends no write: Back and Forward are reads of committed state only.
 expect(writes).toEqual([]);

 // No layer is left, so this Back is the browser's own and leaves the application.
 await page.goBack();
 await page.waitForURL(/\/healthz$/);
});

test('Android-style history.back closes the same layers, restores Forward, and never loops',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto('/healthz');
 await addProject(page,'Android back fixture');
 await createDoc(page,'docs/beta.md','Beta');
 await page.evaluate(()=>{
  const state=window as unknown as {__pops?:number;__navMarker?:string};
  state.__pops=0;state.__navMarker='alive';
  window.addEventListener('popstate',()=>{state.__pops=(state.__pops??0)+1;});
 });

 // The Android browser Back button is a history traversal, not a click.
 await page.evaluate(()=>history.back());
 await expect(page.locator('.doc-body h1')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Doc',exact:true})).toHaveClass(/active/);
 expect(await page.evaluate(()=>((window as unknown as {__pops?:number}).__pops))).toBe(1);
 expect(await marker(page)).toBe('alive');

 await page.evaluate(()=>history.back());
 await expect(page.getByRole('button',{name:'Task',exact:true})).toHaveClass(/active/);
 expect(await page.evaluate(()=>((window as unknown as {__pops?:number}).__pops))).toBe(2);
 expect(await marker(page)).toBe('alive');

 // Forward returns to the same layers, in order, without a reload.
 await page.goForward();
 await expect(page.getByRole('button',{name:'Doc',exact:true})).toHaveClass(/active/);
 await page.goForward();
 await expect(page.locator('.doc-body h1')).toHaveText('Beta');
 // Two Backs and two Forwards are four traversals, one popstate each. A loop would add more.
 expect(await page.evaluate(()=>((window as unknown as {__pops?:number}).__pops))).toBe(4);
 expect(await marker(page)).toBe('alive');
});

test('menus, sessions and documents each take their own history entry',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await addProject(page,'Back transitions fixture');
 await openAgents(page);

 // A menu above the Agents view closes on Back without changing the view.
 await page.getByRole('button',{name:'Board actions',exact:true}).click();
 await expect(page.getByRole('group',{name:'Board actions',exact:true})).toBeVisible();
 await page.goBack();
 await expect(page.getByRole('group',{name:'Board actions',exact:true})).toBeHidden();
 await expect(page.getByRole('button',{name:'Session',exact:true})).toHaveClass(/active/);

 // Sessions: choosing one is a route, and Back returns to the previous session.
 await createSession(page,'Alpha');
 await createSession(page,'Beta');
 await openSession(page,'Beta');
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Beta');
 await openSession(page,'Alpha');
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Alpha');

 await page.goBack();
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Beta');
 await page.goForward();
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Alpha');

 // Documents: Back closes the open document; Forward restores it.
 await createDoc(page,'docs/gamma.md','Gamma');
 await page.goBack();
 await expect(page.locator('.doc-body h1')).toHaveCount(0);
 await page.goForward();
 await expect(page.locator('.doc-body h1')).toHaveText('Gamma');
});

test('a direct session or document link opens its route, and an unknown one falls back to the list',async({page})=>{
 await addProject(page,'Direct entry fixture');
 await openAgents(page);
 await createSession(page,'Linked session');
 await createDoc(page,'docs/linked.md','Linked');
 const ids=await fixtureIds(page,'Direct entry fixture');
 const session=ids.sessions.find(candidate=>candidate.name==='Linked session')!;
 expect(session).toBeTruthy();

 await page.goto('/?project='+ids.project+'&view=Agents&session='+encodeURIComponent(session.id));
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Linked session');
 await expect(page.getByLabel('Message the agent')).toBeVisible();

 // A reload on the session route shows the same session.
 await page.reload();
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Linked session');

 // A direct document link opens the document.
 await page.goto('/?project='+ids.project+'&view=Wiki&doc='+encodeURIComponent('docs/linked.md'));
 await expect(page.locator('.doc-body h1')).toHaveText('Linked');

 // An unknown session opens the project's root conversation and the named-session list, and the
 // bad id is removed from the address rather than left as an unsupported deep link.
 await page.goto('/?project='+ids.project+'&view=Agents&session=missing-session');
 await expect(page.getByLabel('Named sessions')).toBeVisible();
 await expect(page.getByText(/not in this project/)).toBeVisible();
 await expect.poll(()=>new URL(page.url()).searchParams.get('session')).toBeNull();
 await expect(page.getByRole('button',{name:'Session',exact:true})).toHaveClass(/active/);
 // A very long untrusted id is not echoed into the interface.
 const longId='x'.repeat(400);
 await page.goto('/?project='+ids.project+'&view=Agents&session='+longId);
 await expect(page.getByText(/not in this project/)).toBeVisible();
 expect((await page.getByText(/not in this project/).innerText()).length).toBeLessThan(160);
 expect(await page.getByText(longId).count()).toBe(0);

 // The injected list has its own entry: closing it in the app keeps the app, and one Back returns
 // to the route before this link rather than leaving the page.
 await page.getByRole('button',{name:'Sessions',exact:true}).click();
 await expect(page.getByLabel('Named sessions')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Session',exact:true})).toHaveClass(/active/);
 expect(new URL(page.url()).pathname).toBe('/');
 await page.goBack();
 expect(new URL(page.url()).pathname).toBe('/');
 await expect(page.getByRole('heading',{name:'Direct entry fixture'})).toBeVisible();

 // A remembered session the project no longer has also opens the list; closing it keeps the app.
 await page.evaluate((project)=>{
  localStorage.setItem('pilot.session.v1:'+project,'missing-remembered');
 },ids.project);
 await page.goto('/?project='+ids.project+'&view=Agents');
 await expect(page.getByLabel('Named sessions')).toBeVisible();
 await expect(page.getByText(/not in this project/)).toBeVisible();
 await page.getByRole('button',{name:'Sessions',exact:true}).click();
 await expect(page.getByLabel('Named sessions')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Session',exact:true})).toHaveClass(/active/);
 await expect.poll(()=>new URL(page.url()).searchParams.get('session')).toBeNull();

 // An unknown project shows an explicit error and selects nothing. It never silently opens the
 // remembered project, so no edit can be sent to the wrong project.
 const writes:string[]=[];
 page.on('request',request=>{if(request.method()!=='GET')writes.push(request.method()+' '+new URL(request.url()).pathname);});
 await page.goto('/?project=missing-project&view=List');
 await expect(page.getByRole('alert')).toContainText(/not registered/);
 await expect(page.getByRole('heading',{name:'Direct entry fixture'})).toHaveCount(0);
 await expect(page.getByRole('heading',{level:1,name:'Pilot'})).toBeVisible();
 await expect.poll(()=>new URL(page.url()).searchParams.get('project')).toBeNull();
 expect(writes).toEqual([]);
 // The sidebar is the explicit selection path.
 await page.getByRole('button',{name:'Show project sidebar'}).click();
 await page.getByRole('navigation',{name:'Projects'}).getByRole('button',{name:/Direct entry fixture/}).click();
 await expect(page.getByRole('heading',{name:'Direct entry fixture'})).toBeVisible();
});

test('a short phone viewport keeps the primary controls reachable in normal flow, above the safe area',async({page})=>{
 await page.setViewportSize({width:390,height:420});
 await addProject(page,'Short controls fixture');
 await openAgents(page);
 await page.getByLabel('Message the agent').fill('a draft that stays');
 // A real phone reports a bottom inset; setting the token proves the padding uses it.
 await page.evaluate(()=>document.documentElement.style.setProperty('--safe-bottom','24px'));
 await page.locator('.agents').evaluate(element=>{element.scrollTop=element.scrollHeight;});

 const geometry=await page.evaluate(()=>{
  const rect=(selector:string)=>{
   const element=document.querySelector(selector) as HTMLElement|null;
   if(!element)return null;
   const box=element.getBoundingClientRect();
   return {x:box.x,y:box.y,w:box.width,h:box.height,bottom:box.bottom,right:box.right};
  };
  const section=document.querySelector('.agents') as HTMLElement;
  const composer=document.querySelector('.agent-composer') as HTMLElement;
  const style=getComputedStyle(composer);
  return {
   viewport:{w:innerWidth,h:innerHeight},
   section:{clientHeight:section.clientHeight,scrollHeight:section.scrollHeight,scrollTop:section.scrollTop},
   transcript:rect('.agent-transcript'),
   composer:rect('.agent-composer'),
   send:rect('[aria-label="Send message"]'),
   steer:rect('[aria-label="Steer the run"]'),
   stop:rect('[aria-label="Stop the agent"]'),
   attach:rect('.image-pick'),
   attention:rect('[aria-label^="Needs me"]'),
   position:style.position,
   bottomInset:parseFloat(style.paddingBottom)+parseFloat(style.marginBottom),
  };
 });
 const inside=(box:{x:number;y:number;w:number;h:number}|null)=>Boolean(box&&box.w>0&&box.h>0&&box.y>=0&&box.x>=0&&box.y+box.h<=geometry.viewport.h&&box.x+box.w<=geometry.viewport.w);

 // The section scrolls in normal flow; the composer is not docked over the transcript.
 expect(geometry.section.scrollHeight).toBeGreaterThan(geometry.section.clientHeight);
 expect(geometry.position).toBe('static');
 expect(geometry.transcript!.y+geometry.transcript!.h).toBeLessThanOrEqual(geometry.composer!.y+0.5);
 expect(geometry.transcript!.h).toBeGreaterThanOrEqual(160);
 expect(geometry.bottomInset).toBeGreaterThanOrEqual(24);
 expect(geometry.stop).toBeNull();
 expect(geometry.steer).toBeNull();
 for(const [name,box] of Object.entries({send:geometry.send,attach:geometry.attach})){
  expect(inside(box),name+' is reachable inside the short viewport').toBe(true);
 }
 // The attention entry stays in the application bar, visible above the section.
 expect(inside(geometry.attention)).toBe(true);
 await expect(page.getByLabel('Message the agent')).toHaveValue('a draft that stays');
 // During a run, both controls must remain reachable on the same short screen.
 await page.getByLabel('Message the agent').fill('[pause] short viewport run');
 await page.getByRole('button',{name:'Send message'}).click();
 const stop=page.getByRole('button',{name:'Stop the agent'});
 const steer=page.getByRole('button',{name:'Steer the run'});
 await expect(stop).toBeVisible();
 await expect(steer).toBeVisible();
 await stop.scrollIntoViewIfNeeded();
 await expect(stop).toBeInViewport();
 await steer.scrollIntoViewIfNeeded();
 await expect(steer).toBeInViewport();
 await stop.click();
 await expect(stop).toHaveCount(0);
});

test('a session’s draft survives Back, Forward and a reload',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await addProject(page,'Draft backstack fixture');
 await openAgents(page);
 const composer=page.getByLabel('Message the agent');

 await composer.fill('root draft');
 await createSession(page,'Alpha');
 await openSession(page,'Alpha');
 await composer.fill('alpha draft');
 await createSession(page,'Beta');
 await openSession(page,'Beta');
 await composer.fill('beta draft');

 await openSession(page,'Alpha');
 await expect(composer).toHaveValue('alpha draft');
 await page.goBack();
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Beta');
 await expect(composer).toHaveValue('beta draft');
 await page.goForward();
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Alpha');
 await expect(composer).toHaveValue('alpha draft');

 await page.reload();
 await expect(page.getByRole('region',{name:'Session',exact:true})).toContainText('Alpha');
 await expect(composer).toHaveValue('alpha draft');
 expect(new URL(page.url()).searchParams.get('session')).toBeTruthy();
});

test('Back asks before it discards unsaved document text, and the text survives a refusal',async({page})=>{
 await addProject(page,'Dirty document fixture');
 await createDoc(page,'docs/dirty.md','Dirty');
 await page.getByRole('button',{name:'Edit document'}).click();
 const body=page.getByLabel('Document body');
 await body.fill('# Dirty\n\nunsaved change');

 let asked=0;
 page.once('dialog',async dialog=>{asked+=1;await dialog.dismiss();});
 await page.goBack();
 await expect(body).toHaveValue(/unsaved change/);
 expect(asked).toBe(1);

 page.once('dialog',async dialog=>{asked+=1;await dialog.accept();});
 await page.goBack();
 await expect(page.getByLabel('Document body')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Doc',exact:true})).toHaveClass(/active/);
 expect(asked).toBe(2);

 // Forward reopens the document. The unsubmitted editor text is not restored: only the route is.
 await page.goForward();
 await expect(page.locator('.doc-body h1')).toHaveText('Dirty');
});

test('a direct document link writes one entry before its read, keeps the address when the read fails, and one Back leaves',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await addProject(page,'Doc entry fixture');
 await createDoc(page,'docs/slow.md','Slow');
 const ids=await fixtureIds(page,'Doc entry fixture');

 // A real page behind the app makes leaving observable.
 await page.goto('/healthz');
 const before=await page.evaluate(()=>history.length);
 await page.route('**/api/projects/'+ids.project+'/docs/document*',async route=>{
  await new Promise(resolve=>setTimeout(resolve,700));
  await route.continue();
 });
 await page.goto('/?project='+ids.project+'&view=Wiki&doc='+encodeURIComponent('docs/slow.md'));
 // The requested address is kept from the first frame, while the read is still pending.
 await expect.poll(()=>new URL(page.url()).searchParams.get('doc')).toBe('docs/slow.md');
 await expect(page.locator('.doc-body h1')).toHaveText('Slow',{timeout:15000});
 // The route was written once, in place; the document did not add a second entry.
 expect(await page.evaluate(()=>history.length)).toBe(before+1);
 await page.goBack();
 await page.waitForURL(/\/healthz$/);

 // A document the store refuses keeps the requested address and announces the failure.
 await page.goto('/?project='+ids.project+'&view=Wiki&doc='+encodeURIComponent('docs/missing.md'));
 await expect.poll(()=>new URL(page.url()).searchParams.get('doc')).toBe('docs/missing.md');
 const failure=page.locator('.error.doc-message');
 await expect(failure).toHaveAttribute('role','alert');
 await expect(failure).toBeVisible();
 await expect(page.getByRole('button',{name:'Doc',exact:true})).toHaveClass(/active/);
 // One Back leaves this single route entry.
 await page.goBack();
 await page.waitForURL(/\/healthz$/);
});

test('a pushed alert asks before it discards unsaved document text, and a refusal changes nothing',async({page})=>{
 await page.addInitScript(()=>{
  const listeners=new Set<(event:MessageEvent)=>void>();
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{
   addEventListener:(type:string,listener:(event:MessageEvent)=>void)=>{if(type==='message')listeners.add(listener);},
   removeEventListener:(type:string,listener:(event:MessageEvent)=>void)=>{listeners.delete(listener);},
   getRegistration:async()=>undefined,
   register:async()=>{throw new Error('not used');},
  }});
  Object.defineProperty(window,'PushManager',{configurable:true,value:class PushManager {}});
  Object.defineProperty(window,'Notification',{configurable:true,value:{permission:'denied'}});
  (window as unknown as {__pushAlert:(url:string)=>void}).__pushAlert=(url)=>{
   for(const listener of listeners)listener({data:{type:'dashboard-alert',url}} as MessageEvent);
  };
 });

 await addProject(page,'Alert guard A');
 await createDoc(page,'docs/guard.md','Guard');
 const a=await fixtureIds(page,'Alert guard A');
 await addProject(page,'Alert guard B');
 const b=await fixtureIds(page,'Alert guard B');
 expect(a.project).not.toBe(b.project);

 await page.goto('/?project='+a.project+'&view=Wiki&doc='+encodeURIComponent('docs/guard.md'));
 await expect(page.locator('.doc-body h1')).toHaveText('Guard');
 await page.getByRole('button',{name:'Edit document'}).click();
 const body=page.getByLabel('Document body');
 await body.fill('# Guard\n\nunsaved work');

 const before=await page.evaluate(()=>({length:history.length,url:location.href}));
 let asked=0;
 page.once('dialog',async dialog=>{asked+=1;await dialog.dismiss();});
 await page.evaluate(project=>{(window as unknown as {__pushAlert:(url:string)=>void}).__pushAlert('/?project='+project+'&view=List');},b.project);
 await expect(body).toHaveValue(/unsaved work/);
 expect(asked).toBe(1);
 expect(await page.getByRole('heading',{name:'Alert guard A'}).isVisible()).toBe(true);
 expect(await page.evaluate(()=>({length:history.length,url:location.href}))).toEqual(before);

 // The same alert with consent leaves the document and the project.
 page.once('dialog',async dialog=>{asked+=1;await dialog.accept();});
 await page.evaluate(project=>{(window as unknown as {__pushAlert:(url:string)=>void}).__pushAlert('/?project='+project+'&view=List');},b.project);
 await expect(page.getByRole('heading',{name:'Alert guard B'})).toBeVisible();
 expect(asked).toBe(2);
});

test('a layer opened while a Back apply waits is kept after that entry settles',async({page})=>{
 await addProject(page,'Apply intent A');
 const a=await fixtureIds(page,'Apply intent A');
 await addProject(page,'Apply intent B');
 await page.getByRole('button',{name:'Show project sidebar'}).click();
 await page.getByRole('navigation',{name:'Projects'}).getByRole('button',{name:/Apply intent A/}).click();
 await expect(page.getByRole('heading',{name:'Apply intent A'})).toBeVisible();
 await page.getByRole('navigation',{name:'Projects'}).getByRole('button',{name:/Apply intent B/}).click();
 await expect(page.getByRole('heading',{name:'Apply intent B'})).toBeVisible();

 // The Back to A waits for its board. A dialog opened in that window is the person's intent.
 await page.route('**/api/projects/'+a.project+'/board',async route=>{
  await new Promise(resolve=>setTimeout(resolve,800));
  await route.continue();
 });
 await page.goBack();
 await page.getByRole('button',{name:'Agents and privileges'}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await expect(page.getByRole('heading',{name:'Apply intent A'})).toBeVisible({timeout:12000});
 await expect(page.getByRole('dialog')).toBeVisible();
 await page.getByRole('button',{name:'Close agent manager'}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Apply intent A'})).toBeVisible();
});

test('a foreign history entry under a layer is re-anchored, and the app stays after the close',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto('/healthz');
 await addProject(page,'Foreign entry fixture');
 const fixture=await fixtureIds(page,'Foreign entry fixture');
 await page.goto('/healthz');
 await page.goto('/?project='+fixture.project+'&view=List');
 await expect(page.getByRole('button',{name:'Task',exact:true})).toHaveClass(/active/);

 // A script on the page writes an entry this stack did not create, then the person opens a layer.
 await page.evaluate(()=>history.pushState({foreign:true},'',location.pathname+'?foreign=1'));
 await page.getByRole('button',{name:'Agents and privileges'}).click();
 await expect(page.getByRole('dialog')).toBeVisible();

 // Closing the layer in the app stops at the foreign entry, rewrites it to what the app shows,
 // and never leaves the page.
 await page.getByRole('button',{name:'Close agent manager'}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Foreign entry fixture'})).toBeVisible();
 expect(new URL(page.url()).searchParams.get('foreign')).toBeNull();
 expect(new URL(page.url()).pathname).toBe('/');

 // One Back may land on the app's own base entry (a no-op); the next leaves the app.
 await page.goBack();
 await expect(page.getByRole('heading',{name:'Foreign entry fixture'})).toBeVisible();
 expect(new URL(page.url()).pathname).toBe('/');
 await page.goBack();
 await page.waitForURL(/\/healthz$/);
});

test('an entry from an earlier page load stays readable but is not this load’s own',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto('/healthz');
 await addProject(page,'Earlier load fixture');
 const ids=await fixtureIds(page,'Earlier load fixture');
 await page.goto('/healthz');
 await page.goto('/?project='+ids.project+'&view=List');
 await expect(page.getByRole('button',{name:'Task',exact:true})).toHaveClass(/active/);
 await page.getByRole('button',{name:'Doc',exact:true}).click();
 await expect(page.locator('.wiki-tree')).toHaveClass(/open/);
 // Close the tree so the current entry is the Wiki route itself; the List entry is below it.
 await page.getByRole('button',{name:'Hide documents'}).click();
 await expect(page.locator('.wiki-tree')).not.toHaveClass(/open/);

 // The reload gives this page load a new nonce. The List entry below is from the earlier load.
 await page.reload();
 await expect(page.getByRole('button',{name:'Doc',exact:true})).toHaveClass(/active/);
 await page.goBack();
 await expect(page.getByRole('button',{name:'Task',exact:true})).toHaveClass(/active/);
 expect(new URL(page.url()).searchParams.get('view')).toBe('List');

 // A layer opened now and closed in the app does not walk into the earlier entry.
 await page.getByRole('button',{name:'Board actions',exact:true}).click();
 const commands=page.getByRole('group',{name:'Board actions',exact:true});
 await expect(commands).toBeVisible();
 await page.getByRole('button',{name:'Board actions',exact:true}).click();
 await expect(commands).toBeHidden();
 await expect(page.getByRole('button',{name:'Task',exact:true})).toHaveClass(/active/);
 expect(new URL(page.url()).pathname).toBe('/');

 // The next Back leaves for the page before the earlier entry.
 await page.goBack();
 await page.waitForURL(/\/healthz$/);
});
