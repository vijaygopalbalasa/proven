import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { couponTicket, fixCoupon, greenRepo, makeRepo } from './support/helpers.js';
import { findCommittedLeaks } from './support/scan.js';

// Kane's recording (tickets/output-T-N/) is never committed and anyone with a shell can edit it. The fake Kane, with
// FAKE_KANE_RECORDING_PASSES, passes whenever a recording is there, the way a replay of a tampered recording would.
const TAMPERED = { FAKE_KANE_RECORDING_PASSES: '1' };

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

  const r = await repo.run(['recheck'], { scenario: ['replay-fail', 'red'], env: TAMPERED });
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
