import { spawn } from 'node:child_process';
import { loadAgentCommand, wantsStreamJson } from '../agent.js';
import { Refusal } from '../errors.js';
import { fileAt, git, head } from '../git.js';
import { readLock } from '../lock.js';
import { receiptCommitAtHead, verifyReceipt } from '../receipt.js';
import { loadState, statusOf } from '../state.js';
import { checkId, ticketIds, ticketPaths } from '../ticket.js';
import { cmdRecheck } from './recheck.js';

const MAX_HANDBACK_ROUNDS = 2;
const POLL_MS = 500;
const TOOL_CHARS = 100;
const LABELS = {
  new: 'not frozen',
  frozen: 'frozen, no red yet',
  'already-passes': 'already passes',
};

// The only two prompts. They name the ticket id and the files to read, and nothing Kane wrote.
export const redPrompt = (id) =>
  `Ticket ${id} is red. Read tickets/${id}.md and make it true in demo/app. When you believe it is done, run node bin/proven.js done ${id} and follow what it prints.`;
export const reopenedPrompt = (id) =>
  `proven recheck reopened ${id}. Read tickets/${id}.md and .proven/state/${id}.json for what Kane saw, fix demo/app, then run node bin/proven.js done ${id} and follow what it prints.`;

// One line of plain text: control characters (colour codes, carriage returns) become spaces.
const plain = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

function readStatus(root, id) {
  try {
    const lock = readLock(root, id);
    return { status: statusOf(lock ? loadState(root, id) : null, lock) };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    return { status: 'unreadable', why: err.message };
  }
}

// What the agent just did, from one stream-json line: the tool's name and the file or command it works on. Never the
// content it writes and never a tool's result.
function toolLines(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  const lines = [];
  for (const part of event.message.content) {
    if (part?.type !== 'tool_use' || typeof part.name !== 'string') continue;
    const input = part.input && typeof part.input === 'object' ? part.input : {};
    const target = [input.file_path, input.notebook_path, input.command, input.path, input.pattern].find((x) => typeof x === 'string' && x);
    lines.push(`${plain(part.name)}${target ? ' ' + cut(plain(target), TOOL_CHARS) : ''}`);
  }
  return lines;
}

// Prints each attempt that proven done has recorded for this ticket since `since`: state commits only, so nothing is
// read from Kane's output a second time. Returns the new place to read from.
function printAttempts(ctx, id, since) {
  const { root, config, out } = ctx;
  const rel = ticketPaths(id).state;
  const now = head(root);
  if (now === since) return since;
  const log = git(root, ['log', '--reverse', '--format=%H', `${since}..${now}`, '--', rel], { allowFail: true }) ?? '';
  for (const commit of log.split('\n').filter(Boolean)) {
    let state;
    try {
      state = JSON.parse(fileAt(root, commit, rel).toString('utf8'));
    } catch {
      continue;
    }
    if (state.status === 'done') {
      out.say(`${id} attempt ${state.attempts + 1} of ${config.maxAttempts}: Kane passed.`);
    } else if (state.last_failure && state.last_failure.attempt === state.attempts) {
      const f = state.last_failure;
      const says = plain(f.kane_one_liner);
      out.say(`${id} attempt ${f.attempt} of ${config.maxAttempts}: Kane failed step ${f.failed_step} (${plain(f.failed_step_title)}).${says ? ` Kane says: ${cut(says, 300)}` : ''}`);
    }
  }
  return now;
}

// Starts the agent for one ticket and waits for it. The program is run directly, with no shell, and the prompt is its
// last argument.
function runAgent(ctx, id, cmd, prompt, streamJson) {
  const { root, out } = ctx;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd[0], [...cmd.slice(1), prompt], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      resolve({ notStarted: err });
      return;
    }
    let buffered = '';
    let since = head(root);
    const poll = () => {
      try {
        since = printAttempts(ctx, id, since);
      } catch {
        // progress is best effort; the verdict is read from the state afterwards
      }
    };
    const timer = setInterval(poll, POLL_MS);
    const feed = (chunk) => {
      if (!streamJson) return;
      buffered += chunk.toString('utf8');
      let at;
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        for (const l of toolLines(line)) out.say(`${id} agent: ${l}`);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', () => {});
    child.on('error', (err) => {
      clearInterval(timer);
      resolve({ notStarted: err });
    });
    child.on('close', (code, signal) => {
      clearInterval(timer);
      if (streamJson && buffered.trim()) for (const l of toolLines(buffered)) out.say(`${id} agent: ${l}`);
      poll();
      resolve({ code, signal });
    });
  });
}

