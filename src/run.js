import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyRun } from './classify.js';
import { Refusal } from './errors.js';
import { fileSha256, findPack } from './evidence.js';
import { head, ignoredFiles, isIgnored, short, worktreeFiles } from './git.js';
import { runKane } from './kane.js';
import { scrubText } from './leak.js';
import { probe } from './probe.js';
import { serveTree, snapshotApp } from './snapshot.js';
import { ticketPaths } from './ticket.js';

function list(paths) {
  return paths.slice(0, 5).join(', ') + (paths.length > 5 ? ', ...' : '');
}

// Symlinks are refused for clarity: a snapshot holds a link's text, not the file it points to.
export function symlinkRefusal(root, app) {
  const links = worktreeFiles(root, app).filter((p) => lstatSync(join(root, p)).isSymbolicLink());
  return links.length ? `${app} holds a symlink: ${list(links)}. Replace it with the real file, so Kane sees what gets committed.` : null;
}

function saveRaw(root, id, label, raw) {
  const rel = `.proven/runs/${id}/${label}.ndjson`;
  if (!isIgnored(root, rel)) return null;
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw);
  return rel;
}

const notRun = (reason) => ({ outcome: 'did-not-run', reason, exact: [] });

// Kane judges a snapshot, never the live folder: Proven writes the app folder as a git tree (what a commit would
// hold), serves that tree itself on the start URL's port for the whole run, and classifies Kane's events.
// The tree id comes back as appTree; done commits exactly that tree as G.
export async function runFrozenTest(ctx, { id, label, steps, startUrl, kane }) {
  const { root, config, out } = ctx;
  const p = ticketPaths(id);

  if (kane.fake) out.both(`Kane: ${kane.label}. This run is not Kane CLI evidence.`);
  const links = symlinkRefusal(root, config.app);
  if (links) return notRun(links);
  const ignored = ignoredFiles(root, config.app);
  if (ignored.length) {
    out.progress(`Note: Kane will not see ${ignored.length} ${ignored.length === 1 ? 'file' : 'files'} that git ignores in ${config.app}: ${list(ignored)}`);
  }
  const appTree = snapshotApp(root, config.app);
  if (!appTree) return notRun(`${config.app} holds no files`);

  let served;
  try {
    served = await serveTree(root, appTree, startUrl);
  } catch (err) {
    if (err instanceof Refusal) return notRun(err.message);
    throw err;
  }
  try {
    const before = await probe(startUrl);
    if (!before.ok) return notRun(`the app is not answering at ${startUrl} (${before.detail})`);

    const headBefore = head(root);
    out.progress(`Serving ${config.app} as tree ${short(appTree)} at ${startUrl}`);
    out.progress(`Running Kane on ${p.test} (${steps.length} steps). This takes about a minute.`);
    const result = await runKane({
      command: kane.command,
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

    const verdict = classifyRun({ ...result, steps, timeoutS: config.timeoutS, command: kane.command });
    verdict.headBefore = headBefore;
    verdict.appTree = appTree;
    if (verdict.outcome === 'did-not-run' && (result.exitCode === 2 || result.spawnError)) {
      const last = result.stderr.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
      if (last) verdict.hint = scrubText(last, { exact: verdict.exact }).slice(0, 240);
    }
    if (verdict.outcome !== 'did-not-run' && head(root) !== headBefore) {
      Object.assign(verdict, { outcome: 'did-not-run', reason: 'a commit was made while Kane ran' });
    }
    if (verdict.reason) verdict.reason = scrubText(verdict.reason, { exact: verdict.exact });
    const pack = findPack(root, p.test, verdict);
    verdict.packFile = pack;
    verdict.evidenceSha256 = pack ? fileSha256(pack) : null;
    return verdict;
  } finally {
    await served.close();
  }
}

// Kane's words, made safe to store.
export function kaneWords(verdict) {
  const opts = { exact: verdict.exact };
  return { oneLiner: scrubText(verdict.kaneOneLiner ?? '', opts), reason: scrubText(verdict.kaneReason ?? '', opts) };
}
