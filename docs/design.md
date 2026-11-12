# Design: Proven

Proven is a small Node.js CLI (Node 22+, no runtime dependencies). It closes a ticket only on Kane CLI evidence.
Proven never judges pass or fail. It runs Kane, reads Kane's NDJSON events, compares hashes and git history, and
writes receipts. This document covers Requirements 1 to 4. Requirements 5 to 8 come after the first gate.

## Files

| Path | Written by | Committed | Holds |
|---|---|---|---|
| `tickets/T-N.md` | a person (`proven new` makes the skeleton) | in F | title, start URL, landmark, acceptance criteria, notes |
| `tickets/T-N_test.md` | `proven freeze` | in F | Kane test: step 1 opens the start URL and checks the landmark, then one step per criterion |
| `tickets/T-N.lock.json` | `proven freeze` | alone, right after F | sha256 of the test and the ticket, and F |
| `.proven/state/T-N.json` | `proven red`, `proven done` | alone (red, failed attempts), with the receipt (green) | status, the red run, attempts, last failure |
| `receipts/T-N.json` | `proven done` | with Kane's recording, right after G | the receipt |
| `tickets/output-T-N/` | Kane | with the receipt | Kane's recording, which later replays need |
| `.proven/config.json` | a person | yes | app folder, Kane command, time limit, attempt limit |
| `.proven/runs/` | Proven | never (gitignored) | raw Kane output and copies of failing screenshots, for the agent |
| `.testmuai/` | Kane | never (gitignored) | evidence packs, which carry the runner's name and email |

Config defaults: `{"app": "demo/app", "kane": ["kane-cli"], "timeout_s": 300, "max_attempts": 4}`. The Kane command
is read only from the config file, never from the environment, so an agent cannot swap Kane for a script that
always passes by setting a variable.

## Ticket and test format

```
# T-1: Coupon SAVE10 takes 10% off

Start URL: http://localhost:8091/
Landmark: Your cart

## Acceptance criteria

### Apply SAVE10
Type SAVE10 in the coupon field and click Apply.
Verify the order total shows $27.50.

## Notes
Free text for the agent. Not part of the test.
```

Each `###` block under `## Acceptance criteria` is one criterion: its heading becomes the Kane step title and its
lines become the step text. Freeze refuses a ticket with no start URL, no landmark or no criteria, and says which is
missing. It also refuses a criterion whose last line does not start with "Verify", because a criterion with nothing to
check on screen proves nothing.

The frozen test (`front matter mode: testing`, then the title, then the steps):

```
## Open the start page
Open http://localhost:8091/
Verify the text "Your cart" is shown on the page.

## Apply SAVE10
Type SAVE10 in the coupon field and click Apply.
Verify the order total shows $27.50.
```

## The commit rule

Any commit a lock or a receipt names must already contain what it vouches for, so a lock or receipt always goes in its
own commit after the commit it names. Proven commits with git plumbing on a temporary index (`read-tree HEAD`,
`add -A -- <paths>`, `write-tree`, `commit-tree`, `update-ref HEAD <new> <old>`), so each commit holds exactly the
named paths, whatever else is staged, and a moved HEAD makes the commit fail instead of losing work. After each commit
Proven lists the changed paths and stops if any falls outside the allowed set.

| Command | Commit | Paths |
|---|---|---|
| freeze | F | `tickets/T-N.md`, `tickets/T-N_test.md` |
| freeze | lock | `tickets/T-N.lock.json` |
| red | state | `.proven/state/T-N.json` (red commit = HEAD before it) |
| done, Kane failed | state | `.proven/state/T-N.json` (attempt count) |
| done, Kane passed | G | the app folder (G = HEAD if the app folder is already committed) |
| done, Kane passed | receipt | `receipts/T-N.json`, `tickets/output-T-N/` (no `evidence/`, no `*.evidence`), `.proven/state/T-N.json` |

## Reading the frozen test (1.4)

Every command that runs a test checks that the lock exists, that the test file's sha256 equals the lock's, and that
the test as committed at F has the same sha256. `done` also checks that the lock is byte-identical to the lock at the
red commit, so a freeze after red cannot slip through.

## Running Kane

`kane-cli testmd run tickets/T-N_test.md --agent --headless`, from the repo root, as its own process group. Proven
keeps its own timer (default 300 s) and kills the whole group on timeout or Ctrl+C, because Kane's launcher ignores
SIGTERM and runs the real CLI as a child. Proven reads only stdout NDJSON for decisions. Kane's stderr is shown, with
emails and home paths masked, only as a hint when Kane did not start.

Before each run Proven checks that the start URL answers HTTP 200 and, if not, says "did not run: the app is not
answering at <url>" and records nothing. It checks again after the run.

## Classifying a run

Inputs: Kane's events, exit code, and the frozen step titles. A run is:

- **passed** when the exit code is 0, `test_md_done.overall_status` is passed, every step 1..N ended passed and the
  `test_md_summary` counts agree.
- **failed at step k** when the exit code is 1, the status is failed, step 1 (the landmark) passed, steps 1..k-1
  passed, step k failed, the steps after k are absent or skipped, and the summary counts agree.
