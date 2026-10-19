import {test,expect} from '@playwright/test';
test('the agent runs, streams, steers and stops without calling a model',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Agents fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 // The instance is explicit that a scripted provider answers, so nobody mistakes it for a model.
 await expect(page.getByText('no model called')).toBeVisible();
 await expect(page.locator('.agent-state')).toHaveText('Idle');

 await page.getByLabel('Message the agent').fill('hello from the phone');
 await page.getByRole('button',{name:'Send message'}).click();
 const transcript=page.getByLabel('Agent transcript');
 await expect(transcript).toContainText('Scripted test reply');
 await expect(transcript).toContainText('hello from the phone');
 await expect(page.locator('.agent-state')).toHaveText('Idle');

 // A paused run stays open long enough to be steered and then stopped.
 await page.getByLabel('Message the agent').fill('[pause] hold the run open');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('.agent-state')).toHaveText('Working…');
 await page.getByLabel('Message the agent').fill('steer: prefer pnpm');
 await page.getByRole('button',{name:'Steer the run'}).click();
 await expect(page.getByLabel('Queued messages')).toContainText('steer: prefer pnpm');
 await page.getByRole('button',{name:'Stop the agent'}).click();
 await expect(page.locator('.agent-state')).toHaveText('Idle');
 await expect(page.getByLabel('Queued messages')).toHaveCount(0);

 // The conversation lives in SQLite, so it is still there after a reload.
 await page.reload();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByLabel('Agent transcript')).toContainText('Scripted test reply');
});

test('a run survives the browser closing and the reopened view reconnects to it',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Reconnect fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await page.getByLabel('Message the agent').fill('[pause] keep working while I leave');
 await page.getByRole('button',{name:'Send message'}).click();
 await expect(page.locator('.agent-state')).toHaveText('Working…');

 // The tab goes away entirely, which is what a phone does when it sleeps.
 await page.close();
 const reopened=await page.context().newPage();
 await reopened.goto('/');
 await reopened.getByRole('button',{name:'Agents',exact:true}).click();
 const transcript=reopened.getByLabel('Agent transcript');
 await expect(transcript).toContainText('keep working while I leave');
 await expect(reopened.locator('.agent-state')).toHaveText('Idle');
 await expect(transcript).toContainText('Scripted test reply');
});

// A question asked by the agent must reach the inbox and be answerable exactly once, on a phone.
test('an agent question reaches the inbox and is answered once on a phone-sized screen',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Question fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 // From here on it is a phone-sized screen, which is where the question has to be answerable.
 // The desktop preference left the project drawer open, and a drawer covers content by design.
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Hide project sidebar'}).click();
 await page.getByLabel('Message the agent').fill('[ask] add the invoice export');
 await page.getByRole('button',{name:'Send message'}).click();
 const questions=page.getByRole('region',{name:'Questions for me'});
 await expect(questions).toContainText('Should I proceed with: add the invoice export?');

 // The same question appears in the application inbox, and opening it lands on the answer.
 await page.getByRole('button',{name:/Needs me/}).click();
 await expect(page.getByRole('group',{name:'Needs me'})).toContainText('Should I proceed with');
 await page.locator('.inbox-item').last().click();
 await expect(questions).toBeVisible();

 await page.getByLabel(/^Answer to:/).fill('Yes, use the CSV export');
 await page.getByRole('button',{name:'Send answer'}).click();
 await expect(questions).toContainText('answered');
 await expect(questions).toContainText('Yes, use the CSV export');
 await expect(page.getByLabel(/^Answer to:/)).toHaveCount(0);
 await expect(page.getByRole('button',{name:/Needs me/})).toHaveAttribute('aria-label','Needs me');

 // It stays answered after a reload, with no way to answer it twice.
 await page.reload();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByRole('region',{name:'Questions for me'})).toContainText('Yes, use the CSV export');
 await expect(page.getByLabel(/^Answer to:/)).toHaveCount(0);
});
