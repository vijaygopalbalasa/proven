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

- Edit tools (Write, Edit, MultiEdit, NotebookEdit) are deny-by-default. They may write only inside the app folder named
  in `.proven/config.json` (`demo/app` if the file is missing), and nowhere else. If the config cannot be read or names
  something that is not a folder inside the project, every edit is blocked. A path that reaches outside the app folder
  through `..` or a symlink is denied too (an edit to `~/.gitconfig` could make an allowed git command run code).
  Paths into `tickets/` (where Kane also keeps its recordings), `receipts/`, `.proven/`, `.claude/`, `.git/`,
  `.testmuai/`, `.mcp.json`, `CLAUDE.md`, `.gitattributes`, `.gitmodules` and Proven's own files (`bin/`, `src/`,
  `package.json`, `node_modules/`, `test/`, `docs/`, `.gitignore`, `README.md`) get a specific message. The loop's one
  need is the app folder, so this broke nothing in the demo or the TodoMVC run.
- MCP tool calls (the hook's matcher includes `mcp__.*`). The guard cannot tell what someone else's tool writes, so it
  checks every string in the arguments, object keys included, and fails closed:
  - a call it cannot check completely is blocked: a string over 4096 characters, nesting deeper than 10 levels, more than
    2000 values, or a `file:` URL or percent-encoding it cannot read;
  - every string is checked as written, percent-decoded (up to three rounds) and, for `file:` URLs, as the path the URL
    names, and a call that points into a protected path is blocked;
  - a path-like string (it starts with `/`, `~`, `./` or `../`, or has a slash and no spaces) must point inside the app
    folder, or the call is blocked. Ordinary text and `http(s)` URLs pass, and so does a bare file name such as
    `notes.txt`, which the guard cannot tell from a word. A tool that writes a bare name to the project root is not
    stopped by this check.
- Anything it cannot read. A tool call that is not valid JSON, or has no tool name, or makes the guard throw, is blocked
  with exit code 2 and a reason. It never lets a call through because it could not understand it.
- A person's steps: `proven new`, `proven freeze`, `proven red` and `proven loop`.
- Bash is an allowlist. A command is allowed only if every segment (split on `|`, `&&`, `||`, `;` and newlines) is one of:
  - `proven done T-N` (as `node bin/proven.js done T-N`, `node ./bin/proven.js done T-N` or `proven done T-N`);
  - a read-only program: `cat`, `head`, `tail`, `ls`, `wc`, `grep`, `rg`, `find`, `sed -n` with line-number print scripts such as `1,20p`, `sort`,
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

## Paths

Edit tools and MCP arguments are compared by where the file really is: symbolic links are resolved with the on-disk
(canonical) path of the deepest part that exists, and names are compared without regard to case. That covers a symlink
with another name that leads into `tickets/`, and `Tickets/` on a case-insensitive disk. It does not cover a hard link to
a protected file from somewhere else, or a second mount of the same disk. Those need a different kind of check (a
sandbox), and the guard is not one.

Kane's own writes to `.testmuai/` still work: they come from the process `proven done` starts, not through the agent's tools.

## What it is

It is not a sandbox. An agent with a shell outside the hook can still get around it. That is why a ticket is
shown as done only for a receipt that verifies, why `proven loop` checks git and file hashes after every session (see
[loop.md](loop.md)), and why `verify --replay` stays the strongest check.

## Seen blocking

In my live runs the agent never tried to change a test, so nothing was blocked live. This is the guard called the way
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
