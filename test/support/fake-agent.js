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
appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ argv, cwd: process.cwd(), id }) + '\n');

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
