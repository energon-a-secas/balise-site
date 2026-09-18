// Every query plan this Worker depends on, pinned by index name.
//
// One of the three files tests/local-d1.test.mjs was split into (A31): that file had reached
// 858 lines against a 500-line ceiling, and it was three concerns by then. This is the one that
// asserts HOW the database answers. Its sibling tests/local-d1-rows.test.mjs asserts how MUCH
// the database reads, and tests/local-d1.test.mjs keeps the routes and the contract envelopes.
//
// WHY A PLAN CAN BE PINNED AT ALL (A20). `PRAGMA optimize` at the end of 0004 analyses nothing,
// because a migration runs against an empty table: `sqlite_stat1` holds one row and it is
// d1_migrations. So every plan below is chosen STRUCTURALLY, from the shape of the WHERE against
// the shape of the index, by the leftmost-prefix rule and nothing else. That is what makes them
// stable enough to assert, and asserting them is the mitigation the pragma was mistakenly
// credited with: a planner change, a dropped index or a rewritten WHERE becomes a red test here
// instead of a bill in production.
//
// WHY THE STATEMENTS ARE TRANSCRIBED. `EXPLAIN QUERY PLAN` needs a statement, and this file
// cannot ask the store for one: the store's text is built inside a function, with bound
// parameters and, in one case, an interpolated ORDER BY column. So the statements below are
// copies, and a copy rots. The second and third tests are what stop that: every transcription is
// run against the same database and its answer must equal the answer the ROUTE gives, so a
// transcription that has drifted from the store fails instead of pinning the plan of a query
// nobody runs. A pinned plan for a statement the Worker does not execute is worth nothing.
//
// It runs the Worker under workerd because the answers have to come from the routes, and it
// plants the tenant fixture because 'the route's answer equals the scoped statement's answer' is
// only a statement about scoping if there is a second tenancy in the table to leave out.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  WORKER_DIR, TOKEN, AI_TOKEN, SALT, TURNSTILE_PASS,
  migrate, startWorker, stopWorker, requester, seedReports, seedOpenItems, seedPublished, PUBLISHED,
} from './harness.mjs';
import { plantTenant, d1For, TENANT_ROWS } from './tenant-rows.mjs';
import { TENANT, TENANT_MARK } from './tenant-fixture.mjs';

const STATE = join(WORKER_DIR, '.wrangler/plans-state');
const PORT = 8886;
const BASE = `http://127.0.0.1:${PORT}`;
const call = requester(BASE);
const d1 = d1For(STATE);

// Enough rows for a page of five and for both feeds to be non-empty, and no more: a plan is
// structural, so seeding forty reports to look at one would only make the suite slower.
const SEEDED = 12;
const OPEN_SEEDED = 8;

let worker = null;

before(async () => {
  rmSync(STATE, { recursive: true, force: true });
  await migrate(STATE);
  // Before the Worker starts: nothing in phase 1 can create a tenant row through a route, and
  // planting while `wrangler dev` holds the database would be a second writer on the same file.
  await plantTenant(STATE);
  worker = await startWorker(PORT, {
    BALISE_OPERATOR_TOKEN: TOKEN,
    BALISE_AUTOMATION_TOKEN: AI_TOKEN,
    BALISE_IP_SALT: SALT,
    BALISE_TURNSTILE_SECRET: TURNSTILE_PASS,
  }, STATE);
  await seedReports(call, SEEDED, assert);
  await seedOpenItems(call, OPEN_SEEDED, assert);
  // The published rows. /log, /board and /board/summary answer nothing without them, and an
  // answer-equality test between two empty answers proves nothing at all.
  await seedPublished(call, assert);
}, { timeout: 300_000 });

after(async () => {
  await stopWorker(worker);
});

/** Bigger than any created_at or fixed_at these tests produce, standing in for the keyset
 *  cursor's default. */
const CURSOR = Number.MAX_SAFE_INTEGER;
/** The window both the /health read-back and the board summary count over, in days. Asserted
 *  against what the summary route reports rather than imported, so a change to
 *  SUMMARY_WINDOW_DAYS shows up here as a red test rather than as two agreeing copies. */
const WINDOW_DAYS = 30;
const WINDOW_FROM = Date.now() - WINDOW_DAYS * 86_400_000;

