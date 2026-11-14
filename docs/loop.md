# proven loop

`proven loop [T-N ...]` hands Kane's verdict straight back to the coding agent. A person still writes the ticket,
freezes its test and records red. After that the loop does the rest in one command.

## What it does

1. It takes each ticket you name, or every ticket that is red, in progress or reopened, in id order. It starts the
   coding agent for one ticket at a time, one agent session per ticket per round.
2. The agent gets one fixed prompt, with the ticket id and the files to read and nothing else. Kane's words reach the
   agent only through what `proven done` prints and the ticket's state file, never on a command line.
   - red ticket: `Ticket T-N is red. Read tickets/T-N.md and make it true in demo/app. When you believe it is done, run node bin/proven.js done T-N and follow what it prints.`
   - reopened ticket: `proven recheck reopened T-N. Read tickets/T-N.md and .proven/state/T-N.json for what Kane saw, fix demo/app, then run node bin/proven.js done T-N and follow what it prints.`
3. When every ticket in the round has a pass from `proven done`, the loop runs `proven recheck` itself: a fresh Kane
   run on every done ticket, including the ones the agent just closed. A ticket the recheck reopens is handed back to
   the agent, for at most 2 rounds in one loop. The loop ends with a recheck whose result it prints.
4. A ticket is reported done only after that recheck passes it: "confirmed by a fresh Kane run from proven loop".
   Inside a session a pass is called "Kane passed in proven done (not yet confirmed)".

The attempt limit is the one `proven done` already enforces (4 by default). A ticket that reaches it needs a person,
and so does an agent that exits without a green. The loop stops there.

## What it prints

Every line names the ticket. It prints each attempt as `proven done` records it (attempt number, Kane's verdict, the
failing step and Kane's one-liner), one short line per agent tool call (the tool and the file or command, paths shown
relative to the repository, about 100 characters at most), and the agent's own words as "agent says" lines
(shortened). It never prints file contents or tool results. The real output of one run is in
[recorded-run.md](recorded-run.md).

## The agent command

The command is in `.proven/agent.json`, an optional file: `{ "command": ["claude", "-p", ...] }`. It is a list of
words, run without a shell, with the prompt as the last word. Without the file Proven runs:

```
claude -p --model claude-sonnet-5-5 --permission-mode acceptEdits --allowedTools "Bash(node bin/proven.js done *)" --output-format stream-json --verbose
```

- Because a cloned repository could ship its own `agent.json`, `proven loop` prints the command and refuses (exit 2)
  unless you pass `--agent-config`, each time.
- It always refuses a command with `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` or
  `--permission-mode bypassPermissions`.
- The command is not in `.proven/config.json` and no lock pins it, so receipts verify as before.
- If the agent program is not on PATH, the loop says "did not run" and exits 2.

### Using another coding agent

Only Claude Code has been tested. `.proven/agent.json` lets you name another command line agent, but I have not run any other one, so treat this as untested.

```
{ "command": ["my-agent", "--headless"] }
```

- `command` is a list of words: the program first, then its flags. Proven runs it directly, with no shell, in the repository folder, and adds the prompt as the last word. The prompt is the fixed text above, so the agent must take its task as its last argument.
- The agent has to be able to run `proven done T-N` (or `node bin/proven.js done T-N` in this repo) and read what it prints. Exit 0 means Kane passed. Exit 1 means Kane failed and the agent should fix the app. Exit 2 means Kane did not run.
- Add `"--output-format", "stream-json"` only if your agent really prints Claude Code's stream-json lines. Proven shows tool calls and "agent says" lines only from that format. With any other output it prints just the attempts it reads from its own state.
- The guard hook is a Claude Code hook. With another agent it does not run, so nothing keeps that agent out of tests, receipts or Proven's own files while it works. The checks that `proven loop` runs after every session still apply, and `verify --replay` is unchanged.
- Because the file comes from the repository, `proven loop` shows the command and refuses until you pass `--agent-config`. It also refuses any command with a flag that turns permission checks off.

## What it does not trust

The loop does not trust a verdict made inside the agent's session. After every session it checks git and file hashes,
then re-runs Kane from its own code before it reports done. It checks what it can see; it is a check, not a sandbox.

- The recheck and verify run inside the loop's own process, from modules loaded before the first session, so an agent
  that rewrites Proven's code and puts it back changes nothing.
- Before and after each session it hashes `bin/`, `src/`, `package.json`, `.claude/`, `test/`, `tickets/` (apart from
  Kane's recordings), `.proven/config.json`, every `.gitignore` and `.gitattributes`, and the whole `.git` directory
  except objects, logs, the index and refs. It also compares every git ref and looks for skip-worktree flags.
- Every commit made during a session must be one that `proven done` makes (the app tree Kane judged, a state file, a
  receipt), must name the ticket handed to the agent, and must leave the ticket's red record alone, never lower its
  attempt count, and say done only with a matching receipt.
- If any check fails, it prints "Proven's own files changed during the agent's session", trusts nothing from that
  session, runs no recheck and exits 1. A person's uncommitted change to those files stops the loop before it starts.
- Every git command Proven makes ignores replace objects and system and global git config, and is pinned to the
  repository's own `.git`. The loop refuses to run where `.git` is a file (a worktree or a submodule).
- The Kane program's whole package directory is hashed before the loop and checked again before each recheck.

`verify --replay`, run by someone else on their own machine, stays the strongest check.

## Exit codes

0: every ticket it handled is done and the last recheck passes. 1: a ticket needs a person, the agent stopped without a
green, or the last recheck reopened a ticket. 2: something did not run.

## Running it yourself

```
git checkout try-it                  # T-3 is written, not frozen
node bin/proven.js freeze T-3        # a person freezes the ticket's test
node bin/proven.js red T-3           # Kane must fail it on the shop as it is: red
node bin/proven.js loop              # the agent, Kane and the recheck, in one command
```

It needs Kane CLI and `kane-cli login`, Google Chrome and Claude Code (`claude`). Proven serves the app itself on the
start URL's port (8091), so nothing else may listen there.
