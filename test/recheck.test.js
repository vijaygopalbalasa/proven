import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealReceipt } from '../src/receipt.js';
import { couponTicket, greenRepo, makeRepo } from './support/helpers.js';
import { findCommittedLeaks } from './support/scan.js';

const STATE = '.proven/state/T-1.json';
const RECEIPT = 'receipts/T-1.json';

function both(r, re) {
  assert.match(r.stdout, re, `stdout: ${r.stdout}`);
  assert.match(r.stderr, re, `stderr: ${r.stderr}`);
}

// A later change that drops the SAVE10 code, the way T-3's natural fix does in the demo.
function breakCoupon(repo) {
  const text = repo.read('demo/app/cart.js');
  const changed = text.replace('const coupons = { save10: 10 };', 'const coupons = { fall15: 15 };');
  if (changed === text) throw new Error('the coupon table was not found in cart.js');
  repo.write('demo/app/cart.js', changed);
  repo.git('commit', '-q', '-am', 'Take the codes from the autumn campaign');
  return repo.head();
}

// What the agent would do once T-1 is reopened: put SAVE10 back next to the new code.
function restoreCoupon(repo) {
  repo.write('demo/app/cart.js', repo.read('demo/app/cart.js').replace('const coupons = { fall15: 15 };', 'const coupons = { save10: 10, fall15: 15 };'));
}

function okLines(stdout) {
  return [...stdout.matchAll(/^ {2}ok {4}(.*)$/gm)].map((m) => m[1]);
}

test('recheck reopens a done ticket that a later change broke, and done closes it again with a linked receipt', async (t) => {
  const repo = await greenRepo(t);
  const first = repo.json(RECEIPT);
  const firstReceiptCommit = repo.head();
  const R2 = breakCoupon(repo);
  const calls = repo.kaneCalls().length;

  // Requirement 5.1 and 5.2: the replay fails, one fresh run confirms it, and only then does T-1 reopen.
  let r = await repo.run(['recheck'], { scenario: ['replay-fail', 'red'] });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  both(r, /^T-1: the replay failed at step 2 \(Apply SAVE10\)\. Confirming with one fresh run that authors every step again\.$/m);
  both(r, new RegExp(`^T-1 reopened at ${R2.slice(0, 7)}: Kane failed step 2 \\(Apply SAVE10\\) on a fresh run too\\.$`, 'm'));
  both(r, /^Kane says: The cart accepts SAVE10, but applying it leaves the total at \$20\.00 instead of \$18\.00\.$/m);
  both(r, /^The agent fixes the app and runs proven done T-1\. Fix the app, not the test\.$/m);
  both(r, /^Reopened: T-1\.$/m);
  const [replay, confirm] = repo.kaneCalls().slice(calls);
  assert.deepEqual(replay.extra_args, ['--no-adaptive-heal']);
  assert.equal(replay.recording_before, true, 'the replay used the local recording');
  assert.deepEqual(confirm.extra_args, ['--author']);
  assert.equal(repo.kaneCalls().length, calls + 2);

  // The reopen is a state commit of its own, right on the commit Kane judged.
  assert.deepEqual(repo.changed('HEAD'), [STATE]);
  assert.equal(repo.git('rev-parse', 'HEAD~1'), R2);
  assert.match(repo.git('log', '-1', '--format=%s'), /^T-1: reopened at [0-9a-f]{7}, step 2 failed$/);
  let state = repo.json(STATE);
  assert.equal(state.status, 'reopened');
  assert.equal(state.attempts, 0);
  assert.equal(state.red.commit, R2);
  assert.equal(state.red.app_tree, repo.git('rev-parse', `${R2}:demo/app`));
  assert.equal(state.red.failed_step, 2);
  assert.equal(state.red.kane, 'fake (PROVEN_KANE_BIN)');
  assert.equal(state.reopened.replay.kane_one_liner, 'Applying SAVE10 leaves the $20.00 cart total unchanged instead of showing $18.00.');
  assert.deepEqual(state.reopened.previous, {
    receipt: RECEIPT,
    commit: firstReceiptCommit,
    receipt_sha256: first.receipt_sha256,
    green_commit: first.green.commit,
  });
  assert.equal('green' in state, false);

  // The first receipt still verifies, and a person's steps refuse while the agent works.
  assert.equal((await repo.run(['verify', RECEIPT])).code, 0);
  r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /T-1 was reopened by proven recheck at [0-9a-f]{7}, so it is red again\./);
  r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /would move the goalposts/);

  // Requirement 5.2: a new green through proven done, which counts attempts as before.
  r = await repo.run(['done', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 1, r.stderr);
  both(r, /Attempt 1 of 4\./);
  assert.equal(repo.json(STATE).status, 'in-progress');
  restoreCoupon(repo);
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 0, r.stderr);
  const second = repo.json(RECEIPT);
  both(r, new RegExp(`^Done: red ${R2.slice(0, 7)}, green ${second.green.commit.slice(0, 7)}\\.$`, 'm'));
  both(r, /^This receipt links the earlier one \([0-9a-f]{7}, committed in [0-9a-f]{7}\), which proven recheck reopened\.$/m);
  assert.equal(second.red.commit, R2);
  assert.equal(second.green.failed_attempts, 1);
  assert.deepEqual(second.previous, { commit: firstReceiptCommit, receipt_sha256: first.receipt_sha256 });
  assert.deepEqual(second.frozen, first.frozen);
  state = repo.json(STATE);
  assert.equal(state.status, 'done');

  // Both receipts verify with git alone; the new one also checks the one it links.
  r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(okLines(r.stdout).length, 11, r.stdout);
  assert.ok(okLines(r.stdout).includes('the earlier receipt it links is committed, verifies, and came before this red'));
  assert.ok(okLines(r.stdout).includes('the lock was written once, right after the frozen commit, and pins these settings'));
  repo.write('receipts/T-1.earlier.json', repo.git('show', `${firstReceiptCommit}:${RECEIPT}`) + '\n');
  r = await repo.run(['verify', 'receipts/T-1.earlier.json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(okLines(r.stdout).length, 10);

  // The replay re-checks the new red too: the app at the reopen commit fails, the agent's fix passes.
  r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'green'] });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, new RegExp(`replay at red ${R2.slice(0, 7)}: Kane failed step 2 \\(Apply SAVE10\\), as the receipt records`));

  // A recheck now finds every done ticket passing and changes nothing.
  const before = repo.head();
  r = await repo.run(['recheck'], { scenario: 'green' });
  assert.equal(r.code, 0, r.stdout);
  both(r, /^T-1 still passes: Kane replayed its frozen test on [0-9a-f]{7}\.$/m);
  both(r, /^Every done ticket still passes\.$/m);
  assert.equal(repo.head(), before);

  assert.deepEqual(findCommittedLeaks(repo.dir, { calls: repo.kaneCalls() }), []);
  assert.equal(repo.realKaneCalled(), false);
});