// The IN list is rendered as literals because `wrangler d1 execute` takes no parameters. It is
// IN_PROGRESS_STATES from src/work.js, and the board summary test below proves the copy still
// counts what the route counts.
const MOVING = `'claimed','review','accepted'`;
/** The six public_note columns the board selects, in order. `source`, `source_ref`, `body` and
 *  `site` are deliberately not among them (see board() in src/store-open.js). */
const BOARD_COLUMNS = 'public_note, status, opened_at, fixed_at, source_closed_at, work_state';

const STATEMENTS = {
  'listReports, kind given': `SELECT id FROM reports WHERE app_id = 'fleet' AND kind = 'wrong' AND created_at < ${CURSOR} ORDER BY created_at DESC LIMIT 5`,
  'listReports, kind and status': `SELECT id FROM reports WHERE app_id = 'fleet' AND kind = 'wrong' AND status = 'new' AND created_at < ${CURSOR} ORDER BY created_at DESC LIMIT 5`,
  'listReports, corrections': `SELECT id FROM reports WHERE app_id = 'fleet' AND kind <> 'open' AND created_at < ${CURSOR} ORDER BY created_at DESC LIMIT 5`,
  'listReports, corrections and status': `SELECT id FROM reports WHERE app_id = 'fleet' AND kind <> 'open' AND status = 'new' AND created_at < ${CURSOR} ORDER BY created_at DESC LIMIT 5`,
  'publicLog': `SELECT id, public_note FROM reports WHERE app_id = 'fleet' AND kind <> 'open' AND status = 'fixed' AND public = 1 AND fixed_at < ${CURSOR} ORDER BY fixed_at DESC LIMIT 5`,
  'healthSites': `SELECT site, count(*) AS n, max(created_at) AS last_at FROM reports WHERE app_id = 'fleet' AND kind <> 'open' AND created_at > ${WINDOW_FROM} GROUP BY site ORDER BY n DESC`,

  // The four board reads (A28). board() is ONE statement called twice, with the status and the
  // ORDER BY column interpolated, and the two calls are planned differently: that is why both
  // are here rather than one standing in for the other.
  'board, open list': `SELECT ${BOARD_COLUMNS} FROM reports WHERE kind = 'open' AND public = 1 AND status = 'accepted' AND app_id = 'fleet' ORDER BY opened_at DESC LIMIT 50`,
  'board, resolved list': `SELECT ${BOARD_COLUMNS} FROM reports WHERE kind = 'open' AND public = 1 AND status = 'fixed' AND app_id = 'fleet' ORDER BY fixed_at DESC LIMIT 50`,
  'boardSummary, counts': `SELECT COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS open_count,
                COALESCE(SUM(CASE WHEN status = 'accepted' AND work_state IN (${MOVING}) THEN 1 ELSE 0 END), 0) AS moving_count,
                COALESCE(SUM(CASE WHEN status = 'fixed' AND fixed_at >= ${WINDOW_FROM} THEN 1 ELSE 0 END), 0) AS resolved_count
           FROM reports
          WHERE kind = 'open' AND public = 1 AND status IN ('accepted', 'fixed') AND app_id = 'fleet'`,
  'boardSummary, latest': `SELECT ${BOARD_COLUMNS} FROM reports WHERE kind = 'open' AND public = 1 AND status = 'fixed' AND app_id = 'fleet' ORDER BY fixed_at DESC LIMIT 1`,
};

