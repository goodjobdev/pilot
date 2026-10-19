import { test,expect } from '@playwright/test';
test('add two projects, reopen and switch without separate setup',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'＋ Add project'}).first().click();
 await page.getByLabel('Project name').fill('Browser Alpha');await page.getByRole('button',{name:'Confirm & add project'}).click();
 await expect(page.getByRole('heading',{name:'Browser Alpha'})).toBeVisible();await page.reload();await expect(page.getByRole('heading',{name:'Browser Alpha'})).toBeVisible();
 await page.getByRole('button',{name:'＋ Add project',exact:true}).click();await page.getByLabel('Project name').fill('Browser Beta');await page.getByRole('button',{name:'Confirm & add project'}).click();
 await page.getByRole('navigation',{name:'Projects'}).getByRole('button',{name:/Browser Alpha/}).click();await expect(page.getByRole('heading',{name:'Browser Alpha'})).toBeVisible();
});
