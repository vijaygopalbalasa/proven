import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { boardModel } from '../src/board/model.js';
import { startBoard } from '../src/board/server.js';
import { couponTicket, fixCoupon, freePort, greenRepo, makeRepo, PROVEN } from './support/helpers.js';

const card = (model, id) => model.tickets.find((t) => t.id === id);

async function withT2Red(repo) {
  repo.write('tickets/T-2.md', couponTicket(repo.url).replace('# T-1:', '# T-2:').replace('Coupon SAVE10 takes 10% off', 'Free shipping from $50'));
  assert.equal((await repo.run(['freeze', 'T-2'])).code, 0);
  const r = await repo.run(['red', 'T-2'], { scenario: 'red' });
  assert.equal(r.code, 0, r.stderr);
}

test('the board shows each ticket\'s state with its red and green evidence', async (t) => {
  const repo = await greenRepo(t);
  await withT2Red(repo);
  repo.write('tickets/T-3.md', '# T-3: Take coupon codes from coupons.json\n\nStart URL: \nLandmark: \n');

  let model = boardModel(repo.dir);
  assert.equal(model.head, repo.head());
  assert.deepEqual(model.tickets.map((x) => [x.id, x.state, x.label]), [
    ['T-1', 'done', 'Done'],
    ['T-2', 'red', 'Red'],
    ['T-3', 'new', 'Not frozen'],
  ]);
  const receipt = repo.json('receipts/T-1.json');
  const t1 = card(model, 'T-1');
  assert.equal(t1.title, 'Coupon SAVE10 takes 10% off');
  assert.deepEqual(t1.red, {
    commit: receipt.red.commit,
    step: 2,
    step_title: 'Apply SAVE10',
    one_liner: 'The cart accepts SAVE10, but applying it leaves the total at $20.00 instead of $18.00.',
    reason: receipt.red.kane_reason,
    credits: 22.45,
    duration_s: 54,
    kane: 'fake (PROVEN_KANE_BIN)',
    kane_cli: '0.10.4',
  });
  assert.equal(t1.green.commit, receipt.green.commit);
  assert.equal(t1.green.steps_total, 2);
  assert.deepEqual(t1.receipt, { path: 'receipts/T-1.json', sha256: receipt.receipt_sha256, commit: repo.git('log', '-1', '--format=%H', '--', 'receipts/T-1.json'), checks: 10, closed: 1, earlier: [] });
  assert.equal(t1.note, 'Done, but this receipt was not made with Kane CLI.');
  assert.equal(card(model, 'T-2').red.step, 2);
  assert.equal(card(model, 'T-2').green, null);
  assert.match(card(model, 'T-3').note, /^Written, not frozen yet\. When tickets\/T-3\.md is ready, a person runs proven freeze T-3\.$/);
  assert.deepEqual(model.counts, { done: 1, red: 1, new: 1 });

  // A failed attempt, then a Kane run in progress, which the board shows while it lasts.
  assert.equal((await repo.run(['done', 'T-2'], { scenario: 'red' })).code, 1);
  mkdirSync(join(repo.dir, '.proven/runs/T-2'), { recursive: true });
  writeFileSync(join(repo.dir, '.proven/runs/T-2/active.json'), JSON.stringify({ label: 'attempt-2', pid: process.pid, started_at: 'now' }));
  model = boardModel(repo.dir);
  const t2 = card(model, 'T-2');
  assert.equal(t2.state, 'in-progress');
  assert.deepEqual(t2.last_failure, { attempt: 1, step: 2, step_title: 'Apply SAVE10', one_liner: 'The cart accepts SAVE10, but applying it leaves the total at $20.00 instead of $18.00.' });
  assert.match(t2.note, /^The agent is working: 1 failed attempt of 4\./);
  assert.deepEqual(t2.running, { label: 'attempt-2', text: 'Kane is checking attempt 2', since: 'now' });
  writeFileSync(join(repo.dir, '.proven/runs/T-2/active.json'), JSON.stringify({ label: 'attempt-2', pid: 999999, started_at: 'now' }));
  assert.equal(card(boardModel(repo.dir), 'T-2').running, null, 'a run whose process is gone is not shown');
});

