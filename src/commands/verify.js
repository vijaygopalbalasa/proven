import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { FAKE_LABEL } from '../config.js';
import { Refusal } from '../errors.js';
import { findRoot } from '../git.js';
import { verifyReceipt } from '../receipt.js';

// proven verify receipts/T-N.json: re-check a receipt with git only, no network.
export async function cmdVerify({ cwd, out }, [file], flags) {
  if (flags.replay) {
    out.warn('proven verify --replay is not built yet. Run proven verify without --replay for the git checks.');
    return 2;
  }
  if (!file) throw new Refusal('Give a receipt to check: proven verify receipts/T-1.json');
  const abs = resolve(cwd, file);
  if (!existsSync(abs)) throw new Refusal(`${file} was not found.`);
  const root = findRoot(dirname(abs));
  const rel = relative(root, abs).split('\\').join('/');
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Refusal(`${file} is not inside a git repository.`);

  const { receipt, checks } = verifyReceipt(root, readFileSync(abs), rel);
  const ok = checks.every((c) => c.ok);
  // Integrity and provenance are separate: a receipt made with the test-only fake Kane can verify,
  // but it must never read as Kane CLI evidence.
  const kanes = receipt ? [receipt.red.kane ?? 'unknown', receipt.green.kane ?? 'unknown'] : [];
  let caveat = '';
  if (kanes.some((k) => k === FAKE_LABEL)) caveat = ', but made with a fake Kane, not Kane CLI';
  else if (kanes.some((k) => k !== 'kane-cli')) caveat = ', but it does not show that Kane CLI made it';
  out.say(`${ok ? 'CONFIRMED' : 'MISMATCH'} ${rel}${caveat}`);
  for (const c of checks) out.say(c.ok ? `  ok    ${c.name}` : `  FAIL  ${c.name}: ${c.detail}`);
  if (caveat) out.say(`  note  red ran on ${kanes[0]}, green ran on ${kanes[1]}`);
  return ok ? 0 : 1;
}
