import {test,expect} from '@playwright/test';

test('phone alerts can be enabled from the inbox, tested and turned off',async({page})=>{
 // The browser's own push plumbing is stubbed: a real push service is not reachable from a test.
 // Everything the application owns — permission flow, subscription POST, status, worker — is real.
 await page.addInitScript(() => {
   // A stateful stub: the browser remembers the subscription the way a real one does, so the
   // application's unsubscribe path is exercised rather than short-circuited.
   let subscribed = false;
   const subscription = {
     endpoint: 'https://push.example/device-under-test',
     toJSON: () => ({ endpoint: 'https://push.example/device-under-test', keys: { p256dh: 'BStubP256dhKeyValueForTests', auth: 'stubAuthValue' } }),
     unsubscribe: async () => { subscribed = false; return true; }
   };
   const registration = {
     scope: '/',
     pushManager: {
       getSubscription: async () => (subscribed ? subscription : null),
       subscribe: async () => { subscribed = true; return subscription; }
     }
   };
   Object.defineProperty(navigator,'serviceWorker',{ configurable: true, value: {
     register: async () => registration,
     getRegistration: async () => registration,
     addEventListener: () => {},
     removeEventListener: () => {}
   } });
   Object.defineProperty(window,'Notification',{ configurable: true, value: { permission: 'default', requestPermission: async () => 'granted' } });
   Object.defineProperty(window,'PushManager',{ configurable: true, value: class PushManager {} });
 });

 // The worker is served as JavaScript from the application's own origin.
 const worker=await page.request.get('/sw.js');
 expect(worker.status()).toBe(200);
 expect(worker.headers()['content-type']).toContain('javascript');
 const source=await worker.text();
 expect(source).toContain("addEventListener('push'");
 expect(source).toContain("addEventListener('notificationclick'");
 expect(source).toContain('showNotification');

 await page.goto('/');
 await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
 await page.getByLabel('Project name').fill('Alerts fixture');
 await page.getByRole('button',{name:'Confirm & add project'}).click();

 await page.getByRole('button',{name:/Needs me/}).click();
 await expect(page.getByText('Get a notification when an agent asks a question or finishes.')).toBeVisible();
 await page.getByRole('button',{name:'Enable phone alerts'}).click();
 await expect(page.getByText(/Alerts enabled on 1 device/)).toBeVisible();
 await expect(page.getByRole('button',{name:'Send a test alert'})).toBeVisible();

 // The instance recorded this device.
 const recorded=await page.evaluate(async()=>{
   const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
   return (await fetch('/api/alerts',{headers:{'X-Dashboard-Token':token}})).json();
 });
 expect(recorded.subscriptions).toBe(1);
 expect(recorded.enabled).toBe(true);

 // A test has no real push service, so the sender reports the refusal instead of pretending:
 // the success path is covered by the server test with a stubbed transport.
 await page.getByRole('button',{name:'Send a test alert'}).click();
 await expect(page.getByText(/push service refused it/)).toBeVisible();
 await page.getByRole('button',{name:'Turn off'}).click();
 await expect(page.getByText(/Alerts turned off/)).toBeVisible();
 const after=await page.evaluate(async()=>{
   const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
   return (await fetch('/api/alerts',{headers:{'X-Dashboard-Token':token}})).json();
 });
 expect(after.subscriptions).toBe(0);
});
