// The Worker's query plans on a database that HAS planner statistics, next to the plans on one
// that has none, over node:sqlite (queue #139, items 1 to 4 and 6).
//
// WHY THIS FILE EXISTS. tests/local-d1-plans.test.mjs and tests/work.test.mjs pin every plan the
// Worker depends on, and every one of those pins is the STRUCTURAL plan: a migration run by those
// suites runs against an empty table, so the PRAGMA optimize at the foot of 0004 and 0005 gathers
// nothing. The databases the Worker meets are not like that. A desk that migrates a populated
// table, and production on release day, both get statistics from that same pragma, and then plan
// by them. Nothing measured those plans until this file. tests/plan-fixture.mjs builds the same
// rows three ways (no statistics, statistics of the rows themselves, and the statistics a release
// leaves behind) and captures the store's own statements, so nothing here is a transcription.
//
// WHAT IT FOUND, measured 2026-11-03 over node:sqlite 3.51.1. Read the pins for the detail.
//
//   1. The release regime is the one to worry about. A release applies 0002 to 0005 to a table
//      holding production's 1.0.0 rows, so the statistics describe a small table of fleet
//      corrections with an empty work queue, and nothing ever gathers them again. On those
//      statistics the import's dedupe read and the sync's chunked close become a SCAN of the
//      whole table, every tenant's rows included, on every batch: the IN list is longer than the
//      table the planner believes in. Below a handful of rows at release (the sweep below) the
//      board's open list, the summary's counts, the sync's read of a source's open items, the
//      claim's pick and even GET /work/:id's lookup by primary key scan too.
//   2. The claim's answer, readDetail by run, is NOT the fleet's slice on any database with
//      statistics: it takes the partial reports_work_run and reads one row, in both regimes that
//      have them. The fleet-slice cost item 1 of #139 describes is real on an unanalysed
//      database, which is what tests/work.test.mjs pins, and only there.
//   3. listWork's second page seeks reports_app_work_updated on (app_id, work_state,
//      work_updated_at) in all three regimes. #139 item 2 says an analysed database takes the
//      unscoped reports_work_updated and drops the app_id term. That was NOT reproduced: the
//      fixture below, 54 shapes of a fixture like it (fleet size, queue size and tenant size
//      varied, all analysed) and the release model at 12 row counts from 1 to 200 all kept the
//      scoped index.
//   4. The claim pick does become a MULTI-INDEX OR once the rows are analysed, as #139 item 3
//      predicted, and a cheaper plan than the structural one. Under release statistics it stays
//      structural.
//   5. boardSummary's latest and the board's resolved list stay on the unscoped
//      reports_public_log in all three regimes on this fixture, and that is a cost: the tenant's
//      published fixes are newer than the fleet's, so the walk to the first fleet row reads
//      every one of them (#139 item 6). On a shape with a busy board (2000 open items),
//      analysed, latest moves to reports_app_board and a sort (#139 item 4), and whether that is
//      cheaper depends on where the tenant's rows sit in time, which no statistic records. The
//      last test shows both.
//   6. Two statements the item did not name move under statistics: healthSites takes the unscoped
//      reports_site_created by skip-scan once analysed, reading every tenant's rows in the
//      window, and listReports' corrections-by-status page leaves the partial index for
//      reports_app_status_created and steps over the open items of that status.
//
// WHAT IS NOT CLAIMED. These are node:sqlite plans. D1 runs a SQLite of its own version, and no
// test here or anywhere has measured a plan on an analysed D1. The structural column agrees with
// the two workerd suites line for line, which says the planners agree on what they both see; it
// says nothing about statistics D1 might weigh differently. The row counts are the rows a plan's
// index range spans on this fixture, derived from the plan, because node:sqlite reports no
// rows_read: an upper bound on what the plan reads, not a meter reading. Nothing in this file is
// an argument for an index. Which indexes 0006 should carry, if any, is the owner's call (#139).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REGIMES, SHAPE, RELEASE_ROWS, buildFixture, captureStatements, planOf, statRows,
} from './plan-fixture.mjs';

