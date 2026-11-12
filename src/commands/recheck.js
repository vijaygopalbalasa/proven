import { kaneCommand } from '../config.js';
import { Refusal } from '../errors.js';
import { assertOnlyPaths, commitPaths, dirtyPaths, head, objectAt, short } from '../git.js';
import { checkFrozenTest, readLock } from '../lock.js';
import { receiptCommitAtHead, verifyReceipt } from '../receipt.js';
import { announceKane, kaneWords, runKaneOnTree, symlinkRefusal } from '../run.js';
import { checkRedRecord, loadState, statusOf, writeState } from '../state.js';
import { checkId, ticketIds, ticketPaths } from '../ticket.js';

const LABELS = {
  new: 'not frozen',
  frozen: 'frozen, no red yet',
  red: 'red',
  'in-progress': 'in progress',
  reopened: 'reopened',
  'needs-a-person': 'needs a person',
  'already-passes': 'already passes',
};

// Everything done checks before it trusts a ticket, plus a receipt that verifies. Returns the frozen test, or throws
// a Refusal that says why the ticket is not rechecked.
function trustedDone(root, id, config, lock, state) {
  const p = ticketPaths(id);
  const frozen = checkFrozenTest(root, id, config);
  checkRedRecord(root, id, state, lock);
  const at = receiptCommitAtHead(root, id);
  if (!at) throw new Refusal(`${p.receipt} is not committed as Proven wrote it.`);
  const failed = verifyReceipt(root, at.bytes).checks.filter((c) => !c.ok);
  if (failed.length) throw new Refusal(`its receipt does not verify (${failed[0].name}: ${failed[0].detail}). Run proven verify ${p.receipt}.`);
  return { ...frozen, receiptAt: at };
}

// Why Kane did not run, with Kane's own last words when it gave any, as one sentence without its final period.
function whyNotRun(run) {
  const trim = (x) => String(x).trim().replace(/\.+$/, '');
  return run.hint ? `${trim(run.reason)}. Kane said: ${trim(run.hint)}` : trim(run.reason);
}

function failureRecord(run, words) {
  return {
    failed_step: run.failedStep,
    failed_step_title: run.failedTitle,
    kane_one_liner: words.oneLiner,
    kane_reason: words.reason,
    duration_s: run.durationS,
    credits: run.credits,
    evidence_sha256: run.evidenceSha256,
  };
}

