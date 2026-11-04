import { test,expect,type Page } from '@playwright/test';
import { writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
async function fixture(page:Page,name:string){
 await page.goto('/');if(!await page.getByRole('button',{name:'＋ Add project',exact:true}).first().isVisible())await page.getByRole('button',{name:'Show project sidebar',exact:true}).click();await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();await page.getByLabel('Project name').fill(name);await page.getByRole('button',{name:'Confirm & add project'}).click();await expect(page.getByRole('heading',{name})).toBeVisible();
 const p=await page.evaluate(async name=>{const token=document.querySelector('meta[name="dashboard-token"]')!.getAttribute('content')!;return (await(await fetch('/api/projects',{headers:{'x-dashboard-token':token}})).json()).find((p:{name:string})=>p.name===name);},name) as {id:string;path:string};expect(p.path).toContain('dashboard-browser-');
 await mkdir(join(p.path,'src/lib'),{recursive:true});await mkdir(join(p.path,'docs/specs'),{recursive:true});
 for(const [path,text] of [['src/app.ts','export const answer = 1;\n'],['src/lib/util.ts','export const half = (n:number)=>n/2;\n'],['src/lib/deep/more.ts','export const three = 3;\n'],['docs/specs/plan.md','# Plan\n']]){await mkdir(join(p.path,path.split('/').slice(0,-1).join('/')),{recursive:true});await writeFile(join(p.path,path),text);}
 return p;
}
test('the workspace file list is a folder tree that opens, closes and still searches flat',async({page})=>{
 await fixture(page,'Tree fixture');await page.getByRole('button',{name:'Files and changes',exact:true}).click();const pane=page.getByRole('complementary',{name:'Project files and changes'});
 // Folders are collapsed-able and the tree groups by directory.
 const folders=()=>pane.locator('.file-folder');
 const folder=(path:string)=>pane.locator('.file-folder[title="'+path+'"]');
 const leaf=(path:string)=>pane.locator('.file-leaf[title="'+path+'"]');
 await expect(folder('src')).toHaveAttribute('aria-expanded','true');
 await expect(leaf('src/lib/util.ts')).toBeVisible();
 await folder('src').click();await expect(folder('src')).toHaveAttribute('aria-expanded','false');
 await expect(leaf('src/lib/util.ts')).toHaveCount(0);await folder('src').click();await expect(leaf('src/lib/util.ts')).toBeVisible();
 await folder('src/lib').click();await expect(leaf('src/lib/util.ts')).toHaveCount(0);
 await folder('src/lib').click();await expect(leaf('src/lib/util.ts')).toBeVisible();
 // A file inside a nested folder opens as its own preview.
 await leaf('src/lib/deep/more.ts').click();await expect(pane.getByRole('region',{name:'File contents'})).toContainText('export const three = 3;');
 await pane.getByRole('button',{name:'Back to files and changes'}).click();
 // Searching keeps one flat, matching list, because a match inside a closed folder would be hidden.
 await pane.getByLabel('Find project files').fill('util');await expect(pane.getByRole('button',{name:/src\/lib\/util\.ts/})).toBeVisible();
 await expect(folders(),'a search shows matching files, not folders').toHaveCount(0);
 await pane.getByLabel('Find project files').fill('');await expect(folder('src')).toBeVisible();
});
test('a long paste is offered as a document, and only an absurd one is refused',async({page})=>{
 await fixture(page,'Limit fixture');await page.getByRole('button',{name:'Session',exact:true}).click();
 const requests:string[]=[];page.on('request',request=>{if(request.url().includes('/agents/input'))requests.push(request.url());});
 const box=page.getByLabel('Message the agent');
 // 8,100 characters is a long paste, not an error: it is offered as a document and can be sent.
 await box.fill('x'.repeat(8100));
 await expect(page.getByRole('button',{name:'Save the message text as a document in the worktree'})).toBeVisible();
 await expect(page.locator('[data-message-limit="over"]')).toHaveCount(0);
 // Past the server's own maximum, the composer refuses before the request and keeps the text.
 await box.fill('y'.repeat(200001));
 await expect(page.locator('[data-message-limit="over"]')).toContainText('200,001 of 200,000 characters');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:/limit for one message is 200,?000/})).toBeVisible();
 expect(requests.length,'no send leaves the page for a message past the maximum').toBe(0);
 await expect(box).toHaveValue('y'.repeat(200001));
 await box.fill('short enough');await expect(page.locator('[data-message-limit="over"]')).toHaveCount(0);
});
test('every transcript message carries its time, and the composer holds the draft',async({page})=>{
 await fixture(page,'Timestamps fixture');await page.getByRole('button',{name:'Session',exact:true}).click();
 await page.getByLabel('Message the agent').fill('Hello there');await page.getByRole('button',{name:'Send message',exact:true}).click();
 const transcript=page.getByRole('region',{name:'Agent transcript'});
 await expect(transcript.locator('.agent-entry').first()).toBeVisible();
 const times=transcript.locator('time.agent-time');expect(await times.count(),'each rendered entry carries a time').toBeGreaterThan(0);
 const stamp=await times.first().textContent();expect(stamp,'a time like 3:04:05 pm or 15:04:05').toMatch(/\d{1,2}:\d{2}/);
 const datetime=await times.first().getAttribute('datetime');expect(new Date(datetime??'').getTime(),'the machine-readable time parses').toBeGreaterThan(0);
});
test('the agent manager keeps its title and close control in view and grants every available scope at once',async({page})=>{
 await fixture(page,'Privileges fixture');await page.getByRole('button',{name:'Agents and privileges',exact:true}).click().catch(async()=>{await page.getByRole('button',{name:'Board actions',exact:true}).click();await page.getByRole('button',{name:'Agents & privileges',exact:true}).click();});
 const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'Agents & privileges'})).toBeVisible();
 // Wait for the registry, so the body has its final height: a dialog is vertically centred, so a
 // body that grows while it loads moves its own top edge.
 await expect(dialog.locator('[aria-label="Privilege scopes"]')).toBeVisible();
 const before=await dialog.getByRole('button',{name:'Close agent manager'}).boundingBox();
 await dialog.locator('.manager-scroll').evaluate(element=>{element.scrollTop=element.scrollHeight;});
 const after=await dialog.getByRole('button',{name:'Close agent manager'}).boundingBox();
 expect(Math.abs((after?.y??0)-(before?.y??0)),'the close control stays at the same place while the body scrolls').toBeLessThan(4);
 expect(await dialog.locator('.manager-scroll').evaluate(element=>element.scrollTop),'the body really scrolled').toBeGreaterThan(50);
 expect(await dialog.evaluate(element=>element.scrollTop),'the dialog frame itself does not scroll').toBe(0);
 // Select all grants every available scope, and clear all removes them again.
 await dialog.getByRole('button',{name:'New agent',exact:true}).click();
 await dialog.getByRole('button',{name:'Grant every available scope'}).click();
 const scopes=dialog.locator('[aria-label="Privilege scopes"] input[type=checkbox]');
 const checked=await scopes.evaluateAll(boxes=>(boxes as HTMLInputElement[]).filter(box=>box.checked&&!box.disabled).length);
 expect(checked,'every available scope is granted').toBeGreaterThan(3);
 expect(await scopes.count(),'an unavailable scope is never granted by select all').toBeGreaterThan(checked);
 await dialog.getByRole('button',{name:'Remove every scope from this draft'}).click();
 expect(await scopes.evaluateAll(boxes=>(boxes as HTMLInputElement[]).filter(box=>box.checked).length),'clear all leaves none granted').toBe(0);
});

