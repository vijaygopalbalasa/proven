import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GUARD_COMMAND, GUARD_SOURCE, SECTION_END, SECTION_START } from '../src/commands/init.js';
import { decide, personStep, shellParts } from '../src/hooks/proven-guard.mjs';
import { makeRepo, PROVEN, ROOT } from './support/helpers.js';

const SESSION = '00000000-0000-4000-8000-0000000000c1';

// What Claude Code sends a PreToolUse hook on stdin.
function hookInput(dir, tool_name, tool_input) {
  return {
    session_id: SESSION,
    transcript_path: join(dir, '.git', 'transcript.jsonl'),
    cwd: dir,
    permission_mode: 'acceptEdits',
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
  };
}

function runGuard(dir, input) {
  const r = spawnSync(process.execPath, [join(dir, '.claude', 'hooks', 'proven-guard.mjs')], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    encoding: 'utf8',
  });
  return { code: r.status, stderr: r.stderr };
}

function settingsOf(repo) {
  return repo.json('.claude/settings.json');
}

function provenHooks(settings) {
  return settings.hooks.PreToolUse.filter((e) => e.hooks.some((h) => h.command.includes('proven-guard')));
}

test('proven init writes the guard, a PreToolUse hook, Bash time limits and a CLAUDE.md section', async (t) => {
  const repo = await makeRepo(t);
  const head = repo.head();
  const r = await repo.run(['init']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Wrote \.claude\/hooks\/proven-guard\.mjs/);
  assert.match(r.stdout, /These are guard rails, not a sandbox\. Review the three files and commit them yourself\./);
  assert.equal(repo.head(), head, 'init commits nothing');

  assert.deepEqual(readFileSync(join(repo.dir, '.claude/hooks/proven-guard.mjs')), readFileSync(GUARD_SOURCE));
  assert.ok(statSync(join(repo.dir, '.claude/hooks/proven-guard.mjs')).mode & 0o100);
  const settings = settingsOf(repo);
  assert.deepEqual(settings.hooks.PreToolUse, [
    { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: GUARD_COMMAND, timeout: 30 }] },
  ]);
  assert.equal(GUARD_COMMAND, 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/proven-guard.mjs"');
  assert.deepEqual(settings.env, { BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '900000' });

  const claude = repo.read('CLAUDE.md');
  assert.ok(claude.startsWith(SECTION_START) && claude.trimEnd().endsWith(SECTION_END));
  assert.match(claude, /run `proven done T-N` in the foreground and wait/);
  assert.match(claude, /Fix the app, never the test\. After 4 failed attempts the ticket needs a person/);
  assert.match(claude, /Your job is the app in `demo\/app\/`/);
});

test('proven init merges with settings and a CLAUDE.md that are already there, and can run again', async (t) => {
  const repo = await makeRepo(t);
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked' }] };
  repo.write(
    '.claude/settings.json',
    JSON.stringify({ permissions: { allow: ['Bash(npm test *)'] }, hooks: { PreToolUse: [other], Stop: [{ hooks: [] }] }, env: { FOO: '1', BASH_MAX_TIMEOUT_MS: '60000' } }),
  );
  repo.write('CLAUDE.md', '# My project\n\nUse tabs.\n');

  let r = await repo.run(['init']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Note: BASH_MAX_TIMEOUT_MS is 60000 in \.claude\/settings\.json\. Proven left it, but Kane runs may need 900000\./);
  r = await repo.run(['init']);
  assert.equal(r.code, 0, r.stderr);

  const settings = settingsOf(repo);
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test *)'] });
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [] }]);
  assert.deepEqual(settings.hooks.PreToolUse[0], other);
  assert.equal(provenHooks(settings).length, 1);
  assert.deepEqual(settings.env, { FOO: '1', BASH_MAX_TIMEOUT_MS: '60000', BASH_DEFAULT_TIMEOUT_MS: '600000' });

  const claude = repo.read('CLAUDE.md');
  assert.ok(claude.startsWith('# My project\n\nUse tabs.\n\n<!-- proven:start -->'));
  assert.equal(claude.split(SECTION_START).length, 2);
  repo.write('CLAUDE.md', claude.replace('Your job is the app', 'An old line') + '\nMore of my notes.\n');
  assert.equal((await repo.run(['init'])).code, 0);
  const again = repo.read('CLAUDE.md');
  assert.doesNotMatch(again, /An old line/);
  assert.match(again, /Your job is the app/);
  assert.match(again, /More of my notes\.\n$/);
});

test('proven init leaves a settings file it cannot read alone, and writes nothing', async (t) => {
  const repo = await makeRepo(t);
  repo.write('.claude/settings.json', '{ "hooks": ');
  const r = await repo.run(['init']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\.claude\/settings\.json is not valid JSON, so proven init left it alone\./);
  assert.equal(repo.read('.claude/settings.json'), '{ "hooks": ');
  assert.equal(repo.exists('CLAUDE.md'), false);
  assert.equal(repo.exists('.claude/hooks/proven-guard.mjs'), false);
});

