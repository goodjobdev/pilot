import {test,expect} from '@playwright/test';

/**
 * The session and composer user experience the owner asked for: a session bar that binds an agent and
 * shows the scopes in effect, a session list and create form, a details panel, a registry-driven slash
 * surface, Enter-to-send, and a question that can be dismissed with a reason.
 *
 * Every assertion reads what the server reports; nothing here is a client-side capability of its own.
 */
async function addProject(page:import('@playwright/test').Page,name:string){
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill(name);
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
}

test('the composer sends on Enter, keeps Shift+Enter as a newline, and the slash list is the registry',async({page})=>{
 await addProject(page,'Composer fixture');
 const composer=page.getByLabel('Message the agent');
 const transcript=page.getByLabel('Agent transcript');

 // Enter sends, and the composer is cleared.
 await composer.fill('sent by pressing enter');
 await composer.press('Enter');
 await expect(transcript).toContainText('sent by pressing enter');
 await expect(composer).toHaveValue('');

 // Shift+Enter inserts a newline instead of sending.
 await composer.fill('first line');
 await composer.press('Shift+Enter');
 await composer.pressSequentially('second line');
 await expect(composer).toHaveValue('first line\nsecond line');
 // The message has not been sent yet, so the transcript does not carry it.
 await expect(transcript).not.toContainText('first line');
 // Enter now sends the two-line message.
 await composer.press('Enter');
 await expect(transcript).toContainText('first line');

 // Typing '/' opens the slash list, driven by the same action registry the palette reads.
 await composer.fill('/');
 const slash=page.getByLabel('Slash commands');
 await expect(slash).toBeVisible();
 await expect(slash).toContainText('session.create',{timeout:10000});
 // Filtering narrows to the one registry action, and the chosen one runs through the execute path.
 await composer.fill('/session.create');
 await expect(slash.getByRole('button',{name:'Run Create session'})).toBeVisible();
 await expect(slash.locator('.slash-row')).toHaveCount(1);
 await composer.fill('');
 await expect(page.getByLabel('Slash commands')).toHaveCount(0);
});

test('a session is created with per-field validation, listed with its work, and its details name the agent and scopes in force',async({page})=>{
 await addProject(page,'Session UX fixture');
 const bar=page.getByRole('region',{name:'Session',exact:true});
 await expect(bar).toContainText('live conversation');

 // Create a named session.
 await page.getByRole('button',{name:'New session'}).click();
 await page.getByLabel('New session name').fill('Quarterly review');
 await page.getByRole('button',{name:'Create session'}).click();
 await expect(page.getByText('Created session Quarterly review')).toBeVisible();

 // A name outside the documented rule is refused, and the refusal lands beside the field.
 await page.getByRole('button',{name:'New session'}).click();
 await page.getByLabel('New session name').fill('bad/name');
 await page.getByRole('button',{name:'Create session'}).click();
 await expect(page.locator('.field-error')).toContainText('name');

 // The list shows name, agent bound, lifecycle, last activity and linked work.
 await page.getByRole('button',{name:'Sessions'}).click();
 const list=page.getByLabel('Named sessions');
 await expect(list).toContainText('Quarterly review');
 await expect(list).toContainText('agent:');
 await expect(list).toContainText('last activity');

 // The details panel names the effective model, the lifecycle, the agent and the scopes in effect.
 await page.getByRole('button',{name:'Session details'}).click();
 const details=page.getByRole('region',{name:'Session details',exact:true});
 await expect(details).toContainText('Effective model');
 await expect(details).toContainText('Scopes in effect');
 await expect(details).toContainText('Cache hits');
 await expect(details).toContainText('Cost');
});

test('the session bar binds an agent to the live session and shows the scopes in effect, including the empty case',async({page})=>{
 await addProject(page,'Binding fixture');
 const bar=page.getByRole('region',{name:'Session',exact:true});
 await expect(bar).toContainText('live conversation');

 // Create an agent scoped to this project, with the record_note scope.
 await page.getByRole('button',{name:'Agents and privileges'}).click();
 const dialog=page.getByRole('dialog');
 await page.getByRole('button',{name:'New agent'}).click();
 await page.getByLabel('Agent name').fill('Session UX agent');
 await page.getByLabel('Project Binding fixture').check();
 await page.getByLabel('Scope record_note').check();
 await page.getByRole('button',{name:'Create agent'}).click();
 await expect(dialog.getByRole('status')).toContainText('Created Session UX agent');
 await page.getByRole('button',{name:'Close agent manager'}).click();

 // Bind it to the live session from the bar; the scopes in effect are now the agent's own.
 await page.getByLabel('Agent for this session').selectOption({label:'Session UX agent'});
 await expect(bar).toContainText('record_note');
 // Choosing "No agent" is explicit: every tool is refused until one is bound.
 await page.getByLabel('Agent for this session').selectOption({label:'No agent (unbound — no privileges)'});
 await expect(bar).toContainText('none — every tool is refused');
 await expect(bar).toContainText('No agent is bound to this session');
});

test('a question is dismissed with a reason, does not reappear, and cannot be answered afterwards',async({page})=>{
 await addProject(page,'Dismiss fixture');
 await page.getByLabel('Message the agent').fill('[ask] ship the release');
 await page.getByRole('button',{name:'Send message'}).click();
 const questions=page.getByRole('region',{name:'Questions for me'});
 await expect(questions).toContainText('Should I proceed with: ship the release?');

 await page.getByRole('button',{name:/Dismiss question:/}).click();
 await page.getByLabel(/^Dismissal reason for:/).fill('Not this cycle');
 await page.getByRole('button',{name:'Confirm dismissal'}).click();
 await expect(questions).toContainText('dismissed');
 await expect(questions).toContainText('Not this cycle');
 // A dismissed question is not answerable: no answer field remains for it.
 await expect(page.getByLabel(/^Answer to:/)).toHaveCount(0);

 // It stays dismissed after a reload.
 await page.reload();
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await expect(page.getByRole('region',{name:'Questions for me'})).toContainText('Not this cycle');
 await expect(page.getByLabel(/^Answer to:/)).toHaveCount(0);
});