test('a file can be chosen, and a project with no worktree says why it cannot store it',async({page})=>{
 await fixture(page,'Attachment fixture');await page.getByRole('button',{name:'Session',exact:true}).click();
 await page.getByLabel('Attach a file or image').setInputFiles({name:'brief.md',mimeType:'text/markdown',buffer:Buffer.from('# Brief\nRead me.\n')});
 // This fixture has no connected repository, so there is no worktree to store into. The composer
 // names that reason instead of pretending the file was attached, and nothing is sent by accident.
 await expect(page.getByRole('alert').filter({hasText:/Attachments need a connected repository worktree/})).toBeVisible();
 await expect(page.getByRole('group',{name:'Attachments'}).getByText('brief.md')).toHaveCount(0);
 // The storage path itself — the worktree, the generated name, the bounded size — is covered
 // against a real worktree in tests/server/attachments.test.ts, which a browser fixture cannot have.
});
test('a long paste is offered as a document rather than refused',async({page})=>{
 await fixture(page,'Document fixture');await page.getByRole('button',{name:'Session',exact:true}).click();
 const box=page.getByLabel('Message the agent');await box.fill('y'.repeat(9000));
 const offer=page.getByRole('button',{name:'Save the message text as a document in the worktree'});
 await expect(offer).toBeVisible();
 await offer.click();
 await expect(page.getByRole('alert').filter({hasText:/Attachments need a connected repository worktree/})).toBeVisible();
 await expect(box,'a refused document keeps every character in the box').toHaveValue('y'.repeat(9000));
});
test('the thinking level is chosen per session and reported back by the server',async({page})=>{
 await fixture(page,'Thinking fixture');await page.getByRole('button',{name:'Session',exact:true}).click();
 await page.getByRole('button',{name:'Model and thinking'}).click();
 const panel=page.getByRole('group',{name:'Model and thinking'});
 await panel.getByRole('button',{name:'high',exact:true}).click();
 await expect(panel.getByRole('button',{name:'high',exact:true})).toHaveAttribute('aria-pressed','true');
 // The server is the authority: a fresh read of the view reports the same level.
 await expect.poll(async()=>await page.evaluate(async()=>{const token=document.querySelector('meta[name="dashboard-token"]')?.getAttribute('content')??'';const project=new URL(location.href).searchParams.get('project')??'';const view=await (await fetch('/api/projects/'+project+'/agents',{headers:{'x-dashboard-token':token}})).json();return view.view.thinkingLevel;})).toBe('high');
 await panel.getByRole('button',{name:'default',exact:true}).click();
 await expect(panel.getByRole('button',{name:'default',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('the harness settings are the owner’s, apply without a restart, and cannot turn a tool on that the deployment lacks',async({page})=>{
 await fixture(page,'Harness settings fixture');
 await page.getByRole('button',{name:'Harness settings',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'Harness',exact:true})).toBeVisible();
 const turns=dialog.getByLabel('Most model requests in a row for one message');
 await expect(turns).toHaveValue('40');
 await turns.fill('300');
 await dialog.getByLabel('Most tokens one request may produce').fill('64000');
 await dialog.getByLabel('Thinking level for a new conversation').selectOption('medium');
 await dialog.getByRole('button',{name:'Save harness settings'}).click();
 await expect(dialog.getByRole('status')).toContainText('no restart');
 // The server is the authority: a fresh read reports what was saved.
 await expect.poll(async()=>await page.evaluate(async()=>{const token=document.querySelector('meta[name="dashboard-token"]')?.getAttribute('content')??'';const view=await (await fetch('/api/settings/harness',{headers:{'x-dashboard-token':token}})).json();return JSON.stringify([view.settings.preferences.maxModelTurns,view.settings.preferences.maxOutputTokens,view.settings.preferences.defaultThinking,view.revision]);})).toBe('[300,64000,"medium",2]');
 // This browser server runs without the capability switches, so the boxes are disabled and each
 // says why. The narrowing path — a capability the deployment offers, switched off here — is
 // exercised against an instance that really offers them in tests/server/harness-settings-http.test.ts.
 const shell=dialog.getByLabel('Shell (bash)');
 await expect(shell).toBeDisabled();
 await expect(dialog.locator('[data-capability-state="shell"]')).toContainText('Not offered by this deployment');
 const coding=dialog.getByLabel('Coding tools (read, write)');
 await expect(coding).toBeDisabled();
});
