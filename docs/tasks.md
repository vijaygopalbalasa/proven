# Tasks

Build order from the requirements: Requirements 1 to 4 first, then the gate, then 5 to 8.

## Now: Requirements 1 to 4

- [x] Demo shop under `demo/app/` and `demo/server.js` (sends `Cache-Control: no-store`)
- [x] Two demo tickets written as a person would: `tickets/T-1.md` (coupon), `tickets/T-2.md` (free shipping)
- [x] Core helpers: git plumbing commits, sha256, canonical JSON, folder hash, leak scrub and checks
- [x] 1.1 `proven new T-N "<title>"` writes the ticket skeleton
- [x] 1.2 `proven freeze T-N` writes the test, commits F (ticket + test), then the lock alone
- [x] 1.3 freeze refuses and names what is missing (start URL, landmark, criteria, Verify line)
- [x] 1.4 every run checks the test against the lock and against F
- [x] 2.1 red refuses a dirty app folder and probes the start URL for HTTP 200
- [x] 2.2 Kane runs as a process group with Proven's own time limit, NDJSON only
- [x] 2.3 red counts only on a passed landmark and a later failed step that Kane's result, exit code and step list agree on
- [x] 2.4 a pass at red marks "already passes" and blocks the ticket until a new freeze
- [x] 2.5 exit 2 or 3, no `test_md_done`, a failed landmark or an environment verdict mean "did not run"
- [x] 2.6 state files hold no session folder, link, absolute path, name or email
- [x] 3.1 done checks the test, the app and runs Kane
- [x] 3.2 a failure prints step, title, one_liner, reason, screenshot path and "Fix the app, not the test." (exit 1), and 4 failures mean "needs a person"
- [x] 3.3 did not run exits 2 and counts no attempt
- [x] 3.4 a pass commits G, then the receipt with Kane's recording, and prints "Done: red X, green Y."
- [x] 3.5 Proven commits only the app folder, `tickets/`, `receipts/` and `.proven/state/`
- [x] 4.1 receipt fields and its own canonical sha256
- [x] 4.2 `proven verify` prints CONFIRMED or MISMATCH with each failed check, git only
- [x] 4.3 `verify --replay` stub that says it is not built yet
- [x] Fake Kane and end-to-end tests: red, fail, did not run, green, CONFIRMED, MISMATCH (tampered receipt, test edited
      after freeze, red not an ancestor of green), timeout kills the process group, leak scan of every commit
- [x] Security review fixes: Kane is always kane-cli (fake only via `PROVEN_KANE_BIN`, always labelled); settings pinned
      in the lock; state read from HEAD and Proven's own commits only; red record invariants and the lock chain (red
      sits on the lock commit); Kane judges a snapshot that Proven serves, and G is exactly that tree; no symlinks in
      the app; verify derives paths from the ticket id and checks the lock chain, the app trees and the state history;
      hashes use canonical JSON or git tree ids
- [x] README stub

## The gate (live, with Kane)

- [ ] T-1: red, the agent fixes it, green, `proven verify` CONFIRMED, with no hand edits
- [ ] T-2: the same, a second time

## Later: Requirements 5 to 8

- [ ] 4.3 `verify --replay` serves the app at the red and green commits and replays the frozen test
- [ ] 5 `proven recheck` replays done tickets with `--no-adaptive-heal`, confirms with a fresh run, reopens
- [ ] 6 `proven board` local page, live updates, done only for receipts that verify
- [ ] 7 `proven init` writes Claude Code hooks and a `CLAUDE.md` section
- [ ] 8 a third demo ticket that a later change breaks, `npm start` judge mode, README limits
