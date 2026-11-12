#!/usr/bin/env node
// Proven's guard for Claude Code, written into a project by proven init. Claude Code runs it before every Write,
// Edit, MultiEdit, NotebookEdit and Bash call (a PreToolUse hook) and sends the call as JSON on stdin. Exit code 2
// blocks the call and shows the reason on stderr to the agent. Exit code 0 lets it through.
//
// It blocks the agent from changing files under tickets/ (which holds Kane's recordings, tickets/output-T-N/),
// receipts/, .proven/ and .claude/, and from running proven new, proven freeze, proven red or proven loop, which are a person's
// steps. For shell commands it fails closed where it can: a command that writes files is blocked when any of its
// arguments points into those folders, whichever argument the command would write to. It is defence in depth, not a
// sandbox: an agent with a shell can still get around it. That is why Proven shows a ticket as done only for a
// receipt that verifies.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Tickets, receipts, Proven's state and these guard rails, and Proven's own code and files: the agent runs
// proven done as the judge, so it must not be able to change the judge. Names are lowercase (compared without case).
export const PROTECTED = [
  'tickets', 'receipts', '.proven', '.claude', '.git',
  'bin', 'src', 'package.json', 'package-lock.json', 'node_modules', 'test', 'docs', '.gitignore', 'readme.md',
];
export const PERSON_STEPS = ['new', 'freeze', 'red', 'loop'];
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
const MENTION = new RegExp(`(^|[\\s'"\`(=,:/])(${PROTECTED.map((x) => x.replace(/[.]/g, '\\.')).join('|')})(\\/|\\\\|$|[\\s'"\`),;])`, 'i');

const WHY = {
  tickets: 'Tickets, their frozen tests and locks are a person\'s. Fix the app, not the test.',
  receipts: 'Receipts are written only by proven done, when Kane passes the frozen test.',
  '.proven': 'Proven writes its own state there.',
  '.claude': 'That folder holds these guard rails.',
  '.git': 'Git config, hooks and refs decide what Proven trusts.',
};
const OWN = 'That is part of Proven itself, which judges the ticket, so the agent does not change it.';
for (const name of PROTECTED) WHY[name] ??= OWN;
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

