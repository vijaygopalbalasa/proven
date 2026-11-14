import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, guard, PROTECTED } from '../src/hooks/proven-guard.mjs';
import { GUARD_MATCHER } from '../src/commands/init.js';
import { ROOT } from './support/helpers.js';

const HOOK = join(ROOT, 'src', 'hooks', 'proven-guard.mjs');

function project(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'proven-hardening-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'project');
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  mkdirSync(join(dir, 'site'), { recursive: true });
  return dir;
}
const run = (dir, input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

test('the guard also protects .testmuai, .mcp.json and CLAUDE.md', (t) => {
  const dir = project(t);
  for (const name of ['.testmuai', '.mcp.json', 'claude.md']) assert.ok(PROTECTED.includes(name), name);
  const call = (tool_name, tool_input) => decide({ tool_name, tool_input, cwd: dir }, { projectDir: dir });
  for (const file of ['.testmuai/evidence/x', '.mcp.json', 'CLAUDE.md', 'claude.md', 'Claude.md']) {
    assert.match(call('Write', { file_path: join(dir, file), content: 'x' }) ?? '', /which the agent does not change/, file);
    assert.match(call('Bash', { command: `echo x > ${file}` }) ?? '', /Proven: /, file);
  }
  assert.equal(call('Bash', { command: 'cat CLAUDE.md .mcp.json' }), null, 'reading is allowed');
  assert.equal(call('Write', { file_path: join(dir, 'site', 'a.html'), content: 'x' }), null, 'the app stays editable');
});

test('unparseable or malformed hook input is blocked with exit code 2 and a reason', (t) => {
  const dir = project(t);
  for (const input of ['not json', '', '   ', '[]', 'null', '"x"', '42', '{}', '{"tool_name":7}']) {
    const r = run(dir, input);
    assert.equal(r.status, 2, JSON.stringify(input));
    assert.match(r.stderr, /Proven: .*could not read this tool call/, JSON.stringify(input));
  }
  const ok = run(dir, JSON.stringify({ tool_name: 'Read', cwd: dir, tool_input: { file_path: join(dir, 'site', 'a.html') } }));
  assert.equal(ok.status, 0, ok.stderr);
  const blocked = run(dir, JSON.stringify({ tool_name: 'Write', cwd: dir, tool_input: { file_path: join(dir, 'tickets', 'T-1.md') } }));
  assert.equal(blocked.status, 2);
});

test('an exception inside the guard blocks the call too', async (t) => {
  const dir = project(t);
  const r = await guard(JSON.stringify({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'ls' } }), {
    projectDir: dir,
    decideFn: () => {
      throw new Error('boom');
    },
  });
  assert.equal(r.code, 2);
  assert.match(r.message, /Proven: the guard failed \(boom\), so it blocked this call/);
});

test('the hook matcher covers MCP tools, and init writes it', () => {
  const re = new RegExp(`^(${GUARD_MATCHER})$`);
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'mcp__files__write_file', 'mcp__github__create_issue']) assert.match(tool, re, tool);
  assert.doesNotMatch('Read', re);
  assert.match(GUARD_MATCHER, /mcp__\.\*/);
});

test('an MCP call whose string arguments point into a protected path is blocked, others are allowed', (t) => {
  const dir = project(t);
  const call = (tool_input, tool_name = 'mcp__files__write_file') => decide({ tool_name, tool_input, cwd: dir }, { projectDir: dir });
  for (const input of [
    { path: 'tickets/T-1_test.md', content: 'x' },
    { path: join(dir, 'receipts', 'T-1.json') },
    { files: ['site/a.js', 'receipts/T-1.json'] },
    { nested: { deep: [{ target: '.proven/state/T-1.json' }] } },
    { uri: `file://${join(dir, 'tickets', 'T-1.md')}` },
    { path: 'TICKETS/T-1.md' },
    { path: 'src/commands/done.js' },
    { path: '.git/config' },
    { path: 'CLAUDE.md' },
  ]) assert.match(call(input) ?? '', /Proven: .*protected/, JSON.stringify(input));
  for (const input of [
    { path: 'site/a.html', content: 'a ticket and a receipt' },
    { query: 'show tickets' },
    { n: 3, ok: true, none: null },
    { files: ['site/a.js'] },
  ]) assert.equal(call(input), null, JSON.stringify(input));
  assert.equal(call({ path: 'tickets/T-1.md' }, 'mcp__other__read_only'), call({ path: 'tickets/T-1.md' }), 'the verdict does not depend on the server name');
});

test('a symlink with another name that leads into a protected folder is caught by the on-disk path', (t) => {
  const dir = project(t);
  symlinkSync(join(dir, 'tickets'), join(dir, 'site', 'alias'));
  writeFileSync(join(dir, 'tickets', 'T-1.md'), 'x');
  const call = (tool, input) => decide({ tool_name: tool, tool_input: input, cwd: dir }, { projectDir: dir });
  assert.match(call('Edit', { file_path: 'site/alias/T-1.md' }) ?? '', /under tickets\//);
  assert.match(call('Edit', { file_path: join(dir, 'site', 'alias', 'new.md') }) ?? '', /under tickets\//);
  assert.match(call('mcp__x__y', { path: 'site/alias/T-1.md' }) ?? '', /Proven: /);
});
