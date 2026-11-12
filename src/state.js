import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refusal } from './errors.js';
import { changedPaths, commitsTouchingOldestFirst, fileAt, git, objectAt, parentOf, resolveCommit, short } from './git.js';
import { canonicalJson } from './hash.js';
import { assertClean } from './leak.js';
import { ticketPaths } from './ticket.js';

// Is this a commit Proven makes for this ticket's state? Either the state file alone (red, an attempt,
// needs a person, already passes) or the receipt commit (the receipt and the state, nothing else).
function provenShaped(root, id, commit, subject) {
  const p = ticketPaths(id);
  if (!subject.startsWith(`${id}: `)) return false;
  const paths = changedPaths(root, commit);
  if (paths.length === 1 && paths[0] === p.state) return true;
  return subject.startsWith(`${id}: receipt`) && paths.includes(p.receipt) && paths.every((x) => x === p.state || x === p.receipt);
}

// Did Proven's own commits write every version of this ticket's state? Returns the reason it did not, or null.
export function stateHistoryProblem(root, id) {
  const rel = ticketPaths(id).state;
  const log = git(root, ['log', '--format=%H%x09%s', '--', rel], { allowFail: true }) ?? '';
  for (const line of log.split('\n').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const commit = line.slice(0, tab);
    if (!provenShaped(root, id, commit, line.slice(tab + 1))) {
      return `${rel} was changed by commit ${short(commit)}, which Proven did not make. Proven trusts its state only from its own commits.`;
    }
  }
  return null;
}

// The state as committed at HEAD, for reading only (the board). Never throws: a state Proven cannot trust comes back
// as a problem.
export function committedState(root, id) {
  const rel = ticketPaths(id).state;
  const problem = stateHistoryProblem(root, id);
  if (problem) return { state: null, problem };
  const committed = fileAt(root, 'HEAD', rel);
  if (!committed) return { state: null, problem: null };
  try {
    return { state: JSON.parse(committed.toString('utf8')), problem: null };
  } catch {
    return { state: null, problem: `${rel} is not valid JSON.` };
  }
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
  const problem = stateHistoryProblem(root, id);
  if (problem) throw new Refusal(problem);
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
  'app_tree',
];
const RED_NOT_EMPTY = ['commit', 'failed_step', 'failed_step_title', 'kane', 'app_tree'];

// The lock chain: after the frozen commit F, the lock is written exactly once, in its own commit, right on F.
// Returns that lock commit L. Red must then be recorded right on L.
export function lockChain(root, id, lock) {
  const p = ticketPaths(id);
  const F = resolveCommit(root, lock.frozen_commit);
  if (!F) throw new Refusal(`The frozen commit ${short(lock.frozen_commit)} of ${id} is not in this repository.`);
  const writes = commitsTouchingOldestFirst(root, F, 'HEAD', p.lock);
  if (writes.length !== 1) {
    throw new Refusal(`${p.lock} was written ${writes.length} times after its frozen commit ${short(F)}. A person needs to look at ${id}.`);
  }
  const L = writes[0];
  if (parentOf(root, L) !== F) throw new Refusal(`${p.lock} was not written right after its frozen commit ${short(F)}. A person needs to look at ${id}.`);
  const changed = changedPaths(root, L);
  if (changed.length !== 1 || changed[0] !== p.lock) throw new Refusal(`The lock commit ${short(L)} of ${id} holds other files too.`);
  return L;
}

function readStateAt(root, id, commit) {
  try {
    return JSON.parse(fileAt(root, commit, ticketPaths(id).state)?.toString('utf8') ?? 'null');
  } catch {
    return null;
  }
}

