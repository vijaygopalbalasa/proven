import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Refusal } from './errors.js';

// Every git command Proven makes runs with replace objects switched off and without system or global config, so a
// refs/replace ref or a config the agent does not control cannot change what a commit, tree or file looks like. It is
// also pinned to the repository's own .git (resolved once, at startup) and carries the person's identity.
const pinned = new Map();
const identities = new Map();

const plainGit = (root, args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

// The absolute .git of this repository, found once with plain git, before anything else can change it.
export function pinGitDir(root) {
  if (pinned.has(root)) return pinned.get(root);
  const dir = plainGit(root, ['rev-parse', '--absolute-git-dir']);
  if (dir) pinned.set(root, dir);
  return dir || null;
}

// The identity commits use. Proven runs git without the global config, so what the repository lacks is read once from
// the person's global git config, with plain git, and passed as environment variables.
export function readIdentity(root) {
  if (identities.has(root)) return identities.get(root);
  const env = {};
  const missing = [];
  for (const [key, who] of [['name', 'NAME'], ['email', 'EMAIL']]) {
    const local = plainGit(root, ['config', '--local', '--get', `user.${key}`]);
    if (local) continue;
    const global = plainGit(root, ['config', '--global', '--get', `user.${key}`]);
    if (global) Object.assign(env, { [`GIT_AUTHOR_${who}`]: global, [`GIT_COMMITTER_${who}`]: global });
    else missing.push(`user.${key}`);
  }
  const value = { env, missing };
  identities.set(root, value);
  return value;
}

function requireIdentity(root) {
  const { missing } = readIdentity(root);
  if (missing.length) {
    throw new Refusal(
      `Git has no user.name and user.email for this repository (missing: ${missing.join(', ')}), and Proven does not use other git settings while it works. Set them inside this repository: git config user.name "Your Name" and git config user.email "<your email>".`,
    );
  }
}

export function gitEnv(base = process.env, extra = {}, root) {
  const identity = root ? identities.get(root)?.env : null;
  const dir = root ? pinned.get(root) : null;
  return { ...base, GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...(identity ?? {}), ...(dir ? { GIT_DIR: dir } : {}), ...extra };
}

export function git(root, args, { env, input, buffer = false, allowFail = false } = {}) {
  try {
    const result = execFileSync('git', args, {
      cwd: root,
      env: gitEnv(env ?? process.env, {}, root),
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 512 * 1024 * 1024,
      ...(buffer ? {} : { encoding: 'utf8' }),
    });
    return result;
  } catch (err) {
    if (allowFail) return null;
    const detail = (err.stderr ? err.stderr.toString() : err.message).trim();
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

export function short(sha) {
  return sha ? String(sha).slice(0, 7) : '(none)';
}

export function findRoot(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!out) throw new Refusal('Run proven inside a git repository.');
  return out.trim();
}

export function head(root) {
  const out = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  return out ? out.trim() : null;
}

export function resolveCommit(root, ref) {
  if (typeof ref !== 'string' || !/^[0-9a-f]{4,64}$/i.test(ref)) return null;
  const out = git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true });
  return out ? out.trim() : null;
}

