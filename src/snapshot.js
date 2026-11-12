import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { blob, git } from './git.js';
import { hostsFor, serveFolder } from './serve.js';

// The app folder as git would commit it from the working tree (tracked and untracked files, not ignored ones),
// written as a git tree. Returns the tree id of the app folder, or null when it holds no files.
// This id is the app's fingerprint: it is exactly what a commit of the folder would hold.
export function snapshotApp(root, app) {
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).trim();
  const tmpIndex = join(gitDir, `proven-snapshot-${process.pid}-${randomBytes(4).toString('hex')}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    git(root, ['read-tree', '--empty'], { env });
    git(root, ['add', '-A', '--', app], { env });
    const rootTree = git(root, ['write-tree'], { env }).trim();
    const out = git(root, ['rev-parse', '--verify', '-q', `${rootTree}:${app}`], { allowFail: true });
    return out ? out.trim() : null;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

// Write every file of a tree into a folder. Symlinks and submodules are refused, so the folder holds exactly
// the tree's file contents.
export function exportTree(root, tree, dest) {
  const out = git(root, ['ls-tree', '-r', '-z', tree]);
  for (const line of out.split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [mode, , id] = line.slice(0, tab).split(' ');
    const path = line.slice(tab + 1);
    if (mode !== '100644' && mode !== '100755') throw new Error(`${path} is not a plain file (mode ${mode})`);
    const file = join(dest, ...path.split('/'));
    if (!file.startsWith(dest + sep)) throw new Error(`${path} is outside the export folder`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, blob(root, id));
    if (mode === '100755') chmodSync(file, 0o755);
  }
}

// Export a tree to a temporary folder and serve it on the start URL's port until close() is called.
// Used for every Kane run, and later by verify --replay to serve the red and green commits.
export async function serveTree(root, tree, startUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'proven-app-'));
  try {
    exportTree(root, tree, dir);
    const { port } = new URL(startUrl);
    const served = await serveFolder(dir, { port: Number(port), hosts: hostsFor(startUrl) });
    return {
      dir,
      close: async () => {
        await served.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
