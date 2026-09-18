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
import { plantTenant, d1For, PLANTED_AT, TENANT_ROWS, TENANT_FIXED, UNSCOPED_FLOOR } from './tenant-rows.mjs';
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
    call('/board?limit=50'),
    call('/board/summary'),
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

// ── Phase 2 pass 0b: what the two board reads cost, and what that number grows with ───────────
//
// Review condition C2 asked for warnRowsRead on GET /board and GET /board/summary, on the reading
// that /board has a `limit` so rowsReadBudget applies to it. It does not, and these tests are why
// the call was not made. src/routes-open.js carries the argument; this is the measurement.
//
// FOUR POPULATIONS MOVE THESE NUMBERS, NOT TWO. Pass 0 fitted `2 x O + R + 2` and `O + 2 x R + 3`
// to four populations that only ever moved O and R together, and the second is not a law: A39
// held O and R fixed, added seven rows that are neither, and moved the summary from 14 to 21 while
// that formula predicted 15 at all three. This file asserted a THIRD formula at the time, so the
// source's prose and this assertion disagreed and the suite was green anyway. Re-measured
// 2026-09-18 at ten populations, each term moved on its own through the real PATCH route:
//
//   O     fleet rows at kind='open', public=1, status='accepted': the published entries
//   Ra    every row at status='fixed' AND public=1, ANY tenant, either kind
//   Af    fleet rows at status='accepted', WHATEVER their kind and visibility
//   Ff    fleet rows at status='fixed', WHATEVER their kind and visibility
//   rank  where the newest FLEET entry's resolution sits within Ra in fixed_at DESC order. A
//         RANK AND NOT A COUNT: one tenant resolution newer than the fleet's costs this term 1
//         and three hundred of them cost it three hundred.
//
//   GET /board            rows_read = 2 x O + Ra + 2       identical at limit=5 and limit=50
//   GET /board/summary    rows_read = Af + Ff + rank + 4   it has no limit at all
//
// Exact at all ten. The trailing constant is one per statement whose seek range is NOT empty, so
// a board with nothing published of some kind pays less: measured 7 rather than 8 for /board at
// O=3 with Ra=0, and 6 rather than 7 for the summary at Af=3, Ff=0, rank=0. This fixture has
// every range non-empty, so the constants below are exact rather than a bound.
//
// EVERY TERM IS MEASURED FROM THE DATABASE BELOW rather than written as a constant, and that is
// the difference between a law and a curve fitted to one fixture: these assertions survive the
// fixture growing and go red when the cost of a ROW moves, which is the only thing a plan
// regression can do here. Neither number is a function of `limit`, and every term grows without
// bound as the board is used: at this fixture's two published resolutions /board crosses
// rowsReadBudget(50) = 110 at O = 54. So a constant threshold is either a warning an operator
// meets in normal service and deletes, or one that detects nothing.
//
// THE Ra AND rank TERMS ARE NOT SCOPED, and that is the finding rather than a detail. Both of
// those walks seek on (status, public) through reports_public_log, which leads on neither app_id
// nor kind, so they include the fixture's TENANT_FIXED fixed-and-public rows and reject them one
// at a time. The summary's cost therefore depends on how many resolutions ANOTHER TENANT has
// published since the fleet's newest one, which is why rank is the honest term and a count is
// not. The six indexes of 0004_tenants.sql do not cover this: the scoped twin for the log,
// reports_app_fix_public_log, is partial on `kind <> 'open'` and both board queries carry
// `kind = 'open'`, so it is not a candidate for either of them. Reported to delivery-lead for
// data-engineer; constraint 3 of this pass forbids adding the index here.

/** What harness.seedPublished leaves behind, which is the whole published population of this
 *  fixture: one open item at accepted, and two rows at fixed (a correction and an open item).
 *  Asserted from the routes below rather than trusted, because the ceilings are formulas in it. */
const PUBLISHED_OPEN = 1;
const PUBLISHED_FIXED = 2;

test('C2: the board fixture holds the published population the two laws below are written in', async () => {
  const { body } = await call('/board/summary');
  assert.equal(body.open, PUBLISHED_OPEN, `the summary counts ${body.open} open entries, not ${PUBLISHED_OPEN}: re-measure the two laws before touching them`);
  assert.equal(body.resolved, PUBLISHED_FIXED - 1, 'the summary counts a resolution this fixture did not publish');
  assert.equal(body.in_progress, 0, 'the work queue reached this fixture, so the board laws are measuring something else');
});

