import {test,expect} from '@playwright/test';

/**
 * The command palette: one surface driven entirely by the registry.
 *
 * The assertions read the registry through the same authenticated API the palette uses, so the test
 * fails if the client ever lists a capability the server does not serve, or stops listing one it does.
 */
async function readRegistry(page:import('@playwright/test').Page){
 return await page.evaluate(async()=>{
  const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
  const headers={'X-Dashboard-Token':token};
  const projects=await (await fetch('/api/projects',{headers})).json();
  const project=projects.find((candidate:{name:string})=>candidate.name==='Palette fixture');
  const listed=await (await fetch('/api/actions?projectId='+encodeURIComponent(project.id),{headers})).json();
  const sessions=await (await fetch('/api/sessions?projectId='+encodeURIComponent(project.id),{headers})).json();
  return {
   projectId:project.id as string,
   actions:listed.actions.map((action:{id:string;label:string})=>({id:action.id,label:action.label})),
   sessions:sessions.sessions.map((session:{name:string})=>session.name)
  };
 });
}
type ProjectedSession={id:string;name:string;run:{recorded:boolean;state:string|null;revision:number;absenceReason:string|null}};
type Projection={sessions:ProjectedSession[];harness:{state:string;reason:string|null}};
/** The live projection, read exactly as the palette reads it: the durable run state and tool activity. */
async function readProjection(page:import('@playwright/test').Page,projectId:string):Promise<Projection>{
 return await page.evaluate(async(id:string)=>{
  const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
  const activity=await (await fetch('/api/actions/activity?projectId='+encodeURIComponent(id),{headers:{'X-Dashboard-Token':token}})).json();
  return {
   sessions:activity.sessions.map((entry:{sessionId:string;name:string;run:{recorded:boolean;state:string|null;revision:number;absenceReason:string|null}})=>({id:entry.sessionId,name:entry.name,run:entry.run})),
   harness:{state:activity.harness.state,reason:activity.harness.reason}
  };
 },projectId) as Projection;
}

