import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { couponTicket, fixCoupon, makeRepo } from './support/helpers.js';

const STATE = '.proven/state/T-1.json';
const CONFIG = '.proven/config.json';

function both(r, re) {
  assert.match(r.stdout, re, `stdout: ${r.stdout}`);
  assert.match(r.stderr, re, `stderr: ${r.stderr}`);
}

// Commit a state file the way an agent with a shell could: state only, with a subject that looks like Proven's.
function forgeStateCommit(repo, state, subject = 'T-1: attempt 1 failed at step 2') {
  repo.write(STATE, JSON.stringify(state, null, 2) + '\n');
  repo.git('add', STATE);
  repo.git('commit', '-q', '-m', subject);
}

async function redRepo(t, opts) {
  const repo = await makeRepo(t, opts);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 0, r.stderr);
  return repo;
}

test('the Kane command cannot come from a file in the repository', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  repo.write(CONFIG, JSON.stringify({ app: 'demo/app', kane: ['node', 'always-pass.js'] }));
  const r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /"kane" cannot be set here\. Proven always runs kane-cli from PATH\./);
  assert.equal(repo.kaneCalls().length, 0);
});

test('settings that affect verdicts are pinned at freeze; red and done refuse when they change', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const original = repo.read(CONFIG);

  repo.write(CONFIG, JSON.stringify({ app: 'demo/app', timeout_s: 5, max_attempts: 4 }));
  let r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /settings changed after T-1 was frozen: timeout_s/);
  assert.equal(repo.kaneCalls().length, 0);

  repo.write(CONFIG, original);
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);

  repo.write(CONFIG, JSON.stringify({ app: 'demo/app', timeout_s: 60, max_attempts: 99 }));
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /settings changed after T-1 was frozen: max_attempts/);
  repo.write(CONFIG, JSON.stringify({ app: 'demo', timeout_s: 60, max_attempts: 4 }));
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.match(r.stderr, /settings changed after T-1 was frozen: app/);
  assert.equal(repo.kaneCalls().length, 1);
});

test('Proven reads its state only from its own commits', async (t) => {
  const repo = await redRepo(t);
  let r = await repo.run(['done', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 1);
  assert.equal(repo.json(STATE).attempts, 1);
  const calls = repo.kaneCalls().length;
  const good = repo.head();

  // An edit in the working tree is refused.
  const lowered = JSON.stringify({ ...repo.json(STATE), attempts: 0, status: 'red' }, null, 2) + '\n';
  repo.write(STATE, lowered);
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\.proven\/state\/T-1\.json has uncommitted changes\. Proven reads its state from commits only\./);
  repo.git('checkout', '--', STATE);

  // A commit that changes the state along with other files is not Proven's.
  fixCoupon(repo);
  repo.write(STATE, lowered);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'Fix coupon');
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /was changed by commit [0-9a-f]{7}, which Proven did not make/);
  repo.git('reset', '-q', '--hard', good);

  // A state-only commit that looks like Proven's still cannot lower the attempt count.
  repo.write(STATE, lowered);
  repo.git('add', STATE);
  repo.git('commit', '-q', '-m', 'T-1: attempt 1 failed at step 2');
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /history of \.proven\/state\/T-1\.json does not match its attempt count/);
  repo.git('reset', '-q', '--hard', good);

  assert.equal(repo.kaneCalls().length, calls);
});

test('done refuses when the frozen test was changed in a commit after red, even if changed back', async (t) => {
  const repo = await redRepo(t);
  const original = repo.read('tickets/T-1_test.md');
  repo.write('tickets/T-1_test.md', original.replace('$27.50', '$30.00'));
  repo.git('commit', '-q', '-am', 'Loosen the test');
  repo.write('tickets/T-1_test.md', original);
  repo.git('commit', '-q', '-am', 'Put it back');
  fixCoupon(repo);
  const r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /tickets\/T-1_test\.md was changed after red in 2 commit\(s\)/);
  assert.equal(repo.kaneCalls().length, 1);
});

