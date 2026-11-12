import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Refusal } from './errors.js';
import { assertClean } from './leak.js';
import { ticketPaths } from './ticket.js';

export function readState(root, id) {
  const file = join(root, ticketPaths(id).state);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Refusal(`${ticketPaths(id).state} is not valid JSON.`);
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
