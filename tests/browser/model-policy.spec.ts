import { test, expect, type Page } from '@playwright/test';
import { WORKER_MODEL_POLICY_READBACK_UNCERTAIN } from '../../src/shared/model-policy-codes';

/**
 * The worker model policy configures allowed models and the default for new owner-created workers.
 *
 * These scenarios use the real settings route and the real control store. They make no provider
 * call, open no harness and start no worker. They prove the separate choices, the explicit
 * default-removal refusal, draft preservation on a conflict, the deliberate reload, the phone
 * layout, and that the interface never calls a worker model effective.
 */

type PolicyView = {
  revision: number;
  models: { provider: string; modelId: string; known: boolean; available: boolean }[];
};

async function token(page: Page): Promise<string> {
  return await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name=dashboard-token]')!.content);
}

async function readPolicy(page: Page): Promise<PolicyView> {
  const base = new URL(page.url()).origin;
  const response = await page.request.get(base + '/api/settings/model-policy', { headers: { 'x-dashboard-token': await token(page) } });
  expect(response.ok()).toBe(true);
  return await response.json() as PolicyView;
}

/** Clear the policy through the same authenticated route, so tests do not depend on each other. */
async function resetPolicy(page: Page): Promise<void> {
  await page.goto('/');
  const base = new URL(page.url()).origin;
  const current = await readPolicy(page);
  const response = await page.request.post(base + '/api/settings/model-policy', {
    headers: { 'x-dashboard-token': await token(page), origin: base, 'content-type': 'application/json' },
    data: { revision: current.revision, policy: { allowedWorkerModels: [], defaultWorkerModel: null } }
  });
  expect(response.ok()).toBe(true);
}

async function openPolicy(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Providers & models', exact: true }).click();
  return page.getByRole('dialog').getByRole('group', { name: 'Worker model policy' });
}

async function catalogKeys(page: Page, count = 2): Promise<string[]> {
  const view = await readPolicy(page);
  const keys = view.models.filter((model) => model.known).slice(0, count).map((model) => model.provider + '/' + model.modelId);
  expect(keys.length).toBeGreaterThanOrEqual(count);
  return keys;
}

async function addAndSave(worker: ReturnType<Page['getByRole']>, key: string): Promise<void> {
  await worker.getByLabel('Worker model to add').selectOption(key);
  await worker.getByRole('button', { name: 'Add worker model' }).click();
  await worker.getByRole('button', { name: 'Save worker model policy' }).click();
}

function modelRow(worker: ReturnType<Page['getByRole']>, key: string) {
  return worker.locator('[data-model-key="' + key + '"]');
}

test('the owner can configure worker models separately from the orchestrator default', async ({ page }) => {
  await resetPolicy(page);
  const worker = await openPolicy(page);
  await expect(worker).toBeVisible();
  await expect(worker).toContainText('Owner-created workers use the allowed set and default below');
  await expect(worker).toContainText('Existing workers keep their pinned model');
  await expect(worker).toContainText('This view does not measure worker cost or perform a provider health probe');
  await expect(worker).not.toContainText('No worker runs exist in this build');
  await expect(worker).toContainText('A model marked available means only that a provider credential is saved');
  await expect(worker).toContainText('An existing session or a bound agent may use a different model');

  const [key] = await catalogKeys(page);
  // Add one catalog model and choose it as the future worker default.
  await worker.getByLabel('Worker model to add').selectOption(key);
  await worker.getByRole('button', { name: 'Add worker model' }).click();
  await expect(modelRow(worker, key)).toBeVisible();
  await worker.getByLabel('Default worker model').selectOption(key);
  await worker.getByRole('button', { name: 'Save worker model policy' }).click();
  await expect(worker.getByRole('status')).toContainText('Worker model policy saved. Owner-created workers use this allowed set and default. Existing workers keep their pinned model.');

  // The policy survives a reload, so the choice is durable and not a view-only value.
  await page.reload();
  await page.getByRole('button', { name: 'Providers & models', exact: true }).click();
  const reopened = page.getByRole('dialog').getByRole('group', { name: 'Worker model policy' });
  await expect(modelRow(reopened, key)).toBeVisible();
  await expect(reopened.getByLabel('Default worker model')).toHaveValue(key);

  // Removing the default from the allowed set is a named refusal. It is never replaced.
  await reopened.getByRole('button', { name: 'Remove worker model ' + key }).click();
  await expect(reopened.getByRole('alert').filter({ hasText: 'not in the allowed worker set' })).toBeVisible();
  await reopened.getByRole('button', { name: 'Save worker model policy' }).click();
  await expect(reopened.getByRole('alert').filter({ hasText: 'clear defaultWorkerModel explicitly' })).toBeVisible();

  // The explicit clear is the owner decision, and then the empty set saves as an empty set.
  await reopened.getByRole('button', { name: 'Clear worker default' }).click();
  await reopened.getByRole('button', { name: 'Save worker model policy' }).click();
  await expect(reopened.getByRole('status')).toContainText('Worker model policy saved.');
  await expect(reopened).toContainText('No worker model is allowed yet');
});

