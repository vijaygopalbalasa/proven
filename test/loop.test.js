import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, personStep } from '../src/hooks/proven-guard.mjs';
import { cpSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { FAKE_KANE, couponTicket, makeRepo, PROVEN, ROOT } from './support/helpers.js';
import { findCommittedLeaks } from './support/scan.js';

const FAKE_AGENT = join(ROOT, 'test', 'support', 'fake-agent.js');
const KANE_WORDS = 'The cart accepts SAVE10, but applying it leaves the total at $20.00 instead of $18.00.';

const RED_PROMPT = (id) =>
  `Ticket ${id} is red. Read tickets/${id}.md and make it true in demo/app. When you believe it is done, run node bin/proven.js done ${id} and follow what it prints.`;
const REOPEN_PROMPT = (id) =>
  `proven recheck reopened ${id}. Read tickets/${id}.md and .proven/state/${id}.json for what Kane saw, fix demo/app, then run node bin/proven.js done ${id} and follow what it prints.`;

// A repo with T-1 frozen and red, and .proven/agent.json pointing at the fake agent.
async function redRepo(t, { agent = [process.execPath, FAKE_AGENT, '--output-format', 'stream-json'], maxAttempts, commitAgent = false } = {}) {
  const repo = await makeRepo(t, { maxAttempts });
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  if (agent) {
    repo.write('.proven/agent.json', JSON.stringify({ command: agent }, null, 2) + '\n');
    if (commitAgent) {
      repo.git('add', '.proven/agent.json');
      repo.git('commit', '-q', '-m', 'Say which agent to run');
    }
  }
  // Proven's own code, as a person would have committed it, for the tests that tamper with it.
  repo.write('src/commands/done.js', '// the judge\n');
  repo.git('add', 'src');
  repo.git('commit', '-q', '-m', 'Add the judge');
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 0, r.stderr);
  return repo;
}

function agentEnv(repo, extra = {}) {
  return { FAKE_AGENT_LOG: join(repo.dir, '.git', 'fake-agent.log'), FAKE_AGENT_PROVEN: PROVEN, ...extra };
}
function agentCalls(repo) {
  const log = join(repo.dir, '.git', 'fake-agent.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const lines = (r) => (r.stdout + '\n' + r.stderr).split('\n');

test('loop: a red ticket the agent fixes on its second attempt, one Kane fail fed back, then a pass', async (t) => {
  const repo = await redRepo(t);
  // done fails once, then passes; the recheck that follows passes.
  const r = await repo.run(['loop', '--agent-config'], { scenario: ['red', 'green', 'green'], env: agentEnv(repo) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^T-1: starting the agent \(1 of 1\)\.$/m);
  assert.match(r.stdout, /^T-1 attempt 1 of 4: Kane failed step 2 \(Apply SAVE10\)\. Kane says: The cart accepts SAVE10/m);
  assert.match(r.stdout, /^T-1 attempt 2 of 4: Kane passed in proven done \(not yet confirmed\)\.$/m);
  assert.match(r.stdout, /^T-1 is done: confirmed by a fresh Kane run from proven loop\.$/m);
  assert.doesNotMatch(r.stdout, /is done: receipt verifies/);
  assert.match(r.stdout, /^T-1 still passes/m);
  assert.match(r.stdout, /^Loop finished: every ticket is done and the last recheck passes\.$/m);
  // one agent session, with the red prompt, and the state it worked from
  const calls = agentCalls(repo);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argv.at(-1), RED_PROMPT('T-1'));
  assert.equal(repo.json('.proven/state/T-1.json').status, 'done');
  // the receipt verifies without the network
  const v = await repo.run(['verify', 'receipts/T-1.json']);
  assert.equal(v.code, 0, v.stdout);
  assert.match(v.stdout, /CONFIRMED/);
  assert.equal(repo.realKaneCalled(), false);
  assert.deepEqual(findCommittedLeaks(repo.dir, { calls: repo.kaneCalls() }), []);
});

test('loop: tool calls are shown by name and path or command only, never contents or results', async (t) => {
  const repo = await redRepo(t);
  const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'green'], env: agentEnv(repo) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^T-1 agent: Read tickets\/T-1\.md$/m);
  assert.match(r.stdout, /^T-1 agent: Edit demo\/app\/styles\.css$/m);
  const bash = r.stdout.split('\n').find((l) => l.startsWith('T-1 agent: Bash '));
  assert.ok(bash, r.stdout);
  assert.ok(bash.length <= 'T-1 agent: Bash '.length + 100, `truncated: ${bash.length}`);
  assert.doesNotMatch(r.stdout + r.stderr, /FILE-CONTENT-THAT-MUST-NOT-BE-PRINTED|RESULT-MUST-NOT-BE-PRINTED|this line is not json/);
});

