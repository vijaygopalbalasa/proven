# Design: Proven

Proven is a small Node.js CLI (Node 22+, no runtime dependencies). It closes a ticket only on Kane CLI evidence.
Proven never judges pass or fail. It runs Kane, reads Kane's NDJSON events, compares hashes and git history, and
writes receipts. This document covers Requirements 1 to 8. Requirements 1 to 4 passed a live gate with Kane before
5 to 8 were built.

## Files

| Path | Written by | Committed | Holds |
|---|---|---|---|
| `tickets/T-N.md` | a person (`proven new` makes the skeleton) | in F | title, start URL, landmark, acceptance criteria, notes |
| `tickets/T-N_test.md` | `proven freeze` | in F | Kane test: step 1 opens the start URL and checks the landmark, then one step per criterion |
| `tickets/T-N.lock.json` | `proven freeze` | alone, right after F | sha256 of the test and the ticket, F, and the pinned settings with their sha256 |
| `.proven/state/T-N.json` | `proven red`, `proven done`, `proven recheck` | alone (red, each failed attempt, a reopen), with the receipt (green) | status, the red record, attempts, last failure, the reopen |
| `receipts/T-N.json` | `proven done` | with the state, right after G | the receipt |
| `tickets/output-T-N/` | Kane | never (gitignored) | Kane's recording: it carries Kane account and session ids, so it stays local, and it never decides a verdict (moved aside for every run) |
| `.proven/config.json` | a person | yes | `app`, `timeout_s`, `max_attempts` (nothing else is allowed) |
| `.proven/runs/` | Proven | never (gitignored) | raw Kane output, copies of failing screenshots for the agent, and `T-N/active.json` while Kane runs, for the board |
| `.testmuai/` | Kane | never (gitignored) | evidence packs, which carry the runner's name and email |
| `.claude/settings.json`, `.claude/hooks/proven-guard.mjs`, `CLAUDE.md` | `proven init` | by a person, if they want | the guard rails for a Claude Code agent |

## Kane and the settings

Proven always runs `kane-cli` from PATH. No file in the repository can change that: `.proven/config.json` refuses a
`kane` key. Tests swap in a fake Kane only through the test-only environment variable `PROVEN_KANE_BIN`. Every run
made that way prints `Kane: fake (PROVEN_KANE_BIN)` on stdout and stderr, and the state and the receipt record
`kane: "fake (PROVEN_KANE_BIN)"` for that run. `verify` then says the receipt was made with a fake Kane, and `done`
refuses to finish on a different Kane from the one red ran on.

The settings that shape verdicts are pinned in the lock at freeze: `{app, timeout_s, max_attempts, start_url}` and
their sha256. The start URL comes only from step 1 of the frozen test. Red and done refuse when the settings differ
from the lock. There is no `--timeout` flag.

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
check on screen proves nothing. The frozen test starts with `## Open the start page` (`Open <url>`, then
`Verify the text "<landmark>" is shown on the page.`), followed by one `##` step per criterion.

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
| done, Kane failed | state | `.proven/state/T-N.json` (one commit per failed attempt) |
| done, Kane passed | G | the app folder (G = HEAD if the app folder is already committed) |
| done, Kane passed | receipt | `receipts/T-N.json`, `.proven/state/T-N.json` |
| recheck, a confirmed failure | reopen | `.proven/state/T-N.json` (red again = HEAD before it) |

## What Proven trusts

- **The frozen test (1.4).** Every run checks that the test's sha256 equals the lock's and that F holds the same
  bytes. Done also checks that the lock is unchanged since red and that no commit after red touched the test, even
  one that changed it back.
- **The lock chain.** After F, the lock is written exactly once, in its own commit L, right on F. Red must run on L
  itself (HEAD = L), so the code Kane fails is the code that was frozen. If HEAD has moved before red, `proven freeze`
  locks the ticket again on the current commit (an empty F commit, then a new lock).
