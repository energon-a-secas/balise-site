// The populated, multi-tenant database the plan suites over node:sqlite build, in each of the
// three states of planner statistics a Balise database can be in, and the Worker's own
// statements captured from the store as it runs them. NOT a *.test.mjs file, so
// `node --test tests/*.test.mjs` never runs it as a suite; tests/analysed-plans.test.mjs and
// tests/index-writes.test.mjs import it.
//
// THE THREE REGIMES (queue #139, item 3). A plan depends on the schema, the statement and the
// statistics in sqlite_stat1, and nothing else: with no STAT4 compiled in (node:sqlite has
// none, PRAGMA compile_options says so) the bound values do not move it. So the regime is the
// variable this file controls, and the rows are held the same in all three.
//
//   structural   no sqlite_stat1 at all. Every plan is chosen by the shape of the WHERE against
//                the shape of the index. This is what tests/local-d1-plans.test.mjs and
//                tests/work.test.mjs pin, because a migration run against an EMPTY table
//                gathers nothing, and it is what a fresh desk is.
//   analysed     ANALYZE over the populated table below. What a database whose statistics
//                describe its own rows plans.
//   release      what production will actually have. 0001 holds RELEASE_ROWS fleet
//                corrections, as production holds its 1.0.0 rows; 0002 to 0005 are then applied
//                the way the release applies them, and 0004 and 0005 each end with PRAGMA
//                optimize, which on a populated table gathers statistics (measured: 24 rows of
//                sqlite_stat1 from as few as ONE row at release). Then the table grows to the
//                same rows as the other two, and nothing analyses it again: no later migration
//                runs, and the Worker never runs ANALYZE. So the planner keeps believing that
//                `reports` holds RELEASE_ROWS rows, all of them the fleet's, none of them in the
//                work queue, however large and however multi-tenant it becomes.
//
// THE ROWS. Fleet corrections, fleet open items of every published state including the ones
// accepted and NOT published, a work queue with a history (finished items and some of each
// active state), and one tenant's 600 rows, every one newer than every fleet row, the way
// tests/tenant-rows.mjs places them for the workerd suites. Counts are in SHAPE.
//
// THE STATEMENTS ARE THE STORE'S, NOT TRANSCRIPTIONS. Every other plan suite in this directory
// copies the SQL out of src/ with the parameters rendered as literals, because
// `wrangler d1 execute` takes no parameters, and then has to prove each copy against a route
// before its pin is worth anything. Here the store functions run against a recording D1 and
// the exact text and bindings they send are what gets explained. A rewritten WHERE in src/ is
// therefore a changed plan here at once, and no copy can drift.
//
// WHAT THIS IS NOT: D1. It is SQLite 3.51 inside node, and D1's planner is SQLite of some other
// version behind a different binding. The structural column agrees line for line with what the
// two workerd suites measure on a real local D1 (checked when this file was written), which is
// the evidence that the two planners agree; it is not a guarantee that the analysed columns
// would. Every number derived from these plans is a node:sqlite measurement and says so.

import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

import { sqliteD1, MIGRATION_FILES, applyMigration } from './sqlite-d1.mjs';
import { plantReport, TENANT } from './tenant-fixture.mjs';
import { untie } from './plan-ties.mjs';
import { FLEET, FLEET_SCOPE } from '../src/scope.js';
import { sha256Hex } from '../src/keys.js';
import { listReports } from '../src/store.js';
import { publicLog, healthSites } from '../src/store-public.js';
import { board, boardSummary, upsertOpenItems, syncOpenSource, openFingerprintInput } from '../src/store-open.js';
import { listWork, readDetail } from '../src/store-work.js';
import { claimWork } from '../src/store-work-runner.js';
import { ACTIVE_STATES } from '../src/work.js';

export const REGIMES = ['structural', 'analysed', 'release'];

export const T = 1_760_000_000_000;
/** After every timestamp in the fixture, and inside the board summary's window of all of them. */
export const NOW = T + 20_000_000;
/** Where the tenant's rows sit in time: after every fleet row, or (for one shape) before. */
const TENANT_NEWER = T + 10_000_000;
const TENANT_OLDER = T - 10_000_000;

/** The default shape. Open item i is published-fixed when i % 5 is 0, published-open when it is
 *  1, accepted and NOT published when it is 2, and new otherwise, so each class is a fifth. The
 *  first `queued` of them have been in the work queue: the first `done` finished, the rest at an
 *  active state, except that an item C4 has closed is never left active (#64). */
