import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from './errors.js';

export const ID_RE = /^T-[1-9][0-9]*$/;
export const LANDMARK_STEP_TITLE = 'Open the start page';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function checkId(id) {
  if (!id || !ID_RE.test(id)) throw new Refusal(`"${id ?? ''}" is not a ticket id. Use T-1, T-2 and so on.`);
}

// Ticket ids that have a ticket, state or receipt file here, in number order.
export function ticketIds(root) {
  const ids = new Set();
  for (const dir of ['tickets', '.proven/state', 'receipts']) {
    let names = [];
    try {
      names = readdirSync(join(root, dir));
    } catch {}
    for (const name of names) {
      const m = /^(T-[1-9][0-9]*)(?:\.md|\.lock\.json|\.json)$/.exec(name);
      if (m) ids.add(m[1]);
    }
  }
  return [...ids].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

export function ticketPaths(id) {
  return {
    ticket: `tickets/${id}.md`,
    test: `tickets/${id}_test.md`,
    lock: `tickets/${id}.lock.json`,
    state: `.proven/state/${id}.json`,
    receipt: `receipts/${id}.json`,
  };
}

export function renderTicketTemplate({ id, title, url = '', landmark = '' }) {
  return `# ${id}: ${title}

Start URL: ${url}
Landmark: ${landmark}

## Acceptance criteria

<!--
Add one ### block per criterion: a short title, then plain steps.
End each criterion with a Verify line that Kane can check on screen.
Name the exact labels the feature will show (a button's text, a heading).
Check the lasting state of the page, not a message that disappears after a moment.
One action per step: type here, click there, then the Verify line.
Step 1, the landmark check, is added for you.
Read Kane's words at red before you start the agent: a red can fail for a different reason than the one you meant. Example:

### Apply SAVE10
Type SAVE10 in the coupon field and click Apply.
Verify the order total shows $27.50.
-->

## Notes

`;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) return t.slice(1, -1).trim();
  return t;
}

// Parse a ticket. Never throws; problems are listed for freeze to report.
export function parseTicket(text, id) {
  const clean = String(text).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = clean.split('\n');

  let title = '';
  const titleLine = lines.find((l) => /^#\s+\S/.test(l));
  if (titleLine) {
    title = titleLine.replace(/^#\s+/, '').trim();
    const prefix = new RegExp(`^${id}\\s*:\\s*`);
    if (id && prefix.test(title)) title = title.replace(prefix, '').trim();
  }

  const url = unquote(/^start url:[ \t]*(.*)$/im.exec(clean)?.[1] ?? '');
  const landmark = unquote(/^landmark:[ \t]*(.*)$/im.exec(clean)?.[1] ?? '');

  const criteria = [];
  const stray = [];
  const start = lines.findIndex((l) => /^##\s+acceptance criteria\s*$/i.test(l));
  if (start >= 0) {
    let current = null;
    for (const line of lines.slice(start + 1)) {
      if (/^##\s/.test(line)) break;
      const heading = /^###\s+(.*\S)\s*$/.exec(line);
      if (heading) {
        current = { title: heading[1], lines: [] };
        criteria.push(current);
      } else if (line.trim()) {
        if (current) current.lines.push(line.trim());
        else stray.push(line.trim());
      }
    }
  }

  return { id, title, url, landmark, criteria, stray, hasCriteriaSection: start >= 0 };
}

// What stops a freeze. `missing` names absent parts; `problems` are other fixes.
export function ticketProblems(t) {
  const missing = [];
  const problems = [];
  if (!t.title) missing.push('a title (the first line, # T-N: title)');
  if (!t.url) missing.push('a start URL');
  else {
    let u = null;
    try {
      u = new URL(t.url);
    } catch {}
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) problems.push(`The start URL "${t.url}" must start with http:// or https://.`);
    else if (/\s/.test(t.url)) problems.push('The start URL cannot contain spaces.');
    else if (u.protocol !== 'http:' || !LOCAL_HOSTS.includes(u.hostname) || !u.port) {
      problems.push(
        'The start URL must be a local address with a port, like http://localhost:8091/. Proven serves the app folder itself while Kane runs, so for now the app must be static files.',
      );
    }
  }
  if (!t.landmark) missing.push('a landmark');
  else if (t.landmark.includes('"')) problems.push('The landmark cannot contain double quotes.');
  if (!t.criteria.length) missing.push('acceptance criteria');
  if (t.stray.length) problems.push('Under "## Acceptance criteria", put each criterion under its own ### heading.');
  t.criteria.forEach((c, i) => {
    const name = `Criterion ${i + 1} (${c.title})`;
    if (!c.lines.length) problems.push(`${name} has no steps.`);
    else if (!/^verify\b/i.test(c.lines.at(-1))) problems.push(`${name} must end in a Verify line that Kane can check on screen.`);
    if (c.lines.some((l) => l.startsWith('#'))) problems.push(`${name} has a line starting with #.`);
  });
  return { missing, problems };
}

export function renderTest(t) {
  const parts = [
    '---',
    'mode: testing',
    '---',
    '',
    `# ${t.id}: ${t.title}`,
    '',
    `## ${LANDMARK_STEP_TITLE}`,
    `Open ${t.url}`,
    `Verify the text "${t.landmark}" is shown on the page.`,
  ];
  for (const c of t.criteria) parts.push('', `## ${c.title}`, ...c.lines);
  return parts.join('\n') + '\n';
}

// The steps of a Kane test file: [{ index, title, lines }].
export function parseTestSteps(text) {
  let body = String(text).replace(/\r\n?/g, '\n');
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 4);
    if (end >= 0) body = body.slice(body.indexOf('\n', end + 1) + 1);
  }
  const steps = [];
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.*\S)\s*$/.exec(line);
    if (heading && !line.startsWith('###')) steps.push({ index: steps.length + 1, title: heading[1], lines: [] });
    else if (steps.length && line.trim()) steps.at(-1).lines.push(line.trim());
  }
  return steps;
}

export function startUrlOf(steps) {
  const first = steps[0];
  const open = first?.lines.map((l) => /^Open\s+(\S+)\s*$/.exec(l)).find(Boolean);
  return open ? open[1] : null;
}
