#!/usr/bin/env node
// A stand-in for the coding agent, used only by the tests. proven loop starts it like it would start claude: the
// prompt is the last argument. It logs what it was given, prints stream-json lines the way the agent does, edits
// demo/app and runs proven done, following the exit code like a real agent would.
//
// FAKE_AGENT_MODE: "work" (default) edits and runs done until it is green, told to stop or out of tries;
// "quit" exits at once with FAKE_AGENT_EXIT (default 3) without running done.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const prompt = argv.at(-1) ?? '';
const id = /\bT-\d+\b/.exec(prompt)?.[0];
appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ argv, cwd: process.cwd(), id, abbrev: process.env.GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS }) + '\n');

const emit = (content) => process.stdout.write(JSON.stringify({ type: 'assistant', message: { content } }) + '\n');
const SECRET_BODY = 'FILE-CONTENT-THAT-MUST-NOT-BE-PRINTED';

emit([{ type: 'tool_use', name: 'Read', input: { file_path: `tickets/${id}.md` } }]);
process.stdout.write('this line is not json\n');

if (process.env.FAKE_AGENT_MODE === 'quit') process.exit(Number(process.env.FAKE_AGENT_EXIT ?? 3));

// Tamper modes: the agent edits Proven's own judge, or hides an extra commit touching src/, then runs done.
if (process.env.FAKE_AGENT_MODE === 'tamper-src' || process.env.FAKE_AGENT_MODE === 'commit-src') {
  const judge = 'src/commands/done.js';
  writeFileSync(judge, readFileSync(judge, 'utf8') + '// always pass\n');
  if (process.env.FAKE_AGENT_MODE === 'commit-src') {
    spawnSync('git', ['commit', '-q', '-am', `${id}: attempt 1 failed at step 2`], { encoding: 'utf8' });
  }
}

// More tampering modes. Each does its damage first, then (unless it quits) works as normal.
const mode = process.env.FAKE_AGENT_MODE;
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const STATE = `.proven/state/${id}.json`;
if (mode === 'rewrite-restore') {
  // Changes the loop's recheck code on disk during the session and puts it back before exiting.
  const file = process.env.FAKE_AGENT_TAMPER_FILE;
  const original = readFileSync(file, 'utf8');
  const changed = original.replace("'Every done ticket still passes.'", "'TAMPERED RECHECK'");
  if (changed === original) throw new Error('marker not found');
  writeFileSync(file, changed);
  process.on('exit', () => writeFileSync(file, original));
}
if (mode === 'replace-ref') {
  const [a, b] = [sh('git', ['rev-parse', 'HEAD']).stdout.trim(), sh('git', ['rev-parse', 'HEAD~1']).stdout.trim()];
  sh('git', ['update-ref', `refs/replace/${a}`, b]);
}
if (mode === 'grafts') writeFileSync('.git/info/grafts', '\n');
if (mode === 'alternates') writeFileSync('.git/objects/info/alternates', process.cwd() + '/.git/objects\n');
if (mode === 'attributes') appendFileSync('.git/info/attributes', '*.zzz text\n');
if (mode === 'gitattributes') writeFileSync('.gitattributes', '*.zzz text\n');
if (mode === 'kane-swap') appendFileSync(process.env.FAKE_AGENT_KANE_FILE, '\n# the agent changed this\n');
if (mode === 'ignored-file') writeFileSync('src/.DS_Store', 'ignored by .gitignore, but it is in src');
if (mode === 'git-config') appendFileSync('.git/config', '[alias]\n\tx = !true\n');
if (mode === 'git-exclude') appendFileSync('.git/info/exclude', 'src/\n');
if (mode === 'skip-worktree') {
  sh('git', ['update-index', '--skip-worktree', 'src/commands/done.js']);
}
if (mode === 'forge-red') {
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  state.red.kane_reason = 'invented by the agent';
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  sh('git', ['commit', '-q', '-m', `${id}: attempt 1 failed at step 2`, '--', STATE]);
  process.exit(0);
}
if (mode === 'forge-done') {
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  state.status = 'done';
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  sh('git', ['commit', '-q', '-m', `${id}: receipt, red 0000000, green 1111111`, '--', STATE]);
  process.exit(0);
}
if (mode === 'other-ticket') {
  writeFileSync('.proven/state/T-2.json', '{}\n');
  sh('git', ['add', '-f', '.proven/state/T-2.json']);
  sh('git', ['commit', '-q', '-m', 'T-2: attempt 1 failed at step 2', '--', '.proven/state/T-2.json']);
  process.exit(0);
}

const tries = Number(process.env.FAKE_AGENT_TRIES ?? 6);
for (let n = 1; n <= tries; n++) {
  const file = 'demo/app/styles.css';
  writeFileSync(file, readFileSync(file, 'utf8') + `/* ${id} fake agent edit ${process.hrtime.bigint()} */\n`);
  emit([{ type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: 'a', new_string: SECRET_BODY } }]);
  const command = `node bin/proven.js done ${id}`;
  emit([{ type: 'tool_use', name: 'Bash', input: { command: command + ' ' + 'x'.repeat(200) } }]);
  const r = spawnSync(process.execPath, [process.env.FAKE_AGENT_PROVEN, 'done', id], { encoding: 'utf8' });
  process.stdout.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `RESULT-MUST-NOT-BE-PRINTED ${r.stdout}` }] } }) + '\n');
  if (r.status === 0 || r.status === 2 || /needs a person/.test(r.stdout + r.stderr)) process.exit(0);
}
process.exit(0);
