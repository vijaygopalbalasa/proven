import http from 'node:http';
import https from 'node:https';

// Does the start URL answer HTTP 200 right now? No redirects are followed.
export function probe(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, detail: 'not a valid URL' });
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve({ ok: false, detail: 'not an http or https URL' });
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { agent: false, timeout: timeoutMs, headers: { 'cache-control': 'no-cache' } }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode === 200, status: res.statusCode, detail: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', (err) => resolve({ ok: false, detail: err.code || err.message }));
  });
}
