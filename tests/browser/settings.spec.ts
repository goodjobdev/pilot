import {test,expect} from '@playwright/test';

test('provider credentials, defaults and favourites can be managed from the UI without a model call',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'Providers & models',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await expect(dialog.getByRole('heading',{name:'Providers & models'})).toBeVisible();
 await dialog.getByLabel('Provider',{exact:true}).selectOption('openai');
 await dialog.getByLabel('Provider API key').fill('browser-fake-key-not-a-credential');
 await dialog.getByRole('button',{name:/Save API key|Replace API key/}).click();
 await expect(dialog.getByText('Credential saved on the server. No model call was made.')).toBeVisible();
 const models=await page.evaluate(async()=>{const token=document.querySelector<HTMLMetaElement>('meta[name=dashboard-token]')!.content;return (await (await fetch('/api/settings/providers',{headers:{'x-dashboard-token':token}})).json()).models.filter((m:any)=>m.provider==='openai');});
 const chosen=models.at(-1);
 await dialog.getByLabel('Search models').fill(chosen.modelId);
 await dialog.getByRole('button',{name:'Favourite openai/'+chosen.modelId,exact:true}).click();
 await expect(dialog.getByRole('button',{name:'Unfavourite openai/'+chosen.modelId,exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'Set default openai/'+chosen.modelId,exact:true}).click();
 await expect(dialog.getByRole('button',{name:'Set default openai/'+chosen.modelId,exact:true})).toBeDisabled();
 await dialog.getByLabel('Search models').fill('');
 await expect(dialog.locator('.model-row').first()).toContainText(chosen.name);
 await expect(dialog.getByLabel(/Allow real model calls/)).not.toBeChecked();
 await page.reload();
 await page.getByRole('button',{name:'Providers & models',exact:true}).click();
 await expect(dialog.locator('.model-row').first()).toContainText(chosen.name);
 await expect(dialog.getByLabel('Provider API key')).toHaveValue('');
 // Restore the free default for all later fixtures; no provider request is sent.
 await dialog.getByRole('button',{name:'Use scripted default'}).click();
 await expect(dialog.getByText('Scripted test provider (free)',{exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'Disconnect provider'}).click();
 await expect(dialog.getByText('Provider disconnected.',{exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'Done',exact:true}).click();
});

test('a phone user can add a repository and manage its public deploy key',async({page})=>{
 await page.setViewportSize({width:412,height:915});
 await page.goto('/');
 await page.getByRole('button',{name:'Show project sidebar'}).click();
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 let dialog=page.getByRole('dialog');
 await dialog.getByLabel('Project name').fill('Repository phone fixture');
 await dialog.getByLabel(/Repository URL/).fill('https://github.com/example/disposable.git');
 await dialog.getByRole('button',{name:'Confirm & add project'}).click();
 dialog=page.getByRole('dialog');
 await expect(dialog.getByRole('heading',{name:'Repository & deploy key'})).toBeVisible();
 await dialog.getByRole('button',{name:'Generate project deploy key',exact:true}).click();
 await expect(dialog.getByLabel('Project public deploy key')).toHaveValue(/^ssh-ed25519 /);
 const value=await dialog.getByLabel('Project public deploy key').inputValue();
 await expect(dialog.getByRole('link',{name:/Open GitHub deploy keys/})).toHaveAttribute('href','https://github.com/example/disposable/settings/keys');
 await expect(dialog.getByRole('button',{name:'Connect repository worktree',exact:true})).toBeDisabled();
 expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
 await dialog.getByRole('button',{name:'Done',exact:true}).click();
 await page.reload();
 await page.getByRole('button',{name:'Board actions',exact:true}).click();
 await page.getByRole('button',{name:'Repository & deploy key',exact:true}).click();
 await expect(page.getByLabel('Project public deploy key')).toHaveValue(value);
 page.once('dialog',d=>void d.accept());
 await page.getByRole('button',{name:'Remove key',exact:true}).click();
 await expect(page.getByRole('button',{name:'Generate project deploy key',exact:true})).toBeVisible();
});