- **did not run** in every other case: exit 2 or 3, Proven's timer fired, no `test_md_done`, step 1 failed, a heading
  that does not match the frozen test, or any disagreement between the result, the exit code and the step list. A
  failed step whose `test_md_bug_verdict` has family `environment_issue` is also "did not run". This is Kane saying the
  environment broke, as in the measured dead-server run where step 1 passed on Chrome's error page.

For a failed step Proven takes Kane's `one_liner` (or the bug verdict's) and `reason` from the events inside that
step. Credits are the sum of `credits_consumed` over all `run_end` events.

## red (Requirement 2)

1. Check the frozen test, and refuse if a red is already recorded for this freeze.
2. Refuse while `git status` shows any change in the app folder, untracked files included.
3. Probe the start URL, run Kane, probe again, and check that HEAD and the app folder did not change during the run.
4. Failed at step k: write state `red` with HEAD, step, title, one_liner, reason, duration, credits, evidence sha256
   and Kane version, then commit it alone. Passed: write state `already-passes` and commit it. The ticket is then
   blocked until a person sharpens the criteria and freezes again. Did not run: print why, record nothing, exit 2.

Exit codes: 0 red recorded, 1 already passes, 2 did not run or refused.

## done (Requirement 3)

1. Needs state `red` or `in-progress` for the current freeze. Checks the frozen test, the lock against the red
   commit, and that the red commit is an ancestor of HEAD. Probes the app.
2. Hashes the app folder (tracked and untracked, not ignored) before and after the run. A change, or a moved HEAD,
   means did not run.
3. Failed: print the step number and title, Kane's one_liner and reason, the failing step's screenshot path inside
   the evidence pack (and a copy under `.proven/runs/`), "Fix the app, not the test.", on stdout and stderr. Count one
   attempt and commit the state. The 4th failure moves the ticket to `needs-a-person`. Exit 1.
4. Did not run: say why, count nothing, exit 2.
5. Passed: re-check ancestry and the test bytes, commit the app folder as G, refuse if G's app tree equals the red
   commit's (a pass on unchanged code proves nothing), check Kane's recording for leaks, write the receipt naming G,
   commit receipt + recording + state, print "Done: red <short>, green <short>." and exit 0.

## Evidence packs

Proven finds the pack from the NDJSON: `test_md_evidence_ingest.evidence_id` under `<repo>/.testmuai/evidence/`, then
next to the test, then `coverage.pack`. It hashes the file bytes. A small zip reader (stored and deflate entries,
`zlib.inflateRawSync`) reads `failure.yaml` to find the failing step's screenshot
(`tests/<name>/steps/<ordinal>-<k-1>-<n>/screenshot.jpg`). Pack paths are printed but never stored.

## Receipt (Requirement 4)

```
{ receipt: 1, ticket, title, app,
  frozen:   { commit F, test, test_sha256, ticket, ticket_sha256 },
  red:      { commit, failed_step, failed_step_title, kane_one_liner, kane_reason, evidence_sha256, kane_cli, duration_s, credits },
  green:    { commit G, steps_passed, steps_total, evidence_sha256, kane_cli, duration_s, credits, failed_attempts },
  recording:{ path, sha256 },
  receipt_sha256 }
```

`receipt_sha256` is the sha256 of the canonical JSON (keys sorted, no spaces) of everything else. The recording
sha256 is the sha256 of a manifest of `<sha256 of file>  <path>` lines, sorted by path, so it can be recomputed from
the working tree or from any commit.

`proven verify receipts/T-N.json` uses git only, with no network, and prints CONFIRMED (exit 0) or MISMATCH with each
failed check (exit 1):

1. the receipt hash matches its contents;
2. the test and ticket at F match the receipt;
3. F is an ancestor of the red commit (the test was frozen before red);
4. the red commit is an ancestor of G;
5. the test did not change between red and G (same bytes at both, no commit in red..G touches it);
6. the app folder differs between red and G;
7. the receipt is committed as it is, and Kane's recording in that commit matches the receipt.

`--replay` (4.3) is a stub until Requirement 5 lands.

## Leak guards

Proven's own files (tickets, tests, locks, state, receipts) never hold a session id or folder, share URL, Test
Manager link, absolute path, name or email. Kane's text (`one_liner`, `reason`) is scrubbed before it is stored, and
every JSON file Proven writes is checked before writing. Kane's recording folder is committed byte for byte, because
Kane reads `.internal/meta.json` (its `commit_id`) on later runs. Before committing it, Proven refuses if it holds an
email, a home path, a share URL or a Test Manager link. That recording does carry Kane's own session and account ids.

## Testing

`npm test` runs `node --test` and never calls the real Kane CLI. A fake Kane (`test/support/fake-kane.js`) replays
scrubbed NDJSON recorded from Kane CLI 0.10.4 with the recorded exit codes. Like Kane, it writes the recording folder
and an evidence pack, and it can hang, crash or change the app mid-run. The end-to-end tests drive the whole loop in
temporary git repos against the real demo server. A `kane-cli` shim placed first on PATH fails loudly if anything
reaches for the real CLI. A leak test scans every blob of every commit for emails, home paths, temp paths, share
links and session ids.