/** The two work_runs lines every work read ends with: its run, and the newest review note. */
const JOINED = ' | SEARCH w USING INDEX sqlite_autoindex_work_runs_1 (id=?) LEFT-JOIN'
  + ' | CORRELATED SCALAR SUBQUERY 1 | SEARCH n USING INDEX work_runs_report (report_id=?)';
const PICK_SUBQUERY = 'SEARCH reports USING INDEX sqlite_autoindex_reports_1 (id=?) | SCALAR SUBQUERY 1 | ';

// A string is the plan in all three regimes; an object names each. Measured, not intended: where
// a pin and a design document disagree, the document is what is wrong.
const PLANS = {
  'listReports, kind given': 'SEARCH reports USING INDEX reports_app_kind_created (app_id=? AND kind=? AND created_at<?)',
  'listReports, kind and status': 'SEARCH reports USING INDEX reports_app_kind_status_created (app_id=? AND kind=? AND status=? AND created_at<?)',
  'listReports, kind=open': 'SEARCH reports USING INDEX reports_app_kind_created (app_id=? AND kind=? AND created_at<?)',
  'listReports, kind=open and status': 'SEARCH reports USING INDEX reports_app_kind_status_created (app_id=? AND kind=? AND status=? AND created_at<?)',
  'listReports, corrections': 'SEARCH reports USING INDEX reports_app_fix_created (app_id=? AND created_at<?)',
  // Finding 6. Same seek terms, but the analysed plan is not the partial index, so it steps over
  // every fleet open item of the status asked for, testing `kind <> 'open'` per row.
  'listReports, corrections and status': {
    structural: 'SEARCH reports USING INDEX reports_app_fix_status_created (app_id=? AND status=? AND created_at<?)',
    analysed: 'SEARCH reports USING INDEX reports_app_status_created (app_id=? AND status=? AND created_at<?)',
    release: 'SEARCH reports USING INDEX reports_app_fix_status_created (app_id=? AND status=? AND created_at<?)',
  },
  publicLog: 'SEARCH reports USING INDEX reports_app_fix_public_log (app_id=? AND status=? AND public=? AND fixed_at<?)',
  // Finding 6. ANY(site) is a skip-scan of an index with no tenant column.
  healthSites: {
    structural: 'SEARCH reports USING INDEX reports_app_fix_created (app_id=? AND created_at>?) | USE TEMP B-TREE FOR GROUP BY | USE TEMP B-TREE FOR ORDER BY',
    analysed: 'SEARCH reports USING INDEX reports_site_created (ANY(site) AND created_at>?) | USE TEMP B-TREE FOR ORDER BY',
    release: 'SEARCH reports USING INDEX {app_id-leading} (app_id=?) | USE TEMP B-TREE FOR ORDER BY',
  },

  // Finding 5, and #139 item 6's first two findings, with statistics: the resolved list and the
  // summary's latest keep their unscoped seek, and the open list keeps the temp b-tree that
  // reports_board's trailing `status` costs a sort on opened_at.
  'board, resolved list': 'SEARCH reports USING INDEX reports_public_log (status=? AND public=?)',
  'board, open list': 'SEARCH reports USING INDEX reports_app_board (app_id=? AND kind=? AND public=? AND status=?) | USE TEMP B-TREE FOR ORDER BY',
  'boardSummary, counts': 'SEARCH reports USING INDEX reports_app_board (app_id=? AND kind=? AND public=? AND status=?)',
  'boardSummary, latest': 'SEARCH reports USING INDEX reports_public_log (status=? AND public=?)',

  // Finding 3: the second page is scoped in every regime.
  'listWork, the active four': `SEARCH r USING INDEX reports_app_work_updated (app_id=? AND work_state=?)${JOINED} | USE TEMP B-TREE FOR ORDER BY`,
  'listWork, the active four, page 2': `SEARCH r USING INDEX reports_app_work_updated (app_id=? AND work_state=? AND work_updated_at<?)${JOINED} | USE TEMP B-TREE FOR ORDER BY`,
  'listWork, one state': `SEARCH r USING INDEX reports_app_work_updated (app_id=? AND work_state=?)${JOINED}`,
  'listWork, one state, page 2': `SEARCH r USING INDEX reports_app_work_updated (app_id=? AND work_state=? AND work_updated_at<?)${JOINED}`,
  'listWork, the tally': 'SEARCH reports USING COVERING INDEX reports_work_updated (work_state>?)',

  // The sweep was pinned nowhere until this file (0005_indexes.sql says so beside its index). Its
  // `reports` half seeks reports_work_updated in every regime, which is the measurement behind
  // "no drop list may hold it". The analysed SCAN is of work_runs, a table of finished runs.
  'claimWork, the sweep of runs': {
    structural: 'SEARCH work_runs USING INDEX sqlite_autoindex_work_runs_1 (id=?) | LIST SUBQUERY 1 | SEARCH reports USING INDEX reports_work_updated (work_state=?) | CREATE BLOOM FILTER',
    analysed: 'SCAN work_runs | LIST SUBQUERY 1 | SEARCH reports USING INDEX reports_work_updated (work_state=?) | CREATE BLOOM FILTER',
    release: 'SEARCH work_runs USING INDEX sqlite_autoindex_work_runs_1 (id=?) | LIST SUBQUERY 1 | SEARCH reports USING INDEX reports_work_updated (work_state=?) | CREATE BLOOM FILTER',
  },
  'claimWork, the sweep of rows': 'SEARCH reports USING INDEX reports_work_updated (work_state=?)',
  // Finding 4, the pin tests/work.test.mjs warned would be the first to break.
  'claimWork, the pick': {
    structural: `${PICK_SUBQUERY}SEARCH reports USING INDEX reports_app_work_updated (app_id=? AND work_state>?) | USE TEMP B-TREE FOR ORDER BY`,
    analysed: `${PICK_SUBQUERY}MULTI-INDEX OR | INDEX 1 | SEARCH reports USING INDEX reports_app_work_updated (app_id=? AND work_state=?)`
      + ' | INDEX 2 | SEARCH reports USING INDEX reports_app_work_updated (app_id=? AND work_state=?) | USE TEMP B-TREE FOR ORDER BY',
    release: `${PICK_SUBQUERY}SEARCH reports USING INDEX reports_app_work_updated (app_id=? AND work_state>?) | USE TEMP B-TREE FOR ORDER BY`,
  },
  // Finding 2.
  'readDetail, by run': {
    structural: `SEARCH r USING INDEX {app_id-leading} (app_id=?)${JOINED}`,
    analysed: `SEARCH r USING INDEX reports_work_run (work_run=?)${JOINED}`,
    release: `SEARCH r USING INDEX reports_work_run (work_run=?)${JOINED}`,
  },
  'readDetail, by id': `SEARCH r USING INDEX sqlite_autoindex_reports_1 (id=?)${JOINED}`,

  // Finding 1. A batch of 25 and a chunk of 50, which is what production sends.
  'openImport, dedupe read, batch of 25': {
    structural: 'SEARCH reports USING INDEX {app_id-leading} (app_id=?)',
    analysed: 'SEARCH reports USING INDEX reports_fp (fingerprint=?)',
    release: 'SCAN reports',
  },
  'openSync, the open items of one source': 'SEARCH reports USING INDEX {app_id,kind-leading} (app_id=? AND kind=?)',
  'openSync, the chunked close, 50 fingerprints': {
    structural: 'SEARCH reports USING INDEX {app_id-leading} (app_id=?)',
    analysed: 'SEARCH reports USING INDEX reports_fp (fingerprint=?)',
    release: 'SCAN reports',
  },
};

