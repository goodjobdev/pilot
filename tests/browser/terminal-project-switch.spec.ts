import {test,expect,type Page} from '@playwright/test';

type WindowWithTerminalSockets=Window&{__terminalTestSockets?:{closeCalls:number;readyState:number;sentMessages:string[];closeFromServer:()=>void}[]};
const idA='a1111111-1111-4111-8111-111111111111';
const idB='b1111111-1111-4111-8111-111111111111';
const createdId='c1111111-1111-4111-8111-111111111111';

async function addProject(page:Page,name:string):Promise<{id:string}> {
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill(name);
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await expect(page.getByRole('heading',{name})).toBeVisible();
 return await page.evaluate(async name=>{
  const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')?.content??'';
  const projects=await (await fetch('/api/projects',{headers:{'x-dashboard-token':token}})).json() as {id:string;name:string}[];
  return projects.find(project=>project.name===name)!;
 },name);
}
async function installSocketSpy(page:Page):Promise<void> {
 await page.addInitScript(()=>{
  const sockets:FakeSocket[]=[];
  Object.defineProperty(window,'__terminalTestSockets',{value:sockets});
  class FakeSocket {
   static readonly CONNECTING=0;static readonly OPEN=1;static readonly CLOSING=2;static readonly CLOSED=3;
   readyState=FakeSocket.CONNECTING;closeCalls=0;sentMessages:string[]=[];
   onopen:((event:Event)=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;
   onerror:((event:Event)=>void)|null=null;onclose:((event:CloseEvent)=>void)|null=null;
   constructor(_url:string|URL,_protocols?:string|string[]){sockets.push(this);setTimeout(()=>{this.readyState=FakeSocket.OPEN;this.onopen?.(new Event('open'));},0);}
   send(data:string):void{this.sentMessages.push(data);}
   close():void{this.closeCalls++;this.readyState=FakeSocket.CLOSED;this.onclose?.(new CloseEvent('close'));}
   closeFromServer():void{this.readyState=FakeSocket.CLOSED;this.onclose?.(new CloseEvent('close'));}
  }
  Object.defineProperty(window,'WebSocket',{value:FakeSocket,configurable:true});
 });
}
async function setupProjects(page:Page):Promise<{projectA:{id:string};projectB:{id:string}}> {
 await page.goto('/');
 const projectA=await addProject(page,'Terminal project A');
 const projectB=await addProject(page,'Terminal project B');
 await page.evaluate(({id})=>localStorage.setItem('dashboard.filters.'+id,JSON.stringify({search:'',domain:'all',status:'all',scope:'all',view:'Terminal'})),projectB);
 return {projectA,projectB};
}
async function selectProject(page:Page,name:string):Promise<void> {
 await page.getByRole('navigation',{name:'Projects'}).getByRole('button',{name:new RegExp(name)}).first().click();
}
function listFor(projectId:string,id:string,name:string){return {terminals:[{id,projectId,projectName:name,cwd:'/tmp/'+name,createdAt:'2026-11-16T00:00:00.000Z',connected:false}]};}
function socketCount(page:Page){return page.evaluate(()=>((window as WindowWithTerminalSockets).__terminalTestSockets??[]).length);}

test('switching projects while Terminal is selected detaches the old project session',async({page})=>{
 await installSocketSpy(page);
 const {projectA,projectB}=await setupProjects(page);
 await page.route('**/api/projects/*/terminals',async route=>{
  const projectId=new URL(route.request().url()).pathname.split('/')[3];
  if(route.request().method()!=='GET')return route.continue();
  return route.fulfill({json:projectId===projectA.id?listFor(projectA.id,idA,'Terminal project A'):listFor(projectB.id,idB,'Terminal project B')});
 });
 await page.route('**/api/terminals/*/ticket',route=>route.fulfill({json:{ticket:'disposable-terminal-ticket'}}));
 await selectProject(page,'Terminal project A');
 await page.getByRole('button',{name:'Terminal',exact:true}).click();
 const terminalList=page.getByLabel('Existing terminal');
 await expect(terminalList.locator('option',{hasText:'Terminal project A'})).toHaveCount(1);
 await terminalList.selectOption(idA);
 await expect(page.getByRole('status')).toContainText('Connected');
 await expect.poll(()=>socketCount(page)).toBe(1);

 await selectProject(page,'Terminal project B');
 await expect(terminalList.locator('option',{hasText:'Terminal project B'})).toHaveCount(1);
 await expect(terminalList.locator('option',{hasText:'Terminal project A'})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>((window as WindowWithTerminalSockets).__terminalTestSockets?.[0]?.closeCalls??0))).toBe(1);
});

