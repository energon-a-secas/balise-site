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
  migrate, startWorker, stopWorker, requester, report, seedReports, seedOpenItems, seedPublished,
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
/** A second batch of corrections, seeded AFTER the open items, and the fixture's whole point is
 *  the ORDER. The desk's real shape is a one-off import and then a stream of reader reports, so
 *  the newest fleet rows are corrections and the open tab has rows of the other kind to step over.
 *  Without them the open-tab case below is vacuous: a page of `limit` starts at the newest row, so
 *  whichever kind is newest reads a page under any plan at all. That is why the regression these
 *  two batches detect went unnoticed for a campaign. */
const LATER_SEEDED = 20;
/** Every fleet correction in the table. The healthSites read-back counts these. */
const FLEET_CORRECTIONS = SEEDED + LATER_SEEDED;
/** Open items the desk ACCEPTED and did not publish: status 'accepted', `public` cleared, written
 *  through the shipped PATCH route. THE ONE SHAPE NEITHER FIXTURE IN THIS SUITE HAD, and the gap
 *  is why an index change that made GET /board read them all was recorded as cost-neutral by two
 *  test files and a migration comment. A board plan that SEEKS `public` never touches these rows;
 *  one that tests it per row pays for every one of them. The board law at the foot of this file
 *  is exact only because they are here, and it goes red by exactly this many if the seek is lost
 *  again. Twelve rather than one so the failure message is unambiguous about what it measures. */
const HIDDEN_ACCEPTED = 12;

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
  // The later corrections, filed one by one as a reader would, so they are the newest fleet rows.
  // Not seedReports() a second time: that would resend report(0..n) and the fingerprint would
  // dedupe every one of them. The address changes every eighth for the ratelimit binding, which
  // counts for real in local mode.
  for (let i = 0; i < LATER_SEEDED; i += 1) {
    const { res } = await call('/report', { method: 'POST', body: report(1000 + i), ip: `198.51.100.${40 + Math.floor(i / 8)}` });
    assert.equal(res.status, 200, `seeding later report ${i} failed with ${res.status}`);
  }
  // And one published resolution, because /log answers NOTHING without one and a budget
  // assertion over an empty answer is satisfied by any plan at all. That used to arrive as a
  // side effect of the C4 route tests this file was split away from, which is exactly the kind
  // of dependency a split turns into a silently vacuous test.
  await seedPublished(call, assert);
  // And the accepted items the desk chose NOT to publish, through the same route an operator
  // uses. See HIDDEN_ACCEPTED: these are what a board plan that tests `public` per row pays for
  // and a plan that seeks it does not, so without them the board's cost law is satisfied by both.
  const drafts = (await call('/reports?kind=open&status=new&limit=50', { token: TOKEN, ip: '192.0.2.108' })).body.reports
    // Not the three refs the import case below re-imports: hiding one would change what that
    // measurement is measuring.
    .filter((r) => !REIMPORT_REFS.includes(r.source_ref))
    .slice(0, HIDDEN_ACCEPTED);
  assert.equal(drafts.length, HIDDEN_ACCEPTED, `only ${drafts.length} open drafts were available to accept without publishing`);
  for (const draft of drafts) {
    const { res, body } = await call(`/reports/${draft.id}`, {
      method: 'PATCH',
      body: { status: 'accepted', public_note: 'An accepted item the desk has not published.', public: false },
      token: TOKEN, ip: '192.0.2.108',
    });
    assert.equal(res.status, 200, `accepting ${draft.id} unpublished failed: ${JSON.stringify(body)}`);
  }
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
// `0004_tenants.sql` adds tenant-first indexes and DROPS NOTHING, because Worker 1.1.0 is
// what a rollback goes back to and its queries are unscoped (DESIGN.md 6.1). The ones they
// supersede therefore stay, and the one real risk section 4.2 names is that the planner reaches
// for a kept one for a scoped query: same answer, several hundred times the `rows_read`, and
// `rows_read` is what production bills. (Six when this section was written, ten since
// `0005_indexes.sql`; the five cases below are about 0004's six, and the four after them about
// 0005's. The OPPOSITE risk, a scoped index chosen over a kept one that was the cheaper of the
// two, is what 0005 exists for and what those four cases are.)
//
// Each of the five cases below is that detector. `TENANT_ROWS` rows of a second tenancy sit above
// every fleet row, so a plan that does not lead on `app_id` must walk them; the assertion is an
// upper bound no such plan can meet. Every one of the five was taken red by dropping the six new
// indexes and green again by restoring them, and both numbers are in ./tenant-rows.mjs.
//
// reports_app_site_created has no such case and the test says so rather than pretending: see
// 'healthSites' at the foot of this file, and A21.
//
// FOUR MORE CASES came with `0005_indexes.sql`, and they detect the opposite failure: not a plan
// that lost the tenant term, but one that kept it and lost `kind`, `work_state` or `public`.
// Their own section says so, between the second case and the third.

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