test('loop: prompts are fixed, passed as arguments with no shell, and never carry Kane text', async (t) => {
  const repo = await redRepo(t, { agent: [process.execPath, FAKE_AGENT, '--note=$(touch pwned); echo `x`'] });
  const r = await repo.run(['loop', '--agent-config'], { scenario: ['red', 'red', 'green', 'green'], env: agentEnv(repo) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const calls = agentCalls(repo);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv.slice(0, -1), ['--note=$(touch pwned); echo `x`']);
  assert.equal(calls[0].argv.at(-1), RED_PROMPT('T-1'));
  assert.equal(existsSync(join(repo.dir, 'pwned')), false, 'no shell ran the argument');
  for (const c of calls) for (const a of c.argv) assert.ok(!a.includes('Kane') && !a.includes(KANE_WORDS) && !a.includes('$20.00'), a);
  assert.equal(calls[0].cwd, repo.dir);
});

test('loop: a recheck reopen is handed back with the reopened prompt and fixed', async (t) => {
  const repo = await redRepo(t);
  // T-1 goes green; recheck replay and confirm both fail (reopen); the agent fixes it; the next recheck passes.
  const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'red', 'red', 'green', 'green'], env: agentEnv(repo) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const calls = agentCalls(repo);
  assert.deepEqual(calls.map((c) => c.argv.at(-1)), [RED_PROMPT('T-1'), REOPEN_PROMPT('T-1')]);
  assert.match(r.stdout, /^T-1 reopened at /m);
  assert.match(r.stdout, /^Handing back to the agent: T-1 \(recheck round 1 of 2\)\.$/m);
  assert.equal(repo.json('.proven/state/T-1.json').status, 'done');
  assert.ok(repo.json('receipts/T-1.json').previous, 'the new receipt links the earlier one');
  assert.equal((await repo.run(['verify', 'receipts/T-1.json'])).code, 0);
});

test('loop: needs a person after the attempt limit stops that ticket and exits 1', async (t) => {
  const repo = await redRepo(t, { maxAttempts: 2 });
  const r = await repo.run(['loop', '--agent-config'], { scenario: 'red', env: agentEnv(repo) });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^T-1 attempt 2 of 2: Kane failed step 2/m);
  assert.match(r.stdout, /^T-1 needs a person after 2 failed attempts\. The loop stops work on it\.$/m);
  assert.equal(agentCalls(repo).length, 1, 'one session per ticket per round');
  assert.equal(repo.json('.proven/state/T-1.json').status, 'needs-a-person');
  assert.doesNotMatch(r.stdout, /Rechecking/, 'no recheck while a ticket is stuck');
});

test('loop: an agent that exits without a green is reported with its exit code', async (t) => {
  const repo = await redRepo(t);
  const r = await repo.run(['loop', '--agent-config'], { scenario: 'red', env: agentEnv(repo, { FAKE_AGENT_MODE: 'quit', FAKE_AGENT_EXIT: '3' }) });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^T-1: the agent stopped without a green \(exit code 3\)\.$/m);
  assert.equal(agentCalls(repo).length, 1);
  assert.equal(repo.json('.proven/state/T-1.json').status, 'red');
});

test('loop: at most 2 hand-back rounds, then a final recheck whose result is printed', async (t) => {
  const repo = await redRepo(t);
  // green; then (recheck red red, agent green) twice; then the final recheck still reopens it
  const scenario = ['green', 'red', 'red', 'green', 'red', 'red', 'green', 'red', 'red'];
  const r = await repo.run(['loop', '--agent-config'], { scenario, env: agentEnv(repo) });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const calls = agentCalls(repo);
  assert.deepEqual(calls.map((c) => c.argv.at(-1)), [RED_PROMPT('T-1'), REOPEN_PROMPT('T-1'), REOPEN_PROMPT('T-1')]);
  assert.match(r.stdout, /recheck round 2 of 2/);
  assert.doesNotMatch(r.stdout, /recheck round 3/);
  assert.match(r.stdout, /^Loop stopped: the last recheck reopened T-1, and the limit of 2 hand-back rounds is used up\.$/m);
  assert.equal(repo.json('.proven/state/T-1.json').status, 'reopened');
});

