import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Refusal } from '../errors.js';
import { fileAt } from '../git.js';
import { ID_RE, ticketPaths } from '../ticket.js';
import { boardModel, changeKey } from './model.js';

const PAGE = new URL('./page.html', import.meta.url);

function listen(server, port, host) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      done();
    });
  });
}

// Requirement 6: a local page with no build step. It reads only committed state, and the page updates itself over
// server-sent events whenever a commit (or a Kane run starting or ending) changes what it shows.
// It listens on 127.0.0.1 only, and answers only requests addressed to this machine by a loopback name: a web page on
// another name that resolves here (DNS rebinding) sends that name as Host and gets 421, and a request from another
// page's origin gets 403.
export async function startBoard(root, { port = 8090, hosts = ['127.0.0.1'], judge = false, pollMs = 1000 } = {}) {
  const page = readFileSync(PAGE);
  let model = boardModel(root, { judge });
  let body = JSON.stringify(model);
  let key = changeKey(root);
  const clients = new Set();

  const send = (res, status, data, type) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  };
  const names = () => [`localhost:${bound}`, `127.0.0.1:${bound}`, `[::1]:${bound}`];
  const handler = (req, res) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!names().includes(host)) return send(res, 421, 'This board answers only to localhost.', 'text/plain; charset=utf-8');
    const origin = req.headers.origin;
    if (origin !== undefined && !names().some((n) => `http://${n}` === String(origin).toLowerCase())) {
      return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    }
    const url = new URL(req.url, 'http://board');
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    if (url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
    if (url.pathname === '/api/board') return send(res, 200, body, 'application/json; charset=utf-8');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`retry: 2000\nevent: board\ndata: ${body}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    const receipt = /^\/receipts\/(T-[1-9][0-9]*)\.json$/.exec(url.pathname);
    if (receipt && ID_RE.test(receipt[1])) {
      const bytes = fileAt(root, 'HEAD', ticketPaths(receipt[1]).receipt);
      if (bytes) return send(res, 200, bytes, 'application/json; charset=utf-8');
    }
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  };

  // Loopback only: nothing outside this machine can reach the board.
  const servers = [];
  const closeServers = () =>
    Promise.all(
      servers.map(
        (server) =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      ),
    );
  let bound = port;
  for (const host of hosts) {
    const server = createServer(handler);
    try {
      await listen(server, bound, host);
      bound = server.address().port;
      servers.push(server);
    } catch (err) {
      if (host === '::1' && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) continue;
      await closeServers();
      if (err.code === 'EADDRINUSE') throw new Refusal(`Port ${bound} is already in use. Pick another one: proven board --port 8095`);
      throw err;
    }
  }

  let busy = false;
  const poll = setInterval(() => {
    if (busy) return;
    busy = true;
    try {
      const next = changeKey(root);
      if (next === key) return;
      const built = boardModel(root, { judge });
      key = next;
      model = built;
      const text = JSON.stringify(model);
      if (text === body) return;
      body = text;
      for (const res of clients) res.write(`event: board\ndata: ${body}\n\n`);
    } catch {
      // A commit in the middle of a read can fail one poll; the next one catches up.
    } finally {
      busy = false;
    }
  }, pollMs);
  const ping = setInterval(() => {
    for (const res of clients) res.write(': still here\n\n');
  }, 15000);

  return {
    port: bound,
    model: () => model,
    close: async () => {
      clearInterval(poll);
      clearInterval(ping);
      for (const res of clients) res.end();
      await closeServers();
    },
  };
}
