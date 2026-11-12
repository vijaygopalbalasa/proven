import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kaneCommand } from '../config.js';
import { Refusal } from '../errors.js';
import { displayPath, failingScreenshot, saveScreenshot } from '../evidence.js';
import {
  assertOnlyPaths,
  commitPaths,
  commitsTouching,
  fileAt,
  head,
  isAncestor,
  isIgnored,
  objectAt,
  resolveCommit,
  short,
} from '../git.js';
import { hashEntries, sha256 } from '../hash.js';
import { findLeaks } from '../leak.js';
import { checkFrozenTest } from '../lock.js';
import { RECORDING_EXCLUDES, recordingAt, recordingFromWorktree, sealReceipt } from '../receipt.js';
import { appFingerprint, appHashAt, appRefusal, kaneWords, runFrozenTest } from '../run.js';
import { checkAttemptHistory, checkRedRecord, loadState, statusOf, writeJson, writeState } from '../state.js';
import { checkId, parseTicket, ticketPaths } from '../ticket.js';

function screenshotLine(root, id, label, run) {
  if (!run.packFile) return 'Screenshot: Kane\'s evidence pack was not found.';
  try {
    const shot = failingScreenshot(run.packFile, run.failedStep);
    if (!shot) return `Screenshot: none for step ${run.failedStep} in ${displayPath(root, run.packFile)}`;
    let line = `Screenshot: ${shot.inner} in ${displayPath(root, run.packFile)}`;
    if (isIgnored(root, `.proven/runs/${id}/x`)) line += `\nScreenshot copy: ${saveScreenshot(root, id, label, run.failedStep, shot)}`;
    return line;
  } catch (err) {
    return `Screenshot: could not read the evidence pack (${err.message})`;
  }
}

// Kane writes its recording; Proven commits it byte for byte, so it must not carry private data.
function recordingLeaks(files, exact) {
  const kinds = new Set();
  const paths = exact.filter((v) => v.includes('/'));
  for (const f of files) {
    if (f.content.subarray(0, 8192).includes(0)) continue;
    for (const leak of findLeaks(f.content.toString('utf8'), { exact: paths })) kinds.add(leak.kind);
  }
  return [...kinds];
}

