import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../errors.js';
import { assertOnlyPaths, commitPaths, short } from '../git.js';
import { canonicalJson, sha256 } from '../hash.js';
import { readLock } from '../lock.js';
import { readState, statusOf, writeJson } from '../state.js';
import { checkId, parseTicket, renderTest, ticketPaths, ticketProblems } from '../ticket.js';

// proven freeze T-N: write the test, commit ticket + test as F, then the lock naming F in its own commit.
export async function cmdFreeze({ root, out }, [id]) {
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

  const oldLock = readLock(root, id);
  if (oldLock) {
    const status = statusOf(readState(root, id), oldLock);
    if (status === 'done') throw new Refusal(`${id} is done and its receipt stays as it is. Write a new ticket for new work.`);
    if (status === 'red' || status === 'in-progress') {
      throw new Refusal(`${id} is red and the agent may be working on it. Freezing it again now would move the goalposts.`);
    }
  }

  const testText = renderTest(ticket);
  writeFileSync(join(root, p.test), testText);

  const f = commitPaths(root, { paths: [p.ticket, p.test], message: `${id}: freeze ticket and test` });
  if (f.created) assertOnlyPaths(root, f.commit, [p.ticket, p.test]);

  const lock = {
    ticket: id,
    ticket_path: p.ticket,
    ticket_sha256: sha256(ticketBuf),
    test_path: p.test,
    test_sha256: sha256(testText),
    frozen_commit: f.commit,
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
