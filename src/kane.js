import { spawn } from 'node:child_process';

// Run Kane as its own process group and read its NDJSON stdout.
// Proven keeps its own timer: Kane's launcher ignores SIGTERM and runs the real CLI as a child,
// so on timeout or Ctrl+C the whole group is stopped.
export function runKane({ command, args, cwd, timeoutMs, graceMs = 5000, onEvent }) {
  return new Promise((resolve) => {
    const events = [];
    const raw = [];
    let pending = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    let spawnError = null;
    let settled = false;
    let killTimer = null;
    const group = process.platform !== 'win32';

    let child;
    try {
      child = spawn(command[0], [...command.slice(1), ...args], {
        cwd,
        detached: group,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      resolve({ events, exitCode: null, signal: null, timedOut, interrupted, stderr, raw: '', spawnError: err });
      return;
    }

    const kill = (sig) => {
      try {
        if (group) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {}
    };
    const stop = () => {
      kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => kill('SIGKILL'), graceMs);
    };
    const onSignal = () => {
      interrupted = true;
      stop();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    const takeLine = (line) => {
      raw.push(line);
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const event = JSON.parse(trimmed);
        if (event && typeof event === 'object') {
          events.push(event);
          if (onEvent) {
            try {
              onEvent(event);
            } catch {}
          }
        }
      } catch {}
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        takeLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-65536);
    });

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (pending) takeLine(pending);
      resolve({ events, exitCode, signal, timedOut, interrupted, stderr, raw: raw.join('\n'), spawnError });
    };
    child.on('error', (err) => {
      spawnError = err;
      if (child.pid === undefined) finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