test('reports_app_kind_created: listReports with kind=wrong uses the scoped index', async () => {
  // Index: reports_app_kind_created (app_id, kind, created_at DESC)
  // Falls back to: reports_open_created (kind, created_at DESC), measured, not reports_created
  //
  // THE CEILING CHANGED WITH THE INDEX, and the old comment here explained a number that no
  // longer holds. It read: the index does not carry `kind`, so the walk is over fleet rows in
  // created_at order with the kind term applied per row, and the open items are the only rows it
  // can reject, which makes OPEN_SEEDED + limit exact. That was true of reports_app_created. The
  // index this now takes carries `kind` as its second column, so the term is part of the seek and
  // a page reads a page. A plan led by `kind` instead of `app_id` still reads all TENANT_ROWS
  // first, which is what the second assertion holds.
  //
  // `limit` EXACTLY, and not rowsReadBudget(limit). The looser ceiling was written here for one
  // revision and it hid the regression it was named after: with reports_app_kind_created dropped
  // this page reads 1, 5 and 55 rows on this fixture, and 55 is under a budget of 60. Measured
  // 1, 5 and 25 with the index, by dropping it and restoring it on this suite's own database.
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?kind=wrong&limit=${limit}`, { token: TOKEN, ip: '192.0.2.100' });
    assert.equal(typeof body.rows_read, 'number', 'the worker did not report rows_read');
    assert.equal(body.reports.length, limit, `the corrections page returned ${body.reports.length} of ${limit} rows, so the ceiling below is met by a short page rather than by a seek`);
    assert.ok(
      body.rows_read <= limit,
      `kind=wrong page of ${limit} scanned ${body.rows_read} rows, and a page is ${limit}: without the kind term in the seek this reads 1, 5 and 55 on this fixture`,
    );
    assert.ok(
      body.rows_read < UNSCOPED_FLOOR,
      `kind=wrong page of ${limit} scanned ${body.rows_read}, which is at or above the ${UNSCOPED_FLOOR} tenant rows an unscoped plan has to walk: the planner took a kept index`,
    );
  }
});

test('reports_app_kind_status_created: listReports with kind+status uses the multi-column index', async () => {
  // Index: reports_app_kind_status_created (app_id, kind, status, created_at DESC)
  // Falls back to: reports_open_status_created (kind, status, created_at DESC), measured
  //
  // Same correction as the case above: this used to take reports_app_status_created, which
  // carries `status` but not `kind`, and its ceiling of OPEN_SEEDED + limit was the open items it
  // had to step over. Three of the four columns are now the seek, so a page reads a page.
  // A plan led by `kind` walks the tenant's TENANT_NEW rows with status 'new': measured 325.
  //
  // `limit` exactly here too, and here the slack would have to be only ONE row to hide the
  // regression: with reports_app_kind_status_created dropped this page falls onto the (app_id,
  // kind) seek and reads 2, 6 and 26 on this fixture, one row over the page every time. With all
  // four indexes gone it reads 1, 5 and 41. A ceiling of rowsReadBudget(limit) would have noticed
  // neither.
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?kind=wrong&status=new&limit=${limit}`, { token: TOKEN, ip: '192.0.2.101' });
    assert.equal(body.reports.length, limit, `the filtered corrections page returned ${body.reports.length} of ${limit} rows, so the ceiling below is met by a short page rather than by a seek`);
    assert.ok(
      body.rows_read <= limit,
      `kind+status page of ${limit} scanned ${body.rows_read} rows, and a page is ${limit}: without the kind term in the seek this reads 1, 5 and 41 on this fixture`,
    );
    assert.ok(
      body.rows_read < UNSCOPED_FLOOR,
      `kind+status page of ${limit} scanned ${body.rows_read}, at or above the ${UNSCOPED_FLOOR} tenant rows an unscoped plan has to walk`,
    );
  }
});

