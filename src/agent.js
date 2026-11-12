import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from './errors.js';

export const AGENT_PATH = '.proven/agent.json';

// The coding agent proven loop starts. The command is a list of words, run with no shell, and the prompt is added as
// the last word. It lives apart from .proven/config.json on purpose: locks pin the settings in config.json by hash,
// and the agent has no say in a verdict.
export function defaultAgentCommand() {
  return [
    'claude', '-p', '--model', 'claude-sonnet-5-5', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(node bin/proven.js done *)', '--output-format', 'stream-json', '--verbose',
  ];
}

export function loadAgentCommand(root) {
  const file = join(root, AGENT_PATH);
  if (!existsSync(file)) return defaultAgentCommand();
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
  return cmd;
}

// Does this command ask the agent for stream-json output?
export function wantsStreamJson(cmd) {
  return cmd.some((w, i) => w === '--output-format=stream-json' || (w === '--output-format' && cmd[i + 1] === 'stream-json'));
}
