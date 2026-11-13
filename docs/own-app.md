# Proven on someone else's app: TodoMVC

This is a real run of Proven on an app we did not write: the vanilla JavaScript TodoMVC example
(`examples/javascript-es5/dist` from github.com/tastejs/todomvc, MIT license). It ran on Nov 13 with real Kane CLI 0.10.4
and real Claude Code, from Proven at `de49287`. **The run lives in a scratch git repository, not in this one.** Nothing
from it is committed here except this text. The TodoMVC files were copied in as data: they were served, and never built,
installed or run.

The ticket: with 3 todos and 2 completed, the button under the list should read "Clear completed (2)". TodoMVC says only
"Clear completed", so this is a small feature it really lacks.

## Every command

The scratch repo is a fresh `git init` with the TodoMVC `dist` folder copied to `todomvc/` and committed. `proven` was
on PATH through a one-line shell script that runs `node <path>/bin/proven.js` (the same thing `npm link` does, without
touching the global npm folder).

```
mkdir -p .proven && echo '{ "app": "todomvc" }' > .proven/config.json     # where the app is (a folder inside the repo)
git add -A && git commit -m "Tell Proven where the app is"
proven init                                              # guard hook, CLAUDE.md, .gitignore lines
git add -A && git commit -m "proven init"
proven new T-1 "Clear completed shows how many todos it clears" --url http://localhost:8095/ --landmark "todos"
# edit tickets/T-1.md: one criterion, in plain English, ending in a Verify line (below)
proven freeze T-1
proven red T-1
proven loop
proven verify receipts/T-1.json
```

The criterion in `tickets/T-1.md`:

```
### Clear completed shows the count
Type Buy milk in the What needs to be done field and press Enter. Do the same for Walk dog and for Pay rent. Click the round checkbox next to Buy milk and the one next to Walk dog.
Verify the button at the bottom right of the list reads Clear completed (2).
```

`proven freeze` turned it into a 2-step Kane test: step 1 opens the start page and checks the text "todos" (the
landmark), step 2 is the criterion.

## Red: Kane fails the test on TodoMVC as it is

```
Serving todomvc as tree b3cde73 at http://localhost:8095/
Running Kane on tickets/T-1_test.md (2 steps). This takes about a minute.
  step 1 Open the start page: passed (17.1 s)
  step 2 Clear completed shows the count: failed (83.8 s)
T-1 is red at 412d9f7. Kane failed step 2 (Clear completed shows the count).
Kane says: After two tasks were completed, the bottom-right button showed “Clear completed” without the required count of 2.
Reason: Final verification failed: "the button at the bottom right of the list reads Clear completed (2)"
```

## The loop: Claude Code fixes it, Kane passes it

`proven loop` with no `.proven/agent.json`, so the default agent command ran. This is its output, with each line shown
once (when both output streams go to one file, `proven loop` prints each result line on both):

```
T-1: starting the agent (1 of 1).
T-1 agent: Read tickets/T-1.md
T-1 agent: Bash ls todomvc
T-1 agent: Bash grep -n -i "clear" todomvc/*.js todomvc/index.html
T-1 agent: Read todomvc/template.js
T-1 agent: Read todomvc/view.js
T-1 agent: Read todomvc/controller.js
T-1 agent: Edit todomvc/template.js
T-1 agent: Bash proven done T-1
T-1 attempt 1 of 4: Kane passed in proven done (not yet confirmed).
T-1 agent says: T-1 is done, and `proven done T-1` exited 0 on the first attempt. Kane passed both steps of the frozen test. The red commit was 412d9f7 and the green commit ...
Rechecking 1 done ticket (T-1) against todomvc at d9f0d75.
T-1: running tickets/T-1_test.md fresh on d9f0d75.
Serving todomvc at d9f0d75 as tree f18f636 at http://localhost:8095/
Running Kane on tickets/T-1_test.md (2 steps) with --no-adaptive-heal. This takes about a minute.
  step 1 Open the start page: passed (17.1 s)
  step 2 Clear completed shows the count: passed (66.2 s)
T-1 still passes: Kane ran its frozen test fresh on d9f0d75.
Every done ticket still passes.
T-1 is done: confirmed by a fresh Kane run from proven loop.
Loop finished: every ticket is done and the last recheck passes.
```