test('C2: GET /board scans the same rows at limit=5 as at limit=50, so no budget keyed on limit bounds it', async () => {
  // The direct refutation of C2's premise, and the cheapest thing in this file to keep true.
  // The open half sorts on opened_at while reports_board ends in created_at, so SQLite fills a
  // temp b-tree from every matching entry BEFORE the LIMIT applies. Read it as: the page size a
  // caller asks for does not change what the database does.
  const five = await call('/board?limit=5');
  const fifty = await call('/board?limit=50');
  assert.equal(five.res.status, 200);
  assert.equal(fifty.res.status, 200);
  assert.equal(
    five.body.rows_read, fifty.body.rows_read,
    `a page of 5 scanned ${five.body.rows_read} and a page of 50 scanned ${fifty.body.rows_read}: /board has become bounded by its limit, which would mean the open list stopped needing a temp b-tree. Good news, and it makes rowsReadBudget applicable for the first time.`,
  );
});

test('C2: both board reads cost exactly what the measured law says, per row and not per page', async () => {
  // Equality, not a ceiling. A ceiling on a number that grows with the board is a ceiling that
  // eventually fires for no reason; equality on the law fires when the COST OF A ROW changes,
  // which is the only thing a plan regression can do here.
  //
  // The five terms are READ BACK FROM THE DATABASE, one statement each, in the wording of the
  // definitions at the head of this section. Writing them as constants is what let the pass-0
  // formula and the pass-0 prose disagree while both matched one fixture (A39 finding F2).
  const [[o], [ra], [af], [ff], [rk], [tied]] = await d1(
    `SELECT count(*) AS n FROM reports WHERE app_id = 'fleet' AND kind = 'open' AND public = 1 AND status = 'accepted'`,
    `SELECT count(*) AS n FROM reports WHERE status = 'fixed' AND public = 1`,
    `SELECT count(*) AS n FROM reports WHERE app_id = 'fleet' AND status = 'accepted'`,
    `SELECT count(*) AS n FROM reports WHERE app_id = 'fleet' AND status = 'fixed'`,
    `SELECT count(*) AS n FROM reports WHERE status = 'fixed' AND public = 1 AND fixed_at >= (SELECT max(fixed_at) FROM reports WHERE app_id = 'fleet' AND kind = 'open' AND public = 1 AND status = 'fixed')`,
    `SELECT count(*) AS n FROM reports WHERE status = 'fixed' AND public = 1 AND fixed_at = (SELECT max(fixed_at) FROM reports WHERE app_id = 'fleet' AND kind = 'open' AND public = 1 AND status = 'fixed')`,
  );
  const [O, Ra, Af, Ff, rank] = [o.n, ra.n, af.n, ff.n, rk.n];

  // The law's terms have to be non-degenerate or it is satisfied by arithmetic rather than by a
  // plan. rank is a position in a fixed_at DESC walk, so a TIE at the row the walk stops on makes
  // it exact only up to the size of the tie: this fixture has none, and if it grows one the right
  // answer is to give the tenant rows distinct fixed_at values, not to widen the assertion.
  assert.ok(O > 0 && Ra > 0 && Af > 0 && Ff > 0, `a term of the law is zero (O=${O} Ra=${Ra} Af=${Af} Ff=${Ff}), so the constants below are not the ones this fixture pays`);
  assert.equal(rank, TENANT_FIXED + PUBLISHED_FIXED - 1, `the newest fleet resolution sits at rank ${rank} of the ${Ra} published resolutions, not under all ${TENANT_FIXED} tenant ones: the fixture has moved and the two laws want re-measuring`);
  assert.equal(tied.n, 1, `${tied.n} published resolutions share the fixed_at the summary's walk stops on, so rank is exact only to within that tie`);

  const board = await call('/board?limit=50');
  const summary = await call('/board/summary');

  const boardLaw = 2 * O + Ra + 2;
  assert.equal(
    board.body.rows_read, boardLaw,
    `GET /board scanned ${board.body.rows_read}, and the law 2xO + Ra + 2 with O=${O} and Ra=${Ra} says ${boardLaw}. Either the plan moved or the fixture did; re-measure before adjusting the number.`,
  );
  // Ra and rank are the UNSCOPED terms: if a scoped index ever serves these two reads, both
  // numbers drop by about TENANT_FIXED and both assertions go red with the arithmetic in the
  // message. That is the intended red, not a regression.
  const summaryLaw = Af + Ff + rank + 4;
  assert.equal(
    summary.body.rows_read, summaryLaw,
    `GET /board/summary scanned ${summary.body.rows_read}, and the law Af + Ff + rank + 4 with Af=${Af}, Ff=${Ff} and rank=${rank} says ${summaryLaw}. rank is a POSITION in the published resolutions ordered by fixed_at DESC, not a count of them: read the section head above before adjusting anything.`,
  );

  // And the number these two routes report is above the floor the five cases above are built
  // around, which is what makes this a finding rather than a note. Asserted as a comparison so
  // the message carries both numbers when it changes in either direction.
  assert.ok(
    board.body.rows_read > UNSCOPED_FLOOR,
    `GET /board scanned ${board.body.rows_read}, at or under the ${UNSCOPED_FLOOR} row floor: an index now covers the resolved list, so this test and the two laws above need re-measuring and this assertion should be inverted.`,
  );
});

