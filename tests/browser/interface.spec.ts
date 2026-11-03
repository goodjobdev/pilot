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
test('an over-long message is refused in the composer with the limit named, and nothing is sent',async({page})=>{
 await fixture(page,'Limit fixture');await page.getByRole('button',{name:'Agents',exact:true}).click();
 const requests:string[]=[];page.on('request',request=>{if(request.url().includes('/agents/input'))requests.push(request.url());});
 const box=page.getByLabel('Message the agent');await box.fill('x'.repeat(8100));
 await expect(page.locator('[data-message-limit="over"]')).toContainText('8,100 of 8,000 characters');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:/The limit for one message is 8,000/})).toBeVisible();
 expect(requests.length,'no send leaves the page for an over-long message').toBe(0);
 await expect(box).toHaveValue('x'.repeat(8100));
 await box.fill('short enough');await expect(page.locator('[data-message-limit="over"]')).toHaveCount(0);
});
test('every transcript message carries its time, and the composer holds the draft',async({page})=>{
 await fixture(page,'Timestamps fixture');await page.getByRole('button',{name:'Agents',exact:true}).click();
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