The agent's whole change was one line in `todomvc/template.js`:

```
-            return "Clear completed";
+            return `Clear completed (${completedTodos})`;
```

The agent's own words: "T-1 is done, and `proven done T-1` exited 0 on the first attempt. Kane passed both steps of the
frozen test." Then the loop ran Kane again on its own, fresh, and reported the ticket done only after that passed.

## Verify

```
proven verify receipts/T-1.json
```

printed `CONFIRMED receipts/T-1.json` with 10 git checks (the replay with Kane was not run here).

## Credits

About 88 Kane credits in all: red 43.63 and the green run 21.76 (both recorded in `.proven/state/T-1.json` and the
receipt), plus the loop's own fresh recheck, about 23 by the figures in its evidence pack. Red cost more here than in the
demo shop (about 22 there): Kane's step took 84 s instead of 45 s.

## Friction, and what we did about it

1. **The README had no own-app instructions.** It only described the demo. We added the section "Use it on your own
   static app" to the README after this run.
2. **Proven's own repo was assumed in the loop's prompts, the agent's allowed command and the config.** This is what
   the first part of this task fixed, before the run. The prompts now name the app folder (`todomvc`) and `proven done`
   instead of `demo/app` and `node bin/proven.js done`, and an app folder the guard keeps the agent out of (`src`, `docs`,
   `bin`, `test` and so on) is refused with a message. The agent ran `proven done T-1` and Claude Code accepted it
   under `Bash(proven done *)`. This only works if `proven` is on PATH, which is why `npm link` (or a shim) is a
   requirement, not a nicety.
3. **Git would have committed Kane's evidence.** The scratch repo had no `.gitignore`, and after the run `git status`
   showed `.testmuai/`, which holds evidence packs with the runner's name and email. One careless `git add -A` would
   publish them. `proven init` now adds `.testmuai/`, `tickets/output-*/`, `.proven/runs/` and `*.evidence` to
   `.gitignore` (new, with a test). This run did not have that fix, so it did not add them; we did not commit them.
4. **The guard blocked one of the agent's commands.** It tried `grep -n -i "clear" todomvc/*.js todomvc/index.html`. The
   unquoted `*` is not allowed, so the guard blocked it, and the agent read the files with its Read tool instead. That
   is the intended behaviour, but it is a wasted call, and a stranger will see it.
5. **`proven init` reads the app folder from `.proven/config.json`,** so the config has to exist first (we wrote it first; `.proven/` does not exist in a fresh repo, so the command starts with `mkdir -p .proven`).
   If it is missing, `proven init` now says so and names the default app folder it used.
6. **Doubled lines.** When `proven loop` writes both streams to one file, each result line appears twice. Cosmetic.
   It only prints once to a terminal. We did not change it.
7. **`proven init` still describes only the older guard** in its first line (tickets, receipts, `.proven`, `.claude`; new,
   freeze, red). The guard itself is stricter than that line says. We did not change the text.
8. **`proven verify ... | head -1` ends with a Node EPIPE stack trace** in a pipe that closes early. Cosmetic.
   We did not change it.

## What the run shows, and what it does not

It shows that a person who is not us can take a static app we did not write, point Proven at its folder, freeze a
plain-English test, have Kane fail it, let Claude Code fix it and Kane pass it, and get a receipt that `proven verify`
confirms. It does not show: apps that need a build step or a server (Proven only serves static files), an agent that
needs more than one attempt, a recheck that reopens something, or any app other than this one.
