import { randomBytes, randomUUID } from 'node:crypto';
import type { Project } from '../../shared/model';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';

export const TERMINAL_MAX_SESSIONS = 8;
export const TERMINAL_MAX_COLS = 240;
export const TERMINAL_MAX_ROWS = 100;
export const TERMINAL_SCROLLBACK_BYTES = 256 * 1024;
export const TERMINAL_TICKET_TTL_MS = 30_000;
export const SHELL_MAX_COMMAND_BYTES = 16 * 1024;
export const SHELL_MAX_OUTPUT_BYTES = 64 * 1024;
export const SHELL_MAX_COMMAND_MS = 5 * 60_000;

export type TerminalInfo = Readonly<{
  id: string;
  projectId: string;
  projectName: string;
  cwd: string;
  createdAt: string;
  connected: boolean;
}>;

type Ticket = { terminalId: string; expiresAt: number };
type TerminalRecord = {
  info: Omit<TerminalInfo, 'connected'>;
  process: pty.IPty;
  sockets: Set<WebSocket>;
  scrollback: string;
  scrollbackBytes: number;
  connected: boolean;
  exited: Promise<void>;
  resolveExit: () => void;
};

/**
 * The opt-in, same-service-user shell surface. `cwd` is only the initial directory, not a sandbox:
 * commands inherit the Pilot process environment and may read any resource the service UID can.
 * Nothing in this class logs command text, terminal bytes or environment values.
 */
