// The Balise Worker under workerd, against a real local D1.
//
// This file runs `wrangler dev` and talks to it over HTTP, which is the only way to
// exercise the three things node cannot fake:
//
//   1. `result.meta.rows_read`, which is A4's whole point. It counts rows SCANNED, and a
//      query that scans the table is free locally and is what exhausts the daily quota in
//      production. The budget assertions below are the only thing that would catch it.
//   2. `crypto.subtle.timingSafeEqual`, a Workers runtime extension that does not exist in
//      node, and therefore the entire C3 comparison and lockout.
//   3. D1 itself: the unique index that is the duplicate guard, and the guarded UPDATE
//      that enforces C4.
//
// WHAT THIS FILE CANNOT PROVE, and neither can any other local test:
//   - Every D1 limit and quota. Local D1 is the same workerd binary over a real SQLite
//     file, so SQL behaviour reproduces, but no limit and no quota does
//     (cloudflare/workers-sdk#6347: a migration that passes --local fails --remote with
//     SQLITE_TOOBIG). rows_read is measured here and BILLED only in production.
//   - The Turnstile success path against a real widget. It uses Cloudflare's published
//     always-passes DUMMY secret key, which is a documented test value and not a secret
//     (https://developers.cloudflare.com/turnstile/troubleshooting/testing/). A real
//     sitekey, a real browser and a real token are never involved.
//
// It also makes real network calls to challenges.cloudflare.com. That is deliberate: a
// stubbed siteverify would prove nothing about the code path that matters.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(WORKER_DIR, 'node_modules/.bin/wrangler');
const STATE = join(WORKER_DIR, '.wrangler/test-state');

const PORT = 8878;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-operator-token-local-only-not-a-secret';
const SALT = 'test-ip-salt-local-only';

// Cloudflare's published test secret keys. Both are documented public values, not
// secrets: "1x..." always passes siteverify and "2x..." always fails.
const TURNSTILE_PASS = '1x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const SEEDED = 40;
const ORIGIN = 'https://balise.neorgon.com';

let worker = null;

// ── Process control ───────────────────────────────────────────────────────────

