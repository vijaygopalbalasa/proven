#!/usr/bin/env node
// Proven's guard for Claude Code, written into a project by proven init. Claude Code runs it before every Write,
// Edit, MultiEdit, NotebookEdit and Bash call (a PreToolUse hook) and sends the call as JSON on stdin. Exit code 2
// blocks the call and shows the reason on stderr to the agent. Exit code 0 lets it through.
//
// It blocks the agent from changing files under tickets/ (which holds Kane's recordings, tickets/output-T-N/),
// receipts/, .proven/ and .claude/, and from running proven new, proven freeze or proven red, which are a person's
// steps. For shell commands it fails closed where it can: a command that writes files is blocked when any of its
// arguments points into those folders, whichever argument the command would write to. It is defence in depth, not a
// sandbox: an agent with a shell can still get around it. That is why Proven shows a ticket as done only for a
// receipt that verifies.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROTECTED = ['tickets', 'receipts', '.proven', '.claude'];
export const PERSON_STEPS = ['new', 'freeze', 'red'];
// Programs that run another program named later on the line.
const WRAPPERS = new Set([
  'node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'env', 'sudo', 'doas', 'time', 'exec', 'command', 'builtin',
  'nice', 'nohup', 'timeout', 'xargs', 'stdbuf', 'ionice', 'caffeinate', 'watch',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// Programs that write, move, link, create or delete the files they are given.
const WRITERS = new Set([
  'cp', 'mv', 'ln', 'rsync', 'install', 'ditto', 'scp', 'mkdir', 'touch', 'rm', 'rmdir', 'unlink', 'truncate', 'shred',
  'chmod', 'chown', 'tar', 'unzip', 'dd', 'patch', 'tee',
]);
// Programs that edit files in place only with -i (bundled or not) or --in-place.
const EDITORS = new Set(['sed', 'gsed', 'perl']);
// Programs that run code given on the line.
const INTERPRETERS = new Set(['node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'osascript']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A protected folder named as a path segment inside code or text.
const MENTION = /(^|[\s'"`(=,:/])(tickets|receipts|\.proven|\.claude)(\/|\\|$|[\s'"`),;])/i;

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

// Where the program of a simple command is: the first word after any NAME=value. Behind a wrapper such as env, sudo,
// timeout or xargs, it is the first later word that `matches`. Returns -1 when there is none.
function programIndex(words, matches) {
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i])) i++;
  if (i >= words.length) return -1;
  if (matches(words[i])) return i;
  if (!WRAPPERS.has(basename(words[i]))) return -1;
  return words.findIndex((w, j) => j > i && matches(w));
}

// The person's step a simple command runs (new, freeze or red), or null.
export function personStep(words) {
  const at = programIndex(words, isProven);
  if (at < 0) return null;
  const step = words.slice(at + 1).find((w) => !w.startsWith('-'));
  return PERSON_STEPS.includes(step) ? step : null;
}

// Every path an argument could name: the word itself, the value after an =, and for an option word every tail of it,
// so a value bundled into short options (cp -vtDIR, tar -xzCDIR) is seen too.
function pathsIn(word) {
  const out = [word];
  const eq = word.indexOf('=');
  if (eq >= 0) out.push(word.slice(eq + 1));
  if (word.startsWith('-')) for (let i = 1; i < word.length; i++) out.push(word.slice(i));
  return out;
}

// What a simple command may write to: for a writing program, every argument after it, whichever one the program
// would really write to. That leaves no parser to get around. An editor counts only when it edits in place.
export function writeTargets(words) {
  const at = programIndex(words, (w) => WRITERS.has(basename(w)) || EDITORS.has(basename(w)) || basename(w) === 'find');
  if (at < 0) return [];
  const name = basename(words[at]);
  const args = words.slice(at + 1);
  if (EDITORS.has(name) && !args.some((w) => (/^-[^-]/.test(w) && w.includes('i')) || w.startsWith('--in-place'))) return [];
  if (name === 'find' && !args.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(w))) return [];
  return args.flatMap(pathsIn);
}

// Code given on the line (node -e, python -c, perl -e) that names a protected folder. The guard cannot tell whether
// the code reads or writes, so it blocks.
function inlineCodeArea(words) {
  const at = programIndex(words, (w) => INTERPRETERS.has(basename(w)));
  if (at < 0) return null;
  const args = words.slice(at + 1);
  const inline = args.some((w) => /^-[A-Za-z]*[ecpE]$/.test(w) || w === '--eval' || w === '--print' || w.startsWith('--eval='));
  if (!inline) return null;
  for (const w of args) {
    const m = MENTION.exec(w);
    if (m) return m[2].toLowerCase();
  }
  return null;
}

function bashVerdict(command, where, depth = 0) {
  const { commands, targets } = shellParts(command);
  for (const words of commands) {
    const step = personStep(words);
    if (step) return `Proven: proven ${step} is a person's step, not the agent's. Work on the app. ${DONE_HINT}`;
    const shell = programIndex(words, (w) => SHELLS.has(basename(w)));
    if (shell >= 0 && depth < 3) {
      const k = words.indexOf('-c', shell);
      if (k > 0 && words[k + 1]) {
        const inner = bashVerdict(words[k + 1], where, depth + 1);
        if (inner) return inner;
      }
    }
    const code = inlineCodeArea(words);
    if (code) return `Proven: this command runs code that names a path under ${code}/, which the agent does not change. ${WHY[code]} ${DONE_HINT}`;
    targets.push(...writeTargets(words));
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
