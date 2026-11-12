import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { exportTree, serveTree, snapshotApp } from '../src/snapshot.js';
import { serveFolder } from '../src/serve.js';
import { commitTreeAtPath } from '../src/git.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256 } from '../src/hash.js';
import { findLeaks, scrubText } from '../src/leak.js';
import { kaneCommand, loadConfig, settingsOf } from '../src/config.js';
import { commitPaths, dirtyPaths } from '../src/git.js';
import { readZip } from '../src/zip.js';
import { failingScreenshot } from '../src/evidence.js';
import { probe } from '../src/probe.js';
import { APP_DIR } from '../demo/server.js';
import { writeZip } from './support/zip-writer.js';
import { freePort, git, TEST_EMAIL } from './support/helpers.js';
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

function repoWithApp(t) {
  const dir = tempDir(t);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Proven Test');
  git(dir, 'config', 'user.email', TEST_EMAIL);
  git(dir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'app', 'js'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '*.log\n');
  writeFileSync(join(dir, 'app', 'index.html'), '<h1>Your cart</h1>');
  writeFileSync(join(dir, 'app', 'js', 'cart.js'), 'let total = 30;');
  writeFileSync(join(dir, 'notes.md'), 'outside the app');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'app');
  return dir;
}

test('a snapshot is the tree git would commit for the app: untracked files in, ignored files out', (t) => {
  const dir = repoWithApp(t);
  const committed = git(dir, 'rev-parse', 'HEAD:app');
  assert.equal(snapshotApp(dir, 'app'), committed);

  writeFileSync(join(dir, 'app', 'debug.log'), 'ignored');
  assert.equal(snapshotApp(dir, 'app'), committed, 'an ignored file is not in the snapshot');

  writeFileSync(join(dir, 'app', 'js', 'cart.js'), 'let total = 27.5;');
  writeFileSync(join(dir, 'app', 'new.js'), 'new');
  const changed = snapshotApp(dir, 'app');
  assert.notEqual(changed, committed);
  git(dir, 'add', '-A');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'app/js/cart.js\napp/new.js');
  git(dir, 'commit', '-q', '-m', 'change');
  assert.equal(git(dir, 'rev-parse', 'HEAD:app'), changed, 'the snapshot id is the id git commits');
});

test('exportTree writes exactly the tree, and commitTreeAtPath commits exactly that tree for the app', (t) => {
  const dir = repoWithApp(t);
  writeFileSync(join(dir, 'app', 'js', 'cart.js'), 'let total = 27.5;');
  const tree = snapshotApp(dir, 'app');
  writeFileSync(join(dir, 'app', 'js', 'cart.js'), 'edited again after the snapshot');

  const out = join(tempDir(t), 'export');
  mkdirSync(out);
  exportTree(dir, tree, out);
  assert.equal(readFileSync(join(out, 'js', 'cart.js'), 'utf8'), 'let total = 27.5;');
  assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), '<h1>Your cart</h1>');

  const before = git(dir, 'rev-parse', 'HEAD');
  const g = commitTreeAtPath(dir, { path: 'app', tree, message: 'G' });
  assert.equal(g.created, true);
  assert.equal(git(dir, 'rev-parse', `${g.commit}:app`), tree);
  assert.equal(git(dir, 'rev-parse', `${g.commit}~1`), before);
  assert.equal(git(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', g.commit), 'app/js/cart.js');
  assert.equal(git(dir, 'show', `${g.commit}:notes.md`), 'outside the app');
  assert.equal(readFileSync(join(dir, 'app', 'js', 'cart.js'), 'utf8'), 'edited again after the snapshot');
  assert.equal(git(dir, 'status', '--porcelain'), 'M app/js/cart.js');
  assert.deepEqual(commitTreeAtPath(dir, { path: 'app', tree, message: 'again' }), { commit: g.commit, created: false });
});

test('serveTree serves only the snapshot, with no-store, and refuses a port that is taken', async (t) => {
  const dir = repoWithApp(t);
  writeFileSync(join(dir, 'app', 'debug.log'), 'ignored');
  const tree = snapshotApp(dir, 'app');
  const url = `http://127.0.0.1:${await freePort()}/`;
  const served = await serveTree(dir, tree, url);
  t.after(() => served.close());
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), '<h1>Your cart</h1>');
  assert.equal((await fetch(new URL('debug.log', url))).status, 404);
  assert.equal((await fetch(new URL('js/cart.js', url))).headers.get('content-type'), 'text/javascript; charset=utf-8');
  await assert.rejects(serveTree(dir, tree, url), /Port \d+ is already in use\. Stop the other server/);
  await served.close();
  assert.equal((await probe(url)).ok, false);
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
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const server = await serveFolder(APP_DIR, { port, hosts: ['127.0.0.1'] });
  t.after(() => server.close());
  assert.equal((await probe(url)).ok, true);
  const missing = await probe(new URL('nope.html', url).href);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  await server.close();
  assert.equal((await probe(url)).ok, false);
  assert.equal((await probe('not a url')).ok, false);
});

test('the demo shop is served with no-store, and paths outside it are refused', async (t) => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const server = await serveFolder(APP_DIR, { port, hosts: ['127.0.0.1'] });
  t.after(() => server.close());
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /<h1>Your cart<\/h1>/);
  assert.equal((await fetch(new URL('/..%2fserver.js', url))).status, 404);
});