test('loop: a missing agent program means it did not run, exit 2, and nothing changes', async (t) => {
  const repo = await redRepo(t, { agent: ['proven-test-no-such-agent-program', '-p'], commitAgent: false });
  const before = repo.head();
  const r = await repo.run(['loop', '--agent-config'], { scenario: 'red' });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(lines(r).join('\n'), /^did not run: the agent program proven-test-no-such-agent-program was not found on PATH\./m);
  assert.equal(repo.head(), before);
  assert.equal(repo.json('.proven/state/T-1.json').status, 'red');
});

test('loop: a malformed .proven/agent.json is refused with exit 2', async (t) => {
  const repo = await redRepo(t, { agent: null });
  repo.write('.proven/agent.json', '{"command": "claude -p"}\n');
  const r = await repo.run(['loop', '--agent-config'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\.proven\/agent\.json: "command" must be a list of words/);
  repo.write('.proven/agent.json', '{"command": ["x"], "kane": "y"}\n');
  assert.match((await repo.run(['loop', '--agent-config'])).stderr, /unknown setting "kane"/);
});

test('loop: named tickets that are not ready are not handed over', async (t) => {
  const repo = await redRepo(t);
  repo.write('tickets/T-2.md', couponTicket(repo.url).replace('T-1', 'T-2'));
  const r = await repo.run(['loop', '--agent-config', 'T-2'], { scenario: 'red', env: agentEnv(repo) });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(lines(r).join('\n'), /^T-2: not handed to the agent: not frozen\./m);
  assert.equal(agentCalls(repo).length, 0);
});

test('loop: default and the agent.json file stay out of config and locks, and T-1/T-2 receipts still verify', async (t) => {
  const { defaultAgentCommand } = await import('../src/agent.js');
  assert.deepEqual(defaultAgentCommand(), [
    'claude', '-p', '--model', 'claude-sonnet-5-5', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(node bin/proven.js done *)', '--output-format', 'stream-json', '--verbose',
  ]);
  const repo = await redRepo(t);
  const lockBefore = repo.read('tickets/T-1.lock.json');
  const configBefore = repo.read('.proven/config.json');
  const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'green'], env: agentEnv(repo) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(repo.read('tickets/T-1.lock.json'), lockBefore);
  assert.equal(repo.read('.proven/config.json'), configBefore);
  assert.doesNotMatch(lockBefore + configBefore, /agent|claude/);
  // the real repository's committed receipts
  for (const id of ['T-1', 'T-2']) {
    const v = await import('./support/helpers.js').then((h) => h.runProven(ROOT, ['verify', `receipts/${id}.json`]));
    assert.equal(v.code, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /CONFIRMED/);
  }
});

test('guard: proven loop is a person\'s step, however it is run', async () => {
  assert.equal(personStep(['node', 'bin/proven.js', 'loop']), 'loop');
  assert.equal(personStep(['proven', 'loop', 'T-1']), 'loop');
  assert.equal(personStep(['env', 'X=1', 'npx', 'proven', '--quiet', 'loop']), 'loop');
  assert.equal(personStep(['echo', 'proven', 'loop']), null);
  assert.equal(personStep(['proven', 'done', 'T-1']), null);
  const dir = '/tmp/proven-guard-test';
  for (const command of ['node bin/proven.js loop', 'cd demo && proven loop T-1', 'bash -c "proven loop"', 'echo "$(node ./bin/proven.js loop)"']) {
    const why = decide({ tool_name: 'Bash', tool_input: { command }, cwd: dir }, { projectDir: dir });
    assert.match(why ?? '', /proven loop is a person's step, not the agent's\./, command);
  }
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'node bin/proven.js done T-1' }, cwd: dir }, { projectDir: dir }), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'grep -rn "proven loop" README.md' }, cwd: dir }, { projectDir: dir }), null);
});

