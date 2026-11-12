import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingsOf } from '../config.js';
import { Refusal } from '../errors.js';
import { assertOnlyPaths, commitPaths, fileAt, resolveCommit, short } from '../git.js';
import { canonicalJson, sha256 } from '../hash.js';
import { readLock, settingsSha } from '../lock.js';
import { loadState, statusOf, writeJson } from '../state.js';
import { checkId, parseTicket, renderTest, ticketPaths, ticketProblems } from '../ticket.js';

// proven freeze T-N: write the test, commit ticket + test as F, then the lock naming F in its own commit.
// The lock also pins the settings that shape verdicts (app folder, time limit, attempt limit, start URL).
export async function cmdFreeze({ root, config, out }, [id]) {
  checkId(id);
  const p = ticketPaths(id);
  const ticketFile = join(root, p.ticket);
  if (!existsSync(ticketFile)) throw new Refusal(`${p.ticket} does not exist. Run proven new ${id} "<title>" first.`);

  const ticketBuf = readFileSync(ticketFile);
  const ticket = parseTicket(ticketBuf.toString('utf8'), id);
  const { missing, problems } = ticketProblems(ticket);
  if (missing.length || problems.length) {
    const lines = [`proven freeze ${id} refused.`];
    if (missing.length) lines.push(`${p.ticket} is missing: ${missing.join(', ')}.`);
    lines.push(...problems);
    throw new Refusal(lines.join('\n'));
  }

  let oldLock = null;
  try {
    oldLock = readLock(root, id);
  } catch {
    oldLock = null;
  }
  const state = loadState(root, id);
  const status = oldLock ? statusOf(state, oldLock) : (state?.status ?? 'new');
  if (status === 'done') throw new Refusal(`${id} is done and its receipt stays as it is. Write a new ticket for new work.`);
  if (status === 'red' || status === 'in-progress') {
    throw new Refusal(`${id} is red and the agent may be working on it. Freezing it again now would move the goalposts.`);
  }

  const testText = renderTest(ticket);
  const ticketSha = sha256(ticketBuf);
  const testSha = sha256(testText);
  const settings = settingsOf(config, ticket.url);

  // Same ticket, same test, same settings, and the lock's commit still holds them: nothing to do.
  if (oldLock && oldLock.ticket_sha256 === ticketSha && oldLock.test_sha256 === testSha && oldLock.settings_sha256 === settingsSha(settings)) {
    const F = resolveCommit(root, oldLock.frozen_commit);
    const atF = F && fileAt(root, F, p.test);
    const testNow = existsSync(join(root, p.test)) ? readFileSync(join(root, p.test)) : null;
    if (atF && sha256(atF) === testSha && testNow && sha256(testNow) === testSha) {
      out.say(`${id} is already frozen at ${short(F)}. Nothing changed.`);
      return 0;
    }
  }

  writeFileSync(join(root, p.test), testText);
  const f = commitPaths(root, { paths: [p.ticket, p.test], message: `${id}: freeze ticket and test` });
  if (f.created) assertOnlyPaths(root, f.commit, [p.ticket, p.test]);

  const lock = {
    ticket: id,
    ticket_path: p.ticket,
    ticket_sha256: ticketSha,
    test_path: p.test,
    test_sha256: testSha,
    frozen_commit: f.commit,
    settings,
    settings_sha256: settingsSha(settings),
  };
  if (oldLock && canonicalJson(oldLock) === canonicalJson(lock)) {
    out.say(`${id} is already frozen at ${short(f.commit)}. Nothing changed.`);
    return 0;
  }
  writeJson(root, p.lock, lock);
  const l = commitPaths(root, { paths: [p.lock], message: `${id}: lock frozen test (F ${short(f.commit)})` });
  assertOnlyPaths(root, l.commit, [p.lock]);

  out.say(`Frozen ${id}: ticket and test in ${short(f.commit)}, lock in ${short(l.commit)}.`);
  out.say(`${p.test} has ${ticket.criteria.length + 1} steps: the landmark check, then ${ticket.criteria.length} criteria.`);
  out.say(`Next: start the app, then run proven red ${id}`);
  return 0;
}
