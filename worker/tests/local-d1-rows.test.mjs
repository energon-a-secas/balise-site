// How MUCH the database reads: the A4 budgets, keyset paging, and the five index-selection
// cases that make tenancy cost nothing.
//
// One of the three files tests/local-d1.test.mjs was split into (A31): that file had reached 858
// lines against a 500-line ceiling and was three concerns by then. Its sibling
// tests/local-d1-plans.test.mjs asserts HOW the database answers, by pinning each plan's index
// name; tests/local-d1.test.mjs keeps the routes and the contract envelopes. This file is the
// one that reads `result.meta.rows_read`.
//
// WHY IT HAS TO RUN THE WORKER UNDER WORKERD. `rows_read` is a D1 number and node cannot fake
// it. It counts rows SCANNED, not rows returned, which makes it the one measurement that tells a
// query using an index apart from a query scanning the table: both give the same answer, one of
// them exhausts the daily quota in production. Local D1 enforces NO quota, so nothing here is
// slow and nothing here fails on its own. These assertions are the only thing that would notice.
//
// WHAT IT CANNOT PROVE. Every D1 limit and quota. Local D1 is the same workerd binary over a
// real SQLite file, so SQL behaviour reproduces and no limit does
// (cloudflare/workers-sdk#6347). rows_read is measured here and BILLED only in production.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  WORKER_DIR, TOKEN, AI_TOKEN, SALT, TURNSTILE_PASS,
  migrate, startWorker, stopWorker, requester, seedReports, seedOpenItems, seedPublished,
} from './harness.mjs';
// The tenant fixture, the floor an unscoped plan cannot get under, and the one-statement query
// helper, all in ./tenant-rows.mjs. Read its header before changing any ceiling below: the
// measured pairs that make these cases discriminate are recorded there.
import { plantTenant, d1For, PLANTED_AT, TENANT_ROWS, UNSCOPED_FLOOR } from './tenant-rows.mjs';
import { TENANT, TENANT_MARK } from './tenant-fixture.mjs';
import { rowsReadBudget } from '../src/store.js';

const STATE = join(WORKER_DIR, '.wrangler/rows-state');
const PORT = 8884;
const BASE = `http://127.0.0.1:${PORT}`;
const call = requester(BASE);
const d1 = d1For(STATE);

// Both counts appear in the ceilings below and in the numbers measured against them, so they are
// the fixture as much as the tenant rows are. Changing either means re-measuring.
const SEEDED = 40;
/** Imported open items, seeded in `before` so that every corrections assertion in this file also
 *  states that the two feeds do not see each other. */
const OPEN_SEEDED = 30;

let worker = null;

before(async () => {
  // A fresh database every run. The budgets below only mean something against a known number
  // of rows.
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

  // Both feeds, through the real routes rather than by inserting rows, so the fixtures are
  // produced by the code under test.
  await seedReports(call, SEEDED, assert);
  await seedOpenItems(call, OPEN_SEEDED, assert);
  // And one published resolution, because /log answers NOTHING without one and a budget
  // assertion over an empty answer is satisfied by any plan at all. That used to arrive as a
  // side effect of the C4 route tests this file was split away from, which is exactly the kind
  // of dependency a split turns into a silently vacuous test.
  await seedPublished(call, assert);
}, { timeout: 300_000 });

after(async () => {
  await stopWorker(worker);
});

// ── A4: the rows_read budget ──────────────────────────────────────────────────
//
// Measured on 2026-08-29: every keyset page read exactly `limit` rows. Dropping
// reports_created and reports_status_created and repeating the same requests read 208 rows for a
// page of 5, so the gap these assertions sit in is wide, not marginal.

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
    assert.ok(body.entries.length > 0, 'the log is empty, so this budget is met by every plan and measures nothing');
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

// ── Phase 1: index selection, and the six kept indexes ────────────────────────
//
// `0004_tenants.sql` adds six tenant-first indexes and DROPS NOTHING, because Worker 1.1.0 is
// what a rollback goes back to and its queries are unscoped (DESIGN.md 6.1). The six they
// supersede therefore stay, and the one real risk section 4.2 names is that the planner reaches
// for a kept one for a scoped query: same answer, several hundred times the `rows_read`, and
// `rows_read` is what production bills.
//
// Each of the five cases below is that detector. `TENANT_ROWS` rows of a second tenancy sit above
// every fleet row, so a plan that does not lead on `app_id` must walk them; the assertion is an
// upper bound no such plan can meet. Every one of the five was taken red by dropping the six new
// indexes and green again by restoring them, and both numbers are in ./tenant-rows.mjs.
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
  assert.equal(tenant.floor, PLANTED_AT, 'the fixture did not land where ./tenant-rows.mjs says it does');
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
    assert.ok(body.entries.length > 0, 'the log is empty, so this case is met by every plan and measures nothing');
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
  //    which point this is the index that should win. So the plan pinned in
  //    tests/local-d1-plans.test.mjs is what the planner does, not what the design wanted. Do
  //    not "fix" it to name the other index.
  // 2. /health exposes no rows_read at all, so there is no number to bound. What separates the
  //    two plans here is visible only in EXPLAIN QUERY PLAN, and that is where it is asserted:
  //    scoped it is a SEARCH over the 42 fleet corrections in the window, and with the six new
  //    indexes dropped it becomes `SCAN reports USING INDEX reports_site_created`, a full pass
  //    over all 672 rows in the table. That pair is in the plan file, and it is the detector:
  //    42 rows visited against 672, both measured.
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