export function isAncestor(root, ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, stdio: 'ignore', env: gitEnv(process.env, {}, root) });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git could not compare ${short(ancestor)} and ${short(descendant)}`);
}

// File content at a commit, as a Buffer, or null if it is not there.
export function fileAt(root, commit, path) {
  return git(root, ['cat-file', 'blob', `${commit}:${path}`], { buffer: true, allowFail: true });
}

// Git's id for a file or folder at a commit, or null.
export function objectAt(root, commit, path) {
  const out = git(root, ['rev-parse', '--verify', '-q', `${commit}:${path}`], { allowFail: true });
  return out ? out.trim() : null;
}

export function changedPaths(root, commit) {
  const out = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-z', commit]);
  return out.split('\0').filter(Boolean);
}

export function commitsTouching(root, from, to, path) {
  const out = git(root, ['rev-list', `${from}..${to}`, '--', path]);
  return out.split('\n').filter(Boolean);
}

export function commitsChangingFile(root, path) {
  const out = git(root, ['log', '--format=%H', '--', path], { allowFail: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

// Uncommitted changes under a path, untracked files included.
export function dirtyPaths(root, path) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', path]);
  const paths = [];
  for (const token of out.split('\0')) {
    if (/^[ MADRCU?!]{2} /.test(token)) paths.push(token.slice(3));
  }
  return paths;
}

export function isIgnored(root, path) {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: root, stdio: 'ignore', env: gitEnv(process.env, {}, root) });
  return result.status === 0;
}

function lexists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Files under a folder that git would track: tracked or untracked, not ignored, present on disk
// (a symlink counts as present even when its target is not).
export function worktreeFiles(root, dir) {
  const out = git(root, ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', dir]);
  const seen = new Set();
  for (const p of out.split('\0')) {
    if (p && !seen.has(p) && lexists(join(root, p))) seen.add(p);
  }
  return [...seen].sort();
}

// Untracked files under a folder that git ignores: on disk, maybe served, never committed.
export function ignoredFiles(root, dir) {
  const out = git(root, ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--', dir]);
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

export function parentOf(root, commit) {
  const out = git(root, ['rev-parse', '--verify', '-q', `${commit}^`], { allowFail: true });
  return out ? out.trim() : null;
}

// Commits in from..to that change path, oldest first.
export function commitsTouchingOldestFirst(root, from, to, path) {
  const out = git(root, ['rev-list', '--reverse', `${from}..${to}`, '--', path], { allowFail: true });
  return out ? out.split('\n').filter(Boolean) : [];
}


export function blob(root, id) {
  return git(root, ['cat-file', 'blob', id], { buffer: true });
}

function pathKnown(root, headSha, p) {
  if (existsSync(join(root, p))) return true;
  if (!headSha) return false;
  const out = git(root, ['ls-tree', '--name-only', headSha, '--', p]);
  return out.trim().length > 0;
}

// Commit exactly the working-tree state of `paths` on top of HEAD, using a temporary index, so whatever else the
// person has staged stays staged and out of this commit. `excludes` are pathspecs to leave out.
// Returns { commit, created }. If nothing changed, returns HEAD with created false.
export function commitPaths(root, { paths, excludes = [], message, allowEmpty = false }) {
  requireIdentity(root);
  const headSha = head(root);
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).trim();
  const tmpIndex = join(gitDir, `proven-index-${process.pid}-${randomBytes(4).toString('hex')}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    if (headSha) git(root, ['read-tree', headSha], { env });
    else git(root, ['read-tree', '--empty'], { env });
    const present = paths.filter((p) => pathKnown(root, headSha, p));
    if (present.length) {
      git(root, ['add', '-A', '--', ...present, ...excludes.map((e) => `:(exclude,glob)${e}`)], { env });
    }
    const tree = git(root, ['write-tree'], { env }).trim();
    if (!allowEmpty && headSha && tree === git(root, ['rev-parse', `${headSha}^{tree}`]).trim()) {
      return { commit: headSha, created: false };
    }
    const args = ['commit-tree', tree, '-m', message];
    if (headSha) args.push('-p', headSha);
    const commit = git(root, args).trim();
    const update = ['update-ref', '-m', `proven: ${message}`, 'HEAD', commit];
    if (headSha) update.push(headSha);
    git(root, update);
    // Bring the real index in line with the new commit for these paths only.
    if (present.length) git(root, ['reset', '-q', '--', ...present]);
    return { commit, created: true };
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

// Commit HEAD's tree with `path` replaced by an existing tree id, so the commit holds exactly that tree for the
// path, built from the tree itself and not from the working tree. Returns HEAD unchanged if it already holds it.
export function commitTreeAtPath(root, { path, tree, message }) {
  requireIdentity(root);
  const headSha = head(root);
  if (headSha && objectAt(root, headSha, path) === tree) return { commit: headSha, created: false };
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).trim();
  const tmpIndex = join(gitDir, `proven-index-${process.pid}-${randomBytes(4).toString('hex')}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    if (headSha) git(root, ['read-tree', headSha], { env });
    else git(root, ['read-tree', '--empty'], { env });
    git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', path], { env });
    git(root, ['read-tree', `--prefix=${path}/`, tree], { env });
    const newTree = git(root, ['write-tree'], { env }).trim();
    const args = ['commit-tree', newTree, '-m', message];
    if (headSha) args.push('-p', headSha);
    const commit = git(root, args).trim();
    const update = ['update-ref', '-m', `proven: ${message}`, 'HEAD', commit];
    if (headSha) update.push(headSha);
    git(root, update);
    git(root, ['reset', '-q', '--', path]);
    return { commit, created: true };
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

// Stop if a commit Proven made touches anything outside the allowed paths.
export function assertOnlyPaths(root, commit, allowed) {
  const outside = changedPaths(root, commit).filter(
    (p) => !allowed.some((a) => p === a || p.startsWith(a.endsWith('/') ? a : a + '/')),
  );
  if (outside.length) {
    throw new Error(`commit ${short(commit)} touches paths it should not: ${outside.slice(0, 5).join(', ')}`);
  }
}
