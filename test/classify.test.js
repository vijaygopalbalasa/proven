import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRun, replayProblem } from '../src/classify.js';
import { ROOT } from './support/helpers.js';
import { SESSIONS } from './support/patterns.js';

// The fixtures are real Kane CLI 0.10.4 runs on a 2-step cart test, scrubbed.
const steps = [
  { index: 1, title: 'Open the cart' },
  { index: 2, title: 'Apply the coupon' },
];

function load(name) {
  return readFileSync(join(ROOT, 'test', 'fixtures', 'kane', `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const run = (events, exitCode, more = {}) => classifyRun({ events, exitCode, steps, timeoutS: 300, ...more });

test('a real failing run is red at step 2 with Kane\'s own words', () => {
  const v = run(load('red'), 1);
  assert.equal(v.outcome, 'failed');
  assert.equal(v.failedStep, 2);
  assert.equal(v.failedTitle, 'Apply the coupon');
  assert.equal(v.kaneOneLiner, 'The cart accepts SAVE10, but applying it leaves the total at $20.00 instead of $18.00.');
  assert.match(v.kaneReason, /total remains \$20\.00/);
  assert.equal(v.kaneVersion, '0.10.4');
  assert.equal(v.durationS, 54);
  assert.equal(v.credits, 22.45);
  assert.equal(v.evidenceId, '{{EVIDENCE_ID}}');
});

test('a real passing run passes all steps', () => {
  const v = run(load('green'), 0);
  assert.equal(v.outcome, 'passed');
  assert.equal(v.stepsPassed, 2);
  assert.equal(v.durationS, 39);
});

test('a replay failure takes its one-liner from the bug verdict', () => {
  const v = run(load('replay-fail'), 1);
  assert.equal(v.outcome, 'failed');
  assert.equal(v.failedStep, 2);
  assert.equal(v.kaneOneLiner, 'Applying SAVE10 leaves the $20.00 cart total unchanged instead of showing $18.00.');
  assert.equal(v.kaneReason, 'assertion_failed: @ step 5');
});

test('the dead-server trap (step 1 passed on an error page) is not red', () => {
  const v = run(load('env-down'), 1);
  assert.equal(v.outcome, 'did-not-run');
  assert.match(v.reason, /failed because of the environment, not the app/);
});

test('a failed landmark is not red', () => {
  const v = run(load('landmark-down'), 1);
  assert.equal(v.outcome, 'did-not-run');
  assert.match(v.reason, /could not confirm the landmark at step 1/);
});

test('exit codes 2 and 3, a missing final result and a timeout are "did not run"', () => {
  assert.match(run(load('red'), 2).reason, /did not start \(exit code 2\)/);
  assert.match(run(load('red'), 3).reason, /timed out or was cancelled/);
  assert.match(run(load('red').filter((e) => e.type !== 'test_md_done'), 1).reason, /no test_md_done/);
  assert.match(run(load('red'), null, { timedOut: true }).reason, /did not finish within 300 s/);
  assert.match(run([], null, { spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }).reason, /Kane CLI was not found/);
});

test('result, exit code and step list must agree', () => {
  assert.match(run(load('green'), 1).reason, /exit code \(1\) does not match its result \(passed\)/);
  assert.match(run(load('red'), 0).reason, /exit code \(0\) does not match its result \(failed\)/);

  const passedButStepFailed = load('green').map((e) => (e.type === 'test_md_step_end' && e.step_index === 2 ? { ...e, status: 'failed' } : e));
  assert.equal(run(passedButStepFailed, 0).outcome, 'did-not-run');

  const countsOff = load('red').map((e) => (e.type === 'test_md_summary' ? { ...e, steps: { ...e.steps, passed: 2 } } : e));
  assert.match(run(countsOff, 1).reason, /step counts do not match/);

  const otherHeading = load('red').map((e) => (e.type === 'test_md_step_start' && e.step_index === 2 ? { ...e, heading: 'Something else' } : e));
  assert.match(run(otherHeading, 1).reason, /frozen test says "Apply the coupon"/);

  const noStepEnds = load('red').filter((e) => e.type !== 'test_md_step_end');
  assert.match(run(noStepEnds, 1).reason, /no result for step 1/);

  const cancelled = load('red').map((e) => (e.type === 'test_md_summary' ? { ...e, cancelled: true } : e));
  assert.match(run(cancelled, 1).reason, /cancelled/);
});

test('a 3-step test can fail at step 2 with step 3 skipped, or at step 3', () => {
  const three = [...steps, { index: 3, title: 'Check shipping' }];
  const ev = (k) => {
    const out = [{ type: 'stream_start', cli_version: '0.10.4' }];
    for (let i = 1; i <= k; i++) {
      out.push({ type: 'test_md_step_start', step_index: i, heading: three[i - 1].title });
      out.push({ type: 'run_end', status: i === k ? 'failed' : 'passed', one_liner: `step ${i}`, reason: `r${i}`, credits_consumed: 1 });
      out.push({ type: 'test_md_step_end', step_index: i, status: i === k ? 'failed' : 'passed' });
    }
    out.push({ type: 'test_md_summary', overall_status: 'failed', steps: { total: 3, passed: k - 1, failed: 1, skipped: 3 - k } });
    out.push({ type: 'test_md_done', overall_status: 'failed', duration_s: 9 });
    return out;
  };
  const at2 = classifyRun({ events: ev(2), exitCode: 1, steps: three });
  assert.equal(at2.outcome, 'failed');
  assert.equal(at2.failedStep, 2);
  assert.equal(at2.kaneOneLiner, 'step 2');
  const at3 = classifyRun({ events: ev(3), exitCode: 1, steps: three });
  assert.equal(at3.failedStep, 3);
  assert.equal(at3.credits, 3);

  const ranAfterFailure = ev(2);
  ranAfterFailure.splice(-2, 0, { type: 'test_md_step_end', step_index: 3, status: 'passed' });
  assert.match(classifyRun({ events: ranAfterFailure, exitCode: 1, steps: three }).reason, /after the failed step/);
});

test('ids, links and absolute paths from the run are collected so they can be kept out of commits', () => {
  const values = {
    SESSION_ID: 'sid-1234567',
    SHARE_URL: 'https://tm.example/share/US_TOKEN',
    SESSION_DIR: `/opt/runner/${SESSIONS}/sid-1234567`,
    TEST_PATH: '/opt/repo/tickets/T-1_test.md',
  };
  const events = load('red').map((e) =>
    JSON.parse(JSON.stringify(e).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => values[k] ?? m)),
  );
  const v = run(events, 1);
  for (const value of Object.values(values)) assert.ok(v.exact.includes(value), value);
  assert.ok(!v.exact.includes('Open the cart'));
});

test('only a run where Kane authored every step counts: a replayed or healed step, or no summary, does not', () => {
  assert.equal(replayProblem(load('red')), null);
  assert.equal(replayProblem(load('green')), null);
  assert.equal(replayProblem(load('replay-fail')), 'Kane replayed 2 recorded steps instead of authoring every step, so this run does not count');
  assert.equal(replayProblem(load('green').filter((e) => e.type !== 'test_md_summary')), 'Kane wrote no step summary, so Proven cannot tell that it authored every step');
  const healed = load('green').map((e) => (e.type === 'test_md_summary' ? { ...e, adaptive_heal: { triggered: true } } : e));
  assert.equal(replayProblem(healed), 'Kane healed a replayed step instead of authoring every step, so this run does not count');
  const one = load('green').map((e) => (e.type === 'test_md_summary' ? { ...e, steps: { ...e.steps, replay_decisions: 1 } } : e));
  assert.match(replayProblem(one), /^Kane replayed 1 recorded step instead/);
});