// ── The three reads 0004's six regressed, and the four indexes of 0005 that fix them ──────────
//
// All three were UNPINNED, and that is the whole story of how they regressed without a red test.
// The desk's open tab, the work queue's default page and the board's open list had no rows_read
// case anywhere in the suite that could tell a seek from a walk, so when 0004 handed the planner
// app_id-leading indexes to prefer and demoted `kind`, `work_state` and `public` to per-row
// tests, the only thing that changed was a number nothing looked at.
//
// Measured through the routes on THIS fixture, before 0005 against after, by dropping the four
// indexes on this suite's own database and restoring them, the same way the five cases above
// were measured:
//
//   GET /reports?kind=open&limit=1 / 5 / 25   21, 25, 45 rows read  ->  1, 5, 25
//   GET /work?limit=1 / 5 / 25                92, 92, 92            ->  3, 3, 3
//   GET /board?limit=50                             306             ->  306
//
// The first line is the later corrections plus the page against the page alone, which is the
// fixture's ordering doing its job. The second does not move with `limit` at all, because the old
// plan seeks (app_id=?) and walks the fleet's whole slice whatever the page size: that is why
// GET /work was over budget at a page of ONE on an EMPTY queue, which is how QA-3 found it.
//
// THE THIRD LINE IS THE ONE TO READ CAREFULLY, because it is unchanged and that is the point.
// /board never regressed against 0004; it regressed against the FIRST ATTEMPT at fixing the other
// two. With reports_app_kind_created, reports_app_kind_status_created and reports_app_work_updated
// created and reports_app_board NOT created, this fixture's /board reads 318. The middle column
// that matters for the board is therefore 318, not 306, and the case below pins it.
//
// WHAT /work's LINE IS A MEASUREMENT OF, said once here because the number is easy to over-read:
// a database with NO table statistics, which is what this suite builds and what a fresh desk is.
// On an ANALYZEd copy of the pre-0005 schema the four-state page already seeks
// reports_work_updated and does not walk the fleet (measured over node:sqlite, at 0 and at 400
// finished rows). 0005's own comment carries the full version. The index still earns its place on
// an analysed database, because it makes the plan the same either way and removes the temp b-tree
// from the single-state page, but "92 rows" is a fact about this fixture and not about every
// database the Worker will meet.

test('reports_app_kind_created: the desk\'s open tab reads a page, not the corrections above it', async () => {
  // Index: reports_app_kind_created (app_id, kind, created_at DESC)
  // Regressed onto: reports_app_created (app_id, created_at DESC), which has no kind term
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?kind=open&limit=${limit}`, { token: TOKEN, ip: '192.0.2.105' });
    assert.equal(typeof body.rows_read, 'number', 'the worker did not report rows_read');
    assert.ok(body.reports.length > 0, 'the open tab is empty, so this budget is met by every plan and measures nothing');
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `open page of ${limit} scanned ${body.rows_read} rows, budget ${rowsReadBudget(limit)}`,
    );
    // And the sharper one, which is what catches the regression at a page of 25, where the budget
    // of 60 does not: a plan without the kind term steps over the later corrections before it
    // reaches the first open item and reads 21, 25 and 45 at these three limits, measured on this
    // fixture by dropping this index alone, while the seek with the kind term in it reads the page
    // and nothing else. Measured exactly `limit`, and asserted exactly, because a slack of even
    // one row here is a slack nobody re-measured. The kind=wrong case above is the same assertion
    // for the other feed, and it was briefly loosened to rowsReadBudget: at limit 25 that is 60,
    // the regressed read is 55, and the loosened test passed with the index dropped.
    assert.ok(
      body.rows_read <= limit,
      `open page of ${limit} scanned ${body.rows_read} rows, and a page is ${limit}: the kind term has stopped being part of the seek`,
    );
  }
});

test('reports_app_kind_status_created: the open tab with a status filter reads a page too', async () => {
  // Index: reports_app_kind_status_created (app_id, kind, status, created_at DESC)
  // Regressed onto: reports_app_status_created, which carries status but not kind. The pair is
  // needed: with only the kind index this shape loses the STATUS term instead and reads 15, 19
  // and 31 at these three limits, measured on this fixture by dropping this index alone.
  //
  // THE PAGE IS SHORT AT limit=25 and the ceiling has to be read knowing it: the fixture accepts
  // HIDDEN_ACCEPTED of the imported drafts without publishing them, so 16 open items are left at
  // status 'new' and a page of 25 returns 16 and reads 17. The gap the assertion lives in is
  // therefore 17 against 31, not 25 against 31, and it is still wider than one row.
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/reports?kind=open&status=new&limit=${limit}`, { token: TOKEN, ip: '192.0.2.106' });
    assert.ok(body.reports.length > 0, 'the filtered open tab is empty, so this budget measures nothing');
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `open+status page of ${limit} scanned ${body.rows_read} rows, budget ${rowsReadBudget(limit)}`,
    );
    assert.ok(
      body.rows_read <= Math.min(limit, body.reports.length + 1),
      `open+status page of ${limit} scanned ${body.rows_read} rows for ${body.reports.length} reports: without this index the same three pages read 15, 19 and 31`,
    );
  }
});

