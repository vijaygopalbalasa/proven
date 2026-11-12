import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sha256 } from '../src/hash.js';
import { replayAgrees } from '../src/replay.js';
import { greenRepo } from './support/helpers.js';

const RECEIPT = 'receipts/T-1.json';

function lines(stdout, status) {
  return [...stdout.matchAll(new RegExp(`^ {2}${status} +(.*)$`, 'gm'))].map((m) => m[1]);
}

test('verify --replay serves the app as it was at red and at green, and Kane agrees with both', async (t) => {
  const repo = await greenRepo(t);
  const receipt = repo.json(RECEIPT);
  const calls = repo.kaneCalls().length;
  const r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'green'], env: { FAKE_KANE_FETCH: '/cart.js' } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^CONFIRMED receipts\/T-1\.json, but made with a fake Kane, not Kane CLI$/m);
  assert.deepEqual(lines(r.stdout, 'ok').slice(-2), [
    `replay at red ${receipt.red.commit.slice(0, 7)}: Kane failed step 2 (Apply SAVE10), as the receipt records`,
    `replay at green ${receipt.green.commit.slice(0, 7)}: Kane passed all 2 steps, as the receipt records`,
  ]);
  assert.match(r.stdout, /^ {8}Kane says: The cart accepts SAVE10, but applying it leaves the total at \$20\.00 instead of \$18\.00\.$/m);
  assert.match(r.stdout, /^Kane ran the frozen test again: it failed without the change and passed with it\.$/m);
  assert.match(r.stderr, /Kane: fake \(PROVEN_KANE_BIN\)\. This run is not Kane CLI evidence\./);

  // The same command red and done ran, on exactly the trees the receipt names.
  const [red, green] = repo.kaneCalls().slice(calls);
  for (const call of [red, green]) assert.deepEqual(call.args, ['testmd', 'run', 'tickets/T-1_test.md', '--agent', '--headless']);
  const cart = (commit) => sha256(Buffer.from(repo.git('show', `${commit}:demo/app/cart.js`) + '\n'));
  assert.equal(red.fetched['/cart.js'].sha256, cart(receipt.red.commit));
  assert.equal(green.fetched['/cart.js'].sha256, cart(receipt.green.commit));
  assert.notEqual(red.fetched['/cart.js'].sha256, green.fetched['/cart.js'].sha256);

  // A replay writes nothing to git.
  assert.equal(repo.git('status', '--porcelain', '--', 'demo/app', 'tickets', 'receipts', '.proven/state'), '');
});

test('verify --replay: a red that Kane now passes is a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  const r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['green', 'green'] });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /^MISMATCH receipts\/T-1\.json/m);
  assert.match(lines(r.stdout, 'FAIL')[0], /^replay at red [0-9a-f]{7}: Kane passed all 2 steps, but the receipt records a failure at step 2$/);
  assert.match(r.stdout, /^Kane does not agree with this receipt\.$/m);
});

test('verify --replay: a green that Kane now fails is a MISMATCH', async (t) => {
  const repo = await greenRepo(t);
  const r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'replay-fail'] });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /^MISMATCH receipts\/T-1\.json/m);
  assert.match(lines(r.stdout, 'FAIL')[0], /^replay at green [0-9a-f]{7}: Kane failed step 2 \(Apply SAVE10\), but the receipt records a pass$/);
});

test('verify --replay: when Kane does not run, the replay is skipped and the git result stands', async (t) => {
  const repo = await greenRepo(t);
  const calls = repo.kaneCalls().length;
  let r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: 'not-started' });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^CONFIRMED receipts\/T-1\.json/m);
  assert.deepEqual(lines(r.stdout, 'skip'), [
    'replay skipped: Kane did not start (exit code 2). Kane said: Not signed in. Run kane-cli login first.',
  ]);
  assert.match(r.stdout, /^Kane did not run again, so the git checks stand\.$/m);
  assert.equal(repo.kaneCalls().length, calls + 1, 'green is not tried when red did not run');

  r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'not-started'] });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(lines(r.stdout, 'ok').at(-1).startsWith('replay at red '), true);
  assert.match(lines(r.stdout, 'skip')[0], /^replay skipped at green [0-9a-f]{7}: Kane did not start \(exit code 2\)/);
});

test('verify --replay: skipped when the git checks fail, when the port is taken, or when the test was edited', async (t) => {
  const repo = await greenRepo(t);
  const calls = repo.kaneCalls().length;

  const receipt = repo.json(RECEIPT);
  repo.write(RECEIPT, JSON.stringify({ ...receipt, title: 'Edited' }, null, 2) + '\n');
  let r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'green'] });
  assert.equal(r.code, 1);
  assert.deepEqual(lines(r.stdout, 'skip'), ['replay skipped: the git checks failed, so the commits in this receipt are not trusted']);
  repo.git('checkout', '--', RECEIPT);

  const other = createServer((req, res) => res.end('another app'));
  await new Promise((done) => other.listen(Number(new URL(repo.url).port), '127.0.0.1', done));
  r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'green'] });
  await new Promise((done) => other.close(done));
  assert.equal(r.code, 0);
  assert.match(lines(r.stdout, 'skip')[0], /^replay skipped: Port \d+ is already in use\. Stop the other server/);

  repo.write('tickets/T-1_test.md', repo.read('tickets/T-1_test.md').replace('$27.50', '$30.00'));
  r = await repo.run(['verify', RECEIPT, '--replay'], { scenario: ['red', 'green'] });
  assert.equal(r.code, 0);
  assert.match(lines(r.stdout, 'skip')[0], /^replay skipped: tickets\/T-1_test\.md here is not the frozen test\. Restore it with: git checkout [0-9a-f]{7} -- tickets\/T-1_test\.md$/);
  assert.equal(repo.kaneCalls().length, calls, 'Kane never ran');
});

test('a replay agrees only on a failure at the recorded step, or on a pass', () => {
  const red = { outcome: 'failed', failedStep: 2 };
  assert.equal(replayAgrees(red, { outcome: 'failed', failedStep: 2 }), true);
  assert.equal(replayAgrees(red, { outcome: 'failed', failedStep: 3 }), false);
  assert.equal(replayAgrees(red, { outcome: 'passed' }), false);
  assert.equal(replayAgrees(red, { outcome: 'did-not-run' }), null);
  assert.equal(replayAgrees({ outcome: 'passed' }, { outcome: 'passed' }), true);
  assert.equal(replayAgrees({ outcome: 'passed' }, { outcome: 'failed', failedStep: 2 }), false);
});
