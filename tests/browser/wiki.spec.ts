import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const document_=['# Checkout behaviour','','The intent for this flow.','','\u0060\u0060\u0060mermaid','flowchart LR','  Plan --> Build','\u0060\u0060\u0060','','![Static mockup](./checkout.html)','','![Flow sketch](./flow.png)','','spec: docs/spec/alpha.md#Acceptance','','## Open questions','','- [ ] Which payment provider?','- [x] Answered already','','needle-in-haystack',''].join('\n');
test('wiki browse, render, edit, search and conflict-safe saving',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Wiki fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 // Real files for the documentation to reference: a one-pixel PNG and a static mockup.
 const readProjectPath=()=>page.evaluate(async()=>{
   const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
   const listed=await (await fetch('/api/projects',{headers:{'X-Dashboard-Token':token}})).json() as {name:string;path:string}[];
   return listed.find(project=>project.name==='Wiki fixture')?.path??null;
 });
 let projectPath: string|null=null;
 for(let attempt=0;attempt<50&&projectPath===null;attempt++){ projectPath=await readProjectPath(); if(projectPath===null)await page.waitForTimeout(100); }
 if(projectPath===null)throw Error('the fixture project was not registered in time');
 // The page lives at docs/spec/alpha.md, so its ./ references resolve inside docs/spec/.
 await mkdir(join(projectPath,'docs','spec'),{recursive:true});
 await writeFile(join(projectPath,'docs','spec','flow.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64'));
 await writeFile(join(projectPath,'docs','spec','checkout.html'),'<p>Static checkout mockup</p>');
 await page.getByRole('button',{name:'Wiki',exact:true}).click();
 await expect(page.getByText('Write the intent first.')).toBeVisible();
 page.once('dialog',dialog=>void dialog.accept('docs/spec/alpha.md'));
 await page.getByRole('button',{name:'New page',exact:true}).click();
 const body=page.getByLabel('Document body');
 await expect(body).toBeVisible();
 await body.fill(document_);
 await page.getByRole('button',{name:'Save document',exact:true}).click();
 await expect(page.locator('.save-indicator')).toHaveText(/Saved docs\/spec\/alpha\.md/);
 // Rendered view: heading, diagram, contained assets, open questions.
 await expect(page.locator('.doc-body h1')).toHaveText('Checkout behaviour');
 await expect(page.locator('.doc-body .mermaid svg')).toBeVisible();
 // Images and mockups load through an authenticated fetch, so they work without
 // relying on a proxy to inject an identity header.
 const image=page.locator('.doc-body img[data-asset]');
 await expect(image).toHaveAttribute('src',/^blob:/);
 await expect.poll(async()=>image.evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(1);
 const mockup=page.locator('.doc-body iframe[data-mockup]');
 await expect(mockup).toHaveAttribute('sandbox','');
 await expect(mockup).toHaveAttribute('srcdoc',/Static checkout mockup/);
 await expect(page.getByRole('region',{name:'Open questions'})).toContainText('Which payment provider?');
 await expect(page.getByRole('region',{name:'Open questions'})).not.toContainText('Answered already');
 // The document lives in the project's Markdown, listed by kind.
 await expect(page.getByRole('button',{name:/alpha\.md/})).toContainText('spec');
 // Edit and save again.
 await page.getByRole('button',{name:'Edit document'}).click();
 await page.getByLabel('Document body').fill(document_.replace('# Checkout behaviour','# Checkout behaviour revised'));
 await page.getByRole('button',{name:'Save document',exact:true}).click();
 await expect(page.locator('.save-indicator')).toHaveText(/Saved docs\/spec\/alpha\.md/);
 await expect(page.locator('.doc-body h1')).toHaveText('Checkout behaviour revised');
 // Content search finds the line and opens the document.
 await page.getByLabel('Search documents').fill('needle-in-haystack');
 await page.getByRole('button',{name:'Search contents'}).click();
 const match=page.locator('.doc-matches button').first();
 await expect(match).toContainText('docs/spec/alpha.md:21');
 await match.click();
 await expect(page.locator('.doc-body h1')).toHaveText('Checkout behaviour revised');
 // Search that cannot match says so rather than pretending.
 await page.getByLabel('Search documents').fill('nothing-matches-this');
 await page.getByRole('button',{name:'Search contents'}).click();
 await expect(page.getByText('No matches in document contents')).toBeVisible();
 // A work item points at the documentation; the link is advisory, never a gate.
 await page.getByRole('button',{name:'List',exact:true}).click();
 await page.getByRole('button',{name:'＋ Task',exact:true}).click();
 await page.getByLabel('Task title',{exact:true}).fill('Implement checkout');
 await page.getByRole('button',{name:'Save task',exact:true}).click();
 await expect(page.getByRole('status')).toHaveText('Saved');
 await page.getByRole('button',{name:'Close inspector'}).click();
 await expect(page.locator('.spec-chip.none').first()).toHaveText('no spec');
 await page.getByRole('button',{name:/Implement checkout/}).first().click();
 await page.getByRole('button',{name:'＋ Link a specification'}).click();
 await page.getByLabel('Specification 1').fill('docs/spec/alpha.md#acceptance');
 await page.getByLabel('Specification 1').blur();
 await page.getByRole('button',{name:'Save task',exact:true}).click();
 await expect(page.getByRole('status')).toHaveText('Saved');
 await page.getByRole('button',{name:'Close inspector'}).click();
 await expect(page.locator('.spec-chip').first()).toHaveText('alpha.md#acceptance');
 // The questions inbox opens the document that asked.
 await page.getByRole('button',{name:/Needs me/}).click();
 const pending=page.locator('.inbox-item').first();
 await expect(pending).toContainText('Which payment provider?');
 await pending.click();
 await expect(page.locator('.doc-body h1')).toHaveText('Checkout behaviour revised');
 await expect(page.locator('.doc-body #open-questions')).toBeVisible();
 // Persistence: the document is still listed after a reload.
 await page.reload();
 await expect(page.getByRole('button',{name:/alpha\.md/})).toBeVisible();
 // Narrow screen: the tree becomes a drawer that closes after choosing a document.
 await page.setViewportSize({width:390,height:844});
 await page.reload();
 await page.getByRole('button',{name:'Wiki',exact:true}).click();
 await expect(page.locator('.wiki-tree')).toHaveClass(/open/);
 await page.getByRole('button',{name:/alpha\.md/}).click();
 await expect(page.locator('.doc-body h1')).toHaveText('Checkout behaviour revised');
 await expect(page.locator('.wiki-tree')).not.toHaveClass(/open/);
 await page.getByRole('button',{name:'Show documents'}).click();
 await expect(page.locator('.wiki-tree')).toHaveClass(/open/);
 await page.getByRole('button',{name:'Hide documents'}).click();
 await expect(page.locator('.wiki-tree')).not.toHaveClass(/open/);
});
