# Requirements: Proven

## Introduction

AI coding agents say a ticket is done before it is. Proven closes a ticket only on evidence from Kane CLI: the ticket's
acceptance test is frozen before any work starts, Kane must see that test FAIL on the code as it is (red), and later
PASS on the changed code (green), with the test unchanged in between. Every closed ticket keeps both runs in a receipt
anyone can re-check, and a later change that breaks a closed ticket reopens it.

A person writes and freezes tickets. The coding agent (a headless Claude Code session in the demo) does the work and
calls `proven done` when it believes a ticket is finished; Kane's verdict, read by Proven, decides. Proven itself never judges pass or fail: it
runs Kane, reads Kane's events, compares hashes and git history, and writes receipts.

Measured before this spec (Kane CLI 0.10.4): a frozen 2-step test fails 3 of 3 runs on a broken page and passes 3 of 3
on a working one; a saved test replayed with `--no-adaptive-heal` on a broken page fails; Kane leaves the test file
unchanged and writes its recording to `output-<stem>/` next to it (no names, emails or home paths in it); after a failed
step Kane skips the rest. With the app's server down, an "open the page" step with no check passed on the browser's
error page and the next step failed, so an outage looked like a real failure; with a landmark check in the first step
the first step failed instead. So Proven checks the app answers, and the first step always verifies a landmark.

One rule runs through everything: any commit a lock or a receipt names must already contain what it vouches for. A
lock or receipt is therefore written in its own commit, after the commit it names.

Glossary: a ticket is T-N; its frozen test is `tickets/T-N_test.md` (Kane's test.md format, one `##` step per
criterion); red means Kane failed the frozen test before the change, with the landmark step passing and a later step failing; green means Kane passed the
same test after it; a receipt is `receipts/T-N.json`.

## Requirement 1: Tickets and freeze
**User story:** As a person handing work to an agent, I want to write a ticket in plain English and freeze its test
before work starts, so that the agent cannot move the goalposts.
### Acceptance criteria
1. WHEN a person runs `proven new T-N "<title>"` THE SYSTEM SHALL create `tickets/T-N.md` holding the title, the start
   URL, a landmark (text that must be visible on the page at the start URL) and an empty list of acceptance criteria to
   fill in, each criterion ending in something Kane can verify on screen.
2. WHEN a person runs `proven freeze T-N` THE SYSTEM SHALL write `tickets/T-N_test.md` whose first `##` step opens the
   start URL and verifies the landmark, followed by one `##` step per acceptance criterion, and commit exactly the
   ticket and the test (commit F); then write `tickets/T-N.lock.json` with the test's sha256, the ticket's sha256 and
   F, and commit the lock alone.
3. IF a ticket has no acceptance criteria, no start URL or no landmark THEN `proven freeze` SHALL refuse and say which
   is missing.
4. WHEN any command reads a frozen test THE SYSTEM SHALL compare its sha256 with the lock and with the file as it is at
   the lock's commit, and SHALL refuse to run it when either differs.

## Requirement 2: Red before work
**User story:** As a person, I want proof that the test fails on today's code, so that a later pass means the change
did something.
### Acceptance criteria
1. WHEN a person runs `proven red T-N` THE SYSTEM SHALL refuse while the app folder has uncommitted changes (so the red
   commit holds exactly the code Kane judged), then check that the start URL answers HTTP 200 and, if it does not,
   report "did not run: the app is not answering at <url>" and record nothing.
2. THE SYSTEM SHALL run `kane-cli testmd run tickets/T-N_test.md --agent --headless --author` with its own time limit
   (default 300 s) and read Kane's NDJSON events, never Kane's human-readable text. Kane's recording folder for the test
   SHALL be moved out of the repository for the run and put back exactly as it was, so Kane authors every step from the
   frozen test and no recording decides a verdict; a run whose events show a replayed step, or whose output folder holds
   a file older than the run, SHALL count as "did not run".
3. THE SYSTEM SHALL count the run as red only WHEN Kane's `test_md_done` reports `overall_status` failed AND the first
   step (the landmark) passed AND a later step failed (Kane skips the steps after it). It SHALL record the git commit
   (HEAD), the first failed step's number and title, Kane's `one_liner` and `reason` for it, the run's duration and
   credits, and the sha256 of the evidence pack Kane wrote, in `.proven/state/T-N.json`.
4. IF Kane passes the test THEN THE SYSTEM SHALL mark the ticket "already passes: this test proves nothing yet" and
   SHALL NOT let it be assigned until a person sharpens the criteria and freezes again.
