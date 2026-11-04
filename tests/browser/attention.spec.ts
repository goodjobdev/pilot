import { test, expect } from '@playwright/test';
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { SessionLifecycleStore, adoptRunningSessions } from '../../src/server/state/session-lifecycle';

/**
 * The data root the browser server really uses. The server creates one random marker for this run
 * in the ignored test-output directory, exclusively with mode 0600. The test discovers it by its
 * random name and refuses anything that is not a private regular file: a symlink is never followed,
 * and a fixed shared path is not used.
 */
async function browserDataRoot(): Promise<string> {
  const directory = join(process.cwd(), 'test-results');
  const markers = (await readdir(directory)).filter(name => /^attention-fixture-[a-f0-9]{32}\.root$/.test(name));
  if (markers.length !== 1) throw Error('expected exactly one attention data-root marker for this run, found ' + markers.length);
  const file = join(directory, markers[0]);
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw Error('the data-root marker is not a regular file');
  if ((info.mode & 0o077) !== 0) throw Error('the data-root marker is not private to this user');
  return (await readFile(file, 'utf8')).trim();
}

/** One owner-only API call with the page's own token, exactly as the interface makes it. */
async function api(page: import('@playwright/test').Page, path: string, method = 'GET', body?: unknown) {
  return await page.evaluate(async ({ path, method, body }) => {
    const token = document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
    const response = await fetch('/api' + path, {
      method,
      headers: { 'X-Dashboard-Token': token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { path, method, body });
}

async function addProject(page: import('@playwright/test').Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: '＋ Add project', exact: true }).first().click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Confirm & add project' }).click();
  // The click resolves when the event was dispatched, not when the registration request has
  // committed, so the listing is polled instead of read once: a single read raced the in-flight
  // request under load and reported a project that was never missing. The assertion is unchanged.
  let project: { id: string; name: string } | undefined;
  await expect.poll(async () => {
    const created = await api(page, '/projects');
    project = (created.body as { id: string; name: string }[]).find(candidate => candidate.name === name);
    return project?.id ?? '';
  }, { timeout: 15000 }).not.toBe('');
  if (!project) throw Error('the project was not registered');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp('project=' + project.id));
  return project.id;
}

async function waitForAgentIdle(page: import('@playwright/test').Page, projectId: string, sessionId: string) {
  const until = Date.now() + 15000;
  for (;;) {
    const view = await api(page, '/projects/' + projectId + '/agents?sessionId=' + encodeURIComponent(sessionId));
    const value = view.body as { view?: { working: boolean; entries: unknown[] } };
    if (value.view && !value.view.working && value.view.entries.length > 0) return;
    if (Date.now() > until) throw Error('the seeded conversation did not settle');
    await page.waitForTimeout(100);
  }
}

test('attention ranks all four kinds on a phone, is read-only, and resolves only by a durable action', async ({ page }) => {
  const projectId = await addProject(page, 'Attention fixture');

  // One named session whose conversation exists and whose durable run failed.
  const failedSession = (await api(page, '/sessions', 'POST', { projectId, name: 'Failed attention run' })).body as { session: { id: string } };
  await api(page, '/projects/' + projectId + '/agents/input', 'POST', { text: 'seed the conversation', mode: 'followUp', sessionId: failedSession.session.id });
  await waitForAgentIdle(page, projectId, failedSession.session.id);
  // One named session that was running when its process went away: an uncertain interruption.
  const interruptedSession = (await api(page, '/sessions', 'POST', { projectId, name: 'Interrupted attention run' })).body as { session: { id: string } };
  await api(page, '/projects/' + projectId + '/agents/input', 'POST', { text: 'completed original request', mode: 'followUp', requestId: 'ack-terminal-request', sessionId: interruptedSession.session.id });
  await waitForAgentIdle(page, projectId, interruptedSession.session.id);

  const root = await browserDataRoot();
  const control = new ControlStore(root);
  try {
    const lifecycle = new SessionLifecycleStore(control);
    lifecycle.markRunning({ projectId, sessionId: failedSession.session.id, requestId: 'request-failed' });
    lifecycle.markSettled({ projectId, sessionId: failedSession.session.id, outcome: 'failed', reason: 'The provider refused the request.' });
    // The original request has terminal `done` status and the conversation is idle. The UI action
    // still requires an explicit owner click; rendering the panel alone is read-only.
    lifecycle.markRunning({ projectId, sessionId: interruptedSession.session.id, requestId: 'ack-terminal-request' });
    adoptRunningSessions(lifecycle, new Date());
  } finally {
    control.close();
  }

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const approval = await api(page, '/approvals', 'POST', {
    kind: 'deploy',
    scope: { projectId },
    target: { endpoint: 'https://deploy.example.test/hook', releaseId: 'rel-attention-1' },
    expiresAt
  });
  expect(approval.status).toBe(201);

  // The question is the real harness question, not a seeded row.
  await api(page, '/projects/' + projectId + '/agents/input', 'POST', { text: '[ask] add the invoice export', mode: 'followUp' });
  let question: { id: string; text: string; answer: unknown } | undefined;
  await expect.poll(async () => {
    const questionView = await api(page, '/projects/' + projectId + '/agents');
    question = (questionView.body as { view: { questions: { id: string; text: string; answer: unknown }[] } }).view.questions.find(candidate => !candidate.answer);
    return question?.id;
  }, { timeout: 15000 }).toBeTruthy();
  expect(question).toBeTruthy();

  // Phone-sized, in the Agents view, with the drawer out of the way. The route change is made
  // inside the app so the entry under the attention layer is one this page wrote.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  const hideDrawer = page.getByRole('button', { name: 'Hide project sidebar' });
  if (await hideDrawer.count()) await hideDrawer.click();
  const beforeUrl = page.url();

  // Opening and paging the surface is a read: only GET requests leave the page.
  const methods: string[] = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/api/')) methods.push(request.method() + ' ' + new URL(url).pathname);
  });
  await page.getByRole('button', { name: /Needs me/ }).click();
  const panel = page.getByRole('group', { name: 'Needs me' });
  await expect(panel.locator('.attention-item')).toHaveCount(4);
  await expect(panel.locator('.attention-count')).toContainText('4 open');
  const kinds = await panel.locator('.attention-item').evaluateAll(elements => elements.map(element => element.getAttribute('data-kind')));
  expect(kinds).toEqual(['interrupted', 'failure', 'approval', 'question']);
  expect(methods.every(entry => entry.startsWith('GET '))).toBe(true);

  // Back closes the layer and stays inside the application. This is checked on the first opening,
  // before other actions write history of their own. Wait until the layer's own entry exists, so
  // Back traverses it rather than whatever preceded the page.
  await expect.poll(() => page.evaluate(() => JSON.stringify(history.state))).toContain('panel:inbox');
  await page.goBack();
  await expect(page.locator('.attention-panel')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp('project=' + projectId));
  await page.getByRole('button', { name: /Needs me/ }).click();
  await expect(page.locator('.attention-panel')).toBeVisible();

  // Sensitive fields: the approval nonce is never part of the surface, and no path is shown.
  const panelHtml = await panel.innerHTML();
  expect(panelHtml).not.toContain('nonce');
  expect(panelHtml).not.toContain('session.sqlite');

  // The uncertain interruption offers no replay and names the operator-attention case.
  const interruptedItem = panel.locator('.attention-item[data-kind="interrupted"]');
  await expect(interruptedItem).toContainText('Operator attention');
  await expect(interruptedItem.getByRole('button', { name: /Resume/ })).toHaveCount(0);
  await expect(interruptedItem).toContainText('does not undo the effect');
  await expect(interruptedItem).toContainText('Review the conversation and the affected project files first');
  const acknowledge = interruptedItem.getByRole('button', { name: /Acknowledge interrupted work/ });
  await expect(acknowledge).toBeVisible();
  await acknowledge.click();
  await expect(panel).toContainText(/Acknowledged after terminal status/);
  await expect(panel.locator('.attention-item[data-kind="interrupted"]')).toHaveCount(0);
  expect(page.url()).toBe(beforeUrl);

  // An approval shows its full exact target before any action, then consumes only when asked.
  await panel.locator('.attention-item[data-kind="approval"]').getByRole('button', { name: /Review approval/ }).click();
  const review = page.getByRole('group', { name: 'Approval review' });
  await expect(review).toContainText('https://deploy.example.test/hook');
  await expect(review).toContainText('rel-attention-1');
  await expect(review).toContainText('performs no commit');
  await review.getByRole('button', { name: 'Consume approval grant' }).click();
  await expect(panel).toContainText(/Consumption recorded/);
  await expect(review).toContainText('This approval is consumed and cannot be consumed again.');
  await expect(review.getByRole('button', { name: 'Consume approval grant' })).toHaveCount(0);
  await expect(panel.locator('.attention-item[data-kind="approval"]')).toHaveCount(0);
  await expect(panel.locator('.attention-count')).toContainText('2 open');
  expect(page.url()).toBe(beforeUrl);

  // A failure offers retry, and only the explicit click dispatches.
  await panel.locator('.attention-item[data-kind="failure"]').getByRole('button', { name: /Retry/ }).click();
  await expect(panel).toContainText(/Retry recorded as a new attempt/);
  await expect(panel.locator('.attention-item[data-kind="failure"]')).toHaveCount(0);
  expect(page.url()).toBe(beforeUrl);

  // A question opens its exact session; the panel closes as one layer.
  await panel.locator('.attention-item[data-kind="question"]').click();
  await expect(page.locator('.attention-panel')).toHaveCount(0);
  await expect(page.locator('#question-' + question!.id)).toBeVisible();
  // The root conversation is the default, so the address may omit `session`; the view is exact.
  await expect(page).toHaveURL(new RegExp('view=Agents'));

  // A push link names the exact question: the Agents view shows it and the panel does not open.
  await page.goto('/?project=' + projectId + '&view=Agents&session=1&attention=' + encodeURIComponent('question:' + question!.id));
  await expect(page.locator('#question-' + question!.id)).toBeVisible();
  await expect(page.locator('.attention-panel')).toHaveCount(0);
});