test('recheck changes nothing when the replay passes, when a fresh run passes, or when Kane does not run', async (t) => {
  const repo = await greenRepo(t);
  breakCoupon(repo);
  const head = repo.head();
  let calls = repo.kaneCalls().length;

  let r = await repo.run(['recheck'], { scenario: 'green' });
  assert.equal(r.code, 0);
  both(r, /^T-1 still passes/m);
  assert.equal(repo.kaneCalls().length, calls + 1, 'no fresh run after a passing replay');

  calls = repo.kaneCalls().length;
  r = await repo.run(['recheck'], { scenario: ['replay-fail', 'green'] });
  assert.equal(r.code, 0);
  both(r, /^T-1 stays done: the replay missed, but a fresh run passed every step, so nothing broke\.$/m);
  assert.equal(repo.kaneCalls().length, calls + 2);

  r = await repo.run(['recheck'], { scenario: ['replay-fail', 'not-started'] });
  assert.equal(r.code, 2);
  both(r, /^T-1: the fresh run did not run: Kane did not start \(exit code 2\)\. Kane said: Not signed in\. Run kane-cli login first\. Nothing changed\. Run proven recheck again\.$/m);

  calls = repo.kaneCalls().length;
  r = await repo.run(['recheck'], { scenario: 'env-down' });
  assert.equal(r.code, 2);
  both(r, /^T-1: the replay did not run: Kane says step 2 failed because of the environment, not the app/m);
  assert.equal(repo.kaneCalls().length, calls + 1);

  assert.equal(repo.head(), head);
  assert.equal(repo.json(STATE).status, 'done');
});

