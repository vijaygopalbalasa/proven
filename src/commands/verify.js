import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { FAKE_LABEL } from '../config.js';
import { Refusal } from '../errors.js';
import { findRoot } from '../git.js';
import { verifyReceipt } from '../receipt.js';
import { replayReceipt } from '../replay.js';

// proven verify receipts/T-N.json [--replay]: re-check a receipt with git only, no network. With --replay, Kane also
// runs the frozen test again with the app as it was at red (it must fail at the recorded step) and at green (it must
// pass). When Kane does not run (signed out, no network, time limit), the git result stands.
export async function cmdVerify({ cwd, out }, [file], flags) {
  if (!file) throw new Refusal('Give a receipt to check: proven verify receipts/T-1.json');
  const abs = resolve(cwd, file);
  if (!existsSync(abs)) throw new Refusal(`${file} was not found.`);
  const root = findRoot(dirname(abs));
  const rel = relative(root, abs).split('\\').join('/');
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Refusal(`${file} is not inside a git repository.`);

  const { receipt, checks } = verifyReceipt(root, readFileSync(abs));
  let ok = checks.every((c) => c.ok);

  let replay = null;
  if (flags.replay) {
    replay = ok
      ? await replayReceipt({ root, out }, receipt)
      : { lines: [{ status: 'skip', text: 'replay skipped: the git checks failed, so the commits in this receipt are not trusted' }], agreed: null };
    if (replay.agreed === false) ok = false;
  }

  // Integrity and provenance are separate: a receipt made with the test-only fake Kane can verify,
  // but it must never read as Kane CLI evidence.
  const kanes = receipt ? [receipt.red.kane ?? 'unknown', receipt.green.kane ?? 'unknown'] : [];
  let caveat = '';
  if (kanes.some((k) => k === FAKE_LABEL)) caveat = ', but made with a fake Kane, not Kane CLI';
  else if (kanes.some((k) => k !== 'kane-cli')) caveat = ', but it does not show that Kane CLI made it';
  out.say(`${ok ? 'CONFIRMED' : 'MISMATCH'} ${rel}${caveat}`);
  for (const c of checks) out.say(c.ok ? `  ok    ${c.name}` : `  FAIL  ${c.name}: ${c.detail}`);
  if (replay) {
    for (const line of replay.lines) {
      out.say(`  ${line.status === 'fail' ? 'FAIL' : line.status.padEnd(4)}  ${line.text}`);
      if (line.more) out.say(`        ${line.more}`);
    }
  }
  if (caveat) out.say(`  note  red ran on ${kanes[0]}, green ran on ${kanes[1]}`);
  // A later close starts from a reopen, which only Proven's own commits vouch for, so git alone is weaker there.
  if (receipt?.previous !== undefined && replay?.agreed !== true) {
    out.say('  note  this receipt follows a reopen by proven recheck: re-check it with --replay for full assurance');
  }
  if (replay) {
    if (replay.agreed === true) out.say('Kane ran the frozen test again: it failed without the change and passed with it.');
    else if (replay.agreed === null) out.say(ok ? 'Kane did not run again, so the git checks stand.' : 'Kane did not run again.');
    else out.say('Kane does not agree with this receipt.');
  }
  return ok ? 0 : 1;
}
