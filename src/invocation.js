import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// How the agent calls Proven in this project: inside Proven's own repository it is node bin/proven.js, anywhere else
// it is proven (installed with npm link, or on PATH some other way).
export function invocation(root) {
  try {
    const own = realpathSync(join(root, 'bin', 'proven.js'));
    if (own === realpathSync(fileURLToPath(new URL('../bin/proven.js', import.meta.url)))) return 'node bin/proven.js';
  } catch {}
  return 'proven';
}
