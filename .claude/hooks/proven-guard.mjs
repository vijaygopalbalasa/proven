#!/usr/bin/env node
// Proven's guard for Claude Code, written into a project by proven init. Claude Code runs it before every Write,
// Edit, MultiEdit, NotebookEdit and Bash call (a PreToolUse hook) and sends the call as JSON on stdin. Exit code 2
// blocks the call and shows the reason on stderr to the agent. Exit code 0 lets it through.
//
// It blocks the agent from changing files under tickets/ (which holds Kane's recordings, tickets/output-T-N/),
// receipts/, .proven/ and .claude/, and from running proven new, proven freeze or proven red, which are a person's
// steps. It is a guard rail, not a sandbox: an agent
// with a shell can still get around it. That is why Proven shows a ticket as done only for a receipt that verifies.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROTECTED = ['tickets', 'receipts', '.proven', '.claude'];
export const PERSON_STEPS = ['new', 'freeze', 'red'];
const WRAPPERS = new Set(['node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'env', 'sudo', 'time', 'exec', 'command', 'nice', 'nohup']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

const WHY = {
  tickets: 'Tickets, their frozen tests and locks are a person\'s. Fix the app, not the test.',
  receipts: 'Receipts are written only by proven done, when Kane passes the frozen test.',
  '.proven': 'Proven writes its own state there.',
  '.claude': 'That folder holds these guard rails.',
};
const DONE_HINT = 'When you believe a ticket is done, run proven done T-N and wait for Kane.';

// A path with symlinks resolved in the part of it that exists.
function realish(p) {
  let head = p;
  const rest = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return p;
    rest.unshift(basename(head));
    head = parent;
  }
  try {
    return join(realpathSync(head), ...rest);
  } catch {
    return p;
  }
}

// Which protected folder of the project a path falls in, or null. Names are compared without case, because a
// file system that ignores case would write Tickets/ into tickets/.
export function protectedArea(path, { projectDir, cwd }) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const root = realish(resolve(projectDir));
  const target = realish(resolve(cwd || projectDir, path.trim()));
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const top = rel.split(sep)[0].toLowerCase();
  return PROTECTED.includes(top) ? top : null;
}

