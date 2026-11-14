# How a run counts, and what I measured about Kane

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
- The live take of Nov 13 (one `proven loop`, then `verify --replay` on T-1): about 207 Kane credits in all, 10 min 42 s
  for the loop itself.
