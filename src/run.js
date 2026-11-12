import { cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Files under .proven/runs/ are local only. They are written only where git ignores that folder.
function runsFile(root, id, name) {
  const rel = `.proven/runs/${id}/${name}`;
  return isIgnored(root, rel) ? rel : null;
}

function saveRaw(root, id, label, raw) {
  const rel = runsFile(root, id, `${label}.ndjson`);
  if (!rel) return null;
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw);
  return rel;
}

// While Kane runs, .proven/runs/T-N/active.json says so, for the board. It is removed when the run ends.
function markActive(root, id, label) {
  const rel = runsFile(root, id, 'active.json');
  if (!rel) return () => {};
  const file = join(root, rel);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ label, pid: process.pid, started_at: new Date().toISOString() }) + '\n');
  } catch {
    return () => {};
  }
  return () => rmSync(file, { force: true });
}

// Kane replays the steps it recorded in tickets/output-T-N/, next to the test. That folder is never committed and
// anyone with a shell can edit it, so it must never decide a verdict. For every run Proven moves it out of the
// repository, so Kane authors every step from the frozen test, and afterwards puts it back exactly as it was (or
// removes the one Kane wrote, if there was none). Kane's output from the run stays in .proven/runs/ and .testmuai/.
export function recordingDir(id) {
  return `tickets/output-${id}`;
}

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function setRecordingAside(root, id) {
  const dir = join(root, recordingDir(id));
  let aside = null;
  if (present(dir)) {
    aside = mkdtempSync(join(tmpdir(), 'proven-recording-'));
    cpSync(dir, join(aside, 'recording'), { recursive: true, verbatimSymlinks: true });
    rmSync(dir, { recursive: true, force: true });
  }
  return () => {
    rmSync(dir, { recursive: true, force: true });
    if (aside) {
      cpSync(join(aside, 'recording'), dir, { recursive: true, verbatimSymlinks: true });
      rmSync(aside, { recursive: true, force: true });
    }
  };
}

const notRun = (reason) => ({ outcome: 'did-not-run', reason, exact: [] });

export function announceKane(out, kane) {
  if (kane.fake) out.both(`Kane: ${kane.label}. This run is not Kane CLI evidence.`);
}

// Serve a git tree of the app on the start URL's port, check it answers, run Kane on the frozen test with any extra
// Kane flags, and classify Kane's events. Proven never judges the app itself.
// `what` names the app for the progress line, for example "demo/app" or "the app at red 0c82fa0".
export async function runKaneOnTree(ctx, { id, label, steps, startUrl, kane, tree, timeoutS, extraArgs = [], what }) {
  const { root, out } = ctx;
  const p = ticketPaths(id);
  let served;
  try {
    served = await serveTree(root, tree, startUrl);
  } catch (err) {
    if (err instanceof Refusal) return notRun(err.message);
    throw err;
  }
  const clearActive = markActive(root, id, label);
  try {
    const before = await probe(startUrl);
    if (!before.ok) return notRun(`the app is not answering at ${startUrl} (${before.detail})`);

    const headBefore = head(root);
    out.progress(`Serving ${what} as tree ${short(tree)} at ${startUrl}`);
    const flags = extraArgs.length ? ` with ${extraArgs.join(' ')}` : '';
    out.progress(`Running Kane on ${p.test} (${steps.length} steps)${flags}. This takes about a minute.`);
    const putBack = setRecordingAside(root, id);
    let result;
    try {
      result = await runKane({
        command: kane.command,
        args: ['testmd', 'run', p.test, '--agent', '--headless', ...extraArgs],
        cwd: root,
        timeoutMs: timeoutS * 1000,
        onEvent: (e) => {
          if (e.type === 'test_md_step_end') {
            const title = steps[e.step_index - 1]?.title ?? '';
            const secs = e.duration_s != null ? ` (${e.duration_s} s)` : '';
            out.progress(`  step ${e.step_index} ${title}: ${e.status}${secs}`);
          }
        },
      });
    } finally {
      putBack();
    }
    saveRaw(root, id, label, result.raw);

    const verdict = classifyRun({ ...result, steps, timeoutS, command: kane.command });
    verdict.headBefore = headBefore;
    verdict.appTree = tree;
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
    clearActive();
    await served.close();
  }
}

// Kane judges a snapshot, never the live folder: Proven writes the app folder as a git tree (what a commit would
// hold), serves that tree itself on the start URL's port for the whole run, and classifies Kane's events.
// The tree id comes back as appTree; done commits exactly that tree as G.
export async function runFrozenTest(ctx, { id, label, steps, startUrl, kane }) {
  const { root, config, out } = ctx;
  announceKane(out, kane);
  const links = symlinkRefusal(root, config.app);
  if (links) return notRun(links);
  const ignored = ignoredFiles(root, config.app);
  if (ignored.length) {
    out.progress(`Note: Kane will not see ${ignored.length} ${ignored.length === 1 ? 'file' : 'files'} that git ignores in ${config.app}: ${list(ignored)}`);
  }
  const appTree = snapshotApp(root, config.app);
  if (!appTree) return notRun(`${config.app} holds no files`);
  return runKaneOnTree(ctx, { id, label, steps, startUrl, kane, tree: appTree, timeoutS: config.timeoutS, what: config.app });
}

// Kane's words, made safe to store.
export function kaneWords(verdict) {
  const opts = { exact: verdict.exact };
  return { oneLiner: scrubText(verdict.kaneOneLiner ?? '', opts), reason: scrubText(verdict.kaneReason ?? '', opts) };
}