test('red and done refuse an app folder holding files git ignores, which G would not keep', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  repo.write('demo/app/.DS_Store', 'ignored by .gitignore, but the server would still serve it');
  let r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /demo\/app holds files that git ignores: demo\/app\/\.DS_Store\./);
  rmSync(join(repo.dir, 'demo/app/.DS_Store'));
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);

  fixCoupon(repo);
  repo.write('demo/app/.DS_Store', 'again');
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /demo\/app holds files that git ignores/);
  rmSync(join(repo.dir, 'demo/app/.DS_Store'));
  assert.equal(repo.kaneCalls().length, 1);

  // One that appears while Kane runs is caught before G is committed.
  const before = repo.head();
  r = await repo.run(['done', 'T-1'], { scenario: 'green-changes-app', env: { FAKE_KANE_TOUCH: join(repo.dir, 'demo/app/.DS_Store') } });
  assert.equal(r.code, 2);
  both(r, /did not run: demo\/app holds files that git ignores: demo\/app\/\.DS_Store\./);
  both(r, /No attempt was counted\./);
  assert.equal(repo.head(), before);
  assert.equal(repo.exists('receipts/T-1.json'), false);
});

test('red and done refuse symlinks in the app folder', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  symlinkSync('cart.js', join(repo.dir, 'demo/app/linked.js'));
  repo.git('add', 'demo/app/linked.js');
  repo.git('commit', '-q', '-m', 'Add a link');
  let r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /demo\/app holds a symlink: demo\/app\/linked\.js\./);
  repo.git('rm', '-q', 'demo/app/linked.js');
  repo.git('commit', '-q', '-m', 'Remove the link');
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);

  fixCoupon(repo);
  symlinkSync('../../tickets/T-1.md', join(repo.dir, 'demo/app/notes.md'));
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /demo\/app holds a symlink: demo\/app\/notes\.md\./);
  assert.equal(repo.kaneCalls().length, 1);
});

test('the red record cannot be moved or thinned by later state commits', async (t) => {
  const repo = await redRepo(t);
  const lock = repo.json('tickets/T-1.lock.json');
  const state = repo.json(STATE);
  const good = repo.head();
  const calls = repo.kaneCalls().length;

  // The attempt count stays consistent, but the red commit is moved to an older commit.
  forgeStateCommit(repo, { ...state, status: 'in-progress', attempts: 1, red: { ...state.red, commit: lock.frozen_commit } });
  let r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /The red record in \.proven\/state\/T-1\.json names [0-9a-f]{7}, but red was recorded on [0-9a-f]{7}\./);
  repo.git('reset', '-q', '--hard', good);

  // Kane's words in the red record are changed in a later state commit.
  forgeStateCommit(repo, { ...state, status: 'in-progress', attempts: 1, red: { ...state.red, kane_reason: 'nothing to see' } });
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /The red record in \.proven\/state\/T-1\.json changed in commit [0-9a-f]{7}\./);
  repo.git('reset', '-q', '--hard', good);

  // A required field is missing: no default is assumed.
  const thin = { ...state.red };
  delete thin.kane;
  forgeStateCommit(repo, { ...state, status: 'in-progress', attempts: 1, red: thin });
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\.proven\/state\/T-1\.json is missing red\.kane\./);
  repo.git('reset', '-q', '--hard', good);

  assert.equal(repo.kaneCalls().length, calls);
});

test('red and green must run on the same Kane', async (t) => {
  const repo = await redRepo(t);
  fixCoupon(repo);
  const r = await repo.run(['done', 'T-1'], { realKane: true });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /T-1 went red on fake \(PROVEN_KANE_BIN\), but this run would use kane-cli\. Red and green must run on the same Kane\./);
  assert.equal(repo.realKaneCalled(), false);
});
