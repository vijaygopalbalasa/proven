import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Refusal } from './errors.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// A static file handler for one folder. Every answer says Cache-Control: no-store, so a browser never shows an
// older copy of the app.
export function staticHandler(root) {
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
      return send(200, await readFile(file), TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    } catch {
      return send(404, 'Not found');
    }
  };
}

function listen(server, port, host) {
  return new Promise((done, fail) => {
    const onError = (err) => {
      server.off('listening', onListening);
      fail(err);
    };
    const onListening = () => {
      server.off('error', onError);
      done();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// The loopback addresses a start URL can reach. "localhost" may resolve to either, so both are taken.
export function hostsFor(startUrl) {
  const { hostname } = new URL(startUrl);
  if (hostname === 'localhost') return ['127.0.0.1', '::1'];
  if (hostname === '[::1]') return ['::1'];
  return [hostname];
}

// Serve a folder on a port, on every loopback address the start URL can reach.
// A port held by another server is a refusal: Kane must only ever see what Proven serves.
export async function serveFolder(root, { port, hosts }) {
  const servers = [];
  const closeAll = () =>
    Promise.all(
      servers.map(
        (s) =>
          new Promise((done) => {
            s.closeAllConnections?.();
            s.close(() => done());
          }),
      ),
    );
  for (const host of hosts) {
    const server = createServer(staticHandler(root));
    try {
      await listen(server, port, host);
      servers.push(server);
    } catch (err) {
      if (host === '::1' && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) continue;
      await closeAll();
      if (err.code === 'EADDRINUSE') {
        throw new Refusal(
          `Port ${port} is already in use. Stop the other server (for example npm run demo) and run this again: Proven serves the app itself while Kane runs.`,
        );
      }
      throw err;
    }
  }
  return { close: closeAll };
}
