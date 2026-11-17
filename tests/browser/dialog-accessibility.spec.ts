import {test,expect} from '@playwright/test';

for (const viewport of [{width:1440,height:950},{width:390,height:844}]) {
 test('dialogs expose their visible title and restore keyboard focus at '+viewport.width+'px',async({page})=>{
  await page.setViewportSize(viewport);await page.goto('/');
  if(viewport.width<500)await page.getByRole('button',{name:'Show project sidebar'}).click();
  const add=page.getByRole('button',{name:'＋ Add project',exact:true}).first();
  await add.click();
  const adding=page.getByRole('dialog',{name:'Add a project',exact:true});await expect(adding).toBeVisible();
  await adding.getByLabel('Project name').fill('Dialog accessibility '+viewport.width);
  await adding.getByRole('button',{name:'Confirm & add project'}).click();await expect(adding).toBeHidden();
  if(viewport.width<500)await page.getByRole('button',{name:'Hide project sidebar'}).click();
  for(const [button,title] of [['Providers & models','Providers & models'],['Harness settings','Harness'],['Agents and privileges','Agents & privileges']] as const){
   const trigger=page.getByRole('button',{name:button,exact:true});await trigger.focus();await page.keyboard.press('Enter');
   const dialog=page.getByRole('dialog',{name:title,exact:true});await expect(dialog).toBeVisible();
   await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(trigger).toBeFocused();
  }
  await page.getByRole('button',{name:'Board actions',exact:true}).click();await page.getByRole('button',{name:'Areas & milestones',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Areas & milestones',exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Board actions',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Board actions',exact:true}).click();await page.getByRole('group',{name:'Board actions'}).getByRole('button',{name:'Import documents',exact:true}).click();
  const importing=page.getByRole('dialog',{name:'Import planning documents',exact:true});await expect(importing).toBeVisible();
  await importing.getByRole('button',{name:'Close import'}).click();await expect(page.getByRole('button',{name:'Board actions',exact:true})).toBeFocused();
 });
}
