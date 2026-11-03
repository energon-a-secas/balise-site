// What every write the Worker makes to `reports` costs in index maintenance, and what 0005's
// four indexes added to it, over node:sqlite (queue #139, item 5).
//
// WHY A PROXY. The question #139 left open is the write cost of 0005's four indexes, and the
// measurement nobody could take is rows_written: D1's local path reports none, through wrangler
// or through the Worker, and wall time at this volume is noise. What CAN be read exactly is the
// bytecode. SQLite compiles an INSERT to one IdxInsert per index on the table, and an UPDATE to
// an IdxDelete and an IdxInsert for every index holding a column its SET names, and for every
// partial index whose predicate reads one. So the index b-trees a statement writes are a property
// of the statement and the schema, decided when it is prepared, and EXPLAIN lists them.
//
// WHAT THE PROXY LEAVES OUT, so the numbers are not read as more than they are:
//   - A partial index is compiled in and then skipped at run time for a row its predicate
//     excludes. reports_app_work_updated is in every INSERT below, and no INSERT writes a row in
//     the work queue, so it costs those statements nothing but the predicate test. The pins mark
//     partial indexes so a reader can make that subtraction.
//   - An UPDATE rewrites an index whose column it names even when the value does not change:
//     applyTransition's COALESCE(?, public) names `public` on every move, so it rewrites every
//     index on `public` whether or not the operator touched it. That is what SQLite does, and the
//     count says so.
//   - It is a count of b-tree writes, not of pages or bytes, and it says nothing about D1's
//     billing, which counts rows written by its own rule.
//
// THE STATEMENTS ARE THE STORE'S, captured from a recording D1 while the store functions run one
// report, one import and one work item through every write they make (tests/plan-fixture.mjs
// explains the recording). Both schemas are empty databases, because bytecode does not depend on
// rows or statistics: "before" is 0001 to 0004, "after" is every migration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { sqliteD1, MIGRATION_FILES, applyMigration } from './sqlite-d1.mjs';
import { recording, T } from './plan-fixture.mjs';
import { FLEET_SCOPE } from '../src/scope.js';
import { insertReport, applyTransition } from '../src/store.js';
import { upsertOpenItems, syncOpenSource } from '../src/store-open.js';
import { insertDirectItem, approveWork, withdrawWork, reviewWork } from '../src/store-work.js';
import { claimWork, heartbeatWork, releaseWork, submitWork, landWork } from '../src/store-work-runner.js';

const REF = { repo: 'balise-site', branch: 'balise/abcd1234-a1', commit: 'abc1234' };