const pinned = (name, regime) => (typeof PLANS[name] === 'string' ? PLANS[name] : PLANS[name][regime]);

/** Each regime built once, with its statements captured. Tests read it and never write it. */
const regimes = new Map();
async function regime(name) {
  if (!regimes.has(name)) {
    const fixture = await buildFixture(name);
    const captured = await captureStatements(fixture.db);
    regimes.set(name, { ...fixture, ...captured });
  }
  return regimes.get(name);
}

test('#139 item 3: every statement the store sends is pinned, with statistics and without', async () => {
  for (const name of REGIMES) {
    const { sqlite, statements } = await regime(name);
    assert.deepEqual(Object.keys(statements).sort(), Object.keys(PLANS).sort(), 'a captured statement has no pin, or a pin has no statement');
    for (const [statement, captured] of Object.entries(statements)) {
      assert.equal(planOf(sqlite, captured), pinned(statement, name), `the ${name} plan for ${statement} has changed`);
    }
  }
});

test('the three regimes hold the statistics they are named for', async () => {
  const structural = await regime('structural');
  assert.equal(statRows(structural.sqlite), 0, 'the structural database has statistics, so none of its plans is structural');

  const analysed = await regime('analysed');
  const total = analysed.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n;
  const stat = (sqlite, idx) => (sqlite.prepare('SELECT stat FROM sqlite_stat1 WHERE idx = ?').get(idx) || {}).stat;
  assert.equal(stat(analysed.sqlite, 'reports_fp'), `${total} 1`, 'the analysed statistics do not describe the analysed rows');

  // The release regime's statistics are the mechanism behind finding 1, so they are asserted
  // rather than described: the planner believes `reports` holds RELEASE_ROWS rows, and that the
  // work queue's indexes are empty, against a table that holds every row the other two do.
  const release = await regime('release');
  assert.equal(release.sqlite.prepare('SELECT COUNT(*) AS n FROM reports').get().n, total, 'the release regime holds different rows');
  assert.equal(stat(release.sqlite, 'reports_fp'), `${RELEASE_ROWS} 1`);
  assert.equal(stat(release.sqlite, 'reports_work_run'), '0 0');
  assert.equal(stat(release.sqlite, 'reports_app_work_updated'), '0 0 0 0 0');
});