// Measured 2026-09-18 on a freshly migrated local D1. Every line below is a MEASUREMENT, not a
// design intention: where the two disagree the design document is what is wrong (A21 for
// healthSites, A28 for the board), and the fix is an amendment rather than an edit here.
const PLANS = {
  'listReports, kind given': 'SEARCH reports USING INDEX reports_app_created (app_id=? AND created_at<?)',
  'listReports, kind and status': 'SEARCH reports USING INDEX reports_app_status_created (app_id=? AND status=? AND created_at<?)',
  'listReports, corrections': 'SEARCH reports USING INDEX reports_app_fix_created (app_id=? AND created_at<?)',
  'listReports, corrections and status': 'SEARCH reports USING INDEX reports_app_fix_status_created (app_id=? AND status=? AND created_at<?)',
  publicLog: 'SEARCH reports USING INDEX reports_app_fix_public_log (app_id=? AND status=? AND public=? AND fixed_at<?)',
  // Not reports_app_site_created, and A21 is why. This line is a measurement, not a wish.
  healthSites: 'SEARCH reports USING INDEX reports_app_fix_created (app_id=? AND created_at>?)'
    + ' | USE TEMP B-TREE FOR GROUP BY | USE TEMP B-TREE FOR ORDER BY',

  // A28, and these four are the amendment's evidence. Three things they say that A18 and
  // DESIGN.md 4.2 said otherwise:
  //
  //   1. The open list DOES keep the full three-term seek on reports_board. It pays for it with
  //      a temp b-tree, because reports_board's trailing column is created_at and the sort is
  //      on opened_at.
  //   2. The resolved list and the summary's latest were NEVER on reports_board: both are
  //      served by reports_public_log, which is why A29 withdrew the suggestion that that index
  //      is dead weight, and why no drop list may contain it.
  //   3. The counts query is the one the `app_id = 'fleet'` literal moves, and it moves it to a
  //      NARROWER seek: two terms on reports_app_status_created instead of three on
  //      reports_board, which cost 208 index entries against 6 on the measured population. The
  //      cost is accepted knowingly (A28) and the term stays. See boardSummary() for why, and
  //      do not "fix" this line by removing the term or adding a fourth-column index.
  //
  // The position of the literal in the WHERE changes NONE of these. SQLite reorders WHERE terms
  // itself; what moves a plan is whether an app_id term is present.
  'board, open list': 'SEARCH reports USING INDEX reports_board (kind=? AND public=? AND status=?)'
    + ' | USE TEMP B-TREE FOR ORDER BY',
  'board, resolved list': 'SEARCH reports USING INDEX reports_public_log (status=? AND public=?)',
  'boardSummary, counts': 'SEARCH reports USING INDEX reports_app_status_created (app_id=? AND status=?)',
  'boardSummary, latest': 'SEARCH reports USING INDEX reports_public_log (status=? AND public=?)',
};

test('A20 and A28: every statement plans onto a named index, and the name is asserted', async () => {
  const names = Object.keys(STATEMENTS);
  assert.deepEqual([...names].sort(), Object.keys(PLANS).sort(), 'a statement has no pinned plan, or a plan has no statement');
  const sets = await d1(...names.map((name) => `EXPLAIN QUERY PLAN ${STATEMENTS[name]}`));
  assert.equal(sets.length, names.length, 'one EXPLAIN QUERY PLAN came back without a result set');
  for (const [i, name] of names.entries()) {
    assert.equal(sets[i].map((row) => row.detail).join(' | '), PLANS[name], `the plan for ${name} has changed`);
  }
});

test('A20: the six desk and log transcriptions are the store\'s own statements, proved against the routes', async () => {
  const names = ['listReports, kind given', 'listReports, kind and status', 'listReports, corrections', 'listReports, corrections and status', 'publicLog', 'healthSites'];
  const sets = await d1(...names.map((name) => STATEMENTS[name]));
  const answer = Object.fromEntries(names.map((name, i) => [name, sets[i]]));

  const desk = async (query, ip) => (await call(`/reports?limit=5${query}`, { token: TOKEN, ip })).body.reports.map((r) => r.id);
  assert.deepEqual(answer['listReports, kind given'].map((r) => r.id), await desk('&kind=wrong', '192.0.2.110'));
  assert.deepEqual(answer['listReports, kind and status'].map((r) => r.id), await desk('&kind=wrong&status=new', '192.0.2.111'));
  assert.deepEqual(answer['listReports, corrections'].map((r) => r.id), await desk('', '192.0.2.112'));
  assert.deepEqual(answer['listReports, corrections and status'].map((r) => r.id), await desk('&status=new', '192.0.2.113'));
  // Five rows on both sides of each of those four, so none of them is two empty lists agreeing.
  for (const name of names.slice(0, 4)) {
    assert.equal(answer[name].length, 5, `${name} returned ${answer[name].length} rows, so the page is not full and the comparison is weak`);
  }

  // The log projects the address and hides the id, so the published sentence is what the two
  // answers have in common.
  const log = await call('/log?limit=5');
  assert.deepEqual(answer.publicLog.map((r) => r.public_note), log.body.entries.map((e) => e.public_note));
  assert.ok(log.body.entries.length > 0, 'the log is empty, so the publicLog transcription proves nothing');
  assert.ok(log.body.entries.some((e) => e.public_note === PUBLISHED.correction), 'the log is missing the resolution seedPublished wrote');

  const health = await call('/health');
  const bySite = (rows) => rows.map((r) => `${r.site}:${r.n ?? r.reports}`).sort();
  assert.deepEqual(bySite(answer.healthSites), bySite(health.body.sites));
  assert.ok(health.body.sites.length > 0, 'the per-site read-back is empty, so the healthSites transcription proves nothing');
  assert.equal(health.body.window_days, WINDOW_DAYS, 'the window this file transcribes is not the window the Worker uses');
});

