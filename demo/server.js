#!/usr/bin/env node
// Serves the demo shop from demo/app, with Cache-Control: no-store, for looking at it by hand.
// Proven does not use this server: while Kane runs, it serves its own snapshot of the app on the same port.
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveFolder } from '../src/serve.js';

export const APP_DIR = fileURLToPath(new URL('./app/', import.meta.url));

async function main() {
  const flag = process.argv.indexOf('--port');
  const port = Number(flag > -1 ? process.argv[flag + 1] : process.env.PORT ?? 8091);
  await serveFolder(APP_DIR, { port, hosts: ['127.0.0.1', '::1'] });
  console.log(`Demo shop at http://localhost:${port}/ (Ctrl+C to stop). Stop it before proven red or proven done.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`demo server: ${err.message}`);
    process.exit(1);
  });
}
