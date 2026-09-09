// Process control and request helpers shared by the two files that run the Worker under
// workerd. NOT a *.test.mjs file, so `node --test tests/*.test.mjs` never runs it as a
// suite; it only ever gets imported.
//
// It exists because the local-D1 suite outgrew one file when the open-items feed arrived,
// and two copies of "spawn wrangler dev and wait for /health" is exactly the kind of
// duplication that drifts until one suite is testing a Worker the other is not.
//
// Every value below is a LOCAL TEST VALUE and none of them is a secret. Cloudflare's
// "1x..." Turnstile key is a documented public value that always passes siteverify
// (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const WRANGLER = join(WORKER_DIR, 'node_modules/.bin/wrangler');

export const TOKEN = 'test-operator-token-local-only-not-a-secret';
// The automation role is a SEPARATE credential, not a header. The suites prove the
// boundary by presenting a different token, which is the only way it can be reached.
export const AI_TOKEN = 'test-automation-token-local-only-not-a-secret';
export const SALT = 'test-ip-salt-local-only';

export const TURNSTILE_PASS = '1x0000000000000000000000000000000AA';
export const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export const ORIGIN = 'https://balise.neorgon.com';

/** One wrangler command to completion, with its whole output on failure. */
export function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(WRANGLER, args, {
      cwd: WORKER_DIR,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')} exited ${code}\n${out}`))));
  });
}

/** The migrations, on an isolated state directory. Never the schema file: 0002 adds
 *  columns, and a CREATE TABLE IF NOT EXISTS cannot add a column to a table that exists. */
export function migrate(state) {
  return run(['d1', 'migrations', 'apply', 'balise', '--local', '--persist-to', state]);
}

export async function startWorker(port, vars, state) {
  const args = ['dev', '--port', String(port), '--inspector-port', String(port + 1000)];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  args.push('--persist-to', state);
  const child = spawn(WRANGLER, args, {
    cwd: WORKER_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return child;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGKILL');
  throw new Error(`wrangler dev did not come up on ${port} in 90s:\n${log}`);
}

export async function stopWorker(child) {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  if (!child.killed) child.kill('SIGKILL');
}

/**
 * A request helper bound to one base URL. Returns { res, body } and never throws on an
 * HTTP status, because every failure this Worker can produce is a readable envelope and a
 * test that had to try/catch to see one would be testing the wrong thing.
 */
export function requester(defaultBase) {
  return async function call(path, { method = 'GET', body, token, ip, origin, base = defaultBase } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (ip) headers['CF-Connecting-IP'] = ip;
    if (origin) headers.Origin = origin;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { res, body: json };
  };
}

/** One valid C1 report, seeded through the real ingest path rather than inserted. */
export const report = (n, over = {}) => ({
  v: 1,
  site: 'parla-site',
  url: `https://parla.neorgon.com/?q=seed${n}`,
  target: { kind: 'concept', id: `seed${n}`, label: `seed ${n}` },
  kind: 'wrong',
  body: `Seeded report ${n}: the gloss here does not match what the page says.`,
  contact: '',
  turnstile: DUMMY_TOKEN,
  ...over,
});

/**
 * A slice of imported open items. Every fourth one carries a closed_at, which is what an
 * item whose tracker line moved to Done looks like: still private, and now a candidate
 * RESOLUTION rather than a candidate open entry. The text carries a path and a line
 * number on purpose, so that a suggestion built from it has something to strip.
 */
export function openBatch(from, count) {
  return Array.from({ length: count }, (_, n) => {
    const i = from + n;
    return {
      ref: `#${900 + i}`,
      text: `Seeded tracker line ${i}: enforce.py:${600 + i} returns 1 when total_drift is non-zero`,
      suggested: i % 3 === 0 ? `The seeded item ${i} is being worked on.` : '',
      opened_at: Date.UTC(2026, 7, 1) + i * 86400000,
      closed_at: i % 4 === 0 ? Date.UTC(2026, 8, 1) + i * 86400000 : null,
    };
  });
}

/** Seed the ingest path. The address changes every eighth report because the ratelimit
 *  binding really does count in local mode and the shipped config allows 20 per minute. */
export async function seedReports(call, count, assert) {
  for (let i = 0; i < count; i += 1) {
    const { res } = await call('/report', { method: 'POST', body: report(i), ip: `198.51.100.${10 + Math.floor(i / 8)}` });
    assert.equal(res.status, 200, `seeding report ${i} failed with ${res.status}`);
  }
}

/** Seed the import path, in batches of 25 because that is the route's cap. */
export async function seedOpenItems(call, count, assert) {
  for (let i = 0; i < count; i += 25) {
    const items = openBatch(i, Math.min(25, count - i));
    const { res, body } = await call('/open-items', { method: 'POST', body: { v: 1, source: 'queue', items }, token: AI_TOKEN });
    assert.equal(res.status, 200, `seeding open items failed: ${JSON.stringify(body)}`);
    assert.equal(body.created, items.length);
  }
}
