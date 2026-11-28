/**
 * The browser side of the agent event stream.
 *
 * One call to `openAgentStream` owns one project/session subscription for as long as its
 * lifetime signal is not aborted. It reads full snapshots, treats every complete frame
 * (including the server's keep-alive comment) as transport evidence, reconnects with a
 * bounded backoff, and never sends a request other than a `GET`.
 */
import type { AgentView } from '../shared/agent';
import {
  MAX_STREAM_FRAME_BYTES,
  STREAM_MAX_ATTEMPTS,
  STREAM_MAX_RETRY_MS,
  STREAM_MIN_RETRY_MS,
  STREAM_REFUSAL_TIMEOUT_MS,
  STREAM_STABLE_RESET_MS,
  STREAM_STALE_AFTER_MS,
  nextBackoff,
  transportIsStale
} from '../shared/stream';

/** The closed set of connection states the interface can show. */
export type ConnectionState = 'connecting' | 'live' | 'stale' | 'offline' | 'auth-required' | 'server-error';

export interface ConnectionStatus {
  state: ConnectionState;
  /** One honest line for the interface. It never names a model, token or path. */
  detail: string;
  /** 0 while a connection is active; the retry ordinal while waiting for one. */
  attempt: number;
  /** When any frame was last received, including a keep-alive. Transport health. */
  lastFrameAt: number | null;
  /** When a full snapshot was last applied. Useful progress, not transport health. */
  lastViewAt: number | null;
}

export interface SseFrame {
  /** True when the frame carried only a comment (the server's keep-alive). */
  comment: boolean;
  event: string | null;
  data: string | null;
  retry: number | null;
}

export class SseBufferError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SseBufferError';
  }
}

interface PendingFrame {
  event: string | null;
  data: string[];
  retry: number | null;
  comment: boolean;
}

/**
 * A spec-shaped SSE frame parser with a bounded buffer.
 *
 * It handles CRLF, LF and CR line endings, comments, multiple `data:` lines and the
 * `retry:` hint. A frame is emitted on its blank line, including a comment-only frame:
 * that is how transport freshness is observed when the view itself is idle.
 */
export class SseParser {
  private buffer = '';
  private bufferBytes = 0;
  private pending: PendingFrame | null = null;
  private pendingBytes = 0;
  private readonly encoder = new TextEncoder();

  constructor(private readonly maxBytes = MAX_STREAM_FRAME_BYTES + 64 * 1024) {}

  private tooLarge(): never {
    throw new SseBufferError('STREAM_FRAME_TOO_LARGE', 'The agent stream sent a frame larger than this client accepts.');
  }

  push(chunk: string): SseFrame[] {
    // A trailing CR may be the first half of a CRLF split across chunks, so it waits.
    const text = this.buffer + chunk;
    let end = text.length;
    if (text.endsWith('\r')) end -= 1;
    const head = text.slice(0, end).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.buffer = text.slice(end);
    const lines = head.split('\n');
    const tail = lines.pop();
    this.buffer = (tail ?? '') + this.buffer;
    const frames: SseFrame[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.pending !== null) {
          const frame = this.pending;
          this.pending = null;
          this.pendingBytes = 0;
          frames.push({
            comment: frame.data.length === 0,
            event: frame.event,
            data: frame.data.length === 0 ? null : frame.data.join('\n'),
            retry: frame.retry
          });
        }
        continue;
      }
      // Every line belongs to the current frame until a blank line ends it. Count the
      // UTF-8 line, a line-ending allowance and every earlier line in the same frame,
      // so many short `data:` lines cannot grow without a bound.
      this.pendingBytes += this.encoder.encode(line).length + 2;
      if (this.pendingBytes > this.maxBytes) this.tooLarge();
      if (line.startsWith(':')) {
        this.pending ??= { event: null, data: [], retry: null, comment: true };
        this.pending.comment = true;
        continue;
      }
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') {
        this.pending ??= { event: null, data: [], retry: null, comment: false };
        this.pending.data.push(value);
      } else if (field === 'event') {
        this.pending ??= { event: null, data: [], retry: null, comment: false };
        this.pending.event = value;
      } else if (field === 'retry') {
        this.pending ??= { event: null, data: [], retry: null, comment: false };
        if (/^[0-9]+$/.test(value)) this.pending.retry = Number(value);
      }
    }
    // The incomplete tail belongs to the same frame as any data lines already parsed.
    this.bufferBytes = this.encoder.encode(this.buffer).length;
    if (this.pendingBytes + this.bufferBytes > this.maxBytes) this.tooLarge();
    return frames;
  }

  /** An event without its terminating blank line is incomplete and is discarded. */
  flush(): SseFrame[] {
    this.buffer = '';
    this.bufferBytes = 0;
    this.pending = null;
    this.pendingBytes = 0;
    return [];
  }
}

