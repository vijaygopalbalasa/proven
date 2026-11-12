import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from './errors.js';
import { fileAt, resolveCommit, short } from './git.js';
import { sha256 } from './hash.js';
import { LANDMARK_STEP_TITLE, parseTestSteps, startUrlOf, ticketPaths } from './ticket.js';

export function readLock(root, id) {
  const file = join(root, ticketPaths(id).lock);
  if (!existsSync(file)) return null;
  let lock;
  try {
    lock = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Refusal(`${ticketPaths(id).lock} is not valid JSON.`);
  }
  for (const key of ['test_sha256', 'ticket_sha256', 'frozen_commit']) {
    if (typeof lock[key] !== 'string' || !lock[key]) throw new Refusal(`${ticketPaths(id).lock} has no ${key}.`);
  }
  return lock;
}

// Requirement 1.4: the test must match its lock, and the lock's commit F must hold the same bytes.
export function checkFrozenTest(root, id) {
  const p = ticketPaths(id);
  const lock = readLock(root, id);
  if (!lock) throw new Refusal(`${id} is not frozen yet. A person runs proven freeze ${id} first.`);
  if (lock.ticket !== id || lock.test_path !== p.test || lock.ticket_path !== p.ticket) {
    throw new Refusal(`${p.lock} does not belong to ${id}.`);
  }
  const testFile = join(root, p.test);
  if (!existsSync(testFile)) throw new Refusal(`${p.test} is missing. Restore it with: git checkout ${short(lock.frozen_commit)} -- ${p.test}`);
  const testBuf = readFileSync(testFile);

  const problems = [];
  if (sha256(testBuf) !== lock.test_sha256) problems.push(`${p.test} changed after it was frozen`);
  const frozenCommit = resolveCommit(root, lock.frozen_commit);
  if (!frozenCommit) problems.push(`the frozen commit ${short(lock.frozen_commit)} is not in this repository`);
  else {
    const atF = fileAt(root, frozenCommit, p.test);
    if (!atF) problems.push(`the frozen commit ${short(frozenCommit)} does not hold ${p.test}`);
    else if (sha256(atF) !== lock.test_sha256) problems.push(`${p.test} at the frozen commit ${short(frozenCommit)} does not match the lock`);
  }
  if (problems.length) {
    throw new Refusal(
      `Refusing to run ${p.test}: ${problems.join('; ')}.\nFix the app, not the test. To restore the frozen test: git checkout ${short(lock.frozen_commit)} -- ${p.test}`,
    );
  }

  const steps = parseTestSteps(testBuf.toString('utf8'));
  const startUrl = startUrlOf(steps);
  if (steps.length < 2 || steps[0].title !== LANDMARK_STEP_TITLE || !startUrl) {
    throw new Refusal(`${p.test} does not start with "${LANDMARK_STEP_TITLE}" and a start URL. Freeze it again with proven freeze ${id}.`);
  }
  return { lock, testBuf, steps, startUrl };
}
