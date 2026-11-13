import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from './errors.js';
import { invocation } from './invocation.js';

export const AGENT_PATH = '.proven/agent.json';

// The coding agent proven loop starts. The command is a list of words, run with no shell, and the prompt is added as
// the last word. It lives apart from .proven/config.json on purpose: locks pin the settings in config.json by hash,
// and the agent has no say in a verdict.
export function defaultAgentCommand(proven = 'node bin/proven.js') {
  return [
    'claude', '-p', '--model', 'claude-sonnet-5-5', '--permission-mode', 'acceptEdits',
    '--allowedTools', `Bash(${proven} done *)`, '--output-format', 'stream-json', '--verbose',
  ];
}

// The flag in an agent command that turns Claude Code's permission checks off, or null. Proven never runs such a command.
export function bypassFlag(cmd) {
  for (let i = 0; i < cmd.length; i++) {
    const w = cmd[i];
    if (w.startsWith('--dangerously-skip-permissions') || w.startsWith('--allow-dangerously-skip-permissions')) return w;
    if (/^--permission-mode=bypasspermissions$/i.test(w)) return w;
    if (w === '--permission-mode' && /^bypasspermissions$/i.test(cmd[i + 1] ?? '')) return `${w} ${cmd[i + 1]}`;
  }
  return null;
}

// { command, fromFile }. A command from .proven/agent.json comes from the repository, which may be someone else's, so
// proven loop runs it only when the person passes --agent-config.
export function loadAgentCommand(root) {
  const file = join(root, AGENT_PATH);
  if (!existsSync(file)) return { command: defaultAgentCommand(invocation(root)), fromFile: false };
  let user;
  try {
    user = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Refusal(`${AGENT_PATH} is not valid JSON.`);
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Refusal(`${AGENT_PATH} must hold a JSON object.`);
  for (const key of Object.keys(user)) {
    if (key !== 'command') throw new Refusal(`${AGENT_PATH}: unknown setting "${key}". Allowed: command.`);
  }
  const cmd = user.command;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((w) => typeof w === 'string' && w) ) {
    throw new Refusal(`${AGENT_PATH}: "command" must be a list of words, the program first, for example ["claude", "-p"]. It is run without a shell.`);
  }
  return { command: cmd, fromFile: true };
}

// Does this command ask the agent for stream-json output?
export function wantsStreamJson(cmd) {
  return cmd.some((w, i) => w === '--output-format=stream-json' || (w === '--output-format' && cmd[i + 1] === 'stream-json'));
}