export interface OpenAgentStreamOptions {
  projectId: string;
  sessionId?: string;
  signal: AbortSignal;
  onView: (view: AgentView, meta: { initialSnapshot: boolean }) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Called once when the server answers as a sign-in layer rather than the application. */
  onAuthExpired?: () => void;
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  minDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  staleAfterMs?: number;
  maxFrameBytes?: number;
  /** How long a connection must stay fresh before a drop resets the retry budget. */
  stableResetMs?: number;
  /** How long a refusal body may take to explain itself. */
  refusalTimeoutMs?: number;
}

interface AttemptFailure {
  kind: 'retry' | 'auth' | 'fatal' | 'aborted';
  detail: string;
  code?: string;
  stale?: boolean;
  sawSnapshot: boolean;
  /** Transport-fresh time after the first snapshot; 0 when there was no snapshot. */
  liveMs: number;
  retryHint?: number;
}

function dashboardToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')?.content ?? '';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * A refusal body is bounded in bytes and in time. A 401 is decided from the status alone,
 * and a 403 is shown with the status default even when its body never arrives.
 */
async function readRefusal(res: Response, timeoutMs: number): Promise<{ message: string; code?: string }> {
  const fallback = `The server refused the stream (HTTP ${res.status}).`;
  if (!res.body) return { message: fallback };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = '';
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), remaining);
      });
      const outcome = await Promise.race([reader.read(), timeout]);
      clearTimeout(timer);
      if (outcome === 'timeout') break;
      if (outcome.done) break;
      text += decoder.decode(outcome.value, { stream: true });
      if (text.length > 16 * 1024) break;
    }
  } catch {
    return { message: fallback };
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (text === '') return { message: fallback };
  try {
    const value = JSON.parse(text) as { error?: unknown; code?: unknown };
    return {
      message: typeof value.error === 'string' && value.error !== '' ? value.error : fallback,
      ...(typeof value.code === 'string' && value.code !== '' ? { code: value.code } : {})
    };
  } catch {
    return { message: fallback };
  }
}

/**
 * Runs one connection until it ends, fails, goes stale or is aborted.
 *
 * A full snapshot is what the server sends first on every accepted subscription, so this
 * function does not fetch a second one: it only marks `live` after that snapshot arrives.
 */