test('the board shows done only for a receipt that verifies, and state only from Proven\'s commits', async (t) => {
  const repo = await greenRepo(t);
  const good = repo.head();

  repo.write('receipts/T-1.json', repo.read('receipts/T-1.json').replace('"steps_passed": 2', '"steps_passed": 3'));
  repo.git('commit', '-q', '-am', 'Edit the receipt');
  let t1 = card(boardModel(repo.dir), 'T-1');
  assert.equal(t1.state, 'needs-a-person');
  assert.match(t1.problem, /^The receipt does not verify: the receipt hash matches its contents: /);
  assert.equal(t1.green, null);
  repo.git('reset', '-q', '--hard', good);

  repo.write('.proven/state/T-1.json', repo.read('.proven/state/T-1.json').replace('"attempts": 0', '"attempts": 1'));
  repo.write('demo/app/cart.js', repo.read('demo/app/cart.js') + '\n');
  repo.git('commit', '-q', '-am', 'Tidy up');
  t1 = card(boardModel(repo.dir), 'T-1');
  assert.equal(t1.state, 'needs-a-person');
  assert.match(t1.problem, /which Proven did not make/);
  repo.git('reset', '-q', '--hard', good);

  // An uncommitted edit to the receipt does not change the board: it reads commits.
  repo.write('receipts/T-1.json', '{}');
  assert.equal(card(boardModel(repo.dir), 'T-1').state, 'done');
});

test('the board shows a reopened ticket, then the second close with its earlier receipt', async (t) => {
  const repo = await greenRepo(t);
  const first = repo.json('receipts/T-1.json');
  repo.write('demo/app/cart.js', repo.read('demo/app/cart.js').replace('const coupons = { save10: 10 };', 'const coupons = { fall15: 15 };'));
  repo.git('commit', '-q', '-am', 'Take the codes from the autumn campaign');
  assert.equal((await repo.run(['recheck'], { scenario: ['red', 'red'] })).code, 1);

  let t1 = card(boardModel(repo.dir), 'T-1');
  assert.equal(t1.state, 'reopened');
  assert.equal(t1.label, 'Reopened');
  assert.equal(t1.red.commit, repo.git('rev-parse', 'HEAD~1'));
  assert.deepEqual(t1.reopened, {
    at: repo.git('rev-parse', 'HEAD~1'),
    first_run_one_liner: 'The cart accepts SAVE10, but applying it leaves the total at $20.00 instead of $18.00.',
    previous_receipt_sha256: first.receipt_sha256,
    previous_green: first.green.commit,
  });
  assert.match(t1.note, /^proven recheck reopened it at [0-9a-f]{7}: a later change broke it, and a fresh run confirmed it\./);

  repo.write('demo/app/cart.js', repo.read('demo/app/cart.js').replace('const coupons = { fall15: 15 };', 'const coupons = { save10: 10, fall15: 15 };'));
  assert.equal((await repo.run(['done', 'T-1'], { scenario: 'green' })).code, 0);
  t1 = card(boardModel(repo.dir), 'T-1');
  assert.equal(t1.state, 'done');
  assert.equal(t1.receipt.checks, 11);
  assert.equal(t1.receipt.closed, 2);
  assert.deepEqual(t1.receipt.earlier, [{ sha256: first.receipt_sha256, red: first.red.commit, green: first.green.commit }]);
});

// Read server-sent events from the board until one matches.
async function nextEvent(reader, state, match, timeoutMs = 60000) {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let cut;
    while ((cut = state.buffer.indexOf('\n\n')) >= 0) {
      const block = state.buffer.slice(0, cut);
      state.buffer = state.buffer.slice(cut + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (/^event: board$/m.test(block) && data) {
        const model = JSON.parse(data);
        if (match(model)) return model;
      }
    }
    // One read stays pending across waits, so no chunk is lost to the timeout.
    state.pending ??= reader.read();
    const result = await Promise.race([state.pending, new Promise((r) => setTimeout(() => r(null), 500))]);
    if (!result) continue;
    state.pending = null;
    if (result.done) throw new Error('the event stream ended');
    state.buffer += decoder.decode(result.value, { stream: true });
  }
  throw new Error('no matching board event in time');
}

