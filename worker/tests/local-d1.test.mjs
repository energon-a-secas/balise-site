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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORKER_DIR, TOKEN, AI_TOKEN, SALT, TURNSTILE_PASS, ORIGIN,
  run, migrate, startWorker, stopWorker, requester, report, seedReports, seedOpenItems,
} from './harness.mjs';
// The row shape of a tenant report is defined ONCE, in tenant-fixture.mjs, and the two
// node:sqlite suites plant it with `plantReport`. This suite reuses that same function and
// changes only the transport: it has no node:sqlite handle on the database, because the
// database is workerd's, so the INSERTs are recorded rather than executed and handed to
// `wrangler d1 execute --local --file`. A second definition of "what a tenant row looks
// like" is how two suites come to disagree about the thing they are both testing.
import { plantReport, TENANT, TENANT_MARK } from './tenant-fixture.mjs';

// Process control and the request helper live in ./harness.mjs, which tests/open-items.test.mjs
// imports too. Two copies of "spawn wrangler dev and wait for /health" would drift.
const STATE = join(WORKER_DIR, '.wrangler/test-state');
const PORT = 8878;
const BASE = `http://127.0.0.1:${PORT}`;
const call = requester(BASE);

const SEEDED = 40;
/** Imported open items, seeded in `before` so that every corrections assertion in this
 *  file also states that the two feeds do not see each other. */
const OPEN_SEEDED = 30;

// ── The second tenancy, which is what makes the index cases at the foot of this file
//    discriminate rather than merely pass ──────────────────────────────────────────────
//
// A22: pass 3 asserted `rows_read < SEEDED + OPEN_SEEDED` against a table holding nothing but
// fleet rows. With one tenancy in the table a scoped index and an unscoped one read the same
// rows, so those assertions passed on either plan and detected nothing.
//
// These rows are the detector. Every one of them is NEWER than every fleet row this suite
// seeds, so an index whose leading column is not `app_id` must walk all of them before it
// reaches a single row the query can return. The `app_id = 'fleet'` term in the statement
// still rejects them, so nothing leaks either way and `rows_read` is the ONLY thing that
// moves: that is the measurement, and 'the fleet's answer is unchanged' is not.
//
// Measured 2026-09-18 in this suite, at a page of 25, six new indexes present against the same
// six dropped so the planner has to fall back to a kept one. Same Worker, same SQL, same
// fixture, 672 rows in the table:
//
//   GET /reports?kind=wrong&limit=25             55 rows_read  ->  625
//   GET /reports?kind=wrong&status=new&limit=25  55            ->  325
//   GET /reports?limit=25                        25            ->  625
//   GET /reports?status=new&limit=25             25            ->  325
//   GET /log?limit=25                             3            ->  303
//
// Forcing the fallback by dropping the six is a closer model of the risk than an `INDEXED BY`
// hint would be: the Worker's own statement is left exactly as it is and SQLite is left to
// choose freely among the indexes a rollback to 1.1.0 would leave behind.
//
// Two groups because the queries filter on different things: an unscoped plan for a
// `status = 'new'` query walks only the tenant's `new` rows, and one for the public log walks
// only its `fixed` ones. Each group on its own is therefore the floor an unscoped plan cannot
// get under, which is what `UNSCOPED_FLOOR` names.
const TENANT_NEW = 300;
const TENANT_FIXED = 300;
const TENANT_ROWS = TENANT_NEW + TENANT_FIXED;
/** The fewest tenant rows ANY unscoped plan among the six must read. Under a scoped plan the
 *  worst of the five cases reads 55, so the gap is wide in both directions. */
const UNSCOPED_FLOOR = Math.min(TENANT_NEW, TENANT_FIXED);
/** An hour ahead, so every tenant row is newer than every fleet row seeded below however
 *  long the seeding takes. The test 'the fixture is positioned' asserts that it worked,
 *  because a fixture that quietly slid under the fleet's rows is exactly how these cases
 *  would go vacuous again. */
const PLANTED_AT = Date.now() + 3_600_000;

let worker = null;

