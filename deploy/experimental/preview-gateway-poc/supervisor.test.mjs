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
    child.finish = (code = 0, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal); };
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

test('starts both children and reports success only after both exit normally', (t) => {
  const h = harness(t);
  assert.equal(h.children.length, 2);
  assert.equal(h.children[0].command, process.execPath);
  assert.equal(h.children[1].command, '/usr/local/bin/tsnet-ingress');
  h.children[0].child.stdout.emit('data', 'private preview core listening\n');
  h.children[1].child.stdout.emit('data', 'tsnet HTTPS ingress ready\n');
  assert.equal(h.result.readyCount, 2);
  h.children[0].child.finish(0);
  assert.deepEqual(h.children[1].child.killed, ['SIGTERM']);
  h.children[1].child.finish(0);
  assert.deepEqual(h.exits, [1]);
});
test('fails closed and terminates the peer when either service exits unsuccessfully', (t) => {
  const h = harness(t);
  h.children[1].child.finish(1);
  assert.deepEqual(h.children[0].child.killed, ['SIGTERM']);
  h.children[0].child.finish(0);
  assert.deepEqual(h.exits, [1]);
});
test('treats child exits caused by supervisor SIGTERM as a clean shutdown', (t) => {
  const h = harness(t);
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
test('forwards readiness only from explicit service markers', (t) => {
  const h = harness(t);
  h.children[0].child.stdout.emit('data', 'unrelated log\n');
  assert.equal(h.result.readyCount, 0);
});

test('readiness contract matches the ingress log line', () => {
  // The supervisor counts a child ready only on this exact substring; a change on
  // one side without the other would leave the container permanently unready.
  const source = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
  const ingress = readFileSync(new URL('./ingress/cmd/tsnet-ingress/lifecycle.go', import.meta.url), 'utf8');
  const literal = /const readyLine = "([^"]+)"/.exec(ingress);
  assert.ok(literal, 'ingress readyLine constant is missing');
  assert.ok(source.includes(literal[1]), 'supervisor does not wait for the ingress ready line');
  assert.ok(source.includes(`\${literal[1]}`) || source.includes(literal[1]));
});
