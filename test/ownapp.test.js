import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { defaultAgentCommand, loadAgentCommand } from '../src/agent.js';
import { invocation } from '../src/invocation.js';
import { redPrompt, reopenedPrompt } from '../src/commands/loop.js';
import { couponTicket, makeRepo, PROVEN, ROOT } from './support/helpers.js';

const FAKE_AGENT = join(ROOT, 'test', 'support', 'fake-agent.js');

// A repository laid out like someone else's: the static app is in site/, not demo/app, and Proven is not in the repo.
async function foreignRepo(t, { app = 'site' } = {}) {
  const repo = await makeRepo(t);
  repo.git('mv', 'demo/app', app);
  repo.write('.proven/config.json', JSON.stringify({ app, timeout_s: 60, max_attempts: 4 }) + '\n');
  repo.write('.proven/agent.json', JSON.stringify({ command: [process.execPath, FAKE_AGENT, '--output-format', 'stream-json'] }) + '\n');
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  repo.git('add', '-A', ':!.proven/agent.json');
  repo.git('commit', '-q', '-m', 'Move the app to its own folder');
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 0, r.stderr);
  return repo;
}
const agentEnv = (repo, extra = {}) => ({ FAKE_AGENT_LOG: join(repo.aux, 'fake-agent.log'), FAKE_AGENT_PROVEN: PROVEN, ...extra });
const agentCalls = (repo) => {
  const log = join(repo.aux, 'fake-agent.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('invocation: node bin/proven.js inside Proven\'s own repository, proven anywhere else', async (t) => {
  assert.equal(invocation(ROOT), 'node bin/proven.js');
  const repo = await makeRepo(t);
  assert.equal(invocation(repo.dir), 'proven');
});

test('the loop prompts and the default agent command keep their exact demo strings', () => {
  assert.equal(
    redPrompt('T-3'),
    'Ticket T-3 is red. Read tickets/T-3.md and make it true in demo/app. When you believe it is done, run node bin/proven.js done T-3 and follow what it prints.',
  );
  assert.equal(
    reopenedPrompt('T-1'),
    'proven recheck reopened T-1. Read tickets/T-1.md and .proven/state/T-1.json for what Kane saw, fix demo/app, then run node bin/proven.js done T-1 and follow what it prints.',
  );
  assert.deepEqual(defaultAgentCommand(), [
    'claude', '-p', '--model', 'claude-sonnet-5-5', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(node bin/proven.js done *)', '--output-format', 'stream-json', '--verbose',
  ]);
  assert.deepEqual(loadAgentCommand(ROOT).command, defaultAgentCommand());
});

test('in another repository the prompts and the default agent command name that app folder and plain proven', async (t) => {
  assert.equal(
    redPrompt('T-1', { app: 'site', proven: 'proven' }),
    'Ticket T-1 is red. Read tickets/T-1.md and make it true in site. When you believe it is done, run proven done T-1 and follow what it prints.',
  );
  assert.equal(
    reopenedPrompt('T-1', { app: 'site', proven: 'proven' }),
    'proven recheck reopened T-1. Read tickets/T-1.md and .proven/state/T-1.json for what Kane saw, fix site, then run proven done T-1 and follow what it prints.',
  );
  const repo = await makeRepo(t);
  const { command } = loadAgentCommand(repo.dir);
  assert.equal(command[command.indexOf('--allowedTools') + 1], 'Bash(proven done *)');
  assert.deepEqual(defaultAgentCommand('proven').slice(0, 7), defaultAgentCommand().slice(0, 7));
});

test('loop works on a repository laid out like someone else\'s', async (t) => {
  const repo = await foreignRepo(t);
  const r = await repo.run(['loop', '--agent-config'], { scenario: ['red', 'green', 'green'], env: agentEnv(repo, { FAKE_AGENT_APP: 'site' }) });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const [call] = agentCalls(repo);
  assert.equal(
    call.argv.at(-1),
    'Ticket T-1 is red. Read tickets/T-1.md and make it true in site. When you believe it is done, run proven done T-1 and follow what it prints.',
  );
  assert.match(r.stdout, /^T-1 is done: confirmed by a fresh Kane run from proven loop\.$/m);
  assert.equal(repo.json('.proven/state/T-1.json').status, 'done');
  assert.equal((await repo.run(['verify', 'receipts/T-1.json'])).code, 0);
});

test('config refuses an app folder the guard keeps the agent out of', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'proven-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (app) => {
    const fs = require_fs();
    fs.mkdirSync(join(dir, '.proven'), { recursive: true });
    fs.writeFileSync(join(dir, '.proven', 'config.json'), JSON.stringify({ app }));
  };
  for (const app of ['site', 'public', 'demo/app', 'web/dist', 'app']) {
    write(app);
    assert.equal(loadConfig(dir).app, app);
  }
  for (const app of ['src', 'src/web', 'docs', 'docs/site', 'bin', 'test', 'Test/app', 'node_modules/x', 'package.json', 'README.md', '.gitignore', '.claude/x']) {
    write(app);
    assert.throws(() => loadConfig(dir), /the guard keeps the agent out of .* so an app there could never be edited/, app);
  }
});

test('freeze refuses such a config, and says what to do', async (t) => {
  const repo = await makeRepo(t);
  repo.write('.proven/config.json', JSON.stringify({ app: 'docs/site' }) + '\n');
  const r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /Move the app to another folder, for example site\//);
});

test('init says so when there is no .proven/config.json, and stays quiet when there is', async (t) => {
  const repo = await makeRepo(t);
  let r = await repo.run(['init']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  repo.git('rm', '-q', '-f', '.proven/config.json');
  r = await repo.run(['init']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /no \.proven\/config\.json.*demo\/app.*"app": "<folder>".*run proven init again/s);
});

test('loop hashes node_modules in another layout too: a change there during a session is tampering', async (t) => {
  const repo = await foreignRepo(t);
  const r = await repo.run(['loop', '--agent-config'], { scenario: ['green', 'green'], env: agentEnv(repo, { FAKE_AGENT_APP: 'site', FAKE_AGENT_MODE: 'node-modules' }) });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /Proven's own files changed during the agent's session: .*node_modules\/x\/index\.js/);
});

test('init makes sure git ignores what Kane writes, which carries the runner\'s name and email', async (t) => {
  const repo = await makeRepo(t);
  repo.git('rm', '-q', '-f', '.gitignore');
  repo.write('.gitignore', 'node_modules/\n.DS_Store');
  let r = await repo.run(['init']);
  assert.equal(r.code, 0, r.stderr);
  const lines = repo.read('.gitignore').split('\n');
  for (const want of ['node_modules/', '.DS_Store', '.testmuai/', 'tickets/output-*/', '.proven/runs/', '*.evidence']) assert.ok(lines.includes(want), want);
  assert.match(r.stdout, /\.gitignore/);
  const once = repo.read('.gitignore');
  r = await repo.run(['init']);
  assert.equal(repo.read('.gitignore'), once, 'a second init changes nothing');
  assert.doesNotMatch(r.stdout, /Added to \.gitignore/);
  // no .gitignore at all
  rmSync(join(repo.dir, '.gitignore'));
  r = await repo.run(['init']);
  assert.ok(repo.read('.gitignore').includes('.testmuai/'));
});
