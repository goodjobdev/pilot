import {test,expect} from '@playwright/test';

test('a stale CSRF token renews once and preserves the add-project form',async({page})=>{
 let posts=0,renewals=0;
 await page.route('**/api/session',async route=>{renewals++;await route.continue();});
 await page.route('**/api/projects',async route=>{
   if(route.request().method()==='POST'&&++posts===1){
     await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Session CSRF token required',code:'SESSION_CSRF'})});return;
   }
   await route.continue();
 });
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 const dialog=page.locator('dialog');
 await dialog.getByLabel('Project name').fill('CSRF renewal fixture');
 await dialog.getByRole('button',{name:'Confirm & add project'}).click();
 await expect(dialog).toHaveCount(0);
 await expect(page.locator('h1')).toHaveText('CSRF renewal fixture');
 expect(posts).toBe(2);expect(renewals).toBe(2);
});

test('a CSRF rejection that persists after renewal is not retried indefinitely',async({page})=>{
 let posts=0;
 await page.route('**/api/projects',async route=>{
   if(route.request().method()==='POST'){posts++;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Session CSRF token required',code:'SESSION_CSRF'})});return;}
   await route.continue();
 });
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 const dialog=page.locator('dialog');
 await dialog.getByLabel('Project name').fill('Persistent rejection');
 await dialog.getByRole('button',{name:'Confirm & add project'}).click();
 await expect(dialog.getByRole('alert')).toContainText('Session CSRF token required');
 expect(posts).toBe(2);
 await expect(dialog.getByLabel('Project name')).toHaveValue('Persistent rejection');
});

test('generic permission failures are not retried or disguised as session failures',async({page})=>{
 let posts=0;
 await page.route('**/api/projects',async route=>{
   if(route.request().method()==='POST'){posts++;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'Owner identity required'})});return;}
   await route.continue();
 });
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 const dialog=page.locator('dialog');
 await dialog.getByLabel('Project name').fill('No retry fixture');
 await dialog.getByRole('button',{name:'Confirm & add project'}).click();
 await expect(dialog.getByRole('alert')).toHaveText('Owner identity required');
 expect(posts).toBe(1);
});

test('an expired sign-in is reported as a sign-in problem, not a network failure',async({page})=>{
 // The sign-in layer answers an expired session with a redirect to its login page, which a
 // fetch cannot follow. Simulate exactly that response shape for the registration call.
 await page.addInitScript(()=>{
   const original=window.fetch.bind(window);
   window.fetch=async(input,init)=>{
     const url=typeof input==='string'?input:(input as Request).url;
     if(url.includes('/api/projects')&&(init?.method??'GET')==='POST'){
       return {type:'opaqueredirect',status:0,ok:false,redirected:false,json:async()=>({})} as unknown as Response;
     }
     return original(input,init);
   };
 });
 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Expired session fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();

 // The dialog explains the real cause and offers the way out.
 const dialog=page.locator('dialog');
 await expect(dialog.getByText(/Your sign-in has expired\. Reload the page to sign in again/)).toBeVisible();
 await expect(dialog.getByRole('button',{name:'Reload and sign in'})).toBeVisible();

 // And it is reported at the top level too, so a failed save is never silent.
 await dialog.getByRole('button',{name:'Cancel'}).click();
 const banner=page.locator('main .workspace-error');
 await expect(banner).toContainText('Your sign-in has expired');
 await expect(banner.getByRole('button',{name:'Reload and sign in'})).toBeVisible();
});