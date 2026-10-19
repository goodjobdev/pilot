import {test,expect} from '@playwright/test';
test('task editing, connectors, cycle rejection, drag persistence, undo and filtered context',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();await page.getByLabel('Project name').fill('Canvas fixture');await page.getByRole('button',{name:'Confirm & add project'}).click();
 async function add(title:string){await page.getByRole('button',{name:'＋ Task',exact:true}).click();await expect(page.getByLabel('Task title',{exact:true})).toHaveValue('New task');await page.getByLabel('Task title',{exact:true}).fill(title);await page.getByRole('button',{name:'Save task',exact:true}).click();await expect(page.getByRole('status')).toHaveText('Saved');}
 await add('Foundation A');await add('Delivery B');
 await page.getByRole('combobox',{name:'Other task',exact:true}).selectOption({label:'Foundation A'});await page.getByRole('button',{name:'Add relationship',exact:true}).click();await expect(page.getByRole('status')).toHaveText('Saved');
 await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
 await page.getByRole('combobox',{name:'Direction',exact:true}).selectOption('downstream');await page.getByRole('button',{name:'Add relationship',exact:true}).click();await expect(page.getByRole('alert')).toContainText('cycle');await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
 await page.getByRole('button',{name:'Close inspector'}).click();
 await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(page.locator('.svelte-flow__edge')).toHaveCount(0);await page.getByRole('button',{name:'Redo',exact:true}).click();await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
 const card=page.locator('.svelte-flow__node').filter({hasText:'Foundation A'});const initial=await card.getAttribute('style');const box=await card.boundingBox();if(!box)throw Error('No card box');
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+70,box.y+box.height/2+30,{steps:8});await page.mouse.up();await expect(page.getByRole('status')).toHaveText('Saved');
 const moved=await card.getAttribute('style');expect(moved).not.toBe(initial);await page.reload();await expect(page.getByRole('heading',{name:'Canvas fixture'})).toBeVisible();await expect(card).toHaveAttribute('style',new RegExp(moved!.match(/translate\(([^)]+)\)/)![1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 await page.getByLabel('Search tasks').fill('Delivery B');await expect(page.locator('.context-label')).toHaveText('FILTERED CONTEXT');
 expect(errors).toEqual([]);
});
