// Turn one Kane run (events + exit code) into passed, failed at step k, or did not run.
// Proven does not judge the app: it only checks that Kane's own result, exit code and step list agree.

function round2(n) {
  return Math.round(n * 100) / 100;
}

function norm(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Facts from the event stream, whatever the outcome.
export function readEvents(events) {
  const facts = {
    kaneVersion: null,
    done: null,
    summary: null,
    durationS: null,
    credits: 0,
    evidenceId: null,
    packPath: null,
    starts: new Map(),
    ends: new Map(),
    endConflict: false,
    runEnds: new Map(),
    verdicts: new Map(),
    exact: new Set(),
    lastMessage: null,
  };
  let current = null;
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    // Values that must never reach a committed file: Kane's ids and links, and any absolute path it reports.
    for (const key of ['session_id', 'share_url', 'commit_id']) {
      if (typeof e[key] === 'string' && e[key]) facts.exact.add(e[key]);
    }
    for (const key of ['session_dir', 'run_dir', 'screenshot_path', 'path', 'pack']) {
      const v = e[key];
      if (typeof v === 'string' && (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v))) facts.exact.add(v);
    }
    if (typeof e.message === 'string' && e.message) facts.lastMessage = e.message;
    switch (e.type) {
      case 'stream_start':
        facts.kaneVersion = e.cli_version ?? facts.kaneVersion;
        break;
      case 'test_md_step_start':
        current = e.step_index;
        if (!facts.starts.has(e.step_index)) facts.starts.set(e.step_index, e.heading ?? null);
        break;
      case 'test_md_step_end': {
        const prev = facts.ends.get(e.step_index);
        if (prev && prev !== e.status) facts.endConflict = true;
        facts.ends.set(e.step_index, e.status);
        current = null;
        break;
      }
      case 'run_end': {
        const n = Number(e.credits_consumed ?? e.credits);
        if (Number.isFinite(n)) facts.credits += n;
        if (current != null) {
          if (!facts.runEnds.has(current)) facts.runEnds.set(current, []);
          facts.runEnds.get(current).push(e);
        }
        break;
      }
      case 'test_md_bug_verdict':
        facts.verdicts.set(e.step_index, e);
        break;
      case 'test_md_evidence_ingest':
        if (e.status === 'ok' && e.evidence_id) facts.evidenceId = String(e.evidence_id);
        break;
      case 'coverage':
        if (typeof e.pack === 'string') facts.packPath = e.pack;
        break;
      case 'test_md_summary':
        facts.summary = e;
        break;
      case 'test_md_done':
        facts.done = e;
        break;
      default:
        break;
    }
  }
  facts.credits = round2(facts.credits);
  facts.durationS = facts.done?.duration_s ?? facts.summary?.duration_s ?? null;
  return facts;
}

// Kane's words for one step: its one_liner and reason.
export function stepDetail(facts, k) {
  const runs = facts.runEnds.get(k) ?? [];
  const failed = [...runs].reverse().find((r) => r.status === 'failed') ?? runs.at(-1) ?? {};
  const verdict = facts.verdicts.get(k) ?? {};
  return {
    oneLiner: failed.one_liner || verdict.one_liner || '',
    reason: failed.reason || verdict.bug_title || '',
    family: verdict.family ?? null,
  };
}

function summaryAgrees(summary, expected) {
  if (!summary) return true;
  const s = summary.steps;
  if (!s || typeof s !== 'object') return false;
  for (const [key, value] of Object.entries(expected)) {
    if (s[key] !== undefined && s[key] !== value) return false;
    if (s[key] === undefined && key !== 'skipped') return false;
  }
  return true;
}