// The person's step a simple command runs (new, freeze, red or loop), or null. Fail closed: a proven command with any
// word that is a person's step is blocked, wherever the word stands, because a value flag (--port 8090 red) would make
// "the first word after proven" the wrong one to read.
export function personStep(words) {
  const at = programIndex(words, isProven);
  if (at < 0) return null;
  return words.slice(at + 1).find((w) => PERSON_STEPS.includes(w)) ?? null;
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

function denyVerdict(command, where, depth = 0) {
  const { commands, targets } = shellParts(command);
  for (const words of commands) {
    const step = personStep(words);
    if (step) return `Proven: proven ${step} is a person's step, not the agent's. Work on the app. ${DONE_HINT}`;
    const shell = programIndex(words, (w) => SHELLS.has(basename(w)));
    if (shell >= 0 && depth < 3) {
      const k = words.indexOf('-c', shell);
      if (k > 0 && words[k + 1]) {
        const inner = denyVerdict(words[k + 1], where, depth + 1);
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


// ---- The allowlist -------------------------------------------------------------------------------------------------
// A Bash command is allowed only when every segment of it (split on | && || ; and newlines) is proven done for one
// ticket, a program that only reads, or a read-only git subcommand. Everything else is blocked: substitution,
// redirection to a file, cd, assignments, and every program that is not listed. The denylist above runs first only to
// give a precise reason; this is what decides. It is defence in depth, not a sandbox.
const READ_ONLY = new Set(['cat', 'head', 'tail', 'ls', 'wc', 'grep', 'rg', 'find', 'sed', 'awk', 'sort', 'uniq', 'diff', 'jq', 'echo', 'pwd', 'file', 'stat', 'tree']);
const GIT_READ = new Set(['log', 'show', 'diff', 'status', 'rev-parse', 'ls-files', 'blame', 'grep', 'cat-file', 'branch']);
const ALLOWED_REDIRECTS = new Set(['2>&1', '2>/dev/null', '>/dev/null']);
const DOLLAR = /[A-Za-z_{(0-9@*#?!$-]/;
const ALLOW_HINT = 'The agent may only read files, edit the app with its edit tools, and run proven done.';

// Splits a command into segments of words, or says why it cannot be read safely.
function segmentsOf(s) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  let start = 0;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = (i) => {
    endWord();
    if (words.length) segments.push({ words, text: s.slice(start, i).trim() });
    words = [];
    start = i + 1;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return { problem: 'an unterminated quote' };
      word += s.slice(i + 1, j);
      inWord = true;
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length) word += s[++j];
        else if (s[j] === '`' || (s[j] === '$' && DOLLAR.test(s[j + 1] ?? ''))) return { problem: 'command substitution or expansion' };
        else word += s[j];
      }
      if (j >= s.length) return { problem: 'an unterminated quote' };
      inWord = true;
      i = j;
    } else if (c === '\\') {
      if (i + 1 < s.length && s[i + 1] !== '\n') {
        word += s[++i];
        inWord = true;
      } else i++;
    } else if (c === ' ' || c === '\t') endWord();
    else if (c === '\n' || c === ';') endSegment(i);
    else if (c === '|') {
      if (s[i + 1] === '|') i++;
      endSegment(i);
    } else if (c === '&') {
      if (s[i + 1] !== '&') return { problem: 'a background or combined redirect (&)' };
      i++;
      endSegment(i);
    } else if (c === '>') {
      let fd = '';
      if (inWord && /^\d+$/.test(word)) {
        fd = word;
        word = '';
        inWord = false;
      } else endWord();
      let j = i + 1;
      const append = s[j] === '>';
      if (append) j++;
      let target = '';
      if (s[j] === '&') {
        target = '&';
        for (j++; /\d/.test(s[j] ?? ''); j++) target += s[j];
      } else {
        while (s[j] === ' ' || s[j] === '\t') j++;
        for (; j < s.length && !/[\s;|&<>()]/.test(s[j]); j++) target += s[j];
      }
      const text = `${fd}>${append ? '>' : ''}${target}`;
      if (!ALLOWED_REDIRECTS.has(text)) return { problem: `the redirection ${text}` };
      i = j - 1;
    } else if (c === '<') return { problem: 'input redirection, a heredoc or process substitution' };
    else if (c === '(' || c === ')' || c === '`') return { problem: 'a subshell, process or command substitution' };
    else if (c === '$' && DOLLAR.test(s[i + 1] ?? '')) return { problem: 'command substitution or expansion' };
    else {
      word += c;
      inWord = true;
    }
  }
  endSegment(s.length);
  return { segments };
}

const shortOpt = (w, letters) => /^-[^-]/.test(w) && [...w.slice(1)].some((x) => letters.includes(x));

// Why a segment is not allowed, or null.
function segmentProblem(words) {
  const [name, ...args] = words;
  if (ASSIGNMENT.test(name)) return 'it sets an environment variable';
  if (name === 'node' || name === 'proven') {
    const form = name === 'node' ? ['bin/proven.js', './bin/proven.js'].includes(args[0]) && args[1] === 'done' && args.length === 3 : args[0] === 'done' && args.length === 2;
    return form && /^T-\d+$/.test(args.at(-1)) ? null : 'only proven done T-N is allowed';
  }
  if (name === 'git') {
    const sub = args[0];
    if (!GIT_READ.has(sub)) return 'only read-only git subcommands are allowed (log, show, diff, status, rev-parse, ls-files, blame, grep, cat-file, branch --list)';
    const rest = args.slice(1);
    if (sub === 'branch' && !rest.every((w) => ['--list', '-l', '-a', '-r', '-v', '--all', '--remotes'].includes(w))) return 'git branch is allowed only with no arguments or --list';
    if (rest.some((w) => w.startsWith('--output') || w === '--ext-diff' || w === '-O' || w.startsWith('-O') || w.startsWith('--open-files-in-pager'))) return 'that git option writes a file or runs a program';
    return null;
  }
  if (!READ_ONLY.has(name)) return `${name} is not a read-only program on the list`;
  if (name === 'find' && args.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w))) return 'find may not run programs, delete or write files';
  if (name === 'sort' && args.some((w) => shortOpt(w, 'oT') || /^--(output|compress-program|temporary-directory)/.test(w))) return 'sort may not write a file or run a program';
  if (name === 'tree' && args.some((w) => shortOpt(w, 'o') || w.startsWith('--output') || w.startsWith('--fromfile'))) return 'tree may not write a file';
  if (name === 'file' && args.some((w) => shortOpt(w, 'C'))) return 'file may not write a file';
  if (name === 'rg' && args.some((w) => w.startsWith('--pre') || w.startsWith('--hostname-bin'))) return 'rg may not run a program';
  if (name === 'uniq' && args.filter((w) => !w.startsWith('-')).length > 1) return 'uniq with a second file writes it';
  if (name === 'sed') {
    let quiet = false;
    const scripts = [];
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const w = args[i];
      if (w === '--quiet' || w === '--silent') quiet = true;
      else if (/^-[nEr]+$/.test(w)) quiet ||= w.includes('n');
      else if (w === '-e') scripts.push(args[++i] ?? '');
      else if (w.startsWith('--expression=')) scripts.push(w.slice(13));
      else if (w.startsWith('-')) return 'sed is allowed only with -n and print commands';
      else files.push(w);
    }
    if (!scripts.length && files.length) scripts.push(files.shift());
    const PRINT = /^(\d+|\$|\/[^/]*\/)?(,(\d+|\$|\/[^/]*\/))?p$/;
    if (!quiet || !scripts.length || !scripts.every((x) => PRINT.test(x.trim()))) return 'sed is allowed only with -n and print commands';
  }
  if (name === 'awk') {
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const w = args[i];
      if (w === '-F' || w === '-v') i++;
      else if (/^-[Fv]./.test(w)) continue;
      else if (w.startsWith('-')) return 'awk is allowed only with -F, -v and a program';
      else rest.push(w);
    }
    if (!rest.length || /[>|@]|\bsystem\b|\bgetline\b|\bprintf?\s*\(.*\)\s*>/.test(rest[0])) return 'awk may not write files, pipe or run programs';
  }
  return null;
}

// The reason to block a Bash command, or null when every segment is on the list.
export function allowVerdict(command) {
  const text = String(command ?? '');
  const { segments, problem } = segmentsOf(text);
  if (problem) return `Proven: this command is blocked because it has ${problem}: ${text.trim().slice(0, 200)}. ${ALLOW_HINT} ${DONE_HINT}`;
  for (const { words, text: seg } of segments) {
    const why = segmentProblem(words);
    if (why) return `Proven: this command is blocked at the segment "${seg.slice(0, 200)}": ${why}. ${ALLOW_HINT} ${DONE_HINT}`;
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
  if (tool === 'Bash') return denyVerdict(args.command, where) ?? allowVerdict(args.command);
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
