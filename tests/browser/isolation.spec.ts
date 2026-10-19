import {test,expect} from '@playwright/test';

test('two projects keep their documentation and their agent sessions apart',async({page})=>{
 await page.goto('/');
 const addProject=async(name:string)=>{
   await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
   await page.getByLabel('Project name').fill(name);
   await page.getByRole('button',{name:'Confirm & add project'}).click();
 };
 // Selecting explicitly matters: creating a project selects it, so the test must say which
 // project it is working in rather than assuming.
 const selectProject=async(name:string)=>await page.getByRole('button',{name:new RegExp(name)}).click();
 await addProject('Isolation Alpha');
 await addProject('Isolation Beta');

 await selectProject('Isolation Alpha');
 await page.getByRole('button',{name:'Wiki',exact:true}).click();
 page.once('dialog',dialog=>void dialog.accept('docs/alpha.md'));
 await page.getByRole('button',{name:'New page',exact:true}).click();
 await page.getByLabel('Document body').fill('# Alpha only\n\nA note that belongs to Alpha.\n');
 await page.getByRole('button',{name:'Save document',exact:true}).click();
 await expect(page.locator('.doc-body h1')).toHaveText('Alpha only');
 await expect(page.getByRole('button',{name:/alpha\.md/})).toBeVisible();

 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await page.getByLabel('Message the agent').fill('alpha session message');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.getByLabel('Agent transcript')).toContainText('alpha session message');

 // Beta has neither the document nor the conversation. Waiting for the document list to settle
 // matters: an empty state shown before the list loads would prove nothing.
 await selectProject('Isolation Beta');
 await page.getByRole('button',{name:'Wiki',exact:true}).click();
 await expect(page.getByText('No Markdown documents in this project yet')).toBeVisible();
 await expect(page.getByRole('button',{name:/alpha\.md/})).toHaveCount(0);
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 const betaTranscript=page.getByLabel('Agent transcript');
 await expect(betaTranscript).toContainText('No messages yet');
 await expect(betaTranscript).not.toContainText('alpha session message');
 await page.getByLabel('Message the agent').fill('beta session message');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(betaTranscript).toContainText('beta session message');

 // Alpha still has exactly its own history and its own document.
 await selectProject('Isolation Alpha');
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 const alphaTranscript=page.getByLabel('Agent transcript');
 await expect(alphaTranscript).toContainText('alpha session message');
 await expect(alphaTranscript).not.toContainText('beta session message');
 await page.getByRole('button',{name:'Wiki',exact:true}).click();
 await expect(page.getByRole('button',{name:/alpha\.md/})).toBeVisible();
});