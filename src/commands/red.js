import { kaneCommand } from '../config.js';
import { Refusal } from '../errors.js';
import { assertOnlyPaths, commitPaths, dirtyPaths, head, objectAt, short } from '../git.js';
import { checkFrozenTest } from '../lock.js';
import { kaneWords, runFrozenTest } from '../run.js';
import { loadState, lockChain, statusOf, writeState } from '../state.js';
import { checkId, ticketPaths } from '../ticket.js';

// proven red T-N: prove the frozen test fails on the code as it is, with the landmark step passing and a later step failing.
export async function cmdRed(ctx, [id]) {
  const { root, config, out } = ctx;
  checkId(id);
  const p = ticketPaths(id);
  const kane = kaneCommand();
  const { lock, steps, startUrl } = checkFrozenTest(root, id, config);
  const state = loadState(root, id);
  const status = statusOf(state, lock);
  if (status === 'red' || status === 'in-progress') throw new Refusal(`${id} is already red at ${short(state.red?.commit)}.`);
  if (status === 'reopened') {
    throw new Refusal(`${id} was reopened by proven recheck at ${short(state.red?.commit)}, so it is red again. The agent fixes the app and runs proven done ${id}.`);
  }
  if (status === 'already-passes') {
    throw new Refusal(`${id} already passes: this test proves nothing yet. A person sharpens the criteria and runs proven freeze ${id} again.`);
  }
  if (status === 'needs-a-person') throw new Refusal(`${id} needs a person. Change the ticket and run proven freeze ${id} again.`);
  if (status === 'done') throw new Refusal(`${id} is done.`);

  // Red sits on the very commit that locked the test, so the code Kane fails is the code that was frozen.
  const L = lockChain(root, id, lock);
  if (head(root) !== L) {
    throw new Refusal(
      `${id} must go red on the commit that locked its test (${short(L)}), but HEAD has moved since. Run proven freeze ${id} again, then proven red ${id} right after it.`,
    );
  }

  const dirty = dirtyPaths(root, config.app);
  if (dirty.length) {
    throw new Refusal(
      `${config.app} has uncommitted changes, so a red commit would not hold the code Kane judged. Commit or stash them first: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}`,
    );
  }

  const run = await runFrozenTest(ctx, { id, label: 'red', steps, startUrl, kane });

  if (run.outcome === 'did-not-run') {
    out.warn(`did not run: ${run.reason}`);
    if (run.hint) out.warn(`Kane said: ${run.hint}`);
    out.warn('Nothing was recorded.');
    return 2;
  }

  if (run.appTree !== objectAt(root, run.headBefore, config.app)) {
    out.warn(`did not run: the snapshot of ${config.app} does not match the commit ${short(run.headBefore)}.`);
    out.warn('Nothing was recorded.');
    return 2;
  }

  const at = new Date().toISOString();
  if (run.outcome === 'passed') {
    writeState(
      root,
      id,
      {
        ticket: id,
        frozen_commit: lock.frozen_commit,
        status: 'already-passes',
        checked_commit: run.headBefore,
        app_tree: run.appTree,
        kane: kane.label,
        kane_cli: run.kaneVersion,
        duration_s: run.durationS,
        credits: run.credits,
        evidence_sha256: run.evidenceSha256,
        at,
      },
      { exact: run.exact },
    );
    const c = commitPaths(root, { paths: [p.state], message: `${id}: already passes at ${short(run.headBefore)}` });
    assertOnlyPaths(root, c.commit, [p.state]);
    out.say(`${id} already passes: this test proves nothing yet.`);
    out.say(`Kane passed all ${run.stepsTotal} steps on ${short(run.headBefore)}. A person sharpens the criteria and runs proven freeze ${id} again.`);
    return 1;
  }

  const words = kaneWords(run);
  const red = {
    commit: run.headBefore,
    failed_step: run.failedStep,
    failed_step_title: run.failedTitle,
    kane_one_liner: words.oneLiner,
    kane_reason: words.reason,
    duration_s: run.durationS,
    credits: run.credits,
    evidence_sha256: run.evidenceSha256,
    kane: kane.label,
    kane_cli: run.kaneVersion,
    app_tree: run.appTree,
    at,
  };
  writeState(root, id, { ticket: id, frozen_commit: lock.frozen_commit, status: 'red', attempts: 0, red }, { exact: run.exact });
  const c = commitPaths(root, {
    paths: [p.state],
    message: `${id}: red at ${short(run.headBefore)}, step ${run.failedStep} failed`,
  });
  assertOnlyPaths(root, c.commit, [p.state]);

  out.say(`${id} is red at ${short(run.headBefore)}. Kane failed step ${run.failedStep} (${run.failedTitle}).`);
  if (words.oneLiner) out.say(`Kane says: ${words.oneLiner}`);
  if (words.reason) out.say(`Reason: ${words.reason}`);
  if (!run.evidenceSha256) out.warn("Note: Kane's evidence pack was not found, so no evidence hash was recorded.");
  out.say(`Recorded in ${p.state}. The agent can start. It runs proven done ${id} when it thinks the ticket is done.`);
  return 0;
}