5. IF Kane exits 2 or 3, writes no `test_md_done`, or fails the first step (the landmark) THEN THE SYSTEM SHALL report
   "did not run" with Kane's reason and SHALL NOT count it as red.
6. THE files Proven commits under `.proven/state/` SHALL hold no session folder, Test Manager link, absolute path, name
   or email.

## Requirement 3: The agent's loop
**User story:** As a person, I want the agent to hear Kane's verdict in its own loop, so that it fixes the app until
Kane passes and cannot close the ticket any other way.
### Acceptance criteria
1. WHEN the agent runs `proven done T-N` on a ticket with a recorded red THE SYSTEM SHALL check the frozen test as in
   1.4, check the app answers as in 2.1, run Kane as in 2.2, and print the verdict on stdout and stderr.
2. WHEN Kane fails the test THE SYSTEM SHALL print the failing step's number and title, Kane's `one_liner` and
   `reason`, the path of the failing step's screenshot in the evidence pack, and the line "Fix the app, not the test.",
   exit with code 1, and count one attempt. After 4 failed attempts the ticket SHALL move to "needs a person".
3. WHEN Kane did not run (as in 2.5) THE SYSTEM SHALL say so, exit with code 2, and count no attempt.
4. WHEN Kane passes the test THE SYSTEM SHALL check that the red commit is an ancestor of HEAD and that the frozen test
   is byte-identical to the lock, commit the app folder's changes (commit G, the code Kane just judged), then write
   `receipts/T-N.json` naming G and commit it, mark the ticket done, print "Done: red <short sha>, green <short sha>."
   and exit with code 0. Kane's recording folder for the test (`tickets/output-<stem>/`) stays local and is not
   committed, because it carries Kane account and session ids and the repository is public.
5. THE SYSTEM SHALL never commit files outside the app folder, `tickets/`, `receipts/` and `.proven/state/`, and SHALL
   never commit Kane's recording folders (`output-<stem>/`), session folders or evidence packs. Recordings carry Kane
   account and session ids, so they stay on disk only: replays on the same machine stay cheap, and a fresh clone
   records again.

## Requirement 4: Receipts anyone can re-check
**User story:** As anyone reading the repository, I want to re-check a closed ticket without trusting the agent or the
author.
### Acceptance criteria
1. THE receipt SHALL record the ticket id and title, the frozen test's sha256 and its commit F, the red run (commit,
   failing step, Kane's reason, evidence sha256, Kane CLI version), the green run (commit G, steps passed, evidence
   sha256, Kane CLI version), and its own sha256 over a canonical JSON of everything else. It SHALL NOT hash Kane's
   recording, which stays local because it carries Kane account and session ids.
2. WHEN anyone runs `proven verify receipts/T-N.json` THE SYSTEM SHALL check, with git and no network, the receipt's own
   hash, that the frozen test at the lock commit matches the recorded sha256, that the red commit is an ancestor of the
   green commit, and that the frozen test did not change between them, and SHALL print CONFIRMED and exit 0, or
   MISMATCH with each failed check and exit 1.
3. WHEN `--replay` is given and Kane CLI is signed in THE SYSTEM SHALL serve the app as it was at the red commit and
   check that Kane fails the frozen test there for the recorded step, then serve it as it was at the green commit and
   check that Kane passes, and report both verdicts. This re-checks the red itself, not only the green. IF the replay
   does not complete THEN THE SYSTEM SHALL say so in the headline (`CONFIRMED (git checks only)`) and exit 2.

## Requirement 5: Reopen on regression
**User story:** As a person, I want a closed ticket to reopen when later work breaks it, so that done stays done.
### Acceptance criteria
1. WHEN a person or the agent runs `proven recheck` THE SYSTEM SHALL run the frozen test of every done ticket again,
   fresh as in 2.2 and with `--no-adaptive-heal`, against the app as committed at HEAD.
2. IF that run fails THEN THE SYSTEM SHALL confirm with a second fresh run before acting, and only a confirmed failure
   SHALL move the ticket to "reopened", keep the failing step, Kane's reason and the app tree Kane judged, and require a
   new green through `proven done`, whose receipt links the earlier one.

## Requirement 6: The board
**User story:** As a person (and a judge), I want to see every ticket's evidence at a glance.
### Acceptance criteria
1. WHEN a person runs `proven board` THE SYSTEM SHALL serve a local web page, with no build step and no dependencies to
   install, showing each ticket's state (frozen, red, in progress, done, reopened, needs a person) with its red and
   green evidence in plain words.