/**
 * The tenant rows, as one SQL file, built by tenant-fixture's own `plantReport`. The recorder
 * stands in for its `db.sqlite`: `plant` prepares one INSERT and runs it with the values, so
 * capturing the pair and rendering it as a literal statement is the same row by a different
 * road. Bindings are rendered rather than bound because `wrangler d1 execute` takes a file of
 * statements and no parameters.
 */
function tenantInserts() {
  const statements = [];
  const recorder = { sqlite: { prepare: (sql) => ({ run: (...params) => statements.push({ sql, params }) }) } };
  for (let i = 0; i < TENANT_NEW; i += 1) {
    plantReport(recorder, TENANT, {
      id: `pass3b-new-${i}`,
      over: { created_at: PLANTED_AT + i, status: 'new', fingerprint: `pass3b-new-${i}` },
    });
  }
  for (let i = 0; i < TENANT_FIXED; i += 1) {
    const at = PLANTED_AT + TENANT_NEW + i;
    plantReport(recorder, TENANT, {
      id: `pass3b-fixed-${i}`,
      // `site` is the fleet's own site on purpose: if the public log or the per-site read-back
      // ever stopped scoping, these rows would land in the middle of an answer a human reads.
      over: { created_at: at, status: 'fixed', public: 1, fixed_at: at, site: 'parla-site', fingerprint: `pass3b-fixed-${i}` },
    });
  }
  const literal = (v) => {
    if (v === null || v === undefined) return 'NULL';
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  };
  return statements
    .map(({ sql, params }) => `${sql.split('?').map((piece, i) => piece + (i < params.length ? literal(params[i]) : '')).join('')};`)
    .join('\n');
}

/** Plant them. The SQL file goes to a temp directory outside the repo and is removed either
 *  way: a stray .sql next to the suite is a scratch file someone will later mistake for a
 *  fixture. */
async function plantTenant(state) {
  const dir = mkdtempSync(join(tmpdir(), 'balise-tenant-'));
  try {
    const file = join(dir, 'tenant-rows.sql');
    writeFileSync(file, tenantInserts());
    await run(['d1', 'execute', 'balise', '--local', '--persist-to', state, '--file', file, '--yes']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One or more statements against the same local D1 the Worker is bound to, as one result set
 *  per statement. `--local` is spelled out here as it is in every other D1 command in this
 *  project. Reading this file while `wrangler dev` holds it open is safe and is verified by
 *  the tests that do it. */
async function d1(...commands) {
  const out = await run(['d1', 'execute', 'balise', '--local', '--persist-to', STATE, '--json', '--command', commands.join('; ')]);
  return JSON.parse(out.slice(out.indexOf('['))).map((set) => set.results);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  // A fresh database every run. The rows_read budgets below only mean something against
  // a known number of rows.
  rmSync(STATE, { recursive: true, force: true });
  await migrate(STATE);
  // Before the Worker starts, because nothing in phase 1 can create a tenant row through a
  // route: there is no tenant principal until WS-C, and `reports.app_id` is NOT NULL DEFAULT
  // 'fleet', so a row is only a tenant's if it is written with an explicit app_id. Planting
  // while `wrangler dev` holds the database would also be a second writer on the same file.
  await plantTenant(STATE);
  worker = await startWorker(PORT, {
    BALISE_OPERATOR_TOKEN: TOKEN,
    BALISE_AUTOMATION_TOKEN: AI_TOKEN,
    BALISE_IP_SALT: SALT,
    BALISE_TURNSTILE_SECRET: TURNSTILE_PASS,
  }, STATE);

  // Both feeds, through the real routes rather than by inserting rows, so the fixtures
  // are produced by the code under test. The open items are seeded HERE, before every
  // assertion below, so each of those is also a statement that a second feed in the same
  // table changes nothing about the first.
  await seedReports(call, SEEDED, assert);
  await seedOpenItems(call, OPEN_SEEDED, assert);
}, { timeout: 300_000 });


after(async () => {
  await stopWorker(worker);
});

// ── /health, and the per-site read-back ───────────────────────────────────────

test('/health names which secrets are bound and never their values', async () => {
  const { res, body } = await call('/health');
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.config, {
    db: true, operator_token: true, automation_token: true, turnstile: true, ip_salt: true, rate_limiter: true,
  });
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

test('C4: automation is refused every edge that reaches a reader', async () => {
  const r = await firstNew();
  for (const to of ['accepted', 'rejected', 'fixed']) {
    const { res, body } = await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: to }, token: AI_TOKEN, ip: '192.0.2.12' });
    assert.equal(res.status, 409, `ai new -> ${to} was allowed`);
    assert.equal(body.code, 'BAD_TRANSITION');
  }
});