async function runAttempt(
  options: OpenAgentStreamOptions,
  attempt: number,
  retryHint: number | undefined,
  emit: (status: ConnectionStatus) => void
): Promise<AttemptFailure> {
  const now = options.now ?? (() => Date.now());
  const staleAfter = options.staleAfterMs ?? STREAM_STALE_AFTER_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const lifetime = options.signal;
  const refusalTimeout = options.refusalTimeoutMs ?? STREAM_REFUSAL_TIMEOUT_MS;
  const attemptAbort = new AbortController();
  const abortAttempt = () => attemptAbort.abort();
  const aborted = (): AttemptFailure => failure({ kind: 'aborted', detail: 'Stopped.', sawSnapshot });
  let sawSnapshot = false;
  let lastFrameAt: number | null = now();
  let lastViewAt: number | null = null;
  let firstSnapshotAt: number | null = null;
  let stale = false;
  let hint = retryHint;
  const startedAt = now();
  // The retry budget is reset by a measured fresh period, not by one lucky snapshot:
  // a proxy that delivers a snapshot and then drops must still reach `offline`.
  const failure = (value: Omit<AttemptFailure, 'liveMs'>): AttemptFailure => ({
    ...value,
    liveMs: firstSnapshotAt === null || lastFrameAt === null ? 0 : Math.max(0, lastFrameAt - firstSnapshotAt)
  });
  if (lifetime.aborted) return aborted();
  lifetime.addEventListener('abort', abortAttempt, { once: true });
  let staleTimer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // The timer starts before the request: a server that accepts a socket and then answers
  // nothing is not fresh, and the wait for response headers is bounded by the same rule.
  staleTimer = setInterval(() => {
    if (transportIsStale(lastFrameAt, now(), staleAfter)) {
      stale = true;
      attemptAbort.abort();
    }
  }, Math.max(10, Math.min(1_000, Math.floor(staleAfter / 3))));
  try {
    const query = options.sessionId ? '?sessionId=' + encodeURIComponent(options.sessionId) : '';
    const response = await fetchImpl('/api/projects/' + options.projectId + '/agents/stream' + query, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'x-dashboard-token': options.token ?? dashboardToken() },
      signal: attemptAbort.signal
    });
    if (response.type === 'opaqueredirect' || response.status === 0) {
      return failure({ kind: 'auth', detail: 'Your sign-in has expired. Reload the page to sign in again.', sawSnapshot });
    }
    if (!response.ok) {
      // The status decides the state first. A refused body is only optional detail, so a
      // body that hangs can never delay the terminal or retry decision beyond the timeout.
      if (response.status === 401) {
        void response.body?.cancel().catch(() => undefined);
        return failure({ kind: 'auth', detail: 'Your sign-in has expired. Reload the page to sign in again.', sawSnapshot });
      }
      const refusal = await readRefusal(response, refusalTimeout);
      const detail = refusal.code ? `${refusal.message} (${refusal.code})` : refusal.message;
      // A 403 could be this origin's Host policy, this session's CSRF scope or a revoked
      // authorisation. Retrying cannot repair any of them, so it is shown and not retried.
      if (response.status === 403) return failure({ kind: 'fatal', detail, code: refusal.code, sawSnapshot });
      if (response.status === 404 || response.status === 409 || response.status === 422) {
        return failure({ kind: 'fatal', detail, code: refusal.code, sawSnapshot });
      }
      return failure({ kind: 'retry', detail, sawSnapshot, retryHint: hint });
    }
    if (!response.body) return failure({ kind: 'retry', detail: 'The server closed the stream.', sawSnapshot, retryHint: hint });

    emit({
      state: 'connecting',
      detail: 'Connected — waiting for the first snapshot…',
      attempt,
      lastFrameAt,
      lastViewAt
    });
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser(options.maxFrameBytes);
    for (;;) {
      const { value, done } = await reader.read();
      if (lifetime.aborted) return aborted();
      if (done) {
        parser.flush();
        return failure({
          kind: 'retry',
          detail: sawSnapshot ? 'The connection closed.' : 'The server closed the stream.',
          sawSnapshot,
          retryHint: hint
        });
      }
      lastFrameAt = now();
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        if (frame.retry !== null) hint = frame.retry;
        if (frame.event === 'error') {
          let message = 'The agent stream reported an error.';
          let code: string | undefined;
          try {
            const value = JSON.parse(frame.data ?? '{}') as { error?: unknown; code?: unknown };
            if (typeof value.error === 'string' && value.error !== '') message = value.error;
            if (typeof value.code === 'string' && value.code !== '') code = value.code;
          } catch {
            /* the named fallback stands */
          }
          return failure({ kind: 'fatal', detail: message, ...(code ? { code } : {}), sawSnapshot });
        }
        if (frame.data === null) continue;
        let view: AgentView;
        try {
          const parsed = JSON.parse(frame.data) as unknown;
          if (parsed === null || typeof parsed !== 'object') continue;
          view = parsed as AgentView;
        } catch {
          // A malformed frame is ignored; the next full snapshot still applies.
          continue;
        }
        lastViewAt = now();
        firstSnapshotAt ??= lastFrameAt;
        const initialSnapshot = !sawSnapshot;
        if (!sawSnapshot) sawSnapshot = true;
        options.onView(view, { initialSnapshot });
        emit({ state: 'live', detail: 'Live', attempt: 0, lastFrameAt, lastViewAt });
      }
    }
  } catch (error) {
    if (lifetime.aborted) return aborted();
    if (stale) {
      return failure({
        kind: 'retry',
        detail: `No frame from the server for ${Math.round((now() - (lastFrameAt ?? startedAt)) / 1_000)} seconds.`,
        stale: true,
        sawSnapshot,
        retryHint: hint
      });
    }
    if (error instanceof SseBufferError) {
      return failure({ kind: 'fatal', detail: error.message, code: error.code, sawSnapshot });
    }
    if ((error as Error)?.name === 'AbortError') return failure({ kind: 'retry', detail: 'The connection was interrupted.', sawSnapshot, retryHint: hint });
    return failure({ kind: 'retry', detail: 'The server could not be reached. Check your connection and try again.', sawSnapshot, retryHint: hint });
  } finally {
    if (staleTimer !== undefined) clearInterval(staleTimer);
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
    lifetime.removeEventListener('abort', abortAttempt);
  }
}

