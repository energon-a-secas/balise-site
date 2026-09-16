// The open-items store and its two board reads, over node:sqlite (tests/sqlite-d1.mjs), for
// what no pair of HTTP requests can interleave and no healthy local D1 will do: a filing that
// lands between two INSERTs of one import, a close mark a sync left and the next import has to
// clear, a resolution the operator kept private, and a store that stops answering.
//
// The real store functions, the real routes and the real router run here, with nothing
// installed and nothing listening. The flows themselves are in tests/open-items.test.mjs and
// tests/work-guards.test.mjs, against a real D1 under workerd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sqliteD1 } from './sqlite-d1.mjs';
import { originVerdict } from '../src/envelope.js';
import { validatePatch } from '../src/validate.js';
import { STATUSES, listReports, applyTransition } from '../src/store.js';
import { IMPORT_BATCH_MAX, upsertOpenItems, board, boardSummary, dayStamp } from '../src/store-open.js';
import { insertDirectItem } from '../src/store-work.js';
import { openImport, openSync } from '../src/routes-open.js';
import worker from '../src/index.js';

const T = 1_757_000_000_000;
const WORKER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** D1's two per-invocation limits this file's writes have to stay inside. */
const D1_STATEMENTS_MAX = 50;
const D1_PARAMS_MAX = 100;

