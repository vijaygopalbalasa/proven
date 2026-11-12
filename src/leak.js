// Guards against writing personal or private data into files Proven commits:
// emails, home and temp paths, Kane session folders, share and Test Manager links, and ids from the current run.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const HOME_RE = /(?:\/Users\/|\/home\/)[^\s"'`<>/\\]+/g;
const WIN_HOME_RE = /[A-Za-z]:\\Users\\[^\s"'`<>\\]+/g;
const TEMP_RE = /(?:\/private)?\/var\/folders\/[^\s"'`<>]*/g;
const LINK_RE = /https?:\/\/[^\s"'`<>]*(?:lambdatest\.com|\/share\/)[^\s"'`<>]*/gi;
const SESSIONS_RE = /\.testmuai\/kaneai\/sessions\/[^\s"'`<>]*/g;

const PATTERNS = [
  ['a share or Test Manager link', LINK_RE],
  ['a Kane session folder', SESSIONS_RE],
  ['a temp folder path', TEMP_RE],
  ['a home folder path', HOME_RE],
  ['a home folder path', WIN_HOME_RE],
  ['an email address', EMAIL_RE],
];

function usable(exact) {
  return [...new Set((exact ?? []).filter((s) => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length);
}

export function findLeaks(text, { exact } = {}) {
  const s = String(text ?? '');
  const found = [];
  for (const value of usable(exact)) {
    if (s.includes(value)) found.push({ kind: 'an id or link from this Kane run', sample: value.slice(0, 8) + '...' });
  }
  for (const [kind, re] of PATTERNS) {
    for (const m of s.matchAll(re)) found.push({ kind, sample: m[0].slice(0, 16) + '...' });
  }
  return found;
}

export function scrubText(text, { exact } = {}) {
  let s = String(text ?? '');
  for (const value of usable(exact)) s = s.split(value).join('<hidden>');
  return s
    .replace(LINK_RE, '<link>')
    .replace(SESSIONS_RE, '<kane session>')
    .replace(TEMP_RE, '<temp>')
    .replace(HOME_RE, '~')
    .replace(WIN_HOME_RE, '~')
    .replace(EMAIL_RE, '<email>');
}

export function assertClean(text, what, { exact } = {}) {
  const leaks = findLeaks(text, { exact });
  if (leaks.length) {
    const kinds = [...new Set(leaks.map((l) => l.kind))].join(', ');
    throw new Error(`refusing to write ${what}: it would hold ${kinds}`);
  }
}
