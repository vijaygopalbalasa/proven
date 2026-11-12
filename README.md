# Proven

A ticket closes only when Kane CLI saw its frozen test fail before the change and pass after it.

AI coding agents say a ticket is done before it is. With Proven, a person writes a ticket and freezes its acceptance
test before any work starts. Kane must fail that test on the code as it is (red), and later pass the same test on the
changed code (green). Proven never judges pass or fail itself: it runs Kane, reads Kane's events, checks hashes and
git history, and writes a receipt that anyone can re-check with git.

## Status

Built: `proven new`, `freeze`, `red`, `done` and `verify` (Requirements 1 to 4), tested end to end on a fake Kane.
Not built yet: `verify --replay`, `recheck`, `board` and `init` (Requirements 4.3 and 5 to 8).

## Needs

- Node.js 22 or newer and git. No other installs: Proven has no dependencies.
- For live runs: Kane CLI (`npm install -g @testmuai/kane-cli`), Google Chrome, and `kane-cli login`.

## Try it

```
npm test                                   # the whole loop on a fake Kane, no login needed
npm run demo                               # the demo shop at http://localhost:8091/
node bin/proven.js freeze T-1              # a person freezes the ticket's test
node bin/proven.js red T-1                 # Kane must fail it on today's code
# the agent fixes demo/app, then runs: node bin/proven.js done T-1
node bin/proven.js verify receipts/T-1.json
```

Run `npm link` once to call it as `proven` instead of `node bin/proven.js`.

## Commands

| Command | Who | What it does |
|---|---|---|
| `proven new T-N "<title>" [--url U] [--landmark L]` | person | writes `tickets/T-N.md` to fill in |
| `proven freeze T-N` | person | writes `tickets/T-N_test.md`, commits ticket and test, then a lock naming that commit |
| `proven red T-N` | person | Kane must fail the frozen test on the code as it is, for the right reason |
| `proven done T-N` | agent | Kane decides. A failure prints what Kane saw and "Fix the app, not the test." A pass commits the change and the receipt |
| `proven verify receipts/T-N.json` | anyone | re-checks a receipt with git only, and prints CONFIRMED or MISMATCH |

Exit codes for `red` and `done`: 0 ok, 1 Kane failed (or, at red, the test already passes), 2 did not run.

## How a run counts

- Each test starts by opening the start URL and checking a landmark text. Proven checks the app answers HTTP 200
  before and after each run.
- Red, or a failed attempt, needs Kane's exit code, final result and step list to agree, the landmark step to pass and
  a later step to fail. A pass needs every step to pass.
- Anything else is "did not run": nothing is recorded and no attempt is counted.
- After 4 failed attempts a ticket needs a person.

## Files

`tickets/` holds tickets, frozen tests, locks and Kane's recordings (`output-T-N/`, which replays need).
`receipts/` holds receipts. `.proven/state/` holds each ticket's red record and attempts. `.proven/config.json` holds
the app folder, the time limit and the attempt limit, which are pinned when a ticket is frozen.

## Limits

- Receipts are tamper-evident for the files they hash. Kane does not sign them.
- An agent with shell access can forge local git history, so Proven's local checks are tamper-evident, not
  tamper-proof. The stronger check is `proven verify --replay`: Kane re-runs the frozen test at the red commit,
  expecting the recorded failure, and at the green commit, expecting a pass. It is the next requirement (4.3) and is
  not built yet.
- Kane's verdicts can be flaky. That is why red needs a passing landmark and a failing later step, and why anything
  unclear counts as "did not run".
- Evidence packs are not committed, because they carry the runner's name and email. Proven keeps only their sha256.
- Kane's recording folder is committed because replays need it. It holds Kane's own session and account ids.
- Guard rails for the agent (Requirement 7) are not built yet.
- The tests use a fake Kane through the `PROVEN_KANE_BIN` variable. Every run made that way says so in the output, the
  state and the receipt, and `verify` flags such a receipt.
