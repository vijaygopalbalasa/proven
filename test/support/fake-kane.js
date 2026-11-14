#!/usr/bin/env node
// A stand-in for Kane CLI, used only by the tests. It replays NDJSON recorded from real Kane CLI 0.10.4 runs
// (scrubbed: every private value is a {{PLACEHOLDER}}) with Kane's exit codes, and writes what Kane writes:
// the recording folder next to the test and a sealed evidence pack under .testmuai/evidence/.
// Private-looking values (home path, session ids, share links, the runner's email) are made up at run time,
// so the tests can prove Proven never commits them.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './zip-writer.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'kane');
const AFTER_RUN = ['test_md_summary', 'coverage', 'test_md_done'];

const SCENARIOS = {
  red: { fixture: 'red', exit: 1 },
  green: { fixture: 'green', exit: 0 },
  'replay-fail': { fixture: 'replay-fail', exit: 1 },
  'env-down': { fixture: 'env-down', exit: 1 },
  'landmark-down': { fixture: 'landmark-down', exit: 1 },
  'no-done': { fixture: 'red', exit: 1, drop: AFTER_RUN },
  'exit-3': { fixture: 'red', exit: 3, drop: AFTER_RUN },
  'exit-mismatch': { fixture: 'green', exit: 1 },
  'not-started': { fixture: null, exit: 2, stderr: 'Not signed in. Run kane-cli login first.' },
  'green-changes-app': { fixture: 'green', exit: 0, touch: true },
  'red-leaky': { fixture: 'red', exit: 1, leaky: true },
  hang: { hang: true },
  // Plays the red run up to the end of step 2 (which fails), then hangs, like a run cut off by the time limit.
  'red-cut': { fixture: 'red', exit: 1, cutAfterStep: 2 },
};

// Flags after the test path that Kane CLI 0.10.4 has for testmd run: Proven may add only these.
const KNOWN_FLAGS = new Set(['--agent', '--headless', '--no-adaptive-heal', '--author']);

const args = process.argv.slice(2);
const extraArgs = args.slice(3).filter((a) => a !== '--agent' && a !== '--headless');
if (
  args[0] !== 'testmd' ||
  args[1] !== 'run' ||
  !args[2]?.endsWith('_test.md') ||
  !args.includes('--agent') ||
  !args.includes('--headless') ||
  args.slice(3).some((a) => !KNOWN_FLAGS.has(a))
) {
  process.stderr.write(`fake kane: unexpected arguments: ${args.join(' ')}\n`);
  process.exit(2);
}
// FAKE_KANE_SCENARIO is one scenario, or a comma-separated list for commands that run Kane more than once:
// run n takes the n-th entry (the last one repeats), counted in the FAKE_KANE_COUNTER file.
let scenarioName = pickScenario(process.env.FAKE_KANE_SCENARIO ?? '');

function pickScenario(value) {
  const list = value.split(',').map((x) => x.trim()).filter(Boolean);
  if (list.length < 2) return list[0];
  const counter = process.env.FAKE_KANE_COUNTER;
  if (!counter) {
    process.stderr.write('fake kane: a scenario list needs FAKE_KANE_COUNTER\n');
    process.exit(2);
  }
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) || 0 : 0;
  writeFileSync(counter, String(n + 1));
  return list[Math.min(n, list.length - 1)];
}

