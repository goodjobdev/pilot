import { test,expect,type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
const exec=promisify(execFile);
async function fixture(page:Page,name:string){
 await page.goto('/');if(!await page.getByRole('button',{name:'＋ Add project',exact:true}).first().isVisible())await page.getByRole('button',{name:'Show project sidebar',exact:true}).click();await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();await page.getByLabel('Project name').fill(name);await page.getByRole('button',{name:'Confirm & add project'}).click();await expect(page.getByRole('heading',{name})).toBeVisible();
 const p=await page.evaluate(async name=>{const token=document.querySelector('meta[name="dashboard-token"]')!.getAttribute('content')!;const projects=await (await fetch('/api/projects',{headers:{'x-dashboard-token':token}})).json();return projects.find((p:{name:string})=>p.name===name);},name) as {id:string;path:string};
 expect(p.path).toContain('dashboard-browser-');expect(p.id).toMatch(/^[a-f0-9-]{36}$/);
 const git=async(...args:string[])=>(await exec('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:p.path,env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},timeout:10000})).stdout;
 await git('init','-b','work/pilot-'+p.id.slice(0,8));await mkdir(join(p.path,'docs/specs'),{recursive:true});await mkdir(join(p.path,'src'));
 await writeFile(join(p.path,'docs/specs/work.md'),'# Work\n- [ ] Storage first <!-- pilot:task STORAGE -->\n- [ ] UI second <!-- pilot:task UI --> <!-- pilot:depends STORAGE -->\n');
 await writeFile(join(p.path,'src/icon.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));
 await writeFile(join(p.path,'src/app.ts'),'export const answer = 1;\n');await git('add','docs/dashboard/board.md','docs/specs/work.md','src/app.ts','src/icon.png');await git('commit','-m','fixture: initial project');return {p,git};
}
test('wiki folders fold together and the right sidebar opens safe source files and real commit diffs',async({page})=>{
 const {p}=await fixture(page,'Files and changes fixture');await page.getByRole('button',{name:'Wiki',exact:true}).click();
 await page.getByRole('button',{name:'Collapse all folders'}).click();await expect(page.locator('.doc-folder[aria-expanded="true"]')).toHaveCount(0);await page.getByRole('button',{name:'Expand all folders'}).click();await expect(page.locator('.doc-item').filter({hasText:'specs/work.md'})).toBeVisible();
 await page.getByRole('button',{name:'Files and changes',exact:true}).click();const pane=page.getByRole('complementary',{name:'Project files and changes'});
 await pane.getByRole('button',{name:'src/icon.png'}).click();await expect(pane.getByRole('img',{name:'src/icon.png'})).toBeVisible();await expect.poll(()=>pane.getByRole('img',{name:'src/icon.png'}).evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBe(1);await pane.getByRole('button',{name:'Back to files and changes'}).click();
 await pane.getByRole('button',{name:'src/app.ts'}).click();await expect(pane.getByRole('region',{name:'File contents'})).toContainText('export const answer = 1;');
 await writeFile(join(p.path,'src/app.ts'),'export const answer = 2;\n');await pane.getByRole('button',{name:'Show changes',exact:true}).click();await expect(pane.getByRole('region',{name:'File diff'})).toContainText('-export const answer = 1;');await expect(pane.getByRole('region',{name:'File diff'})).toContainText('+export const answer = 2;');
 await pane.getByRole('tab',{name:'Changes'}).click();await pane.getByRole('button',{name:'fixture: initial project'}).click();await pane.getByRole('button',{name:'src/app.ts',exact:true}).click();await expect(pane.getByRole('region',{name:'File diff'})).toContainText('+export const answer = 1;');
});
test('sync creates one committed canonical plan and board/source edits update each other without a reload',async({page})=>{
 const {p,git}=await fixture(page,'Shared plan fixture');await page.getByRole('button',{name:'Sync plan',exact:true}).click();await expect(page.getByRole('heading',{name:'Sync plan',exact:true})).toBeVisible();
 await page.getByLabel('docs/specs/work.md',{exact:true}).check();await page.getByRole('button',{name:'Preview sync'}).click();await expect(page.getByText('2 candidates', {exact:false})).toBeVisible();await page.getByLabel('Storage first → UI second',{exact:true}).check();
 const before=Number((await git('rev-list','--count','HEAD')).trim());await page.getByRole('button',{name:'Apply 2 reviewed tasks'}).click();await expect(page.getByRole('dialog')).not.toBeVisible();expect(Number((await git('rev-list','--count','HEAD')).trim())).toBe(before+1);
 await page.getByRole('button',{name:'List',exact:true}).click();await page.getByRole('button',{name:'Storage first active'}).click();await page.getByLabel('Task title',{exact:true}).fill('Board edited title');await page.getByRole('button',{name:'Save task',exact:true}).click();await expect(page.locator('.save-indicator')).toContainText('Committed');
 expect(await git('show','HEAD:docs/dashboard/board.md')).toContain('Board edited title');
 await page.getByRole('button',{name:'Board actions',exact:true}).click();await page.getByRole('button',{name:'Open plan document',exact:true}).click();await expect(page.getByRole('heading',{name:'Board edited title',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Edit document',exact:true}).click();const body=page.getByRole('textbox',{name:'Document body',exact:true});await body.fill((await body.inputValue()).replace('Board edited title','Document edited title'));await page.getByRole('button',{name:'Save document',exact:true}).click();await expect(page.getByRole('heading',{name:'Document edited title',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'List',exact:true}).click();await expect(page.getByRole('button',{name:'Document edited title active'})).toBeVisible();
 const path=join(p.path,'docs/dashboard/board.md'),source=await readFile(path,'utf8');await writeFile(path,source.replace('Document edited title','Externally edited title'));await expect(page.getByRole('button',{name:'Externally edited title active'})).toBeVisible({timeout:7000});
});
test('phone file preview preserves the chat draft and does not overflow the screen',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page,'Phone workspace fixture');await page.getByRole('button',{name:'Agents',exact:true}).click();await page.getByLabel('Message the agent').fill('Keep this unsent draft');
 await page.getByRole('button',{name:'Files and changes',exact:true}).click();const pane=page.getByRole('complementary',{name:'Project files and changes'});await pane.getByRole('button',{name:'src/app.ts'}).click();await expect(pane.getByRole('region',{name:'File contents'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await pane.getByRole('button',{name:'Close files and changes'}).click();await expect(page.getByLabel('Message the agent')).toHaveValue('Keep this unsent draft');
});