test('C2: the board answers 200 with its full cache policy while it is reading 300 rows', async () => {
  // The other half of C2: whatever is done about cost, it may not touch the answer. These two
  // routes are cached for five minutes and answer any origin (A8), so a header lost here is a
  // fleet-wide breakage that no other assertion in this file would see.
  for (const path of ['/board?limit=50', '/board/summary']) {
    const { res } = await call(path);
    assert.equal(res.status, 200, `${path} did not answer 200`);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300', `${path} lost its cache policy`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', `${path} stopped answering any origin`);
  }
});

// ── Phase 2 pass 0: what an import batch costs, and what that number grows with ────────────────
//
// POST /open-items was the last read in this Worker with no rows_read on it, which is why
// upsertOpenItems now returns one. A36 finding A is why it matters here rather than only in the
// plans file: the dedupe read is the one statement whose cost is NOT the size of what the caller
// sent. Measured with make d1-query at IN-list sizes 1, 2, 3 and 50, and pinned by seek shape in
// tests/local-d1-plans.test.mjs: at one or two items it seeks the UNIQUE reports_fp on
// (fingerprint), and at THREE it switches to seeking (app_id) alone and testing the fingerprint
// per row. Real batches are 25.
//
// So the two assertions below are one fact in two halves: a batch of one costs one row, and a batch
// of three costs the whole of the fleet's half of the table. That is the regression made visible.
// It is not fixed here: the fix is an index and an index is not this file's to add.

/** Three refs `seedOpenItems` already imported and `openBatch` did NOT mark closed at its source
 *  (every fourth one is), so re-importing them with no closed_at writes nothing at all: three
 *  unchanged items, no INSERT, no UPDATE, and the only statement that runs is the dedupe read. */
const REIMPORT_REFS = ['#901', '#902', '#903'];

const reimport = async (refs) => {
  const items = refs.map((ref) => ({ ref, text: `Seeded tracker line for ${ref}: re-imported to measure the dedupe read`, opened_at: Date.UTC(2026, 7, 1), closed_at: null }));
  const { res, body } = await call('/open-items', { method: 'POST', body: { v: 1, source: 'queue', items }, token: AI_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.created, 0, `a ref this test reuses was not already imported: ${JSON.stringify(body)}`);
  assert.equal(body.unchanged, refs.length, `the re-import wrote something: ${JSON.stringify(body)}`);
  assert.equal(body.closed + body.reopened, 0, 'the measurement changed the fixture');
  assert.equal(typeof body.rows_read, 'number', 'POST /open-items does not report rows_read');
  return body.rows_read;
};

test('A36 finding A: an import of three items scans the fleet, and an import of one scans one row', async () => {
  const one = await reimport(REIMPORT_REFS.slice(0, 1));
  const three = await reimport(REIMPORT_REFS);
  const FLEET_ROWS = SEEDED + OPEN_SEEDED;

  assert.ok(one <= 2, `a one-item batch scanned ${one} rows, so it is no longer taking the UNIQUE reports_fp`);
  assert.equal(
    three, FLEET_ROWS,
    `a three-item batch scanned ${three} rows and the fleet has ${FLEET_ROWS}: the dedupe read is meant to walk all of them under the (app_id=?) seek pinned in tests/local-d1-plans.test.mjs. A LOWER number is good news and means an index now serves the fingerprint term, at which point re-measure this file and that pin together.`,
  );
  assert.ok(
    three > one * 3,
    `three items cost ${three} and one cost ${one}, so the cost is now proportional to the batch and the finding has been fixed`,
  );
  // And the walk is the FLEET's rows and not the table's: the tenant literal in the dedupe read is
  // what keeps 600 planted rows out of a number the importer pays for on every run.
  assert.ok(
    three < TENANT_ROWS,
    `a three-item batch scanned ${three} rows of a table holding ${TENANT_ROWS} tenant rows besides: the dedupe read has lost its app_id term`,
  );
});
