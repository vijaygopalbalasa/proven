import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyRun } from './classify.js';
import { fileSha256, findPack } from './evidence.js';
import { head, isIgnored, worktreeFiles } from './git.js';
import { hashEntries } from './hash.js';
import { runKane } from './kane.js';
import { scrubText } from './leak.js';
import { probe } from './probe.js';
import { ticketPaths } from './ticket.js';

// Everything git would commit from the app folder, as one hash.
export function appFingerprint(root, app) {
  return hashEntries(worktreeFiles(root, app).map((p) => ({ path: p, content: readFileSync(join(root, p)) })));
}

function saveRaw(root, id, label, raw) {
  const rel = `.proven/runs/${id}/${label}.ndjson`;
  if (!isIgnored(root, rel)) return null;
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw);
  return rel;
}

// Probe the app, run Kane on the frozen test, probe again, and classify.
export async function runFrozenTest(ctx, { id, label, steps, startUrl }) {
  const { root, config, out } = ctx;
  const p = ticketPaths(id);

  const before = await probe(startUrl);
  if (!before.ok) {
    return { outcome: 'did-not-run', reason: `the app is not answering at ${startUrl} (${before.detail})`, exact: [] };
  }

  const headBefore = head(root);
  const appBefore = appFingerprint(root, config.app);
  if (!config.kaneIsDefault) out.progress(`Using Kane command from .proven/config.json: ${config.kane.join(' ')}`);
  out.progress(`Running Kane on ${p.test} (${steps.length} steps). This takes about a minute.`);

  const result = await runKane({
    command: config.kane,
    args: ['testmd', 'run', p.test, '--agent', '--headless'],
    cwd: root,
    timeoutMs: config.timeoutS * 1000,
    onEvent: (e) => {
      if (e.type === 'test_md_step_end') {
        const title = steps[e.step_index - 1]?.title ?? '';
        const secs = e.duration_s != null ? ` (${e.duration_s} s)` : '';
        out.progress(`  step ${e.step_index} ${title}: ${e.status}${secs}`);
      }
    },
  });
  saveRaw(root, id, label, result.raw);

  const verdict = classifyRun({ ...result, steps, timeoutS: config.timeoutS, command: config.kane });
  verdict.headBefore = headBefore;

  if (verdict.outcome === 'did-not-run' && (result.exitCode === 2 || result.spawnError)) {
    const last = result.stderr.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
    if (last) verdict.hint = scrubText(last, { exact: verdict.exact }).slice(0, 240);
  }

  if (verdict.outcome !== 'did-not-run') {
    const after = await probe(startUrl);
    if (!after.ok) Object.assign(verdict, { outcome: 'did-not-run', reason: `the app stopped answering at ${startUrl} during the run (${after.detail})` });
    else if (head(root) !== headBefore) Object.assign(verdict, { outcome: 'did-not-run', reason: 'a commit was made while Kane ran' });
    else if (appFingerprint(root, config.app) !== appBefore) {
      Object.assign(verdict, { outcome: 'did-not-run', reason: `${config.app} changed while Kane ran, so Kane's verdict is not about the code as it is now` });
    }
  }

  if (verdict.reason) verdict.reason = scrubText(verdict.reason, { exact: verdict.exact });
  const pack = findPack(root, p.test, verdict);
  verdict.packFile = pack;
  verdict.evidenceSha256 = pack ? fileSha256(pack) : null;
  return verdict;
}

// Kane's words, made safe to store.
export function kaneWords(verdict) {
  const opts = { exact: verdict.exact };
  return { oneLiner: scrubText(verdict.kaneOneLiner ?? '', opts), reason: scrubText(verdict.kaneReason ?? '', opts) };
}