test('a stale save keeps the draft, and explicit adoption saves it over the newer revision', async ({ page, context }) => {
  await resetPolicy(page);
  const [keyA, keyB] = await catalogKeys(page);
  const other = await context.newPage();
  try {
    const workerA = await openPolicy(page);
    const workerB = await openPolicy(other);
    // Both tabs read the same revision before either writes.
    await addAndSave(workerA, keyA);
    await expect(workerA.getByRole('status')).toContainText('Worker model policy saved.');

    await addAndSave(workerB, keyB);
    await expect(workerB.getByRole('alert').filter({ hasText: 'Revision conflict. Your draft is preserved.' })).toBeVisible();
    // The draft is still on screen; the saved value from the other tab did not overwrite it.
    await expect(modelRow(workerB, keyB)).toBeVisible();
    await expect(modelRow(workerB, keyA)).toHaveCount(0);

    // Review the latest revision without replacing the draft. The difference is explicit.
    await workerB.getByRole('button', { name: 'Review latest revision' }).click();
    await expect(workerB.getByRole('group', { name: 'Latest revision review' })).toBeVisible();
    await expect(workerB.getByText(/Your draft choices not on the server:/)).toContainText(keyB);
    await expect(workerB.getByText(/Server choices not in your draft:/)).toContainText(keyA);
    await expect(workerB).toContainText('replaces the newer server choices with your draft');
    // The draft is still intact while the review is open.
    await expect(modelRow(workerB, keyB)).toBeVisible();

    // The explicit confirmation moves the CAS base and saves the draft over the newer choice.
    await workerB.getByRole('button', { name: 'Use latest revision and save my choices' }).click();
    await expect(workerB.getByRole('status')).toContainText('Worker model policy saved.');
    await expect(modelRow(workerB, keyB)).toBeVisible();
    await expect(modelRow(workerB, keyA)).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('a third writer during the review makes the rebase conflict again and preserves the draft', async ({ page, context }) => {
  await resetPolicy(page);
  const [keyA, keyB, keyC] = await catalogKeys(page, 3);
  const second = await context.newPage();
  const third = await context.newPage();
  try {
    const workerA = await openPolicy(page);
    const workerB = await openPolicy(second);
    // Both tabs read revision 0. A writes first.
    await addAndSave(workerA, keyA);
    await expect(workerA.getByRole('status')).toContainText('Worker model policy saved.');
    await addAndSave(workerB, keyB);
    await expect(workerB.getByRole('alert').filter({ hasText: 'Revision conflict. Your draft is preserved.' })).toBeVisible();

    // B reviews revision 1. A third writer then reads revision 1 and writes revision 2.
    await workerB.getByRole('button', { name: 'Review latest revision' }).click();
    await expect(workerB.getByRole('group', { name: 'Latest revision review' })).toBeVisible();
    const workerC = await openPolicy(third);
    await addAndSave(workerC, keyC);
    await expect(workerC.getByRole('status')).toContainText('Worker model policy saved.');

    // B's base is still revision 1, so the confirmation is refused again. The draft is preserved.
    await workerB.getByRole('button', { name: 'Use latest revision and save my choices' }).click();
    await expect(workerB.getByRole('alert').filter({ hasText: 'Revision conflict. Your draft is preserved.' })).toBeVisible();
    await expect(modelRow(workerB, keyB)).toBeVisible();

    // Reviewing again shows the newest revision and the newer choice, then the save succeeds.
    await workerB.getByRole('button', { name: 'Review latest revision' }).click();
    await expect(workerB.getByRole('group', { name: 'Latest revision review' })).toBeVisible();
    await expect(workerB.getByText(/Server choices not in your draft:/)).toContainText(keyC);
    await workerB.getByRole('button', { name: 'Use latest revision and save my choices' }).click();
    await expect(workerB.getByRole('status')).toContainText('Worker model policy saved.');
    await expect(modelRow(workerB, keyB)).toBeVisible();
    await expect(modelRow(workerB, keyC)).toHaveCount(0);
  } finally {
    await second.close();
    await third.close();
  }
});

test('phone settings keep save, conflict and controls inside the viewport', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await resetPolicy(page);
  const [keyA, keyB] = await catalogKeys(page);
  const desktop = await context.newPage();
  try {
    const phoneWorker = await openPolicy(page);
    const desktopWorker = await openPolicy(desktop);
    await addAndSave(desktopWorker, keyA);
    await expect(desktopWorker.getByRole('status')).toContainText('Worker model policy saved.');

    await addAndSave(phoneWorker, keyB);
    await expect(phoneWorker.getByRole('alert').filter({ hasText: 'Revision conflict. Your draft is preserved.' })).toBeVisible();
    await expect(phoneWorker.getByRole('button', { name: 'Reload current policy and discard my draft' })).toBeVisible();
    expect(await page.getByRole('dialog').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    // A deliberate reload works on the phone, and a later save succeeds there too.
    await phoneWorker.getByRole('button', { name: 'Reload current policy and discard my draft' }).click();
    await expect(modelRow(phoneWorker, keyA)).toBeVisible();
    await addAndSave(phoneWorker, keyB);
    await expect(phoneWorker.getByRole('status')).toContainText('Worker model policy saved.');
  } finally {
    await desktop.close();
  }
});

test('an uncertain write keeps the draft and offers a deliberate reload', async ({ page }) => {
  await resetPolicy(page);
  const [key] = await catalogKeys(page);
  const worker = await openPolicy(page);
  await page.route('**/api/settings/model-policy', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The worker model policy was written, but the current policy could not be read back. The saved value may be the new revision. Reload the current policy before you save again.', code: WORKER_MODEL_POLICY_READBACK_UNCERTAIN })
      });
    } else {
      await route.continue();
    }
  });
  await addAndSave(worker, key);
  await expect(worker.getByRole('alert').filter({ hasText: 'The write result is uncertain. Your draft is preserved.' })).toBeVisible();
  await expect(modelRow(worker, key)).toBeVisible();
  await expect(worker.getByRole('button', { name: 'Reload current policy and discard my draft' })).toBeVisible();
  await expect(worker.getByRole('button', { name: 'Keep my draft' })).toBeVisible();
  // Keeping the draft dismisses only the choice; the draft itself stays.
  await worker.getByRole('button', { name: 'Keep my draft' }).click();
  await expect(worker.getByRole('button', { name: 'Reload current policy and discard my draft' })).toHaveCount(0);
  await expect(modelRow(worker, key)).toBeVisible();
});

test('a 500 without the readback machine code is not treated as an uncertain readback', async ({ page }) => {
  await resetPolicy(page);
  const [key] = await catalogKeys(page);
  const worker = await openPolicy(page);
  await page.route('**/api/settings/model-policy', async (route) => {
    if (route.request().method() === 'POST') {
      // Same English text, no machine code. The UI must use the code, not the text.
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The worker model policy was written, but the current policy could not be read back.' })
      });
    } else {
      await route.continue();
    }
  });
  await addAndSave(worker, key);
  await expect(worker.getByRole('alert').filter({ hasText: 'The worker model policy could not be read or saved. Your draft is preserved.' })).toBeVisible();
  await expect(worker.getByRole('button', { name: 'Reload current policy and discard my draft' })).toHaveCount(0);
  await expect(modelRow(worker, key)).toBeVisible();
});
