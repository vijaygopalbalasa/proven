# The recorded run, as text

This is the filmed run of Nov 13 (06:13 to 06:28 IST, starting from `14e9664`), copied from the terminal recordings
line by line, so you can read what Kane and the agent actually said without a Kane login or any credits. The number on
each line is seconds since that recording started. Nothing here was edited, apart from the headings. Long "agent
says" lines are cut by `proven loop` itself, which shortens them.

Four things about the run, up front:

- I wrote T-3 on purpose so that its plain reading (take the coupon codes from `coupons.json`) breaks T-1
  (requirement 8.1 in [requirements.md](requirements.md)). The agent took that reading on its own, in all 4 live runs: two rehearsals in throwaway copies (their
  logs are not in this repo), the filmed run recorded here, and a run from a fresh clone of `try-it` that followed only the
  README (also not in this repo's history). The recheck reopened T-1 each time: rehearsal 1 at `a51f39f` and rehearsal 2
  at `ed46d29` (both commits are from those throwaway copies), the filmed run at `fb9d347`. Each reopen was a fresh run
  that failed, then a second fresh run that agreed.
- The loop took 10 min 42 s, and the whole take, with `verify --replay`, used about 207 Kane credits.
- Kane failed or passed each step on its own. Proven never judged the page.
- No Kane evidence files are in this repository. Each Kane run's evidence is kept only as a sha256 in the ticket's state
  file. Six of Kane's own step screenshots (the demo cart and a TodoMVC page, cropped) are in `docs/images` and shown in the README.

## 1. A person freezes T-3

```
proven freeze T-3
```

```
    0.2  Frozen T-3: ticket and test in c4d9869, lock in 452057b.
    0.2  tickets/T-3_test.md has 2 steps: the landmark check, then 1 criterion.
    0.2  Next: run proven red T-3 right away. Red must sit on this lock commit, and Proven serves the app itself.
```

## 2. Kane must fail the test on the shop as it is (red)

```
proven red T-3
```

```
    0.2  Serving demo/app as tree 4e62914 at http://localhost:8091/
    0.2  Running Kane on tickets/T-3_test.md (2 steps). This takes about a minute.
   21.6    step 1 Open the start page: passed (15.8 s)
   67.5    step 2 Apply FALL15: failed (45.8 s)
   76.1  T-3 is red at 452057b. Kane failed step 2 (Apply FALL15).
   76.1  Kane says: The cart rejects the required FALL15 coupon, so the order total remains $30.00 instead of $26.25.
   76.1  Reason: Final verification failed: "the order total shows $26.25"
   76.1  Recorded in .proven/state/T-3.json. The agent can start. It runs proven done T-3 when it thinks the ticket is done.
```

## 3. One command: proven loop

```
proven loop
```

### The agent works on T-3

```
    1.6  T-3: starting the agent (1 of 1).
    6.9  T-3 agent: Read tickets/T-3.md
    7.0  T-3 agent: Bash ls -R demo/app | head -50; cat .proven/state/T-3.json
    8.6  T-3 agent: Read demo/app/cart.js
    8.9  T-3 agent: Read demo/app/coupons.json
    9.3  T-3 agent: Read demo/app/index.html
   13.7  T-3 agent: Edit demo/app/cart.js
   14.3  T-3 agent: Edit demo/app/cart.js
   15.9  T-3 agent: Bash node bin/proven.js done T-3
   85.9  T-3 attempt 1 of 4: Kane passed in proven done (not yet confirmed).
   88.6  T-3 agent says: T-3 is done. `node bin/proven.js done T-3` exited 0: Kane passed both steps, and Proven committed the change as green `25ddbee` (red was `452057b`). The cart...
```

### The loop rechecks every done ticket from fb9d347: T-1 fails, then a second fresh run fails again

```
   93.7  Rechecking 3 done tickets (T-1, T-2, T-3) against demo/app at fb9d347.
   93.9  T-1: running tickets/T-1_test.md fresh on fb9d347.
   94.0  Serving demo/app at fb9d347 as tree becd583 at http://localhost:8091/
   94.0  Running Kane on tickets/T-1_test.md (2 steps) with --no-adaptive-heal. This takes about a minute.
  114.7    step 1 Open the start page: passed (15.8 s)
  142.7    step 2 Apply SAVE10: failed (28 s)
  160.8  T-1: Kane failed step 2 (Apply SAVE10). Confirming with a second fresh run before anything changes.
  160.9  Serving demo/app at fb9d347 as tree becd583 at http://localhost:8091/
  160.9  Running Kane on tickets/T-1_test.md (2 steps). This takes about a minute.
  183.3    step 1 Open the start page: passed (17.4 s)
  223.3    step 2 Apply SAVE10: failed (40 s)
  231.3  T-1 reopened at fb9d347: Kane failed step 2 (Apply SAVE10) on the second run too.
  231.3  Kane says: The cart rejects the valid SAVE10 coupon, so the order total remains $30.00 instead of $27.50.
  231.3  Reason: Final verification failed: "the order total shows $27.50"
  231.3  The agent fixes the app and runs proven done T-1. Fix the app, not the test.
```

### T-2 and T-3 still pass

```
  231.6  T-2: running tickets/T-2_test.md fresh on e5e609b.
  231.7  Serving demo/app at e5e609b as tree becd583 at http://localhost:8091/
  231.7  Running Kane on tickets/T-2_test.md (2 steps) with --no-adaptive-heal. This takes about a minute.
  253.3    step 1 Open the start page: passed (16.1 s)
  280.7    step 2 Free shipping at exactly $50: passed (27.3 s)
  296.7  T-2 still passes: Kane ran its frozen test fresh on e5e609b.
  297.0  T-3: running tickets/T-3_test.md fresh on e5e609b.
  297.0  Serving demo/app at e5e609b as tree becd583 at http://localhost:8091/
  297.0  Running Kane on tickets/T-3_test.md (2 steps) with --no-adaptive-heal. This takes about a minute.
  317.1    step 1 Open the start page: passed (15.4 s)
  346.3    step 2 Apply FALL15: passed (29.2 s)
  361.9  T-3 still passes: Kane ran its frozen test fresh on e5e609b.
  361.9  Reopened: T-1.
  361.9  T-3 is done: confirmed by a fresh Kane run from proven loop.
```

### The loop hands T-1 back to the agent

```
  362.0  Handing back to the agent: T-1 (recheck round 1 of 2).
  362.1  T-1: starting the agent (1 of 1).
  367.7  T-1 agent: Read tickets/T-1.md
  367.8  T-1 agent: Read .proven/state/T-1.json
  368.0  T-1 agent: Bash ls -R demo/app | head -50
  369.6  T-1 agent: Read demo/app/cart.js
  370.0  T-1 agent: Read demo/app/coupons.json
  370.3  T-1 agent: Read demo/app/index.html
  372.4  T-1 agent says: The `SAVE10` code is missing from `coupons.json`. With a $25.00 subtotal, 10% off ($2.50) plus $5.00 shipping gives the expected $27.50.
  373.1  T-1 agent: Edit demo/app/coupons.json
  374.8  T-1 agent: Bash node bin/proven.js done T-1
  437.8  T-1 attempt 1 of 4: Kane passed in proven done (not yet confirmed).
  440.2  T-1 agent says: T-1 is closed. Kane passed both steps, including "Apply SAVE10", and Proven committed the change with a new receipt (red `fb9d347`, green `8d0207e`). The rec...
```

### The final recheck: all three pass

```
  445.0  Rechecking 3 done tickets (T-1, T-2, T-3) against demo/app at d3b9389.
  445.5  T-1: running tickets/T-1_test.md fresh on d3b9389.
  445.5  Serving demo/app at d3b9389 as tree f54154b at http://localhost:8091/
  445.5  Running Kane on tickets/T-1_test.md (2 steps) with --no-adaptive-heal. This takes about a minute.
  465.7    step 1 Open the start page: passed (15.2 s)
  496.2    step 2 Apply SAVE10: passed (30.5 s)
  512.1  T-1 still passes: Kane ran its frozen test fresh on d3b9389.
  512.4  T-2: running tickets/T-2_test.md fresh on d3b9389.
  512.4  Serving demo/app at d3b9389 as tree f54154b at http://localhost:8091/
  512.4  Running Kane on tickets/T-2_test.md (2 steps) with --no-adaptive-heal. This takes about a minute.
  534.2    step 1 Open the start page: passed (16.8 s)
  559.2    step 2 Free shipping at exactly $50: passed (25 s)
  574.7  T-2 still passes: Kane ran its frozen test fresh on d3b9389.
  575.0  T-3: running tickets/T-3_test.md fresh on d3b9389.
  575.0  Serving demo/app at d3b9389 as tree f54154b at http://localhost:8091/
  575.0  Running Kane on tickets/T-3_test.md (2 steps) with --no-adaptive-heal. This takes about a minute.
  597.5    step 1 Open the start page: passed (16.2 s)
  625.5    step 2 Apply FALL15: passed (28 s)
  641.7  T-3 still passes: Kane ran its frozen test fresh on d3b9389.
  641.7  Every done ticket still passes.
  641.7  T-1 is done: confirmed by a fresh Kane run from proven loop.
  641.7  Loop finished: every ticket is done and the last recheck passes.
```

## 4. Anyone can run Kane again at red and at green

```
proven verify receipts/T-1.json --replay
```

```
    0.5  Replaying tickets/T-1_test.md with the app as it was at red fb9d347.
    0.6  Serving the app at red fb9d347 as tree becd583 at http://localhost:8091/
    0.6  Running Kane on tickets/T-1_test.md (2 steps). This takes about a minute.
   23.0    step 1 Open the start page: passed (17.5 s)
   65.5    step 2 Apply SAVE10: failed (42.5 s)
   73.5  Replaying tickets/T-1_test.md with the app as it was at green 8d0207e.
   73.5  Serving the app at green 8d0207e as tree f54154b at http://localhost:8091/
   73.5  Running Kane on tickets/T-1_test.md (2 steps). This takes about a minute.
   92.7    step 1 Open the start page: passed (15 s)
  126.3    step 2 Apply SAVE10: passed (33.6 s)
  143.2  CONFIRMED receipts/T-1.json
  143.2    ok    the receipt's paths match ticket T-1
  143.2    ok    the receipt hash matches its contents
  143.2    ok    the test and ticket at the frozen commit match the receipt
  143.2    ok    the lock was written once, right after the frozen commit, and pins these settings
  143.2    ok    the test was frozen before red
  143.2    ok    red is an ancestor of green
  143.2    ok    the frozen test did not change between red and green
  143.2    ok    the app at red and green matches the receipt, and changed
  143.2    ok    the state history records this red, then one commit per failed attempt
  143.2    ok    the receipt is committed as it is
  143.2    ok    the earlier receipt it links is committed, verifies, and came before this red
  143.2    ok    replay at red fb9d347: Kane failed step 2 (Apply SAVE10), as the receipt records
  143.2          Kane says: The checkout rejects SAVE10 and leaves the order total at $30.00 instead of applying the expected $2.50 discount.
  143.2    ok    replay at green 8d0207e: Kane passed all 2 steps, as the receipt records
  143.2  Kane ran the frozen test again: it failed without the change and passed with it.
```

## What the clone already holds

`.proven/state/T-N.json` is written by Proven for each ticket. It holds, for the red run, Kane's one-line summary, its
reason, the failing step, the duration, the credits and a sha256 of Kane's evidence pack, and the same kind of record
for a pass or a reopen. For T-3 the red record reads:

```
failed_step_title: Apply FALL15
kane_one_liner:    The cart rejects the required FALL15 coupon, so the order total remains $30.00 instead of $26.25.
kane_reason:       Final verification failed: "the order total shows $26.25"
duration_s:        64
credits:           22.54
evidence_sha256:   97ef88f4fe64d9fdb19325d6d3462f6bf2fd5ac0306f5cc65c9fc99e0712509a
kane_cli:          0.10.4
```

T-1's state also holds the reopen: `reopened.first_run` is the first fresh recheck run that failed, and `red` is the
second one that confirmed it. `receipts/T-N.json` holds the receipt that `proven verify` re-checks with git alone, and
T-1's second receipt links the first.