// Split a shell command into simple commands (lists of words) and the files it redirects output to. It reads quotes,
// escapes, ; && || | &, newlines, ( ), $( ) and backticks. It is rough on purpose: a guard rail, not a parser.
export function shellParts(command) {
  const commands = [];
  const targets = [];
  let words = [];
  let word = '';
  let inWord = false;
  let redirect = null;
  const endWord = () => {
    if (!inWord) return;
    if (redirect === '>') targets.push(word);
    else if (!redirect) words.push(word);
    redirect = null;
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const s = String(command ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      word += s.slice(i + 1, j < 0 ? s.length : j);
      inWord = true;
      i = j < 0 ? s.length : j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) word += s[j] === '\\' && j + 1 < s.length ? s[++j] : s[j];
      inWord = true;
      i = j;
    } else if (c === '\\' && i + 1 < s.length) {
      word += s[++i];
      inWord = true;
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if ('\n;|&()`'.includes(c)) {
      if (c === '&' && s[i + 1] === '>') continue;
      endCommand();
    } else if (c === '$' && s[i + 1] === '(') {
      endCommand();
      i++;
    } else if (c === '>' || c === '<') {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else endWord();
      if (s[i + 1] === '>') i++;
      if (c === '>' && s[i + 1] === '&') {
        i++;
        redirect = 'dup';
      } else redirect = c === '>' ? '>' : '<';
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  // Command substitutions inside double quotes still run.
  for (const w of commands.flat()) {
    const at = w.search(/\$\(|`/);
    if (at >= 0) {
      const inner = shellParts(w.slice(at + (w[at] === '$' ? 2 : 1)));
      commands.push(...inner.commands);
      targets.push(...inner.targets);
    }
  }
  return { commands, targets };
}

const isProven = (w) => /^proven(\.m?js)?$/.test(basename(w));

// The person's step a simple command runs (new, freeze or red), or null. The program is the first word after any
// NAME=value; behind a wrapper such as node, npx or sudo, it is the first word that names proven.
export function personStep(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  const program = words[i];
  if (!program) return null;
  let at = -1;
  if (isProven(program)) at = i;
  else if (WRAPPERS.has(basename(program))) at = words.findIndex((w, j) => j > i && isProven(w));
  if (at < 0) return null;
  const step = words.slice(at + 1).find((w) => !w.startsWith('-'));
  return PERSON_STEPS.includes(step) ? step : null;
}

// The paths a simple command writes to, for the usual ways a shell copies, moves, links, creates, deletes or edits
// files in place. Reading is left alone: cp tickets/T-1.md elsewhere is fine.
export function writeTargets(words) {
  const name = basename(words[0] ?? '');
  const args = words.slice(1);
  const plain = args.filter((w) => !w.startsWith('-'));
  const valueOf = (...flags) => {
    for (let i = 0; i < args.length; i++) {
      for (const f of flags) {
        if (args[i] === f) return args[i + 1] ?? null;
        if (f.startsWith('--') && args[i].startsWith(`${f}=`)) return args[i].slice(f.length + 1);
        if (!f.startsWith('--') && args[i].startsWith(f) && args[i].length > f.length) return args[i].slice(f.length);
      }
    }
    return null;
  };
  switch (name) {
    case 'cp':
    case 'ln':
    case 'rsync':
    case 'install':
    case 'ditto':
    case 'scp': {
      const target = valueOf('-t', '--target-directory');
      return target ? [target] : plain.slice(-1);
    }
    case 'mv': {
      // Moving a file away changes it as much as writing over it.
      const target = valueOf('-t', '--target-directory');
      return target ? [target, ...plain] : plain;
    }
    case 'mkdir':
    case 'touch':
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'truncate':
    case 'shred':
      return plain;
    case 'sed':
    case 'perl':
      return args.some((w) => /^-[A-Za-z]*i/.test(w) || w.startsWith('--in-place')) ? plain : [];
    case 'tar': {
      const dir = valueOf('-C', '--directory');
      return dir ? [dir] : [];
    }
    case 'unzip': {
      const dir = valueOf('-d');
      return dir ? [dir] : [];
    }
    default:
      return [];
  }
}

function bashVerdict(command, where, depth = 0) {
  const { commands, targets } = shellParts(command);
  for (const words of commands) {
    const step = personStep(words);
    if (step) return `Proven: proven ${step} is a person's step, not the agent's. Work on the app. ${DONE_HINT}`;
    const name = basename(words[0] ?? '');
    if (name === 'tee') targets.push(...words.slice(1).filter((w) => !w.startsWith('-')));
    targets.push(...writeTargets(words));
    if (SHELLS.has(name) && depth < 3) {
      const k = words.indexOf('-c');
      if (k > 0 && words[k + 1]) {
        const inner = bashVerdict(words[k + 1], where, depth + 1);
        if (inner) return inner;
      }
    }
  }
  for (const t of targets) {
    const area = protectedArea(t, where);
    if (area) return `Proven: this command writes to ${t}, under ${area}/, which the agent does not change. ${WHY[area]} ${DONE_HINT}`;
  }
  return null;
}

// The reason to block a tool call, or null to let it through.
export function decide(input, { projectDir }) {
  if (!input || typeof input !== 'object') return null;
  const tool = input.tool_name;
  const args = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const where = { projectDir, cwd: typeof input.cwd === 'string' ? input.cwd : projectDir };
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const path = args.file_path ?? args.notebook_path;
    const area = protectedArea(path, where);
    if (area) return `Proven: ${path} is under ${area}/, which the agent does not change. ${WHY[area]} ${DONE_HINT}`;
    return null;
  }
  if (tool === 'Bash') return bashVerdict(args.command, where);
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // Not a tool call this guard understands. It lets it through rather than stall the agent.
    return 0;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof input?.cwd === 'string' ? input.cwd : process.cwd());
  const reason = decide(input, { projectDir });
  if (!reason) return 0;
  process.stderr.write(reason + '\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realish(resolve(process.argv[1]))).href) {
  process.exitCode = await main();
}