export const SHAPE = Object.freeze({
  corrections: 200,
  open: 60,
  queued: 40,
  done: 30,
  tenantNew: 300,
  tenantFixed: 300,
  tenantsOlder: false,
});

/** Fleet rows at release. Production's real count is not knowable from here without reading the
 *  remote; tests/analysed-plans.test.mjs sweeps it, because the plans turn on it. */
export const RELEASE_ROWS = 20;

/** The open source every fixture item comes from, and its refs. */
export const SOURCE = 'queue';
export const refOf = (i) => `#${i}`;

const fixedAt = (createdAt) => createdAt + 500;
const correctionAt = (i) => T + i * 1000;
const openAt = (shape, i) => T + shape.corrections * 1000 + i * 1000;

/** One fleet correction, by a statement that is valid on 0001's table as well as on 0005's, so
 *  the release regime can write its first rows before 0002 exists and every regime holds the
 *  same row. Columns added by later migrations take their defaults, which are the fleet's. */
function insertCorrection(sqlite, i) {
  const fixed = i % 4 === 0;
  const at = correctionAt(i);
  sqlite
    .prepare(`INSERT INTO reports (id, created_at, site, url, target_kind, target_id, target_label, kind, body, contact,
                status, public, public_note, fixed_at, fingerprint)
              VALUES (?, ?, ?, ?, 'concept', ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?)`)
    .run(
      `fc-${i}`, at, `site-${i % 9}`, `https://example.test/fc-${i}`, `target-${i}`, `label ${i}`,
      i % 3 ? 'wrong' : 'missing', `Correction ${i}.`,
      fixed ? 'fixed' : i % 4 === 1 ? 'rejected' : 'new',
      fixed ? `Resolution ${i}.` : null, fixed ? fixedAt(at) : null, `fc-${i}`,
    );
}

function openState(shape, i) {
  if (i >= shape.queued) return null;
  if (i < shape.done || i % 5 === 0) return 'done';
  return ACTIVE_STATES[i % 4];
}

async function plantOpenItem(db, shape, i) {
  const at = openAt(shape, i);
  const cls = i % 5;
  const status = cls === 0 ? 'fixed' : cls === 1 || cls === 2 ? 'accepted' : 'new';
  const state = openState(shape, i);
  const runId = state ? `run-${i}` : undefined;
  plantReport(db, FLEET, {
    id: `fo-${i}`,
    runId,
    over: {
      created_at: at,
      kind: 'open',
      status,
      public: cls === 2 ? 0 : 1,
      public_note: status === 'new' ? null : `Open item ${i}.`,
      fixed_at: status === 'fixed' ? fixedAt(at) : null,
      // The fingerprint the import computes, so the capture's re-import of these refs is the
      // no-op a second run of the same batch is.
      fingerprint: await sha256Hex(openFingerprintInput(SOURCE, refOf(i))),
      source: SOURCE,
      source_ref: refOf(i),
      opened_at: at,
      work_state: state,
      work_run: runId || null,
      work_mode: state ? 'fix' : null,
      work_attempts: state ? 1 : 0,
      work_approved_at: state ? T + i : null,
      work_updated_at: state ? T + 2_000_000 + i * 10 : null,
      // Lapsed at NOW, so a claimed item is claimable again and the claim's sweep has rows to
      // consider.
      work_lease_until: state === 'claimed' ? T : null,
    },
  });
}

function plantTenant(db, shape) {
  const from = shape.tenantsOlder ? TENANT_OLDER : TENANT_NEWER;
  for (let i = 0; i < shape.tenantNew; i += 1) {
    plantReport(db, TENANT, { id: `tn-${i}`, over: { created_at: from + i, status: 'new', fingerprint: `tn-${i}` } });
  }
  for (let i = 0; i < shape.tenantFixed; i += 1) {
    const at = from + shape.tenantNew + i;
    plantReport(db, TENANT, {
      id: `tf-${i}`,
      over: { created_at: at, status: 'fixed', public: 1, fixed_at: at, site: 'parla-site', fingerprint: `tf-${i}` },
    });
  }
}

/**
 * The fixture in one regime: `{ sqlite, db }`, `db` being tests/sqlite-d1.mjs's D1 binding over
 * that database. `releaseRows` is read by the release regime only.
 */
