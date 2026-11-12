import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { parseTestSteps, parseTicket, renderTest, renderTicketTemplate, startUrlOf, ticketProblems, checkId } from '../src/ticket.js';
import { ROOT } from './support/helpers.js';

const good = `# T-1: Coupon SAVE10 takes 10% off

Start URL: http://localhost:8091/
Landmark: Your cart

## Acceptance criteria

### Apply SAVE10
Type SAVE10 in the coupon field and click Apply.
Verify the order total shows $27.50.

### Keep shipping
Verify shipping still shows $5.00.

## Notes

### Not a criterion
Notes can have their own headings.
`;

test('a filled ticket parses into title, start URL, landmark and criteria', () => {
  const t = parseTicket(good, 'T-1');
  assert.equal(t.title, 'Coupon SAVE10 takes 10% off');
  assert.equal(t.url, 'http://localhost:8091/');
  assert.equal(t.landmark, 'Your cart');
  assert.deepEqual(t.criteria, [
    { title: 'Apply SAVE10', lines: ['Type SAVE10 in the coupon field and click Apply.', 'Verify the order total shows $27.50.'] },
    { title: 'Keep shipping', lines: ['Verify shipping still shows $5.00.'] },
  ]);
  assert.deepEqual(ticketProblems(t), { missing: [], problems: [] });
});

test('the skeleton from proven new is missing a start URL, a landmark and criteria', () => {
  const t = parseTicket(renderTicketTemplate({ id: 'T-3', title: 'Something' }), 'T-3');
  assert.equal(t.title, 'Something');
  assert.deepEqual(ticketProblems(t).missing, ['a start URL', 'a landmark', 'acceptance criteria']);
});

test('the example inside the template comment is not taken as a criterion', () => {
  const t = parseTicket(renderTicketTemplate({ id: 'T-3', title: 'x', url: 'http://localhost:8091/', landmark: 'Your cart' }), 'T-3');
  assert.equal(t.criteria.length, 0);
});

test('freeze problems name each fix', () => {
  const t = parseTicket(
    `# T-2: x\nStart URL: localhost:8091\nLandmark: Say "hi"\n\n## Acceptance criteria\nloose line\n\n### No check\nClick Apply.\n\n### Empty\n`,
    'T-2',
  );
  const { missing, problems } = ticketProblems(t);
  assert.deepEqual(missing, []);
  assert.ok(problems.some((p) => p.includes('must start with http:// or https://')));
  assert.ok(problems.some((p) => p.includes('cannot contain double quotes')));
  assert.ok(problems.some((p) => p.includes('its own ### heading')));
  assert.ok(problems.some((p) => p.includes('Criterion 1 (No check) must end in a Verify line')));
  assert.ok(problems.some((p) => p.includes('Criterion 2 (Empty) has no steps')));
});

test('the frozen test opens the start URL and checks the landmark first, then one step per criterion', () => {
  const text = renderTest(parseTicket(good, 'T-1'));
  assert.equal(
    text,
    `---
mode: testing
---

# T-1: Coupon SAVE10 takes 10% off

## Open the start page
Open http://localhost:8091/
Verify the text "Your cart" is shown on the page.

## Apply SAVE10
Type SAVE10 in the coupon field and click Apply.
Verify the order total shows $27.50.

## Keep shipping
Verify shipping still shows $5.00.
`,
  );
  const steps = parseTestSteps(text);
  assert.deepEqual(steps.map((s) => s.title), ['Open the start page', 'Apply SAVE10', 'Keep shipping']);
  assert.equal(startUrlOf(steps), 'http://localhost:8091/');
});

test('the demo tickets and the demo config are ready for the live gate', () => {
  assert.deepEqual(loadConfig(ROOT), { app: 'demo/app', timeoutS: 300, maxAttempts: 4 });
  for (const id of ['T-1', 'T-2']) {
    const t = parseTicket(readFileSync(join(ROOT, 'tickets', `${id}.md`), 'utf8'), id);
    assert.deepEqual(ticketProblems(t), { missing: [], problems: [] }, id);
    assert.equal(t.url, 'http://localhost:8091/');
    assert.equal(t.landmark, 'Your cart');
    assert.equal(parseTestSteps(renderTest(t)).length, 2, id);
  }
});

test('ticket ids look like T-1', () => {
  assert.doesNotThrow(() => checkId('T-12'));
  for (const bad of ['t-1', 'T-0', 'T1', 'T-1a', '../T-1', undefined]) assert.throws(() => checkId(bad), /not a ticket id/);
});