test('proven board serves the page and updates it live over server-sent events when a commit changes a ticket', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);

  const port = await freePort();
  const board = spawn(process.execPath, [PROVEN, 'board', '--port', String(port), '--judge'], { cwd: repo.dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => board.kill('SIGKILL'));
  let printed = '';
  await new Promise((done, fail) => {
    board.stdout.on('data', (d) => {
      printed += d;
      if (printed.includes('kane-cli login.')) done();
    });
    board.once('exit', () => fail(new Error(`the board stopped: ${printed}`)));
  });
  assert.match(printed, new RegExp(`^Board: http://127\\.0\\.0\\.1:${port}/ {2}\\(Ctrl\\+C to stop\\)$`, 'm'));
  assert.match(printed, /New Kane runs \(proven red, proven done, proven verify --replay\) need Kane CLI .* and kane-cli login\./);
  const base = `http://127.0.0.1:${port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await page.text();
  assert.match(html, /<title>Proven board<\/title>/);
  assert.match(html, /Failed before the change/);
  assert.match(html, /Passed after/);
  assert.doesNotMatch(html, /(src|href)="https?:/, 'the page loads nothing from the network');
  const api = await (await fetch(`${base}/api/board`)).json();
  assert.equal(api.judge, true);
  assert.equal(card(api, 'T-1').state, 'frozen');
  assert.equal((await fetch(`${base}/receipts/T-1.json`)).status, 404);
  assert.equal((await fetch(`${base}/../tickets/T-1.md`)).status, 404);

  const events = await fetch(`${base}/events`);
  assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = events.body.getReader();
  const stream = { buffer: '' };
  await nextEvent(reader, stream, (m) => card(m, 'T-1')?.state === 'frozen');

  // The ticket goes red in another process; the board hears about it without a reload.
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);
  let model = await nextEvent(reader, stream, (m) => card(m, 'T-1')?.state === 'red');
  assert.equal(card(model, 'T-1').red.one_liner, 'The cart accepts SAVE10, but applying it leaves the total at $20.00 instead of $18.00.');

  fixCoupon(repo);
  assert.equal((await repo.run(['done', 'T-1'], { scenario: 'green' })).code, 0);
  model = await nextEvent(reader, stream, (m) => card(m, 'T-1')?.state === 'done');
  assert.equal(card(model, 'T-1').receipt.checks, 10);
  const receipt = await fetch(`${base}/receipts/T-1.json`);
  assert.equal(receipt.status, 200);
  assert.equal(await receipt.text(), readFileSync(join(repo.dir, 'receipts/T-1.json'), 'utf8'));
  await reader.cancel();

  const exited = new Promise((done) => board.once('exit', (code) => done(code)));
  board.kill('SIGTERM');
  assert.equal(await exited, 0);
});

// One raw request, so the test can send any Host and Origin header.
function raw(port, path, headers, { setHost = true } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers, setHost }, (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode));
    });
    req.on('error', fail);
    req.end();
  });
}

test('the board answers only to localhost: another Host gets 421 and another Origin gets 403', async (t) => {
  const repo = await makeRepo(t);
  const board = await startBoard(repo.dir, { port: 0 });
  t.after(() => board.close());
  const port = board.port;
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    assert.equal(await raw(port, '/', { Host: host }), 200, host);
  }
  // A page on another name that resolves to this machine (DNS rebinding) sends its own name as Host.
  for (const host of [`evil.example:${port}`, `localhost:${port + 1}`, 'localhost', `127.0.0.1.nip.example:${port}`]) {
    assert.equal(await raw(port, '/api/board', { Host: host }), 421, host);
  }
  // With no Host header at all, Node's HTTP server refuses the request itself (400), before the board sees it.
  assert.equal(await raw(port, '/', {}, { setHost: false }), 400, 'no Host header');
  for (const origin of ['http://evil.example', `http://localhost:${port + 1}`, `https://localhost:${port}`, 'null']) {
    assert.equal(await raw(port, '/events', { Host: `localhost:${port}`, Origin: origin }), 403, origin);
  }
  assert.equal(await raw(port, '/api/board', { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` }), 200);
  assert.equal(await raw(port, '/api/board', { Host: `localhost:${port}`, Origin: `http://localhost:${port}` }), 200);
});

test('the board listens on 127.0.0.1 only', async (t) => {
  const repo = await makeRepo(t);
  const board = await startBoard(repo.dir, { port: 0 });
  t.after(() => board.close());
  const reached = await new Promise((done) => {
    const socket = connect({ host: '::1', port: board.port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
  assert.equal(reached, false);
});