function run(args) {
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

async function startWorker(port, vars) {
  const args = ['dev', '--port', String(port), '--inspector-port', String(port + 1000)];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  args.push('--persist-to', STATE);
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

async function stopWorker(child) {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  if (!child.killed) child.kill('SIGKILL');
}

// ── Request helpers ───────────────────────────────────────────────────────────

async function call(path, { method = 'GET', body, token, actor, ip, origin, base = BASE } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (actor) headers['X-Balise-Actor'] = actor;
  if (ip) headers['CF-Connecting-IP'] = ip;
  if (origin) headers.Origin = origin;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { res, body: json };
}

const report = (n, over = {}) => ({
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

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  // A fresh database every run. The rows_read budgets below only mean something against
  // a known number of rows.
  rmSync(STATE, { recursive: true, force: true });
  await run(['d1', 'execute', 'balise', '--local', '--persist-to', STATE, '--file=schema.sql', '-y']);
  worker = await startWorker(PORT, {
    BALISE_OPERATOR_TOKEN: TOKEN,
    BALISE_IP_SALT: SALT,
    BALISE_TURNSTILE_SECRET: TURNSTILE_PASS,
  });

  // Seed through the real ingest path rather than by inserting rows, so the fixtures are
  // produced by the code under test. The address changes every eighth report because the
  // ratelimit binding really does count in local mode (measured, see the A5 note at the
  // bottom of this file) and the shipped config allows 20 per minute per key.
  for (let i = 0; i < SEEDED; i += 1) {
    const { res } = await call('/report', { method: 'POST', body: report(i), ip: `198.51.100.${10 + Math.floor(i / 8)}` });
    assert.equal(res.status, 200, `seeding report ${i} failed with ${res.status}`);
  }
}, { timeout: 300_000 });

after(async () => {
  await stopWorker(worker);
});

// ── /health, and the per-site read-back ───────────────────────────────────────

test('/health names which secrets are bound and never their values', async () => {
  const { res, body } = await call('/health');
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.config, { db: true, operator_token: true, turnstile: true, ip_salt: true, rate_limiter: true });
  assert.equal(body.store_ok, true);
  const text = JSON.stringify(body);
  assert.ok(!text.includes(TOKEN), '/health leaked the operator token');
  assert.ok(!text.includes(SALT), '/health leaked the ip salt');
  assert.ok(!text.includes(TURNSTILE_PASS), '/health leaked the turnstile secret');
});

test('/health counts reports per site, which is the only read-back on a live Beacon', async () => {
  const { body } = await call('/health');
  const parla = body.sites.find((s) => s.site === 'parla-site');
  assert.ok(parla, 'parla-site is missing from the per-site read-back');
  assert.equal(parla.reports, SEEDED);
  assert.ok(parla.last_at > 0);
  assert.equal(body.window_days, 30);
});

// ── C1 and ingest ─────────────────────────────────────────────────────────────

test('C1: an identical report is a DUPLICATE and writes no second row', async () => {
  const before = (await call('/health')).body.sites.find((s) => s.site === 'parla-site').reports;
  const { res, body } = await call('/report', { method: 'POST', body: report(0), ip: '203.0.113.9' });
  assert.equal(res.status, 409);
  assert.equal(body.code, 'DUPLICATE');
  const after = (await call('/health')).body.sites.find((s) => s.site === 'parla-site').reports;
  assert.equal(after, before);
});

test('C1: the duplicate guard ignores case and whitespace', async () => {
  const noisy = report(1, { body: `  SEEDED   report 1:  The gloss here does not match what the page says.` });
  const { body } = await call('/report', { method: 'POST', body: noisy, ip: '203.0.113.10' });
  assert.equal(body.code, 'DUPLICATE');
});

test('C1: an old widget fails loudly with BAD_VERSION', async () => {
  const { res, body } = await call('/report', { method: 'POST', body: report(900, { v: 2 }), ip: '203.0.113.11' });
  assert.equal(res.status, 400);
  assert.equal(body.code, 'BAD_VERSION');
});

test('C1: a page level report with target null is accepted, not an error', async () => {
  const { res, body } = await call('/report', { method: 'POST', body: report(901, { target: null, site: 'pieza-site' }), ip: '203.0.113.12' });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
});

test('C2: a body over 8 KB is TOO_LARGE and is refused before it is parsed', async () => {
  const { res, body } = await call('/report', { method: 'POST', body: report(902, { body: 'x'.repeat(9000) }), ip: '203.0.113.13' });
  assert.equal(res.status, 413);
  assert.equal(body.code, 'TOO_LARGE');
});

test('C2: a report with no challenge token is CHALLENGE_FAILED', async () => {
  const { res, body } = await call('/report', { method: 'POST', body: report(903, { turnstile: '' }), ip: '203.0.113.14' });
  assert.equal(res.status, 403);
  assert.equal(body.code, 'CHALLENGE_FAILED');
});

// ── C2.2: origins ─────────────────────────────────────────────────────────────

test('C2.2: a denied origin gets FORBIDDEN_ORIGIN and no CORS headers at all', async () => {
  const { res, body } = await call('/report', { method: 'POST', body: report(904), origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(body.code, 'FORBIDDEN_ORIGIN');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('C2.2: an allowed origin is echoed back, exactly one of them, with Vary', async () => {
  const { res } = await call('/log', { origin: ORIGIN });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(res.headers.get('vary') || '', /Origin/);
});

test('a preflight from an allowed origin is a 204 that names the methods', async () => {
  const res = await fetch(`${BASE}/report`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods') || '', /PATCH/);
});

// ── C3: operator authentication ───────────────────────────────────────────────

test('C3: absent and wrong tokens are both one generic 401', async () => {
  const absent = await call('/reports', { ip: '192.0.2.10' });
  const wrong = await call('/reports', { token: 'not-the-token', ip: '192.0.2.10' });
  assert.equal(absent.res.status, 401);
  assert.equal(wrong.res.status, 401);
  assert.equal(absent.body.code, 'UNAUTHORIZED');
  assert.deepEqual(absent.body, wrong.body, 'the two failures are distinguishable');
});

test('C3: the right token opens the desk', async () => {
  const { res, body } = await call('/reports?limit=5', { token: TOKEN, ip: '192.0.2.11' });
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.reports.length, 5);
});

test('C3: five wrong tries lock that address out, and the right token still fails', async () => {
  const ip = '192.0.2.50';
  for (let i = 0; i < 5; i += 1) {
    const { res } = await call('/reports', { token: `wrong-${i}`, ip });
    assert.equal(res.status, 401);
  }
  const locked = await call('/reports', { token: TOKEN, ip });
  assert.equal(locked.res.status, 401, 'the lockout did not hold');
  assert.equal(locked.body.code, 'UNAUTHORIZED');

  // And it is scoped to the address, not to the deployment: one prober must not be able
  // to lock the operator out of their own queue.
  const elsewhere = await call('/reports', { token: TOKEN, ip: '192.0.2.51' });
  assert.equal(elsewhere.res.status, 200);
});

test('C3: /report and /log never honour the operator header', async () => {
  const log = await call('/log', { token: TOKEN });
  assert.equal(log.res.status, 200);
  assert.equal(log.body.provider, 'log');
  // The log carries the operator's note and never the stranger's text.
  for (const e of log.body.entries) {
    assert.equal(e.body, undefined, 'the public log served a report body');
    assert.equal(e.contact, undefined, 'the public log served a contact');
  }
});

// ── C4: transitions, enforced ─────────────────────────────────────────────────

async function firstNew() {
  const { body } = await call('/reports?status=new&limit=1', { token: TOKEN, ip: '192.0.2.12' });
  return body.reports[0];
}

test('C4: the AI is refused every edge except new to triaged', async () => {
  const r = await firstNew();
  for (const to of ['accepted', 'rejected', 'spam', 'fixed']) {
    const { res, body } = await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: to }, token: TOKEN, actor: 'ai', ip: '192.0.2.12' });
    assert.equal(res.status, 409, `ai new -> ${to} was allowed`);
    assert.equal(body.code, 'BAD_TRANSITION');
  }
});

test('C4: the AI takes its one edge, and a human carries it the rest of the way', async () => {
  const r = await firstNew();
  const triaged = await call(`/reports/${r.id}`, {
    method: 'PATCH',
    body: { status: 'triaged', ai_verdict: 'plausible', ai_confidence: 0.7, ai_notes: 'Consistent with the page.' },
    token: TOKEN,
    actor: 'ai',
    ip: '192.0.2.12',
  });
  assert.equal(triaged.res.status, 200, JSON.stringify(triaged.body));
  assert.equal(triaged.body.report.status, 'triaged');
  assert.equal(triaged.body.report.ai.verdict, 'plausible');

  const accepted = await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: 'accepted' }, token: TOKEN, ip: '192.0.2.12' });
  assert.equal(accepted.body.report.status, 'accepted');

  const bare = await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: 'fixed' }, token: TOKEN, ip: '192.0.2.12' });
  assert.equal(bare.res.status, 400, 'fixed was accepted with no public note');
  assert.equal(bare.body.code, 'BAD_FIELD');

  const fixed = await call(`/reports/${r.id}`, {
    method: 'PATCH',
    body: { status: 'fixed', public_note: 'Corrected the gloss on that entry.', fixed_ref: 'abc1234' },
    token: TOKEN,
    ip: '192.0.2.12',
  });
  assert.equal(fixed.body.report.status, 'fixed');

  const reopen = await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: 'accepted' }, token: TOKEN, ip: '192.0.2.12' });
  assert.equal(reopen.res.status, 409, 'fixed is not terminal');
  assert.equal(reopen.body.code, 'BAD_TRANSITION');
});

