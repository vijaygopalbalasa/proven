import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeSection } from '../src/commands/init.js';
import { ROOT } from './support/helpers.js';

const section = claudeSection({ proven: 'node bin/proven.js', app: 'demo/app', maxAttempts: 4 });

test('the CLAUDE.md snippet tells the agent only what it can do: read, edit the app, run proven done', () => {
  assert.doesNotMatch(section, /node bin\/proven\.js (recheck|verify)/);
  assert.match(section, /read files, edit the app with your edit tools, and run `node bin\/proven\.js done T-N`/);
  assert.match(section, /Fix the app, never the test\. After 4 failed attempts the ticket needs a person, so stop there\./);
  assert.match(section, /Exit 0 means done/);
  assert.match(section, /Exit 1 means Kane failed/);
  assert.match(section, /Exit 2 means Kane did not run/);
  assert.match(section, /proven loop/);
  assert.match(section, /person's \(or proven loop's\) job/);
});

test('the committed CLAUDE.md carries the same section', () => {
  const committed = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.ok(committed.includes(section), 'CLAUDE.md in the repository is not what proven init writes');
});