test('reports_app_work_updated: GET /work costs a page and a tally, not the fleet, on an empty queue', async () => {
  // Index: reports_app_work_updated (app_id, work_state, work_updated_at DESC, id DESC)
  //          WHERE work_state IS NOT NULL
  // Regressed onto: reports_app_site_created on a bare (app_id=?) seek, with the four-element IN
  // list applied per row. The four states are what moves it; at a single state the read stayed on
  // 0003's reports_work_updated throughout.
  //
  // THE QUEUE IS EMPTY HERE and that is deliberate, not an oversight: an empty queue is the case
  // QA-3 reported, it makes the tally free, and it leaves the page cost alone in the number. What
  // this file cannot say is what the tally costs once a queue has history, because the tally has
  // no `limit` and no tenant term by invariant 4.3. tests/work.test.mjs measures the populated
  // case against a budget that carries the tally as its own term.
  const [[fleet], [queued]] = await d1(
    `SELECT count(*) AS n FROM reports WHERE app_id = 'fleet'`,
    'SELECT count(*) AS n FROM reports WHERE work_state IS NOT NULL',
  );
  assert.equal(queued.n, 0, `${queued.n} rows are in the work queue, so this case no longer measures the empty-queue cost`);
  for (const limit of [1, 5, 25]) {
    const { body } = await call(`/work?limit=${limit}`, { token: TOKEN, ip: '192.0.2.107' });
    assert.equal(typeof body.rows_read, 'number', 'GET /work does not report rows_read');
    assert.deepEqual(body.items, [], 'the queue is not empty, so the number below is not the empty-queue cost');
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `the work page of ${limit} scanned ${body.rows_read} rows on an empty queue, budget ${rowsReadBudget(limit)}`,
    );
    assert.ok(
      body.rows_read < fleet.n,
      `the work page of ${limit} scanned ${body.rows_read} of the fleet's ${fleet.n} rows: the seek has lost its work_state term and is walking the tenancy again`,
    );
  }
});

