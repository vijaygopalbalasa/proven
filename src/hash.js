import { createHash } from 'node:crypto';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Canonical JSON: object keys sorted, no whitespace, undefined fields dropped.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonical JSON cannot hold NaN or Infinity');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v === undefined ? null : v)).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

// Hash of a set of files: sha256 of the canonical JSON of [path, sha256 of content] pairs, sorted by path.
// The same files give the same hash whether they are read from the working tree or from a commit.
// (The app folder is fingerprinted by its git tree id instead; see snapshot.js.)
export function hashEntries(entries) {
  const pairs = entries.map((e) => [e.path, sha256(e.content)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(canonicalJson(pairs));
}
