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
// recorded step), then serve the app as it was at the green commit (it must pass). Each side is one fresh run with
// --author, so Kane authors every step again from the frozen test: neither a local recording nor a moved button
// decides the verdict, a fresh clone behaves the same, and no heal cycle runs into the time limit.
// Returns { lines: [{ status: 'ok'|'fail'|'skip', text, more? }], agreed }.
// agreed is true (both sides agree), false (a side disagrees) or null (Kane did not run: the git checks stand).
export async function replayReceipt(ctx, receipt) {
  const { root, out } = ctx;
  const id = receipt.ticket;
  const p = ticketPaths(id);
  const skip = (reason) => ({ lines: [{ status: 'skip', text: `replay skipped: ${reason}` }], agreed: null });

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
      timeoutS,
      extraArgs: ['--author'],
      what: `the app at ${s.side} ${short(s.commit)}`,
    });
    const agrees = replayAgrees(s.expected, verdict);
    if (agrees === null) {
      const why = verdict.hint ? `${verdict.reason}. Kane said: ${verdict.hint}` : verdict.reason;
      // Without a red replay there is nothing to compare green against, so the replay stops there.
      if (s.side === 'red') return { lines: [...lines, { status: 'skip', text: `replay skipped: ${why}` }], agreed: null };
      lines.push({ status: 'skip', text: `replay skipped at green ${short(s.commit)}: ${why}` });
      return { lines, agreed: agreed ? null : false };
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
