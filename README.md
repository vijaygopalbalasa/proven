# Proven

A ticket closes only when Kane CLI saw its frozen test fail before the change and pass after it.

## The idea: red, then green

AI coding agents say a ticket is done before it is. A passing test proves little if it might have passed anyway. So
with Proven, a person writes a ticket and freezes its acceptance test before any work starts. Kane must fail that test
on the code as it is (red). The agent then changes the app and runs `proven done`, and Kane must pass the same,
unchanged test (green). Proven never judges pass or fail itself: it runs Kane, reads Kane's events, checks hashes and
git history, and writes a receipt that anyone can re-check. A later change that breaks a closed ticket reopens it.

## Install

- Node.js 22 or newer and git. Proven has no dependencies to install.
- For live runs: Kane CLI (`npm install -g @testmuai/kane-cli`), Google Chrome, and `kane-cli login`.
- For the agent loop: Claude Code (`claude`).

```
npm test       # every command, end to end, on a fake Kane: no login needed
npm start      # judge mode: the board over the receipts committed here, at http://127.0.0.1:8090/
```

Run `npm link` once to call Proven as `proven`. The commands below use `node bin/proven.js`, which works without it.

## The loop, with exact commands

The demo shop is in `demo/app/`. Tickets T-1 and T-2 are already closed with real Kane receipts. T-3 is written and
waiting: marketing put a new code in `demo/app/coupons.json`, and the cart ignores that file.

```
node bin/proven.js board                  # second terminal: the board at http://127.0.0.1:8090/, live
node bin/proven.js freeze T-3             # a person freezes the ticket's test
node bin/proven.js red T-3                # Kane must fail it on the shop as it is: red

# The agent's turn (see the next section). It ends with: Done: red <sha>, green <sha>.
claude -p --model claude-sonnet-5-5 --permission-mode acceptEdits \
  --allowedTools "Bash(node bin/proven.js done *)" \
  "Ticket T-3 is red. Read tickets/T-3.md and make it true in demo/app. When you believe it is done, run node bin/proven.js done T-3 and follow what it prints."

node bin/proven.js recheck                # replays every done ticket; T-3's change broke T-1, so T-1 reopens
claude -p --model claude-sonnet-5-5 --permission-mode acceptEdits \
  --allowedTools "Bash(node bin/proven.js done *)" \
  "proven recheck reopened T-1. Read tickets/T-1.md and .proven/state/T-1.json for what Kane saw, fix demo/app, then run node bin/proven.js done T-1 and follow what it prints."

node bin/proven.js verify receipts/T-1.json --replay   # git checks, then Kane again at red and at green
```

Proven serves the app itself while Kane runs, on the start URL's port (8091 here), so nothing else may listen there.
`npm run demo` serves the shop for looking at it by hand; stop it before `red`, `done`, `recheck` or `--replay`.

## How the agent loop works with Claude Code

`proven init` writes three files, which are already committed in this repository:

- `.claude/hooks/proven-guard.mjs`, run by a PreToolUse hook in `.claude/settings.json` before every Write, Edit,
  MultiEdit, NotebookEdit and Bash call. It blocks changes under `tickets/` (where Kane also keeps its recordings),
  `receipts/`, `.proven/` and `.claude/`, by the file tools or by the usual shell ways (`>`, `tee`, `cp`, `mv`, `ln`,
  `rsync`, `mkdir`, `touch`, `rm`, `sed -i`, `tar -C`, `unzip -d`), and the commands `proven new`, `proven freeze` and
  `proven red`, which are a person's steps. It exits with code 2 and says why on stderr, which Claude Code shows to the
  agent.
- Bash time limits in the same settings (10 minutes), because a Kane run takes a minute or two and `proven done` runs
  in the foreground.
- A section in `CLAUDE.md`: when the agent believes a ticket is done, it runs `proven done T-N`; it fixes the app,
  never the test. If `CLAUDE.md` or the settings already exist, `proven init` merges into them and keeps the rest.

The agent edits the app and runs `proven done T-N`. Kane decides:

