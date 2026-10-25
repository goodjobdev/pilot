import { test, expect } from '@playwright/test';

/**
 * The measured activity timeline in the session view, on a phone-sized screen.
 *
 * The assertions read what the projection really reports for the conversation the scripted provider
 * ran. No model is called, nothing is paired and no duration is invented: a missing duration is the
 * harness's own named absence.
 */
async function addProject(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '＋ Add project', exact: true }).first().click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Confirm & add project' }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
}

test('the session view shows a bounded activity timeline with recorded outcomes and says what it truncates', async ({ page }) => {
  await addProject(page, 'Activity fixture');
  await page.setViewportSize({ width: 390, height: 844 });
  const activity = page.getByRole('region', { name: 'Session activity', exact: true });
  const transcript = page.getByLabel('Agent transcript');

  // No tool has run yet: the named absence, never an empty success.
  await expect(activity).toContainText('no-tool-activity-reported-yet', { timeout: 20000 });

  // One note call and its result. The note text carries a path the projection must never repeat.
  const composer = page.getByLabel('Message the agent');
  await composer.fill('[note /Users/private/activity-note]');
  await composer.press('Enter');
  await expect(transcript).toContainText('Scripted test reply', { timeout: 20000 });
  await expect(activity.getByLabel('Recent tool calls')).toContainText('record_note', { timeout: 20000 });
  await expect(activity.getByLabel('Recent tool calls')).toContainText('assistant message recorded at');
  await expect(activity.getByLabel('Recent tool calls')).not.toContainText('tool start');
  await expect(activity.getByLabel('Recent tool results')).toContainText('record_note');
  await expect(activity.getByLabel('Recent tool results')).toContainText('ok');
  await expect(activity).toContainText('Newest recorded call or result instant:');
  const afterFirst = await activity.innerText();
  expect(afterFirst).not.toContain('/Users/private');
  expect(afterFirst).toMatch(/\d+ ms|no duration \(no-duration-reported-by-the-harness\)/);

  // Two more tools make three calls and three results, which is over the view's bound of two per
  // list. The timeline says exactly how many older events it withholds.
  await composer.fill('[read-notes]');
  await composer.press('Enter');
  await expect(transcript).toContainText('read_notes (tool call)', { timeout: 20000 });
  await expect(activity.getByLabel('Recent tool calls')).toContainText('read_notes', { timeout: 20000 });
  await composer.fill('[ask] add the invoice export');
  await composer.press('Enter');
  await expect(page.getByRole('region', { name: 'Questions for me' })).toContainText('Should I proceed with: add the invoice export?', { timeout: 20000 });
  await expect(activity.getByLabel('Recent tool calls')).toContainText('ask_question', { timeout: 20000 });
  await expect(activity).toContainText('Bounded: showing the 2 most recent call(s) and 2 most recent result(s).', { timeout: 20000 });
  await expect(activity).toContainText('older call(s)');
  await expect(activity).toContainText('older result(s)');

  // The timeline never carries a call's arguments or a result's message.
  expect(await activity.innerText()).not.toContain('invoice export');
});

test('switching to a named session clears the previous timeline and names the new session absence', async ({ page }) => {
  await addProject(page, 'Activity switch fixture');
  const activity = page.getByRole('region', { name: 'Session activity', exact: true });
  const transcript = page.getByLabel('Agent transcript');

  await page.getByLabel('Message the agent').fill('[note root conversation only]');
  await page.getByLabel('Message the agent').press('Enter');
  await expect(transcript).toContainText('Scripted test reply', { timeout: 20000 });
  await expect(activity.getByLabel('Recent tool calls')).toContainText('record_note', { timeout: 20000 });

  // A new named session opens its own empty conversation. Selecting it must not leave the root
  // conversation's call on screen as if it were this session's activity.
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('New session name').fill('Fresh session');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByText('Created session Fresh session')).toBeVisible();
  // Choose the session in the list; that is the selection the transcript and the timeline follow.
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByRole('button', { name: /Fresh session/ }).click();
  await expect(activity).toContainText('no-tool-activity-reported-yet', { timeout: 20000 });
  const switched = await activity.innerText();
  expect(switched).not.toContain('record_note');
  expect(switched).not.toContain('root conversation only');
  await expect(transcript).toContainText('No messages yet');
});

test('a late activity response for the previous session is discarded after a switch', async ({ page }) => {
  await addProject(page, 'Activity late fixture');
  const activity = page.getByRole('region', { name: 'Session activity', exact: true });
  const transcript = page.getByLabel('Agent transcript');

  await page.getByLabel('Message the agent').fill('[note root only before the switch]');
  await page.getByLabel('Message the agent').press('Enter');
  await expect(transcript).toContainText('Scripted test reply', { timeout: 20000 });
  await expect(activity.getByLabel('Recent tool calls')).toContainText('record_note', { timeout: 20000 });

  // Hold every project-scoped activity read, so one is still in flight while the reader switches.
  await page.route('**/api/actions/activity*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.get('sessionId')) await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.getByLabel('Message the agent').fill('[read-notes]');
  await page.getByLabel('Message the agent').press('Enter');
  await expect(transcript).toContainText('read_notes (tool call)', { timeout: 20000 });

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('New session name').fill('Late switch session');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByText('Created session Late switch session')).toBeVisible();
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByRole('button', { name: /Late switch session/ }).click();
  await expect(activity).toContainText(/no-tool-activity-reported-yet|no-conversation-reported/, { timeout: 20000 });

  // Wait past the held project-scoped response. If it were applied, the root conversation's calls
  // would appear in this session's timeline.
  await page.waitForTimeout(3000);
  const switched = await activity.innerText();
  expect(switched).not.toContain('record_note');
  expect(switched).not.toContain('read_notes');
  await page.unroute('**/api/actions/activity*');
});