// The state history after the lock commit L, in rounds. Round 1 starts with the red record, right on L. A later round
// starts when proven recheck reopens a done ticket: its state commit follows a done and sits right on the commit it
// names as red. Inside a round come the failed attempts, then needs a person or done.
export function stateRounds(root, id, L) {
  const p = ticketPaths(id);
  const rounds = [];
  let prev = null;
  for (const c of commitsTouchingOldestFirst(root, L, 'HEAD', p.state)) {
    const s = readStateAt(root, id, c);
    if (!s || typeof s !== 'object') throw new Refusal(`${p.state} at ${short(c)} is not valid JSON. A person needs to look at ${id}.`);
    if (!rounds.length) {
      rounds.push({ kind: 'red', redCommit: L, start: c, first: s, commits: [c] });
    } else if (s.status === 'reopened') {
      if (prev.status !== 'done') {
        throw new Refusal(`${p.state} records a reopen in ${short(c)} that does not follow a done. A person needs to look at ${id}.`);
      }
      if (typeof s.red?.commit !== 'string' || parentOf(root, c) !== s.red.commit) {
        throw new Refusal(`The reopen commit ${short(c)} of ${id} does not sit on the commit it names as red. A person needs to look at ${id}.`);
      }
      rounds.push({ kind: 'reopened', redCommit: s.red.commit, start: c, first: s, commits: [c] });
    } else {
      if (prev.status === 'done' || prev.status === 'needs-a-person') {
        throw new Refusal(`${p.state} records "${s.status}" in ${short(c)} after "${prev.status}". A person needs to look at ${id}.`);
      }
      rounds.at(-1).commits.push(c);
    }
    prev = s;
  }
  return rounds;
}

// Cheap invariants on the red record, which an agent with a shell could otherwise rewrite: every field is present
// (nothing is assumed), the first state commit after the lock sits right on the lock commit and records red there,
// a reopen sits right on its own red commit, every red names the app tree that its commit holds (what Kane judged),
// and no later state commit in a round changes that round's red record.
export function checkRedRecord(root, id, state, lock) {
  const p = ticketPaths(id);
  const red = state.red;
  if (!red || typeof red !== 'object') throw new Refusal(`${p.state} has no red record. A person needs to look at ${id}.`);
  for (const key of RED_FIELDS) {
    if (!(key in red) || (RED_NOT_EMPTY.includes(key) && (red[key] === null || red[key] === ''))) {
      throw new Refusal(`${p.state} is missing red.${key}. A person needs to look at ${id}.`);
    }
  }
  const L = lockChain(root, id, lock);
  const rounds = stateRounds(root, id, L);
  if (!rounds.length) throw new Refusal(`No commit after the lock records red in ${p.state}. A person needs to look at ${id}.`);
  if (parentOf(root, rounds[0].start) !== L) {
    throw new Refusal(`The first state commit after the lock, ${short(rounds[0].start)}, does not sit on the lock commit ${short(L)}. A person needs to look at ${id}.`);
  }
  const round = rounds.at(-1);
  if (red.commit !== round.redCommit) {
    throw new Refusal(`The red record in ${p.state} names ${short(red.commit)}, but red was recorded on ${short(round.redCommit)}. A person needs to look at ${id}.`);
  }
  for (const r of rounds) {
    const opening = r.kind === 'red' ? 'red' : 'reopened';
    const last = r === round ? red : null;
    if (r.first.status !== opening || (last && canonicalJson(r.first.red) !== canonicalJson(last))) {
      throw new Refusal(`The red record in ${p.state} changed in commit ${short(r.commits.at(-1))}. A person needs to look at ${id}.`);
    }
    if (r.first.red?.commit !== r.redCommit) {
      throw new Refusal(`The red record in ${p.state} at ${short(r.start)} names ${short(r.first.red?.commit)}, but red was recorded on ${short(r.redCommit)}. A person needs to look at ${id}.`);
    }
    const app = lock.settings?.app;
    const tree = typeof app === 'string' ? objectAt(root, r.redCommit, app) : null;
    if (!tree || r.first.red.app_tree !== tree) {
      throw new Refusal(`The red record in ${p.state} at ${short(r.start)} names app tree ${short(r.first.red.app_tree)}, but the app at ${short(r.redCommit)} is ${short(tree)}. A person needs to look at ${id}.`);
    }
    for (const c of r.commits.slice(1)) {
      const later = readStateAt(root, id, c);
      if (!later || canonicalJson(later.red) !== canonicalJson(r.first.red)) {
        throw new Refusal(`The red record in ${p.state} changed in commit ${short(c)}. A person needs to look at ${id}.`);
      }
    }
  }
  return { L, rounds };
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