export async function openAgentStream(options: OpenAgentStreamOptions): Promise<void> {
  const random = options.random ?? Math.random;
  const minDelay = options.minDelayMs ?? STREAM_MIN_RETRY_MS;
  const maxDelay = options.maxDelayMs ?? STREAM_MAX_RETRY_MS;
  const maxAttempts = options.maxAttempts ?? STREAM_MAX_ATTEMPTS;
  const stableReset = options.stableResetMs ?? STREAM_STABLE_RESET_MS;
  let attempt = 0;
  let hint: number | undefined;
  // Ages survive a reconnect: the interface must show the last confirmed snapshot age
  // across a disconnected period, not restart it from zero on every attempt.
  let lastFrameAt: number | null = null;
  let lastViewAt: number | null = null;
  const emit = (status: ConnectionStatus) => {
    if (status.lastFrameAt !== null) lastFrameAt = status.lastFrameAt;
    if (status.lastViewAt !== null) lastViewAt = status.lastViewAt;
    if (!options.signal.aborted) options.onStatus(status);
  };
  while (!options.signal.aborted) {
    emit({
      state: 'connecting',
      detail: attempt === 0 ? 'Connecting…' : `Reconnecting (attempt ${attempt})…`,
      attempt,
      lastFrameAt,
      lastViewAt
    });
    const result = await runAttempt(options, attempt, hint, emit);
    if (options.signal.aborted || result.kind === 'aborted') return;
    if (result.retryHint !== undefined) hint = result.retryHint;
    if (result.kind === 'auth') {
      emit({ state: 'auth-required', detail: result.detail, attempt, lastFrameAt, lastViewAt });
      options.onAuthExpired?.();
      return;
    }
    if (result.kind === 'fatal') {
      emit({ state: 'server-error', detail: result.detail, attempt, lastFrameAt, lastViewAt });
      return;
    }
    if (result.liveMs >= stableReset) attempt = 0;
    attempt += 1;
    if (attempt > maxAttempts) {
      emit({
        state: result.stale ? 'stale' : 'offline',
        detail: result.detail + ' Reconnect when the server is reachable.',
        attempt,
        lastFrameAt,
        lastViewAt
      });
      return;
    }
    emit({
      state: result.stale ? 'stale' : 'offline',
      detail: result.detail,
      attempt,
      lastFrameAt,
      lastViewAt
    });
    await sleep(nextBackoff(attempt, hint, random, minDelay, maxDelay), options.signal);
  }
}
