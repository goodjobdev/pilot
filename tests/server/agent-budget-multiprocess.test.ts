import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentBudgetLedger } from '../../src/server/state/agent-budget';

async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('child process deadline exceeded')), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('independent processes cannot reserve the last request-budget slot across projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-agent-budget-process-race-'));
  const setup = new ControlStore(root);
  setup.close();
  const script = `
    import { ControlStore } from './src/server/state/control-store.ts';
    import { AgentBudgetLedger, AgentBudgetExceeded } from './src/server/state/agent-budget.ts';
    import { createInterface } from 'node:readline';
    import { readSync } from 'node:fs';
    const store = new ControlStore(process.argv[1]);
    try {
      const ledger = new AgentBudgetLedger(store);
      const admit = store.admit.bind(store);
      let firstAdmission = true;
      store.admit = input => {
        if (firstAdmission) {
          firstAdmission = false;
          const ordinal = Number(input.idempotencyKey.split('.r').pop());
          process.stdout.write(JSON.stringify({ event: 'admit-ready', ordinal }) + '\\n');
          const release = Buffer.alloc(1);
          if (readSync(3, release, 0, 1, null) !== 1 || release[0] !== 1) throw new Error('reservation barrier was not released');
        }
        return admit(input);
      };
      process.stdout.write('ready\\n');
      for await (const line of createInterface({ input: process.stdin })) {
        if (line !== 'go') continue;
        try {
          const result = ledger.reserve({ agentId: 'shared-agent', projectId: process.argv[2], kind: 'request', limit: 1 });
          process.stdout.write(JSON.stringify({ status: 'reserved', ordinal: result.ordinal }) + '\\n');
        } catch (error) {
          if (error instanceof AgentBudgetExceeded) {
            process.stdout.write(JSON.stringify({ status: 'refused', reason: 'budget-exhausted', message: error.message }) + '\\n');
          } else {
            process.stdout.write(JSON.stringify({ status: 'unexpected-error', name: error.name, message: error.message }) + '\\n');
          }
        }
        break;
      }
    } finally {
      store.close();
    }
  `;
  const children = ['project-a', 'project-b'].map(projectId => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, root, projectId], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return { child, lines, closed, stderr: () => stderr };
  });

  try {
    for (const process of children) {
      const ready = await within(process.lines.next());
      assert.equal(ready.value, 'ready', process.stderr());
    }
    for (const process of children) process.child.stdin.end('go\n');

    const barriers = await Promise.all(children.map(async process => {
      const line = await within(process.lines.next());
      assert.equal(line.done, false, process.stderr());
      return JSON.parse(line.value!) as { event?: string; ordinal?: number };
    }));
    assert.deepEqual(barriers, [{ event: 'admit-ready', ordinal: 1 }, { event: 'admit-ready', ordinal: 1 }]);
    for (const process of children) (process.child.stdio[3] as Writable).write(Buffer.from([1]));

    const answers = await Promise.all(children.map(async process => {
      const line = await within(process.lines.next());
      assert.equal(line.done, false, process.stderr());
      return JSON.parse(line.value!) as { status: string; ordinal?: number; reason?: string; message?: string; name?: string };
    }));
    assert.equal(answers.some(answer => answer.status === 'unexpected-error'), false, JSON.stringify(answers));
    assert.equal(answers.filter(answer => answer.status === 'reserved').length, 1, JSON.stringify(answers));
    assert.equal(answers.filter(answer => answer.status === 'refused').length, 1, JSON.stringify(answers));
    assert.equal(answers.find(answer => answer.status === 'reserved')?.ordinal, 1);
    const refusal = answers.find(answer => answer.status === 'refused')!;
    assert.equal(refusal.reason, 'budget-exhausted');
    assert.match(refusal.message!, /exhausted/);

    for (const process of children) {
      const exit = await within(process.closed);
      assert.equal(exit.code, 0, process.stderr());
    }

    const reopened = new ControlStore(root);
    try {
      const count = reopened.db.prepare("SELECT COUNT(*) AS total FROM operations WHERE project_id=? AND session_id=? AND kind=?")
        .get('agent-budgets', 'shared-agent', 'agent.budget-request') as { total: number };
      assert.equal(Number(count.total), 1);
    } finally {
      reopened.close();
    }
  } finally {
    for (const process of children) process.child.kill('SIGTERM');
    await Promise.all(children.map(async process => {
      try {
        await within(process.closed, 1000);
      } catch {
        process.child.kill('SIGKILL');
        await within(process.closed, 1000);
      }
    }));
    await rm(root, { recursive: true, force: true });
  }
});