// ── What the plans that move read ─────────────────────────────────────────────
//
// For each statement whose plan changes with the statistics, or whose plan is one of #139's
// findings, the rows its chosen index range spans on this fixture. One entry per plan the
// statement has been measured to take; a plan with no entry fails here, so a new plan cannot be
// costed by an entry written for another.
//
// The two writes the capture makes (one claim, fifty source closes) touch no column any count
// below reads, so these are counted on the captured database as it stands.

const n = (sqlite, sql, ...params) => sqlite.prepare(sql).get(...params).n;
const FLEET_SLICE = (sqlite) => n(sqlite, "SELECT COUNT(*) AS n FROM reports WHERE app_id = 'fleet'");
const WHOLE_TABLE = (sqlite) => n(sqlite, 'SELECT COUNT(*) AS n FROM reports');
/** Fleet open items on the board's resolved half: what reports_app_board's four terms span. */
const FLEET_RESOLVED = "app_id = 'fleet' AND kind = 'open' AND public = 1 AND status = 'fixed'";
const BOARD_RANGE = (sqlite) => n(sqlite, `SELECT COUNT(*) AS n FROM reports WHERE ${FLEET_RESOLVED}`);
/** reports_public_log walked in fixed_at order from the newest published fix of ANY tenancy, down
 *  to the `limit`-th fleet resolution, or to the end of the range if there are fewer. */
const PUBLIC_LOG_WALK = (limit) => (sqlite) => n(
  sqlite,
  `SELECT COUNT(*) AS n FROM reports WHERE status = 'fixed' AND public = 1 AND fixed_at >= COALESCE(
     (SELECT fixed_at FROM reports WHERE ${FLEET_RESOLVED} ORDER BY fixed_at DESC LIMIT 1 OFFSET ${limit - 1}), -1)`,
);

