import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { kaneCommand } from '../config.js';
import { invocation } from '../invocation.js';
import { canonicalJson, sha256 } from '../hash.js';
import { bypassFlag, loadAgentCommand, wantsStreamJson, AGENT_PATH } from '../agent.js';
import { Refusal } from '../errors.js';
import { changedPaths, fileAt, git, head, short } from '../git.js';
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
// In Proven's own repository they read exactly as in the README (demo/app, node bin/proven.js); in another project
// they name that project's app folder and plain proven.
export const redPrompt = (id, { app = 'demo/app', proven = 'node bin/proven.js' } = {}) =>
  `Ticket ${id} is red. Read tickets/${id}.md and make it true in ${app}. When you believe it is done, run ${proven} done ${id} and follow what it prints.`;
export const reopenedPrompt = (id, { app = 'demo/app', proven = 'node bin/proven.js' } = {}) =>
  `proven recheck reopened ${id}. Read tickets/${id}.md and .proven/state/${id}.json for what Kane saw, fix ${app}, then run ${proven} done ${id} and follow what it prints.`;

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

// What the agent just did, from one stream-json line: the tool's name and the file or command it works on, or a short
// line of what the agent said. Never the content it writes and never a tool's result. Paths inside the repository are
// shown relative to it, so the lines stay readable.
const SAY_CHARS = 160;
function rootForms(root) {
  const forms = new Set([root]);
  try {
    forms.add(realpathSync(root));
  } catch {}
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length);
}
function relativeToRoot(roots, s) {
  let out = s;
  for (const r of roots) out = out.split(r + '/').join('');
  return out;
}
function toolLines(line, root) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  const roots = rootForms(root);
  const lines = [];
  for (const part of event.message.content) {
    if (part?.type === 'text' && typeof part.text === 'string' && plain(part.text)) {
      lines.push(`agent says: ${cut(plain(relativeToRoot(roots, part.text)), SAY_CHARS)}`);
      continue;
    }
    if (part?.type !== 'tool_use' || typeof part.name !== 'string') continue;
    const input = part.input && typeof part.input === 'object' ? part.input : {};
    const target = [input.file_path, input.notebook_path, input.command, input.path, input.pattern].find((x) => typeof x === 'string' && x);
    lines.push(`agent: ${plain(part.name)}${target ? ' ' + cut(plain(relativeToRoot(roots, target)), TOOL_CHARS) : ''}`);
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
      out.say(`${id} attempt ${state.attempts + 1} of ${config.maxAttempts}: Kane passed in proven done (not yet confirmed).`);
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
      child = spawn(cmd[0], [...cmd.slice(1), prompt], { cwd: root, env: { ...process.env, GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
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
        for (const l of toolLines(line, root)) out.say(`${id} ${l}`);
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
      if (streamJson && buffered.trim()) for (const l of toolLines(buffered, root)) out.say(`${id} ${l}`);
      poll();
      resolve({ code, signal });
    });
  });
}