test('reports_app_board: the board seeks `public`, so the desk\'s unpublished drafts cost it nothing', async () => {
  // Index: reports_app_board (app_id, kind, public, status), the tenant twin of 0002's
  //        reports_board (kind, public, status)
  // Regressed onto: reports_app_kind_status_created (app_id, kind, status, created_at DESC),
  //        which seeks three of the four terms and TESTS `public` once per row
  //
  // NOT A REGRESSION AGAINST 0004. This is the one of the four that repairs damage done by the
  // other three: with them created and this one not, the board's open list leaves reports_board,
  // which seeks `public`, and its row set becomes the published entries PLUS every open item the
  // desk accepted and held back. The first attempt at the index fix shipped exactly that and both
  // this file and the migration recorded it as cost-neutral, because no fixture in the suite had
  // a single unpublished accepted item. HIDDEN_ACCEPTED is why there are twelve now.
  //
  // The law and its terms live with the prose that explains them, in the C2 section at the foot
  // of this file. This case asserts the same equality for one reason the C2 case does not state:
  // to fail under the NAME of the index whose absence causes it.
  const terms = await boardTerms();
  assert.ok(
    terms.H > 0,
    'the fixture holds no accepted-but-unpublished open item, so this case cannot tell a plan that seeks `public` from one that tests it per row',
  );
  const { body } = await call('/board?limit=50');
  assert.equal(
    body.rows_read, boardLaw(terms),
    `GET /board scanned ${body.rows_read} rows against the law's ${boardLaw(terms)}, with ${terms.H} accepted items unpublished. ${boardLaw(terms) + terms.H} is the number a plan that tests \`public\` per row pays, and reports_app_board is the index that stops it: measured 318 against 306 on this fixture with that index dropped and the other three present.`,
  );
  // And the drafts really are reachable through the route that made them, so this is a property
  // of rows an operator can create and not of a shape only a test can plant.
  const { body: drafts } = await call('/reports?kind=open&status=accepted&limit=50', { token: TOKEN, ip: '192.0.2.109' });
  assert.ok(
    drafts.reports.filter((r) => !r.public).length >= terms.H,
    'the desk cannot see the unpublished accepted items this case is about, so they were not made the way an operator makes them',
  );
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
  // reports_app_site_created, and the honest answer is that this file cannot build a discriminating
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
  assert.equal(parla.reports, FLEET_CORRECTIONS, `parla-site count is ${parla.reports}, expected ${FLEET_CORRECTIONS}`);
  assert.ok(!JSON.stringify(body.sites).includes(TENANT_MARK), 'the per-site read-back named a tenant site');
});

