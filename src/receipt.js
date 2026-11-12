import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  blob,
  commitFiles,
  commitsChangingFile,
  commitsTouching,
  fileAt,
  isAncestor,
  objectAt,
  resolveCommit,
  short,
  worktreeFiles,
} from './git.js';
import { canonicalJson, hashEntries, sha256 } from './hash.js';

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

// Requirement 4.2: re-check a receipt with git only. Returns { receipt, checks: [{ name, ok, detail }] }.
export function verifyReceipt(root, bytes, receiptRel) {
  let r;
  try {
    r = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { receipt: null, checks: [{ name: 'the receipt is valid JSON', ok: false, detail: 'it is not' }] };
  }
  if (!r || typeof r !== 'object' || !r.frozen || !r.red || !r.green || !r.recording || !r.settings) {
    return { receipt: null, checks: [{ name: 'the receipt has settings, frozen, red, green and recording parts', ok: false, detail: 'some are missing' }] };
  }
  const test = r.frozen.test;
  const app = r.settings.app;

  const checks = [
    check('the receipt hash matches its contents', () => receiptHash(r) === r.receipt_sha256 || 'the contents were changed after the receipt was written'),
    check('the test and ticket at the frozen commit match the receipt', () => {
      const F = need(root, r.frozen.commit, 'frozen commit');
      const t = fileAt(root, F, test);
      if (!t) return `${test} is not in ${short(F)}`;
      if (sha256(t) !== r.frozen.test_sha256) return `${test} at ${short(F)} has a different sha256`;
      const k = fileAt(root, F, r.frozen.ticket);
      if (!k || sha256(k) !== r.frozen.ticket_sha256) return `${r.frozen.ticket} at ${short(F)} has a different sha256`;
      return true;
    }),
    check('the test was frozen before red', () => {
      const F = need(root, r.frozen.commit, 'frozen commit');
      const red = need(root, r.red.commit, 'red commit');
      return isAncestor(root, F, red) || `${short(F)} is not an ancestor of red ${short(red)}`;
    }),
    check('red is an ancestor of green', () => {
      const red = need(root, r.red.commit, 'red commit');
      const green = need(root, r.green.commit, 'green commit');
      return isAncestor(root, red, green) || `red ${short(red)} is not an ancestor of green ${short(green)}`;
    }),
    check('the frozen test did not change between red and green', () => {
      const red = need(root, r.red.commit, 'red commit');
      const green = need(root, r.green.commit, 'green commit');
      for (const [label, c] of [['red', red], ['green', green]]) {
        const t = fileAt(root, c, test);
        if (!t || sha256(t) !== r.frozen.test_sha256) return `${test} at ${label} ${short(c)} is not the frozen test`;
      }
      if (isAncestor(root, red, green)) {
        const touching = commitsTouching(root, red, green, test);
        if (touching.length) return `${touching.length} commit(s) between red and green changed ${test}, first ${short(touching.at(-1))}`;
      }
      return true;
    }),
    check('the app changed between red and green', () => {
      const red = need(root, r.red.commit, 'red commit');
      const green = need(root, r.green.commit, 'green commit');
      const a = objectAt(root, red, app);
      const b = objectAt(root, green, app);
      if (!b) return `${app} is not in green ${short(green)}`;
      return a !== b || `${app} is the same at red and green`;
    }),
    check("the receipt is committed as it is, with Kane's recording", () => {
      const commit = commitsChangingFile(root, receiptRel).find((c) => {
        const b = fileAt(root, c, receiptRel);
        return b && b.equals(bytes);
      });
      if (!commit) return `${receiptRel} is not committed with these exact contents`;
      const green = need(root, r.green.commit, 'green commit');
      if (!isAncestor(root, green, commit)) return `green ${short(green)} is not an ancestor of the receipt commit ${short(commit)}`;
      const files = recordingAt(root, commit, r.recording.path);
      if (!files.length) return `${r.recording.path} is not in the receipt commit ${short(commit)}`;
      return hashEntries(files) === r.recording.sha256 || `${r.recording.path} in ${short(commit)} does not match the receipt`;
    }),
  ];
  return { receipt: r, checks };
}
