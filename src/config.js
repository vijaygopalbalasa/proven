import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { Refusal } from './errors.js';

export const CONFIG_PATH = '.proven/config.json';

export const DEFAULTS = Object.freeze({
  app: 'demo/app',
  timeout_s: 300,
  max_attempts: 4,
});

const ALLOWED = new Set(Object.keys(DEFAULTS));
const RESERVED = ['tickets', 'receipts', '.proven', '.git', '.testmuai'];

// The settings that shape verdicts. They are pinned in the lock at freeze; red and done refuse if they change.
// The Kane command is not one of them: it can never be set from a file in the repository.
export function loadConfig(root) {
  const file = join(root, CONFIG_PATH);
  let user = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Refusal(`${CONFIG_PATH} is not valid JSON.`);
    }
    if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Refusal(`${CONFIG_PATH} must hold a JSON object.`);
  }
  if ('kane' in user) throw new Refusal(`${CONFIG_PATH}: "kane" cannot be set here. Proven always runs kane-cli from PATH.`);
  for (const key of Object.keys(user)) {
    if (!ALLOWED.has(key)) throw new Refusal(`${CONFIG_PATH}: unknown setting "${key}". Allowed: ${[...ALLOWED].join(', ')}.`);
  }
  const merged = { ...DEFAULTS, ...user };

  if (typeof merged.app !== 'string' || !merged.app.trim()) throw new Refusal(`${CONFIG_PATH}: "app" must name the app folder.`);
  const app = normalize(merged.app.trim()).replace(/\\/g, '/').replace(/\/+$/, '');
  if (isAbsolute(app) || app === '.' || app.startsWith('..') || RESERVED.some((r) => app === r || app.startsWith(r + '/'))) {
    throw new Refusal(`${CONFIG_PATH}: "app" must be a folder inside the repository, apart from tickets/, receipts/ and .proven/.`);
  }
  const timeoutS = Number(merged.timeout_s);
  if (!(timeoutS > 0)) throw new Refusal(`${CONFIG_PATH}: "timeout_s" must be a number of seconds.`);
  const maxAttempts = Number(merged.max_attempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Refusal(`${CONFIG_PATH}: "max_attempts" must be 1 or more.`);

  return { app, timeoutS, maxAttempts };
}

// What the lock pins. The start URL always comes from step 1 of the frozen test.
export function settingsOf(config, startUrl) {
  return { app: config.app, timeout_s: config.timeoutS, max_attempts: config.maxAttempts, start_url: startUrl };
}

// Proven always runs kane-cli from PATH. Tests swap in a fake only through PROVEN_KANE_BIN, and every run,
// state file and receipt made that way is labelled as fake.
export const FAKE_LABEL = 'fake (PROVEN_KANE_BIN)';

export function kaneCommand(env = process.env) {
  const bin = env.PROVEN_KANE_BIN;
  if (bin) return { command: /\.[cm]?js$/.test(bin) ? [process.execPath, bin] : [bin], label: FAKE_LABEL, fake: true };
  return { command: ['kane-cli'], label: 'kane-cli', fake: false };
}