// One agent session for one ticket. Returns 'closed' (Kane passed in proven done, not yet confirmed), 'needs-a-person', 'stopped', 'tampered' or 'not-run'.
async function session(ctx, id, i, n, cmd, streamJson) {
  const { root, out } = ctx;
  const { status } = readStatus(root, id);
  const before = head(root);
  const dirty = [...changedOwn(root, OWN_PATHS), ...hiddenFlags(root)];
  if (dirty.length) {
    out.both(`did not run: ${dirty.join(', ')} (Proven's own files) have uncommitted changes, so the loop could not tell the agent's changes from yours. Commit or restore them first.`);
    return 'not-run';
  }
  const pre = { state: loadState(root, id) };
  const hashesBefore = hashTree(root);
  const refsBefore = refsSnapshot(root);
  out.say(`${id}: starting the agent (${i} of ${n}).`);
  const result = await runAgent(ctx, id, cmd, (status === 'reopened' ? reopenedPrompt : redPrompt)(id, { app: ctx.config.app, proven: invocation(root) }), streamJson);
  if (result.notStarted) {
    const missing = result.notStarted.code === 'ENOENT';
    out.both(
      missing
        ? `did not run: the agent program ${cmd[0]} was not found on PATH. Install it or name another one in .proven/agent.json.`
        : `did not run: the agent program ${cmd[0]} could not start (${result.notStarted.message}).`,
    );
    return 'not-run';
  }
  const tampered = sessionTampering(ctx, id, before, pre, hashesBefore, refsBefore);
  if (tampered.length) {
    out.both(`Proven's own files changed during the agent's session: ${tampered.join(', ')}. Nothing from this session is trusted.`);
    return 'tampered';
  }
  const after = readStatus(root, id);
  if (after.status === 'done') {
    const at = receiptCommitAtHead(root, id);
    const failed = at ? verifyReceipt(root, at.bytes).checks.filter((c) => !c.ok) : [{ name: 'receipt', detail: 'it is not committed as Proven wrote it' }];
    if (!failed.length) return 'closed';
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

// Proven's own code and guard rails. The agent runs proven done as the judge, so a change here would change the judge.
const OWN_PATHS = ['bin', 'src', 'package.json', 'package-lock.json', '.claude', 'test', '.proven/config.json'];

// Files under Proven's own paths or tickets/ that differ from HEAD in the working tree or index, or are new and not
// ignored. A path that is not there is simply not listed.
function changedOwn(root, paths) {
  const lines = (args) => (git(root, args, { allowFail: true }) ?? '').split('\0').filter(Boolean);
  return [...new Set([...lines(['diff', '--name-only', '-z', 'HEAD', '--', ...paths]), ...lines(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths])])];
}

// Everything whose change would change the judge or what Proven trusts, hashed byte for byte, ignored files included.
// Kane's recordings under tickets/output-* are the one thing proven done writes there, and they are never trusted.
const HASHED = ['bin', 'src', 'package.json', 'package-lock.json', '.claude', 'test', 'tickets', '.proven/config.json', '.git/objects/info/alternates', '.git/objects/info/http-alternates'];
// The whole .git directory is hashed too, except what git itself rewrites all the time (objects, logs, the index) and
// the refs, which for-each-ref covers.
const GIT_SKIP = new Set(['objects', 'logs', 'index', 'refs', 'packed-refs']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.testmuai']);

function hashTree(root) {
  const map = new Map();
  const visit = (rel, { ignoreFiles = false } = {}) => {
    let st;
    try {
      st = lstatSync(join(root, rel));
    } catch {
      return;
    }
    const name = rel.split('/').at(-1);
    if (st.isSymbolicLink()) map.set(rel, `link:${readlinkSync(join(root, rel))}`);
    else if (st.isDirectory()) {
      if (name.startsWith('output-')) return;
      for (const child of readdirSync(join(root, rel)).sort()) visit(`${rel}/${child}`, { ignoreFiles });
    } else if (!ignoreFiles || name === '.gitignore' || name === '.gitattributes') map.set(rel, sha256(readFileSync(join(root, rel))));
  };
  for (const rel of HASHED) visit(rel);
  const visitGit = (rel, top) => {
    let st;
    try {
      st = lstatSync(join(root, rel));
    } catch {
      return;
    }
    const name = rel.split('/').at(-1);
    if (top && (GIT_SKIP.has(name) || name.startsWith('proven-index-') || name.startsWith('index.'))) return;
    if (st.isSymbolicLink()) map.set(rel, `link:${readlinkSync(join(root, rel))}`);
    else if (st.isDirectory()) for (const child of readdirSync(join(root, rel)).sort()) visitGit(`${rel}/${child}`, rel === '.git');
    else map.set(rel, sha256(readFileSync(join(root, rel))));
  };
  visitGit('.git', false);
  // Every .gitignore in the project decides what git leaves out.
  const walk = (rel) => {
    for (const child of readdirSync(join(root, rel || '.')).sort()) {
      const path = rel ? `${rel}/${child}` : child;
      const st = lstatSync(join(root, path));
      if (st.isDirectory() && !SKIP_DIRS.has(child) && !child.startsWith('output-')) walk(path);
      else if (child === '.gitignore' || child === '.gitattributes') map.set(path, sha256(readFileSync(join(root, path))));
    }
  };
  walk('');
  return map;
}

function hashDiff(before, after) {
  const out = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) if (before.get(k) !== after.get(k)) out.push(k);
  return out;
}

// Every ref and what HEAD points at. Only the current branch may move, and sessionCommits checks how.
function refsSnapshot(root) {
  const refs = new Map();
  for (const line of (git(root, ['for-each-ref', '--format=%(objectname) %(refname)'], { allowFail: true }) ?? '').split('\n').filter(Boolean)) {
    const at = line.indexOf(' ');
    refs.set(line.slice(at + 1), line.slice(0, at));
  }
  return { refs, symbolic: (git(root, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true }) ?? '').trim() };
}

function refsDiff(before, after) {
  const out = [];
  if (before.symbolic !== after.symbolic) out.push('HEAD');
  for (const k of new Set([...before.refs.keys(), ...after.refs.keys()])) {
    if (k !== before.symbolic && before.refs.get(k) !== after.refs.get(k)) out.push(k);
  }
  return out;
}

