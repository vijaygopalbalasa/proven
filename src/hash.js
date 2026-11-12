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

// Hash of a set of files: sha256 over "<sha256 of content>  <path>\n" lines sorted by path.
// The same files give the same hash whether they are read from the working tree or from a commit.
export function hashEntries(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = sorted.map((e) => `${sha256(e.content)}  ${e.path}\n`).join('');
  return sha256(manifest);
}
