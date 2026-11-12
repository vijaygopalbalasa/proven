import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256 } from '../src/hash.js';
import { couponTicket, fixCoupon, makeRepo } from './support/helpers.js';
import { findCommittedLeaks } from './support/scan.js';

const STATE = '.proven/state/T-1.json';
const RECEIPT = 'receipts/T-1.json';

function both(r, re) {
  assert.match(r.stdout, re, `stdout: ${r.stdout}`);
  assert.match(r.stderr, re, `stderr: ${r.stderr}`);
}

test('the gate: freeze, red, a failed attempt, did-not-run cases, green, receipt, verify', async (t) => {
  const repo = await makeRepo(t);

  // Requirement 1.1 and 1.3: the skeleton, then refusals that name what is missing.
  let r = await repo.run(['new', 'T-1', 'Coupon SAVE10 takes 10% off']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(repo.read('tickets/T-1.md'), /^# T-1: Coupon SAVE10 takes 10% off\n\nStart URL: \nLandmark: \n\n## Acceptance criteria\n/);
  r = await repo.run(['new', 'T-1', 'Again']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already exists/);
  const startHead = repo.head();
  r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /tickets\/T-1\.md is missing: a start URL, a landmark, acceptance criteria\./);
  assert.equal(repo.head(), startHead);

  // Requirement 1.2: F holds exactly the ticket and the test; the lock follows alone and names F.
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 0, r.stderr);
  const lock = repo.json('tickets/T-1.lock.json');
  const lockCommit = repo.head();
  assert.deepEqual(repo.changed(lockCommit), ['tickets/T-1.lock.json']);
  assert.equal(repo.git('rev-parse', 'HEAD~1'), lock.frozen_commit);
  assert.deepEqual(repo.changed(lock.frozen_commit), ['tickets/T-1.md', 'tickets/T-1_test.md']);
  assert.equal(lock.test_sha256, sha256(readFileSync(join(repo.dir, 'tickets/T-1_test.md'))));
  assert.equal(lock.ticket_sha256, sha256(readFileSync(join(repo.dir, 'tickets/T-1.md'))));
  assert.deepEqual(lock.settings, { app: 'demo/app', timeout_s: 60, max_attempts: 4, start_url: repo.url });
  assert.equal(lock.settings_sha256, sha256(canonicalJson(lock.settings)));
  const testText = repo.read('tickets/T-1_test.md');
  assert.match(testText, new RegExp(`## Open the start page\nOpen ${repo.url}\nVerify the text "Your cart" is shown on the page\\.\n\n## Apply SAVE10\n`));
  r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /already frozen/);
  assert.equal(repo.head(), lockCommit);

  // Requirement 2.1: red refuses a dirty app folder, before Kane runs.
  repo.write('demo/app/cart.js', repo.read('demo/app/cart.js') + '\n');
  r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /demo\/app has uncommitted changes/);
  repo.git('checkout', '--', 'demo/app/cart.js');
  repo.write('demo/app/extra.js', 'new file');
  r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /demo\/app\/extra\.js/);
  rmSync(join(repo.dir, 'demo/app/extra.js'));
  assert.equal(repo.kaneCalls().length, 0);

  // Requirement 2.5: anything but a clean red is "did not run" and records nothing.
  for (const [scenario, why] of [
    ['landmark-down', /could not confirm the landmark at step 1/],
    ['env-down', /failed because of the environment, not the app/],
    ['no-done', /no test_md_done/],
    ['exit-3', /timed out or was cancelled/],
    ['not-started', /did not start \(exit code 2\)/],
    ['exit-mismatch', /exit code \(1\) does not match its result \(passed\)/],
  ]) {
    r = await repo.run(['red', 'T-1'], { scenario });
    assert.equal(r.code, 2, `${scenario}: ${r.stderr}`);
    assert.match(r.stderr, /^did not run: /m, scenario);
    assert.match(r.stderr, why, scenario);
    assert.match(r.stderr, /Nothing was recorded\./);
    assert.equal(repo.exists(STATE), false, scenario);
    assert.equal(repo.head(), lockCommit, scenario);
  }
  r = await repo.run(['red', 'T-1'], { scenario: 'not-started' });
  assert.match(r.stderr, /Kane said: Not signed in\. Run kane-cli login first\./);

  // Requirement 2.3: a real red records HEAD, the step, Kane's words, duration, credits and the evidence hash.
  r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`T-1 is red at ${lockCommit.slice(0, 7)}\\. Kane failed step 2 \\(Apply SAVE10\\)\\.`));
  both(r, /^Kane: fake \(PROVEN_KANE_BIN\)\. This run is not Kane CLI evidence\.$/m);
  const redCall = repo.kaneCalls().at(-1);
  assert.deepEqual(redCall.args, ['testmd', 'run', 'tickets/T-1_test.md', '--agent', '--headless']);
  let state = repo.json(STATE);
  assert.equal(state.status, 'red');
  assert.equal(state.frozen_commit, lock.frozen_commit);
  assert.equal(state.red.commit, lockCommit);
  assert.equal(state.red.failed_step, 2);
  assert.equal(state.red.failed_step_title, 'Apply SAVE10');
  assert.equal(state.red.kane_one_liner, 'The cart accepts SAVE10, but applying it leaves the total at $20.00 instead of $18.00.');
  assert.match(state.red.kane_reason, /total remains \$20\.00/);
  assert.equal(state.red.duration_s, 54);
  assert.equal(state.red.credits, 22.45);
  assert.equal(state.red.kane_cli, '0.10.4');
  assert.equal(state.red.kane, 'fake (PROVEN_KANE_BIN)');
  assert.equal(state.red.evidence_sha256, sha256(readFileSync(join(repo.dir, '.testmuai/evidence', `${redCall.evidence_id}.evidence`))));
  assert.deepEqual(repo.changed('HEAD'), [STATE]);
  assert.equal(repo.git('rev-parse', 'HEAD~1'), lockCommit);
  r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already red/);

  // Requirement 3.2: a failure tells the agent what Kane saw, on stdout and stderr, and counts one attempt.
  r = await repo.run(['done', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 1, r.stderr);
  both(r, /T-1 is not done\. Kane failed step 2 \(Apply SAVE10\)\./);
  both(r, /Kane says: The cart accepts SAVE10, but applying it leaves the total at \$20\.00 instead of \$18\.00\./);
  both(r, /Reason: SAVE10 was entered and Apply clicked/);
  both(r, /Screenshot: tests\/T-1-0a1b2c3d\/steps\/6-1-5\/screenshot\.jpg in \.testmuai\/evidence\/[0-9a-f-]+\.evidence/);
  both(r, /Screenshot copy: \.proven\/runs\/T-1\/attempt-1-step-2\.jpg/);
  both(r, /Attempt 1 of 4\./);
  both(r, /^Fix the app, not the test\.$/m);
  assert.deepEqual([...readFileSync(join(repo.dir, '.proven/runs/T-1/attempt-1-step-2.jpg')).subarray(0, 2)], [0xff, 0xd8]);
  state = repo.json(STATE);
  assert.equal(state.attempts, 1);
  assert.equal(state.status, 'in-progress');
  assert.equal(state.last_failure.failed_step, 2);
  assert.deepEqual(repo.changed('HEAD'), [STATE]);

  // A replayed failure is an attempt too.
  r = await repo.run(['done', 'T-1'], { scenario: 'replay-fail' });
  assert.equal(r.code, 1);
  both(r, /Kane says: Applying SAVE10 leaves the \$20\.00 cart total unchanged/);
  both(r, /Attempt 2 of 4\./);

  // Requirement 3.3: did not run counts no attempt.
  for (const scenario of ['not-started', 'env-down', 'landmark-down']) {
    r = await repo.run(['done', 'T-1'], { scenario });
    assert.equal(r.code, 2, scenario);
    both(r, /did not run: /);
    both(r, /No attempt was counted\./);
  }
  assert.equal(repo.json(STATE).attempts, 2);

  // Requirement 1.4: an edited test is refused before Kane runs.
  const calls = repo.kaneCalls().length;
  repo.write('tickets/T-1_test.md', testText.replace('$27.50', '$30.00'));
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /tickets\/T-1_test\.md changed after it was frozen/);
  assert.match(r.stderr, /Fix the app, not the test\./);
  assert.equal(repo.kaneCalls().length, calls);
  repo.git('checkout', '--', 'tickets/T-1_test.md');

  // The agent fixes the app.
  fixCoupon(repo);

  // Requirement 3.4: green commits G (the app as judged), then the receipt with Kane's recording.
  const beforeGreen = repo.head();
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 0, r.stderr);
  const receipt = repo.json(RECEIPT);
  const G = receipt.green.commit;
  both(r, new RegExp(`^Done: red ${lockCommit.slice(0, 7)}, green ${G.slice(0, 7)}\\.$`, 'm'));
  assert.equal(repo.git('rev-parse', 'HEAD~1'), G);
  assert.equal(repo.git('rev-parse', `${G}~1`), beforeGreen);
  assert.deepEqual(repo.changed(G), ['demo/app/cart.js']);
  const receiptFiles = repo.changed('HEAD');
  assert.ok(receiptFiles.includes(RECEIPT) && receiptFiles.includes(STATE) && receiptFiles.includes('tickets/output-T-1/Result.md'));
  assert.ok(receiptFiles.every((p) => p === RECEIPT || p === STATE || p.startsWith('tickets/output-T-1/')), receiptFiles.join(' '));
  assert.equal(repo.git('status', '--porcelain', '--', 'demo/app', 'tickets', 'receipts', '.proven/state'), '');
  assert.equal(repo.git('ls-files', '.testmuai'), '');

  // Requirement 4.1: what the receipt holds. A receipt made with the fake Kane says so in both runs.
  assert.equal(receipt.ticket, 'T-1');
  assert.equal(receipt.title, 'Coupon SAVE10 takes 10% off');
  assert.deepEqual(receipt.settings, lock.settings);
  assert.equal(receipt.red.kane, 'fake (PROVEN_KANE_BIN)');
  assert.equal(receipt.green.kane, 'fake (PROVEN_KANE_BIN)');
  assert.deepEqual(receipt.frozen, {
    commit: lock.frozen_commit,
    test: 'tickets/T-1_test.md',
    test_sha256: lock.test_sha256,
    ticket: 'tickets/T-1.md',
    ticket_sha256: lock.ticket_sha256,
  });
  assert.equal(receipt.red.commit, lockCommit);
  assert.equal(receipt.red.failed_step, 2);
  assert.equal(receipt.red.kane_cli, '0.10.4');
  assert.equal(receipt.red.app_tree, repo.git('rev-parse', `${lockCommit}:demo/app`));
  assert.equal(receipt.green.app_tree, repo.git('rev-parse', `${G}:demo/app`));
  assert.notEqual(receipt.red.app_tree, receipt.green.app_tree);
  assert.equal(receipt.green.steps_passed, 2);
  assert.equal(receipt.green.steps_total, 2);
  assert.equal(receipt.green.failed_attempts, 2);
  assert.equal(receipt.green.kane_cli, '0.10.4');
  assert.match(receipt.green.evidence_sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.recording.path, 'tickets/output-T-1');
  assert.match(receipt.receipt_sha256, /^[0-9a-f]{64}$/);
  assert.equal(repo.json(STATE).status, 'done');

  r = await repo.run(['done', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 0);
  both(r, /already done/);

  // Requirement 4.2: anyone can re-check it with git alone.
  r = await repo.run(['verify', RECEIPT]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^CONFIRMED receipts\/T-1\.json, but made with a fake Kane, not Kane CLI$/m);
  assert.match(r.stdout, /^ {2}note {2}red ran on fake \(PROVEN_KANE_BIN\), green ran on fake \(PROVEN_KANE_BIN\)$/m);
  assert.equal((r.stdout.match(/^ {2}ok /gm) ?? []).length, 10, r.stdout);
  assert.doesNotMatch(r.stdout, /FAIL/);
  r = await repo.run(['verify', RECEIPT, '--replay']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not built yet/);

  // Requirements 2.6 and 3.5: nothing private was ever committed, and the real Kane CLI was never called.
  assert.deepEqual(findCommittedLeaks(repo.dir, { calls: repo.kaneCalls() }), []);
  assert.equal(repo.realKaneCalled(), false);
});

