import { Refusal } from './errors.js';
import { loadConfig } from './config.js';
import { findRoot } from './git.js';
import { cmdNew } from './commands/new.js';
import { cmdFreeze } from './commands/freeze.js';
import { cmdRed } from './commands/red.js';
import { cmdDone } from './commands/done.js';
import { cmdVerify } from './commands/verify.js';
import { cmdRecheck } from './commands/recheck.js';

export const USAGE = `proven: a ticket closes only when Kane CLI saw it fail before the change and pass after it.

  proven new T-N "<title>" [--url <start url>] [--landmark <text>]   write a ticket skeleton
  proven freeze T-N                  freeze the ticket's test (person)
  proven red T-N                     prove the test fails on the code as it is (person)
  proven done T-N                    the agent says it is done; Kane decides
  proven verify receipts/T-N.json    re-check a receipt with git only
  proven verify receipts/T-N.json --replay
                                     and run Kane again with the app at red (must fail) and at green (must pass)
  proven recheck [T-N ...]           replay every done ticket; reopen one whose failure a fresh run confirms

Kane is always kane-cli from PATH. Settings live in .proven/config.json (app, timeout_s, max_attempts)
and are pinned when a ticket is frozen.
Exit codes for red and done: 0 ok, 1 Kane failed (or already passes at red), 2 did not run.
Exit codes for recheck: 0 all still pass, 1 a ticket reopened, 2 something did not run.`;

const COMMANDS = { new: cmdNew, freeze: cmdFreeze, red: cmdRed, done: cmdDone, verify: cmdVerify, recheck: cmdRecheck };
const VALUE_FLAGS = new Set(['url', 'landmark']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq > 0 ? eq : undefined);
      if (eq > 0) flags[name] = arg.slice(eq + 1);
      else if (VALUE_FLAGS.has(name)) {
        if (i + 1 >= argv.length) throw new Refusal(`--${name} needs a value.`);
        flags[name] = argv[++i];
      } else flags[name] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

export function makeOut({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const line = (stream, s) => stream.write(String(s).endsWith('\n') ? String(s) : String(s) + '\n');
  // Verdicts go to stdout and stderr, so an agent or hook that reads only one still sees them.
  // When both streams are the same terminal, a person would see it twice, so it is printed once.
  const sameTerminal = Boolean(stdout.isTTY && stderr.isTTY);
  return {
    say: (s) => line(stdout, s),
    warn: (s) => line(stderr, s),
    both: (s) => {
      line(stdout, s);
      if (!sameTerminal) line(stderr, s);
    },
    progress: (s) => line(stderr, s),
  };
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), stdout, stderr } = {}) {
  const out = makeOut({ stdout, stderr });
  try {
    const { positional, flags } = parseArgs(argv);
    const name = positional.shift();
    if (!name || name === 'help' || flags.help) {
      out.say(USAGE);
      return name ? 0 : 2;
    }
    const command = COMMANDS[name];
    if (!command) {
      out.warn(`Unknown command "${name}".\n\n${USAGE}`);
      return 2;
    }
    if (flags.timeout !== undefined) throw new Refusal('There is no --timeout flag. The time limit is timeout_s in .proven/config.json, pinned at freeze.');
    const root = findRoot(cwd);
    const config = name === 'verify' ? null : loadConfig(root);
    return await command({ root, cwd, config, out }, positional, flags);
  } catch (err) {
    if (err instanceof Refusal) {
      out.warn(err.message);
      return err.exitCode;
    }
    out.warn(`proven: ${err.message}`);
    return 2;
  }
}