test('C4: automation may close junk, and only a human may reopen it', async () => {
  const r = await firstNew();
  const spam = await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: 'spam' }, token: AI_TOKEN, ip: '192.0.2.13' });
  assert.equal(spam.res.status, 200, JSON.stringify(spam.body));
  assert.equal(spam.body.report.status, 'spam');

  // The automation credential cannot walk it back out.
  const reopenByAi = await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: 'accepted' }, token: AI_TOKEN, ip: '192.0.2.13' });
  assert.equal(reopenByAi.res.status, 409);
  assert.equal(reopenByAi.body.code, 'BAD_TRANSITION');

  // The operator can.
  const reopen = await call(`/reports/${r.id}`, { method: 'PATCH', body: { status: 'accepted' }, token: TOKEN, ip: '192.0.2.13' });
  assert.equal(reopen.body.report.status, 'accepted');
});

test('C3: the role follows the credential, so the old header cannot grant it', async () => {
  const r = await firstNew();
  // The operator token with the retired header set still gets the HUMAN table:
  // the header is inert, which is the whole point of moving the role onto the token.
  const res = await fetch(`${BASE}/reports/${r.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'X-Balise-Actor': 'ai',
      'CF-Connecting-IP': '192.0.2.14',
    },
    body: JSON.stringify({ status: 'accepted' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.report.status, 'accepted', 'the header must not downgrade a human');
});

test('C4: the AI takes its one edge, and a human carries it the rest of the way', async () => {
  const r = await firstNew();
  const triaged = await call(`/reports/${r.id}`, {
    method: 'PATCH',
    body: { status: 'triaged', ai_verdict: 'plausible', ai_confidence: 0.7, ai_notes: 'Consistent with the page.' },
    token: AI_TOKEN,
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

/**
 * #76 end to end. The Beacon sends `location.href`, so a report filed from a Vitrina
 * public shelf arrives carrying the owner's handle in the query. The desk needs that
 * address whole to reproduce the report; the public log needs the page and nothing else.
 * Both halves are asserted here because the two projections read the same stored column,
 * and trimming the column instead of the projection would pass one and break the other.
 */
test('#76: the log carries the page, and the desk keeps the whole address', async () => {
  const full = 'https://vitrina.neorgon.com/u/?owner=a-real-handle#shelf-3';
  const posted = await call('/report', {
    method: 'POST',
    ip: '198.51.100.90',
    body: report(9001, {
      site: 'vitrina-site',
      url: full,
      target: null,
      body: 'The spine order on this shelf does not match the list printed under it.',
    }),
  });
  assert.equal(posted.res.status, 200, JSON.stringify(posted.body));
  const id = posted.body.id;

  await call(`/reports/${id}`, { method: 'PATCH', body: { status: 'accepted' }, token: TOKEN, ip: '192.0.2.30' });
  const fixed = await call(`/reports/${id}`, {
    method: 'PATCH',
    body: { status: 'fixed', public_note: 'Reordered the spines to match the list.' },
    token: TOKEN,
    ip: '192.0.2.30',
  });
  assert.equal(fixed.body.report.status, 'fixed', JSON.stringify(fixed.body));

  const log = await call('/log?limit=50');
  const entry = log.body.entries.find((e) => e.public_note === 'Reordered the spines to match the list.');
  assert.ok(entry, 'the fixed report never reached the log');
  assert.equal(entry.url, 'https://vitrina.neorgon.com/u/');

  const desk = await call('/reports?status=fixed&limit=50', { token: TOKEN, ip: '192.0.2.30' });
  const row = desk.body.reports.find((r) => r.id === id);
  assert.ok(row, 'the fixed report is not on the desk');
  assert.equal(row.url, full, 'the desk lost the address it needs to reproduce the report');
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
  }, STATE);
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

// ── Phase 1: index selection, and the six kept indexes ────────────────────────
//
// `0004_tenants.sql` adds six tenant-first indexes and DROPS NOTHING, because Worker 1.1.0 is
// what a rollback goes back to and its queries are unscoped (DESIGN.md 6.1). The six they
// supersede therefore stay, and the one real risk section 4.2 names is that the planner
// reaches for a kept one for a scoped query: same answer, several hundred times the
// `rows_read`, and `rows_read` is what production bills.
//
// Each of the five cases below is that detector. `TENANT_ROWS` rows of a second tenancy sit
// above every fleet row, so a plan that does not lead on `app_id` must walk them; the
// assertion is an upper bound no such plan can meet. Every one of the five was taken red by
// dropping the six new indexes and green again by restoring them, and both numbers are in the
// comment beside `TENANT_NEW`.
//
// The sixth index has no such case and the test says so rather than pretending: see
// 'healthSites' at the foot of this file, and A21.

test('the fixture is positioned: every tenant row is newer than every fleet row', async () => {
  // The one thing every case below rests on, asserted directly, because a fixture that slid
  // under the fleet's rows would make all five pass while detecting nothing. That is A22's
  // failure exactly, and it is silent unless something looks.
  const [[tenant], [fleetAbove], [leak]] = await d1(
    `SELECT count(*) AS n, min(created_at) AS floor FROM reports WHERE app_id = '${TENANT}'`,
    `SELECT count(*) AS n FROM reports WHERE app_id = 'fleet' AND created_at >= (SELECT min(created_at) FROM reports WHERE app_id = '${TENANT}')`,
    `SELECT count(*) AS n FROM reports WHERE app_id = '${TENANT}' AND (work_state IS NOT NULL OR kind = 'open')`,
  );
  assert.equal(tenant.n, TENANT_ROWS, `the tenant fixture is ${tenant.n} rows, not ${TENANT_ROWS}`);
  assert.equal(
    fleetAbove.n, 0,
    `${fleetAbove.n} fleet rows sit at or above the fixture's floor of ${tenant.floor}, so an unscoped plan would reach a returnable row before it had walked the tenant, and the cases below cannot discriminate`,
  );
  // And the fixture itself honours the two invariants of DESIGN.md 4.3, so it cannot be the
  // thing that breaks tenant-invariants.test.mjs.
  assert.equal(leak.n, 0, 'the tenant fixture holds an open item or a queued row, which invariant 4.3 forbids');
});