export class TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly tickets = new Map<string, Ticket>();
  private closed = false;

  open(project: Project, requested?: { cols?: number; rows?: number }): TerminalInfo {
    if (this.closed) throw new Error('The terminal service is shutting down.');
    if (this.terminals.size >= TERMINAL_MAX_SESSIONS) throw new Error('The terminal session limit is reached. Close an existing terminal first.');
    const cols = clampInteger(requested?.cols, 80, 2, TERMINAL_MAX_COLS);
    const rows = clampInteger(requested?.rows, 24, 2, TERMINAL_MAX_ROWS);
    const id = randomUUID();
    const shell = configuredShell();
    const child = pty.spawn(shell, shellLoginArgs(shell), {
      name: 'xterm-256color', cols, rows, cwd: project.path,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    });
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const record: TerminalRecord = {
      info: Object.freeze({ id, projectId: project.id, projectName: project.name, cwd: project.path, createdAt: new Date().toISOString() }),
      process: child, sockets: new Set(), scrollback: '', scrollbackBytes: 0, connected: false, exited, resolveExit
    };
    this.terminals.set(id, record);
    child.onData((data) => this.publish(record, data));
    child.onExit(() => { record.resolveExit(); this.disposeRecord(id, record); });
    return this.view(record);
  }

  list(projectId: string): readonly TerminalInfo[] {
    return Object.freeze([...this.terminals.values()].filter((record) => record.info.projectId === projectId).map((record) => this.view(record)));
  }

  read(id: string, projectId: string): TerminalInfo {
    const record = this.require(id, projectId);
    return this.view(record);
  }

  issueTicket(id: string, projectId: string, now = Date.now()): string {
    const record = this.require(id, projectId);
    if (record.connected) throw new Error('This terminal already has an attached browser.');
    this.expireTickets(now);
    const token = randomBytes(32).toString('base64url');
    this.tickets.set(token, { terminalId: record.info.id, expiresAt: now + TERMINAL_TICKET_TTL_MS });
    return token;
  }

  consumeTicket(id: string, token: string, now = Date.now()): boolean {
    this.expireTickets(now);
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.terminalId !== id || ticket.expiresAt <= now) return false;
    this.tickets.delete(token);
    const record = this.terminals.get(id);
    if (!record || record.connected) return false;
    record.connected = true;
    return true;
  }

  attach(id: string, socket: WebSocket): void {
    const record = this.terminals.get(id);
    if (!record) { socket.close(1008, 'Terminal is unavailable'); return; }
    record.sockets.add(socket);
    if (record.scrollback) socket.send(JSON.stringify({ type: 'output', data: record.scrollback }));
    socket.on('message', (raw, binary) => {
      if (binary) { socket.close(1003, 'Text messages only'); return; }
      if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) { socket.close(1003, 'Text messages only'); return; }
      if (Buffer.byteLength(raw) > 8192) { socket.close(1009, 'Message too large'); return; }
      let message: unknown;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1007, 'Invalid message'); return; }
      if (!message || typeof message !== 'object') { socket.close(1007, 'Invalid message'); return; }
      const value = message as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
      if (value.type === 'input' && typeof value.data === 'string' && Buffer.byteLength(value.data) <= 4096) {
        record.process.write(value.data);
        return;
      }
      if (value.type === 'resize') {
        try { record.process.resize(clampInteger(value.cols, 80, 2, TERMINAL_MAX_COLS), clampInteger(value.rows, 24, 2, TERMINAL_MAX_ROWS)); }
        catch { /* the process may have exited between the check and resize */ }
        return;
      }
      socket.close(1007, 'Unsupported terminal message');
    });
    socket.on('close', () => {
      record.sockets.delete(socket);
      record.connected = false;
    });
    socket.on('error', () => {
      record.sockets.delete(socket);
      record.connected = false;
    });
  }

  closeTerminal(id: string, projectId: string): boolean {
    const record = this.terminals.get(id);
    if (!record || record.info.projectId !== projectId) return false;
    this.disposeRecord(id, record);
    terminatePty(record.process);
    const escalation=setTimeout(()=>forceKillPty(record.process),750);
    void record.exited.then(()=>clearTimeout(escalation));
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.tickets.clear();
    const records = [...this.terminals.entries()];
    for (const [id, record] of records) {
      for (const socket of record.sockets) socket.close(1001, 'Pilot is shutting down');
      this.disposeRecord(id, record);
      terminatePty(record.process);
    }
    const escalation = setTimeout(() => { for (const [, record] of records) forceKillPty(record.process); }, 750);
    const forceDeadline = setTimeout(() => { for (const [, record] of records) forceKillPty(record.process); }, 2000);
    let waitTimer!: NodeJS.Timeout;
    await Promise.race([Promise.all(records.map(([, record]) => record.exited)), new Promise<void>((resolve) => { waitTimer=setTimeout(resolve,2200); })]);
    clearTimeout(escalation);clearTimeout(forceDeadline);clearTimeout(waitTimer);
  }

  private publish(record: TerminalRecord, data: string): void {
    const bytes = Buffer.byteLength(data);
    record.scrollback += data;
    record.scrollbackBytes += bytes;
    while (record.scrollbackBytes > TERMINAL_SCROLLBACK_BYTES && record.scrollback.length) {
      const drop = Math.max(1, Math.ceil((record.scrollbackBytes - TERMINAL_SCROLLBACK_BYTES) / 4));
      const removed = record.scrollback.slice(0, drop);
      record.scrollback = record.scrollback.slice(drop);
      record.scrollbackBytes -= Buffer.byteLength(removed);
    }
    const frame = JSON.stringify({ type: 'output', data });
    for (const socket of record.sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Terminal output is over the connection limit'); record.sockets.delete(socket); record.connected = false; continue; }
      try { socket.send(frame); } catch { socket.close(1011, 'Terminal output failed'); record.sockets.delete(socket); record.connected = false; }
    }
  }

  private disposeRecord(id: string, record: TerminalRecord): void {
    if (this.terminals.get(id) !== record) return;
    this.terminals.delete(id);
    for (const [token, ticket] of this.tickets) if (ticket.terminalId === id) this.tickets.delete(token);
    for (const socket of record.sockets) socket.close(1000, 'Terminal exited');
    record.sockets.clear();
  }

  private require(id: string, projectId: string): TerminalRecord {
    const record = this.terminals.get(id);
    if (!record || record.info.projectId !== projectId) throw new Error('Terminal not found.');
    return record;
  }

  private view(record: TerminalRecord): TerminalInfo {
    return Object.freeze({ ...record.info, connected: record.connected });
  }

  private expireTickets(now: number): void {
    for (const [token, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(token);
  }
}

/** One non-interactive model shell call, with a hard wall-clock and stored-output cap. */
export async function runShellCommand(input: {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; truncated: boolean }> {
  const command = input.command.trim();
  if (!command) throw new Error('A shell command is required.');
  if (Buffer.byteLength(command) > SHELL_MAX_COMMAND_BYTES) throw new Error('The shell command exceeds the documented 16 KiB limit.');
  if (input.signal?.aborted) throw new Error('The shell command was cancelled before it started.');
  const timeoutMs = clampInteger(input.timeoutMs, SHELL_MAX_COMMAND_MS, 100, SHELL_MAX_COMMAND_MS);
  return await new Promise((resolve, reject) => {
    const shell = configuredShell();
    const child = pty.spawn(shell, [...shellLoginArgs(shell), '-c', command], {
      name: 'xterm-256color', cols: 120, rows: 40, cwd: input.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    });
    let output = '', outputBytes = 0, truncated = false, timedOut = false, cancelled = false, settled = false;
    let killTimer: NodeJS.Timeout | undefined, reapTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      input.signal?.removeEventListener('abort', abort);
      resolve(Object.freeze({ exitCode: timedOut || cancelled ? null : exitCode, timedOut, stdout: output, stderr: '', truncated }));
    };
    const stop = () => {
      terminatePty(child);
      if (!killTimer) killTimer = setTimeout(() => forceKillPty(child), 750);
      if (!reapTimer) reapTimer = setTimeout(() => finish(null), 2000);
    };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    child.onData((chunk) => {
      const remaining = SHELL_MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) { truncated = true; stop(); return; }
      const bytes = Buffer.from(chunk);
      if (bytes.byteLength > remaining) {
        output += bytes.subarray(0, remaining).toString('utf8');
        outputBytes += remaining;
        truncated = true;
        stop();
      } else {
        output += chunk;
        outputBytes += bytes.byteLength;
      }
    });
    child.onExit(({ exitCode }) => finish(exitCode));
  });
}

function configuredShell(): string {
  return process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/bash';
}
function shellLoginArgs(shell: string): string[] {
  return shell.endsWith('/zsh') ? ['-l'] : ['--login'];
}
function terminatePty(child: pty.IPty): void {
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch { try { child.kill('SIGTERM'); } catch { /* already exited */ } }
}
function forceKillPty(child: pty.IPty): void {
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error('Terminal dimensions are outside the documented bounds.');
  return value as number;
}