test('an unreadable attention source makes the badge say the count is incomplete, not zero', async ({ page }) => {
  const projectId = await addProject(page, 'Attention incomplete fixture');
  const root = await browserDataRoot();
  // A directory where the project transcript belongs makes the read-only open fail. The count is
  // then partial, and the badge must not present it as an exact zero.
  await mkdir(join(root, 'agents', projectId, 'session.sqlite'), { recursive: true });
  await page.goto('/?project=' + projectId + '&view=List');
  const needsMe = page.getByRole('button', { name: /Needs me/ });
  await expect(needsMe).toHaveAttribute('aria-label', 'Needs me (count incomplete)');
  await needsMe.click();
  const panel = page.getByRole('group', { name: 'Needs me' });
  await expect(panel.locator('.attention-count')).toContainText('count incomplete');
  await expect(panel).toContainText('Some sources are unavailable');
  await expect(panel).not.toContainText('Nothing needs you');
});

test('an alert project switch discards a delayed attention response and its approval actions', async ({ page }) => {
  // The service worker message path is stubbed, but the application's own listener and navigation
  // are real. A notification therefore moves the app to the other project as it does on a phone.
  await page.addInitScript(() => {
    const target = new EventTarget();
    const registration = { pushManager: { getSubscription: async () => null } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      register: async () => registration,
      getRegistration: async () => registration,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target)
    } });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'default', requestPermission: async () => 'granted' } });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
  });
  const alpha = await addProject(page, 'Alert switch alpha');
  const beta = await addProject(page, 'Alert switch beta');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const oldApproval = await api(page, '/approvals', 'POST', {
    kind: 'deploy', scope: { projectId: alpha },
    target: { endpoint: 'https://deploy.example.test/old', releaseId: 'rel-old-attention' }, expiresAt
  });
  expect(oldApproval.status).toBe(201);
  // Let the second project's own selection settle before a document navigation, so the navigation
  // cannot race the application's first route write.
  await expect(page.getByRole('button', { name: '＋ Task', exact: true })).toBeEnabled();

  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let requestStarted = false;
  await page.route(new RegExp('/api/projects/' + alpha + '/attention\\?'), async route => {
    requestStarted = true;
    await held;
    await route.continue().catch(() => {});
  });

  // Select alpha in the app rather than with a document navigation, so this test exercises the
  // same project switch an alert uses.
  await page.locator('#project-sidebar').getByRole('button', { name: /Alert switch alpha/ }).click();
  await expect(page).toHaveURL(new RegExp('project=' + alpha));
  await page.getByRole('button', { name: 'Task', exact: true }).click();
  await page.getByRole('button', { name: /Needs me/ }).click();
  await expect.poll(() => requestStarted).toBe(true);

  // The alert arrives while alpha's request is still held. The app moves to beta and the panel is
  // rebuilt for beta; alpha's response is released afterwards and must change nothing.
  await page.evaluate(url => {
    (navigator.serviceWorker as unknown as EventTarget).dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard-alert', url } }));
  }, '/?project=' + beta + '&view=List');
  await expect(page).toHaveURL(new RegExp('project=' + beta));
  const panel = page.getByRole('group', { name: 'Needs me' });
  await expect(panel.locator('.attention-count')).toContainText('0 open');
  release();
  await page.waitForTimeout(400);

  // The panel in the document is the one for beta, and the shell badge still describes beta. The
  // delayed alpha response changed neither.
  await expect(page.locator('.attention-panel')).toHaveAttribute('data-project', beta);
  await expect(page.getByRole('button', { name: /Needs me/ })).toHaveAttribute('aria-label', 'Needs me');
  await expect(panel).not.toContainText('rel-old-attention');
  await expect(panel).not.toContainText('https://deploy.example.test/old');
  await expect(panel.getByRole('button', { name: /Review approval/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Consume approval grant' })).toHaveCount(0);
});

test('attention pages 20 at a time with the exact count and a list that says when it is capped', async ({ page }) => {
  const projectId = await addProject(page, 'Attention paging fixture');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  for (let index = 0; index < 25; index += 1) {
    const created = await api(page, '/approvals', 'POST', {
      kind: 'publish',
      scope: { projectId },
      target: { channel: 'docs', artifact: 'page-' + index },
      expiresAt
    });
    expect(created.status).toBe(201);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?project=' + projectId + '&view=Agents');
  const hideDrawer = page.getByRole('button', { name: 'Hide project sidebar' });
  if (await hideDrawer.count()) await hideDrawer.click();
  await page.getByRole('button', { name: /Needs me/ }).click();
  const panel = page.getByRole('group', { name: 'Needs me' });
  await expect(panel.locator('.attention-count')).toContainText('25 open');
  await expect(panel.locator('.attention-item')).toHaveCount(20);
  await panel.getByRole('button', { name: 'Show older items' }).click();
  await expect(panel.locator('.attention-item')).toHaveCount(25);
  await expect(panel.getByRole('button', { name: 'Show older items' })).toHaveCount(0);
  await expect(panel).toContainText('proposed defaults');
  // The count did not change with paging: it comes from its own query.
  await expect(panel.locator('.attention-count')).toContainText('25 open');
});
