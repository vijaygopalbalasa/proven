import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DEMO, fixCoupon, makeRepo } from './support/helpers.js';
import { findCommittedLeaks } from './support/scan.js';

// The demo tickets as committed, pointed at this test's port.
const ticket = (repo, id) => readFileSync(join(FIXTURE_DEMO, 'tickets', `${id}.md`), 'utf8').replace('http://localhost:8091/', repo.url);

// T-3's natural fix: the cart takes exactly the codes in coupons.json. SAVE10 is not in that file.
function takeCodesFromFile(repo) {
  const text = repo.read('demo/app/cart.js');
  const changed = text.replace(
    'const coupons = { save10: 10 };',
    "let coupons = {};\nfetch('coupons.json')\n  .then((res) => res.json())\n  .then((data) => {\n    coupons = Object.fromEntries(data.codes.map((c) => [c.code.toLowerCase(), c.percent_off]));\n  });",
  );
  assert.notEqual(changed, text);
  repo.write('demo/app/cart.js', changed);
}

test('the demo story: T-3\'s natural fix breaks T-1, recheck reopens it, and the agent fixes it again', async (t) => {
  const repo = await makeRepo(t);
  const run = async (args, scenario, code = 0) => {
    const r = await repo.run(args, { scenario });
    assert.equal(r.code, code, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    return r;
  };
  assert.equal(repo.exists('demo/app/coupons.json'), true);

  repo.write('tickets/T-1.md', ticket(repo, 'T-1'));
  await run(['freeze', 'T-1']);
  await run(['red', 'T-1'], 'red');
  fixCoupon(repo);
  await run(['done', 'T-1'], 'green');

  repo.write('tickets/T-3.md', ticket(repo, 'T-3'));
  await run(['freeze', 'T-3']);
  assert.match(repo.read('tickets/T-3_test.md'), /\n## Apply FALL15\nType FALL15 in the coupon field and click Apply\.\nVerify the order total shows \$26\.25\.\n$/);
  await run(['red', 'T-3'], 'red');
  takeCodesFromFile(repo);
  await run(['done', 'T-3'], 'green');

  // Kane fails T-1, a second fresh run confirms it, and T-1 reopens. T-3 still passes.
  let r = await run(['recheck'], ['red', 'red', 'green'], 1);
  assert.match(r.stdout, /^T-1 reopened at [0-9a-f]{7}: Kane failed step 2 \(Apply SAVE10\) on the second run too\.$/m);
  assert.match(r.stdout, /^T-3 still passes: Kane ran its frozen test fresh on [0-9a-f]{7}\.$/m);
  assert.equal(repo.json('.proven/state/T-1.json').status, 'reopened');
  assert.equal(repo.json('.proven/state/T-3.json').status, 'done');

  // The agent fixes T-1 again by putting SAVE10 into coupons.json, and T-1 closes with a linked receipt.
  const codes = repo.json('demo/app/coupons.json');
  codes.codes.push({ code: 'SAVE10', percent_off: 10 });
  repo.write('demo/app/coupons.json', JSON.stringify(codes, null, 2) + '\n');
  await run(['done', 'T-1'], 'green');
  assert.ok(repo.json('receipts/T-1.json').previous);
  r = await run(['recheck'], ['green', 'green']);
  assert.match(r.stdout, /^Every done ticket still passes\.$/m);
  for (const id of ['T-1', 'T-3']) {
    r = await run(['verify', `receipts/${id}.json`]);
    assert.match(r.stdout, new RegExp(`^CONFIRMED receipts/${id}\\.json`, 'm'));
  }
  assert.deepEqual(findCommittedLeaks(repo.dir, { calls: repo.kaneCalls() }), []);
});
