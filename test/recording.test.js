import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { couponTicket, fixCoupon, greenRepo, makeRepo } from './support/helpers.js';
import { findCommittedLeaks } from './support/scan.js';

// Kane's recording (tickets/output-T-N/) is never committed and anyone with a shell can edit it. The fake Kane, with
// FAKE_KANE_RECORDING_PASSES, passes whenever a recording is there, the way a replay of a tampered recording would.
const TAMPERED = { FAKE_KANE_RECORDING_PASSES: '1' };

function both(r, re) {
  assert.match(r.stdout, re, `stdout: ${r.stdout}`);
  assert.match(r.stderr, re, `stderr: ${r.stderr}`);
}

function plantRecording(repo, id) {
  repo.write(`tickets/output-${id}/Result.md`, '---\nstatus: passed\n---\n\n# tampered: every step passed\n');
  repo.write(`tickets/output-${id}/.internal/meta.json`, '{"note":"tampered"}\n');
}

function recordingAsPlanted(repo, id) {
  return repo.read(`tickets/output-${id}/Result.md`).includes('# tampered') && repo.read(`tickets/output-${id}/.internal/meta.json`) === '{"note":"tampered"}\n';
}

test('no Kane run trusts the local recording: Kane never sees it, and it is put back as it was', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  plantRecording(repo, 'T-1');

  // Red: a tampered recording cannot make the test look as if it already passes.
  let r = await repo.run(['red', 'T-1'], { scenario: 'red', env: TAMPERED });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(repo.json('.proven/state/T-1.json').status, 'red');

  // Done: a tampered recording cannot pass a ticket whose app is still broken.
  r = await repo.run(['done', 'T-1'], { scenario: 'red', env: TAMPERED });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(repo.exists('receipts/T-1.json'), false);
  fixCoupon(repo);
  r = await repo.run(['done', 'T-1'], { scenario: 'green', env: TAMPERED });
  assert.equal(r.code, 0, r.stdout + r.stderr);

  // verify --replay: the red side cannot pass on a recording either.
  r = await repo.run(['verify', 'receipts/T-1.json', '--replay'], { scenario: ['red', 'green'], env: TAMPERED });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /replay at red [0-9a-f]{7}: Kane failed step 2 \(Apply SAVE10\), as the receipt records/);

  for (const call of repo.kaneCalls()) assert.equal(call.recording_before, false, `Kane saw the recording on a ${call.scenario} run`);
  assert.ok(recordingAsPlanted(repo, 'T-1'), 'the recording is back as it was');
  assert.equal(repo.git('status', '--porcelain', '--', 'tickets'), '', 'the recording is ignored and nothing else changed');
  assert.deepEqual(findCommittedLeaks(repo.dir, { calls: repo.kaneCalls() }), []);
});

test('recheck cannot be told "still passes" by a tampered recording', async (t) => {
  const repo = await greenRepo(t);
  repo.write('demo/app/cart.js', repo.read('demo/app/cart.js').replace('const coupons = { save10: 10 };', 'const coupons = { fall15: 15 };'));
  repo.git('commit', '-q', '-am', 'Take the codes from the autumn campaign');
  plantRecording(repo, 'T-1');
  const calls = repo.kaneCalls().length;

  const r = await repo.run(['recheck'], { scenario: ['red', 'red'], env: TAMPERED });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^T-1 reopened at [0-9a-f]{7}/m);
  const runs = repo.kaneCalls().slice(calls);
  assert.equal(runs.length, 2);
  for (const call of runs) assert.equal(call.recording_before, false);
  assert.ok(recordingAsPlanted(repo, 'T-1'));
});

test('a run with no recording before leaves none behind', async (t) => {
  const repo = await greenRepo(t);
  assert.equal(repo.exists('tickets/output-T-1'), false);
  assert.equal(readFileSync(join(repo.dir, '.gitignore'), 'utf8').includes('tickets/output-*/'), true);
});

test('a recording planted while Kane starts cannot decide a verdict: every run makes Kane author every step', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const PLANTED = { FAKE_KANE_PLANTED_MIDRUN: '1' };

  let r = await repo.run(['red', 'T-1'], { scenario: 'red', env: PLANTED });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(repo.json('.proven/state/T-1.json').status, 'red');
  r = await repo.run(['done', 'T-1'], { scenario: 'red', env: PLANTED });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(repo.exists('receipts/T-1.json'), false);
  fixCoupon(repo);
  assert.equal((await repo.run(['done', 'T-1'], { scenario: 'green', env: PLANTED })).code, 0);
  r = await repo.run(['verify', 'receipts/T-1.json', '--replay'], { scenario: ['red', 'green'], env: PLANTED });
  assert.equal(r.code, 0, r.stdout);

  for (const call of repo.kaneCalls()) {
    assert.ok(call.extra_args.includes('--author'), `a ${call.scenario} run without --author`);
    assert.equal(call.planted, true);
    assert.equal(call.replayed, false);
  }
  assert.equal(repo.exists('tickets/output-T-1'), false, 'what was planted during the run is gone too');
});

test('a run whose events show a replay does not count, whatever Kane concluded', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const REPLAYS = { FAKE_KANE_REPLAYS: '1' };

  let r = await repo.run(['red', 'T-1'], { scenario: 'red', env: REPLAYS });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /^did not run: Kane replayed 2 recorded steps instead of authoring every step, so this run does not count$/m);
  assert.equal(repo.exists('.proven/state/T-1.json'), false);

  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);
  fixCoupon(repo);
  r = await repo.run(['done', 'T-1'], { scenario: 'green', env: REPLAYS });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  both(r, /did not run: Kane replayed 2 recorded steps instead of authoring every step, so this run does not count/);
  both(r, /No attempt was counted\./);
  assert.equal(repo.exists('receipts/T-1.json'), false);
  assert.equal(repo.json('.proven/state/T-1.json').attempts, 0);

  assert.equal((await repo.run(['done', 'T-1'], { scenario: 'green' })).code, 0);
  r = await repo.run(['recheck'], { scenario: 'green', env: REPLAYS });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stdout, /^T-1: Kane did not run: Kane replayed 2 recorded steps instead of authoring every step, so this run does not count\. Nothing changed\.$/m);
  r = await repo.run(['verify', 'receipts/T-1.json', '--replay'], { scenario: ['red', 'green'], env: REPLAYS });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stdout, /^CONFIRMED \(git checks only\) /m);
  assert.match(r.stdout, /^ {2}skip {2}replay skipped: Kane replayed 2 recorded steps instead of authoring every step, so this run does not count$/m);
});

test('a run that leaves files in the output folder from before it started does not count', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);
  fixCoupon(repo);
  const r = await repo.run(['done', 'T-1'], { scenario: 'green', env: { FAKE_KANE_STALE_FILE: '1' } });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  both(r, /did not run: tickets\/output-T-1\/ holds a file Kane did not write in this run \(planted\.txt\), so this run does not count/);
  assert.equal(repo.exists('receipts/T-1.json'), false);
  assert.equal(repo.exists('tickets/output-T-1'), false);
});