test('red says the app is not answering, and records nothing, when the start page is missing', async (t) => {
  const repo = await makeRepo(t);
  const url = new URL('checkout.html', repo.url).href;
  repo.write('tickets/T-1.md', couponTicket(url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, new RegExp(`did not run: the app is not answering at ${url.replace(/[.]/g, '\\.')} \\(HTTP 404\\)`));
  assert.match(r.stderr, /Nothing was recorded\./);
  assert.equal(repo.kaneCalls().length, 0);
  assert.equal(repo.exists(STATE), false);
});

test('red refuses when another server holds the start URL\'s port', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const other = createServer((req, res) => res.end('another app'));
  await new Promise((done) => other.listen(Number(new URL(repo.url).port), '127.0.0.1', done));
  t.after(() => new Promise((done) => other.close(done)));
  const r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, new RegExp(`Port ${new URL(repo.url).port} is already in use\\. Stop the other server`));
  assert.equal(repo.kaneCalls().length, 0);
  assert.equal(repo.exists(STATE), false);
});

test('four failed attempts move the ticket to "needs a person"', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);
  for (let i = 1; i <= 4; i++) {
    const r = await repo.run(['done', 'T-1'], { scenario: 'red' });
    assert.equal(r.code, 1);
    both(r, new RegExp(`Attempt ${i} of 4\\.`));
  }
  const last = repo.json(STATE);
  assert.equal(last.status, 'needs-a-person');
  assert.equal(last.attempts, 4);
  assert.match(repo.git('log', '-1', '--format=%s'), /needs a person after 4 failed attempts/);
  const calls = repo.kaneCalls().length;
  const r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs a person after 4 failed attempts/);
  assert.equal(repo.kaneCalls().length, calls);
});

