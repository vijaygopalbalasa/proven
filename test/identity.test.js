import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { couponTicket, makeRepo } from './support/helpers.js';

// A fresh clone has no user.name or user.email of its own. Proven runs git without the global config, so it reads the
// person's global identity itself, once, and passes it on.
async function bare(t) {
  const repo = await makeRepo(t);
  repo.git('config', '--unset', 'user.name');
  repo.git('config', '--unset', 'user.email');
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  const home = mkdtempSync(join(tmpdir(), 'proven-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { repo, home, env: { HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: '1' } };
}

test('a repo with no local identity commits with the person\'s global one', async (t) => {
  const { repo, home, env } = await bare(t);
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Global Person\n\temail = global@example.invalid\n');
  const r = await repo.run(['freeze', 'T-1'], { env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(repo.git('log', '-1', '--format=%an <%ae> / %cn <%ce>'), 'Global Person <global@example.invalid> / Global Person <global@example.invalid>');
});

test('a repo with no identity anywhere is refused with how to set one', async (t) => {
  const { repo, env } = await bare(t);
  const before = repo.head();
  const r = await repo.run(['freeze', 'T-1'], { env });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /user\.name and user\.email/);
  assert.match(r.stderr, /git config user\.name "Your Name"/);
  assert.equal(repo.head(), before);
});

test('a local identity is used as it is, and the global one is ignored', async (t) => {
  const { repo, home, env } = await bare(t);
  repo.git('config', 'user.name', 'Local Person');
  repo.git('config', 'user.email', 'local@example.invalid');
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Global Person\n\temail = global@example.invalid\n');
  const r = await repo.run(['freeze', 'T-1'], { env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(repo.git('log', '-1', '--format=%an <%ae>'), 'Local Person <local@example.invalid>');
});