const SPANS = {
  'readDetail, by run': [
    { plan: /reports_work_run \(work_run=\?\)/, count: (sqlite, s) => n(sqlite, 'SELECT COUNT(*) AS n FROM reports WHERE work_run = ?', s.params[0]) },
    { plan: /\{app_id-leading\} \(app_id=\?\)/, count: FLEET_SLICE },
  ],
  'claimWork, the pick': [
    // One seek per arm of the OR: the approved rows, and the claimed ones whose lease it tests.
    { plan: /MULTI-INDEX OR/, count: (sqlite) => n(sqlite, "SELECT COUNT(*) AS n FROM reports WHERE app_id = 'fleet' AND work_state IN ('approved', 'claimed')") },
    // Every fleet row that has ever been in the queue, `done` included, then a sort.
    { plan: /reports_app_work_updated \(app_id=\? AND work_state>\?\)/, count: (sqlite) => n(sqlite, "SELECT COUNT(*) AS n FROM reports WHERE app_id = 'fleet' AND work_state IS NOT NULL") },
  ],
  'openImport, dedupe read, batch of 25': [
    { plan: /reports_fp \(fingerprint=\?\)/, count: (sqlite, s) => s.params.length },
    { plan: /\{app_id-leading\} \(app_id=\?\)/, count: FLEET_SLICE },
    { plan: /^SCAN reports$/, count: WHOLE_TABLE },
  ],
  'openSync, the chunked close, 50 fingerprints': [
    // The first binding is the close time; the rest are the fingerprints, one probe each.
    { plan: /reports_fp \(fingerprint=\?\)/, count: (sqlite, s) => s.params.length - 1 },
    { plan: /\{app_id-leading\} \(app_id=\?\)/, count: FLEET_SLICE },
    { plan: /^SCAN reports$/, count: WHOLE_TABLE },
  ],
  'boardSummary, latest': [
    { plan: /reports_public_log \(status=\? AND public=\?\)$/, count: PUBLIC_LOG_WALK(1) },
    { plan: /reports_app_board .* \| USE TEMP B-TREE FOR ORDER BY$/, count: BOARD_RANGE },
  ],
  'board, resolved list': [
    { plan: /reports_public_log \(status=\? AND public=\?\)$/, count: PUBLIC_LOG_WALK(50) },
    { plan: /reports_app_board .* \| USE TEMP B-TREE FOR ORDER BY$/, count: BOARD_RANGE },
  ],
  healthSites: [
    { plan: /reports_app_fix_created \(app_id=\? AND created_at>\?\)/, count: (sqlite, s) => n(sqlite, "SELECT COUNT(*) AS n FROM reports WHERE app_id = 'fleet' AND kind <> 'open' AND created_at >= ?", s.params[0]) },
    // A skip-scan over every site's entries in the window, whichever tenancy filed them.
    { plan: /reports_site_created \(ANY\(site\) AND created_at>\?\)/, count: (sqlite, s) => n(sqlite, 'SELECT COUNT(*) AS n FROM reports WHERE created_at >= ?', s.params[0]) },
    { plan: /\{app_id-leading\} \(app_id=\?\)/, count: FLEET_SLICE },
  ],
};

// On this fixture: 260 fleet rows (200 corrections, 60 open items of which 40 were ever queued
// and 12 are published resolutions), 600 tenant rows (300 of them published fixes), 860 in all.
// What each plan would cost if it were the cheap one is the smallest number in its row.
const COSTS = {
  'readDetail, by run': { structural: 260, analysed: 1, release: 1 },
  'claimWork, the pick': { structural: 40, analysed: 4, release: 40 },
  'openImport, dedupe read, batch of 25': { structural: 260, analysed: 25, release: 860 },
  'openSync, the chunked close, 50 fingerprints': { structural: 260, analysed: 50, release: 860 },
  'boardSummary, latest': { structural: 301, analysed: 301, release: 301 },
  'board, resolved list': { structural: 362, analysed: 362, release: 362 },
  healthSites: { structural: 200, analysed: 860, release: 260 },
};

test('#139 items 1, 3 and 6: what the plans that move read, in rows their index range spans', async () => {
  assert.deepEqual(Object.keys(COSTS).sort(), Object.keys(SPANS).sort(), 'a costed statement has no span, or a span no cost');
  for (const name of REGIMES) {
    const { sqlite, statements } = await regime(name);
    for (const [statement, spans] of Object.entries(SPANS)) {
      const plan = planOf(sqlite, statements[statement]);
      const span = spans.find((s) => s.plan.test(plan));
      assert.ok(span, `${statement} plans as "${plan}" in the ${name} regime, and nothing here says what that plan reads`);
      assert.equal(span.count(sqlite, statements[statement]), COSTS[statement][name], `the ${name} cost of ${statement} has changed`);
    }
  }
  // The fixture is what makes these numbers mean anything, so its shape is asserted too.
  const { sqlite } = await regime('analysed');
  assert.equal(FLEET_SLICE(sqlite), SHAPE.corrections + SHAPE.open);
  assert.equal(WHOLE_TABLE(sqlite), SHAPE.corrections + SHAPE.open + SHAPE.tenantNew + SHAPE.tenantFixed);
  assert.equal(BOARD_RANGE(sqlite), SHAPE.open / 5);
});