export function classifyRun({ events, exitCode, timedOut, interrupted, spawnError, steps, timeoutS, command }) {
  const facts = readEvents(events ?? []);
  const N = steps.length;
  const base = {
    kaneVersion: facts.kaneVersion,
    durationS: facts.durationS,
    credits: facts.credits,
    evidenceId: facts.evidenceId,
    packPath: facts.packPath,
    exact: [...facts.exact],
    stepsTotal: N,
  };
  const notRun = (reason, extra = {}) => ({ outcome: 'did-not-run', reason, ...base, ...extra });

  if (spawnError) {
    return notRun(
      spawnError.code === 'ENOENT'
        ? `Kane CLI was not found (${(command ?? ['kane-cli'])[0]}). Install it with: npm install -g @testmuai/kane-cli`
        : `Kane could not start: ${spawnError.message}`,
    );
  }
  if (interrupted) return notRun('the run was interrupted');
  if (timedOut) return notRun(`Kane did not finish within ${timeoutS} s`);
  if (exitCode === 2) return notRun(`Kane did not start (exit code 2)${facts.lastMessage ? `: ${facts.lastMessage}` : ''}`);
  if (exitCode === 3) return notRun('Kane timed out or was cancelled (exit code 3)');
  if (exitCode !== 0 && exitCode !== 1) return notRun(`Kane stopped with exit code ${exitCode}`);

  const done = facts.done;
  if (!done) return notRun('Kane wrote no final result (no test_md_done event)');
  const overall = done.overall_status;
  if (overall !== 'passed' && overall !== 'failed') return notRun(`Kane's final result is "${overall}", not passed or failed`);
  if (facts.summary?.cancelled === true) return notRun('Kane says the run was cancelled');
  if (facts.summary?.overall_status && facts.summary.overall_status !== overall) {
    return notRun("Kane's summary and final result do not agree");
  }

  for (const [index, heading] of facts.starts) {
    if (!Number.isInteger(index) || index < 1 || index > N) return notRun(`Kane ran a step ${index} that the frozen test does not have`);
    if (heading != null && norm(heading) !== norm(steps[index - 1].title)) {
      return notRun(`Kane's step ${index} is "${heading}", but the frozen test says "${steps[index - 1].title}"`);
    }
  }
  for (const index of facts.ends.keys()) {
    if (!Number.isInteger(index) || index < 1 || index > N) return notRun(`Kane ended a step ${index} that the frozen test does not have`);
  }
  if (facts.endConflict) return notRun('Kane reported two different results for the same step');

  const status = (i) => facts.ends.get(i);
  if (status(1) !== 'passed') {
    if (status(1) === 'failed') {
      const d = stepDetail(facts, 1);
      return notRun(`Kane could not confirm the landmark at step 1 (${steps[0].title})${d.oneLiner ? `: ${d.oneLiner}` : ''}`, {
        landmarkFailed: true,
        kaneOneLiner: d.oneLiner,
        kaneReason: d.reason,
      });
    }
    return notRun('Kane reported no result for step 1, the landmark');
  }

  if (overall === 'passed') {
    if (exitCode !== 0) return notRun(`Kane's exit code (${exitCode}) does not match its result (passed)`);
    for (let i = 1; i <= N; i++) {
      if (status(i) !== 'passed') return notRun(`Kane's result is passed, but step ${i} did not pass in its step list`);
    }
    if (!summaryAgrees(facts.summary, { total: N, passed: N, failed: 0, skipped: 0 })) {
      return notRun("Kane's step counts do not match its step list");
    }
    return { outcome: 'passed', ...base, stepsPassed: N };
  }

  if (exitCode !== 1) return notRun(`Kane's exit code (${exitCode}) does not match its result (failed)`);
  const failed = [];
  for (let i = 1; i <= N; i++) if (status(i) === 'failed') failed.push(i);
  if (failed.length !== 1) return notRun(`Kane's result is failed, but its step list shows ${failed.length} failed steps`);
  const k = failed[0];
  for (let i = 1; i < k; i++) {
    if (status(i) !== 'passed') return notRun(`Kane's step ${i} has no pass before the failed step ${k}`);
  }
  for (let i = k + 1; i <= N; i++) {
    if (status(i) !== undefined && status(i) !== 'skipped') return notRun(`Kane ran step ${i} after the failed step ${k}`);
  }
  if (!summaryAgrees(facts.summary, { total: N, passed: k - 1, failed: 1, skipped: N - k })) {
    return notRun("Kane's step counts do not match its step list");
  }
  const d = stepDetail(facts, k);
  if (d.family === 'environment_issue') {
    return notRun(`Kane says step ${k} failed because of the environment, not the app${d.oneLiner ? `: ${d.oneLiner}` : ''}`, {
      kaneOneLiner: d.oneLiner,
      kaneReason: d.reason,
    });
  }
  return {
    outcome: 'failed',
    ...base,
    failedStep: k,
    failedTitle: steps[k - 1].title,
    kaneOneLiner: d.oneLiner,
    kaneReason: d.reason,
    stepsPassed: k - 1,
  };
}