- **The state.** Decisions come from the state as committed at HEAD. A working-tree copy that differs from HEAD is
  refused. Every commit that ever changed a state file must look like Proven's: the state file alone, or the receipt
  commit. The red record must have every field (nothing is assumed). The state history after L comes in rounds. Round
  1 starts with the first state commit after L, which must sit right on L and record red on L. A later round starts
  when `proven recheck` reopens a done ticket: that state commit must follow a done and sit right on the commit it
  names as red. Inside a round no state commit may change the round's red record, and nothing follows a done except a
  reopen, or a needs a person at all. The number of state commits since the current red must be the attempt count
  plus one.
- **The app folder: Kane judges a snapshot, never the live folder.** For each run Proven writes the app folder as a
  git tree with a temporary index (what a commit would hold: tracked and untracked files, not ignored ones), exports
  that tree to a temporary folder and serves it itself, with `Cache-Control: no-store`, on the start URL's port for
  the whole run. A port held by another server means did not run, with a message to stop it. The tree id is the
  app's fingerprint. Red records it (and it must equal the app at L). On a pass, done commits exactly that tree as G,
  built from the tree with `read-tree --prefix`, so the code judged and the code committed are the same by
  construction. Edits made while Kane runs never reach G, and files git ignores are never served. Symlinks are
  refused for clarity. The same export-and-serve module will serve the red and green commits for `verify --replay`.

## Running Kane