export async function buildFixture(regime, { shape = SHAPE, releaseRows = RELEASE_ROWS } = {}) {
  assert.ok(REGIMES.includes(regime), `no regime called ${regime}`);
  const sqlite = new DatabaseSync(':memory:');
  let first = 0;
  if (regime === 'release') {
    assert.ok(releaseRows <= shape.corrections, 'the release rows are corrections, so there must be that many');
    applyMigration(sqlite, MIGRATION_FILES[0]);
    for (; first < releaseRows; first += 1) insertCorrection(sqlite, first);
    for (const file of MIGRATION_FILES.slice(1)) applyMigration(sqlite, file);
  } else {
    for (const file of MIGRATION_FILES) applyMigration(sqlite, file);
  }
  const db = sqliteD1({ sqlite });
  for (let i = first; i < shape.corrections; i += 1) insertCorrection(sqlite, i);
  for (let i = 0; i < shape.open; i += 1) await plantOpenItem(db, shape, i);
  plantTenant(db, shape);
  if (regime === 'analysed') sqlite.exec('ANALYZE');
  return { sqlite, db };
}

/** How many rows of sqlite_stat1 the database holds, which is 0 when it has no such table. */
export function statRows(sqlite) {
  const has = sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get().n;
  return has ? sqlite.prepare('SELECT COUNT(*) AS n FROM sqlite_stat1').get().n : 0;
}

/** A D1 binding that keeps every statement it is asked to run, with its bindings, batches
 *  included, so a store function's SQL can be read back exactly as it was sent. */
export function recording(base) {
  const seen = [];
  const wrap = (stmt) => ({
    ...stmt,
    bind: (...values) => wrap(stmt.bind(...values)),
    run: async () => { seen.push({ sql: stmt.sql, params: stmt.params }); return stmt.run(); },
    all: async () => { seen.push({ sql: stmt.sql, params: stmt.params }); return stmt.all(); },
    first: async (column) => { seen.push({ sql: stmt.sql, params: stmt.params }); return stmt.first(column); },
  });
  return {
    ...base,
    seen,
    prepare: (sql) => wrap(base.prepare(sql)),
    batch: async (statements) => {
      for (const s of statements) seen.push({ sql: s.sql, params: s.params });
      return base.batch(statements);
    },
  };
}

/** The plan SQLite chooses for one captured statement, its bindings bound, one line per step
 *  joined by ' | ' as every plan suite here writes it, with tie-breaks written as their set. */
export function planOf(sqlite, { sql, params }) {
  return sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => untie(row.detail)).join(' | ');
}

/**
 * Run the Worker's reads and the claim against `db`, and return every statement this suite pins,
 * by name, exactly as the store sent it. Each `take` names the statements one call must make and
 * requires each pattern to match ONE of them, so a pin can never quietly describe the wrong
 * statement of a call that makes several.
 *
 * The order matters in two places. The second page of each work list is asked for with the
 * cursor the first page answered, which is the only cursor the route ever accepts. And the two
 * calls that write (the claim, and the sync's close) come after every read, although no plan
 * depends on it: the statistics a plan is chosen from are not updated by a write.
 */
