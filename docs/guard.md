# The guard

`proven init` writes three files, which are already committed in this repository:

- `.claude/hooks/proven-guard.mjs`, run by a PreToolUse hook in `.claude/settings.json` before every Write, Edit,
  MultiEdit, NotebookEdit and Bash call.
- Bash time limits in the same settings (10 minutes), because a Kane run takes a minute or two and `proven done` runs
  in the foreground.
- A section in `CLAUDE.md`: the agent can read files, edit the app with its edit tools and run
  `node bin/proven.js done T-N`. It fixes the app, never the test, and stops after 4 failed attempts. If `CLAUDE.md`
  or the settings already exist, `proven init` merges into them and keeps the rest.

## What it blocks

- Edit tools may write only inside the project. A path outside it, or one that reaches outside through a symlink, is
  denied (an edit to `~/.gitconfig` could make an allowed git command run code).
- Writes by Write, Edit, MultiEdit and NotebookEdit to `tickets/` (where Kane also keeps its recordings), `receipts/`,
  `.proven/`, `.claude/`, `.git/`, and Proven's own files: `bin/`, `src/`, `package.json`, `node_modules/`, `test/`,
  `docs/`, `.gitignore` and `README.md`. The agent's only writable area is the app folder.
- A person's steps: `proven new`, `proven freeze`, `proven red` and `proven loop`.
- Bash is an allowlist. A command is allowed only if every segment (split on `|`, `&&`, `||`, `;` and newlines) is one of:
  - `proven done T-N` (as `node bin/proven.js done T-N`, `node ./bin/proven.js done T-N` or `proven done T-N`);
  - a read-only program: `cat`, `head`, `tail`, `ls`, `wc`, `grep`, `rg`, `find`, `sed -n` with print commands, `sort`,
    `uniq`, `diff`, `jq`, `echo`, `pwd`, `file`, `stat`, `tree`;
  - a read-only git subcommand: `log`, `show`, `diff`, `status`, `rev-parse`, `ls-files`, `blame`, `grep`, `cat-file`,
    `branch --list`.
- Each listed program accepts only an explicit list of safe flags. Any other flag, or an abbreviation of one, is blocked.
  A flag that takes a value must be followed by a word that is not itself a flag, and git never takes `--output`.
- An unquoted word may hold only letters, digits and `_ . / : = , @ % + -`. Single quotes are literal. Double quotes
  may not hold `$` or a backtick. Only `2>&1`, `2>/dev/null` and `>/dev/null` are allowed as redirections.
- Everything else is blocked: command substitution, `cd`, variable assignments, `npm`, `node` (other than the done
  command), `python`, `sh -c`, `curl` and the rest.

A block exits with code 2 and says why on stderr, which Claude Code shows to the agent. The message names the segment
and says the agent may only read files, edit the app with its edit tools, and run proven done.

## What it is

Defence in depth, not a sandbox. An agent with a shell outside the hook can still get around it. That is why a ticket is
shown as done only for a receipt that verifies, why `proven loop` checks git and file hashes after every session (see
[loop.md](loop.md)), and why `verify --replay` stays the strongest check.

## Seen blocking

In our live runs the agent never tried to change a test, so nothing was blocked live. This is the guard called the way
Claude Code calls a PreToolUse hook: the tool call as JSON on stdin, `<project>` standing for the repository folder.
Exit code 2 blocks the call and shows the reason to the agent; exit code 0 lets it through.

```
Edit  <project>/tickets/T-3_test.md
  Proven: <project>/tickets/T-3_test.md is under tickets/, which the agent does not change. Tickets, their frozen tests
  and locks are a person's. Fix the app, not the test. When you believe a ticket is done, run proven done T-N and wait for Kane.
  exit code: 2

Bash  node bin/proven.js red T-3
  Proven: proven red is a person's step, not the agent's. Work on the app. When you believe a ticket is done, run proven
  done T-N and wait for Kane.
  exit code: 2

Bash  echo loosened > tickets/T-3_test.md
  Proven: this command writes to tickets/T-3_test.md, under tickets/, which the agent does not change. Tickets, their
  frozen tests and locks are a person's. Fix the app, not the test. When you believe a ticket is done, run proven done T-N
  and wait for Kane.
  exit code: 2

Bash  cat tickets/T-3.md                       exit code: 0   (reading is allowed)
Edit  <project>/demo/app/cart.js               exit code: 0   (the app is the agent's to edit)
```
