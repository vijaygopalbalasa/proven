# Proven

**A ticket closes only when Kane CLI saw its frozen test fail before the change and pass after it.**

Coding agents say "done" before it is true. With Proven, a person freezes a ticket's acceptance test first. Kane must
fail it on the code as it is, then pass the same unchanged test after the agent's change. Only Proven goes on checking:
it re-runs Kane on every closed ticket, and a later change that breaks one gets it reopened by a fresh Kane run and
handed back to the agent, with no person in between.

![The Proven board: three tickets, each with Kane's failure before the change and its pass after it](docs/images/board.png)

Demo video (2 min): VIDEO_LINK_TODO

**Try it in 30 seconds, with no install and no login:**

```
git clone <this repository's URL> proven
cd proven
npm start          # then open http://127.0.0.1:8090/
```

What Kane caught in the recorded run (a demo shop with coupon codes):

- Before any change, Kane failed the frozen test for the right reason: "The cart rejects the required FALL15 coupon, so the order total remains $30.00 instead of $26.25."
- The agent's fix for that ticket broke an older one. A fresh Kane run failed twice on it: "The cart rejects the valid SAVE10 coupon, so the order total remains $30.00 instead of $27.50." The older ticket reopened by itself. (The demo tickets are written so this happens; see "Honest disclosure" below.)
- The loop handed it back, the agent fixed it, Kane passed it, and `proven verify --replay` ran Kane again at red and at green: CONFIRMED.

## For judges

1. **See it (30 seconds).** `npm start` shows the board over the receipts committed here. Each card was re-checked with
   git just now. Needs Node.js 22 or newer. No install, no login.
2. **Run the tests.** `npm test` runs 142 tests, every command end to end, on a fake Kane (no login).
3. **Verify a receipt.** `node bin/proven.js verify receipts/T-1.json` checks it with git alone, no network. With a Kane
   login, add `--replay` and Kane runs the frozen test again with the app at red (must fail) and at green (must pass).
4. **Run the whole loop yourself.** You need Kane CLI and `kane-cli login`, Google Chrome, Claude Code (`claude`), about
   200 Kane credits and about 11 minutes. Start from the branch `try-it` (at `c6213ac`), where T-3 is written but not
   frozen:
   ```
   git checkout try-it
   node bin/proven.js freeze T-3      # a person freezes the ticket's test
   node bin/proven.js red T-3         # Kane must fail it on the shop as it is
   node bin/proven.js loop            # the agent, Kane and the recheck, in one command
   node bin/proven.js verify receipts/T-1.json --replay
   ```
   Nothing else may listen on port 8091: Proven serves the app there while Kane runs.
5. **Fallback without credits.** The receipts and state of the recorded run are committed here. `verify` works offline,
   and [docs/recorded-run.md](docs/recorded-run.md) has the real terminal output of the run, line by line.
6. **Dates.** The first commit is `68295c6`, at 2026-11-13 02:20 IST (Nov 12 20:50 UTC). The history is as written.

### Honest disclosure

T-3 was written on purpose so that its plain reading (take the coupon codes from `coupons.json`) breaks T-1 (requirement
8.1 in [docs/requirements.md](docs/requirements.md)). The agent took that reading on its own in all 3 live runs on Nov 13,
and the recheck reopened T-1 each time: rehearsal 1 at `a51f39f`, rehearsal 2 at `ed46d29`, the filmed run at `fb9d347`.
Each reopen was a fresh run that failed, then a second fresh run that failed again. Only the filmed run is in this clone's
history. So the reopen is real, but it is not a surprise: the demo is built to show it.

## The recorded run

On Nov 13 (06:13 to 06:28 IST), starting from `14e9664`, one `proven loop` ran against live Kane CLI and Claude Code.

- `proven freeze T-3`: ticket and test in `c4d9869`, lock in `452057b`. `proven red T-3` at `452057b`.
- `proven loop` (one command, exit 0, 10 min 42 s): the agent fixed T-3 on its first attempt (green `25ddbee`, receipt `fb9d347`).
- The loop's recheck ran T-1 fresh twice and both runs failed, so T-1 reopened at `fb9d347` (state commit `e5e609b`).
- The loop handed T-1 back. The agent edited `demo/app/coupons.json` and ran done (green `8d0207e`, receipt `d3b9389`, which links the earlier receipt). The final recheck: all three tickets still pass.
- `proven verify receipts/T-1.json --replay`: CONFIRMED, 11 git checks. Kane failed step 2 at red `fb9d347` and passed at green `8d0207e`.
- The whole take used about 207 Kane credits.

Kane's and the agent's own words, with times, are in [docs/recorded-run.md](docs/recorded-run.md).

## The idea: red, then green

AI coding agents say a ticket is done before it is. A passing test proves little if it might have passed anyway. So a
person writes a ticket and freezes its acceptance test before any work starts. Kane must fail that test on the code as
it is (red). The agent then changes the app and runs `proven done`, and Kane must pass the same, unchanged test (green).
Proven never judges pass or fail itself: it runs Kane, reads Kane's events, checks hashes and git history, and writes a
receipt that anyone can re-check. A later change that breaks a closed ticket reopens it.

## Install

- Node.js 22 or newer and git. Proven has no dependencies to install.
- For live runs: Kane CLI (`npm install -g @testmuai/kane-cli`), Google Chrome, and `kane-cli login`.
- For the agent loop: Claude Code (`claude`).

```
npm test       # every command, end to end, on a fake Kane: no login needed
npm start      # judge mode: the board over the receipts committed here, at http://127.0.0.1:8090/
```

Run `npm link` once to call Proven as `proven`. The commands below use `node bin/proven.js`, which works without it.

## Verify, recheck, board

- **Verify.** `proven verify receipts/T-N.json` checks the receipt's own hash, that the frozen test matches, that the
  lock was written once right after it, that red is an ancestor of green, that the test did not change in between,
  that the app trees match and changed, and that the state history shows this red. With `--replay`, Kane runs the
  frozen test fresh at the red commit (must fail at the recorded step) and at the green commit (must pass).
- **Recheck and reopen.** `proven recheck` runs every done ticket's frozen test again against the app as committed now,
  with `--no-adaptive-heal`. A failure is confirmed by a second fresh run before anything changes. Only a confirmed
  failure reopens the ticket, in a state commit of its own, and the new receipt links the earlier one.
- **Board.** `proven board` (or `npm start`, in judge mode) serves a local page with each ticket's state and evidence in
  plain words. It updates live, shows done only for a receipt that verifies with git, and listens on 127.0.0.1 only.

## The loop

`proven loop` hands each red or reopened ticket to the coding agent, one ticket at a time, shows the agent's tool calls,
its words and Kane's verdicts as they happen, rechecks every done ticket from its own code, and hands back what
reopens, for at most 2 rounds. It never trusts a verdict made inside the agent's session: after every session it checks
git and file hashes first. Details, the agent command and exit codes: [docs/loop.md](docs/loop.md).

## The guard

`proven init` writes a Claude Code hook. The agent can read files, edit the app with its edit tools and run
`node bin/proven.js done T-N`. Everything else is blocked: writes to tickets, receipts, `.proven/`, `.git/` and Proven's
own code, and every Bash command that is not on a short read-only allowlist. It is defence in depth, not a sandbox.
Details: [docs/guard.md](docs/guard.md).

## Commands

| Command | Who | What it does |
|---|---|---|
| `proven new T-N "<title>" [--url U] [--landmark L]` | person | writes `tickets/T-N.md` to fill in |
| `proven freeze T-N` | person | writes `tickets/T-N_test.md`, commits ticket and test, then a lock naming that commit |
| `proven red T-N` | person | Kane must fail the frozen test on the code as it is, for the right reason |
| `proven done T-N` | agent | Kane decides. A pass commits the change and the receipt |
| `proven verify receipts/T-N.json [--replay]` | anyone | re-checks a receipt with git, and with `--replay` with Kane at red and green |
| `proven recheck [T-N ...]` | person or agent | runs done tickets' tests again and reopens one whose failure a second run confirms |
| `proven board [--port 8090] [--judge]` | anyone | the local board |
| `proven loop [T-N ...]` | person | hands each red or reopened ticket to the coding agent, shows the agent and Kane live, rechecks, hands back what reopens (at most 2 rounds) |
| `proven init` | person | the Claude Code guard rails |

Exit codes for `red` and `done`: 0 ok, 1 Kane failed (or, at red, the test already passes), 2 did not run. For
`recheck`: 0 all still pass, 1 a ticket reopened, 2 something did not run. For `loop`: 0 all done and the last recheck passes, 1 needs
a person, agent stopped without a green or a reopen at the end, 2 something did not run.

## Honest limits

- Local checks are tamper-evident, not tamper-proof. An agent with a shell can forge local git history. The stronger
  check is `verify --replay`, where Kane itself runs the frozen test again at red and at green, ideally run by someone
  else on their own machine. `proven loop` checks what it can see.
- Receipts are tamper-evident for the files they hash. Kane does not sign them.
- The guard rails are not a sandbox. The guard blocks writes to Proven's own code, and `proven loop` checks git and file
  hashes after every agent session, but an agent with a shell can still try to get around both.
- Proven runs git without your global git config. If the repository has no `user.name` or `user.email` of its own, it
  reads yours once from `git config --global` at startup, and refuses to commit if there is none.
- The app must be static files for now, because Proven serves its own snapshot of the app folder while Kane runs, and
  the start URL must be local with a port, like http://localhost:8091/.
- Kane's verdicts can be flaky. That is why red needs a passing landmark and a failing later step, why anything unclear
  counts as "did not run", and why recheck confirms a failure with a second fresh run before it reopens anything.
- Evidence packs are not committed, because they carry the runner's name and email. Proven keeps only their sha256.
  Kane's recording folder (`tickets/output-T-N/`) stays local for the same reason and is never used for a verdict. So
  every run authors every step: a minute or two and about 10 to 30 credits each.
- `recheck`, `loop` and `verify --replay` run Kane, so they need Kane CLI, Chrome, a login and credits. All three ran
  live on Nov 13 (see "The recorded run"). The test suite uses a fake Kane through the `PROVEN_KANE_BIN` variable; every
  run made that way says so in the output, the state and the receipt, and `verify` flags such a receipt.
- `--author` comes from Kane CLI 0.10.4's own help ("re-author every step"); it ran live on Nov 13 (every recheck run
  used it) and Kane accepted it. If Kane ever rejected it, every run would say "did not run", so nothing could pass by
  mistake.
- A file in Kane's output folder that someone else changes while Kane runs cannot be told apart by its time. Against
  that, Proven relies on `--author` and on Kane's own summary showing no replayed step.
- `recheck` judges the app as committed and refuses while the app folder has uncommitted changes.

## Files

`tickets/` holds tickets, frozen tests and locks. `receipts/` holds receipts. `.proven/state/` holds each ticket's red
record and attempts. `.proven/config.json` holds the app folder, the time limit and the attempt limit, which are
pinned when a ticket is frozen. How a run counts, and what we measured about Kane: [docs/kane-facts.md](docs/kane-facts.md).
