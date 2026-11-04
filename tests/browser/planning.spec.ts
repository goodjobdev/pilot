import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { newTask } from '../../src/shared/model';

test('returning from chat shows persisted planning changes without reloading the workspace', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '＋ Add project', exact: true }).first().click();
  await page.getByLabel('Project name').fill('Planning refresh fixture');
  await page.getByRole('button', { name: 'Confirm & add project' }).click();
  await expect(page.getByRole('heading', { name: 'Planning refresh fixture' })).toBeVisible();
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  const task = newTask(randomUUID(), 'Plan created while the conversation is open');
  const result = await page.evaluate(async (task) => {
    const id = new URL(location.href).searchParams.get('project')!;
    const token = document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
    const headers = { 'X-Dashboard-Token': token, 'Content-Type': 'application/json' };
    const before = await (await fetch('/api/projects/' + id + '/board', { headers })).json();
    const response = await fetch('/api/projects/' + id + '/board', { method: 'POST', headers, body: JSON.stringify({ revision: before.revision, operation: { op: 'putTask', task } }) });
    return response.status;
  }, task);
  expect(result).toBe(200);
  await page.getByRole('button', { name: 'Task', exact: true }).click();
  await expect(page.getByRole('button', { name: task.title })).toBeVisible();
  await expect(page.locator('.authority-badge')).toHaveCount(0);
});
