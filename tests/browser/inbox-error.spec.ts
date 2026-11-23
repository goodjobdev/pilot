import { test, expect } from '@playwright/test';

async function addProject(page: import('@playwright/test').Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: '＋ Add project', exact: true }).first().click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Confirm & add project' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const projectId = new URL(page.url()).searchParams.get('project');
  if (!projectId) throw Error('disposable test project was not selected');
  return projectId;
}

test('question inbox reports a safe error and Retry clears it after a successful fetch', async ({ page }) => {
  const projectId = await addProject(page, 'Inbox error fixture');
  let requests = 0;
  await page.route('**/api/projects/' + projectId + '/docs/inbox', async route => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'private backend detail /secret/path' }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [{ path: 'docs/retry.md', line: 4, text: 'Retry loaded questions', anchor: null, id: 'retry-loaded' }] }) });
    }
  });

  await page.getByRole('button', { name: /Needs me/ }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Open questions are temporarily unavailable' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Try again');
  await expect(alert).not.toContainText('private backend detail');
  await expect(page.getByRole('group', { name: 'Needs me' })).not.toContainText('Nothing needs you.');
  const retryResponse = page.waitForResponse(response => response.url().includes('/projects/' + projectId + '/docs/inbox') && response.status() === 200);
  await alert.getByRole('button', { name: 'Retry' }).click();
  await retryResponse;
  await expect(alert).toHaveCount(0);
  const needsMe = page.getByRole('button', { name: /Needs me/ });
  if (await needsMe.getAttribute('aria-expanded') !== 'true') await needsMe.click();
  await expect(page.locator('.inbox-text')).toContainText('Retry loaded questions');
});

test('an older same-project inbox failure cannot overwrite a newer successful load', async ({ page }) => {
  const observedInboxResponses: string[] = [];
  page.on('response', response => { if (new URL(response.url()).pathname.endsWith('/docs/inbox')) observedInboxResponses.push(response.url()); });
  const projectId = await addProject(page, 'Inbox generation fixture');
  await expect.poll(() => observedInboxResponses.some(url => new URL(url).pathname.includes('/projects/' + projectId + '/docs/inbox'))).toBe(true);
  let releaseOldFailure: (() => Promise<void>) | undefined;
  let requests = 0;
  await page.route('**/api/projects/' + projectId + '/docs/inbox', async route => {
    requests += 1;
    if (requests === 1) {
      await new Promise<void>(resolve => {
        releaseOldFailure = async () => {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }) });
          resolve();
        };
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [{ path: 'docs/current.md', line: 1, text: 'Current loaded question', anchor: null, id: 'current-loaded' }] }) });
  });
  const openButton = page.getByRole('button', { name: /Needs me/ });
  await openButton.click();
  await expect(openButton).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => requests).toBe(1);
  await openButton.click();
  await expect(openButton).toHaveAttribute('aria-expanded', 'false');
  await openButton.click();
  await expect(openButton).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('.inbox-text')).toContainText('Current loaded question');
  if (!releaseOldFailure) throw Error('older inbox request was not held');
  const lateFailure = page.waitForResponse(response => response.url().includes('/projects/' + projectId + '/docs/inbox') && response.status() === 503);
  await releaseOldFailure();
  await lateFailure;
  await expect(page.locator('.inbox-text')).toContainText('Current loaded question');
  await expect(page.getByRole('alert').filter({ hasText: 'Open questions are temporarily unavailable' })).toHaveCount(0);
});

test('a held inbox failure from A cannot replace B while B inbox remains open', async ({ page }) => {
  const observed: string[] = [];
  page.on('response', response => { if (new URL(response.url()).pathname.endsWith('/docs/inbox')) observed.push(response.url()); });
  const projectA = await addProject(page, 'Inbox switch A');
  await expect.poll(() => observed.some(url => new URL(url).pathname.includes('/projects/' + projectA + '/docs/inbox'))).toBe(true);

  let releaseA: (() => Promise<void>) | undefined;
  await page.route('**/api/projects/*/docs/inbox', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.includes('/projects/' + projectA + '/docs/inbox')) {
      await new Promise<void>(resolve => {
        releaseA = async () => {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }) });
          resolve();
        };
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [{ path: 'docs/project-b.md', line: 2, text: 'B inbox loaded', anchor: null, id: 'b-loaded' }] }) });
  });

  const needsMe = page.getByRole('button', { name: /Needs me/ });
  await needsMe.click();
  await expect.poll(() => Boolean(releaseA)).toBe(true);
  await page.getByRole('button', { name: '＋ Add project', exact: true }).first().click();
  await page.getByLabel('Project name').fill('Inbox switch B');
  await page.getByRole('button', { name: 'Confirm & add project' }).click();
  await expect(page.getByRole('heading', { name: 'Inbox switch B', exact: true })).toBeVisible();
  const projectB = new URL(page.url()).searchParams.get('project');
  expect(projectB).not.toBe(projectA);
  if (await needsMe.getAttribute('aria-expanded') !== 'true') await needsMe.click();
  await expect(needsMe).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.inbox-text')).toContainText('B inbox loaded');

  if (!releaseA) throw Error('A inbox request was not held');
  const lateFailure = page.waitForResponse(response => response.url().includes('/projects/' + projectA + '/docs/inbox') && response.status() === 503);
  await releaseA();
  await lateFailure;
  await expect(page.getByRole('heading', { name: 'Inbox switch B', exact: true })).toBeVisible();
  await expect(needsMe).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.inbox-text')).toContainText('B inbox loaded');
  await expect(page.locator('.inbox-load-error')).toHaveCount(0);
});
