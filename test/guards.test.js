import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../src/hash.js';
import { couponTicket, fixCoupon, makeRepo } from './support/helpers.js';

const STATE = '.proven/state/T-1.json';
const CONFIG = '.proven/config.json';

function both(r, re) {
  assert.match(r.stdout, re, `stdout: ${r.stdout}`);
  assert.match(r.stderr, re, `stderr: ${r.stderr}`);
}

// Commit a state file the way an agent with a shell could: state only, with a subject that looks like Proven's.
function forgeStateCommit(repo, state, subject = 'T-1: attempt 1 failed at step 2') {
  repo.write(STATE, JSON.stringify(state, null, 2) + '\n');
  repo.git('add', STATE);
  repo.git('commit', '-q', '-m', subject);
}

async function redRepo(t, opts) {
  const repo = await makeRepo(t, opts);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 0, r.stderr);
  return repo;
}

test('the Kane command cannot come from a file in the repository', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  repo.write(CONFIG, JSON.stringify({ app: 'demo/app', kane: ['node', 'always-pass.js'] }));
  const r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /"kane" cannot be set here\. Proven always runs kane-cli from PATH\./);
  assert.equal(repo.kaneCalls().length, 0);
});

test('settings that affect verdicts are pinned at freeze; red and done refuse when they change', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  const original = repo.read(CONFIG);

  repo.write(CONFIG, JSON.stringify({ app: 'demo/app', timeout_s: 5, max_attempts: 4 }));
  let r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /settings changed after T-1 was frozen: timeout_s/);
  assert.equal(repo.kaneCalls().length, 0);

  repo.write(CONFIG, original);
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);

  repo.write(CONFIG, JSON.stringify({ app: 'demo/app', timeout_s: 60, max_attempts: 99 }));
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /settings changed after T-1 was frozen: max_attempts/);
  repo.write(CONFIG, JSON.stringify({ app: 'demo', timeout_s: 60, max_attempts: 4 }));
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.match(r.stderr, /settings changed after T-1 was frozen: app/);
  assert.equal(repo.kaneCalls().length, 1);
});

test('Proven reads its state only from its own commits', async (t) => {
  const repo = await redRepo(t);
  let r = await repo.run(['done', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 1);
  assert.equal(repo.json(STATE).attempts, 1);
  const calls = repo.kaneCalls().length;
  const good = repo.head();

  // An edit in the working tree is refused.
  const lowered = JSON.stringify({ ...repo.json(STATE), attempts: 0, status: 'red' }, null, 2) + '\n';
  repo.write(STATE, lowered);
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\.proven\/state\/T-1\.json has uncommitted changes\. Proven reads its state from commits only\./);
  repo.git('checkout', '--', STATE);

  // A commit that changes the state along with other files is not Proven's.
  fixCoupon(repo);
  repo.write(STATE, lowered);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'Fix coupon');
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /was changed by commit [0-9a-f]{7}, which Proven did not make/);
  repo.git('reset', '-q', '--hard', good);

  // A state-only commit that looks like Proven's still cannot lower the attempt count.
  repo.write(STATE, lowered);
  repo.git('add', STATE);
  repo.git('commit', '-q', '-m', 'T-1: attempt 1 failed at step 2');
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /history of \.proven\/state\/T-1\.json does not match its attempt count/);
  repo.git('reset', '-q', '--hard', good);

  assert.equal(repo.kaneCalls().length, calls);
});

test('done refuses when the frozen test was changed in a commit after red, even if changed back', async (t) => {
  const repo = await redRepo(t);
  const original = repo.read('tickets/T-1_test.md');
  repo.write('tickets/T-1_test.md', original.replace('$27.50', '$30.00'));
  repo.git('commit', '-q', '-am', 'Loosen the test');
  repo.write('tickets/T-1_test.md', original);
  repo.git('commit', '-q', '-am', 'Put it back');
  fixCoupon(repo);
  const r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /tickets\/T-1_test\.md was changed after red in 2 commit\(s\)/);
  assert.equal(repo.kaneCalls().length, 1);
});

test('Kane judges a snapshot of the app: ignored files are never served, and edits during the run never reach G', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);

  // A file git ignores is on disk but not in the snapshot, so Kane cannot see it.
  repo.write('demo/app/.DS_Store', 'ignored by .gitignore');
  let r = await repo.run(['red', 'T-1'], { scenario: 'red', env: { FAKE_KANE_FETCH: '/.DS_Store,/cart.js' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Kane will not see 1 file that git ignores in demo\/app: demo\/app\/\.DS_Store/);
  let fetched = repo.kaneCalls().at(-1).fetched;
  assert.equal(fetched['/.DS_Store'].status, 404);
  assert.equal(fetched['/cart.js'].sha256, sha256(readFileSync(join(repo.dir, 'demo/app/cart.js'))));
  assert.equal(repo.json(STATE).red.app_tree, repo.git('rev-parse', 'HEAD~1:demo/app'));

  // The agent's uncommitted fix is what Kane sees. A file written while Kane runs is not served and not committed.
  fixCoupon(repo);
  const fixed = sha256(readFileSync(join(repo.dir, 'demo/app/cart.js')));
  r = await repo.run(['done', 'T-1'], {
    scenario: 'green-changes-app',
    env: { FAKE_KANE_TOUCH: join(repo.dir, 'demo/app/late.js'), FAKE_KANE_FETCH: '/late.js,/cart.js' },
  });
  assert.equal(r.code, 0, r.stderr);
  fetched = repo.kaneCalls().at(-1).fetched;
  assert.equal(fetched['/late.js'].status, 404);
  assert.equal(fetched['/cart.js'].sha256, fixed);
  const receipt = repo.json('receipts/T-1.json');
  const G = receipt.green.commit;
  assert.equal(repo.git('rev-parse', `${G}:demo/app`), receipt.green.app_tree);
  assert.deepEqual(repo.changed(G), ['demo/app/cart.js']);
  assert.equal(repo.git('ls-tree', '--name-only', G, 'demo/app/late.js'), '');
  assert.equal(repo.exists('demo/app/late.js'), true);
  assert.equal(repo.git('status', '--porcelain', '--', 'demo/app'), '?? demo/app/late.js');
  assert.equal((await repo.run(['verify', 'receipts/T-1.json'])).code, 0);
});