test('late terminal creation after switching projects is closed and never attached',async({page})=>{
 await installSocketSpy(page);
 const {projectA,projectB}=await setupProjects(page);
 let releaseCreate!:()=>void,signalCreate!:()=>void;
 const createGate=new Promise<void>(resolve=>releaseCreate=resolve);
 const createStarted=new Promise<void>(resolve=>signalCreate=resolve);
 const closed:string[]=[];
 await page.route('**/api/projects/*/terminals',async route=>{
  const projectId=new URL(route.request().url()).pathname.split('/')[3];
  if(route.request().method()==='GET')return route.fulfill({json:{terminals:projectId===projectA.id?[]:listFor(projectB.id,idB,'Terminal project B').terminals}});
  if(projectId!==projectA.id)return route.continue();
  signalCreate();
  await createGate;
  return route.fulfill({json:{terminal:{id:createdId,projectId:projectA.id,projectName:'Terminal project A',cwd:'/tmp/Terminal project A',createdAt:'2026-11-16T00:00:00.000Z',connected:false}}});
 });
 await page.route('**/api/terminals/*',async route=>{
  if(route.request().method()!=='DELETE')return route.continue();
  closed.push(new URL(route.request().url()).pathname.split('/')[3]);
  return route.fulfill({json:{closed:true}});
 });
 await page.route('**/api/terminals/*/ticket',route=>route.fulfill({json:{ticket:'unused-ticket'}}));
 await selectProject(page,'Terminal project A');
 await page.getByRole('button',{name:'Terminal',exact:true}).click();
 await page.getByRole('button',{name:'New terminal'}).click();
 await createStarted;
 await selectProject(page,'Terminal project B');
 await expect(page.getByLabel('Existing terminal').locator('option',{hasText:'Terminal project B'})).toHaveCount(1);
 releaseCreate();
 await expect.poll(()=>closed.length).toBe(1);
 expect(closed).toEqual([createdId]);
 await expect.poll(()=>socketCount(page)).toBe(0);
});

test('switching projects during a new terminal ticket request closes the new session and skips socket attach',async({page})=>{
 await installSocketSpy(page);
 const {projectA,projectB}=await setupProjects(page);
 let signalTicket!:()=>void,releaseTicket!:()=>void;
 const ticketStarted=new Promise<void>(resolve=>signalTicket=resolve);
 const ticketGate=new Promise<void>(resolve=>releaseTicket=resolve);
 const closed:string[]=[];
 await page.route('**/api/projects/*/terminals',async route=>{
  const projectId=new URL(route.request().url()).pathname.split('/')[3];
  if(route.request().method()==='GET')return route.fulfill({json:{terminals:projectId===projectA.id?[]:listFor(projectB.id,idB,'Terminal project B').terminals}});
  if(projectId!==projectA.id)return route.continue();
  return route.fulfill({json:{terminal:{id:createdId,projectId:projectA.id,projectName:'Terminal project A',cwd:'/tmp/Terminal project A',createdAt:'2026-11-16T00:00:00.000Z',connected:false}}});
 });
 await page.route('**/api/terminals/*/ticket',async route=>{
  if(new URL(route.request().url()).pathname.split('/')[3]!==createdId)return route.continue();
  signalTicket();
  await ticketGate;
  return route.fulfill({json:{ticket:'late-ticket'}});
 });
 await page.route('**/api/terminals/*',async route=>{
  if(route.request().method()!=='DELETE')return route.continue();
  closed.push(new URL(route.request().url()).pathname.split('/')[3]);
  return route.fulfill({json:{closed:true}});
 });
 await selectProject(page,'Terminal project A');
 await page.getByRole('button',{name:'Terminal',exact:true}).click();
 await page.getByRole('button',{name:'New terminal'}).click();
 await ticketStarted;
 await selectProject(page,'Terminal project B');
 await expect(page.getByLabel('Existing terminal').locator('option',{hasText:'Terminal project B'})).toHaveCount(1);
 await expect.poll(()=>closed.length).toBe(1);
 expect(closed).toEqual([createdId]);
 releaseTicket();
 await expect.poll(()=>socketCount(page)).toBe(0);
 await expect(page.getByLabel('Existing terminal').locator('option',{hasText:'Terminal project A'})).toHaveCount(0);
});

test('rejecting a connected session preserves the active socket callbacks',async({page})=>{
 await installSocketSpy(page);
 const {projectA}=await setupProjects(page);
 const ticketIds:string[]=[];
 await page.route('**/api/projects/*/terminals',async route=>route.fulfill({json:{terminals:[
  {id:idA,projectId:projectA.id,projectName:'Terminal project A',cwd:'/tmp/active',createdAt:'2026-11-16T00:00:00.000Z',connected:false},
  {id:idB,projectId:projectA.id,projectName:'Terminal project A',cwd:'/tmp/connected',createdAt:'2026-11-16T00:00:01.000Z',connected:true}
 ]}}));
 await page.route('**/api/terminals/*/ticket',route=>{ticketIds.push(new URL(route.request().url()).pathname.split('/')[3]);return route.fulfill({json:{ticket:'disposable-terminal-ticket'}});});
 await selectProject(page,'Terminal project A');
 await page.getByRole('button',{name:'Terminal',exact:true}).click();
 const terminalList=page.getByLabel('Existing terminal');
 await expect(terminalList.locator('option[value="'+idA+'"]')).toHaveCount(1);
 await expect(terminalList.locator('option[value="'+idB+'"]')).toHaveCount(1);
 await terminalList.selectOption(idA);
 await expect(page.getByRole('status')).toContainText('Connected');
 await terminalList.selectOption(idB);
 await expect(page.getByRole('alert')).toContainText('already has a browser attached');
 await expect.poll(()=>page.evaluate(()=>((window as WindowWithTerminalSockets).__terminalTestSockets?.[0]?.readyState))).toBe(1);
 await expect.poll(()=>page.evaluate(()=>((window as WindowWithTerminalSockets).__terminalTestSockets?.[0]?.closeCalls))).toBe(0);
 expect(ticketIds).toEqual([idA]);

 await page.evaluate(()=>((window as WindowWithTerminalSockets).__terminalTestSockets?.[0]?.closeFromServer?.()));
 await expect(page.getByRole('status')).toHaveText('Disconnected');
});