for (const mode of ['tamper-src', 'commit-src']) {
  test(`loop: ${mode}: the agent changes Proven's own code, so nothing from the session is trusted and the loop stops`, async (t) => {
    const repo = await redRepo(t);
    const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'green', 'green'], env: agentEnv(repo, { FAKE_AGENT_MODE: mode }) });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const text = r.stdout + '\n' + r.stderr;
    assert.match(text, /^Proven's own files changed during the agent's session: .*src\/commands\/done\.js.*\. Nothing from this session is trusted\.$/m);
    assert.doesNotMatch(text, /is done|Rechecking|Loop finished|Handing back/);
    assert.equal(agentCalls(repo).length, 1);
  });
}

test('loop: a person\'s uncommitted change to Proven\'s code stops the loop before any agent starts', async (t) => {
  const repo = await redRepo(t);
  repo.write('src/commands/done.js', '// edited by hand\n');
  const r = await repo.run(['loop', '--agent-config'], { scenario: 'red', env: agentEnv(repo) });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /did not run: .*src\/commands\/done\.js.*uncommitted/);
  assert.equal(agentCalls(repo).length, 0);
});

test('guard: Proven\'s own files are protected like tickets and receipts, the app folder is not', async () => {
  const dir = '/tmp/proven-guard-test';
  const paths = ['bin/proven.js', 'src/commands/done.js', 'package.json', 'package-lock.json', 'node_modules/x/index.js', 'test/loop.test.js', 'docs/design.md', '.gitignore', 'README.md'];
  const call = (tool_name, tool_input) => decide({ tool_name, tool_input, cwd: dir }, { projectDir: dir });
  for (const p of paths) {
    for (const [tool, input] of [['Write', { file_path: join(dir, p), content: 'x' }], ['Edit', { file_path: p, old_string: 'a', new_string: 'b' }], ['MultiEdit', { file_path: join(dir, p), edits: [] }], ['NotebookEdit', { notebook_path: p, new_source: 'x' }]]) {
      assert.match(call(tool, input) ?? '', /which the agent does not change/, `${tool} ${p}`);
    }
    for (const command of [`echo x > ${p}`, `sed -i s/a/b/ ${p}`, `cp /tmp/x ${p}`, `rm ${p}`, `tee ${p}`, `node -e "require('fs').writeFileSync('${p}', 'x')"`]) {
      assert.match(call('Bash', { command }) ?? '', /Proven: /, command);
    }
    assert.equal(call('Bash', { command: `cat ${p}` }), null, `reading ${p} is fine`);
  }
  assert.match(call('Write', { file_path: join(dir, 'Src', 'x.js'), content: 'x' }) ?? '', /src\//i, 'case-insensitive');
  assert.equal(call('Write', { file_path: join(dir, 'demo', 'app', 'cart.js'), content: 'x' }), null);
  assert.match(call('Bash', { command: 'sed -i s/a/b/ demo/app/cart.js' }) ?? '', /Proven: /, 'the agent edits the app with its edit tools');
  assert.equal(call('Bash', { command: 'node bin/proven.js done T-1' }), null);
});

test('loop: an agent.json from the repository is not run without --agent-config, and the command is shown', async (t) => {
  const repo = await redRepo(t);
  const r = await repo.run(['loop'], { scenario: 'red', env: agentEnv(repo) });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  const text = r.stdout + '\n' + r.stderr;
  assert.ok(text.includes(JSON.stringify([process.execPath, FAKE_AGENT, '--output-format', 'stream-json'])), text);
  assert.match(text, /\.proven\/agent\.json names the agent command .*Nothing was run.*--agent-config/);
  assert.equal(agentCalls(repo).length, 0);
  assert.equal(repo.json('.proven/state/T-1.json').status, 'red');
  // with the flag it runs, and says which command it uses
  const ok = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'green'], env: agentEnv(repo) });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.ok(ok.stdout.includes('Using the agent command from .proven/agent.json'), ok.stdout);
  assert.equal(agentCalls(repo).length, 1);
});

test('loop: a command that skips Claude Code permissions is refused, flag or not', async (t) => {
  const { bypassFlag, defaultAgentCommand } = await import('../src/agent.js');
  assert.equal(bypassFlag(defaultAgentCommand()), null);
  const bad = [
    ['claude', '-p', '--dangerously-skip-permissions'],
    ['claude', '--allow-dangerously-skip-permissions', '-p'],
    ['claude', '--permission-mode', 'bypassPermissions'],
    ['claude', '--permission-mode=bypassPermissions'],
    ['claude', '--permission-mode=BypassPermissions'],
  ];
  for (const command of bad) {
    assert.ok(bypassFlag(command), command.join(' '));
    const repo = await redRepo(t, { agent: command });
    const r = await repo.run(['loop', '--agent-config'], { scenario: 'red', env: agentEnv(repo) });
    assert.equal(r.code, 2, command.join(' ') + r.stdout + r.stderr);
    assert.match(r.stderr, /refuses an agent command that skips permission checks/);
    assert.equal(agentCalls(repo).length, 0);
  }
});

