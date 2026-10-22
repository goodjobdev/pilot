import {test,expect} from '@playwright/test';

/**
 * The agent management view: create an agent, assign its privilege scopes, and see a refusal beside
 * the field it names rather than as a generic failure.
 *
 * The view is reachable from the existing navigation (the application bar, beside Providers & models),
 * it calls the same authenticated routes as everything else, and it is never the enforcement point:
 * every rule the server applies is reported back in the server's own words.
 */
test('an agent is created with assigned scopes, and a refusal is shown beside the field it names',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Privileges fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();

 // Reachable from the existing navigation, and explicit that the server is the enforcement point.
 await page.getByRole('button',{name:'Agents and privileges'}).click();
 const dialog=page.getByRole('dialog');
 await expect(dialog).toBeVisible();
 await expect(dialog).toContainText('The server enforces it at dispatch');
 await expect(dialog).toContainText('No agents yet');

 // Create one agent and assign two scopes, each beside the line that describes it.
 await page.getByRole('button',{name:'New agent'}).click();
 await page.getByLabel('Agent name').fill('Nightly reviewer');
 await page.getByLabel('Agent description').fill('Reviews what landed overnight.');
 await expect(dialog).toContainText('Append one line to this project');
 await page.getByLabel('Scope read_notes').check();
 await page.getByLabel('Scope record_note').check();
 await page.getByRole('button',{name:'Create agent'}).click();
 await expect(dialog.getByRole('status')).toContainText('Created Nightly reviewer');
 const row=page.locator('.agent-row').first();
 await expect(row).toContainText('Nightly reviewer');
 await expect(row).toContainText('read_notes, record_note');
 await expect(row).toContainText('enabled');
 await expect(row).toContainText('r1');

 // The record is durable: the same agent is served by the registry route, with the scopes it was given.
 const listed=await page.evaluate(async()=>{
  const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
  return (await fetch('/api/agents',{headers:{'X-Dashboard-Token':token}})).json();
 });
 expect(listed.agents.map((agent:{name:string})=>agent.name)).toEqual(['Nightly reviewer']);
 expect(listed.agents[0].scopes).toEqual(['read_notes','record_note']);
 expect(listed.agents[0].enabled).toBe(true);

 // A duplicate live name is refused by the server, and the refusal lands beside the name field.
 await page.getByRole('button',{name:'New agent'}).click();
 await page.getByLabel('Agent name').fill('Nightly reviewer');
 await page.getByRole('button',{name:'Create agent'}).click();
 await expect(dialog.locator('.field-error')).toContainText('already named Nightly reviewer');
 await expect(dialog.locator('.field-error')).toBeVisible();
 // Nothing was written by the refused creation: the registry still holds exactly one agent.
 await expect(page.locator('.agent-row')).toHaveCount(1);

 // A scope outside the closed vocabulary cannot even be chosen, and the model list is the offered one.
 await expect(page.getByLabel('Scope file_edit')).toBeVisible();
 expect(await page.getByLabel('Agent model').locator('option').count()).toBeGreaterThan(0);

 // Disabling is a revision-checked change, and the list reports the new state.
 await page.locator('.agent-row').first().click();
 await page.getByRole('button',{name:'Disable agent'}).click();
 await expect(dialog.getByRole('status')).toContainText('Disabled Nightly reviewer at revision 2');
 await expect(page.locator('.agent-row').first()).toContainText('disabled');
 await expect(page.locator('.agent-row').first()).toContainText('r2');

 // The recorded file edits are shown honestly: the capability is disabled on this instance.
 await expect(dialog).toContainText('The bounded file-edit capability is disabled on this instance');

 await page.getByRole('button',{name:'Close agent manager'}).click();
 await expect(dialog).toBeHidden();
});
