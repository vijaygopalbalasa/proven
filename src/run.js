import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyRun } from './classify.js';
import { fileSha256, findPack } from './evidence.js';
import { blob, commitFiles, head, ignoredFiles, isIgnored, worktreeFiles } from './git.js';
import { hashTree } from './hash.js';
import { runKane } from './kane.js';
import { scrubText } from './leak.js';
import { probe } from './probe.js';
import { ticketPaths } from './ticket.js';

// The app folder as git would commit it from the working tree: mode, content (link text for a symlink), path.
export function appFingerprint(root, app) {
  return hashTree(
    worktreeFiles(root, app).map((p) => {
      const full = join(root, p);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) return { path: p, mode: '120000', content: Buffer.from(readlinkSync(full)) };
      return { path: p, mode: st.mode & 0o100 ? '100755' : '100644', content: readFileSync(full) };
    }),
  );
}

// The app folder as committed, hashed the same way.
export function appHashAt(root, commit, app) {
  return hashTree(commitFiles(root, commit, app).map((f) => ({ path: f.path, mode: f.mode, content: blob(root, f.blob) })));
}

// What the server could show Kane that no commit would hold: ignored files and symlinks.
export function appProblems(root, app) {
  const ignored = ignoredFiles(root, app);
  const symlinks = worktreeFiles(root, app).filter((p) => lstatSync(join(root, p)).isSymbolicLink());
  return { ignored, symlinks };
}

function list(paths) {
  return paths.slice(0, 5).join(', ') + (paths.length > 5 ? ', ...' : '');
}

export function appRefusal(root, app) {
  const { ignored, symlinks } = appProblems(root, app);
  if (ignored.length) {
    return `${app} holds files that git ignores: ${list(ignored)}. The server could show them to Kane, but no commit would keep them. Remove them, or stop ignoring them.`;
  }
  if (symlinks.length) {
    return `${app} holds a symlink: ${list(symlinks)}. Replace it with the real file, so the commit holds what Kane sees.`;
  }
  return null;
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
// `kane` comes from kaneCommand(): kane-cli from PATH, or the test-only fake, which is always announced.
export async function runFrozenTest(ctx, { id, label, steps, startUrl, kane }) {
  const { root, config, out } = ctx;
  const p = ticketPaths(id);

  if (kane.fake) out.both(`Kane: ${kane.label}. This run is not Kane CLI evidence.`);
  const unsafe = appRefusal(root, config.app);
  if (unsafe) return { outcome: 'did-not-run', reason: unsafe, exact: [] };
  const before = await probe(startUrl);
  if (!before.ok) {
    return { outcome: 'did-not-run', reason: `the app is not answering at ${startUrl} (${before.detail})`, exact: [] };
  }

  const headBefore = head(root);
  const appBefore = appFingerprint(root, config.app);
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
  verdict.appJudged = appBefore;

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
    } else {
      const unsafeAfter = appRefusal(root, config.app);
      if (unsafeAfter) Object.assign(verdict, { outcome: 'did-not-run', reason: unsafeAfter });
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