test('guard: a value flag or a later word cannot hide a person\'s step, and package scripts are not run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proven-guard-scripts-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { redo: 'node bin/proven.js red T-3', fine: 'node bin/proven.js done T-1' } }));
  const call = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: dir }, { projectDir: dir });
  for (const command of [
    'node bin/proven.js --port 8090 red T-3',
    'proven --url http://x/ freeze T-1',
    'node bin/proven.js board --port 8090 loop',
    'proven done T-1 red',
    'node bin/proven.js --landmark Cart new T-4 "x"',
    'npx proven --foo bar loop',
    'env X=1 proven --landmark x red',
  ]) {
    assert.match(call(command) ?? '', /is a person's step, not the agent's\./, command);
  }
  for (const command of ['npm run redo', 'npm run-script redo', 'pnpm run redo', 'yarn redo', 'npm run fine', 'npm test', 'cd sub && npm run redo', 'npm --prefix sub run redo']) {
    assert.match(call(command) ?? '', /Proven: /, command);
  }
  for (const command of ['node bin/proven.js done T-1', 'echo red', 'grep -rn "proven red" README.md']) assert.equal(call(command), null, command);
});

test('loop: the recheck and verify run from code loaded before the session, even if the agent rewrites and restores it', async (t) => {
  const copy = mkdtempSync(join(tmpdir(), 'proven-copy-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(join(ROOT, 'bin'), join(copy, 'bin'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(copy, 'src'), { recursive: true });
  writeFileSync(join(copy, 'package.json'), readFileSync(join(ROOT, 'package.json')));
  const bin = join(copy, 'bin', 'proven.js');
  const recheckFile = join(copy, 'src', 'commands', 'recheck.js');
  const original = readFileSync(recheckFile, 'utf8');
  const repo = await redRepo(t);
  const r = await repo.run(['loop', '--agent-config'], {
    scenario: ['green', 'green'],
    proven: bin,
    env: agentEnv(repo, { FAKE_AGENT_MODE: 'rewrite-restore', FAKE_AGENT_TAMPER_FILE: recheckFile, FAKE_AGENT_PROVEN: bin }),
  });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(recheckFile, 'utf8'), original, 'the agent restored the file');
  assert.match(r.stdout, /^Every done ticket still passes\.$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /TAMPERED RECHECK/);
  assert.match(r.stdout, /^T-1 is done: confirmed by a fresh Kane run from proven loop\.$/m);
});

test('loop: a ticket is not reported done when the recheck cannot confirm it', async (t) => {
  const repo = await redRepo(t);
  const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'not-started'], env: agentEnv(repo) });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /Kane passed in proven done \(not yet confirmed\)/);
  assert.doesNotMatch(r.stdout, /is done: confirmed/);
  assert.match(r.stdout + r.stderr, /^T-1 is not confirmed: the fresh Kane run did not complete\.$/m);
});

for (const [mode, what, re] of [
  ['ignored-file', 'an ignored file in src/', /src\/\.DS_Store/],
  ['git-config', '.git/config', /\.git\/config/],
  ['git-exclude', '.git/info/exclude', /\.git\/info\/exclude/],
  ['skip-worktree', 'a skip-worktree flag', /src\/commands\/done\.js/],
]) {
  test(`loop: ${what} changed during the session, so nothing from it is trusted`, async (t) => {
    const repo = await redRepo(t);
    const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'green'], env: agentEnv(repo, { FAKE_AGENT_MODE: mode }) });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const text = r.stdout + '\n' + r.stderr;
    assert.match(text, /^Proven's own files changed during the agent's session: .*\. Nothing from this session is trusted\.$/m);
    assert.match(text, re);
    assert.doesNotMatch(text, /is done|Rechecking|Loop finished/);
  });
}