test('reports_app_created: listReports with kind=wrong uses the scoped index', async () => {
  // Index: reports_app_created (app_id, created_at DESC)
  // Falls back to: reports_open_created (kind, created_at DESC), measured, not reports_created
  //
  // The index does not carry `kind`, so the walk is over fleet rows in created_at order with
  // the kind term applied per row. The only fleet rows it can reject are the open items, which
  // makes OPEN_SEEDED + limit an exact ceiling rather than a guess. A plan led by `kind`
  // instead of `app_id` reads all TENANT_ROWS first: measured 625 for a page of 25 against 55.
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?kind=wrong&limit=${limit}`, { token: TOKEN, ip: '192.0.2.100' });
    assert.equal(typeof body.rows_read, 'number', 'the worker did not report rows_read');
    assert.ok(
      body.rows_read <= OPEN_SEEDED + limit,
      `kind=wrong page of ${limit} scanned ${body.rows_read}, ceiling ${OPEN_SEEDED + limit}`,
    );
    assert.ok(
      body.rows_read < UNSCOPED_FLOOR,
      `kind=wrong page of ${limit} scanned ${body.rows_read}, which is at or above the ${UNSCOPED_FLOOR} tenant rows an unscoped plan has to walk: the planner took a kept index`,
    );
  }
});

test('reports_app_status_created: listReports with kind+status uses the multi-column index', async () => {
  // Index: reports_app_status_created (app_id, status, created_at DESC)
  // Falls back to: reports_open_status_created (kind, status, created_at DESC), measured
  //
  // Same ceiling as the case above and for the same reason: the index carries `status` but not
  // `kind`, and the open items are the only fleet rows the kind term rejects. A plan led by
  // `kind` walks the tenant's TENANT_NEW rows with status 'new': measured 325 against 55.
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?kind=wrong&status=new&limit=${limit}`, { token: TOKEN, ip: '192.0.2.101' });
    assert.ok(
      body.rows_read <= OPEN_SEEDED + limit,
      `kind+status page of ${limit} scanned ${body.rows_read}, ceiling ${OPEN_SEEDED + limit}`,
    );
    assert.ok(
      body.rows_read < UNSCOPED_FLOOR,
      `kind+status page of ${limit} scanned ${body.rows_read}, at or above the ${UNSCOPED_FLOOR} tenant rows an unscoped plan has to walk`,
    );
  }
});

