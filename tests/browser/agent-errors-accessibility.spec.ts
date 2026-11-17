import {test,expect} from '@playwright/test';

test('agent refusal details stay discoverable for grouped and general errors',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();await page.getByLabel('Project name').fill('Group fixture');await page.getByRole('button',{name:'Confirm & add project'}).click();await page.getByRole('button',{name:'Agents and privileges'}).click();
 const dialog=page.getByRole('dialog',{name:'Agents & privileges'});await dialog.getByRole('button',{name:'New agent'}).click();
 await dialog.getByLabel('Agent name').fill('Error accessibility fixture');
 let refusal='workspace is not available';
 await page.route('**/api/agents',route=>route.request().method()==='POST'?route.fulfill({status:422,json:{error:refusal}}):route.continue());
 const save=dialog.getByRole('button',{name:'Create agent'});
 await save.click();await expect(dialog.getByLabel('Agent workspace subpath')).toHaveAccessibleDescription('workspace is not available');
 await expect(dialog.getByRole('group',{name:'Allowed projects'}).getByLabel('Project Group fixture')).toHaveAccessibleDescription('workspace is not available');
 await expect(dialog.getByRole('group',{name:'Privilege scopes'})).toBeVisible();
 refusal='budgets are not valid';await save.click();await expect(dialog.getByLabel('Jobs per hour (test execution)')).toHaveAccessibleDescription('budgets are not valid');
 refusal='scopes are not valid';await save.click();await expect(dialog.getByLabel('Scope read_notes')).toHaveAccessibleDescription(/scopes are not valid/);
 refusal='revision is stale';await save.click();await expect(dialog.getByRole('alert')).toContainText('revision is stale');
});
