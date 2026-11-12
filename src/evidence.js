import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { sha256 } from './hash.js';
import { readZip } from './zip.js';

// Kane copies each sealed pack to .testmuai/evidence/<id>.evidence under the folder it ran in.
// Proven looks there, then next to the test, then at the pack path Kane reports in its coverage event.
export function findPack(root, testRel, { evidenceId, packPath }) {
  const candidates = [];
  if (evidenceId && /^[A-Za-z0-9._-]+$/.test(evidenceId)) {
    candidates.push(join(root, '.testmuai', 'evidence', `${evidenceId}.evidence`));
    candidates.push(join(root, dirname(testRel), '.testmuai', 'evidence', `${evidenceId}.evidence`));
  }
  if (packPath && isAbsolute(packPath) && packPath.endsWith('.evidence')) candidates.push(packPath);
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

export function fileSha256(path) {
  return sha256(readFileSync(path));
}

// For printing only. Pack paths are never stored.
export function displayPath(root, path) {
  const rel = relative(root, path);
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  const home = homedir();
  return home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

function unquote(s) {
  const t = String(s ?? '').trim();
  return t.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

// The root failure.yaml lists failures as "- key: value" items.
function failureItems(yaml) {
  const items = [];
  let current = null;
  let inList = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^failures:/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (/^\S/.test(line)) break;
    const first = /^\s*-\s+([\w-]+):\s*(.*)$/.exec(line);
    if (first) {
      current = { [first[1]]: unquote(first[2]) };
      items.push(current);
      continue;
    }
    const kv = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (current && kv) current[kv[1]] = unquote(kv[2]);
  }
  return items;
}

// The failing step's screenshot inside the pack: { inner, data } or null.
// Kane names step folders <ordinal>-<step index - 1>-<sub step>.
export function failingScreenshot(packPath, stepIndex) {
  const zip = readZip(readFileSync(packPath));
  const flow = String(stepIndex - 1);
  let inner = null;

  const rootYaml = zip.read('failure.yaml');
  if (rootYaml) {
    const items = failureItems(rootYaml.toString('utf8'));
    const match = items.find((i) => String(i.step ?? '').split('-')[0] === flow) ?? (items.length === 1 ? items[0] : null);
    if (match?.path && zip.has(match.path)) {
      const per = zip.read(match.path).toString('utf8');
      const shot = /^\s*screenshot:\s*(\S+)\s*$/m.exec(per)?.[1];
      const cut = match.path.indexOf('/steps/');
      if (shot && cut >= 0) {
        const candidate = match.path.slice(0, cut + 1) + unquote(shot);
        if (zip.has(candidate)) inner = candidate;
      }
    }
  }
  if (!inner) {
    const re = new RegExp(`^tests/[^/]+/steps/(\\d+)-${flow}-\\d+/screenshot\\.(?:jpg|jpeg|png)$`);
    let best = -1;
    for (const name of zip.names) {
      const m = re.exec(name);
      if (m && Number(m[1]) > best) {
        best = Number(m[1]);
        inner = name;
      }
    }
  }
  if (!inner) return null;
  return { inner, data: zip.read(inner) };
}

// Save a copy of the screenshot under .proven/runs/ (gitignored) so the agent can open it.
export function saveScreenshot(root, id, label, stepIndex, shot) {
  const ext = extname(shot.inner) || '.jpg';
  const rel = `.proven/runs/${id}/${label}-step-${stepIndex}${ext}`;
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, shot.data);
  return rel;
}