// Requirement 5: run one done ticket's frozen test with the app as committed at HEAD, with --no-adaptive-heal. Like
// every Proven run, Kane's local recording is moved aside, so Kane authors every step fresh and an edited recording
// cannot say "still passes". A failure is confirmed by a second fresh run, and only a confirmed failure reopens it.
async function recheckOne(ctx, { id, lock, state }, kane) {
  const { root, config, out } = ctx;
  const p = ticketPaths(id);
  let trusted;
  try {
    trusted = trustedDone(root, id, config, lock, state);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    out.both(`${id}: not rechecked: ${err.message}`);
    return 'not-run';
  }
  const { steps, startUrl, receiptAt } = trusted;
  const H = head(root);
  const tree = objectAt(root, H, config.app);
  if (!tree) {
    out.both(`${id}: not rechecked: ${config.app} is not in ${short(H)}.`);
    return 'not-run';
  }
  const run = (label, extraArgs) =>
    runKaneOnTree(ctx, { id, label, steps, startUrl, kane, tree, timeoutS: config.timeoutS, extraArgs, what: `${config.app} at ${short(H)}` });

  out.progress(`${id}: running ${p.test} fresh on ${short(H)}.`);
  const replay = await run('recheck-replay', ['--no-adaptive-heal']);
  if (replay.outcome === 'passed') {
    out.both(`${id} still passes: Kane ran its frozen test fresh on ${short(H)}.`);
    return 'passed';
  }
  if (replay.outcome === 'did-not-run') {
    out.both(`${id}: Kane did not run: ${whyNotRun(replay)}. Nothing changed.`);
    return 'not-run';
  }
  const replayWords = kaneWords(replay);
  out.both(`${id}: Kane failed step ${replay.failedStep} (${replay.failedTitle}). Confirming with a second fresh run before anything changes.`);

  const confirm = await run('recheck-confirm', []);
  if (confirm.outcome === 'did-not-run') {
    out.both(`${id}: the second run did not run: ${whyNotRun(confirm)}. Nothing changed. Run proven recheck again.`);
    return 'not-run';
  }
  if (confirm.outcome === 'passed') {
    out.both(`${id} stays done: the first run failed, but the second passed every step, so Kane does not confirm a break.`);
    return 'passed';
  }
  if (confirm.headBefore !== H || head(root) !== H) {
    out.both(`${id}: not reopened: a commit was made during the recheck. Nothing changed. Run proven recheck again.`);
    return 'not-run';
  }

  // Confirmed: the ticket reopens, red again on the commit Kane just judged, in a state commit of its own.
  const words = kaneWords(confirm);
  const earlier = JSON.parse(receiptAt.bytes.toString('utf8'));
  const at = new Date().toISOString();
  writeState(
    root,
    id,
    {
      ticket: id,
      frozen_commit: lock.frozen_commit,
      status: 'reopened',
      attempts: 0,
      red: {
        commit: H,
        failed_step: confirm.failedStep,
        failed_step_title: confirm.failedTitle,
        kane_one_liner: words.oneLiner,
        kane_reason: words.reason,
        duration_s: confirm.durationS,
        credits: confirm.credits,
        evidence_sha256: confirm.evidenceSha256,
        kane: kane.label,
        kane_cli: confirm.kaneVersion,
        app_tree: tree,
        at,
      },
      reopened: {
        by: 'proven recheck',
        first_run: failureRecord(replay, replayWords),
        previous: {
          receipt: p.receipt,
          commit: receiptAt.commit,
          receipt_sha256: earlier.receipt_sha256,
          green_commit: earlier.green.commit,
        },
      },
    },
    { exact: [...replay.exact, ...confirm.exact] },
  );
  const c = commitPaths(root, { paths: [p.state], message: `${id}: reopened at ${short(H)}, step ${confirm.failedStep} failed` });
  assertOnlyPaths(root, c.commit, [p.state]);
  const lines = [
    `${id} reopened at ${short(H)}: Kane failed step ${confirm.failedStep} (${confirm.failedTitle}) on the second run too.`,
    `Kane says: ${words.oneLiner || '(no one-line summary)'}`,
    `Reason: ${words.reason || '(no reason given)'}`,
    `The agent fixes the app and runs proven done ${id}. Fix the app, not the test.`,
  ];
  out.both(lines.join('\n'));
  return 'reopened';
}

// proven recheck [T-N ...]: replay every done ticket's frozen test against the app as committed now, and reopen a
// ticket whose failure a fresh run confirms. Exit 0 all still pass, 1 a ticket reopened, 2 something did not run.
export async function cmdRecheck(ctx, ids) {
  const { root, config, out } = ctx;
  ids.forEach(checkId);
  const done = [];
  const others = [];
  for (const id of ids.length ? ids : ticketIds(root)) {
    let lock;
    let state;
    try {
      lock = readLock(root, id);
      state = loadState(root, id);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      out.both(`${id}: not rechecked: ${err.message}`);
      others.push(id);
      continue;
    }
    const status = statusOf(state, lock);
    if (status === 'done') done.push({ id, lock, state });
    else others.push(`${id} (${LABELS[status] ?? status})`);
  }
  if (!done.length) {
    out.both(`No done tickets to recheck.${others.length ? ` Not done: ${others.join(', ')}.` : ''}`);
    return 0;
  }

  // Recheck judges the app as committed at HEAD, so a reopen names exactly the code Kane judged.
  const dirty = dirtyPaths(root, config.app);
  if (dirty.length) {
    throw new Refusal(
      `${config.app} has uncommitted changes, so a reopen would not name the code Kane judged. Commit or stash them first: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}`,
    );
  }
  const links = symlinkRefusal(root, config.app);
  if (links) throw new Refusal(links);

  const kane = kaneCommand();
  announceKane(out, kane);
  const names = done.map((t) => t.id).join(', ');
  out.both(`Rechecking ${done.length} done ${done.length === 1 ? 'ticket' : 'tickets'} (${names}) against ${config.app} at ${short(head(root))}.`);
  const results = [];
  for (const t of done) results.push(await recheckOne(ctx, t, kane));

  // A caller that runs recheck in-process (proven loop) can read each ticket's own result.
  if (ctx.recheckResults) done.forEach((t, i) => ctx.recheckResults.set(t.id, results[i]));
  const reopened = done.filter((t, i) => results[i] === 'reopened').map((t) => t.id);
  const notRun = results.filter((r) => r === 'not-run').length;
  if (reopened.length) out.both(`Reopened: ${reopened.join(', ')}.`);
  else if (!notRun) out.both('Every done ticket still passes.');
  return reopened.length ? 1 : notRun ? 2 : 0;
}