2. THE board SHALL update without a reload when a command changes a ticket.
3. THE board SHALL show done only for a ticket whose receipt verifies as in 4.2.

## Requirement 7: Guard rails for the agent
**User story:** As a person, I want the agent unable to edit tickets, tests, locks or receipts, or to freeze or record
red itself.
### Acceptance criteria
1. WHEN a person runs `proven init` THE SYSTEM SHALL write Claude Code project hooks (`.claude/settings.json`, a
   PreToolUse hook) that block Write and Edit calls on paths under `tickets/`, `receipts/` and `.proven/` and Bash
   commands that run `proven new`, `proven freeze` or `proven red`, and a section in `CLAUDE.md` that tells the agent
   to run `proven done T-N` when it believes a ticket is done and to fix the app, never the test.
2. THE README SHALL say plainly that the guard rails are not a sandbox, and that done is shown only for a receipt that
   verifies.

## Requirement 8: Demo, judge mode and honesty
### Acceptance criteria
1. THE repository SHALL hold a small demo shop under `demo/app/`, served by a script that sends `Cache-Control:
   no-store`, and at least three demo tickets, written so that the plain reading of a later ticket breaks an earlier one, so that
   `recheck` can reopen it. The demo's bugs SHALL NOT be announced in comments or text on the page, because Kane reads the page.
2. WHEN a judge runs `npm start` without a Kane login THE SYSTEM SHALL show the board with the committed receipts and
   say that new runs need `kane-cli login`.
3. THE README SHALL state the limits: receipts are tamper-evident for hashed files, not signed by Kane; Kane's verdicts
   can be flaky, which is why red needs a failing last step and a passing landmark; evidence packs are not committed
   because they carry the runner's name and email.
4. THE project SHALL use Node.js 22 or newer and no runtime dependencies.

## Requirement 9: Kane's verdict goes back to the agent with no person in between
**User story:** As a person, I want Kane's failures handed straight back to the coding agent, so that after I write,
freeze and record red, the agent and Kane work the ticket out between them, and a later break is handed back the same
way.
### Acceptance criteria
1. WHEN a person runs `proven loop [T-N ...]` THE SYSTEM SHALL take each named ticket, or by default every ticket that
   is red, in progress or reopened in id order, and start the coding agent for it, one ticket at a time. The agent
   command SHALL come from `.proven/agent.json` (default: `claude -p --model claude-sonnet-5-5 --permission-mode
   acceptEdits --allowedTools "Bash(node bin/proven.js done *)" --output-format stream-json --verbose`). It SHALL be kept out of `.proven/config.json` and
   out of every lock, so existing locks and receipts verify unchanged.
2. THE SYSTEM SHALL start the agent with a fixed prompt that names only the ticket id and the files to read
   (`tickets/T-N.md`, and for a reopened ticket `.proven/state/T-N.json`), passed as a program argument with no shell.
   Kane's words SHALL reach the agent only through what `proven done` prints and the state file, never on a command
   line.
3. WHILE the agent works THE SYSTEM SHALL print each attempt as `proven done` records it (attempt number, Kane's
   verdict, the failing step and Kane's one-liner), so a person can follow the loop live.
4. WHEN the agent exits THE SYSTEM SHALL read the ticket's state. Done, with a receipt that verifies as in 4.2, moves on
   to the next ticket. "Needs a person" (the attempt limit of 3.2) stops work on that ticket and says so. Anything else
   is reported as "the agent stopped without a green" with its exit code. The loop SHALL start at most one agent
   session per ticket per round.
5. WHEN every ticket in a round is done THE SYSTEM SHALL run `proven recheck` (Requirement 5). IF it reopens a ticket
   THEN THE SYSTEM SHALL hand that ticket back to the agent as in 9.1 to 9.4, for at most 2 rounds in one `proven loop`,
   and SHALL end with a recheck whose result it prints.
6. `proven loop` is a person's step: the guard of Requirement 7 SHALL block the agent from running it.
7. `proven loop` SHALL exit 0 when every ticket it handled is done and the last recheck passes, 1 when a ticket needs a
   person, the agent stopped without a green, or the last recheck reopened a ticket, and 2 when something did not run.

## Build order
Build Requirements 1 to 4 against `demo/app/` first and stop: the first gate is one ticket going red, the agent fixing
it, the ticket going green and a receipt that `proven verify` confirms, twice, with no hand edits. Requirements 5 to 8
come after that gate. Requirement 9 comes after a live rehearsal of Requirements 4.3 and 5.
