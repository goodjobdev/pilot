import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentView } from '../../src/shared/agent';
import { SseBufferError, SseParser, openAgentStream, type ConnectionState, type ConnectionStatus } from '../../src/client/stream';

const encoder = new TextEncoder();

function view(label: string): AgentView {
  return {
    conversationId: 'conversation-1',
    working: false,
    attempt: null,
    entries: [],
    partial: label,
    inbox: [],
    usage: { input: 0, output: 0, cost: 0 },
    model: null,
    questions: [],
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function snapshotFrame(label: string): string {
  return 'data: ' + JSON.stringify(view(label)) + '\n\n';
}

function responseFrom(chunks: string[], status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }),
    { status, headers: { 'content-type': 'text/event-stream' } }
  );
}

/** A response whose body is written by the test and never closed by the server. */
function openResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
  return {
    response,
    write: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
    fail: () => controller.error(new DOMException('Aborted', 'AbortError'))
  };
}

function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('condition was not met in time'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

interface Harness {
  statuses: ConnectionStatus[];
  views: AgentView[];
  calls: () => number;
  authExpired: number;
}

function harness(): Harness {
  const statuses: ConnectionStatus[] = [];
  const views: AgentView[] = [];
  let calls = 0;
  const value: Harness = {
    statuses,
    views,
    calls: () => calls,
    authExpired: 0
  };
  value.statuses = statuses;
  return value;
}

test('one chunk with two valid frames passes a per-frame byte cap', () => {
  const parser = new SseParser(20);
  const frame = 'data: {"a":1}\n\n';
  const frames = parser.push(frame + frame);
  assert.equal(frames.length, 2, 'the combined chunk is over the cap, but each frame is under it');
  assert.equal(frames[0].data, '{"a":1}');
  assert.equal(frames[1].data, '{"a":1}');
});

test('many short data lines in one unterminated frame hit the aggregate byte cap', () => {
  const parser = new SseParser(40);
  const line = 'data: 1234567890';
  assert.throws(() => parser.push(line + '\n' + line + '\n' + line + '\n'), (error: unknown) => {
    assert.ok(error instanceof SseBufferError);
    assert.equal(error.code, 'STREAM_FRAME_TOO_LARGE');
    return true;
  });
});

test('the aggregate frame cap counts UTF-8 bytes, not UTF-16 characters', () => {
  assert.throws(() => new SseParser(12).push('data: ééé\n'), (error: unknown) => error instanceof SseBufferError);
});

test('a frame split at every boundary is reassembled exactly once', () => {
  const source = 'data: {"text":"héllo"}\n\n';
  for (let split = 1; split < source.length; split += 1) {
    const parser = new SseParser();
    const frames = [...parser.push(source.slice(0, split)), ...parser.push(source.slice(split))];
    assert.equal(frames.length, 1, 'split at ' + split);
    assert.equal(frames[0].data, '{"text":"héllo"}');
  }
});

test('a CRLF split between its bytes and several data lines stay one frame', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('retry: 3000\r'), []);
  const frames = parser.push('\n\r\nevent: notice\r\ndata: one\r\ndata: two\r\n\r\n');
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { comment: true, event: null, data: null, retry: 3000 });
  assert.deepEqual(frames[1], { comment: false, event: 'notice', data: 'one\ntwo', retry: null });
});

test('an incomplete frame is discarded when the stream ends', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: never terminated'), []);
  assert.deepEqual(parser.flush(), []);
});

test('a fragmented stream yields one full snapshot and a live state', async () => {
  const source = 'retry: 3000\n\n' + snapshotFrame('fragmented');
  const chunks: string[] = [];
  for (let index = 0; index < source.length; index += 7) chunks.push(source.slice(index, index + 7));
  const h = harness();
  const lifetime = new AbortController();
  let fetchCalls = 0;
  await openAgentStream({
    projectId: 'p',
    signal: lifetime.signal,
    fetchImpl: async () => {
      fetchCalls += 1;
      return responseFrom(chunks);
    },
    random: () => 0,
    minDelayMs: 5,
    maxDelayMs: 10,
    maxAttempts: 0,
    onView: next => {
      h.views.push(next);
    },
    onStatus: status => h.statuses.push(status)
  });
  assert.equal(fetchCalls, 1);
  assert.equal(h.views.length, 1);
  assert.equal(h.views[0].partial, 'fragmented');
  assert.equal(h.statuses[0].state, 'connecting');
  assert.ok(h.statuses.some(status => status.state === 'live'));
  assert.ok(h.statuses.every(status => status.state !== 'auth-required'));
});

test('each connection marks its first full snapshot as a fresh baseline', async () => {
  const meta: { initialSnapshot: boolean }[] = [];
  let calls = 0;
  await openAgentStream({
    projectId: 'p', signal: new AbortController().signal,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? responseFrom([snapshotFrame('first')]) : responseFrom([snapshotFrame('reconnect')]);
    },
    random: () => 0, minDelayMs: 1, maxDelayMs: 1, maxAttempts: 1,
    onView: (_view, value) => meta.push(value), onStatus: () => undefined
  });
  assert.deepEqual(meta, [{ initialSnapshot: true }, { initialSnapshot: true }]);
});

