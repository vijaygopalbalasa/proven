import {
  changedPaths,
  commitsChangingFile,
  commitsTouching,
  commitsTouchingOldestFirst,
  fileAt,
  isAncestor,
  objectAt,
  parentOf,
  resolveCommit,
  short,
} from './git.js';
import { canonicalJson, sha256 } from './hash.js';
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

function parse(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

// The commit that wrote the receipt as it is at HEAD, or null.
export function receiptCommitAtHead(root, id) {
  const p = ticketPaths(id);
  const bytes = fileAt(root, 'HEAD', p.receipt);
  if (!bytes) return null;
  const commit = commitsChangingFile(root, p.receipt)[0];
  const at = commit ? fileAt(root, commit, p.receipt) : null;
  return at && at.equals(bytes) ? { commit, bytes } : null;
}

// The earlier receipts a receipt links, newest first: [{ commit, receipt }]. A ticket that was reopened and closed
// again has one per earlier close. Stops at a link that does not resolve.
export function earlierReceipts(root, receipt) {
  const out = [];
  let r = receipt;
  const p = ticketPaths(receipt.ticket);
  while (r?.previous && out.length < 100) {
    const commit = resolveCommit(root, r.previous.commit);
    const bytes = commit ? fileAt(root, commit, p.receipt) : null;
    const earlier = bytes ? parse(bytes) : null;
    if (!earlier) break;
    out.push({ commit, receipt: earlier });
    r = earlier;
  }
  return out;
}

// Requirement 4.2: re-check a receipt with git only. Paths come from the ticket id, never from the receipt.
// Returns { receipt, checks: [{ name, ok, detail }] }. A receipt for a ticket that proven recheck reopened links the
// earlier receipt (previous); that one is checked the same way, all the way back to the first close.
export function verifyReceipt(root, bytes, depth = 0) {
  const r = parse(bytes);
  if (!r) return { receipt: null, checks: [{ name: 'the receipt is valid JSON', ok: false, detail: 'it is not' }] };
  if (!r || typeof r !== 'object' || !r.frozen || !r.red || !r.green || !r.settings) {
    return { receipt: null, checks: [{ name: 'the receipt has settings, frozen, red and green parts', ok: false, detail: 'some are missing' }] };
  }
  if (typeof r.ticket !== 'string' || !ID_RE.test(r.ticket)) {
    return { receipt: null, checks: [{ name: 'the receipt names a ticket like T-1', ok: false, detail: `it names "${r.ticket}"` }] };
  }
  const p = ticketPaths(r.ticket);
  const app = r.settings.app;
  // A later close: the ticket was reopened by proven recheck after an earlier receipt, then closed again.
  const later = r.previous !== undefined;
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
    check(
      later
        ? 'the lock was written once, right after the frozen commit, and pins these settings'
        : 'the lock was written once, right after the frozen commit, pins these settings, and red sits on it',
      () => {
        const { F, red, green } = commits();
        const writes = commitsTouchingOldestFirst(root, F, green, p.lock);
        if (writes.length !== 1) return `${p.lock} was written ${writes.length} times between the frozen commit and green`;
        const L = writes[0];
        if (parentOf(root, L) !== F) return `the lock commit ${short(L)} does not sit right on the frozen commit ${short(F)}`;
        const changed = changedPaths(root, L);
        if (changed.length !== 1 || changed[0] !== p.lock) return `the lock commit ${short(L)} holds other files too`;
        if (!later && L !== red) return `red ${short(red)} is not the lock commit ${short(L)}`;
        const lock = JSON.parse(fileAt(root, L, p.lock).toString('utf8'));
        if (resolveCommit(root, lock.frozen_commit) !== F) return `the lock names ${short(lock.frozen_commit)}, not ${short(F)}`;
        if (lock.test_sha256 !== r.frozen.test_sha256 || lock.ticket_sha256 !== r.frozen.ticket_sha256) return 'the lock pins other test or ticket hashes';
        const want = settingsSha(r.settings);
        if (lock.settings_sha256 !== want || !lock.settings || settingsSha(lock.settings) !== want) return 'the lock pins other settings';
        return true;
      },
    ),
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
    check('the app at red and green matches the receipt, and changed', () => {
      const { red, green } = commits();
      const a = objectAt(root, red, app);
      const b = objectAt(root, green, app);
      if (a !== r.red.app_tree) return `red.app_tree is not the app at red ${short(red)}`;
      if (b !== r.green.app_tree) return `green.app_tree is not the app at green ${short(green)}`;
      return a !== b || `${app} is the same at red and green`;
    }),
    check('the state history records this red, then one commit per failed attempt', () => {
      const { red, green } = commits();
      const stateCommits = commitsTouchingOldestFirst(root, red, green, p.state);
      if (!stateCommits.length) return `no commit between red and green records ${p.state}`;
      const first = stateCommits[0];
      if (parentOf(root, first) !== red) return `the first state commit after red, ${short(first)}, is not recorded on red ${short(red)}`;
      const s = JSON.parse(fileAt(root, first, p.state).toString('utf8'));
      const opening = later ? 'reopened' : 'red';
      if (s.status !== opening || !s.red) return `${short(first)} does not record ${later ? 'a reopen' : 'a red'}`;
      for (const key of RED_FIELDS) {
        if (canonicalJson(s.red[key] ?? null) !== canonicalJson(r.red[key] ?? null)) return `red.${key} differs from the red record in ${short(first)}`;
      }
      if (later && s.reopened?.previous?.receipt_sha256 !== r.previous?.receipt_sha256) {
        return `the reopen in ${short(first)} links another earlier receipt`;
      }
      for (const c of stateCommits.slice(1)) {
        const next = JSON.parse(fileAt(root, c, p.state).toString('utf8'));
        if (next.status !== 'in-progress') return `${short(c)}, between red and green, records "${next.status}", not a failed attempt`;
        if (canonicalJson(next.red) !== canonicalJson(s.red)) return `the red record changed in ${short(c)}`;
      }
      const attempts = stateCommits.length - 1;
      return attempts === r.green.failed_attempts || `${attempts} failed attempts in the history, ${r.green.failed_attempts} in the receipt`;
    }),
    check('the receipt is committed as it is', () => {
      const commit = commitsChangingFile(root, p.receipt).find((c) => {
        const b = fileAt(root, c, p.receipt);
        return b && b.equals(bytes);
      });
      if (!commit) return `${p.receipt} is not committed with these exact contents`;
      const { green } = commits();
      return isAncestor(root, green, commit) || `green ${short(green)} is not an ancestor of the receipt commit ${short(commit)}`;
    }),
  ];

  if (later) {
    checks.push(
      check('the earlier receipt it links is committed, verifies, and came before this red', () => {
        const prev = r.previous;
        if (!prev || typeof prev !== 'object' || typeof prev.commit !== 'string' || typeof prev.receipt_sha256 !== 'string') {
          return 'previous must name a commit and a receipt_sha256';
        }
        if (depth >= 50) return 'too many earlier receipts';
        const { red } = commits();
        const at = need(root, prev.commit, 'earlier receipt commit');
        const earlierBytes = fileAt(root, at, p.receipt);
        if (!earlierBytes) return `${p.receipt} is not in ${short(at)}`;
        const earlier = parse(earlierBytes);
        if (!earlier || earlier.receipt_sha256 !== prev.receipt_sha256) return `${p.receipt} in ${short(at)} is not the receipt this one links`;
        if (canonicalJson(earlier.frozen) !== canonicalJson(r.frozen) || canonicalJson(earlier.settings) !== canonicalJson(r.settings)) {
          return 'the earlier receipt has another frozen test or other settings';
        }
        if (!isAncestor(root, at, red)) return `the earlier receipt commit ${short(at)} is not an ancestor of red ${short(red)}`;
        const between = commitsTouching(root, at, red, p.state);
        if (between.length) return `${p.state} changed between the earlier receipt and red, in ${short(between.at(-1))}`;
        const failed = verifyReceipt(root, earlierBytes, depth + 1).checks.filter((c) => !c.ok);
        if (failed.length) return `the earlier receipt does not verify: ${failed[0].name}: ${failed[0].detail}`;
        return true;
      }),
    );
  }
  return { receipt: r, checks };
}