`kane-cli testmd run tickets/T-N_test.md --agent --headless`, from the repo root, as its own process group, while
Proven serves the snapshot. Kane would replay the steps it recorded in `tickets/output-T-N/`, a folder that is never
committed and that anyone with a shell can edit, so a tampered recording could pass a broken app. Proven therefore
copies that folder out of the repository and removes it before every run, so Kane authors every step from the frozen
test, and afterwards puts it back exactly as it was (or removes the one Kane wrote, if there was none). Kane's output
from the run is kept in `.proven/runs/` and its evidence pack in `.testmuai/`. Proven keeps its own timer (`timeout_s`, default 300) and kills the whole group on timeout
or Ctrl+C, because Kane's launcher ignores SIGTERM and runs the real CLI as a child. Decisions use only stdout NDJSON.
Kane's stderr is shown, with emails and home paths masked, only as a hint when Kane did not start. Before Kane starts,
Proven checks that the start URL answers HTTP 200 from the snapshot and, if not, says "did not run: the app is not
answering at <url>" and records nothing. A commit made while Kane runs voids the run. For now the app must be static
files under the app folder, and the start URL must be local with a port (for example http://localhost:8091/).

## Classifying a run

- **passed**: exit code 0, `test_md_done.overall_status` passed, every step 1..N ended passed, and the
  `test_md_summary` counts agree.
- **failed at step k**: exit code 1, status failed, step 1 (the landmark) passed, steps 1..k-1 passed, step k failed,
  later steps absent or skipped, and the summary counts agree.
- **did not run**: everything else. That covers exit 2 or 3, Proven's timer, no `test_md_done`, a failed step 1, a
  heading that is not the frozen test's, and any disagreement between the result, the exit code and the step list. A
  failed step whose `test_md_bug_verdict` has family `environment_issue` also counts as did not run. That is Kane
  saying the environment broke, as in the measured dead-server run where step 1 passed on Chrome's error page.

## red, done, verify

- **red** runs only on the lock commit and refuses a dirty app folder. It runs Kane, and on a clean red it commits the
  red record (HEAD, the app tree, step, title, Kane's one_liner and reason, duration, credits, evidence sha256, Kane
  version, which Kane). A pass records "already
  passes" and blocks the ticket until a new freeze. Exit 0 red, 1 already passes, 2 did not run.
- **done** runs Kane on the agent's change. On a failure it prints the step, title, Kane's words, the failing
  screenshot inside the evidence pack (and a copy under `.proven/runs/`) and "Fix the app, not the test.", on stdout
  and stderr, exit 1. It counts one attempt, and the 4th failure means "needs a person". Did not run is exit 2 and
  counts nothing. On a pass it commits the judged tree as G, then the receipt and the state, and prints
  "Done: red <short>, green <short>.". Kane's recording is never committed.
- **verify** uses git only. Paths come from the ticket id, never from the receipt. It checks:
  1. the receipt's paths match its ticket;
  2. the receipt hash matches its contents;
  3. the test and ticket at F match the receipt;
  4. the lock was written once, in its own commit right on F, names F, pins the receipt's settings, and is the red
     commit;
  5. F is an ancestor of red;
  6. red is an ancestor of G;
  7. the test did not change between red and G;
  8. the app trees at red and G match the receipt, and differ;
  9. the state history shows the red record right after red, then one commit per failed attempt;
  10. the receipt is committed as it is, after G;
  11. for a ticket that was reopened and closed again: the earlier receipt it links is committed as linked, has the
      same frozen test and settings, came before this red with no state change in between, and verifies itself.

  For a later close, check 4 does not ask red to be the lock commit, and check 9 expects a reopen right after red,
  linking the same earlier receipt. It prints CONFIRMED (exit 0) or MISMATCH with each failed check (exit 1).

## Replay (4.3)

`verify --replay` runs only when the git checks pass. It takes the frozen test from F, refuses to run when the test
in the working tree differs (Kane runs on that path), and runs Kane on it twice, fresh like every run (no recording,
so Kane authors every step from the test's text): first with the tree at red (`red.app_tree`) served on the start
URL's port, where Kane must fail at the recorded step, then with the tree at green, where Kane must pass. A fresh clone
behaves the same, and Kane's adaptive heal (up to 3 re-authoring attempts on a replay miss, then a full re-author)
cannot run into the time limit. A side that disagrees makes the result MISMATCH. When Kane does not run, the line says "replay skipped" with the reason
and the git result stands; without a red replay there is nothing to compare, so green is not tried. A replay writes
nothing to git.

## Recheck and reopen (5)

`proven recheck [T-N ...]` takes every ticket whose state is done, and skips (with the reason) one that fails the
checks done makes (the frozen test, the lock chain, the red record) or whose receipt does not verify. It refuses while
the app folder has uncommitted changes, so a reopen names exactly the code Kane judged: the app tree at HEAD. For each
ticket, Kane runs the frozen test with `--no-adaptive-heal` and, like every run, without its recording, so it authors
every step fresh; Requirement 5 asked for a replay, but a replay would trust the editable recording, so a tampered one
could say "still passes". A pass or a did not run changes nothing. A failure is confirmed by a second fresh run. If
that passes, the ticket stays done. If it fails too, and no commit was made meanwhile, the state is written again in a
commit of its own on HEAD: status reopened, attempts 0, a new red record from the second run (commit = HEAD, the app
tree, step, Kane's words, credits, evidence hash), and `reopened` with the first run's failure and the earlier receipt
(path, the commit that wrote it, its sha256, its green). Exit 1 when a ticket reopened, 2 when something did
not run, 0 otherwise.

`proven done` works on a reopened ticket as on a red one. Its receipt carries `previous: { commit, receipt_sha256 }`,
taken from the reopen. `red` and `freeze` refuse a reopened ticket.

## The board (6)

`proven board [--port 8090] [--judge]` serves one HTML page (no build step, no dependencies, nothing loaded from the
network) on the loopback addresses only, plus `/api/board`, `/events` (server-sent events) and
`/receipts/T-N.json` (the receipt as committed). The model reads only committed state: the lock and state at HEAD,
trusted only when Proven's own commits wrote them and the red record checks out, and done only when the receipt
verifies with git; otherwise the card says needs a person and why. Each second the server compares a cheap key
(HEAD, the ticket files, the `active.json` files) and, when it changed, builds the model again and pushes it if it
differs. The page builds every element with text, never markup. Done cards carry a red "Failed before the change" and
a green "Passed after" stamp. `npm start` is `proven board --judge`, which adds a note that the cards come from the
committed receipts and that new runs need `kane-cli login`.

## Guard rails for the agent (7)

`proven init` copies `src/hooks/proven-guard.mjs` (Node only, no imports from Proven) to
`.claude/hooks/proven-guard.mjs`, adds one PreToolUse hook to `.claude/settings.json` for Write, Edit, MultiEdit,
NotebookEdit and Bash (`node "$CLAUDE_PROJECT_DIR/.claude/hooks/proven-guard.mjs"`), sets Bash time limits of 10 and
15 minutes unless the settings hold others, and puts a marked section into `CLAUDE.md`. It reads and checks everything
before it writes, keeps other settings and text, replaces only its own hook and section on a second run, and commits
nothing. The guard reads Claude Code's PreToolUse JSON from stdin. It blocks (exit 2, the reason on stderr) a file tool
whose path, after symlinks and without case, falls under `tickets/`, `receipts/`, `.proven/` or `.claude/`, and a Bash
command that runs `proven new`, `freeze` or `red` (also behind node, npx, env or `sh -c`, or inside `$( )`) or writes to
those folders with `>`, `>>` or `tee`. Input it cannot read is let through. It is a guard rail, not a sandbox.

## Demo (8)

The shop in `demo/app/` holds no comment or text that names a bug. T-1 (SAVE10) and T-2 (free shipping at $50) were
closed in the live gate. T-3 asks the cart to take exactly the codes in `demo/app/coupons.json`, which marketing filled
with FALL15 only; the cart ignores the file today. Its natural fix drops the SAVE10 code, so after T-3 closes,
`proven recheck` reopens T-1 with the same failure as T-1's first red, and the agent fixes it again (for example by
adding SAVE10 to the file).

## Receipt

```
{ receipt: 1, ticket, title,
  settings: { app, timeout_s, max_attempts, start_url },
  frozen:   { commit F, test, test_sha256, ticket, ticket_sha256 },
  red:      { commit, failed_step, failed_step_title, kane_one_liner, kane_reason, evidence_sha256, kane, kane_cli, duration_s, credits, app_tree },
  green:    { commit G, steps_passed, steps_total, evidence_sha256, kane, kane_cli, duration_s, credits, failed_attempts, app_tree },
  previous: { commit, receipt_sha256 },   (only for a ticket reopened by recheck and closed again)
  receipt_sha256 }
```

`receipt_sha256` is the sha256 of the canonical JSON (keys sorted, no spaces) of everything else. The app trees are
git tree ids. No hash is made from joined strings. Kane's recording is not hashed, because it is never committed.

## Leak guards

No committed file holds a Kane session id or folder, a Kane account id, a share URL, a Test Manager link, an
absolute path, a name or an email. Kane's text is scrubbed before it is stored, and every JSON file Proven writes is
checked before writing. Kane's recording folder and evidence packs are gitignored, and Proven commits only explicit
paths, so they are never committed even where the ignore rule is missing.

## Limits

An agent with shell access can forge local git history, so Proven's local checks are tamper-evident, not
tamper-proof. The stronger check is `verify --replay`: Kane re-runs the frozen test at the red commit, expecting the
recorded failure, and at the green commit, expecting a pass. The guard rails are not a sandbox, so the board shows done
only for a receipt that verifies.

## Testing

`npm test` runs `node --test` and never calls the real Kane CLI. The fake Kane (`test/support/fake-kane.js`, set
through `PROVEN_KANE_BIN`) replays scrubbed NDJSON recorded from Kane CLI 0.10.4 with the recorded exit codes. Like
Kane, it writes the recording folder and an evidence pack, fetches pages from the app Proven serves, and it can hang,
crash, leak private text or change the app mid-run. It accepts only the flags Kane CLI 0.10.4 has for `testmd run`,
logs which ones it got and whether a recording was there, and takes a list of scenarios for a command that runs Kane
more than once (verify --replay, recheck). The end-to-end tests drive the whole loop in temporary git repos against the real demo server. A `kane-cli`
shim placed first on PATH fails loudly if anything reaches for the real CLI. Leak tests scan every blob of every
commit, and this repository itself, for emails, home paths, Kane session and account ids and share links, with no
exception for any folder.