test('recheck looks only at done tickets, refuses an uncommitted app, and skips a receipt that does not verify', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);
  let r = await repo.run(['recheck'], { scenario: 'green' });
  assert.equal(r.code, 0);
  both(r, /^No done tickets to recheck\. Not done: T-1 \(red\)\.$/m);
  assert.equal(repo.kaneCalls().length, 1);

  const done = await greenRepo(t);
  const calls = done.kaneCalls().length;
  done.write('demo/app/cart.js', done.read('demo/app/cart.js') + '\n// work in progress\n');
  r = await done.run(['recheck'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /demo\/app has uncommitted changes, so a reopen would not name the code Kane judged\./);
  done.git('checkout', '--', 'demo/app/cart.js');

  done.write(RECEIPT, done.read(RECEIPT).replace('"failed_attempts": 0', '"failed_attempts": 3'));
  done.git('commit', '-q', '-am', 'Edit the receipt');
  r = await done.run(['recheck'], { scenario: 'green' });
  assert.equal(r.code, 2);
  both(r, /^T-1: not rechecked: its receipt does not verify \(the receipt hash matches its contents: /m);
  assert.equal(done.kaneCalls().length, calls);
});

test('a reopen that Proven did not write is refused', async (t) => {
  const repo = await greenRepo(t);
  const state = repo.json(STATE);
  const good = repo.head();
  const calls = repo.kaneCalls().length;
  const forge = (next, subject) => {
    repo.write(STATE, JSON.stringify(next, null, 2) + '\n');
    repo.git('add', STATE);
    repo.git('commit', '-q', '-m', subject);
  };

  // A reopen that names an older commit as red, to reuse an old failure.
  forge({ ...state, status: 'reopened', attempts: 0, red: { ...state.red } }, 'T-1: reopened at x, step 2 failed');
  let r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /The reopen commit [0-9a-f]{7} of T-1 does not sit on the commit it names as red\./);
  repo.git('reset', '-q', '--hard', good);

  // An attempt recorded after done, to reopen a round without a recheck.
  forge({ ...state, status: 'in-progress', attempts: 1 }, 'T-1: attempt 1 failed at step 2');
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /records "in-progress" in [0-9a-f]{7} after "done"/);
  repo.git('reset', '-q', '--hard', good);

  assert.equal(repo.kaneCalls().length, calls);
});

test('verify: a later receipt whose link to the earlier one is changed is a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  breakCoupon(repo);
  assert.equal((await repo.run(['recheck'], { scenario: ['replay-fail', 'red'] })).code, 1);
  restoreCoupon(repo);
  assert.equal((await repo.run(['done', 'T-1'], { scenario: 'green' })).code, 0);
  const receipt = repo.json(RECEIPT);

  // The link names another receipt hash: the earlier receipt does not match, and the reopen links another one.
  const forged = sealReceipt({ ...receipt, previous: { ...receipt.previous, receipt_sha256: 'f'.repeat(64) } });
  delete forged.receipt_sha256;
  repo.write(RECEIPT, JSON.stringify(sealReceipt(forged), null, 2) + '\n');
  repo.git('commit', '-q', '-am', 'Edit the link');
  let r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL {2}the earlier receipt it links is committed, verifies, and came before this red: receipts\/T-1\.json in [0-9a-f]{7} is not the receipt this one links/);
  assert.match(r.stdout, /FAIL {2}the state history records this red, then one commit per failed attempt: the reopen in [0-9a-f]{7} links another earlier receipt/);
  repo.git('reset', '-q', '--hard', 'HEAD~1');

  // Dropping the link makes it read as a first close, which the history does not show.
  const { previous: _dropped, receipt_sha256: _old, ...rest } = receipt;
  repo.write(RECEIPT, JSON.stringify(sealReceipt(rest), null, 2) + '\n');
  repo.git('commit', '-q', '-am', 'Drop the link');
  r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL {2}the lock was written once, right after the frozen commit, pins these settings, and red sits on it: red [0-9a-f]{7} is not the lock commit/);
  assert.match(r.stdout, /FAIL {2}the state history records this red, then one commit per failed attempt: [0-9a-f]{7} does not record a red/);
});
