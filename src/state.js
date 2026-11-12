import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refusal } from './errors.js';
import { changedPaths, commitsTouchingOldestFirst, fileAt, git, lastCommitTouching, parentOf, short } from './git.js';
import { canonicalJson } from './hash.js';
import { assertClean } from './leak.js';
import { ticketPaths } from './ticket.js';

// Is this a commit Proven makes for this ticket's state? Either the state file alone (red, an attempt,
// needs a person, already passes) or the receipt commit (receipt, Kane's recording, state).
function provenShaped(root, id, commit, subject) {
  const p = ticketPaths(id);
  if (!subject.startsWith(`${id}: `)) return false;
  const paths = changedPaths(root, commit);
  if (paths.length === 1 && paths[0] === p.state) return true;
  return (
    subject.startsWith(`${id}: receipt`) &&
    paths.includes(p.receipt) &&
    paths.every((x) => x === p.state || x === p.receipt || x.startsWith(p.recording + '/'))
  );
}

// Requirement: decisions come from the state as committed at HEAD, written only by Proven's own commits.
// The working-tree copy must match HEAD, so an edit there cannot change a decision.
export function loadState(root, id) {
  const rel = ticketPaths(id).state;
  const committed = fileAt(root, 'HEAD', rel);
  const file = join(root, rel);
  const working = existsSync(file) ? readFileSync(file) : null;
  if ((committed === null) !== (working === null) || (committed && !committed.equals(working))) {
    const fix = committed ? `git checkout HEAD -- ${rel}` : `remove ${rel}`;
    throw new Refusal(`${rel} has uncommitted changes. Proven reads its state from commits only. To restore it: ${fix}`);
  }
  const log = git(root, ['log', '--format=%H%x09%s', '--', rel], { allowFail: true }) ?? '';
  for (const line of log.split('\n').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const commit = line.slice(0, tab);
    if (!provenShaped(root, id, commit, line.slice(tab + 1))) {
      throw new Refusal(`${rel} was changed by commit ${short(commit)}, which Proven did not make. Proven trusts its state only from its own commits.`);
    }
  }
  if (!committed) return null;
  try {
    return JSON.parse(committed.toString('utf8'));
  } catch {
    throw new Refusal(`${rel} is not valid JSON.`);
  }
}

export const RED_FIELDS = [
  'commit',
  'failed_step',
  'failed_step_title',
  'kane_one_liner',
  'kane_reason',
  'evidence_sha256',
  'kane',
  'kane_cli',
  'duration_s',
  'credits',
];
const RED_NOT_EMPTY = ['commit', 'failed_step', 'failed_step_title', 'kane'];

// Cheap invariants on the red record, which an agent with a shell could otherwise rewrite:
// every field is present (nothing is assumed), red.commit is the parent of the first state commit after the
// lock (the commit red was recorded on), and no later state commit changes the red record.
export function checkRedRecord(root, id, state) {
  const p = ticketPaths(id);
  const red = state.red;
  if (!red || typeof red !== 'object') throw new Refusal(`${p.state} has no red record. A person needs to look at ${id}.`);
  for (const key of RED_FIELDS) {
    if (!(key in red) || (RED_NOT_EMPTY.includes(key) && (red[key] === null || red[key] === ''))) {
      throw new Refusal(`${p.state} is missing red.${key}. A person needs to look at ${id}.`);
    }
  }
  const lockCommit = lastCommitTouching(root, 'HEAD', p.lock);
  const stateCommits = lockCommit ? commitsTouchingOldestFirst(root, lockCommit, 'HEAD', p.state) : [];
  if (!stateCommits.length) throw new Refusal(`No commit after the lock records red in ${p.state}. A person needs to look at ${id}.`);
  const recordedOn = parentOf(root, stateCommits[0]);
  if (recordedOn !== red.commit) {
    throw new Refusal(
      `The red record in ${p.state} names ${short(red.commit)}, but red was recorded on ${short(recordedOn)}. A person needs to look at ${id}.`,
    );
  }
  const first = JSON.parse(fileAt(root, stateCommits[0], p.state)?.toString('utf8') ?? 'null');
  if (!first || first.status !== 'red' || canonicalJson(first.red) !== canonicalJson(red)) {
    throw new Refusal(`The red record in ${p.state} changed in commit ${short(stateCommits.at(-1))}. A person needs to look at ${id}.`);
  }
  for (const c of stateCommits.slice(1)) {
    const later = JSON.parse(fileAt(root, c, p.state)?.toString('utf8') ?? 'null');
    if (!later || canonicalJson(later.red) !== canonicalJson(first.red)) {
      throw new Refusal(`The red record in ${p.state} changed in commit ${short(c)}. A person needs to look at ${id}.`);
    }
  }
}

// Every failed attempt is one Proven commit of the state file after red, so the history must show
// the red record plus one commit per attempt.
export function checkAttemptHistory(root, id, state) {
  const rel = ticketPaths(id).state;
  const out = git(root, ['rev-list', `${state.red.commit}..HEAD`, '--', rel], { allowFail: true });
  const commits = out ? out.split('\n').filter(Boolean) : [];
  const attempts = Number.isInteger(state.attempts) ? state.attempts : -1;
  if (attempts < 0 || commits.length !== attempts + 1) {
    throw new Refusal(
      `The history of ${rel} does not match its attempt count (${commits.length} state commits since red, ${state.attempts} attempts recorded). A person needs to look at ${id}.`,
    );
  }
}

// Writes JSON that Proven will commit, after checking it holds nothing private.
export function writeJson(root, rel, value, { exact } = {}) {
  const text = JSON.stringify(value, null, 2) + '\n';
  assertClean(text, rel, { exact });
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return text;
}

export function writeState(root, id, state, opts) {
  return writeJson(root, ticketPaths(id).state, state, opts);
}

// A state left over from an earlier freeze does not count: the ticket is simply frozen again.
export function statusOf(state, lock) {
  if (!lock) return 'new';
  if (!state || state.frozen_commit !== lock.frozen_commit) return 'frozen';
  return state.status;
}
