import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../errors.js';
import { fileAt, head, short } from '../git.js';
import { earlierReceipts, receiptCommitAtHead, verifyReceipt } from '../receipt.js';
import { checkRedRecord, committedState, statusOf } from '../state.js';
import { parseTicket, ticketIds, ticketPaths } from '../ticket.js';

const LABELS = {
  new: 'Not frozen',
  frozen: 'Frozen',
  red: 'Red',
  'in-progress': 'In progress',
  done: 'Done',
  reopened: 'Reopened',
  'needs-a-person': 'Needs a person',
  'already-passes': 'Already passes',
};

function json(buf) {
  try {
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A Kane run in progress for this ticket, from .proven/runs/T-N/active.json (local, never committed).
function runningFor(root, id) {
  const file = join(root, '.proven', 'runs', id, 'active.json');
  if (!existsSync(file)) return null;
  const a = json(readFileSync(file));
  if (!a || !Number.isInteger(a.pid) || !alive(a.pid)) return null;
  const label = String(a.label ?? '');
  const attempt = /^attempt-(\d+)$/.exec(label);
  let text = 'Kane is running';
  if (label === 'red') text = 'Kane is running red';
  else if (attempt) text = `Kane is checking attempt ${attempt[1]}`;
  else if (label === 'recheck-replay') text = 'Kane is replaying it for proven recheck';
  else if (label === 'recheck-confirm') text = 'Kane is confirming with a fresh run';
  else if (label.startsWith('replay-')) text = `Kane is replaying the ${label.slice(7)} side for proven verify`;
  return { label, text, since: a.started_at ?? null };
}

function redPart(red) {
  if (!red) return null;
  return {
    commit: red.commit,
    step: red.failed_step,
    step_title: red.failed_step_title,
    one_liner: red.kane_one_liner,
    reason: red.kane_reason,
    credits: red.credits,
    duration_s: red.duration_s,
    kane: red.kane,
    kane_cli: red.kane_cli,
  };
}

// Everything the board shows for one ticket. The state comes only from Proven's own commits at HEAD, and done is
// shown only when the receipt verifies with git (Requirement 6.3).
export function ticketCard(root, id) {
  const p = ticketPaths(id);
  const ticketText = fileAt(root, 'HEAD', p.ticket)?.toString('utf8') ?? (existsSync(join(root, p.ticket)) ? readFileSync(join(root, p.ticket), 'utf8') : '');
  const card = {
    id,
    title: parseTicket(ticketText, id).title || '(no title)',
    state: 'new',
    label: LABELS.new,
    note: `A person fills in ${p.ticket} and runs proven freeze ${id}.`,
    problem: null,
    frozen_commit: null,
    max_attempts: null,
    attempts: 0,
    red: null,
    last_failure: null,
    reopened: null,
    green: null,
    receipt: null,
    running: runningFor(root, id),
  };
  const lock = json(fileAt(root, 'HEAD', p.lock));
  const { state, problem } = committedState(root, id);
  const needsPerson = (why) => Object.assign(card, { state: 'needs-a-person', label: LABELS['needs-a-person'], problem: why, note: why });
  if (problem) return needsPerson(problem);
  if (!lock) return card;

  card.frozen_commit = lock.frozen_commit;
  card.max_attempts = lock.settings?.max_attempts ?? null;
  const status = statusOf(state, lock);
  card.state = LABELS[status] ? status : 'needs-a-person';
  card.label = LABELS[card.state];
  if (status === 'frozen') {
    card.note = `Frozen. Next, a person runs proven red ${id}: Kane must fail the test on the code as it is.`;
    return card;
  }
  if (status === 'already-passes') {
    card.note = 'Kane passed this test before any change, so it proves nothing yet. A person sharpens the ticket and freezes it again.';
    return card;
  }
  if (!LABELS[status]) return needsPerson(`${p.state} has an unknown status "${status}".`);

  try {
    checkRedRecord(root, id, state, lock);
  } catch (err) {
    if (err instanceof Refusal) return needsPerson(err.message);
    throw err;
  }
  card.red = redPart(state.red);
  card.attempts = state.attempts ?? 0;
  if (state.last_failure && status !== 'done' && status !== 'reopened') {
    const f = state.last_failure;
    card.last_failure = { attempt: f.attempt, step: f.failed_step, step_title: f.failed_step_title, one_liner: f.kane_one_liner };
  }
  if (state.reopened) {
    const prev = state.reopened.previous ?? {};
    card.reopened = {
      at: state.red.commit,
      replay_one_liner: state.reopened.replay?.kane_one_liner ?? null,
      previous_receipt_sha256: prev.receipt_sha256 ?? null,
      previous_green: prev.green_commit ?? null,
    };
  }

  if (status === 'red') card.note = `Red. The agent works on the app and runs proven done ${id} when it believes the ticket is done.`;
  if (status === 'in-progress') {
    card.note = `The agent is working: ${card.attempts} failed ${card.attempts === 1 ? 'attempt' : 'attempts'} of ${card.max_attempts}. Kane decides each one.`;
  }
  if (status === 'needs-a-person') card.note = `Kane failed ${card.attempts} attempts. A person needs to look at ${id}.`;
  if (status === 'reopened') {
    card.note = `proven recheck reopened it at ${short(state.red.commit)}: a later change broke it, and a fresh run confirmed it. The agent fixes the app and runs proven done ${id}.`;
  }
  if (status !== 'done') return card;

  const at = receiptCommitAtHead(root, id);
  if (!at) return needsPerson(`${p.receipt} is not committed as Proven wrote it.`);
  const { receipt, checks } = verifyReceipt(root, at.bytes);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) return needsPerson(`The receipt does not verify: ${failed[0].name}: ${failed[0].detail}.`);
  card.green = {
    commit: receipt.green.commit,
    steps_passed: receipt.green.steps_passed,
    steps_total: receipt.green.steps_total,
    credits: receipt.green.credits,
    duration_s: receipt.green.duration_s,
    failed_attempts: receipt.green.failed_attempts,
    kane: receipt.green.kane,
  };
  const earlier = earlierReceipts(root, receipt);
  card.receipt = {
    path: p.receipt,
    sha256: receipt.receipt_sha256,
    commit: at.commit,
    checks: checks.length,
    closed: earlier.length + 1,
    earlier: earlier.map((e) => ({ sha256: e.receipt.receipt_sha256, red: e.receipt.red.commit, green: e.receipt.green.commit })),
  };
  const fake = [receipt.red.kane, receipt.green.kane].some((k) => k !== 'kane-cli');
  card.note = fake
    ? 'Done, but this receipt was not made with Kane CLI.'
    : `Done: the receipt verifies with git (${checks.length} checks).${earlier.length ? ` Closed ${earlier.length + 1} times: proven recheck reopened it before.` : ''}`;
  return card;
}

// The whole board. changeKey is cheap and tells the server when to build it again.
export function boardModel(root, { judge = false } = {}) {
  const tickets = ticketIds(root).map((id) => ticketCard(root, id));
  const counts = {};
  for (const t of tickets) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return { head: head(root), judge, tickets, counts };
}

export function changeKey(root) {
  const parts = [head(root) ?? 'none'];
  for (const id of ticketIds(root)) {
    for (const rel of [ticketPaths(id).ticket, `.proven/runs/${id}/active.json`]) {
      try {
        parts.push(`${rel}:${statSync(join(root, rel)).mtimeMs}`);
      } catch {}
    }
  }
  return parts.join('|');
}
