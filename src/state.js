import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refusal } from './errors.js';
import { changedPaths, fileAt, git, short } from './git.js';
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
