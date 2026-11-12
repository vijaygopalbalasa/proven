import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EMAIL, FAKE_SHARE_HOST, HOME_LINUX, HOME_MAC, SESSIONS, SHARE_PATH, TM_HOST } from './patterns.js';

function gitBuf(dir, args) {
  return execFileSync('git', args, { cwd: dir, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Every (path, content) ever committed in the repo, across all commits and branches.
export function committedFiles(dir) {
  const commits = gitBuf(dir, ['rev-list', '--all']).toString().split('\n').filter(Boolean);
  const seen = new Map();
  for (const c of commits) {
    for (const line of gitBuf(dir, ['ls-tree', '-r', '-z', c]).toString().split('\0')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const [, type, id] = line.slice(0, tab).split(' ');
      const path = line.slice(tab + 1);
      if (type === 'blob' && !seen.has(`${id} ${path}`)) seen.set(`${id} ${path}`, { path, id });
    }
  }
  return [...seen.values()].map((f) => ({ path: f.path, text: gitBuf(dir, ['cat-file', 'blob', f.id]).toString('utf8') }));
}

// Look for private data in every committed file, with no exception: no Kane session ids, account ids or evidence
// ids, no emails, no home or temp paths, no share or Test Manager links.
export function findCommittedLeaks(dir, { calls = [] } = {}) {
  const banned = [
    [HOME_MAC, 'a home path'],
    [HOME_LINUX, 'a home path'],
    [dir, 'the repo path'],
    [realpathSync(tmpdir()), 'a temp path'],
    [SESSIONS, 'a Kane session folder'],
    [FAKE_SHARE_HOST, 'a share link'],
    [SHARE_PATH, 'a share link'],
    [TM_HOST, 'a Test Manager link'],
  ];
  for (const c of calls) {
    banned.push(
      [c.share_url, "this run's share link"],
      [c.session_dir, "this run's session folder"],
      [c.email, "the runner's email"],
      [c.session_id, 'a Kane session id'],
      [c.evidence_id, 'an evidence id'],
      ...(c.account_ids ?? []).map((id) => [id, 'a Kane account id']),
    );
  }
  const problems = [];
  for (const { path, text } of committedFiles(dir)) {
    if (path.endsWith('.evidence') || path.includes('.testmuai/')) problems.push(`${path}: an evidence pack or Kane folder`);
    if (/(^|\/)output-[^/]+\//.test(path)) problems.push(`${path}: Kane's recording`);
    if (EMAIL.test(text)) problems.push(`${path}: an email address`);
    for (const [needle, what] of banned) if (needle && text.includes(needle)) problems.push(`${path}: ${what}`);
  }
  return problems;
}
