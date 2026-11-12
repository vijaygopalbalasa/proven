import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refusal } from '../errors.js';

export const GUARD_SOURCE = fileURLToPath(new URL('../hooks/proven-guard.mjs', import.meta.url));
export const GUARD_PATH = '.claude/hooks/proven-guard.mjs';
export const SETTINGS_PATH = '.claude/settings.json';
export const GUARD_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/proven-guard.mjs"';
export const GUARD_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
export const SECTION_START = '<!-- proven:start -->';
export const SECTION_END = '<!-- proven:end -->';

// Kane takes a minute or more, and Claude Code stops a Bash call after 2 minutes unless told otherwise. These give
// proven done room to finish in the foreground (measured: a 90 s command returned its output with these set).
export const BASH_TIMEOUTS = { BASH_DEFAULT_TIMEOUT_MS: 600000, BASH_MAX_TIMEOUT_MS: 900000 };

// How the agent calls Proven in this project: inside Proven's own repository it is node bin/proven.js.
function invocation(root) {
  try {
    const own = realpathSync(join(root, 'bin', 'proven.js'));
    if (own === realpathSync(fileURLToPath(new URL('../../bin/proven.js', import.meta.url)))) return 'node bin/proven.js';
  } catch {}
  return 'proven';
}

export function claudeSection({ proven, app, maxAttempts }) {
  return `${SECTION_START}
## Proven: how tickets close here

A ticket closes only on Kane CLI evidence. A person writes each ticket in \`tickets/T-N.md\`, freezes its test and
records red: Kane failing the test on the code as it was. Your job is the app in \`${app}/\`.

- Read the ticket, then change the app until what it asks is true.
- When you believe the ticket is done, run \`${proven} done T-N\` in the foreground and wait. Kane takes a minute or two.
- Exit 0 means done: Proven committed your change and a receipt. Exit 1 means Kane failed the frozen test: read the
  step, Kane's words and the screenshot path it prints, fix the app, and run it again. Exit 2 means Kane did not run:
  read why. No attempt was counted.
- Fix the app, never the test. After ${maxAttempts} failed attempts the ticket needs a person, so stop there.
- Do not edit anything under \`tickets/\`, \`receipts/\`, \`.proven/\` or \`.claude/\`, and do not run
  \`proven new\`, \`proven freeze\` or \`proven red\`. Those are a person's steps, and a hook blocks them.
- \`${proven} recheck\` replays every done ticket. A ticket it reopens needs a new \`${proven} done T-N\`.
  Its state in \`.proven/state/T-N.json\` says which step failed and what Kane saw.
${SECTION_END}
`;
}

function readJsonObject(file, rel) {
  if (!existsSync(file)) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Refusal(`${rel} is not valid JSON, so proven init left it alone. Fix it, then run proven init again.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refusal(`${rel} must hold a JSON object. Fix it, then run proven init again.`);
  return value;
}

const isOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('proven-guard'));

// Add Proven's PreToolUse hook and the Bash time limits to the settings, keeping everything else as it is.
export function mergeSettings(settings) {
  const next = { ...settings };
  const hooks = next.hooks ?? {};
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw new Refusal(`${SETTINGS_PATH}: "hooks" must be an object. Fix it, then run proven init again.`);
  const pre = hooks.PreToolUse ?? [];
  if (!Array.isArray(pre)) throw new Refusal(`${SETTINGS_PATH}: "hooks.PreToolUse" must be a list. Fix it, then run proven init again.`);
  next.hooks = {
    ...hooks,
    PreToolUse: [...pre.filter((e) => !isOurs(e)), { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: GUARD_COMMAND, timeout: 30 }] }],
  };
  const env = next.env ?? {};
  if (typeof env !== 'object' || Array.isArray(env)) throw new Refusal(`${SETTINGS_PATH}: "env" must be an object. Fix it, then run proven init again.`);
  const notes = [];
  next.env = { ...env };
  for (const [key, want] of Object.entries(BASH_TIMEOUTS)) {
    if (env[key] === undefined) next.env[key] = String(want);
    else if (!(Number(env[key]) >= want)) notes.push(`${key} is ${env[key]} in ${SETTINGS_PATH}. Proven left it, but Kane runs may need ${want}.`);
  }
  return { settings: next, notes };
}

// Put the Proven section into CLAUDE.md: replace it if it is there, or add it at the end, keeping the rest.
export function mergeClaudeMd(text, section) {
  if (!text) return section;
  const start = text.indexOf(SECTION_START);
  const end = text.indexOf(SECTION_END);
  if (start >= 0 && end > start) {
    const after = text.slice(end + SECTION_END.length).replace(/^\n/, '');
    return text.slice(0, start) + section + after;
  }
  return text.replace(/\n*$/, '\n\n') + section;
}

// proven init: write the Claude Code guard rails for the agent. Everything is read and checked before anything is
// written, so a file Proven cannot read is left as it is. Proven does not commit these files: a person reviews them.
export async function cmdInit({ root, config, out }) {
  const settingsFile = join(root, SETTINGS_PATH);
  const claudeFile = join(root, 'CLAUDE.md');
  const { settings, notes } = mergeSettings(readJsonObject(settingsFile, SETTINGS_PATH));
  const claudeText = existsSync(claudeFile) ? readFileSync(claudeFile, 'utf8') : '';
  const proven = invocation(root);
  const claude = mergeClaudeMd(claudeText, claudeSection({ proven, app: config.app, maxAttempts: config.maxAttempts }));

  const guardFile = join(root, GUARD_PATH);
  mkdirSync(dirname(guardFile), { recursive: true });
  writeFileSync(guardFile, readFileSync(GUARD_SOURCE));
  chmodSync(guardFile, 0o755);
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  writeFileSync(claudeFile, claude);

  out.say(`Wrote ${GUARD_PATH}: it stops the agent from changing tickets/, receipts/, .proven/ and .claude/, and from running proven new, freeze and red.`);
  out.say(`Updated ${SETTINGS_PATH}: a PreToolUse hook runs the guard, and Bash calls may take up to 10 minutes, for Kane.`);
  out.say(`Updated CLAUDE.md: the agent runs ${proven} done T-N when it believes a ticket is done, and fixes the app, never the test.`);
  for (const note of notes) out.warn(`Note: ${note}`);
  out.say('These are guard rails, not a sandbox. Review the three files and commit them yourself.');
  return 0;
}