const testPath = resolve(process.cwd(), args[2]);
const testText = readFileSync(testPath, 'utf8');
const stem = basename(testPath).replace(/_test\.md$/, '');
// Kane replays the steps it has recorded in output-<stem>/ next to the test, unless --author makes it author every
// step again. The knobs below stand for an attacker with a shell:
//   FAKE_KANE_RECORDING_PASSES  a tampered recording: a run that replays it passes.
//   FAKE_KANE_PLANTED_MIDRUN    a passing recording written into output-<stem>/ just as Kane starts, the way a parallel
//                               tool call could land between Proven setting the recording aside and Kane reading it.
//   FAKE_KANE_REPLAYS           the run replays recorded steps whatever the flags say, and its summary shows it.
//   FAKE_KANE_STALE_FILE        a file from before the run is left in output-<stem>/ after it.
const recordingDir = join(dirname(testPath), `output-${stem}`);
const recordingBefore = existsSync(join(recordingDir, 'Result.md'));
const author = args.includes('--author');
let planted = false;
if (process.env.FAKE_KANE_PLANTED_MIDRUN) {
  mkdirSync(recordingDir, { recursive: true });
  writeFileSync(join(recordingDir, 'Result.md'), '---\nstatus: passed\n---\n\n# planted: every step passed\n');
  planted = true;
}
const replays = (!author && (recordingBefore || planted)) || Boolean(process.env.FAKE_KANE_REPLAYS);
if (!author && ((recordingBefore && process.env.FAKE_KANE_RECORDING_PASSES) || planted)) scenarioName = 'green';
const scenario = SCENARIOS[scenarioName];
const steps = [];
for (const line of testText.split('\n')) {
  const h = /^##\s+(.*\S)\s*$/.exec(line);
  if (h && !line.startsWith('###')) steps.push({ title: h[1], lines: [] });
  else if (steps.length && line.trim()) steps.at(-1).lines.push(line.trim());
}
const startUrl = /^Open\s+(\S+)/m.exec(testText)?.[1] ?? 'http://127.0.0.1:1/';
if (!scenario) {
  process.stderr.write(`fake kane: set FAKE_KANE_SCENARIO to one of ${Object.keys(SCENARIOS).join(', ')}\n`);
  process.exit(2);
}

const sessionId = randomUUID();
const evidenceId = randomUUID();
const home = join('/', 'Users', 'kane-runner');
const sessionDir = join(home, '.testmuai', 'kaneai', 'sessions', sessionId);
const shareUrl = ['https://tm.invalid', 'projects', 'P1', 'dashboard', 'share', `US_${randomBytes(12).toString('hex').toUpperCase()}?type=summary`].join('/');
const email = ['kane.runner', 'example.com'].join('@');
const values = {
  SESSION_ID: sessionId,
  SESSION_DIR: sessionDir,
  SHARE_URL: shareUrl,
  TEST_PATH: testPath,
  TMP: join(tmpdir(), 'kane-fake'),
  ORIGIN: new URL(startUrl).origin,
  EVIDENCE_ID: evidenceId,
  TESTCASE_ID: randomBytes(13).toString('hex').toUpperCase(),
};
// Account ids, as Kane writes them into its recording (made up here, at run time).
const account = {
  org_id: String(3000000 + Math.floor(Math.random() * 999999)),
  user_id: String(3000000 + Math.floor(Math.random() * 999999)),
  project_id: randomBytes(13).toString('hex').toUpperCase(),
};

function log(extra = {}) {
  if (!process.env.FAKE_KANE_LOG) return;
  appendFileSync(
    process.env.FAKE_KANE_LOG,
    JSON.stringify({
      scenario: scenarioName,
      args,
      extra_args: extraArgs,
      recording_before: recordingBefore,
      planted,
      replayed: replays,
      session_id: sessionId,
      share_url: shareUrl,
      session_dir: sessionDir,
      evidence_id: evidenceId,
      email,
      account_ids: [values.TESTCASE_ID, account.org_id, account.user_id, account.project_id],
      ...extra,
    }) + '\n',
  );
}

// Like Kane's browser, fetch pages from the app Proven is serving: FAKE_KANE_FETCH is a comma-separated path list.
async function fetchPages() {
  const paths = (process.env.FAKE_KANE_FETCH ?? '').split(',').filter(Boolean);
  const fetched = {};
  for (const path of paths) {
    try {
      const res = await fetch(new URL(path, startUrl));
      const body = Buffer.from(await res.arrayBuffer());
      fetched[path] = { status: res.status, sha256: createHash('sha256').update(body).digest('hex') };
    } catch (err) {
      fetched[path] = { status: 0, error: String(err.message) };
    }
  }
  return fetched;
}