// ── How the release regime moves with the rows production holds at release ──────
//
// Production's row count is not knowable from a test, and the plans turn on it, because the
// statistics' row count is what the planner takes for the size of the table. So the count is
// swept, and each line is the statements that plan a full SCAN of `reports` at that size. Read
// it with the release script's stage 3 in mind: every one of these is a statement the Worker
// runs against EVERY tenant's rows, for as long as nothing analyses the database again. The
// fixture's 200 corrections cap the sweep, and the dedupe read's line moves between 96 and 97
// rows at release, measured.
const RELEASE_SCANS = {
  1: ['board, open list', 'boardSummary, counts', 'claimWork, the pick', 'readDetail, by id',
    'openImport, dedupe read, batch of 25', 'openSync, the open items of one source', 'openSync, the chunked close, 50 fingerprints'],
  5: ['boardSummary, counts', 'openImport, dedupe read, batch of 25', 'openSync, the open items of one source', 'openSync, the chunked close, 50 fingerprints'],
  [RELEASE_ROWS]: ['openImport, dedupe read, batch of 25', 'openSync, the chunked close, 50 fingerprints'],
  100: ['openSync, the chunked close, 50 fingerprints'],
  200: [],
};

test('#139 item 3: the full scans release statistics leave behind, by the rows production holds at release', async () => {
  const scans = (sqlite, statements) => Object.entries(statements)
    .filter(([, s]) => /(^| \| )SCAN (reports|r)\b/.test(planOf(sqlite, s)))
    .map(([name]) => name)
    .sort();
  for (const [rows, expected] of Object.entries(RELEASE_SCANS)) {
    const { sqlite, db } = await buildFixture('release', { releaseRows: Number(rows) });
    const { statements } = await captureStatements(db);
    assert.deepEqual(scans(sqlite, statements), [...expected].sort(), `with ${rows} rows at release, a different set of statements scans the table`);
  }
});

// ── #139 item 4: boardSummary's latest, by the shape of the table ────────────────
//
// The planner chooses between reports_public_log, which is in the sort's order but unscoped, and
// reports_app_board, which is scoped but needs a sort, from statistics that record how many rows
// share a prefix and NOT when they were written. The cost is decided by when they were written:
// public_log reads every published fix of any tenancy newer than the fleet's newest, and
// app_board reads every fleet resolution then sorts them. So the same statistics can choose the
// expensive plan in either direction, which the three shapes here show. An index that carried
// the sort after the four board terms would read one row in all three; that index is a 0006
// question this file measures nothing about.
/** 2000 open items, so 400 fleet resolutions, beside a tenant of 1300 rows. */
const BUSY_BOARD = { ...SHAPE, corrections: 40, open: 2000, tenantNew: 1000, tenantFixed: 300 };
const LATEST = [
  { shape: SHAPE, why: 'the default fixture, tenants newer', plan: 'reports_public_log', walk: 301, board: 12 },
  { shape: { ...BUSY_BOARD, tenantsOlder: true }, why: 'a busy board, tenants older', plan: 'reports_app_board', walk: 1, board: 400 },
  { shape: BUSY_BOARD, why: 'a busy board, tenants newer', plan: 'reports_app_board', walk: 301, board: 400 },
];

test('#139 item 4: what boardSummary\'s latest reads on each plan, and which plan statistics pick', async () => {
  for (const { shape, why, plan, walk, board } of LATEST) {
    const { sqlite, db } = await buildFixture('analysed', { shape });
    const { statements } = await captureStatements(db);
    const chosen = planOf(sqlite, statements['boardSummary, latest']);
    assert.match(chosen, new RegExp(`USING INDEX ${plan} `), `${why}: latest no longer plans onto ${plan}: ${chosen}`);
    assert.equal(PUBLIC_LOG_WALK(1)(sqlite), walk, `${why}: the reports_public_log walk has changed`);
    assert.equal(BOARD_RANGE(sqlite), board, `${why}: the reports_app_board range has changed`);
  }
});