test('the tenant fixture reaches no reader through any route this Worker serves', async () => {
  // Not a plan discriminator: the app_id term rejects these rows under EVERY plan, which is why
  // rows_read and not the answer is what the cost cases above measure. It is asserted here all
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
//   Fp    fleet rows at kind='open', public=1, status='fixed': the published resolutions
//   H     fleet rows at kind='open', status='accepted' and public=0: accepted and NOT published.
//         IN NEITHER LAW, and that is the whole reason the fixture carries any. A plan that SEEKS
//         `public` never reads them; a plan that tests it per row reads every one. See below.
//   rank  where the newest FLEET entry's resolution sits within Ra in fixed_at DESC order. A
//         RANK AND NOT A COUNT: one tenant resolution newer than the fleet's costs this term 1
//         and three hundred of them cost it three hundred.
//
//   GET /board            rows_read = 2 x O + Ra + 2       identical at limit=5 and limit=50
//   GET /board/summary    rows_read = O + Fp + rank + 4    it has no limit at all
//
// Exact at all ten populations. The trailing constant is one per statement whose seek range is
// NOT empty, so a board with nothing published of some kind pays less: measured 7 rather than 8
// for /board at O=3 with Ra=0, and 6 rather than 7 for the summary at three published entries,
// no published resolution and rank=0. This fixture has every range non-empty, so the constants
// below are exact rather than a bound.
//
// AMENDED TWICE, and the second amendment is a correction of the first. The summary's first two
// terms used to be Af and Ff, fleet rows at a status WHATEVER their kind, because the counts
// query seeked (app_id, status) alone. 0005 gives both board reads a four-term seek on
// (app_id, kind, public, status), so the fleet's corrections and the desk's unpublished drafts
// are no longer read by either, and both laws are now written in the PUBLISHED populations only.
// Measured on this fixture, which holds H=12: /board 306 and /board/summary 307. The amended
// summary law was checked on a SECOND population besides this one, built the same way through
// the routes with no tenant rows at all and forty unpublished accepted items: O=1, Fp=1, rank=1,
// law 7, measured 7. Ten populations stand behind the rest of this section; two behind the two
// terms that moved, which is worth saying rather than letting the older sentence cover both.
//
// WHAT THE FIRST ATTEMPT SAID HERE, kept because the mistake is the lesson. It said "/board is
// untouched, measured 306 on this fixture with the three indexes and 306 without them". That was
// a true measurement of a fixture that held no unpublished accepted item, stated in the voice of
// a law about the route. With reports_app_board absent and the other three present, this fixture
// now measures /board at 318 and /board/summary at 319, which is each law plus H, because the
// open list falls onto reports_app_kind_status_created and tests `public` once per row. Neither
// route was the point of that fix and neither was authorised to be changed; this is what the fix
// did to them and what 0005 does about it, measured both ways.
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
// not. No index in 0004_tenants.sql covers this, and neither does 0005. The scoped twin for the
// log, reports_app_fix_public_log, is partial on `kind <> 'open'` and both board queries carry
// `kind = 'open'`, so it is not a candidate for either of them. reports_app_board is not one
// either, although it is the nearest thing yet: measured with the four indexes created and
// dropped on this fixture, the resolved list and the summary's latest keep their
// (status=? AND public=?) seek on reports_public_log in every configuration, because that index
// ends on fixed_at and answers the sort without a b-tree. So Ra and rank are untouched by this
// campaign. Still the owner's call, and still not this pass's to fix.

/** What harness.seedPublished leaves behind, which is the whole published population of this
 *  fixture: one open item at accepted, and two rows at fixed (a correction and an open item).
 *  Asserted from the routes below rather than trusted, because the ceilings are formulas in it. */
const PUBLISHED_OPEN = 1;
const PUBLISHED_FIXED = 2;

/** The five terms of the two laws above, READ BACK FROM THE DATABASE, one statement each, in the
 *  wording of the definitions at the head of this section. Writing them as constants is what let
 *  the pass-0 formula and the pass-0 prose disagree while both matched one fixture (A39 finding
 *  F2). One helper rather than one copy per test, so a re-measurement cannot land in one of them.
 *
 *  `tied` is not a term: it is how many published resolutions share the fixed_at that rank's walk
 *  stops on, which is what makes rank exact rather than exact-to-within-a-tie. */
const boardTerms = async () => {
  const [[o], [ra], [fp], [h], [rk], [tie]] = await d1(
    `SELECT count(*) AS n FROM reports WHERE app_id = 'fleet' AND kind = 'open' AND public = 1 AND status = 'accepted'`,
    `SELECT count(*) AS n FROM reports WHERE status = 'fixed' AND public = 1`,
    `SELECT count(*) AS n FROM reports WHERE app_id = 'fleet' AND kind = 'open' AND public = 1 AND status = 'fixed'`,
    `SELECT count(*) AS n FROM reports WHERE app_id = 'fleet' AND kind = 'open' AND public = 0 AND status = 'accepted'`,
    `SELECT count(*) AS n FROM reports WHERE status = 'fixed' AND public = 1 AND fixed_at >= (SELECT max(fixed_at) FROM reports WHERE app_id = 'fleet' AND kind = 'open' AND public = 1 AND status = 'fixed')`,
    `SELECT count(*) AS n FROM reports WHERE status = 'fixed' AND public = 1 AND fixed_at = (SELECT max(fixed_at) FROM reports WHERE app_id = 'fleet' AND kind = 'open' AND public = 1 AND status = 'fixed')`,
  );
  return { O: o.n, Ra: ra.n, Fp: fp.n, H: h.n, rank: rk.n, tied: tie.n };
};

/** GET /board's measured cost, in the published populations only. H is deliberately absent: the
 *  index test above and the law test below are both assertions that it is absent from the ROUTE
 *  too, and they fail by exactly H when the open list stops seeking `public`. */
const boardLaw = ({ O, Ra }) => 2 * O + Ra + 2;

test('C2: the board fixture holds the published population the two laws below are written in', async () => {
  const { body } = await call('/board/summary');
  assert.equal(body.open, PUBLISHED_OPEN, `the summary counts ${body.open} open entries, not ${PUBLISHED_OPEN}: re-measure the two laws before touching them`);
  assert.equal(body.resolved, PUBLISHED_FIXED - 1, 'the summary counts a resolution this fixture did not publish');
  assert.equal(body.in_progress, 0, 'the work queue reached this fixture, so the board laws are measuring something else');
});

test('C2: GET /board scans the same rows at limit=5 as at limit=50, so no budget keyed on limit bounds it', async () => {
  // The direct refutation of C2's premise, and the cheapest thing in this file to keep true.
  // The open half sorts on opened_at and no index that can serve it carries that column at all,
  // so SQLite fills a temp b-tree from every matching entry BEFORE the LIMIT applies. Read it as:
  // the page size a caller asks for does not change what the database does. True of reports_board
  // and of 0005's reports_app_board alike; the b-tree is about the sort column, not the index.
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
  const { O, Ra, Fp, H, rank, tied } = await boardTerms();

  // The law's terms have to be non-degenerate or it is satisfied by arithmetic rather than by a
  // plan. rank is a position in a fixed_at DESC walk, so a TIE at the row the walk stops on makes
  // it exact only up to the size of the tie: this fixture has none, and if it grows one the right
  // answer is to give the tenant rows distinct fixed_at values, not to widen the assertion.
  assert.ok(O > 0 && Ra > 0 && Fp > 0, `a term of the law is zero (O=${O} Ra=${Ra} Fp=${Fp}), so the constants below are not the ones this fixture pays`);
  // H IS THE ONE TERM THAT MUST BE NON-ZERO WITHOUT APPEARING IN EITHER LAW. Both laws are
  // written in the published populations, so a fixture where every accepted entry is published
  // pays the same number whether the plan seeks `public` or tests it per row, and both equalities
  // below go on passing while the board reads the desk's private drafts. That is exactly what
  // happened: two fixtures with H=0 and a migration comment that called the change cost-neutral.
  assert.ok(
    H >= HIDDEN_ACCEPTED,
    `the fixture holds ${H} accepted-but-unpublished open items and should hold at least ${HIDDEN_ACCEPTED}: with none, the two laws below cannot tell a plan that seeks 'public' from one that tests it`,
  );
  assert.equal(rank, TENANT_FIXED + PUBLISHED_FIXED - 1, `the newest fleet resolution sits at rank ${rank} of the ${Ra} published resolutions, not under all ${TENANT_FIXED} tenant ones: the fixture has moved and the two laws want re-measuring`);
  assert.equal(tied, 1, `${tied} published resolutions share the fixed_at the summary's walk stops on, so rank is exact only to within that tie`);

  const board = await call('/board?limit=50');
  const summary = await call('/board/summary');

  const law = boardLaw({ O, Ra });
  assert.equal(
    board.body.rows_read, law,
    `GET /board scanned ${board.body.rows_read}, and the law 2xO + Ra + 2 with O=${O} and Ra=${Ra} says ${law}. If it scanned ${law + H}, that is the law plus the ${H} accepted items this fixture never published, and the open list has stopped SEEKING 'public': it is on an index that tests it per row, and the cost grows with every draft the desk holds back. Otherwise the plan moved or the fixture did; re-measure before adjusting the number.`,
  );
  // Ra and rank are the UNSCOPED terms: if a scoped index ever serves these two reads, both
  // numbers drop by about TENANT_FIXED and both assertions go red with the arithmetic in the
  // message. That is the intended red, not a regression.
  const summaryLaw = O + Fp + rank + 4;
  assert.equal(
    summary.body.rows_read, summaryLaw,
    `GET /board/summary scanned ${summary.body.rows_read}, and the law O + Fp + rank + 4 with O=${O}, Fp=${Fp} and rank=${rank} says ${summaryLaw}. ${summaryLaw + H} means the same thing it means for /board above: the counts query lost the 'public' seek and is reading the ${H} unpublished ones. rank is a POSITION in the published resolutions ordered by fixed_at DESC, not a count of them: read the section head above before adjusting anything.`,
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
//
// STILL NOT FIXED, and deliberately. The four indexes of 0005_indexes.sql did not touch this:
// measured before and after, the dedupe read keeps its bare (app_id=?) seek and POST /open-items
// scans the same rows, because not one of the four carries `fingerprint`. WHICH index answers
// that seek did change, and it is a tie among equals rather than a cost: the plans file's
// APP_LEADING list says so and this assertion is an equality on the row count, which is the thing
// that did not move. What this read wants is (app_id, fingerprint), which is one of the findings
// the owner has not authorised, so the number below goes on standing as the record of it.

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
  const FLEET_ROWS = FLEET_CORRECTIONS + OPEN_SEEDED;

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