- Exit 1, Kane failed: Proven prints the failing step, Kane's own one-liner and reason, the screenshot inside the
  evidence pack, and "Fix the app, not the test." The agent reads it and tries again. After 4 failed attempts the
  ticket needs a person.
- Exit 2, Kane did not run (signed out, app not answering, time limit): no attempt is counted.
- Exit 0, Kane passed: Proven commits exactly the app snapshot Kane judged (commit G), then the receipt.

The guard rails are not a sandbox. An agent with a shell can get around a hook, so the board shows a ticket as done
only when its receipt verifies.

## Verify and replay

```
node bin/proven.js verify receipts/T-1.json            # git only, no network: CONFIRMED or MISMATCH
node bin/proven.js verify receipts/T-1.json --replay   # and Kane runs the frozen test again
```

`verify` checks the receipt's own hash, that the frozen test at its commit matches, that the lock was written once
right after it, that red is an ancestor of green, that the test did not change in between, that the app trees match
and changed, and that the state history shows this red and one commit per failed attempt. Paths come from the ticket
id, never from the receipt.

`--replay` re-checks red itself, not only green. Proven serves the app as it was at the red commit and runs Kane on the
frozen test, which must fail at the recorded step, then serves the app as it was at the green commit, where Kane must
pass. Each side is a fresh run: Kane works from the frozen test's text, never from a recording. Either side
disagreeing is a MISMATCH. When Kane cannot run (signed out, no network, time limit), the output says
"replay skipped" with the reason, and the git result stands.

## Recheck and reopen

`proven recheck` runs the frozen test of every done ticket again, against the app as committed now, with
`--no-adaptive-heal`. Kane's local recording is moved aside, so Kane authors every step fresh and an edited recording
cannot say "still passes". A browser agent can fail for a harmless reason, so a failure is confirmed by a second fresh
run before anything changes. Only a confirmed failure reopens the ticket: a state commit of its own records the commit
and app tree Kane judged, the failing step, Kane's reason and the evidence hash. The agent then needs a new green through
`proven done`, and the new receipt links the earlier one. `verify` checks that link and the earlier receipt too.

## The board

`proven board` (or `npm start`, in judge mode) serves a local page with no build step: each ticket's state (frozen,
red, in progress, done, reopened, needs a person) with its evidence in plain words. Red shows Kane's own one-liner and
a "Failed before the change" stamp; green shows "Passed after", the commits, the credits and the receipt. It updates
live over server-sent events when a commit changes a ticket, and shows done only for a receipt that verifies with git.
It listens on 127.0.0.1 only and answers only requests addressed to localhost, so another web page cannot read it.

## Commands

| Command | Who | What it does |
|---|---|---|
| `proven new T-N "<title>" [--url U] [--landmark L]` | person | writes `tickets/T-N.md` to fill in |
| `proven freeze T-N` | person | writes `tickets/T-N_test.md`, commits ticket and test, then a lock naming that commit |
| `proven red T-N` | person | Kane must fail the frozen test on the code as it is, for the right reason |
| `proven done T-N` | agent | Kane decides. A pass commits the change and the receipt |
| `proven verify receipts/T-N.json [--replay]` | anyone | re-checks a receipt with git, and with `--replay` with Kane at red and green |
| `proven recheck [T-N ...]` | person or agent | replays done tickets and reopens one whose failure a fresh run confirms |
| `proven board [--port 8090] [--judge]` | anyone | the local board |
| `proven init` | person | the Claude Code guard rails |

Exit codes for `red` and `done`: 0 ok, 1 Kane failed (or, at red, the test already passes), 2 did not run. For
`recheck`: 0 all still pass, 1 a ticket reopened, 2 something did not run.

## How a run counts

- Kane judges a snapshot, never the live folder. Proven writes the app folder as a git tree (what a commit would
  hold), serves exactly that on the start URL's port for the whole run, and on a pass commits exactly that tree.
