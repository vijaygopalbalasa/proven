import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTicketTemplate } from '../src/ticket.js';
import { couponTicket, fixCoupon, greenRepo, makeRepo, PROVEN, ROOT } from './support/helpers.js';

test('red and done print the credits Kane used on that run, and not when Kane did not run', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  let r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 0, r.stderr);
  const red = repo.json('.proven/state/T-1.json').red.credits;
  assert.ok(red > 0, 'the fixture has credits');
  assert.match(r.stdout, new RegExp(`^Kane used ${red} credits on this run\\.$`, 'm'));
  fixCoupon(repo);
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Kane used [0-9.]+ credits on this run\.$/m);
  const none = await makeRepo(t);
  none.write('tickets/T-1.md', couponTicket(none.url));
  assert.equal((await none.run(['freeze', 'T-1'])).code, 0);
  r = await none.run(['red', 'T-1'], { scenario: 'not-started' });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.stdout + r.stderr, /Kane used/);
});

test('recheck prints credits for each run, and replay says up front that it runs Kane twice', async (t) => {
  const repo = await greenRepo(t);
  let r = await repo.run(['recheck'], { scenario: 'green' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Kane used [0-9.]+ credits on this run\.$/m);
  r = await repo.run(['verify', 'receipts/T-1.json', '--replay'], { scenario: ['red', 'green'] });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Replay runs Kane twice \(red, then green\), so it costs about twice a red run\.$/m);
  assert.equal([...r.stdout.matchAll(/^Kane used [0-9.]+ credits on this run\.$/gm)].length, 2);
});

test('a result line prints once when stdout and stderr go to the same file, and on both when they are separate', async (t) => {
  const repo = await makeRepo(t);
  const file = join(repo.aux, 'both.txt');
  const fd = openSync(file, 'w');
  await new Promise((done) => spawn(process.execPath, [PROVEN, 'recheck'], { cwd: repo.dir, stdio: ['ignore', fd, fd] }).on('close', done));
  closeSync(fd);
  assert.equal(readFileSync(file, 'utf8').split('No done tickets to recheck.').length - 1, 1, 'once in one file');
  const r = await repo.run(['recheck']);
  assert.match(r.stdout, /No done tickets to recheck\./);
  assert.match(r.stderr, /No done tickets to recheck\./);
});

test('freeze refuses while the files proven init wrote are not committed, and says what to run', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['init'])).code, 0);
  let r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /proven init wrote .*\.claude.*CLAUDE\.md.*not committed.*git add -A && git commit -m "Add Proven".*freeze T-1 again/s);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'Add Proven');
  r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 0, r.stderr);
});

test('the ticket template says how to write a criterion that Kane can check', () => {
  const t = renderTicketTemplate({ id: 'T-1', title: 'x' });
  assert.match(t, /Name the exact labels the feature will show/);
  assert.match(t, /lasting state of the page, not a message that disappears/);
  assert.match(t, /Step 1, the landmark check, is added for you/);
});

test('npm packs only what runs: bin, src, README, LICENSE and package.json', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.includes('bin/proven.js') && files.includes('src/cli.js') && files.includes('package.json'));
  for (const f of files) assert.match(f, /^(bin\/|src\/|README\.md$|LICENSE$|package\.json$)/, f);
});
