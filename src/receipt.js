import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  blob,
  changedPaths,
  commitFiles,
  commitsChangingFile,
  commitsTouching,
  commitsTouchingOldestFirst,
  fileAt,
  isAncestor,
  lastCommitTouching,
  objectAt,
  parentOf,
  resolveCommit,
  short,
  worktreeFiles,
} from './git.js';
import { canonicalJson, hashEntries, sha256 } from './hash.js';
import { settingsSha } from './lock.js';
import { RED_FIELDS } from './state.js';
import { ID_RE, ticketPaths } from './ticket.js';

export function receiptHash(receipt) {
  const { receipt_sha256: _ignored, ...rest } = receipt;
  return sha256(canonicalJson(rest));
}

export function sealReceipt(body) {
  return { ...body, receipt_sha256: receiptHash(body) };
}

// Kane's recording folder, without any evidence packs, as [{ path (inside the folder), content }].
function isEvidence(rest) {
  return rest === 'evidence' || rest.startsWith('evidence/') || rest.endsWith('.evidence');
}

export function recordingFromWorktree(root, dir) {
  return worktreeFiles(root, dir)
    .map((p) => ({ full: p, rest: p.slice(dir.length + 1) }))
    .filter((f) => !isEvidence(f.rest))
    .map((f) => ({ path: f.rest, content: readFileSync(join(root, f.full)) }));
}

export function recordingAt(root, commit, dir) {
  return commitFiles(root, commit, dir)
    .map((f) => ({ ...f, rest: f.path.slice(dir.length + 1) }))
    .filter((f) => !isEvidence(f.rest))
    .map((f) => ({ path: f.rest, content: blob(root, f.blob) }));
}

export const RECORDING_EXCLUDES = (dir) => [`${dir}/evidence`, `${dir}/evidence/**`, `${dir}/**/*.evidence`];

function check(name, fn) {
  try {
    const detail = fn();
    return detail === true ? { name, ok: true } : { name, ok: false, detail: detail || 'failed' };
  } catch (err) {
    return { name, ok: false, detail: err.message };
  }
}

function need(root, sha, what) {
  const full = resolveCommit(root, sha);
  if (!full) throw new Error(`${what} ${short(sha)} is not in this repository`);
  return full;
}

