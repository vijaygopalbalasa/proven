import { execFile, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../demo/server.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROVEN = join(ROOT, 'bin', 'proven.js');
export const FAKE_KANE = join(ROOT, 'test', 'support', 'fake-kane.js');
export const TEST_EMAIL = ['proven-test', 'example.com'].join('@');

export function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function runProven(cwd, args, env = {}) {
  const fullEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) fullEnv[k] = v;
  return new Promise((done) => {
    execFile(process.execPath, [PROVEN, ...args], { cwd, env: fullEnv, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

// A temporary git repo holding a copy of the demo shop, served for real, with the fake Kane in its config.
// A kane-cli shim first on PATH fails loudly if anything reaches for the real Kane CLI.
export async function makeRepo(t, { timeoutS = 60, maxAttempts = 4, serve = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'proven-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, 'demo', 'app'), join(dir, 'demo', 'app'), { recursive: true });
  copyFileSync(join(ROOT, '.gitignore'), join(dir, '.gitignore'));
  mkdirSync(join(dir, '.proven'), { recursive: true });
  writeFileSync(
    join(dir, '.proven', 'config.json'),
    JSON.stringify({ app: 'demo/app', kane: [process.execPath, FAKE_KANE], timeout_s: timeoutS, max_attempts: maxAttempts }, null, 2),
  );
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Proven Test');
  git(dir, 'config', 'user.email', TEST_EMAIL);
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', join(dir, '.git', 'no-hooks'));
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '.proven/config.json\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Start the shop');

  const shim = join(dir, '.git', 'shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'kane-cli'), '#!/bin/sh\necho "the real kane-cli was called in a test" >&2\ntouch "$0.called"\nexit 99\n');
  chmodSync(join(shim, 'kane-cli'), 0o755);

  let server = null;
  if (serve) {
    server = await startServer({ root: join(dir, 'demo', 'app') });
    t.after(() => server.close());
  }
  const log = join(dir, '.git', 'fake-kane.log');
  const repo = {
    dir,
    url: server ? server.url : null,
    log,
    run: (args, { scenario, env } = {}) =>
      runProven(dir, args, { FAKE_KANE_SCENARIO: scenario, FAKE_KANE_LOG: log, PATH: `${shim}:${process.env.PATH}`, ...env }),
    git: (...args) => git(dir, ...args),
    read: (rel) => readFileSync(join(dir, rel), 'utf8'),
    write: (rel, text) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    },
    exists: (rel) => existsSync(join(dir, rel)),
    json: (rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8')),
    kaneCalls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    realKaneCalled: () => existsSync(join(shim, 'kane-cli.called')),
    head: () => git(dir, 'rev-parse', 'HEAD'),
    changed: (commit) => git(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', commit).split('\n').filter(Boolean).sort(),
  };
  return repo;
}

export function couponTicket(url, { criteria } = {}) {
  return `# T-1: Coupon SAVE10 takes 10% off

Start URL: ${url}
Landmark: Your cart

## Acceptance criteria

${criteria ?? '### Apply SAVE10\nType SAVE10 in the coupon field and click Apply.\nVerify the order total shows $27.50.'}

## Notes

Customers with the SAVE10 code from our flyer say the cart will not take it.
`;
}

// What the agent would do for T-1.
export function fixCoupon(repo) {
  const file = 'demo/app/cart.js';
  const text = repo.read(file);
  const fixed = text.replace('const percent = coupons[code];', 'const percent = coupons[code.toLowerCase()];');
  if (fixed === text) throw new Error('the coupon line was not found in cart.js');
  repo.write(file, fixed);
}

// Freeze T-1, record red, fix the app and close it with a receipt.
export async function greenRepo(t) {
  const repo = await makeRepo(t);
  repo.write('tickets/T-1.md', couponTicket(repo.url));
  for (const [args, scenario, code] of [
    [['freeze', 'T-1']],
    [['red', 'T-1'], 'red', 0],
  ]) {
    const r = await repo.run(args, { scenario });
    if (r.code !== (code ?? 0)) throw new Error(`${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  }
  fixCoupon(repo);
  const r = await repo.run(['done', 'T-1'], { scenario: 'green' });
  if (r.code !== 0) throw new Error(`done exited ${r.code}: ${r.stderr}`);
  return repo;
}