/** An import's INSERT. A direct filing's names filed_by second, so it never matches. */
const IMPORT_INSERT = /INSERT INTO reports\s+\(id, created_at,/;

const lines = (from, count, over = {}) =>
  Array.from({ length: count }, (_, n) => ({ ref: `#${from + n}`, text: `Tracker line ${from + n}.`, ...over }));

const openTimes = (db) => db.sqlite.prepare("SELECT created_at FROM reports WHERE kind = 'open'").all().map((r) => r.created_at);

const mark = (db, ref) =>
  db.sqlite.prepare("SELECT source_closed_at FROM reports WHERE kind = 'open' AND source_ref = ?").get(ref).source_closed_at;

/** Statements sent since `from`, and the most parameters any one of them bound. */
function spent(db, from) {
  const sent = db.log.slice(from);
  return { statements: sent.length, params: Math.max(0, ...sent.map((sql) => (sql.match(/\?/g) || []).length)) };
}

/** How many open rows the desk's Open items list reaches, `limit` to a page. */
async function reached(db, limit) {
  const ids = new Set();
  let before = null;
  for (let page = 0; page < 100; page += 1) {
    const out = await listReports(db, { status: null, kind: 'open', before, limit });
    assert.equal(out.code, undefined, JSON.stringify(out));
    out.reports.forEach((r) => ids.add(r.id));
    if (!out.next) break;
    before = out.next;
  }
  return ids.size;
}

/** A route's answer, read the way the importer reads it. */
async function answer(response) {
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

// ── created_at ────────────────────────────────────────────────────────────────

test('an import batch is one read and one write per item, and every row it writes has its own created_at', async () => {
  const db = sqliteD1();
  let from = db.log.length;
  assert.deepEqual(
    await upsertOpenItems(db, { source: 'queue', items: lines(1, IMPORT_BATCH_MAX), now: T }),
    { created: IMPORT_BATCH_MAX, unchanged: 0, closed: 0, reopened: 0 },
  );
  const full = spent(db, from);
  assert.equal(full.statements, IMPORT_BATCH_MAX + 1, 'a full batch sent more than one read plus one write per item');
  assert.ok(full.statements <= D1_STATEMENTS_MAX && full.params <= D1_PARAMS_MAX, JSON.stringify(full));

  // A second batch in the same millisecond, then the first again, which has nothing to write.
  await upsertOpenItems(db, { source: 'harness', items: lines(101, IMPORT_BATCH_MAX), now: T });
  from = db.log.length;
  assert.deepEqual(
    await upsertOpenItems(db, { source: 'queue', items: lines(1, IMPORT_BATCH_MAX), now: T }),
    { created: 0, unchanged: IMPORT_BATCH_MAX, closed: 0, reopened: 0 },
  );
  assert.equal(spent(db, from).statements, 1, 'a batch with nothing to write sent more than its one read');

  const times = openTimes(db);
  assert.equal(times.length, 2 * IMPORT_BATCH_MAX);
  assert.equal(new Set(times).size, times.length, 'two imported rows share a created_at');
  assert.ok(times.every((t) => t >= T), 'a row was stamped before its request');
});

test('REG 0: a filing that lands between two INSERTs of an import gets a created_at of its own, so paging reaches every row', async () => {
  const db = sqliteD1();
  // Two filings, run just before the import's second and fourth INSERTs: one whose request
  // took its clock before the import's, one after. The batch used to count up from a MAX it
  // read once, so each filing took the value the next INSERT then wrote as well.
  const filedAt = { 2: T - 5, 4: T + 3 };
  let inserts = 0;
  const arm = () => db.beforeStatement(IMPORT_INSERT, async () => {
    inserts += 1;
    if (filedAt[inserts] !== undefined) {
      const text = `A follow-up filed during insert ${inserts} of an import.`;
      const filed = await insertDirectItem(db, { text, suggested: '', actor: 'ai', now: filedAt[inserts] });
      assert.ok(filed.id, JSON.stringify(filed));
    }
    arm();
  });
  arm();
  assert.equal((await upsertOpenItems(db, { source: 'queue', items: lines(1, 6), now: T })).created, 6);
  assert.equal(inserts, 6, 'the hook did not run before every INSERT of the import');

  const times = openTimes(db);
  assert.equal(times.length, 8);
  assert.equal(new Set(times).size, 8, 'a direct filing and an imported row share a created_at');
  for (const limit of [1, 2, 3]) assert.equal(await reached(db, limit), 8, `paging ${limit} to a page lost a row`);
});

// ── The close mark ────────────────────────────────────────────────────────────

test('RECHECK 66: a sync naming one ref closes a whole source, and the next honest import clears every mark it left, and no other', async () => {
  const db = sqliteD1();
  const env = { DB: db };
  const DONE_AT = Date.UTC(2026, 8, 3);
  const run = (items, now) => openImport(env, { v: 1, source: 'queue', items }, { origin: null, now }).then(answer);
  const sync = (refs, now) => openSync(env, { source: 'queue', refs }, { origin: null, now }).then(answer);

  // The tracker: #1 to #24 open and #25 done in one batch, and #26 open in a second.
  const tracker = [...lines(1, 24), ...lines(25, 1, { closed_at: DONE_AT })];
  await run(tracker, T);
  await run(lines(26, 1), T + 1);

  // One call from the automation credential, naming a single ref.
  assert.deepEqual(await sync(['#1'], T + 2), { ok: true, provider: 'desk', source: 'queue', closed: 24 });

  // The honest run. #26 has left the tracker, so neither its batch nor its sync names it.
  const from = db.log.length;
  assert.deepEqual(
    await run(tracker, T + 3),
    { ok: true, provider: 'desk', source: 'queue', created: 0, unchanged: 2, closed: 0, reopened: 23 },
  );
  const healing = spent(db, from);
  assert.equal(healing.statements, 1 + 23, 'the healing batch sent more than one read plus one write per mark');
  assert.ok(healing.statements <= D1_STATEMENTS_MAX && healing.params <= D1_PARAMS_MAX, JSON.stringify(healing));

  // The sync lists the done line too, because it lists every ref seen. That is not evidence
  // the item is open, so it clears nothing.
  assert.deepEqual(await sync(tracker.map((i) => i.ref), T + 4), { ok: true, provider: 'desk', source: 'queue', closed: 0 });

  for (let n = 1; n <= 24; n += 1) assert.equal(mark(db, `#${n}`), null, `#${n} is open in its tracker and still marked closed`);
  assert.equal(mark(db, '#25'), DONE_AT, 'the done line lost the date its tracker closed it on');
  assert.equal(mark(db, '#26'), T + 2, 'a ref the tracker no longer lists was reopened');
});

// ── The board's two remaining guards (#56) ────────────────────────────────────

test('RECHECK 56: a resolution kept private is never the summary\'s latest, however much newer it is', async () => {
  const db = sqliteD1();
  await upsertOpenItems(db, { source: 'queue', items: lines(1, 2), now: T });
  // The path PATCH /reports/:id takes for the operator's credential: validatePatch, then
  // applyTransition as the human actor. The desk's own buttons never send public: false with
  // a resolution; the credential may, and the query has to stand up to what it may send.
  const resolve = async (ref, body, now) => {
    const { id } = db.sqlite.prepare('SELECT id FROM reports WHERE source_ref = ?').get(ref);
    const patch = validatePatch({ status: 'fixed', ...body }, STATUSES);
    assert.equal(patch.code, undefined, JSON.stringify(patch));
    const out = await applyTransition(db, { id, actor: 'human', patch: patch.value, now });
    assert.equal(out.code, undefined, JSON.stringify(out));
    return out.report;
  };
  const shown = 'The public resolution a reader may see.';
  await resolve('#1', { public_note: shown }, T + 10);
  const hidden = await resolve('#2', { public: false, public_note: 'A resolution the operator kept off the board.' }, T + 20);
  assert.equal(hidden.status, 'fixed');
  assert.equal(hidden.public, false);
  assert.ok(hidden.fixed_at > T + 10, 'the private resolution is not the newer one, so this proves nothing');

  const summary = await boardSummary(db, { now: T + 30 });
  assert.deepEqual(summary.latest, { text: shown, date: dayStamp(T + 10) }, 'the summary led with a resolution nobody published');
  assert.equal(summary.resolved, 1);
  assert.deepEqual((await board(db)).resolved.map((e) => e.text), [shown]);
});

test('RECHECK 56: both board reads answer a store that is down with STORE_ERROR, readable from any origin', async () => {
  const toml = readFileSync(join(WORKER_DIR, 'wrangler.toml'), 'utf8');
  const allowed = /^BALISE_ALLOWED_ORIGINS\s*=\s*"([^"]*)"/m.exec(toml)[1];
  const down = () => { throw new Error('D1 did not answer'); };
  const statement = { bind: () => statement, run: async () => down(), all: async () => down(), first: async () => down() };
  const env = { DB: { prepare: () => statement, batch: async () => down() }, BALISE_ALLOWED_ORIGINS: allowed };
  const ELSEWHERE = 'https://another-section.example';
  assert.equal(originVerdict(ELSEWHERE, env), 'denied', 'the test origin is on the allowlist, so this proves nothing');

  const logged = [];
  const error = console.error;
  console.error = (...args) => logged.push(String(args[0]));
  try {
    for (const [path, where] of [['/board', 'd1 board failed:'], ['/board/summary', 'd1 board summary failed:']]) {
      logged.length = 0;
      const res = await worker.fetch(new Request(`https://balise-api.test${path}`, { headers: { Origin: ELSEWHERE } }), env);
      const body = await res.json();
      assert.equal(res.status, 502, path);
      assert.equal(body.code, 'STORE_ERROR', path);
      assert.equal(body.provider, 'log', path);
      assert.equal(res.headers.get('access-control-allow-origin'), '*', `${path} made its store error unreadable from another origin`);
      // The route answered, and not the never-500 wrapper, whose answer carries no CORS header.
      assert.deepEqual(logged, [where], path);
    }
  } finally {
    console.error = error;
  }
});