// proven done T-N: the agent says the ticket is done; Kane decides.
export async function cmdDone(ctx, [id]) {
  const { root, config, out } = ctx;
  checkId(id);
  const p = ticketPaths(id);
  const kane = kaneCommand();
  const { lock, steps, startUrl, settings } = checkFrozenTest(root, id, config);
  const state = loadState(root, id);
  const status = statusOf(state, lock);

  if (status === 'done') {
    out.both(`${id} is already done: red ${short(state.red?.commit)}, green ${short(state.green?.commit)}.`);
    return 0;
  }
  if (status === 'frozen') throw new Refusal(`${id} has no red yet. A person runs proven red ${id} first.`);
  if (status === 'already-passes') throw new Refusal(`${id} already passes on its frozen test, so it proves nothing. A person sharpens the ticket.`);
  if (status === 'needs-a-person') {
    throw new Refusal(`${id} needs a person after ${state.attempts} failed attempts. Stop and leave it for a person.`);
  }
  if (status !== 'red' && status !== 'in-progress') throw new Refusal(`${p.state} has an unknown status "${status}".`);

  checkRedRecord(root, id, state);
  const redKane = state.red.kane;
  if (redKane !== kane.label) {
    throw new Refusal(`${id} went red on ${redKane}, but this run would use ${kane.label}. Red and green must run on the same Kane.`);
  }
  const redCommit = resolveCommit(root, state.red?.commit);
  if (!redCommit) throw new Refusal(`The red commit ${short(state.red?.commit)} is not in this repository.`);
  checkAttemptHistory(root, id, state);
  const lockNow = readFileSync(join(root, p.lock));
  const lockAtRed = fileAt(root, redCommit, p.lock);
  if (!lockAtRed || !lockAtRed.equals(lockNow)) throw new Refusal(`${p.lock} changed after red. Not running.`);
  if (!isAncestor(root, redCommit, 'HEAD')) {
    throw new Refusal(`The red commit ${short(redCommit)} is not an ancestor of HEAD. Do not rewrite history while working on ${id}.`);
  }
  const touched = commitsTouching(root, redCommit, 'HEAD', p.test);
  if (touched.length) {
    throw new Refusal(
      `${p.test} was changed after red in ${touched.length} commit(s), first ${short(touched.at(-1))}. The test must stay as frozen. Fix the app, not the test.`,
    );
  }

  const attempt = state.attempts + 1;
  const run = await runFrozenTest(ctx, { id, label: `attempt-${attempt}`, steps, startUrl, kane });

  if (run.outcome === 'did-not-run') {
    const lines = [`did not run: ${run.reason}`];
    if (run.hint) lines.push(`Kane said: ${run.hint}`);
    lines.push(`No attempt was counted. Run proven done ${id} again once this is fixed.`);
    out.both(lines.join('\n'));
    return 2;
  }

  const at = new Date().toISOString();
  if (run.outcome === 'failed') {
    const words = kaneWords(run);
    const needsPerson = attempt >= config.maxAttempts;
    const next = {
      ...state,
      status: needsPerson ? 'needs-a-person' : 'in-progress',
      attempts: attempt,
      last_failure: {
        attempt,
        failed_step: run.failedStep,
        failed_step_title: run.failedTitle,
        kane_one_liner: words.oneLiner,
        kane_reason: words.reason,
        evidence_sha256: run.evidenceSha256,
        kane: kane.label,
        at,
      },
    };
    writeState(root, id, next, { exact: run.exact });
    const c = commitPaths(root, {
      paths: [p.state],
      message: needsPerson ? `${id}: needs a person after ${attempt} failed attempts` : `${id}: attempt ${attempt} failed at step ${run.failedStep}`,
    });
    assertOnlyPaths(root, c.commit, [p.state]);

    const lines = [
      `${id} is not done. Kane failed step ${run.failedStep} (${run.failedTitle}).`,
      `Kane says: ${words.oneLiner || '(no one-line summary)'}`,
      `Reason: ${words.reason || '(no reason given)'}`,
      screenshotLine(root, id, `attempt-${attempt}`, run),
      `Attempt ${attempt} of ${config.maxAttempts}.${needsPerson ? ` ${id} now needs a person.` : ''}`,
      'Fix the app, not the test.',
    ];
    out.both(lines.join('\n'));
    return 1;
  }

  // Kane passed. Every check runs before anything is committed.
  if (!isAncestor(root, redCommit, 'HEAD')) throw new Refusal(`The red commit ${short(redCommit)} is not an ancestor of HEAD.`);
  if (sha256(readFileSync(join(root, p.test))) !== lock.test_sha256) throw new Refusal(`${p.test} is not byte-identical to its lock.`);
  const unsafe = appRefusal(root, config.app);
  if (unsafe || appFingerprint(root, config.app) !== run.appJudged) {
    out.both(`did not run: ${unsafe ?? `${config.app} changed after Kane ran`}\nNo attempt was counted.`);
    return 2;
  }
  if (run.appJudged === appHashAt(root, redCommit, config.app)) {
    out.both(
      `did not run: Kane passed, but ${config.app} is the same as at red ${short(redCommit)}. A pass on unchanged code proves nothing, so ${id} stays open.\nNo attempt was counted.`,
    );
    return 2;
  }
  const recordingFiles = recordingFromWorktree(root, p.recording);
  if (!recordingFiles.length) {
    out.both(`did not run: Kane's recording ${p.recording}/ is missing, so there is nothing to replay later.\nNo attempt was counted.`);
    return 2;
  }
  const leaks = recordingLeaks(recordingFiles, run.exact);
  if (leaks.length) {
    throw new Refusal(`Kane's recording ${p.recording}/ holds ${leaks.join(', ')}. Not committing it. ${id} stays open.`);
  }
  const frozenTicket = fileAt(root, lock.frozen_commit, p.ticket);
  const ticket = parseTicket(frozenTicket ? frozenTicket.toString('utf8') : '', id);

  // G: the app folder exactly as Kane judged it.
  const g = commitPaths(root, { paths: [config.app], message: `${id}: app change that Kane passed` });
  if (g.created) assertOnlyPaths(root, g.commit, [config.app]);
  const G = g.commit;
  if (appHashAt(root, G, config.app) !== run.appJudged) {
    throw new Error(`${config.app} at ${short(G)} is not the code Kane judged`);
  }
  if (objectAt(root, G, config.app) === objectAt(root, redCommit, config.app)) {
    throw new Error(`${config.app} at green ${short(G)} is the same as at red ${short(redCommit)}`);
  }

  const red = state.red;
  const receipt = sealReceipt({
    receipt: 1,
    ticket: id,
    title: ticket.title,
    settings,
    frozen: {
      commit: lock.frozen_commit,
      test: p.test,
      test_sha256: lock.test_sha256,
      ticket: p.ticket,
      ticket_sha256: lock.ticket_sha256,
    },
    red: {
      commit: redCommit,
      failed_step: red.failed_step,
      failed_step_title: red.failed_step_title,
      kane_one_liner: red.kane_one_liner,
      kane_reason: red.kane_reason,
      evidence_sha256: red.evidence_sha256,
      kane: red.kane,
      kane_cli: red.kane_cli,
      duration_s: red.duration_s,
      credits: red.credits,
    },
    green: {
      commit: G,
      steps_passed: run.stepsPassed,
      steps_total: run.stepsTotal,
      evidence_sha256: run.evidenceSha256,
      kane: kane.label,
      kane_cli: run.kaneVersion,
      duration_s: run.durationS,
      credits: run.credits,
      failed_attempts: state.attempts,
    },
    recording: { path: p.recording, sha256: hashEntries(recordingFiles) },
  });
  writeJson(root, p.receipt, receipt, { exact: run.exact });
  writeState(
    root,
    id,
    {
      ...state,
      status: 'done',
      green: { commit: G, steps_passed: run.stepsPassed, evidence_sha256: run.evidenceSha256, kane: kane.label, kane_cli: run.kaneVersion, at },
      receipt: p.receipt,
    },
    { exact: run.exact },
  );

  const r = commitPaths(root, {
    paths: [p.receipt, p.recording, p.state],
    excludes: RECORDING_EXCLUDES(p.recording),
    message: `${id}: receipt, red ${short(redCommit)}, green ${short(G)}`,
  });
  assertOnlyPaths(root, r.commit, [p.receipt, p.recording, p.state]);
  if (hashEntries(recordingAt(root, r.commit, p.recording)) !== receipt.recording.sha256) {
    throw new Error(`the committed recording does not match the receipt (commit ${short(r.commit)})`);
  }
  if (head(root) !== r.commit || !existsSync(join(root, p.receipt))) throw new Error('the receipt commit is not HEAD');

  out.both(`Done: red ${short(redCommit)}, green ${short(G)}.`);
  return 0;
}
