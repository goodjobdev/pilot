import { spawn as realSpawn } from 'node:child_process';

export function supervise({ spawn = realSpawn, nodeArgs, goArgs, env = process.env, stdout = process.stdout, stderr = process.stderr, exit = (code) => { process.exitCode = code; }, timeoutMs = 30000 }) {
  const children = [];
  let stopping = false;
  let failed = false;
  let ready = 0;
  let timer;
  const killAll = (signal) => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const stop = (signal = 'SIGTERM', fail = false) => {
    if (fail) failed = true;
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    killAll(signal);
    setTimeout(() => killAll('SIGKILL'), 27000).unref?.();
  };
  const onSignal = () => stop('SIGTERM');
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const start = (command, args, readyText) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      stop('SIGTERM', true);
      if (children.length === 0) {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        exit(1);
      }
      return null;
    }
    children.push(child);
    let announced = false;
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout.write(text);
      if (!announced && text.includes(readyText)) { announced = true; ready++; if (ready === 2) clearTimeout(timer); }
    });
    child.stderr.on('data', (chunk) => stderr.write(chunk));
    child.on('error', () => stop('SIGTERM', true));
    child.on('exit', (code, signal) => {
      const wasStopping = stopping;
      if (!wasStopping) stop('SIGTERM', true);
      if (code !== 0 && code !== null || signal && !wasStopping) failed = true;
      if (children.every((item) => item.exitCode !== null || item.signalCode !== null)) {
        clearTimeout(timer);
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        exit(failed ? 1 : 0);
      }
    });
    return child;
  };
  timer = setTimeout(() => stop('SIGTERM', true), timeoutMs);
  start(process.execPath, nodeArgs, 'private preview core listening');
  if (!stopping) start('/usr/local/bin/tsnet-ingress', goArgs, 'tsnet HTTPS ingress ready');
  return { stop, get readyCount() { return ready; } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { validateRuntimeConfig } = await import('./gateway/preflight.mjs');
  try {
    validateRuntimeConfig(process.env);
    supervise({ nodeArgs: ['/opt/preview/gateway/private-server.js'] });
  } catch (error) {
    process.stderr.write(`startup preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