export async function captureStatements(base) {
  const db = recording(base);
  const got = {};
  const take = async (picks, call) => {
    const from = db.seen.length;
    const out = await call();
    assert.ok(!out || !out.code, `a captured call failed: ${JSON.stringify(out)}`);
    const sent = db.seen.slice(from);
    for (const [name, pattern] of Object.entries(picks)) {
      const hits = sent.filter((s) => pattern.test(s.sql));
      assert.equal(hits.length, 1, `${name}: ${hits.length} statements matched ${pattern}, among:\n${sent.map((s) => s.sql).join('\n---\n')}`);
      got[name] = hits[0];
    }
    return out;
  };
  const one = /\bFROM reports\b/;

  await take({ 'listReports, kind given': one }, () => listReports(db, FLEET_SCOPE, { kind: 'wrong', limit: 5 }));
  await take({ 'listReports, kind and status': one }, () => listReports(db, FLEET_SCOPE, { kind: 'wrong', status: 'new', limit: 5 }));
  await take({ 'listReports, kind=open': one }, () => listReports(db, FLEET_SCOPE, { kind: 'open', limit: 5 }));
  await take({ 'listReports, kind=open and status': one }, () => listReports(db, FLEET_SCOPE, { kind: 'open', status: 'new', limit: 5 }));
  await take({ 'listReports, corrections': one }, () => listReports(db, FLEET_SCOPE, { limit: 5 }));
  await take({ 'listReports, corrections and status': one }, () => listReports(db, FLEET_SCOPE, { status: 'new', limit: 5 }));
  await take({ publicLog: one }, () => publicLog(db, { limit: 5 }));
  await take({ healthSites: one }, () => healthSites(db, NOW - 30 * 86_400_000));

  // board() is one statement run twice, with the status bound and the ORDER BY column
  // interpolated; the ORDER BY is what tells the two apart.
  await take({ 'board, resolved list': /ORDER BY fixed_at DESC/, 'board, open list': /ORDER BY opened_at DESC/ }, () => board(db, { limit: 50 }));
  await take({ 'boardSummary, counts': /AS open_count/, 'boardSummary, latest': /ORDER BY fixed_at DESC LIMIT 1/ }, () => boardSummary(db, { now: NOW }));

  const PAGE = /^\s*SELECT r\.id/;
  const TALLY = /GROUP BY work_state/;
  const cursorOf = (next) => {
    const at = next.indexOf(':');
    return { updatedAt: Number(next.slice(0, at)), id: next.slice(at + 1) };
  };
  const four = await take({ 'listWork, the active four': PAGE, 'listWork, the tally': TALLY }, () => listWork(db, { states: ACTIVE_STATES, limit: 2 }));
  assert.ok(four.next, 'the active list has one page, so its second page cannot be captured');
  await take({ 'listWork, the active four, page 2': PAGE }, () => listWork(db, { states: ACTIVE_STATES, limit: 2, before: cursorOf(four.next) }));
  const done = await take({ 'listWork, one state': PAGE }, () => listWork(db, { states: ['done'], limit: 1 }));
  assert.ok(done.next, 'the finished list has one page, so its second page cannot be captured');
  await take({ 'listWork, one state, page 2': PAGE }, () => listWork(db, { states: ['done'], limit: 1, before: cursorOf(done.next) }));

  // The claim with no id, and its answer, which is readDetail by the run it just made: the read
  // queue item #139's first finding is about, on every successful POST /work/claim.
  const claimed = await take({
    'claimWork, the sweep of runs': /^\s*UPDATE work_runs SET ended_at = \?, end_reason = 'expired'\s+WHERE ended_at IS NULL AND id IN/,
    'claimWork, the sweep of rows': /^\s*UPDATE reports SET work_state = 'approved'/,
    'claimWork, the pick': /^\s*UPDATE reports SET work_state = 'claimed'/,
    'readDetail, by run': PAGE,
  }, () => claimWork(db, { actor: 'ai', runner: 'plans', leaseSeconds: 1800, now: NOW }));
  assert.ok(claimed.item, 'the claim found nothing to claim, so the claim answer was never read');
  await take({ 'readDetail, by id': PAGE }, () => readDetail(db, 'id', claimed.item.id));

  // A real batch is 25 items. These are 25 refs the fixture already holds, unchanged, so the
  // import writes nothing: the case a second run of the same batch is.
  const batch = Array.from({ length: 25 }, (_, i) => ({ ref: refOf(i), text: `Open item ${i}.`, opened_at: T, closed_at: null }));
  const imported = await take({ 'openImport, dedupe read, batch of 25': /fingerprint IN/ }, () => upsertOpenItems(db, { source: SOURCE, items: batch, now: NOW }));
  assert.equal(imported.unchanged, batch.length, `the re-import was not a no-op: ${JSON.stringify(imported)}`);

  // The sync is told every ref is still open at the source except fifty, so fifty close, which
  // is one full chunk whatever the shape.
  const open = base.sqlite.prepare("SELECT source_ref FROM reports WHERE kind = 'open' AND source = ? ORDER BY source_ref").all(SOURCE);
  assert.ok(open.length > 50, 'the fixture has too few open items for a full chunk of the sync');
  await take({
    'openSync, the open items of one source': /^\s*SELECT fingerprint, source_ref/,
    'openSync, the chunked close, 50 fingerprints': /^\s*UPDATE reports SET source_closed_at = \?\s+WHERE app_id = 'fleet' AND source_closed_at IS NULL/,
  }, () => syncOpenSource(db, { source: SOURCE, refs: open.slice(50).map((r) => r.source_ref), now: NOW }));

  return { statements: got, claimed: claimed.item };
}
