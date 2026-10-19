import { test,expect } from '@playwright/test';
test('review selected documents without adopting or running embedded HTML',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();await page.getByLabel('Project name').fill('Import fixture');await page.getByRole('button',{name:'Confirm & add project'}).click();
 await page.getByRole('button',{name:'Import documents'}).first().click();
 await page.getByLabel('Markdown or legacy dashboard files').setInputFiles({name:'tasks.md',mimeType:'text/markdown',buffer:Buffer.from('# Now\n- [ ] Persist safely\n- [x] UI fixture')});
 await page.getByRole('button',{name:'Preview import'}).click();await expect(page.getByText('2 candidates · 0 milestones')).toBeVisible();
 await page.getByRole('button',{name:'Apply 2 reviewed tasks'}).click();await expect(page.getByText('Persistent markdown · 2 tasks')).toBeVisible();
 await expect(page.getByText(/Planning mirror/)).toBeVisible();
});