test('the command palette is driven by the registry, executes a real action and shows a refusal',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 // The palette must really read the live projection: the reader is recorded, not assumed.
 const activityRequests:string[]=[];
 page.on('request',request=>{if(request.url().includes('/api/actions/activity'))activityRequests.push(request.url());});
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Palette fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();
 await expect(page.getByRole('heading',{name:'Palette fixture'})).toBeVisible();

 // A text field has focus: the shortcut does not swallow the keystroke and does not open the palette.
 await page.getByLabel('Search tasks').focus();
 await page.keyboard.press('Control+k');
 await expect(page.getByRole('dialog',{name:'Command palette'})).toHaveCount(0);

 // Opened from the keyboard on the board itself.
 await page.getByRole('heading',{name:'Palette fixture'}).click();
 await page.keyboard.press('Control+k');
 const palette=page.getByRole('dialog',{name:'Command palette'});
 await expect(palette).toBeVisible();
 await expect(palette.getByLabel('Search actions')).toBeFocused();

 // The list is exactly the registry's, action for action: nothing is hardcoded in the client.
 const registry=await readRegistry(page);
 expect(registry.actions.length).toBeGreaterThan(0);
 for(const action of registry.actions)await expect(palette.getByRole('button',{name:action.label,exact:true})).toHaveCount(1);
 await expect(palette.locator('.palette-list button')).toHaveCount(registry.actions.length);
 // No capability outside the registry is offered, and none of the out-of-scope ones is stubbed in.
 for(const absent of ['Commit','Push','Deploy','Publish release','Start the coding runner'])await expect(palette.getByRole('button',{name:absent,exact:true})).toHaveCount(0);
 // ...and only the ones this scope can use: a session-scoped action needs a session.
 await expect(palette.getByRole('button',{name:'Stop session',exact:true})).toHaveCount(0);

 // The live projection is a client surface, and it names what it cannot report instead of filling it.
 const projection=await readProjection(page,registry.projectId);
 await expect(palette.getByLabel('Live projection')).toContainText(projection.harness.reason!,{timeout:20000});
 await expect(palette.getByLabel('Live projection')).toContainText('No named session is registered for this project',{timeout:20000});
 expect(activityRequests.length).toBeGreaterThan(0);

 // Filtering is by label and by id, from the registry's own text.
 await palette.getByLabel('Search actions').fill('session.create');
 await expect(palette.locator('.palette-list button')).toHaveCount(1);
 await expect(palette.getByRole('button',{name:'Create session',exact:true})).toBeVisible();
 await palette.getByLabel('Search actions').fill('No such capability');
 await expect(palette.getByText(/No action of the registry matches/)).toBeVisible();
 await palette.getByLabel('Search actions').fill('');

 // One real action, executed through the API, reported with the handler's own result.
 await palette.getByRole('button',{name:'Create session',exact:true}).click();
 await palette.locator('input[aria-label="name"]').fill('Palette session');
 await palette.getByRole('button',{name:'Execute action'}).click();
 await expect(palette.getByLabel('Action result payload')).toContainText('Palette session');
 expect((await readRegistry(page)).sessions).toContain('Palette session');
 // The new session has no durable lifecycle row, and the panel says exactly that: an absence by
 // name, never the state 'idle' the store happens to read at.
 await expect(palette.getByLabel('Live projection')).toContainText('no-durable-lifecycle-record-yet',{timeout:20000});

 // A refusal is shown as the server's own words, never swallowed.
 await palette.getByRole('button',{name:'Execute action'}).click();
 await expect(palette.locator('.error')).toContainText('already has a live session named Palette session');

 // The declared model choice is a parameter that really works: the palette parses the JSON the
 // registry declares, and the handler records the choice it was given.
 await palette.getByRole('button',{name:'Back to the list'}).click();
 await palette.getByRole('button',{name:'Create session',exact:true}).click();
 await palette.locator('input[aria-label="name"]').fill('Modelled session');
 await palette.locator('textarea[aria-label="model"]').fill('{"provider":"scripted","modelId":"scripted-1"}');
 await palette.getByRole('button',{name:'Execute action'}).click();
 const modelled=palette.getByLabel('Action result payload');
 await expect(modelled).toContainText('"provider": "scripted"');
 await expect(modelled).toContainText('"modelId": "scripted-1"');

 // A session-scoped action appears once a session is chosen, and the scope is the chosen one.
 await palette.getByRole('button',{name:'Back to the list'}).click();
 await palette.getByLabel('Session scope').selectOption({label:'Palette session'});
 await expect(palette.getByRole('button',{name:'Stop session',exact:true})).toHaveCount(1);

 // A revision-bound action on a session that already has a revision: the palette sends the revision
 // the server reports, so the write succeeds instead of being refused as a conflict.
 await palette.getByRole('button',{name:'Rename session',exact:true}).click();
 await expect(palette.locator('input[aria-label="revision"]')).toHaveValue('1');
 await palette.locator('input[aria-label="name"]').fill('Palette session renamed');
 await palette.getByRole('button',{name:'Execute action'}).click();
 await expect(palette.getByLabel('Action result payload')).toContainText('Palette session renamed');
 // ...and again above that: the second write is at the revision the session now really holds.
 await palette.getByRole('button',{name:'Back to the list'}).click();
 await palette.getByRole('button',{name:'Rename session',exact:true}).click();
 await expect(palette.locator('input[aria-label="revision"]')).toHaveValue('2');
 await palette.locator('input[aria-label="name"]').fill('Palette session renamed twice');
 await palette.getByRole('button',{name:'Execute action'}).click();
 await expect(palette.getByLabel('Action result payload')).toContainText('Palette session renamed twice');

 // A lifecycle action is offered with the revision the live projection reports for that session —
 // the durable record, which is the one the store compares against.
 await palette.getByRole('button',{name:'Back to the list'}).click();
 const lifecycle=await readProjection(page,registry.projectId);
 const chosen=lifecycle.sessions.find(entry=>entry.name==='Palette session renamed twice')!;
 await palette.getByRole('button',{name:'Stop session',exact:true}).click();
 await expect(palette.locator('input[aria-label="revision"]')).toHaveValue(String(chosen.run.revision));
 await palette.getByRole('button',{name:'Execute action'}).click();
 await expect(palette.getByLabel('Action result payload')).toContainText('"unchanged": true');

 // The revision is never assumed: with the live projection unreadable, the field stays empty and the
 // palette refuses to send a number the caller did not supply, in the parameter's own words.
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog',{name:'Command palette'})).toHaveCount(0);
 await page.route('**/api/actions/activity*',route=>route.abort());
 await page.getByRole('heading',{name:'Palette fixture'}).click();
 await page.keyboard.press('Control+k');
 await expect(palette).toBeVisible();
 await palette.getByLabel('Session scope').selectOption({label:'Palette session renamed twice'});
 await palette.getByRole('button',{name:'Stop session',exact:true}).click();
 await expect(palette.locator('input[aria-label="revision"]')).toHaveValue('');
 await palette.getByRole('button',{name:'Execute action'}).click();
 await expect(palette.locator('.error')).toContainText('revision parameter is required');
 await page.unroute('**/api/actions/activity*');

 // Escape closes it, and the board is still the board.
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog',{name:'Command palette'})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Palette fixture'})).toBeVisible();
 expect(errors).toEqual([]);
});