test('a 401 stops the loop and reports the sign-in state', async () => {
  const h = harness();
  let calls = 0;
  await openAgentStream({
    projectId: 'p',
    signal: new AbortController().signal,
    fetchImpl: async () => {
      calls += 1;
      return responseFrom(['{}'], 401);
    },
    onView: () => undefined,
    onStatus: status => h.statuses.push(status),
    onAuthExpired: () => {
      h.authExpired += 1;
    }
  });
  assert.equal(calls, 1, 'a sign-in refusal is never retried');
  assert.equal(h.authExpired, 1);
  assert.equal(h.statuses.at(-1)?.state, 'auth-required');
});

test('a 403 is shown with its code and is not retried', async () => {
  const h = harness();
  let calls = 0;
  await openAgentStream({
    projectId: 'p',
    signal: new AbortController().signal,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'Untrusted Host', code: 'HOST' }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      });
    },
    onView: () => undefined,
    onStatus: status => h.statuses.push(status)
  });
  assert.equal(calls, 1);
  const last = h.statuses.at(-1);
  assert.equal(last?.state, 'server-error');
  assert.match(last?.detail ?? '', /Untrusted Host/);
  assert.match(last?.detail ?? '', /HOST/);
});

test('a 401 is terminal before a hanging refusal body can delay it', { timeout: 2_000 }, async () => {
  const h = harness();
  let calls = 0;
  const started = Date.now();
  await openAgentStream({
    projectId: 'p',
    signal: new AbortController().signal,
    fetchImpl: async () => {
      calls += 1;
      return new Response(new ReadableStream({ start() {} }), { status: 401 });
    },
    refusalTimeoutMs: 5_000,
    onView: () => undefined,
    onStatus: status => h.statuses.push(status)
  });
  assert.equal(calls, 1);
  assert.equal(h.statuses.at(-1)?.state, 'auth-required');
  assert.ok(Date.now() - started < 1_000, 'the status, not the body, decides a 401');
});

test('a 403 with a hanging body still reaches a terminal server-error with the safe default', { timeout: 2_000 }, async () => {
  const h = harness();
  let calls = 0;
  const started = Date.now();
  await openAgentStream({
    projectId: 'p',
    signal: new AbortController().signal,
    fetchImpl: async () => {
      calls += 1;
      return new Response(new ReadableStream({ start() {} }), { status: 403 });
    },
    refusalTimeoutMs: 20,
    onView: () => undefined,
    onStatus: status => h.statuses.push(status)
  });
  assert.equal(calls, 1);
  const last = h.statuses.at(-1);
  assert.equal(last?.state, 'server-error');
  assert.match(last?.detail ?? '', /HTTP 403/);
  assert.ok(Date.now() - started < 1_000);
});

test('keep-alives keep an idle transport live without a new snapshot', async () => {
  const h = harness();
  const body = openResponse();
  const lifetime = new AbortController();
  const heartbeat = setInterval(() => body.write(': keep-alive\n\n'), 20);
  setTimeout(() => {
    lifetime.abort();
    body.fail();
  }, 180);
  await openAgentStream({
    projectId: 'p',
    signal: lifetime.signal,
    fetchImpl: async () => body.response,
    staleAfterMs: 500,
    maxAttempts: 0,
    onView: next => h.views.push(next),
    onStatus: status => h.statuses.push(status)
  });
  clearInterval(heartbeat);
  assert.equal(h.views.length, 0);
  assert.ok(!h.statuses.some(status => status.state === 'stale'), 'heartbeats are transport health');
  assert.equal(h.statuses[0].state, 'connecting');
});

test('a silent transport goes stale and then reconnects', async () => {
  const h = harness();
  const silent = openResponse();
  const lifetime = new AbortController();
  let calls = 0;
  await openAgentStream({
    projectId: 'p',
    signal: lifetime.signal,
    fetchImpl: async (_input, init) => {
      calls += 1;
      if (calls === 1) {
        init?.signal?.addEventListener('abort', () => silent.fail(), { once: true });
        return silent.response;
      }
      return responseFrom([snapshotFrame('after-stale')]);
    },
    minDelayMs: 5,
    maxDelayMs: 10,
    maxAttempts: 2,
    random: () => 0,
    staleAfterMs: 40,
    onView: next => {
      h.views.push(next);
      lifetime.abort();
    },
    onStatus: status => h.statuses.push(status)
  });
  assert.equal(calls, 2);
  assert.ok(h.statuses.some(status => status.state === 'stale'));
  assert.ok(h.statuses.some(status => status.detail.startsWith('Reconnecting (attempt 1)')));
  assert.equal(h.views[0].partial, 'after-stale');
});

