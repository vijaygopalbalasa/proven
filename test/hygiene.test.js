import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './support/helpers.js';
import { EMAIL, HOME_LINUX, HOME_MAC, SESSIONS, SHARE_PATH, TM_HOST, UUID } from './support/patterns.js';

// Files in this repository that git tracks or would track: tracked plus untracked, not ignored.
function repoFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return [...new Set(out.split('\0').filter(Boolean))].filter((p) => existsSync(join(ROOT, p)));
}

test('this repository holds no emails, home paths, Kane session data or share links', (t) => {
  if (!existsSync(join(ROOT, '.git'))) return t.skip('not a git checkout');
  const home = homedir();
  const problems = [];
  for (const path of repoFiles()) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    if (EMAIL.test(text)) problems.push(`${path}: an email address`);
    for (const [needle, what] of [
      [HOME_MAC, 'a home path'],
      [HOME_LINUX, 'a home path'],
      [home.length > 1 ? home : null, 'this machine\'s home folder'],
      [SESSIONS, 'a Kane session folder'],
      [SHARE_PATH, 'a share link'],
      [TM_HOST, 'a Test Manager link'],
    ]) {
      if (needle && text.includes(needle)) problems.push(`${path}: ${what}`);
    }
    for (const id of text.match(UUID) ?? []) {
      if (!id.startsWith('00000000-0000-4000-8000-')) problems.push(`${path}: an id that is not a placeholder (${id.slice(0, 8)}...)`);
    }
    if (text.includes(String.fromCharCode(0x2014)) || text.includes(String.fromCharCode(0x2013))) problems.push(`${path}: a long dash`);
    if (path.endsWith('.evidence') || path.startsWith('.testmuai/') || path.includes('/.testmuai/')) problems.push(`${path}: Kane evidence`);
  }
  assert.deepEqual(problems, []);
});