test('inside Proven\'s own repository the agent is told to run node bin/proven.js', async (t) => {
  const repo = await makeRepo(t);
  mkdirSync(join(repo.dir, 'bin'));
  symlinkSync(PROVEN, join(repo.dir, 'bin', 'proven.js'));
  assert.equal((await repo.run(['init'])).code, 0);
  assert.match(repo.read('CLAUDE.md'), /run `node bin\/proven\.js done T-N` in the foreground/);
});

test('the hook blocks writes to tickets, receipts, .proven and .claude, and a person\'s proven steps', async (t) => {
  const repo = await makeRepo(t);
  assert.equal((await repo.run(['init'])).code, 0);
  const dir = repo.dir;
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  symlinkSync(join(dir, 'tickets'), join(dir, 'demo', 'app', 'shortcut'));

  const blocked = [
    ['Write', { file_path: join(dir, 'tickets', 'T-1_test.md'), content: 'loosened' }, /tickets\/T-1_test\.md is under tickets\/.*Fix the app, not the test\./],
    ['Edit', { file_path: join(dir, 'receipts', 'T-1.json'), old_string: 'a', new_string: 'b', replace_all: false }, /under receipts\/.*written only by proven done/],
    ['MultiEdit', { file_path: join(dir, '.proven', 'state', 'T-1.json'), edits: [{ old_string: 'a', new_string: 'b' }] }, /under \.proven\//],
    ['NotebookEdit', { notebook_path: join(dir, 'tickets', 'notes.ipynb'), new_source: 'x' }, /under tickets\//],
    ['Write', { file_path: 'tickets/../tickets/T-3.md', content: 'x' }, /under tickets\//],
    ['Write', { file_path: join(dir, 'Tickets', 'T-1.md'), content: 'x' }, /under tickets\//],
    ['Write', { file_path: join(dir, 'demo', 'app', 'shortcut', 'T-1.md'), content: 'x' }, /under tickets\//],
    ['Edit', { file_path: join(dir, '.claude', 'settings.json'), old_string: 'a', new_string: 'b' }, /under \.claude\/.*guard rails/],
    ['Bash', { command: 'proven freeze T-3', description: 'Freeze' }, /proven freeze is a person's step, not the agent's\./],
    ['Bash', { command: 'node bin/proven.js red T-1', timeout: 600000 }, /proven red is a person's step/],
    ['Bash', { command: 'npx proven new T-4 "Another"' }, /proven new is a person's step/],
    ['Bash', { command: 'cd demo && CI=1 proven red T-1' }, /proven red is a person's step/],
    ['Bash', { command: 'bash -c "proven freeze T-3"' }, /proven freeze is a person's step/],
    ['Bash', { command: 'echo "$(node ./bin/proven.js red T-1)"' }, /proven red is a person's step/],
    ['Bash', { command: 'echo looser > tickets/T-1_test.md' }, /writes to tickets\/T-1_test\.md, under tickets\//],
    ['Bash', { command: "printf '{}' >> receipts/T-1.json" }, /under receipts\//],
    ['Bash', { command: 'cat x.json | tee -a .proven/state/T-1.json' }, /under \.proven\//],
    ['Bash', { command: "cat > tickets/T-1_test.md <<'EOF'\n## Open\nEOF" }, /under tickets\//],
    // Kane's recording lives in tickets/output-T-N/: no way to plant one there.
    ['Write', { file_path: join(dir, 'tickets', 'output-T-1', 'Result.md'), content: 'every step passed' }, /tickets\/output-T-1\/Result\.md is under tickets\//],
    ['Bash', { command: 'cp -r /tmp/recording tickets/output-T-1' }, /writes to tickets\/output-T-1, under tickets\//],
    ['Bash', { command: 'cp -t tickets/output-T-1 /tmp/recording/Result.md' }, /writes to tickets\/output-T-1, under tickets\//],
    ['Bash', { command: 'mv /tmp/recording tickets/output-T-3' }, /under tickets\//],
    ['Bash', { command: 'mv tickets/T-1_test.md /tmp/gone.md' }, /under tickets\//],
    ['Bash', { command: 'ln -s /tmp/recording tickets/output-T-1' }, /under tickets\//],
    ['Bash', { command: 'rsync -a /tmp/recording/ tickets/output-T-1/' }, /under tickets\//],
    ['Bash', { command: 'mkdir -p tickets/output-T-1/.internal' }, /under tickets\//],
    ['Bash', { command: 'rm -rf tickets/output-T-1' }, /under tickets\//],
    ['Bash', { command: 'touch receipts/T-1.json' }, /under receipts\//],
    ['Bash', { command: "sed -i '' 's/27.50/30.00/' tickets/T-1_test.md" }, /under tickets\//],
    ['Bash', { command: "perl -pi -e 's/27.50/30.00/' tickets/T-1_test.md" }, /under tickets\//],
    ['Bash', { command: 'tar -xf recording.tar -C tickets/output-T-1' }, /under tickets\//],
    ['Bash', { command: 'unzip -o recording.zip -d tickets/output-T-1' }, /under tickets\//],
  ];
  for (const [tool, input, re] of blocked) {
    const r = runGuard(dir, hookInput(dir, tool, input));
    assert.equal(r.code, 2, `${tool} ${JSON.stringify(input)} should be blocked`);
    assert.match(r.stderr, re, `${tool} ${JSON.stringify(input)}`);
    assert.match(r.stderr, /When you believe a ticket is done, run proven done T-N and wait for Kane\./);
  }

  const allowed = [
    ['Write', { file_path: join(dir, 'demo', 'app', 'cart.js'), content: 'fixed' }],
    ['Edit', { file_path: join(dir, 'CLAUDE.md'), old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: join(tmpdir(), 'proven-elsewhere.txt'), content: 'x' }],
    ['Read', { file_path: join(dir, 'tickets', 'T-1_test.md') }],
    ['Bash', { command: 'node bin/proven.js done T-1', timeout: 600000 }],
    ['Bash', { command: 'proven recheck' }],
    ['Bash', { command: 'proven verify receipts/T-1.json --replay' }],
    ['Bash', { command: 'cat tickets/T-1.md .proven/state/T-1.json' }],
    ['Bash', { command: 'grep -rn "proven freeze" docs README.md' }],
    ['Bash', { command: 'echo proven red' }],
    ['Bash', { command: 'git log --oneline -- .proven/state tickets' }],
    ['Bash', { command: 'npm test > test-output.txt 2>&1' }],
    ['Bash', { command: 'node bin/proven.js done T-1 2>&1 | tail -5' }],
    ['Bash', { command: 'cp tickets/T-1.md /tmp/proven-copy.md' }],
    ['Bash', { command: 'mkdir -p demo/app/img && touch demo/app/img/logo.svg && rm demo/app/old.js' }],
    ['Bash', { command: "sed -n '1,5p' tickets/T-1_test.md" }],
    ['Bash', { command: 'tar -tf recording.tar' }],
  ];
  for (const [tool, input] of allowed) {
    const r = runGuard(dir, hookInput(dir, tool, input));
    assert.equal(r.code, 0, `${tool} ${JSON.stringify(input)} should be allowed: ${r.stderr}`);
    assert.equal(r.stderr, '');
  }

  // Input the guard does not understand is let through rather than stalling the agent.
  assert.equal(runGuard(dir, 'not json').code, 0);

  // The exact command from the settings, run by a shell the way Claude Code runs it, in a folder with a space.
  const spaced = join(tmpdir(), `proven guard ${process.pid}`);
  symlinkSync(dir, spaced);
  t.after(() => rmSync(spaced, { force: true }));
  const viaShell = (tool, input) =>
    spawnSync('sh', ['-c', GUARD_COMMAND], {
      input: JSON.stringify(hookInput(spaced, tool, input)),
      env: { ...process.env, CLAUDE_PROJECT_DIR: spaced },
      encoding: 'utf8',
    });
  let s = viaShell('Write', { file_path: join(spaced, 'tickets', 'T-1_test.md'), content: 'x' });
  assert.equal(s.status, 2, s.stderr);
  assert.match(s.stderr, /under tickets\//);
  s = viaShell('Write', { file_path: join(spaced, 'demo', 'app', 'cart.js'), content: 'x' });
  assert.equal(s.status, 0, s.stderr);
});

test('the guard reads shell commands roughly but on purpose', () => {
  assert.deepEqual(shellParts('a b; c "d e" | f > out.txt 2>&1 && g <in.txt'), {
    commands: [['a', 'b'], ['c', 'd e'], ['f'], ['g']],
    targets: ['out.txt'],
  });
  assert.equal(personStep(['env', 'X=1', 'proven', '--quiet', 'freeze', 'T-1']), 'freeze');
  assert.equal(personStep(['sudo', '-E', 'node', '/opt/proven/bin/proven.js', 'red']), 'red');
  assert.equal(personStep(['proven', 'done', 'T-1']), null);
  assert.equal(personStep(['echo', 'proven', 'red']), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: {} }, { projectDir: tmpdir() }), null);
  assert.equal(decide(null, { projectDir: tmpdir() }), null);
});

test('the guard committed for this repository\'s demo agent is the tested one', () => {
  const committed = join(ROOT, '.claude', 'hooks', 'proven-guard.mjs');
  if (!existsSync(committed)) return;
  assert.deepEqual(readFileSync(committed), readFileSync(GUARD_SOURCE), 'run node bin/proven.js init to refresh it');
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === GUARD_COMMAND)));
});