/** Every write to `reports` the store makes, by name, as it sent it. */
async function captureWrites() {
  const db = recording(sqliteD1());
  const got = {};
  const take = async (picks, call) => {
    const from = db.seen.length;
    const out = await call();
    assert.ok(!out || !out.code, `a captured write failed: ${JSON.stringify(out)}`);
    const sent = db.seen.slice(from);
    for (const [name, pattern] of Object.entries(picks)) {
      const hits = sent.filter((s) => pattern.test(s.sql));
      assert.equal(hits.length, 1, `${name}: ${hits.length} statements matched ${pattern}`);
      got[name] = hits[0].sql;
    }
    return out;
  };
  const idOf = (ref) => db.sqlite.prepare('SELECT id FROM reports WHERE source_ref = ?').get(ref).id;
  const item = (closedAt) => [{ ref: '#1', text: 'An open item.', opened_at: T, closed_at: closedAt }];

  await take({ 'insertReport, a reader\'s report': /^\s*INSERT INTO reports/ }, () => insertReport(db, FLEET_SCOPE, {
    id: 'r-1', created_at: T, site: 'parla-site', url: 'https://example.test/r-1', target: null,
    kind: 'wrong', body: 'A report.', contact: null, ip_hash: null, fingerprint: 'fp-r-1',
  }));
  await take({ 'openImport, a new item': /^\s*INSERT INTO reports/ }, () => upsertOpenItems(db, { source: 'queue', items: item(null), now: T + 1 }));
  await take({ 'openImport, the close mark': /^\s*UPDATE reports SET source_closed_at = \?\s+WHERE app_id = 'fleet' AND fingerprint = \?/ }, () => upsertOpenItems(db, { source: 'queue', items: item(T + 2), now: T + 2 }));
  await take({ 'openImport, the reopen': /^\s*UPDATE reports SET source_closed_at = NULL/ }, () => upsertOpenItems(db, { source: 'queue', items: item(null), now: T + 3 }));
  await take({ 'applyTransition, any move': /^\s*UPDATE reports SET\s+status\s+=/ }, () => applyTransition(db, FLEET_SCOPE, {
    id: idOf('#1'), actor: 'human', patch: { status: 'accepted', public_note: 'Being looked at.' }, now: T + 4,
  }));

  const filed = await take({ 'insertDirectItem': /^\s*INSERT INTO reports/ }, () => insertDirectItem(db, { text: 'A direct item.', suggested: '', actor: 'human', now: T + 5 }));
  const id = filed.id;
  await take({ approveWork: /^\s*UPDATE reports SET work_state = 'approved', work_mode/ }, () => approveWork(db, { id, actor: 'human', mode: 'fix', instruction: '', now: T + 6 }));
  const first = await take({
    'claimWork, the sweep of rows': /^\s*UPDATE reports SET work_state = 'approved', work_lease_until = NULL, work_updated_at = \?\s+WHERE work_state IS NOT NULL/,
    'claimWork, the claim': /^\s*UPDATE reports SET work_state = 'claimed'/,
  }, () => claimWork(db, { actor: 'ai', runner: 'writes', id, leaseSeconds: 1800, now: T + 7 }));
  const run = first.item.work.run.id;
  await take({ heartbeatWork: /^\s*UPDATE reports SET work_lease_until = \?/ }, () => heartbeatWork(db, { id, actor: 'ai', run, leaseSeconds: 1800, now: T + 8 }));
  await take({ releaseWork: /^\s*UPDATE reports SET work_state = 'approved', work_lease_until = NULL, work_updated_at = \?\s+WHERE id = \?/ }, () => releaseWork(db, { id, actor: 'ai', run, note: '', now: T + 9 }));
  const second = (await claimWork(db, { actor: 'ai', runner: 'writes', id, leaseSeconds: 1800, now: T + 10 })).item.work.run.id;
  await take({ submitWork: /^\s*UPDATE reports SET work_state = 'review'/ }, () => submitWork(db, {
    id, actor: 'ai', run: second, outcome: 'fixed', summary: 'Done.', evidence: '', refs: [REF], needsLanding: true, suggestedNote: '', now: T + 11,
  }));
  await take({ reviewWork: /^\s*UPDATE reports SET work_state = \?/ }, () => reviewWork(db, { id, actor: 'human', decision: 'accept', note: '', now: T + 12 }));
  await take({ 'landWork, failed': /^\s*UPDATE reports SET work_state = 'review', work_updated_at/ }, () => landWork(db, { id, actor: 'ai', run: second, landed: false, refs: [], note: 'Main moved.', now: T + 13 }));
  await reviewWork(db, { id, actor: 'human', decision: 'accept', note: '', now: T + 14 });
  await take({ 'landWork, landed': /^\s*UPDATE reports SET work_state = 'done'/ }, () => landWork(db, { id, actor: 'ai', run: second, landed: true, refs: [REF], note: '', now: T + 15 }));

  const other = (await insertDirectItem(db, { text: 'Another direct item.', suggested: '', actor: 'human', now: T + 16 })).id;
  await approveWork(db, { id: other, actor: 'human', mode: 'investigate', instruction: '', now: T + 17 });
  await take({ withdrawWork: /^\s*UPDATE reports SET work_state = NULL/ }, () => withdrawWork(db, { id: other, actor: 'human', now: T + 18 }));

  await take({ 'openSync, the chunked close': /^\s*UPDATE reports SET source_closed_at = \?\s+WHERE app_id = 'fleet' AND source_closed_at IS NULL/ }, () => syncOpenSource(db, { source: 'queue', refs: [], now: T + 19 }));
  return got;
}

/** An empty database built from the migrations up to and including `last`. */
function schemaThrough(last) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of MIGRATION_FILES.filter((f) => f <= last)) applyMigration(sqlite, file);
  return sqlite;
}

