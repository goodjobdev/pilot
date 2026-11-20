import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalPreviewControlOrigin } from '../../src/server/terminal-preview-config';

test('terminal preview control origin is disabled when unset', () => {
  assert.equal(terminalPreviewControlOrigin(undefined), null);
  assert.equal(terminalPreviewControlOrigin(''), null);
});

test('terminal preview control origin accepts only an HTTPS origin', () => {
  assert.equal(terminalPreviewControlOrigin('https://preview.invalid'), 'https://preview.invalid');
  for (const value of [
    'http://preview.invalid',
    'https://user:pass@preview.invalid',
    'https://preview.invalid/path',
    'https://preview.invalid?x=1',
    'https://preview.invalid#frag',
    'https://preview.invalid/',
  ]) assert.throws(() => terminalPreviewControlOrigin(value), /DASHBOARD_PREVIEW_CONTROL_ORIGIN/);
});