- Kane's recording (`tickets/output-T-N/`) never decides a verdict, because it is not committed and anyone with a
  shell can edit it. Proven has two defences: it moves the recording out of the repository for every run (and puts it
  back afterwards exactly as it was), and it passes `--author`, so Kane authors every step even if a recording
  appears while it runs. Then it checks: a run whose summary shows any replayed or healed step, or whose output folder
  holds a file Kane did not write during the run, counts as "did not run", never as a pass or a fail.
- Each test starts by opening the start URL and checking a landmark text. Proven checks that the URL answers HTTP 200
  before Kane starts.
- Red runs right after freeze, on the commit that locked the test.
- Red, or a failed attempt, needs Kane's exit code, final result and step list to agree, the landmark step to pass and
  a later step to fail. A pass needs every step to pass. Anything else is "did not run".

## Files

`tickets/` holds tickets, frozen tests and locks. `receipts/` holds receipts. `.proven/state/` holds each ticket's red
record and attempts. `.proven/config.json` holds the app folder, the time limit and the attempt limit, which are
pinned when a ticket is frozen.

## Honest limits

- Local checks are tamper-evident, not tamper-proof. An agent with a shell can forge local git history (commits shaped
  like Proven's, a state file, a receipt). The stronger check is `verify --replay`, where Kane itself runs the frozen
  test again at red and at green.
- Receipts are tamper-evident for the files they hash. Kane does not sign them.
- The guard rails are not a sandbox, which is why done is shown only for a receipt that verifies.
- The app must be static files for now, because Proven serves its own snapshot of the app folder while Kane runs, and
  the start URL must be local with a port, like http://localhost:8091/.
- Kane's verdicts can be flaky. That is why red needs a passing landmark and a failing later step, why anything unclear
  counts as "did not run", and why recheck confirms a failed replay with a fresh run before it reopens anything.
- Evidence packs are not committed, because they carry the runner's name and email. Proven keeps only their sha256.
- Kane's recording folder (`tickets/output-T-N/`) stays local, because it carries Kane account and session ids, and
  it is never used for a verdict. So every run authors every step: a minute or two and about 10 to 30 credits each.
- `recheck` and `verify --replay` run Kane, so they need Kane CLI, Chrome, a login and credits. `recheck` makes one
  run per done ticket and a second one to confirm a failure; `--replay` makes two. So far they have run only against
  the test fake, not against live Kane.
- `--author` comes from Kane CLI 0.10.4's own help ("re-author every step"); it has not run live yet. If Kane ever
  rejected it, every run would say "did not run", so nothing could pass by mistake.
- `recheck` judges the app as committed and refuses while the app folder has uncommitted changes.
- The tests use a fake Kane through the `PROVEN_KANE_BIN` variable. Every run made that way says so in the output, the
  state and the receipt, and `verify` flags such a receipt.

## Measured Kane facts

Measured with Kane CLI 0.10.4 before and during the build:

- A frozen 2-step test failed 3 of 3 fresh runs on a broken page and passed 3 of 3 on a working one.
- A saved test replayed with `--no-adaptive-heal` on a broken page failed. A replay cost about 3.6 credits; a fresh
  run of a 2-step test cost about 10 to 30.
- With the app's server down, a step that only opened the page passed on Chrome's error page and the next step failed,
  so an outage looked like a real bug. With a landmark check in step 1, step 1 failed instead. So Proven checks the
  app answers, and step 1 always checks a landmark.
- Kane read a comment in the page's script and quoted it in its reason, so the demo's bugs never announce themselves.
- Kane leaves the test file unchanged, writes its recording next to it in `output-<stem>/`, and skips the steps after
  a failed one.
- In Claude Code, with the Bash time limits that `proven init` sets, a 90-second foreground command returned its
  output, so `proven done` can wait for Kane.
- The live gate: T-1 and T-2 went red ("The test expected SAVE10 to reduce the total, but the store rejected that code
  and kept the total at $30.00."), a headless Claude Code agent fixed each through `proven done` on its first attempt,
  and `proven verify` printed CONFIRMED for both receipts.
