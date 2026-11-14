import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kaneCommand } from './config.js';
import { fileAt, short } from './git.js';
import { sha256 } from './hash.js';
import { announceKane, kaneWords, runKaneOnTree } from './run.js';
import { parseTestSteps, startUrlOf, ticketPaths } from './ticket.js';

// Does a replay agree with what the receipt records? Red must fail at the recorded step; green must pass.
export function replayAgrees(expected, verdict) {
  if (verdict.outcome === 'did-not-run') return null;
  if (expected.outcome === 'passed') return verdict.outcome === 'passed';
  return verdict.outcome === 'failed' && verdict.failedStep === expected.failedStep;
}

function describe(side, commit, expected, verdict) {
  const at = `replay at ${side} ${short(commit)}`;
  const failedText = (v) => `Kane failed step ${v.failedStep} (${v.failedTitle})`;
  if (verdict.outcome === 'passed') {
    const text = `Kane passed all ${verdict.stepsTotal} steps`;
    return expected.outcome === 'passed'
      ? `${at}: ${text}, as the receipt records`
      : `${at}: ${text}, but the receipt records a failure at step ${expected.failedStep}`;
  }
  if (expected.outcome === 'passed') return `${at}: ${failedText(verdict)}, but the receipt records a pass`;
  return verdict.failedStep === expected.failedStep
    ? `${at}: ${failedText(verdict)}, as the receipt records`
    : `${at}: ${failedText(verdict)}, but the receipt records step ${expected.failedStep}`;
}

// Requirement 4.3: serve the app as it was at the red commit and run Kane on the frozen test (it must fail at the
// recorded step), then serve the app as it was at the green commit (it must pass). Like every Proven run, each side
// runs with Kane's local recording moved aside, so Kane authors every step again from the frozen test: neither a
// recording nor a moved button decides the verdict, a fresh clone behaves the same, and no heal cycle runs into the
// time limit.
// Returns { lines: [{ status: 'ok'|'fail'|'skip', text, more? }], agreed }.
// agreed is true (both sides agree), false (a side disagrees) or null (Kane did not run: the git checks stand).
export async function replayReceipt(ctx, receipt) {
  const { root, out } = ctx;
  const id = receipt.ticket;
  const p = ticketPaths(id);
  const skip = (reason) => ({ lines: [{ status: 'skip', text: `replay skipped: ${reason}` }], agreed: null, note: `The replay did not start (${String(reason).replace(/\.+$/, '')}), so only the git checks ran.` });

  const frozen = fileAt(root, receipt.frozen.commit, p.test);
  if (!frozen || sha256(frozen) !== receipt.frozen.test_sha256) return skip(`the frozen test is not in ${short(receipt.frozen.commit)}`);
  const here = existsSync(join(root, p.test)) ? readFileSync(join(root, p.test)) : null;
  if (!here || !here.equals(frozen)) {
    return skip(`${p.test} here is not the frozen test. Restore it with: git checkout ${short(receipt.frozen.commit)} -- ${p.test}`);
  }
  const steps = parseTestSteps(frozen.toString('utf8'));
  const startUrl = startUrlOf(steps);
  if (!startUrl || startUrl !== receipt.settings.start_url) return skip('the frozen test does not open the start URL the receipt pins');
  const timeoutS = Number(receipt.settings.timeout_s);
  if (!(timeoutS > 0)) return skip('the receipt pins no time limit');

  const kane = kaneCommand();
  announceKane(out, kane);
  out.say('Replay runs Kane twice (red, then green), so it costs about twice a red run.');
  // A replay is two runs and decides no ticket's state, so it gets twice the limit pinned at freeze. Red, done and recheck
  // keep the pinned limit.
  const replayLimit = timeoutS * 2;
  out.say(`Replay limit ${replayLimit} s (twice the ${timeoutS} s pinned at freeze)`);
  const lines = [];
  const sides = [
    { side: 'red', commit: receipt.red.commit, tree: receipt.red.app_tree, expected: { outcome: 'failed', failedStep: receipt.red.failed_step } },
    { side: 'green', commit: receipt.green.commit, tree: receipt.green.app_tree, expected: { outcome: 'passed' } },
  ];
  let agreed = true;
  for (const s of sides) {
    out.progress(`Replaying ${p.test} with the app as it was at ${s.side} ${short(s.commit)}.`);
    const verdict = await runKaneOnTree(ctx, {
      id,
      label: `replay-${s.side}`,
      steps,
      startUrl,
      kane,
      tree: s.tree,
      timeoutS: replayLimit,
      what: `the app at ${s.side} ${short(s.commit)}`,
    });
    const agrees = replayAgrees(s.expected, verdict);
    if (agrees === null) {
      const why = verdict.hint ? `${verdict.reason}. Kane said: ${verdict.hint}` : verdict.reason;
      const plain = (x) => String(x).replace(/\.+$/, '');
      if (s.side === 'red') {
        // Without a red replay there is nothing to compare green against, so the replay stops there. Say what Kane did.
        const failedAtRecorded = verdict.timedOut && (verdict.stepEnds ?? []).some(([i, st]) => i === receipt.red.failed_step && st === 'failed');
        const note = failedAtRecorded
          ? `Kane failed step ${receipt.red.failed_step} at red, as the receipt records, but ran past the replay limit of ${replayLimit} s, so the green run was not started.`
          : verdict.timedOut
            ? `Kane ran past the replay limit of ${replayLimit} s at red before the test finished${(verdict.stepEnds ?? []).length ? '' : ' (it had not finished any step)'}, so the replay did not complete and green was not started.`
            : `Kane did not run at red: ${plain(why)}.`;
        return { lines: [...lines, { status: 'skip', text: `replay skipped: ${why}` }], agreed: null, note };
      }
      lines.push({ status: 'skip', text: `replay skipped at green ${short(s.commit)}: ${why}` });
      const redLine = `Kane failed step ${receipt.red.failed_step} at red, as the receipt records`;
      const note = verdict.timedOut
        ? `${redLine}, but ran past the replay limit of ${replayLimit} s at green without finishing, so green was not confirmed.`
        : `${redLine}, but the green run did not complete (${plain(why)}), so green was not confirmed.`;
      return { lines, agreed: agreed ? null : false, note };
    }
    const words = verdict.outcome === 'failed' ? kaneWords(verdict) : null;
    lines.push({
      status: agrees ? 'ok' : 'fail',
      text: describe(s.side, s.commit, s.expected, verdict),
      more: words?.oneLiner ? `Kane says: ${words.oneLiner}` : null,
    });
    if (!agrees) agreed = false;
  }
  return { lines, agreed };
}