test('C4: the public log shows the operator note and never the report body', async () => {
  const { body } = await call('/log');
  assert.ok(body.entries.length >= 1);
  const entry = body.entries[0];
  assert.equal(entry.public_note, 'Corrected the gloss on that entry.');
  assert.deepEqual(Object.keys(entry).sort(), ['fixed_at', 'fixed_ref', 'public_note', 'site', 'target_label', 'url']);
});

test('C4: a report cleared of public never reaches the log', async () => {
  const r = await firstNew();
  await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: 'accepted', public: false }, token: TOKEN, ip: '192.0.2.13' });
  await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: 'fixed', public_note: 'Held back deliberately.' }, token: TOKEN, ip: '192.0.2.13' });
  const { body } = await call('/log?limit=50');
  assert.ok(!body.entries.some((e) => e.public_note === 'Held back deliberately.'), 'a non public report reached the log');
});

test('C4: an unknown status is refused before it reaches the store', async () => {
  const r = await firstNew();
  const { res, body } = await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: 'done' }, token: TOKEN, ip: '192.0.2.14' });
  assert.equal(res.status, 400);
  assert.equal(body.code, 'BAD_FIELD');
});

test('C4: a report id that does not exist is NOT_FOUND, not a crash', async () => {
  const { res, body } = await call('/reports/nope-not-a-real-id', { method: 'PATCH', body: { status: 'accepted' }, token: TOKEN, ip: '192.0.2.15' });
  assert.equal(res.status, 404);
  assert.equal(body.code, 'NOT_FOUND');
});

// ── A4: the rows_read budget ──────────────────────────────────────────────────
//
// The assertion that matters. Local D1 enforces no quota, so a query that scans the whole
// table is free here and is exactly the one that burns the daily allowance in production.
// Measured on 2026-08-29: every keyset page read exactly `limit` rows. Dropping
// reports_created and reports_status_created and repeating the same requests read 208 rows
// for a page of 5, so the gap this assertion sits in is wide, not marginal.

import { rowsReadBudget } from '../src/store.js';

