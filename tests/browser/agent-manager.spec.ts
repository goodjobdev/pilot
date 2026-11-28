import {test,expect} from '@playwright/test';

/**
 * The agent management view: create an agent, assign its privilege scopes, and see a refusal beside
 * the field it names rather than as a generic failure.
 *
 * The view is reachable from the existing navigation (the application bar, beside Providers & models),
 * it calls the same authenticated routes as everything else, and it is never the enforcement point:
 * every rule the server applies is reported back in the server's own words.
 */
test('the owner can configure a fixed commit target without enabling a commit tool',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Commit configuration fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await page.getByRole('button',{name:'Agents and privileges'}).click();
 const panel=page.getByRole('region',{name:'Commit target configuration'});
 await expect(panel).toContainText('does not install a commit tool');
 await page.getByLabel('Commit target project').selectOption({label:'Commit configuration fixture'});
 await expect(panel).toContainText('Not configured yet.');
 await page.getByLabel('Enable commit target').check();
 await page.getByRole('button',{name:'Save commit target'}).click();
 await expect(panel).toContainText('Revision 1');
 await expect(panel).toContainText('accepted commit tool is not installed');
 await page.getByRole('button',{name:'Close agent manager'}).click();
 await page.getByRole('button',{name:'Agents and privileges'}).click();
 await page.getByLabel('Commit target project').selectOption({label:'Commit configuration fixture'});
 await expect(page.getByLabel('Enable commit target')).toBeChecked();
 await expect(panel).toContainText('Revision 1');
});

test('action history makes uncertainty visible without offering a retry',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Action history fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await page.route('**/action-history**',route=>{const earlier=new URL(route.request().url()).searchParams.has('before');return route.fulfill({json:{projectId:'fixture',truncated:!earlier,nextBefore:earlier?null:'intent-1',items:[{id:earlier?'intent-2':'intent-1',revision:2,actionClass:earlier?'commit':'push',state:earlier?'not-started':'uncertain',agentId:'agent-1',sessionId:'session-1',targetId:'target-1',targetRevision:2,artifact:{revision:'action-'+'a'.repeat(64),commit:'b'.repeat(40)},receiptCommit:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}]}});});
 let savedBody:unknown=null;
 await page.route('**/observations',route=>{const saving=route.request().method()==='POST';if(saving)savedBody=route.request().postDataJSON();return route.fulfill({json:{action:{id:'intent-1',revision:2,state:'uncertain'},limit:100,reviews:saving?[{revision:1,actionRevision:2,actionState:'uncertain',observation:'checked-no-effect-visible',observedBy:'local',observedAt:'2026-01-01T00:00:00Z'}]:[]}});});
 await page.getByRole('button',{name:'Agents and privileges'}).click();
 await page.getByLabel('Commit target project').selectOption({label:'Action history fixture'});
 const panel=page.getByRole('region',{name:'Commit target configuration'});
 await expect(panel).toContainText('push · uncertain');
 await expect(panel).toContainText('may have happened');
 await expect(panel).toContainText('A recorded receipt is not independent verification');
 await expect(panel.getByRole('button',{name:/retry|clear action/i})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});
 await expect(panel).toContainText('push · uncertain');
 const overflow=await panel.evaluate(el=>el.scrollWidth>el.clientWidth);
 expect(overflow).toBe(false);
 await panel.getByRole('button',{name:'Earlier actions'}).click();
 await expect(panel).toContainText('commit · not-started');
 await expect(panel).not.toContainText('push · uncertain');
 await panel.getByRole('button',{name:'Reload action history'}).click();
 await expect(panel).toContainText('push · uncertain');
 await panel.getByRole('button',{name:'Review observations for push intent-1'}).click();
 await expect(panel).toContainText('does not establish that an effect stopped');
 await page.getByLabel('Action observation').selectOption('checked-no-effect-visible');
 await panel.getByRole('button',{name:'Record observation'}).click();
 await expect(panel).toContainText('The action and any barrier remain unchanged.');
 expect(savedBody).toEqual({actionRevision:2,revision:0,observation:'checked-no-effect-visible'});
});

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
 await expect(dialog.getByRole('note')).toContainText('enforced for the test-execution tool');
 await expect(dialog.getByRole('note')).toContainText('Owner-created workers use separate limits');
 await expect(dialog.getByRole('note')).toContainText('raising it permits further requests without resetting the count');
 await expect(dialog.getByRole('note')).toContainText('not spending limits');
 await expect(dialog).toContainText('The subpath is recorded but does not confine coding or shell tools');
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
 await expect(page.getByLabel('Agent name')).toHaveAttribute('aria-invalid','true');
 await expect(page.getByLabel('Agent name')).toHaveAccessibleDescription(/already named Nightly reviewer/);
 // Nothing was written by the refused creation: the registry still holds exactly one agent.
 await expect(page.locator('.agent-row')).toHaveCount(1);

 // A scope outside the closed vocabulary cannot even be chosen, and the model list is the offered one.
 await expect(page.getByLabel('Scope file_edit')).toBeVisible();
 await expect(page.getByLabel('Scope file_edit')).toBeDisabled();
 await expect(page.getByLabel('Scope deploy')).toBeDisabled();
 await expect(page.getByLabel('Scope read_notes')).toBeEnabled();
 expect(await page.getByLabel('Agent model').locator('option').count()).toBeGreaterThan(0);

 // Disabling is a revision-checked change, and the list reports the new state.
 await page.locator('.agent-row').first().click();
 await page.getByRole('button',{name:'Disable agent'}).click();
 await expect(dialog.getByRole('status')).toContainText('Disabled Nightly reviewer at revision 2');
 await expect(page.locator('.agent-row').first()).toContainText('disabled');
 await expect(page.locator('.agent-row').first()).toContainText('r2');

 // The recorded file edits are shown honestly: the capability is disabled on this instance.
 await expect(dialog).toContainText('The bounded file-edit capability is disabled on this instance');

 // A legacy unavailable grant remains visible and survives an unrelated save.
 const updateStatus=await page.evaluate(async()=>{
  const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
  const headers={'X-Dashboard-Token':token,'Content-Type':'application/json'};
  const registry=await (await fetch('/api/agents',{headers})).json();
  const agent=registry.agents[0];
  return (await fetch('/api/agents/'+encodeURIComponent(agent.id)+'/update',{
   method:'POST',headers,body:JSON.stringify({revision:agent.revision,patch:{scopes:['read_notes','record_note','deploy']},actor:{kind:'owner',identity:'local'}})
  })).status;
 });
 expect(updateStatus).toBe(200);
 await page.getByRole('button',{name:'Close agent manager'}).click();
 await page.getByRole('button',{name:'Agents and privileges'}).click();
 await expect(page.getByLabel('Scope deploy')).toBeChecked();
 await expect(dialog).toContainText('Existing grant; uncheck to remove.');
 await page.getByLabel('Agent description').fill('Updated description');
 await page.getByRole('button',{name:'Save agent'}).click();
 await expect(dialog.getByRole('status')).toContainText('Saved Nightly reviewer');
 await expect(page.getByLabel('Scope deploy')).toBeChecked();
 await page.getByLabel('Scope deploy').uncheck();
 await expect(page.getByLabel('Scope deploy')).toBeDisabled();

 await page.getByRole('button',{name:'Close agent manager'}).click();
 await expect(dialog).toBeHidden();
});
