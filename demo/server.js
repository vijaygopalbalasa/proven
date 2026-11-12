#!/usr/bin/env node
// Serves the demo shop from demo/app with Cache-Control: no-store, so Kane always sees the current files.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const DEFAULT_ROOT = fileURLToPath(new URL('./app/', import.meta.url));

export function handler(root) {
  const base = resolve(root);
  return async (req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    } catch {
      return send(400, 'Bad request');
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(join(base, pathname));
    if (file !== base && !file.startsWith(base + sep)) return send(404, 'Not found');
    try {
      const info = await stat(file);
      if (!info.isFile()) return send(404, 'Not found');
      const body = await readFile(file);
      return send(200, body, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    } catch {
      return send(404, 'Not found');
    }
  };
}

export function startServer({ root = DEFAULT_ROOT, port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(handler(root));
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolvePromise({
        server,
        port: actual,
        url: `http://${host}:${actual}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function main() {
  const flag = process.argv.indexOf('--port');
  const port = Number(flag > -1 ? process.argv[flag + 1] : process.env.PORT ?? 8091);
  const root = DEFAULT_ROOT;
  await startServer({ root, port, host: '127.0.0.1' });
  // Also answer on IPv6 loopback, since browsers may try ::1 first for "localhost".
  await startServer({ root, port, host: '::1' }).catch(() => {});
  console.log(`Demo shop at http://localhost:${port}/ (Ctrl+C to stop)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`demo server: ${err.message}`);
    process.exit(1);
  });
}
