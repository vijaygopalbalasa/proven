import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { Refusal } from './errors.js';

export const CONFIG_PATH = '.proven/config.json';

export const DEFAULTS = Object.freeze({
  app: 'demo/app',
  kane: ['kane-cli'],
  timeout_s: 300,
  max_attempts: 4,
});

const RESERVED = ['tickets', 'receipts', '.proven', '.git', '.testmuai'];

// The Kane command comes only from this file, never from the environment.
export function loadConfig(root) {
  const file = join(root, CONFIG_PATH);
  let user = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Refusal(`${CONFIG_PATH} is not valid JSON.`);
    }
  }
  const merged = { ...DEFAULTS, ...user };

  if (typeof merged.app !== 'string' || !merged.app.trim()) throw new Refusal(`${CONFIG_PATH}: "app" must name the app folder.`);
  const app = normalize(merged.app.trim()).replace(/\\/g, '/').replace(/\/+$/, '');
  if (isAbsolute(app) || app === '.' || app.startsWith('..') || RESERVED.some((r) => app === r || app.startsWith(r + '/'))) {
    throw new Refusal(`${CONFIG_PATH}: "app" must be a folder inside the repository, apart from tickets/, receipts/ and .proven/.`);
  }

  const kane = typeof merged.kane === 'string' ? [merged.kane] : merged.kane;
  if (!Array.isArray(kane) || !kane.length || !kane.every((part) => typeof part === 'string' && part)) {
    throw new Refusal(`${CONFIG_PATH}: "kane" must be a command, for example ["kane-cli"].`);
  }

  const timeoutS = Number(merged.timeout_s);
  if (!(timeoutS > 0)) throw new Refusal(`${CONFIG_PATH}: "timeout_s" must be a number of seconds.`);
  const maxAttempts = Number(merged.max_attempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Refusal(`${CONFIG_PATH}: "max_attempts" must be 1 or more.`);

  return { app, kane, timeoutS, maxAttempts, kaneIsDefault: kane.length === 1 && kane[0] === 'kane-cli' };
}