test('red must run on the commit that locked the test; freezing again moves the lock', async (t) => {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  repo.write('tickets/T-2.md', couponTicket(repo.url).replace('# T-1:', '# T-2:'));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  assert.equal((await repo.run(['freeze', 'T-2'])).code, 0);

  let r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /T-1 must go red on the commit that locked its test \([0-9a-f]{7}\), but HEAD has moved since\. Run proven freeze T-1 again, then proven red T-1 right after it\./);
  assert.equal(repo.kaneCalls().length, 0);

  r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Frozen T-1 again on the current commit/);
  const lock = repo.json('tickets/T-1.lock.json');
  assert.equal(repo.git('rev-parse', 'HEAD~1'), lock.frozen_commit);
  assert.deepEqual(repo.changed(lock.frozen_commit), []);
  assert.deepEqual(repo.changed('HEAD'), ['tickets/T-1.lock.json']);
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);

  r = await repo.run(['freeze', 'T-1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /would move the goalposts/);
});

test('the lock chain: the lock is written once after F, and red sits on the lock commit', async (t) => {
  const repo = await redRepo(t);
  fixCoupon(repo);
  const good = repo.head();
  const lockText = repo.read('tickets/T-1.lock.json');

  // A second write of the lock after F, even with the same pins, breaks the chain.
  repo.write('tickets/T-1.lock.json', lockText.replace('\n}', ',\n  "note": "again"\n}'));
  repo.git('commit', '-q', '-am', 'T-1: lock frozen test again');
  let r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /tickets\/T-1\.lock\.json was written 2 times after its frozen commit/);
  repo.git('reset', '-q', '--hard', good);
  fixCoupon(repo);
  assert.equal((await repo.run(['done', 'T-1'], { scenario: 'green' })).code, 0);
});

test('red and done refuse symlinks in the app folder', async (t) => {
  const repo = await makeRepo(t);
  symlinkSync('cart.js', join(repo.dir, 'demo/app/linked.js'));
  repo.git('add', 'demo/app/linked.js');
  repo.git('commit', '-q', '-m', 'Add a link');
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  let r = await repo.run(['red', 'T-1'], { scenario: 'red' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /demo\/app holds a symlink: demo\/app\/linked\.js\./);
  repo.git('rm', '-q', 'demo/app/linked.js');
  repo.git('commit', '-q', '-m', 'Remove the link');
  assert.equal((await repo.run(['freeze', 'T-1'])).code, 0);
  assert.equal((await repo.run(['red', 'T-1'], { scenario: 'red' })).code, 0);

  fixCoupon(repo);
  symlinkSync('../../tickets/T-1.md', join(repo.dir, 'demo/app/notes.md'));
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /demo\/app holds a symlink: demo\/app\/notes\.md\./);
  assert.equal(repo.kaneCalls().length, 1);
});

test('the red record cannot be moved or thinned by later state commits', async (t) => {
  const repo = await redRepo(t);
  const lock = repo.json('tickets/T-1.lock.json');
  const state = repo.json(STATE);
  const good = repo.head();
  const calls = repo.kaneCalls().length;

  // The attempt count stays consistent, but the red commit is moved to an older commit.
  forgeStateCommit(repo, { ...state, status: 'in-progress', attempts: 1, red: { ...state.red, commit: lock.frozen_commit } });
  let r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /The red record in \.proven\/state\/T-1\.json names [0-9a-f]{7}, but red was recorded on [0-9a-f]{7}\./);
  repo.git('reset', '-q', '--hard', good);

  // Kane's words in the red record are changed in a later state commit.
  forgeStateCommit(repo, { ...state, status: 'in-progress', attempts: 1, red: { ...state.red, kane_reason: 'nothing to see' } });
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /The red record in \.proven\/state\/T-1\.json changed in commit [0-9a-f]{7}\./);
  repo.git('reset', '-q', '--hard', good);

  // A required field is missing: no default is assumed.
  const thin = { ...state.red };
  delete thin.kane;
  forgeStateCommit(repo, { ...state, status: 'in-progress', attempts: 1, red: thin });
  r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\.proven\/state\/T-1\.json is missing red\.kane\./);
  repo.git('reset', '-q', '--hard', good);

  assert.equal(repo.kaneCalls().length, calls);
});

test('red and green must run on the same Kane', async (t) => {
  const repo = await redRepo(t);
  fixCoupon(repo);
  const r = await repo.run(['done', 'T-1'], { realKane: true });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /T-1 went red on fake \(PROVEN_KANE_BIN\), but this run would use kane-cli\. Red and green must run on the same Kane\./);
  assert.equal(repo.realKaneCalled(), false);
});