test('reports_app_fix_created: corrections queue reads a page via partial index', async () => {
  // Index: reports_app_fix_created (app_id, created_at DESC) WHERE kind <> 'open'
  // Falls back to: reports_fix_created (created_at DESC) WHERE kind <> 'open', measured
  //
  // The partial predicate already excludes the open items, so a page reads exactly `limit`
  // rows and rowsReadBudget is the right ceiling. The kept index has the same predicate and no
  // app_id, so it walks all TENANT_ROWS: measured 625 for a page of 25 against 25.
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?limit=${limit}`, { token: TOKEN, ip: '192.0.2.102' });
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `corrections page of ${limit} scanned ${body.rows_read} rows, budget ${rowsReadBudget(limit)}`,
    );
    assert.ok(
      body.rows_read < UNSCOPED_FLOOR,
      `corrections page of ${limit} scanned ${body.rows_read}, at or above the ${UNSCOPED_FLOOR} tenant rows an unscoped plan has to walk`,
    );
  }
});

test('reports_app_fix_status_created: corrections with status uses the scoped partial index', async () => {
  // Index: reports_app_fix_status_created (app_id, status, created_at DESC) WHERE kind <> 'open'
  // Falls back to: reports_fix_status_created (status, created_at DESC) WHERE kind <> 'open'
  //
  // Every term of the WHERE is a prefix of the index and the sort is the index order, so a page
  // reads exactly `limit`. The kept index walks the tenant's TENANT_NEW 'new' rows first:
  // measured 325 for a page of 25 against 25.
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?status=new&limit=${limit}`, { token: TOKEN, ip: '192.0.2.103' });
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `corrections+status page of ${limit} scanned ${body.rows_read} rows, budget ${rowsReadBudget(limit)}`,
    );
    assert.ok(
      body.rows_read < UNSCOPED_FLOOR,
      `corrections+status page of ${limit} scanned ${body.rows_read}, at or above the ${UNSCOPED_FLOOR} tenant rows an unscoped plan has to walk`,
    );
  }
});