for (const [mode, what] of [
  ['forge-red', 'a state commit that rewrites the red record'],
  ['forge-done', 'a state commit that says done with no receipt'],
  ['other-ticket', 'a commit for a ticket that was not handed to the agent'],
]) {
  test(`loop: ${what} is refused`, async (t) => {
    const repo = await redRepo(t);
    const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'green'], env: agentEnv(repo, { FAKE_AGENT_MODE: mode }) });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const text = r.stdout + '\n' + r.stderr;
    assert.match(text, /Nothing from this session is trusted\./);
    assert.doesNotMatch(text, /is done|Rechecking|Loop finished/);
  });
}

test('guard: .git is protected, so the agent cannot change config, hooks or refs', async () => {
  const dir = '/tmp/proven-guard-test';
  const call = (tool_name, tool_input) => decide({ tool_name, tool_input, cwd: dir }, { projectDir: dir });
  for (const p of ['.git/config', '.git/hooks/pre-commit', '.git/info/exclude', '.git/refs/heads/main', '.git/HEAD']) {
    assert.match(call('Write', { file_path: join(dir, p), content: 'x' }) ?? '', /which the agent does not change/, p);
    assert.match(call('Edit', { file_path: p, old_string: 'a', new_string: 'b' }) ?? '', /\.git\//, p);
    for (const command of [`echo x >> ${p}`, `cp /tmp/x ${p}`, `sed -i s/a/b/ ${p}`, `rm ${p}`]) assert.match(call('Bash', { command }) ?? '', /Proven: /, command);
  }
  assert.equal(call('Bash', { command: 'git log --oneline' }), null);
  assert.equal(call('Bash', { command: 'git status' }), null);
  assert.equal(call('Write', { file_path: join(dir, '.gitignore-not-really', 'x'), content: 'x' }), null);
});

for (const [mode, what, re] of [
  ['replace-ref', 'a refs/replace ref', /refs\/replace\//],
  ['grafts', '.git/info/grafts', /\.git\/info\/grafts/],
  ['alternates', '.git/objects/info/alternates', /\.git\/objects\/info\/alternates/],
  ['attributes', '.git/info/attributes', /\.git\/info\/attributes/],
  ['gitattributes', 'a .gitattributes file', /\.gitattributes/],
]) {
  test(`loop: ${what} created during the session is tampering`, async (t) => {
    const repo = await redRepo(t);
    const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'green'], env: agentEnv(repo, { FAKE_AGENT_MODE: mode }) });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const text = r.stdout + '\n' + r.stderr;
    assert.match(text, /^Proven's own files changed during the agent's session: .*\. Nothing from this session is trusted\.$/m);
    assert.match(text, re);
    assert.doesNotMatch(text, /is done|Rechecking|Loop finished/);
  });
}

test('git: every git command Proven makes ignores replace objects and system and global config', async (t) => {
  const { git, gitEnv } = await import('../src/git.js');
  const env = gitEnv({});
  assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  const repo = await makeRepo(t);
  const original = repo.head();
  repo.write('demo/app/other.txt', 'x');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'A different commit');
  repo.git('update-ref', `refs/replace/${original}`, repo.head());
  assert.equal(repo.git('log', '-1', '--format=%s', original), 'A different commit', 'plain git is fooled by the replace ref');
  assert.equal(git(repo.dir, ['log', '-1', '--format=%s', original]).trim(), 'Start the shop', 'Proven is not');
});

test('loop: a Kane program that changed since the loop started is not run again', async (t) => {
  const wrapper = join(mkdtempSync(join(tmpdir(), 'proven-kane-')), 'kane-wrapper');
  t.after(() => rmSync(join(wrapper, '..'), { recursive: true, force: true }));
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_KANE}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const repo = await redRepo(t);
  const env = (extra) => agentEnv(repo, { PROVEN_KANE_BIN: wrapper, FAKE_AGENT_KANE_FILE: wrapper, ...extra });
  const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'green'], env: env({ FAKE_AGENT_MODE: 'kane-swap' }) });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /^did not run: the Kane program .*kane-wrapper changed since the loop started\. Nothing was rechecked\.$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /is done|Loop finished/);
  // unchanged, the same wrapper is fine
  const repo2 = await redRepo(t);
  const ok = await repo2.run(['loop', '--agent-config'], { scenario: ['green', 'green'], env: { ...agentEnv(repo2), PROVEN_KANE_BIN: wrapper, FAKE_AGENT_KANE_FILE: wrapper } });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
});