test('A4: the desk reads a page, not the table', async () => {
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?limit=${limit}`, { token: TOKEN, ip: '192.0.2.20' });
    assert.equal(typeof body.rows_read, 'number', 'the worker did not report rows_read');
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `unfiltered page of ${limit} scanned ${body.rows_read} rows, budget ${rowsReadBudget(limit)}`,
    );
    assert.ok(body.rows_read < SEEDED, `page of ${limit} scanned ${body.rows_read} rows of ${SEEDED}, which is a table scan`);
  }
});

test('A4: the status filter reads a page, not the table', async () => {
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?status=new&limit=${limit}`, { token: TOKEN, ip: '192.0.2.21' });
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `filtered page of ${limit} scanned ${body.rows_read} rows, budget ${rowsReadBudget(limit)}`,
    );
  }
});

test('A4: the public log reads matching rows, not the table', async () => {
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/log?limit=${limit}`);
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `log page of ${limit} scanned ${body.rows_read} rows, budget ${rowsReadBudget(limit)}`,
    );
  }
});

test('A4: paging is keyset, and the cursor walks without an offset', async () => {
  const first = await call('/reports?limit=10', { token: TOKEN, ip: '192.0.2.22' });
  assert.equal(first.body.reports.length, 10);
  assert.equal(typeof first.body.next, 'number');
  const second = await call(`/reports?limit=10&before=${first.body.next}`, { token: TOKEN, ip: '192.0.2.22' });
  assert.ok(second.body.rows_read <= rowsReadBudget(10), `page two scanned ${second.body.rows_read}`);
  const ids = new Set(first.body.reports.map((r) => r.id));
  assert.ok(!second.body.reports.some((r) => ids.has(r.id)), 'the second page repeated a row');
});

// ── Routing, and the promise that nothing is ever a 500 ───────────────────────

test('an unknown path is NOT_A_ROUTE and names the routes', async () => {
  const { res, body } = await call('/nope');
  assert.equal(res.status, 404);
  assert.equal(body.code, 'NOT_A_ROUTE');
  assert.match(body.hint, /\/report/);
});

test('the right path with the wrong method is NOT_A_ROUTE, never a 500', async () => {
  for (const [path, method] of [['/report', 'GET'], ['/reports', 'POST'], ['/log', 'POST'], ['/health', 'POST']]) {
    const { res, body } = await call(path, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(body.code, 'NOT_A_ROUTE');
  }
});

test('C2: every envelope this suite can reach carries the five keys and is never a 500', async () => {
  const probes = [
    call('/nope'),
    call('/reports'),
    call('/report', { method: 'POST', body: { v: 3 } }),
    call('/report', { method: 'POST', body: 'not-json-at-all' }),
  ];
  for (const p of probes) {
    const { res, body } = await p;
    assert.notEqual(res.status, 500);
    assert.deepEqual(Object.keys(body).sort(), ['code', 'hint', 'message', 'ok', 'provider']);
    assert.equal(body.ok, false);
    assert.ok(body.hint.length > 0, `${body.code} has an empty hint`);
  }
});

// ── The NOT_CONFIGURED paths, on a second process with no secrets ─────────────

test('with no secrets bound, ingest and the desk say so instead of failing vaguely', async (t) => {
  // The secrets are set to the EMPTY STRING rather than left out. Leaving them out is not
  // the same thing: `wrangler dev` also reads worker/.dev.vars if that file exists, so a
  // developer with a local .dev.vars would run this test against a fully configured worker
  // and it would pass for the wrong reason. Measured on 2026-08-29, when exactly that
  // happened. An empty --var overrides the file and is falsy, which is what the gate reads.
  const port = 8880;
  const bare = await startWorker(port, {
    BALISE_TURNSTILE_SECRET: '',
    BALISE_OPERATOR_TOKEN: '',
  });
  t.after(() => stopWorker(bare));
  const base = `http://127.0.0.1:${port}`;

  const health = await call('/health', { base });
  assert.equal(health.body.config.turnstile, false);
  assert.equal(health.body.config.operator_token, false);
  assert.equal(health.body.config.db, true);

  const ingest = await call('/report', { method: 'POST', body: report(950), base, ip: '203.0.113.60' });
  assert.equal(ingest.res.status, 501);
  assert.equal(ingest.body.code, 'NOT_CONFIGURED');

  const desk = await call('/reports', { token: 'anything', base, ip: '203.0.113.60' });
  assert.equal(desk.res.status, 501);
  assert.equal(desk.body.code, 'NOT_CONFIGURED');

  // The public log keeps working with nothing bound, which is what the hint promises.
  const log = await call('/log', { base });
  assert.equal(log.res.status, 200);
}, { timeout: 180_000 });