// One agent session for one ticket. Returns 'done', 'needs-a-person', 'stopped' or 'not-run'.
async function session(ctx, id, i, n, cmd, streamJson) {
  const { root, out } = ctx;
  const { status } = readStatus(root, id);
  out.say(`${id}: starting the agent (${i} of ${n}).`);
  const result = await runAgent(ctx, id, cmd, status === 'reopened' ? reopenedPrompt(id) : redPrompt(id), streamJson);
  if (result.notStarted) {
    const missing = result.notStarted.code === 'ENOENT';
    out.both(
      missing
        ? `did not run: the agent program ${cmd[0]} was not found on PATH. Install it or name another one in .proven/agent.json.`
        : `did not run: the agent program ${cmd[0]} could not start (${result.notStarted.message}).`,
    );
    return 'not-run';
  }
  const after = readStatus(root, id);
  if (after.status === 'done') {
    const at = receiptCommitAtHead(root, id);
    const failed = at ? verifyReceipt(root, at.bytes).checks.filter((c) => !c.ok) : [{ name: 'receipt', detail: 'it is not committed as Proven wrote it' }];
    if (!failed.length) {
      out.say(`${id} is done: receipt verifies.`);
      return 'done';
    }
    out.both(`${id}: the agent stopped without a green: the receipt does not verify (${failed[0].name}: ${failed[0].detail}).`);
    return 'stopped';
  }
  if (after.status === 'needs-a-person') {
    out.both(`${id} needs a person after ${loadState(root, id).attempts} failed attempts. The loop stops work on it.`);
    return 'needs-a-person';
  }
  const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`;
  out.both(`${id}: the agent stopped without a green (${how}).${after.why ? ' ' + after.why : ''}`);
  return 'stopped';
}

const OPEN = new Set(['red', 'in-progress', 'reopened']);

// proven loop [T-N ...]: hand each red, in progress or reopened ticket to the coding agent, one at a time, then
// recheck, and hand back what the recheck reopens, for at most 2 rounds. Exit 0 all done and the last recheck passes,
// 1 a ticket needs a person, the agent stopped without a green or the last recheck reopened one, 2 something did not run.
export async function cmdLoop(ctx, ids) {
  const { root, out } = ctx;
  ids.forEach(checkId);
  const cmd = loadAgentCommand(root);
  const streamJson = wantsStreamJson(cmd);
  const named = ids.length > 0;

  let pending = [];
  let notReady = false;
  let stuck = false;
  const skipped = [];
  for (const id of named ? ids : ticketIds(root)) {
    const { status, why } = readStatus(root, id);
    if (OPEN.has(status)) pending.push(id);
    else if (status === 'done') {
      if (named) out.say(`${id} is already done.`);
    } else if (status === 'needs-a-person') {
      if (named) {
        out.both(`${id} needs a person. The loop does not hand it to the agent.`);
        stuck = true;
      } else skipped.push(`${id} (needs a person)`);
    } else if (named) {
      out.both(`${id}: not handed to the agent: ${why ?? LABELS[status] ?? status}. A person freezes it and records red first.`);
      notReady = true;
    } else if (status === 'unreadable') skipped.push(`${id} (${why})`);
    else skipped.push(`${id} (${LABELS[status] ?? status})`);
  }
  if (skipped.length) out.say(`Skipped: ${skipped.join(', ')}.`);
  if (!pending.length) {
    out.say('No ticket is red, in progress or reopened, so there is nothing to hand to the agent.');
    return notReady ? 2 : stuck ? 1 : 0;
  }

  for (let round = 0; ; round++) {
    let stopped = stuck;
    for (const [k, id] of pending.entries()) {
      const result = await session(ctx, id, k + 1, pending.length, cmd, streamJson);
      if (result === 'not-run') return 2;
      if (result !== 'done') stopped = true;
    }
    if (stopped) {
      out.both('Loop stopped: a ticket needs a person or the agent stopped without a green. No recheck was run.');
      return 1;
    }
    const code = await cmdRecheck(ctx, []);
    if (code === 2) {
      out.both('Loop stopped: the recheck did not run to the end.');
      return 2;
    }
    if (code === 0) {
      out.both('Loop finished: every ticket is done and the last recheck passes.');
      return notReady ? 2 : 0;
    }
    pending = ticketIds(root).filter((id) => readStatus(root, id).status === 'reopened');
    if (!pending.length) {
      out.both('Loop stopped: the recheck reported a reopen but no ticket is reopened.');
      return 1;
    }
    if (round >= MAX_HANDBACK_ROUNDS) {
      out.both(`Loop stopped: the last recheck reopened ${pending.join(', ')}, and the limit of ${MAX_HANDBACK_ROUNDS} hand-back rounds is used up.`);
      return 1;
    }
    out.say(`Handing back to the agent: ${pending.join(', ')} (recheck round ${round + 1} of ${MAX_HANDBACK_ROUNDS}).`);
  }
}