/** The indexes of `reports` a statement compiles a write to, partial ones marked. */
function indexesWritten(sqlite, sql) {
  const byRoot = new Map(sqlite.prepare("SELECT rootpage, name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reports'").all().map((r) => [r.rootpage, r.name]));
  const partial = new Set(sqlite.prepare("SELECT name FROM pragma_index_list('reports') WHERE partial = 1").all().map((r) => r.name));
  const ops = sqlite.prepare(`EXPLAIN ${sql}`).all();
  const cursors = new Map();
  for (const op of ops) if (op.opcode === 'OpenWrite' && byRoot.has(op.p2)) cursors.set(op.p1, byRoot.get(op.p2));
  const written = new Set(ops.filter((op) => op.opcode === 'IdxInsert' && cursors.has(op.p1)).map((op) => cursors.get(op.p1)));
  return [...written].map((name) => (partial.has(name) ? `${name} (partial)` : name)).sort();
}

const BEFORE = schemaThrough('0004_tenants.sql');
const AFTER = schemaThrough(MIGRATION_FILES[MIGRATION_FILES.length - 1]);

// Measured 2026-11-03. `before` and `after` are how many of `reports`' index b-trees the
// statement writes on each schema, partial ones included; `added` is which of 0005's four. On
// 0004 the table has 20 indexes (19 named and the primary key's), on 0005 it has 24.
//
// READ IT AS: every INSERT pays for three of the four (the fourth is partial and skipped); a
// status move pays for the two that hold `status`; every work action pays for
// reports_app_work_updated, because each one stamps work_updated_at; and the import's and the
// sync's close marks pay for none, because no index holds source_closed_at.
const ALL_FOUR = ['reports_app_board', 'reports_app_kind_created', 'reports_app_kind_status_created', 'reports_app_work_updated (partial)'];
const WORK = ['reports_app_work_updated (partial)'];
const WRITES = {
  "insertReport, a reader's report": { before: 20, after: 24, added: ALL_FOUR },
  'openImport, a new item': { before: 20, after: 24, added: ALL_FOUR },
  'openImport, the close mark': { before: 0, after: 0, added: [] },
  'openImport, the reopen': { before: 0, after: 0, added: [] },
  'applyTransition, any move': { before: 9, after: 11, added: ['reports_app_board', 'reports_app_kind_status_created'] },
  insertDirectItem: { before: 20, after: 24, added: ALL_FOUR },
  approveWork: { before: 1, after: 2, added: WORK },
  'claimWork, the sweep of rows': { before: 1, after: 2, added: WORK },
  'claimWork, the claim': { before: 2, after: 3, added: WORK },
  heartbeatWork: { before: 1, after: 2, added: WORK },
  releaseWork: { before: 1, after: 2, added: WORK },
  submitWork: { before: 1, after: 2, added: WORK },
  reviewWork: { before: 1, after: 2, added: WORK },
  'landWork, failed': { before: 1, after: 2, added: WORK },
  'landWork, landed': { before: 1, after: 2, added: WORK },
  withdrawWork: { before: 1, after: 2, added: WORK },
  'openSync, the chunked close': { before: 0, after: 0, added: [] },
};

test('#139 item 5: the index writes each statement compiles to, before and after 0005', async () => {
  const writes = await captureWrites();
  const measured = {};
  for (const [name, sql] of Object.entries(writes)) {
    const before = indexesWritten(BEFORE, sql);
    const after = indexesWritten(AFTER, sql);
    measured[name] = { before: before.length, after: after.length, added: after.filter((i) => !before.includes(i)) };
  }
  assert.deepEqual(measured, WRITES, 'a write to reports now maintains a different set of indexes');
});

test('#139 item 5: the proxy counts what it says it counts', () => {
  // The two schema counts the pins above are read against, so a migration that adds an index
  // shows up here by name before it shows up as a puzzling number.
  const names = (sqlite) => sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reports'").all().map((r) => r.name);
  assert.equal(names(BEFORE).length, 20);
  assert.deepEqual(names(AFTER).filter((n) => !names(BEFORE).includes(n)).sort(),
    ['reports_app_board', 'reports_app_kind_created', 'reports_app_kind_status_created', 'reports_app_work_updated']);
  // An INSERT writes every index, which is the sanity check on the opcode reading itself.
  const insert = "INSERT INTO reports (id, created_at, site, url, kind, body, fingerprint) VALUES ('x', 1, 's', 'u', 'wrong', 'b', 'f')";
  assert.equal(indexesWritten(AFTER, insert).length, names(AFTER).length);
});