const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');

// FAKE_KANE_DELAY_MS: Kane is slow to start, for the tests of the time limits.
if (process.env.FAKE_KANE_DELAY_MS) await new Promise((done) => setTimeout(done, Number(process.env.FAKE_KANE_DELAY_MS)));

if (scenario.hang) {
  log();
  out({ type: 'stream_start', cli_version: '0.10.4', surface: 'testmd', pid: process.pid, v: 1 });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  if (process.env.FAKE_KANE_PIDFILE) writeFileSync(process.env.FAKE_KANE_PIDFILE, String(child.pid));
  setInterval(() => {}, 1000);
} else {
  play();
  log({ fetched: await fetchPages() });
}

function fill(text) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => values[key] ?? m);
}

function play() {
  if (!scenario.fixture) {
    out({ type: 'stream_start', cli_version: '0.10.4', surface: 'testmd', pid: process.pid, v: 1 });
    process.stderr.write(`${scenario.stderr}\n`);
    process.exitCode = scenario.exit;
    return;
  }
  const events = fill(readFileSync(join(FIXTURES, `${scenario.fixture}.ndjson`), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => !(scenario.drop ?? []).includes(e.type));

  const statuses = new Map();
  for (const e of events) if (e.type === 'test_md_step_end') statuses.set(e.step_index, e.status);
  const failedStep = [...statuses].find(([, s]) => s === 'failed')?.[0] ?? null;
  const overall = events.find((e) => e.type === 'test_md_done')?.overall_status ?? (failedStep ? 'failed' : 'passed');

  if (scenario.leaky && failedStep) {
    let current = null;
    for (const e of events) {
      if (e.type === 'test_md_step_start') current = e.step_index;
      if (e.type === 'run_end' && current === failedStep && e.status === 'failed') {
        e.one_liner = `${e.one_liner} Details: ${shareUrl}`;
        e.reason = `${e.reason} (log at ${sessionDir}/runs/1, signed in as ${email})`;
      }
    }
  }

  if (replays) {
    for (const e of events) {
      if (e.type === 'test_md_summary' && e.steps) {
        e.steps.replay_decisions = statuses.size;
        e.steps.author_decisions = 0;
      }
    }
  }

  let wroteRecording = false;
  let touched = false;
  for (const e of events) {
    if (e.type === 'test_md_step_start' && steps[e.step_index - 1]) e.heading = steps[e.step_index - 1].title;
    if (e.type === 'test_md_evidence_ingest') writePack(failedStep);
    if ((e.type === 'test_md_bundle_sync' || e.type === 'test_md_summary') && !wroteRecording) {
      writeRecording(statuses, overall);
      wroteRecording = true;
    }
    out(e);
    if (scenario.cutAfterStep && e.type === 'test_md_step_end' && e.step_index === scenario.cutAfterStep) {
      setInterval(() => {}, 1000);
      return;
    }
    if (scenario.touch && !touched && e.type === 'test_md_step_end' && process.env.FAKE_KANE_TOUCH) {
      writeFileSync(process.env.FAKE_KANE_TOUCH, 'changed while Kane ran\n');
      touched = true;
    }
  }
  if (!wroteRecording) writeRecording(statuses, overall);
  if (process.env.FAKE_KANE_STALE_FILE) {
    const stale = join(recordingDir, 'planted.txt');
    writeFileSync(stale, 'written before this run\n');
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    utimesSync(stale, hourAgo, hourAgo);
  }
  process.stderr.write(`Evidence pack: ${join(process.cwd(), '.testmuai', 'evidence', `${evidenceId}.evidence`)}\n`);
  process.exitCode = scenario.exit;
}

function writePack(failedStep) {
  const testDir = `tests/${stem}-0a1b2c3d`;
  const jpeg = (label) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`fake screenshot ${label} `.repeat(20))]);
  const entries = [
    { name: 'run.yaml', data: `evidence: '0.1'\nrun_id: ${evidenceId}\nstatus: finalized\nrunner:\n  name: Kane Runner\n  email: ${email}\n` },
    { name: `${testDir}/steps/1-0-1/screenshot.jpg`, data: jpeg('step 1'), deflate: true },
  ];
  if (failedStep) {
    const dir = `steps/6-${failedStep - 1}-5`;
    entries.push(
      {
        name: 'failure.yaml',
        data: `generated: 2026-11-12T15:52:22.705Z\ntotals:\n  failures: 1\nfailures:\n  - test: ${stem}-0a1b2c3d\n    ordinal: 6\n    step: ${failedStep - 1}-5\n    status: failed\n    path: ${testDir}/${dir}/failure.yaml\n`,
      },
      { name: `${testDir}/${dir}/failure.yaml`, data: `step: ${failedStep - 1}-5\nstatus: failed\npage_state:\n  url: ${startUrl}\n  screenshot: ${dir}/screenshot.jpg\n` },
      { name: `${testDir}/steps/5-${failedStep - 1}-4/screenshot.jpg`, data: jpeg('before failure'), deflate: true },
      { name: `${testDir}/${dir}/screenshot.jpg`, data: jpeg(`step ${failedStep}`), deflate: true },
    );
  } else {
    entries.push({ name: 'failure.yaml', data: 'generated: 2026-11-12T15:55:54.099Z\ntotals:\n  failures: 0\nfailures: []\n' });
  }
  const folder = join(process.cwd(), '.testmuai', 'evidence');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${evidenceId}.evidence`), writeZip(entries));
}

function writeRecording(statuses, overall) {
  const dir = join(dirname(testPath), `output-${stem}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, '.internal'), { recursive: true });
  const mark = { passed: 'passed', failed: 'failed', skipped: 'skipped' };
  const lines = [
    '---',
    `test: ../${basename(testPath)}`,
    `status: ${overall}`,
    'started: 2026-11-12T15:51:26.465Z',
    'duration_s: 54',
    `session_id: ${sessionId}`,
    '---',
    '',
    `# ${/^#\s+(.*)$/m.exec(testText)?.[1] ?? stem} - Result`,
  ];
  steps.forEach((s, i) => {
    const md5 = createHash('md5').update(s.lines.join('\n')).digest('hex');
    const status = statuses.get(i + 1) ?? 'skipped';
    lines.push('', `## ${s.title} ${mark[status] ?? status}`, `md5: ${md5}`, ...s.lines);
    const flow = join(dir, '.internal', 'steps', `${i + 1}-${md5.slice(0, 8)}`, 'flows', '0');
    mkdirSync(flow, { recursive: true });
    const action = status === 'passed' ? JSON.stringify({ step: 1, action_type: 'navigate', action_instruction: s.lines[0] ?? '' }) + '\n' : '';
    writeFileSync(join(flow, 'actions.ndjson'), action);
  });
  writeFileSync(join(dir, 'Result.md'), lines.join('\n') + '\n');
  writeFileSync(
    join(dir, '.internal', 'meta.json'),
    JSON.stringify(
      {
        test_id: '00000000-0000-4000-8000-0000000000aa',
        project_id: account.project_id,
        org_id: account.org_id,
        session_name: stem,
        commit_id: sessionId,
        testcase_id: values.TESTCASE_ID,
        executions: [{ execution_id: evidenceId, run_kind: 'author', status: overall, valid: true }],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(dir, '.internal', 'execution.json'),
    JSON.stringify({ session_id: sessionId, commit_id: sessionId, org_id: account.org_id, user_id: account.user_id, url: startUrl, status: overall }, null, 2) + '\n',
  );
}
