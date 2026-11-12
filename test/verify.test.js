import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sealReceipt } from '../src/receipt.js';
import { greenRepo, runProven } from './support/helpers.js';

const RECEIPT = 'receipts/T-1.json';

// Write a changed receipt. With reseal, its own hash is recomputed, as a careful forger would.
function forge(repo, change, { reseal = true, commit = true } = {}) {
  const receipt = repo.json(RECEIPT);
  change(receipt);
  repo.write(RECEIPT, JSON.stringify(reseal ? sealReceipt(receipt) : receipt, null, 2) + '\n');
  if (commit) {
    repo.git('add', RECEIPT);
    repo.git('commit', '-q', '-m', 'Edit the receipt');
  }
}

function failed(stdout) {
  return [...stdout.matchAll(/^ {2}FAIL {2}([^:]+):/gm)].map((m) => m[1]);
}

test('verify confirms an untouched receipt, from a subfolder too', async (t) => {
  const repo = await greenRepo(t);
  const r = await runProven(join(repo.dir, 'demo'), ['verify', '../receipts/T-1.json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^CONFIRMED receipts\/T-1\.json/m);
  assert.deepEqual(failed(r.stdout), []);
});

test('verify: a receipt edited after it was written is a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  forge(repo, (r) => (r.red.kane_reason = 'Kane was happy all along.'), { reseal: false, commit: false });
  const r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^MISMATCH receipts\/T-1\.json/m);
  assert.deepEqual(failed(r.stdout), [
    'the receipt hash matches its contents',
    'the state history records this red, then one commit per failed attempt',
    "the receipt is committed as it is, with Kane's recording",
  ]);
});

test('verify: a test edited after freeze is a MISMATCH, even in a re-sealed, committed receipt', async (t) => {
  const repo = await greenRepo(t);
  repo.write('tickets/T-1_test.md', repo.read('tickets/T-1_test.md').replace('$27.50', '$30.00'));
  repo.git('commit', '-q', '-am', 'Loosen the test');
  const loosened = repo.head();
  forge(repo, (r) => (r.green.commit = loosened));
  const r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.ok(failed(r.stdout).includes('the frozen test did not change between red and green'), r.stdout);
  assert.match(r.stdout, /tickets\/T-1_test\.md at green [0-9a-f]{7} is not the frozen test/);
});

test('verify: a test changed and changed back between red and green is a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  const original = repo.read('tickets/T-1_test.md');
  repo.write('tickets/T-1_test.md', original.replace('$27.50', '$30.00'));
  repo.git('commit', '-q', '-am', 'Loosen the test');
  repo.write('tickets/T-1_test.md', original);
  repo.git('commit', '-q', '-am', 'Put it back');
  const back = repo.head();
  forge(repo, (r) => (r.green.commit = back));
  const r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.ok(failed(r.stdout).includes('the frozen test did not change between red and green'), r.stdout);
  assert.match(r.stdout, /2 commit\(s\) between red and green changed tickets\/T-1_test\.md/);
});

test('verify: a red commit that is not an ancestor of green is a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  const lock = repo.json('tickets/T-1.lock.json');
  repo.git('checkout', '-q', '-b', 'side', lock.frozen_commit);
  repo.write('demo/app/side.txt', 'work on another branch\n');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'Side work');
  const side = repo.head();
  repo.git('checkout', '-q', 'main');
  forge(repo, (r) => (r.red.commit = side));
  const r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.ok(failed(r.stdout).includes('red is an ancestor of green'), r.stdout);
  assert.match(r.stdout, /red [0-9a-f]{7} is not an ancestor of green [0-9a-f]{7}/);
});

test('verify: paths come from the ticket id, not from the receipt', async (t) => {
  const repo = await greenRepo(t);
  forge(repo, (r) => {
    r.frozen.test = 'tickets/T-1.md';
    r.frozen.test_sha256 = r.frozen.ticket_sha256;
  });
  const r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.ok(failed(r.stdout).includes("the receipt's paths match ticket T-1"), r.stdout);
  assert.match(r.stdout, /frozen\.test is tickets\/T-1\.md, not tickets\/T-1_test\.md/);
});

test('verify: settings that differ from the lock are a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  forge(repo, (r) => (r.settings.max_attempts = 99));
  const r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.deepEqual(failed(r.stdout), ['the lock was written once, right after the frozen commit, pins these settings, and red sits on it']);
});

test('verify: app trees that do not match the red and green commits are a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  forge(repo, (r) => (r.green.app_tree = r.red.app_tree));
  const r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.deepEqual(failed(r.stdout), ['the app at red and green matches the receipt, and changed']);
  assert.match(r.stdout, /green\.app_tree is not the app at green [0-9a-f]{7}/);
});

test('verify: a red that the state history does not show is a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  forge(repo, (r) => (r.red.kane_reason = 'Something else entirely.'));
  let r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.deepEqual(failed(r.stdout), ['the state history records this red, then one commit per failed attempt']);
  assert.match(r.stdout, /red\.kane_reason differs/);

  repo.git('reset', '-q', '--hard', 'HEAD~1');
  forge(repo, (r) => (r.red.commit = r.frozen.commit));
  r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.ok(failed(r.stdout).includes('the state history records this red, then one commit per failed attempt'), r.stdout);

  repo.git('reset', '-q', '--hard', 'HEAD~1');
  forge(repo, (r) => (r.green.failed_attempts = 3));
  r = await repo.run(['verify', RECEIPT]);
  assert.deepEqual(failed(r.stdout), ['the state history records this red, then one commit per failed attempt']);
  assert.match(r.stdout, /0 failed attempts in the history, 3 in the receipt/);
});

test('verify: a receipt naming a commit that does not exist is a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  forge(repo, (r) => (r.green.commit = 'deadbeef'.repeat(5)));
  const r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /green commit deadbee is not in this repository/);
});