test('A28: the four board transcriptions are the store\'s own statements, proved against /board and /board/summary', async () => {
  // The companion discipline, applied to the four statements added in this pass. Without it the
  // plans above would be pinned for four statements nobody had shown the Worker runs.
  const names = ['board, open list', 'board, resolved list', 'boardSummary, counts', 'boardSummary, latest'];
  const sets = await d1(...names.map((name) => STATEMENTS[name]));
  const answer = Object.fromEntries(names.map((name, i) => [name, sets[i]]));

  const boardRes = await call('/board?limit=50');
  assert.equal(boardRes.res.status, 200, JSON.stringify(boardRes.body));
  const board = boardRes.body;

  // entry() maps a row to { text, state, date } and drops one with no sentence, so public_note
  // in order is what the two answers have in common. Every row seedPublished wrote has a
  // sentence, so nothing is dropped and the lists are the same length.
  assert.deepEqual(answer['board, open list'].map((r) => r.public_note), board.open.map((e) => e.text));
  assert.deepEqual(answer['board, resolved list'].map((r) => r.public_note), board.resolved.map((e) => e.text));
  assert.ok(board.open.length > 0, 'the board has no open entry, so the open-list transcription proves nothing');
  assert.ok(board.resolved.length > 0, 'the board has no resolution, so the resolved-list transcription proves nothing');

  // And the board is the OPEN-ITEMS board: the resolved correction seedPublished also wrote is
  // on /log and must not be here, which is the `kind = 'open'` term in both statements.
  assert.ok(!JSON.stringify(board).includes(PUBLISHED.correction), 'a corrections entry reached the open-items board');

  const summaryRes = await call('/board/summary');
  assert.equal(summaryRes.res.status, 200, JSON.stringify(summaryRes.body));
  const summary = summaryRes.body;
  assert.equal(summary.window_days, WINDOW_DAYS, 'the window this file transcribes is not the window the summary counts over');

  const counts = answer['boardSummary, counts'][0];
  // `since` is computed in this process rather than from the Worker's `now`, so the two windows
  // differ by the seconds the suite has been running. Every resolution here was written by
  // seedPublished moments ago, so both windows contain all of them and the counts are equal.
  assert.equal(counts.open_count, summary.open, 'the transcribed open count is not the route\'s');
  assert.equal(counts.moving_count, summary.in_progress, 'the transcribed in-progress count is not the route\'s');
  assert.equal(counts.resolved_count, summary.resolved, 'the transcribed resolution count is not the route\'s');
  assert.ok(summary.open > 0 && summary.resolved > 0, 'the summary counts are zero, so the counts transcription proves nothing');
  assert.equal(summary.open, board.open.length, 'the summary and the board disagree about how many entries are open');

  const latest = answer['boardSummary, latest'][0];
  assert.ok(latest, 'the latest transcription returned no row');
  assert.equal(latest.public_note, summary.latest.text, 'the transcribed newest resolution is not the route\'s');
  assert.equal(summary.latest.text, PUBLISHED.resolved, 'the newest resolution is not the one seedPublished wrote last');
});

test('the tenant fixture reaches neither the board nor the summary', async () => {
  // The board's two statements and the summary's two carry the literal rather than a bound key
  // (C6.5), and these are the routes that would publish a tenant's items if it were ever
  // dropped: no credential, any origin, cacheable. Asserted over workerd because
  // tests/tenant-scope.test.mjs runs over node:sqlite.
  assert.ok(TENANT_ROWS > 0, 'the tenant fixture is empty');
  for (const path of ['/board?limit=50', '/board/summary', '/log?limit=50']) {
    const { body } = await call(path);
    const text = JSON.stringify(body);
    assert.ok(!text.includes(TENANT_MARK), `${path} answered with a tenant row: ${text.slice(0, 400)}`);
    assert.ok(!text.includes(TENANT), `${path} answered with a tenant app id: ${text.slice(0, 400)}`);
  }
});
