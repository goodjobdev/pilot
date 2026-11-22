import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { supervise } from './supervisor.mjs';

function harness(t) {
  const children = [];
  const exits = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.signalCode = null;
    child.killed = [];
    child.kill = (signal) => { child.killed.push(signal); return true; };
    child.finish = (code = 0, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); child.emit('close', code, signal); };
    children.push({ command, args, options, child });
    return child;
  };
  const stdout = { write() {} }; const stderr = { write() {} };
  const result = supervise({ spawn, nodeArgs: ['node-entry'], goArgs: ['go-entry'], env: { TEST: 'not-secret' }, stdout, stderr, exit: (code) => exits.push(code), timeoutMs: 5000 });
  t.after(() => {
    result.stop('SIGKILL');
    for (const item of children) if (item.child.exitCode === null) item.child.finish(0);
  });
  return { children, exits, result };
}

const coreReady = 'private preview core listening on protected Unix socket\n';

function announceCore(h) {
  h.children[0].child.stdout.emit('data', coreReady);
}

test('starts ingress after the core is ready and fails on unexpected exit', (t) => {
  const h = harness(t);
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].command, process.execPath);
  announceCore(h);
  assert.equal(h.children.length, 2);
  assert.equal(h.children[1].command, '/usr/local/bin/tsnet-ingress');
  h.children[1].child.stdout.emit('data', 'tsnet HTTPS ingress ready\n');
  assert.equal(h.result.readyCount, 2);
  h.children[0].child.finish(0);
  assert.deepEqual(h.children[1].child.killed, ['SIGTERM']);
  h.children[1].child.finish(0);
  assert.deepEqual(h.exits, [1]);
});
test('fails closed and terminates the core when ingress exits unsuccessfully', (t) => {
  const h = harness(t);
  announceCore(h);
  h.children[1].child.finish(1);
  assert.deepEqual(h.children[0].child.killed, ['SIGTERM']);
  h.children[0].child.finish(0);
  assert.deepEqual(h.exits, [1]);
});
test('treats child exits caused by supervisor SIGTERM as a clean shutdown', (t) => {
  const h = harness(t);
  announceCore(h);
  h.result.stop('SIGTERM');
  h.children[0].child.finish(null, 'SIGTERM');
  h.children[1].child.finish(null, 'SIGTERM');
  assert.deepEqual(h.exits, [0]);
});
test('fails closed when a child cannot be spawned', (t) => {
  const exits = [];
  const result = supervise({ spawn: () => { throw new Error('spawn failed'); }, nodeArgs: [], goArgs: [], env: {}, stdout: { write() {} }, stderr: { write() {} }, exit: (code) => exits.push(code) });
  t.after(() => result.stop('SIGKILL'));
  assert.deepEqual(exits, [1]);
});
test('handles asynchronous spawn failure without an exit event', (t) => {
  const h = harness(t);
  announceCore(h);
  h.children[1].child.emit('error', new Error('spawn failed'));
  h.children[1].child.emit('close', -2, null);
  assert.deepEqual(h.children[0].child.killed, ['SIGTERM']);
  h.children[0].child.finish(0);
  assert.deepEqual(h.exits, [1]);
});

test('waits for exact, complete readiness lines even across pipe chunks', (t) => {
  const h = harness(t);
  const core = h.children[0].child;
  core.stderr.emit('data', coreReady);
  core.stdout.emit('data', 'unrelated log\nprefix ' + coreReady + 'x'.repeat(10000));
  core.stdout.emit('data', coreReady); // still on the overlong line
  core.stdout.emit('data', coreReady.slice(0, 10));
  assert.equal(h.result.readyCount, 0);
  assert.equal(h.children.length, 1);
  core.stdout.emit('data', coreReady.slice(10));
  assert.equal(h.result.readyCount, 1);
  h.children[1].child.stdout.emit('data', 'tsnet HTTPS ingress ready');
  assert.equal(h.result.readyCount, 1);
  h.children[1].child.stdout.emit('data', '\n');
  assert.equal(h.result.readyCount, 2);
});

test('does not start ingress after pre-readiness failure or cancellation', (t) => {
  const failed = harness(t);
  failed.children[0].child.finish(1);
  announceCore(failed);
  assert.equal(failed.children.length, 1);
  assert.deepEqual(failed.exits, [1]);

  const stopped = harness(t);
  stopped.result.stop();
  announceCore(stopped);
  assert.equal(stopped.children.length, 1);
  stopped.children[0].child.finish(null, 'SIGTERM');
  assert.deepEqual(stopped.exits, [0]);
});

test('readiness contract matches the ingress log line', () => {
  // Changing either side of the exact stdout marker requires updating its peer.
  const source = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
  const ingress = readFileSync(new URL('./ingress/cmd/tsnet-ingress/lifecycle.go', import.meta.url), 'utf8');
  const literal = /const readyLine = "([^"]+)"/.exec(ingress);
  assert.ok(literal, 'ingress readyLine constant is missing');
  assert.ok(source.includes(literal[1]), 'supervisor does not wait for the ingress ready line');
  const main = readFileSync(new URL('./ingress/cmd/tsnet-ingress/main.go', import.meta.url), 'utf8');
  assert.ok(main.includes('fmt.Fprintln(os.Stdout, readyLine)'));
});
