import { test, expect, type Page } from '@playwright/test';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The phone surface for bounded, owner-created workers (W1).
 *
 * The scenario uses the real routes, the real control store and the real scripted harness. It makes
 * no provider call, installs nothing and writes only inside this run's disposable project and data
 * root. It proves the owner-only creation, the pinned model, one bounded run with a canonical report
 * path, revocation, and a one-column phone layout with no horizontal overflow.
 */

async function token(page: Page): Promise<string> {
  return await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name=dashboard-token]')!.content);
}

async function apiGet(page: Page, path: string) {
  return await page.request.get(new URL(page.url()).origin + '/api' + path, { headers: { 'x-dashboard-token': await token(page) } });
}

test('workers: a phone owner creates a worker, runs it, reads the report path and revokes it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Show project sidebar' }).click();
  await page.getByRole('button', { name: '＋ Add project', exact: true }).first().click();
  const add = page.getByRole('dialog');
  await add.getByLabel('Project name').fill('Worker phone fixture');
  await add.getByRole('button', { name: 'Confirm & add project' }).click();
  // A new managed project may open the connection dialog; dismiss it if it is open.
  const connection = page.getByRole('dialog').filter({ hasText: 'Repository & deploy key' });
  if (await connection.isVisible().catch(() => false)) await connection.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Worker phone fixture' })).toBeVisible();

  const projects = await (await apiGet(page, '/projects')).json() as { id: string; name: string; path: string }[];
  const project = projects.find((candidate) => candidate.name === 'Worker phone fixture');
  expect(project).toBeTruthy();
  const base = new URL(page.url()).origin;
  const policyView = await (await apiGet(page, '/settings/model-policy')).json() as { revision: number; models: { provider: string; modelId: string; known: boolean; available: boolean }[] };
  const scripted = policyView.models.find((model) => model.provider === 'faux' && model.available);
  expect(scripted).toBeTruthy();
  const model = { provider: scripted!.provider, modelId: scripted!.modelId };
  const saved = await page.request.post(base + '/api/settings/model-policy', {
    headers: { 'x-dashboard-token': await token(page), origin: base, 'content-type': 'application/json' },
    data: { revision: policyView.revision, policy: { allowedWorkerModels: [model], defaultWorkerModel: model } }
  });
  expect(saved.ok()).toBe(true);

  await page.getByRole('button', { name: 'Workers', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'Bounded workers' });
  await expect(dialog.getByRole('heading', { name: 'Workers' })).toBeVisible();
  await expect(dialog).toContainText('Limits: 3 live workers per project');
  await expect(dialog).toContainText('8 model turns · 4096 output tokens per turn');
  await expect(dialog).toContainText('Reports are untrusted evidence and are never accepted automatically');
  await expect(dialog.getByLabel('Worker model')).toHaveValue(scripted!.provider + '/' + scripted!.modelId);

  await dialog.getByLabel('Worker name').fill('Phone reviewer');
  await dialog.getByRole('button', { name: 'Create worker' }).click();
  await expect(dialog.getByText('Phone reviewer', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('read_notes');
  await expect(dialog).toContainText('8 turns · 4096 output tokens per turn');

  // The layout is one column and fits the phone: no horizontal overflow inside the dialog.
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await dialog.getByRole('button', { name: 'Start one run' }).click();
  await expect(dialog).toContainText('Report docs/workers/', { timeout: 20_000 });
  await expect(dialog.getByText('completed', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  // The canonical report is authoritative. A manual edit is shown as an integrity warning in the
  // run view, not only logged on the server.
  const runsBefore = await (await apiGet(page, '/projects/' + project!.id + '/workers')).json() as { runs: { id: string; state: string; report: { path: string } | null }[] };
  const completedRun = runsBefore.runs.find((run) => run.state === 'completed')!;
  await appendFile(join(project!.path, completedRun.report!.path), '\nOwner edit.\n', 'utf8');
  await expect(dialog).toContainText('The canonical report is changed since tracking', { timeout: 10_000 });

  page.once('dialog', (confirmation) => void confirmation.accept());
  await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(dialog).toContainText('Revoked. It can start no run; its records stay as history.');
  await expect(dialog.getByRole('button', { name: 'Start one run' })).toHaveCount(0);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  // The canonical report exists in the project, and the run view never returned its content.
  const runs = await (await apiGet(page, '/projects/' + project!.id + '/workers')).json() as { runs: { id: string; state: string; report: { path: string } | null }[] };
  const completed = runs.runs.find((run) => run.state === 'completed');
  expect(completed?.report?.path).toMatch(/^docs\/workers\/w-[a-f0-9-]+\/r-[a-f0-9-]+\.md$/);
  const report = await page.request.get(base + '/api/projects/' + project!.id + '/workers/runs/' + completed!.id, { headers: { 'x-dashboard-token': await token(page) } });
  expect(await report.text()).not.toContain('Scripted test reply');
});

test('workers: a hostile report stays inert in the document view', async ({ page }) => {
  await page.goto('/');
  const token = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name=dashboard-token]')!.content);
  const base = new URL(page.url()).origin;
  const headers = { 'x-dashboard-token': token, origin: base, 'content-type': 'application/json' };
  const created = await page.request.post(base + '/api/projects', { headers, data: { name: 'Hostile report fixture', managed: true, confirm: true } });
  expect(created.ok()).toBe(true);
  const project = await created.json() as { id: string };
  const hostile = [
    '# Hostile report',
    '',
    '> Untrusted evidence. This report was produced by a worker model.',
    '',
    '<script>window.__workerXss = 1</script>',
    '',
    '<img src="x" onerror="window.__workerXss = 2">',
    '',
    '<div onclick="window.__workerXss = 3">click me</div>',
    '',
    '[a link](javascript:window.__workerXss=4)',
    '',
    'Visible evidence text.'
  ].join('\n');
  const saved = await page.request.post(base + '/api/projects/' + project.id + '/docs/document', {
    headers,
    data: { path: 'docs/workers/hostile.md', text: hostile }
  });
  expect(saved.ok()).toBe(true);
  await page.goto('/?project=' + project.id + '&view=Wiki&doc=' + encodeURIComponent('docs/workers/hostile.md'));
  await expect(page.getByRole('heading', { name: 'Hostile report', exact: true })).toBeVisible();
  await expect(page.getByText('Visible evidence text.')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __workerXss?: number }).__workerXss)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.innerHTML.includes('window.__workerXss'))).toBe(false);
  expect(await page.evaluate(() => document.querySelectorAll('[onclick], [onerror]').length)).toBe(0);
  expect(await page.evaluate(() => [...document.querySelectorAll('a')].some((link) => (link.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:')))).toBe(false);
});