test('a network failure retries a bounded number of times, GET only, then reports offline', async () => {
  const h = harness();
  const methods: string[] = [];
  const lifetime = new AbortController();
  await openAgentStream({
    projectId: 'p',
    signal: lifetime.signal,
    fetchImpl: async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      throw new TypeError('fetch failed: the network is unreachable');
    },
    minDelayMs: 2,
    maxDelayMs: 4,
    maxAttempts: 3,
    random: () => 0,
    onView: next => h.views.push(next),
    onStatus: status => h.statuses.push(status)
  });
  assert.equal(methods.length, 4, 'the initial attempt and three bounded retries');
  assert.deepEqual([...new Set(methods)], ['GET'], 'a reconnect never sends anything but a GET');
  assert.equal(h.views.length, 0, 'no snapshot was invented from a failed request');
  assert.equal(h.statuses.at(-1)?.state, 'offline');
  assert.equal(h.statuses.at(-1)?.attempt, 4);
  assert.match(h.statuses.at(-1)?.detail ?? '', /Reconnect when the server is reachable/);
  // The loop has stopped: no attempt follows the terminal state.
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(methods.length, 4, 'the loop stops at the bounded attempt count');
  lifetime.abort();
});

test('a snapshot followed immediately by a drop cannot reset the retry budget', async () => {
  const h = harness();
  let calls = 0;
  await openAgentStream({
    projectId: 'p',
    signal: new AbortController().signal,
    fetchImpl: async () => {
      calls += 1;
      return responseFrom([snapshotFrame('drop-' + calls)]);
    },
    minDelayMs: 2,
    maxDelayMs: 4,
    maxAttempts: 2,
    stableResetMs: 10_000,
    random: () => 0,
    onView: next => h.views.push(next),
    onStatus: status => h.statuses.push(status)
  });
  assert.equal(calls, 3, 'the initial attempt and two retries');
  assert.equal(h.views.length, 3);
  assert.equal(h.statuses.at(-1)?.state, 'offline');
  assert.equal(h.statuses.at(-1)?.attempt, 3);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 3, 'the loop stops at the bounded attempt count');
});

test('a measured stable live period resets the retry budget', async () => {
  const h = harness();
  let calls = 0;
  await openAgentStream({
    projectId: 'p',
    signal: new AbortController().signal,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const body = openResponse();
        body.write(snapshotFrame('stable'));
        const heartbeat = setInterval(() => body.write(': keep-alive\n\n'), 10);
        setTimeout(() => {
          clearInterval(heartbeat);
          body.close();
        }, 80);
        return body.response;
      }
      return responseFrom(['{}'], 503);
    },
    minDelayMs: 2,
    maxDelayMs: 4,
    maxAttempts: 1,
    stableResetMs: 30,
    random: () => 0,
    onView: next => h.views.push(next),
    onStatus: status => h.statuses.push(status)
  });
  assert.equal(calls, 2);
  const reconnects = h.statuses.map(status => status.detail).filter(detail => detail.startsWith('Reconnecting'));
  assert.ok(reconnects.some(detail => detail.startsWith('Reconnecting (attempt 1)')), JSON.stringify(reconnects));
  assert.ok(!reconnects.some(detail => detail.startsWith('Reconnecting (attempt 2)')), 'the budget reset after the stable period');
  assert.equal(h.statuses.at(-1)?.state, 'offline');
});

test('a cancelled session switch drops a late frame from the old stream', async () => {
  const h = harness();
  const body = openResponse();
  const lifetime = new AbortController();
  let calls = 0;
  let started = false;
  const running = openAgentStream({
    projectId: 'old',
    sessionId: 'old-session',
    signal: lifetime.signal,
    fetchImpl: async () => {
      calls += 1;
      started = true;
      return body.response;
    },
    staleAfterMs: 5_000,
    maxAttempts: 3,
    minDelayMs: 5,
    onView: next => h.views.push(next),
    onStatus: status => h.statuses.push(status)
  });
  await waitFor(() => started);
  lifetime.abort();
  body.write(snapshotFrame('late-old-session'));
  await running;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(h.views.length, 0, 'an aborted generation writes nothing');
});

test('an oversized frame is refused once as a server error, without a retry', async () => {
  const h = harness();
  let calls = 0;
  await openAgentStream({
    projectId: 'p',
    signal: new AbortController().signal,
    fetchImpl: async () => {
      calls += 1;
      return responseFrom(['data: ' + 'x'.repeat(200)]);
    },
    maxFrameBytes: 64,
    onView: () => undefined,
    onStatus: status => h.statuses.push(status)
  });
  assert.equal(calls, 1);
  const last = h.statuses.at(-1);
  assert.equal(last?.state, 'server-error');
  assert.match(last?.detail ?? '', /larger than this client accepts/);
});

test('the visible states are a closed set', () => {
  const states: ConnectionState[] = ['connecting', 'live', 'stale', 'offline', 'auth-required', 'server-error'];
  assert.equal(new Set(states).size, 6);
});