test('reports_app_fix_public_log: public log uses the 4-column scoped partial index', async () => {
  // Index: reports_app_fix_public_log (app_id, status, public, fixed_at DESC) WHERE kind <> 'open'
  // Falls back to: reports_fix_public_log (status, public, fixed_at DESC) WHERE kind <> 'open'
  //
  // The sharpest of the five, because the fixture's TENANT_FIXED rows are fixed, public and
  // carry a fixed_at above the fleet's: they sit exactly where this query starts reading.
  // Measured 3 against 303, and the 303 is the same at a page of 5 as at a page of 25, which is
  // the shape of a cost that is all seek and no page.
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/log?limit=${limit}`);
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `public log page of ${limit} scanned ${body.rows_read} rows, budget ${rowsReadBudget(limit)}`,
    );
    assert.ok(
      body.rows_read < UNSCOPED_FLOOR,
      `public log page of ${limit} scanned ${body.rows_read}, at or above the ${UNSCOPED_FLOOR} tenant rows an unscoped plan has to walk`,
    );
  }
});

test('healthSites has NO rows_read case, and reports_app_site_created is unused', async () => {
  // The sixth index, and the honest answer is that this file cannot build a discriminating
  // rows_read case for it. Two separate reasons, and both are worth writing down.
  //
  // 1. The index is not used. A21: `reports_app_site_created (app_id, site, created_at DESC)`
  //    was created for this query and the planner prefers the smaller partial index instead,
  //    then sorts. DESIGN.md 4.2's claim that "the GROUP BY uses the index order rather than a
  //    sort" is wrong, measured. The owner's decision is to KEEP the index: 0004 may contain no
  //    DROP while 1.1.0 is the rollback target, one index write per insert is nothing at this
  //    volume, and the plan may well change once the table has statistics and more rows, at
  //    which point this is the index that should win. So the assertion below pins what the
  //    planner does, not what the design wanted. Do not "fix" it to name the other index.
  // 2. /health exposes no rows_read at all, so there is no number to bound. What separates the
  //    two plans here is visible only in EXPLAIN QUERY PLAN, and that is where it is asserted:
  //    scoped it is a SEARCH over the 42 fleet corrections in the window, and with the six new
  //    indexes dropped it becomes `SCAN reports USING INDEX reports_site_created`, a full pass
  //    over all 672 rows in the table. That pair is in the plan test below, and it is the
  //    detector: 42 rows visited against 672, both measured.
  //
  // What this test can still say is that the answer is the fleet's alone. The fixture's
  // TENANT_FIXED rows carry site 'parla-site' on purpose, so a COUNT that lost its app_id term
  // would show up here as 340 reports against parla-site rather than 40.
  const { body } = await call('/health');
  assert.equal(body.ok, true);
  assert.equal(body.store_ok, true);
  const parla = body.sites.find((s) => s.site === 'parla-site');
  assert.ok(parla, 'parla-site is missing from per-site readback after index creation');
  assert.equal(parla.reports, SEEDED, `parla-site count is ${parla.reports}, expected ${SEEDED}`);
  assert.ok(!JSON.stringify(body.sites).includes(TENANT_MARK), 'the per-site read-back named a tenant site');
});

// ── A20: the plans, asserted by index name ────────────────────────────────────
//
// A20: `PRAGMA optimize` at the end of 0004 analyses nothing, because a migration runs against
// an empty table. `sqlite_stat1` holds one row and it is d1_migrations. So every plan below is
// chosen STRUCTURALLY, from the shape of the WHERE against the shape of the index, by the
// leftmost-prefix rule and nothing else. That is why they are stable enough to pin, and pinning
// them is the mitigation the pragma was mistakenly credited with: a planner change or an index
// change becomes a red test here instead of a bill in production.
//
// The statement text is a transcription, because these tests may not read worker/src. The test
// after this one is what keeps the transcription honest: each statement is run against the same
// database and its answer must equal the answer the route gives, so a transcription that has
// drifted from the store fails rather than pinning the plan of a query nobody runs.

/** Bigger than any created_at or fixed_at these tests produce, standing in for the keyset
 *  cursor's default. */
const CURSOR = Number.MAX_SAFE_INTEGER;
const WINDOW_FROM = Date.now() - 30 * 86_400_000;

const STATEMENTS = {
  'listReports, kind given': `SELECT id FROM reports WHERE app_id = 'fleet' AND kind = 'wrong' AND created_at < ${CURSOR} ORDER BY created_at DESC LIMIT 5`,
  'listReports, kind and status': `SELECT id FROM reports WHERE app_id = 'fleet' AND kind = 'wrong' AND status = 'new' AND created_at < ${CURSOR} ORDER BY created_at DESC LIMIT 5`,
  'listReports, corrections': `SELECT id FROM reports WHERE app_id = 'fleet' AND kind <> 'open' AND created_at < ${CURSOR} ORDER BY created_at DESC LIMIT 5`,
  'listReports, corrections and status': `SELECT id FROM reports WHERE app_id = 'fleet' AND kind <> 'open' AND status = 'new' AND created_at < ${CURSOR} ORDER BY created_at DESC LIMIT 5`,
  'publicLog': `SELECT id, public_note FROM reports WHERE app_id = 'fleet' AND kind <> 'open' AND status = 'fixed' AND public = 1 AND fixed_at < ${CURSOR} ORDER BY fixed_at DESC LIMIT 5`,
  'healthSites': `SELECT site, count(*) AS n, max(created_at) AS last_at FROM reports WHERE app_id = 'fleet' AND kind <> 'open' AND created_at > ${WINDOW_FROM} GROUP BY site ORDER BY n DESC`,
};

const PLANS = {
  'listReports, kind given': 'SEARCH reports USING INDEX reports_app_created (app_id=? AND created_at<?)',
  'listReports, kind and status': 'SEARCH reports USING INDEX reports_app_status_created (app_id=? AND status=? AND created_at<?)',
  'listReports, corrections': 'SEARCH reports USING INDEX reports_app_fix_created (app_id=? AND created_at<?)',
  'listReports, corrections and status': 'SEARCH reports USING INDEX reports_app_fix_status_created (app_id=? AND status=? AND created_at<?)',
  publicLog: 'SEARCH reports USING INDEX reports_app_fix_public_log (app_id=? AND status=? AND public=? AND fixed_at<?)',
  // Not reports_app_site_created, and A21 is why. This line is a measurement, not a wish.
  healthSites: 'SEARCH reports USING INDEX reports_app_fix_created (app_id=? AND created_at>?)'
    + ' | USE TEMP B-TREE FOR GROUP BY | USE TEMP B-TREE FOR ORDER BY',
};

test('A20: each of the six statements plans as a named index, and the name is asserted', async () => {
  const names = Object.keys(STATEMENTS);
  const sets = await d1(...names.map((name) => `EXPLAIN QUERY PLAN ${STATEMENTS[name]}`));
  assert.equal(sets.length, names.length, 'one EXPLAIN QUERY PLAN came back without a result set');
  for (const [i, name] of names.entries()) {
    assert.equal(sets[i].map((row) => row.detail).join(' | '), PLANS[name], `the plan for ${name} has changed`);
  }
});

test('A20: the six transcriptions are the store\'s own statements, proved against the routes', async () => {
  const names = Object.keys(STATEMENTS);
  const sets = await d1(...names.map((name) => STATEMENTS[name]));
  const answer = Object.fromEntries(names.map((name, i) => [name, sets[i]]));

  const desk = async (query, ip) => (await call(`/reports?limit=5${query}`, { token: TOKEN, ip })).body.reports.map((r) => r.id);
  assert.deepEqual(answer['listReports, kind given'].map((r) => r.id), await desk('&kind=wrong', '192.0.2.110'));
  assert.deepEqual(answer['listReports, kind and status'].map((r) => r.id), await desk('&kind=wrong&status=new', '192.0.2.111'));
  assert.deepEqual(answer['listReports, corrections'].map((r) => r.id), await desk('', '192.0.2.112'));
  assert.deepEqual(answer['listReports, corrections and status'].map((r) => r.id), await desk('&status=new', '192.0.2.113'));

  // The log projects the address and hides the id, so the published sentence is what the two
  // answers have in common.
  const log = await call('/log?limit=5');
  assert.deepEqual(answer.publicLog.map((r) => r.public_note), log.body.entries.map((e) => e.public_note));
  assert.ok(log.body.entries.length > 0, 'the log is empty, so the publicLog transcription proves nothing');

  const health = await call('/health');
  const bySite = (rows) => rows.map((r) => `${r.site}:${r.n ?? r.reports}`).sort();
  assert.deepEqual(bySite(answer.healthSites), bySite(health.body.sites));
  assert.ok(health.body.sites.length > 0, 'the per-site read-back is empty, so the healthSites transcription proves nothing');
});

test('the tenant fixture reaches no reader through any route this Worker serves', async () => {
  // Not a plan discriminator: the app_id term rejects these rows under EVERY plan, which is why
  // rows_read and not the answer is what the six cases above measure. It is asserted here all
  // the same, because tenant-scope.test.mjs runs over node:sqlite and this is workerd, and
  // because the fixture deliberately puts fixed, public, parla-site rows at the top of the
  // exact range the public log reads.
  const surfaces = [
    call('/log?limit=50'),
    call('/health'),
    call('/reports?limit=50', { token: TOKEN, ip: '192.0.2.120' }),
    call('/reports?status=fixed&limit=50', { token: TOKEN, ip: '192.0.2.120' }),
    call('/reports?kind=wrong&limit=50', { token: TOKEN, ip: '192.0.2.120' }),
    call('/reports?kind=open&limit=50', { token: TOKEN, ip: '192.0.2.120' }),
  ];
  for (const surface of surfaces) {
    const { body } = await surface;
    const text = JSON.stringify(body);
    assert.ok(!text.includes(TENANT_MARK), `a route answered with a tenant row: ${text.slice(0, 400)}`);
    assert.ok(!text.includes(TENANT), `a route answered with a tenant app id: ${text.slice(0, 400)}`);
  }
});