// Every file under a directory, sorted, symlinks not followed, as one hash.
function hashDir(dir) {
  const lines = [];
  const walk = (rel) => {
    for (const child of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${child}` : child;
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) lines.push(`${path}\0link:${readlinkSync(join(dir, path))}`);
      else if (st.isDirectory()) walk(path);
      else lines.push(`${path}\0${sha256(readFileSync(join(dir, path)))}`);
    }
  };
  walk('');
  return sha256(Buffer.from(lines.join('\n')));
}

// The Kane program: where kane-cli is, symlinks followed, and a hash of its whole package directory (the nearest folder
// above the entry file that has a package.json; the entry file alone if there is none). The test fake is hashed as
// its script. A null hash means it could not be found or read, which counts as a failure.
export function kaneIdentity(kane = kaneCommand(), env = process.env) {
  const { command } = kane;
  const entry = command[0] === process.execPath && command[1] ? command[1] : command[0];
  let path = entry.includes('/') ? entry : null;
  if (!path) {
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      try {
        accessSync(join(dir, entry), constants.X_OK);
        if (lstatSync(join(dir, entry)).isDirectory()) continue;
        path = join(dir, entry);
        break;
      } catch {}
    }
  }
  if (!path) return { path: entry, hash: null };
  try {
    const real = realpathSync(path);
    let pkg = null;
    if (!kane.fake) {
      for (let dir = dirname(real); dir !== dirname(dir); dir = dirname(dir)) {
        if (existsSync(join(dir, 'package.json'))) {
          pkg = dir;
          break;
        }
      }
    }
    return { path: real, hash: pkg ? hashDir(pkg) : sha256(readFileSync(real)) };
  } catch {
    return { path, hash: null };
  }
}

// Paths git is told to ignore the changes of (skip-worktree or assume-unchanged), under the protected paths.
function hiddenFlags(root) {
  const out = git(root, ['ls-files', '-v', '-z', '--', ...OWN_PATHS, 'tickets'], { allowFail: true }) ?? '';
  return out.split('\0').filter((l) => l.length > 2 && (l[0] === 'S' || /[a-z]/.test(l[0]))).map((l) => l.slice(2));
}

// The ticket's red record is part of what the agent was handed; a session cannot change it.
const sameRed = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

// The commits of one session, checked against the state the ticket was in when it began. They must name the ticket
// that was handed over, touch only its state, its receipt and the app, be shaped like proven done's own, leave the red
// record alone, never lower the attempt count, and say done only with a receipt whose red is that record.
function sessionCommits(ctx, id, before, pre) {
  const { root, config } = ctx;
  const p = ticketPaths(id);
  const bad = [];
  const commits = (git(root, ['rev-list', '--reverse', `${before}..HEAD`], { allowFail: true }) ?? '').split('\n').filter(Boolean);
  let prev = pre.state;
  const read = (commit, rel) => {
    try {
      return JSON.parse(fileAt(root, commit, rel).toString('utf8'));
    } catch {
      return null;
    }
  };
  for (const c of commits) {
    const subject = git(root, ['log', '-1', '--format=%s', c]).trim();
    const paths = changedPaths(root, c);
    const flag = (why) => bad.push(...(paths.length ? paths : [`commit ${short(c)}`]).map((x) => (why ? `${x} (${why})` : x)));
    const app = (x) => x.startsWith(config.app + '/');
    if (!subject.startsWith(`${id}: `) || !paths.length || !paths.every((x) => x === p.state || x === p.receipt || app(x))) {
      flag(subject.startsWith(`${id}: `) ? '' : `not ${id}`);
      continue;
    }
    if (subject === `${id}: app change that Kane passed` && paths.every(app)) continue;
    const isReceipt = subject.startsWith(`${id}: receipt`) && paths.length === 2 && paths.includes(p.state) && paths.includes(p.receipt);
    const isState = paths.length === 1 && paths[0] === p.state;
    if (!isReceipt && !isState) {
      flag('not a commit proven done makes');
      continue;
    }
    const state = read(c, p.state);
    if (!state || !sameRed(state.red, pre.state.red)) {
      flag('red record changed');
      continue;
    }
    const allowed = isReceipt ? ['done'] : ['in-progress', 'needs-a-person'];
    const step = isReceipt ? 0 : 1;
    if (!allowed.includes(state.status) || !Number.isInteger(state.attempts) || state.attempts < prev.attempts || state.attempts - prev.attempts > step) {
      flag('state does not follow from the one before');
      continue;
    }
    if (isReceipt) {
      const receipt = read(c, p.receipt);
      const okRed = receipt && receipt.red && Object.keys(receipt.red).every((k) => sameRed(receipt.red[k], pre.state.red[k]));
      if (!receipt || receipt.ticket !== id || !okRed || receipt.green?.app_tree !== state.green?.app_tree || receipt.green?.failed_attempts !== state.attempts) {
        flag('receipt does not match the red the session began with');
        continue;
      }
    }
    prev = state;
  }
  return bad;
}

// After an agent session. Returns what says Proven's code, git setup, tickets or history were touched.
function sessionTampering(ctx, id, before, pre, hashesBefore, refsBefore) {
  const { root } = ctx;
  const bad = [...changedOwn(root, [...OWN_PATHS, 'tickets']), ...hashDiff(hashesBefore, hashTree(root)), ...hiddenFlags(root), ...refsDiff(refsBefore, refsSnapshot(root)).map((r) => (r === 'HEAD' ? 'HEAD' : r))];
  if (head(root) !== before && git(root, ['merge-base', '--is-ancestor', before, 'HEAD'], { allowFail: true }) === null) bad.push('history was rewritten');
  bad.push(...sessionCommits(ctx, id, before, pre));
  return [...new Set(bad)];
}

const OPEN = new Set(['red', 'in-progress', 'reopened']);

// proven loop [T-N ...]: hand each red, in progress or reopened ticket to the coding agent, one at a time, then
// recheck, and hand back what the recheck reopens, for at most 2 rounds. Exit 0 all done and the last recheck passes,
// 1 a ticket needs a person, the agent stopped without a green or the last recheck reopened one, 2 something did not run.
export async function cmdLoop(ctx, ids, flags = {}) {
  const { root, out } = ctx;
  ids.forEach(checkId);
  if (lstatSync(join(root, '.git')).isFile()) {
    throw new Refusal('proven loop does not run where .git is a file (a git worktree or a submodule). Run it in the main clone of the repository.');
  }
  const { command: cmd, fromFile } = loadAgentCommand(root);
  const bypass = bypassFlag(cmd);
  if (bypass) throw new Refusal(`proven loop refuses an agent command that skips permission checks (${bypass}). Proven never runs one.`);
  if (fromFile) {
    if (!flags['agent-config']) {
      throw new Refusal(
        `${AGENT_PATH} names the agent command ${JSON.stringify(cmd)}, and the repository may not be yours. Nothing was run. If you wrote it or trust it, run proven loop again with --agent-config.`,
      );
    }
    out.say(`Using the agent command from ${AGENT_PATH}: ${JSON.stringify(cmd)}`);
  }
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

  const kaneBefore = kaneIdentity();
  if (kaneBefore.hash === null) {
    out.both(`did not run: the Kane program ${kaneBefore.path} could not be found or read. Install Kane CLI first.`);
    return 2;
  }
  for (let round = 0; ; round++) {
    let stopped = stuck;
    const closed = [];
    for (const [k, id] of pending.entries()) {
      const result = await session(ctx, id, k + 1, pending.length, cmd, streamJson);
      if (result === 'not-run') return 2;
      if (result === 'tampered') return 1;
      if (result === 'closed') closed.push(id);
      else stopped = true;
    }
    if (stopped) {
      out.both('Loop stopped: a ticket needs a person or the agent stopped without a green. No recheck was run.');
      return 1;
    }
    // Nothing a session says is taken as the verdict: Kane runs again, from this process's own code, on every done
    // ticket, including the ones the agent just closed.
    const kaneNow = kaneIdentity();
    if (kaneNow.hash === null || kaneNow.path !== kaneBefore.path || kaneNow.hash !== kaneBefore.hash) {
      out.both(
        kaneNow.hash === null
          ? `did not run: the Kane program ${kaneNow.path} could not be found or read. Nothing was rechecked.`
          : `did not run: the Kane program ${kaneNow.path} changed since the loop started. Nothing was rechecked.`,
      );
      return 2;
    }
    const recheckResults = new Map();
    const code = await cmdRecheck({ ...ctx, recheckResults }, []);
    let unconfirmed = false;
    for (const id of closed) {
      const r = recheckResults.get(id);
      if (r === 'passed') out.say(`${id} is done: confirmed by a fresh Kane run from proven loop.`);
      else if (r !== 'reopened') {
        out.both(`${id} is not confirmed: the fresh Kane run did not complete.`);
        unconfirmed = true;
      }
    }
    if (code === 2 || unconfirmed) {
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