test('a test that already passes at red blocks the ticket until a person freezes it again', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  let r = await repo.run(['red', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /T-1 already passes: this test proves nothing yet\./);
  assert.equal(repo.json(STATE).status, 'already-passes');
  assert.deepEqual(repo.changed('HEAD'), [STATE]);

  r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already passes/);
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already passes/);
  r = await repo.run(['freeze', 'T-1']);
  assert.match(r.stdout, /already frozen/);
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 2);

  repo.write(
    'tickets/T-1.md',
    couponTicket(repo.url, { criteria: '### Apply SAVE10 in capitals\nType SAVE10 in the coupon field and click Apply.\nVerify the order total shows $27.50.' }),
  );
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(repo.json(STATE).status, 'red');
  r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /would move the goalposts/);
});

test('Proven stops a hung Kane and its child processes at its own time limit', async (t) => {
  const repo = await makeRepo(t, { timeoutS: 1 });
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const pidFile = join(repo.dir, '.git', 'grandchild.pid');
  const started = Date.now();
  const r = await repo.run(['red', 'T-1'], { scenario: 'hang', env: { FAKE_KANE_PIDFILE: pidFile } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /did not run: Kane did not finish within 1 s/);
  assert.ok(Date.now() - started < 15000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((done) => setTimeout(done, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the child of the hung Kane is still running');
  assert.equal(repo.exists(STATE), false);
});

test("Kane's words are stored without links, paths or emails", async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const r = await repo.run(['red', 'T-1'], { scenario: 'red-leaky' });
  assert.equal(r.code, 0, r.stderr);
  const state = repo.json(STATE);
  assert.match(state.red.kane_one_liner, /Details: <hidden>$/);
  assert.match(state.red.kane_reason, /\(log at <hidden>, signed in as <email>\)$/);
  assert.deepEqual(findCommittedLeaks(repo.dir, { calls: repo.kaneCalls() }), []);
});

test('freeze commits exactly the ticket and the test even when other work is staged', async (t) => {
  const repo = await makeRepo(t);
  repo.write('notes.txt', 'staged, not part of the freeze');
  repo.git('add', 'notes.txt');
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const lock = repo.json('tickets/T-1.lock.json');
  assert.deepEqual(repo.changed(lock.frozen_commit), ['tickets/T-1.md', 'tickets/T-1_test.md']);
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'notes.txt');
  assert.equal(existsSync(join(repo.dir, 'notes.txt')), true);
});