// Requirement 4.2: re-check a receipt with git only. Paths come from the ticket id, never from the receipt.
// Returns { receipt, checks: [{ name, ok, detail }] }.
export function verifyReceipt(root, bytes) {
  let r;
  try {
    r = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { receipt: null, checks: [{ name: 'the receipt is valid JSON', ok: false, detail: 'it is not' }] };
  }
  if (!r || typeof r !== 'object' || !r.frozen || !r.red || !r.green || !r.recording || !r.settings) {
    return { receipt: null, checks: [{ name: 'the receipt has settings, frozen, red, green and recording parts', ok: false, detail: 'some are missing' }] };
  }
  if (typeof r.ticket !== 'string' || !ID_RE.test(r.ticket)) {
    return { receipt: null, checks: [{ name: 'the receipt names a ticket like T-1', ok: false, detail: `it names "${r.ticket}"` }] };
  }
  const p = ticketPaths(r.ticket);
  const app = r.settings.app;
  const commits = () => ({
    F: need(root, r.frozen.commit, 'frozen commit'),
    red: need(root, r.red.commit, 'red commit'),
    green: need(root, r.green.commit, 'green commit'),
  });

  const checks = [
    check(`the receipt's paths match ticket ${r.ticket}`, () => {
      const wrong = [
        ['frozen.test', r.frozen.test, p.test],
        ['frozen.ticket', r.frozen.ticket, p.ticket],
        ['recording.path', r.recording.path, p.recording],
      ].filter(([, got, want]) => got !== want);
      return !wrong.length || wrong.map(([k, got, want]) => `${k} is ${got}, not ${want}`).join('; ');
    }),
    check('the receipt hash matches its contents', () => receiptHash(r) === r.receipt_sha256 || 'the contents were changed after the receipt was written'),
    check('the test and ticket at the frozen commit match the receipt', () => {
      const { F } = commits();
      const t = fileAt(root, F, p.test);
      if (!t) return `${p.test} is not in ${short(F)}`;
      if (sha256(t) !== r.frozen.test_sha256) return `${p.test} at ${short(F)} has a different sha256`;
      const k = fileAt(root, F, p.ticket);
      if (!k || sha256(k) !== r.frozen.ticket_sha256) return `${p.ticket} at ${short(F)} has a different sha256`;
      return true;
    }),
    check('the lock, in its own commit after the frozen commit, names it and pins these settings', () => {
      const { F, red } = commits();
      const buf = fileAt(root, red, p.lock);
      if (!buf) return `${p.lock} is not in red ${short(red)}`;
      const lock = JSON.parse(buf.toString('utf8'));
      if (resolveCommit(root, lock.frozen_commit) !== F) return `the lock names ${short(lock.frozen_commit)}, not ${short(F)}`;
      if (lock.test_sha256 !== r.frozen.test_sha256 || lock.ticket_sha256 !== r.frozen.ticket_sha256) return 'the lock pins other test or ticket hashes';
      const want = settingsSha(r.settings);
      if (lock.settings_sha256 !== want || !lock.settings || settingsSha(lock.settings) !== want) return 'the lock pins other settings';
      const L = lastCommitTouching(root, red, p.lock);
      if (!L || L === F || !isAncestor(root, F, L)) return `the lock was not committed after ${short(F)}`;
      const changed = changedPaths(root, L);
      return (changed.length === 1 && changed[0] === p.lock) || `the lock commit ${short(L)} holds other files too`;
    }),
    check('the test was frozen before red', () => {
      const { F, red } = commits();
      return isAncestor(root, F, red) || `${short(F)} is not an ancestor of red ${short(red)}`;
    }),
    check('red is an ancestor of green', () => {
      const { red, green } = commits();
      return isAncestor(root, red, green) || `red ${short(red)} is not an ancestor of green ${short(green)}`;
    }),
    check('the frozen test did not change between red and green', () => {
      const { red, green } = commits();
      for (const [label, c] of [['red', red], ['green', green]]) {
        const t = fileAt(root, c, p.test);
        if (!t || sha256(t) !== r.frozen.test_sha256) return `${p.test} at ${label} ${short(c)} is not the frozen test`;
      }
      if (isAncestor(root, red, green)) {
        const touching = commitsTouching(root, red, green, p.test);
        if (touching.length) return `${touching.length} commit(s) between red and green changed ${p.test}, first ${short(touching.at(-1))}`;
      }
      return true;
    }),
    check('the app changed between red and green', () => {
      const { red, green } = commits();
      const a = objectAt(root, red, app);
      const b = objectAt(root, green, app);
      if (!b) return `${app} is not in green ${short(green)}`;
      return a !== b || `${app} is the same at red and green`;
    }),
    check('the state history records this red, then one commit per failed attempt', () => {
      const { red, green } = commits();
      const stateCommits = commitsTouchingOldestFirst(root, red, green, p.state);
      if (!stateCommits.length) return `no commit between red and green records ${p.state}`;
      const first = stateCommits[0];
      if (parentOf(root, first) !== red) return `the first state commit after red, ${short(first)}, is not recorded on red ${short(red)}`;
      const s = JSON.parse(fileAt(root, first, p.state).toString('utf8'));
      if (s.status !== 'red' || !s.red) return `${short(first)} does not record a red`;
      for (const key of RED_FIELDS) {
        if (canonicalJson(s.red[key] ?? null) !== canonicalJson(r.red[key] ?? null)) return `red.${key} differs from the red record in ${short(first)}`;
      }
      for (const c of stateCommits.slice(1)) {
        const later = JSON.parse(fileAt(root, c, p.state).toString('utf8'));
        if (later.status !== 'in-progress') return `${short(c)}, between red and green, records "${later.status}", not a failed attempt`;
        if (canonicalJson(later.red) !== canonicalJson(s.red)) return `the red record changed in ${short(c)}`;
      }
      const attempts = stateCommits.length - 1;
      return attempts === r.green.failed_attempts || `${attempts} failed attempts in the history, ${r.green.failed_attempts} in the receipt`;
    }),
    check("the receipt is committed as it is, with Kane's recording", () => {
      const commit = commitsChangingFile(root, p.receipt).find((c) => {
        const b = fileAt(root, c, p.receipt);
        return b && b.equals(bytes);
      });
      if (!commit) return `${p.receipt} is not committed with these exact contents`;
      const { green } = commits();
      if (!isAncestor(root, green, commit)) return `green ${short(green)} is not an ancestor of the receipt commit ${short(commit)}`;
      const files = recordingAt(root, commit, p.recording);
      if (!files.length) return `${p.recording} is not in the receipt commit ${short(commit)}`;
      return hashEntries(files) === r.recording.sha256 || `${p.recording} in ${short(commit)} does not match the receipt`;
    }),
  ];
  return { receipt: r, checks };
}
