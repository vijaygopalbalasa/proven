import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, hashEntries, sha256 } from '../src/hash.js';
import { findLeaks, scrubText } from '../src/leak.js';
import { kaneCommand, loadConfig, settingsOf } from '../src/config.js';
import { commitPaths, dirtyPaths } from '../src/git.js';
import { readZip } from '../src/zip.js';
import { failingScreenshot } from '../src/evidence.js';
import { probe } from '../src/probe.js';
import { startServer } from '../demo/server.js';
import { writeZip } from './support/zip-writer.js';
import { git, TEST_EMAIL } from './support/helpers.js';
import { HOME_MAC, SESSIONS } from './support/patterns.js';

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'proven-core-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('canonical JSON sorts keys at every level and ignores spacing', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(sha256(canonicalJson({ x: 1, y: 2 })), sha256(canonicalJson({ y: 2, x: 1 })));
  assert.throws(() => canonicalJson({ n: NaN }));
});

test('a folder hash depends on paths and contents, not on order', () => {
  const a = hashEntries([{ path: 'a.txt', content: Buffer.from('1') }, { path: 'b/c.txt', content: Buffer.from('2') }]);
  const b = hashEntries([{ path: 'b/c.txt', content: Buffer.from('2') }, { path: 'a.txt', content: Buffer.from('1') }]);
  const c = hashEntries([{ path: 'a.txt', content: Buffer.from('1') }, { path: 'b/c.txt', content: Buffer.from('3') }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('the leak guard finds and hides emails, home paths, session folders and share links', () => {
  const home = `${HOME_MAC}someone`;
  const email = ['someone', 'example.org'].join('@');
  const link = ['https://test-manager.', 'lambdatest', '.com/projects/1/share/US_X'].join('');
  const text = `ran by ${email} at ${home}/${SESSIONS}/abc/runs/1, see ${link} and id abcdef-123`;
  const kinds = findLeaks(text, { exact: ['abcdef-123'] }).map((l) => l.kind);
  for (const k of ['an email address', 'a home folder path', 'a Kane session folder', 'a share or Test Manager link', 'an id or link from this Kane run']) {
    assert.ok(kinds.includes(k), k);
  }
  const clean = scrubText(text, { exact: ['abcdef-123'] });
  assert.deepEqual(findLeaks(clean, { exact: ['abcdef-123'] }), []);
  assert.match(clean, /<email>/);
  assert.deepEqual(findLeaks('Total shows $27.50 at http://localhost:8091/ (assertion_failed: @ step 5)'), []);
});

test('config: defaults, refusals for unsafe app folders, and no way to set Kane from the repository', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(loadConfig(dir), { app: 'demo/app', timeoutS: 300, maxAttempts: 4 });
  mkdirSync(join(dir, '.proven'));
  writeFileSync(join(dir, '.proven', 'config.json'), JSON.stringify({ app: 'web/', timeout_s: 120 }));
  assert.deepEqual(loadConfig(dir), { app: 'web', timeoutS: 120, maxAttempts: 4 });
  writeFileSync(join(dir, '.proven', 'config.json'), JSON.stringify({ kane: ['node', 'always-pass.js'] }));
  assert.throws(() => loadConfig(dir), /"kane" cannot be set here\. Proven always runs kane-cli/);
  writeFileSync(join(dir, '.proven', 'config.json'), JSON.stringify({ kane_cli: 'x' }));
  assert.throws(() => loadConfig(dir), /unknown setting "kane_cli"/);
  for (const app of ['.', '..', '/abs', 'tickets', 'receipts/x', '.proven']) {
    writeFileSync(join(dir, '.proven', 'config.json'), JSON.stringify({ app }));
    assert.throws(() => loadConfig(dir), /"app" must be a folder/, app);
  }
});

test('Kane is kane-cli from PATH unless the test-only PROVEN_KANE_BIN is set, and then it says so', () => {
  assert.deepEqual(kaneCommand({}), { command: ['kane-cli'], label: 'kane-cli', fake: false });
  assert.deepEqual(kaneCommand({ PROVEN_KANE_BIN: '/opt/fake-kane.js' }), {
    command: [process.execPath, '/opt/fake-kane.js'],
    label: 'fake (PROVEN_KANE_BIN)',
    fake: true,
  });
  assert.deepEqual(kaneCommand({ PROVEN_KANE_BIN: '/opt/fake-kane' }).command, ['/opt/fake-kane']);
});

test('the pinned settings cover the app folder, the time limit, the attempt limit and the start URL', () => {
  const a = settingsOf({ app: 'demo/app', timeoutS: 300, maxAttempts: 4 }, 'http://localhost:8091/');
  assert.deepEqual(a, { app: 'demo/app', timeout_s: 300, max_attempts: 4, start_url: 'http://localhost:8091/' });
  const b = settingsOf({ app: 'demo/app', timeoutS: 30, maxAttempts: 4 }, 'http://localhost:8091/');
  assert.notEqual(sha256(canonicalJson(a)), sha256(canonicalJson(b)));
});

test('commitPaths commits exactly the named paths and leaves other staged work alone', (t) => {
  const dir = tempDir(t);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Proven Test');
  git(dir, 'config', 'user.email', TEST_EMAIL);
  git(dir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'tickets', 'output-T-1', 'evidence'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 'T-1.md'), 'ticket');
  writeFileSync(join(dir, 'other.txt'), 'staged elsewhere');
  writeFileSync(join(dir, 'tickets', 'output-T-1', 'Result.md'), 'result');
  writeFileSync(join(dir, 'tickets', 'output-T-1', 'evidence', 'x.json'), 'pack');
  writeFileSync(join(dir, 'tickets', 'output-T-1', 'run.evidence'), 'pack');
  git(dir, 'add', 'other.txt');

  const first = commitPaths(dir, { paths: ['tickets/T-1.md'], message: 'first' });
  assert.equal(first.created, true);
  assert.equal(git(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', first.commit), 'tickets/T-1.md');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'other.txt');
  assert.deepEqual(dirtyPaths(dir, 'tickets/T-1.md'), []);

  const again = commitPaths(dir, { paths: ['tickets/T-1.md'], message: 'nothing new' });
  assert.deepEqual(again, { commit: first.commit, created: false });

  const rec = commitPaths(dir, {
    paths: ['tickets/output-T-1'],
    excludes: ['tickets/output-T-1/evidence', 'tickets/output-T-1/evidence/**', 'tickets/output-T-1/**/*.evidence'],
    message: 'recording',
  });
  assert.equal(git(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', rec.commit), 'tickets/output-T-1/Result.md');
  assert.equal(git(dir, 'rev-parse', 'HEAD~1'), first.commit);
});

test('the zip reader reads stored and deflated entries, and finds the failing screenshot', (t) => {
  const dir = tempDir(t);
  const shot = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('pixels'.repeat(50))]);
  const pack = writeZip([
    { name: 'run.yaml', data: 'status: finalized\n' },
    {
      name: 'failure.yaml',
      data: 'totals:\n  failures: 1\nfailures:\n  - test: cart-1\n    ordinal: 6\n    step: 1-5\n    path: tests/cart-1/steps/6-1-5/failure.yaml\n',
    },
    { name: 'tests/cart-1/steps/6-1-5/failure.yaml', data: 'step: 1-5\npage_state:\n  screenshot: steps/6-1-5/screenshot.jpg\n' },
    { name: 'tests/cart-1/steps/6-1-5/screenshot.jpg', data: shot, deflate: true },
    { name: 'tests/cart-1/steps/7-1-6/screenshot.jpg', data: Buffer.from('later'), deflate: true },
  ]);
  const zip = readZip(pack);
  assert.equal(zip.read('run.yaml').toString(), 'status: finalized\n');
  assert.deepEqual(zip.read('tests/cart-1/steps/6-1-5/screenshot.jpg'), shot);
  assert.equal(zip.read('missing'), null);

  const file = join(dir, 'p.evidence');
  writeFileSync(file, pack);
  const found = failingScreenshot(file, 2);
  assert.equal(found.inner, 'tests/cart-1/steps/6-1-5/screenshot.jpg');
  assert.deepEqual(found.data, shot);

  // Without failure.yaml, the last screenshot of that step is used.
  writeFileSync(file, writeZip([{ name: 'tests/cart-1/steps/3-1-2/screenshot.jpg', data: 'a' }, { name: 'tests/cart-1/steps/4-1-3/screenshot.jpg', data: 'b' }]));
  assert.equal(failingScreenshot(file, 2).inner, 'tests/cart-1/steps/4-1-3/screenshot.jpg');
  assert.equal(failingScreenshot(file, 3), null);
  assert.throws(() => readZip(Buffer.from('not a zip at all, just text that is long enough')), /not a zip/);
  assert.ok(readFileSync(file).length > 0);
});

test('the probe needs HTTP 200 from the start URL', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  assert.equal((await probe(server.url)).ok, true);
  const missing = await probe(new URL('nope.html', server.url).href);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  await server.close();
  assert.equal((await probe(server.url)).ok, false);
  assert.equal((await probe('not a url')).ok, false);
});

test('the demo server sends no-store and refuses paths outside the app', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const res = await fetch(server.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /<h1>Your cart<\/h1>/);
  const js = await fetch(new URL('cart.js', server.url));
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const outside = await fetch(new URL('/..%2fserver.js', server.url));
  assert.equal(outside.status, 404);
});
