import { test } from 'node:test';
import assert from 'node:assert/strict';
import { couponTicket, fixCoupon, makeRepo } from './support/helpers.js';

const RECEIPT = 'receipts/T-1.json';

// A repo with T-1 closed by a fake-Kane red and green, pinning the given time limit.
async function closedRepo(t, timeoutS) {
  const repo = await makeRepo(t, { timeoutS });
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);
  fixCoupon(repo);
  const r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 0, r.stderr);
  return repo;
}
const lines = (stdout, status) => [...stdout.matchAll(new RegExp(`^ {2}${status} +(.*)$`, 'gm'))].map((m) => m[1]);

test('a replay cut off after the red step is not a confirmation: honest headline, what Kane did, exit code 2', async (t) => {
  const repo = await closedRepo(t, 3);
  const calls = repo.kaneCalls().length;
  const r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: 'red-cut' });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^CONFIRMED \(git checks only\) receipts\/T-1\.json, but made with a fake Kane, not Kane CLI$/m);
  assert.doesNotMatch(r.stdout, /^CONFIRMED receipts/m);
  assert.match(r.stdout, /^Replay limit 6 s \(twice the 3 s pinned at freeze\)$/m);
  assert.equal([...r.stdout.matchAll(/^Replay limit /gm)].length, 1, 'said once');
  assert.match(r.stdout, /^Kane failed step 2 at red, as the receipt records, but ran past the replay limit of 6 s, so the green run was not started\.$/m);
  assert.doesNotMatch(r.stdout, /Kane did not run again/);
  assert.equal(repo.kaneCalls().length, calls + 1, 'green was not started');
  assert.equal(lines(r.stdout, 'ok').filter((x) => x.startsWith('replay at')).length, 0, 'no replay line claims a full replay');
});

test('a replay where green is cut off says red agreed and green was not confirmed', async (t) => {
  const repo = await closedRepo(t, 3);
  const r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'hang'] });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^CONFIRMED \(git checks only\) /m);
  assert.match(lines(r.stdout, 'ok').at(-1), /^replay at red [0-9a-f]{7}: Kane failed step 2 \(Apply SAVE10\), as the receipt records$/);
  assert.match(r.stdout, /^Kane failed step 2 at red, as the receipt records, but ran past the replay limit of 6 s at green without finishing, so green was not confirmed\.$/m);
});

test('a replay where Kane never starts says so, exit code 2', async (t) => {
  const repo = await closedRepo(t, 60);
  const r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: 'not-started' });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^CONFIRMED \(git checks only\) receipts\/T-1\.json/m);
  assert.match(r.stdout, /^Kane did not run at red: Kane did not start \(exit code 2\)\. Kane said: Not signed in\. Run kane-cli login first\.$/m);
  assert.doesNotMatch(r.stdout, /Kane did not run again|Kane failed step/);
});

test('a full replay keeps its exact lines and exits 0; a mismatch exits 1', async (t) => {
  const repo = await closedRepo(t, 60);
  let r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'green'] });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^CONFIRMED receipts\/T-1\.json, but made with a fake Kane, not Kane CLI$/m);
  assert.doesNotMatch(r.stdout, /git checks only/);
  assert.match(r.stdout, /^Replay limit 120 s \(twice the 60 s pinned at freeze\)$/m);
  assert.match(r.stdout, /^Kane ran the frozen test again: it failed without the change and passed with it\.$/m);
  r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['green', 'green'] });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^MISMATCH receipts\/T-1\.json/m);
});

test('a replay gets twice the pinned limit, and red, done and recheck stay on the pinned one', async (t) => {
  const repo = await closedRepo(t, 3);
  // Kane takes 4.5 s to start: past the pinned 3 s, inside the replay's 6 s.
  const slow = { FAKE_KANE_DELAY_MS: '4500' };
  const recheck = await repo.run(['recheck'], { scenario: 'green', env: slow });
  assert.equal(recheck.code, 2, recheck.stdout + recheck.stderr);
  assert.match(recheck.stdout + recheck.stderr, /Kane did not finish within 3 s/);
  const r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'green'], env: slow });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Replay limit 6 s \(twice the 3 s pinned at freeze\)$/m);
  assert.match(r.stdout, /^Kane ran the frozen test again: it failed without the change and passed with it\.$/m);
});

test('the help documents the exit codes of verify', async (t) => {
  const repo = await makeRepo(t);
  const r = await repo.run(['help']);
  assert.match(r.stdout, /Exit codes for verify: 0 confirmed \(with --replay, Kane agreed\), 1 mismatch, 2 --replay was asked for but did not complete/);
});
