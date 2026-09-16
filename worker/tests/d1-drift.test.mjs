// The guard that catches a local D1 built by a migration that has since changed (queue #82).
//
// EVERY TEST HERE EXISTS TO TRIP IT. A check that cannot be made to fail is worse than no
// check, because it gets quoted: on 2026-09-16 `make d1-migrate` said "No migrations to
// apply!" about a database with no reports.filed_by column, and that sentence was believed
// until every GET /reports answered 502 STORE_ERROR.
//
// The last two tests run the file the Makefile runs, on stdin, and read its exit code. The
// ones before them exercise the comparison directly, including the case that actually
// happened, so a failure says which half is wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  SCHEMA_QUERY, FIX, declaredSchema, localSchema, drift, report,
} from '../../tools/d1-drift.mjs';

const SCRIPT = fileURLToPath(new URL('../../tools/d1-drift.mjs', import.meta.url));

/** A copy of a schema, so a test can take something out of it without touching the real one. */
const copy = (schema) => new Map([...schema].map(([t, c]) => [t, new Set(c)]));

/** What `wrangler d1 execute --json` prints for SCHEMA_QUERY, given a schema. */
function payload(schema) {
  const results = [];
  for (const [t, columns] of schema) for (const c of columns) results.push({ t, c });
  return JSON.stringify([{ results, success: true, meta: { duration: 1 } }]);
}

/** The script, as the Makefile runs it: schema on stdin, verdict on stdout. */
function run(stdin) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT], { input: stdin, encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: err.stdout };
  }
}

test('the wanted shape is the migrations, columns and all', () => {
  const want = declaredSchema();
  assert.deepEqual([...want.keys()].sort(), ['auth_attempts', 'reports', 'submit_counters', 'work_runs']);
  // The column whose absence was the whole of #82, and one from each earlier migration.
  assert.ok(want.get('reports').has('filed_by'), 'reports.filed_by, added to 0003 in place');
  assert.ok(want.get('reports').has('suggested'), 'reports.suggested, from 0002');
  assert.ok(want.get('reports').has('ip_hash'), 'reports.ip_hash, from the baseline');
  assert.ok(want.get('work_runs').has('suggested_note'));
  // Bookkeeping is excluded by the statement itself, because D1 refuses to read past it.
  assert.equal(want.has('d1_migrations'), false);
});

test('a schema against itself is no drift', () => {
  const want = declaredSchema();
  assert.deepEqual(drift(want, copy(want)), { missing: [], extra: [] });
  assert.equal(report(drift(want, copy(want))), 'the local D1 matches worker/migrations');
});

test('the 2026-09-16 drift: 0003 gained filed_by after this database applied it', () => {
  const want = declaredSchema();
  const got = copy(want);
  got.get('reports').delete('filed_by');
  const found = drift(want, got);
  assert.deepEqual(found, { missing: ['reports.filed_by'], extra: [] });
  const said = report(found);
  assert.match(said, /missing {2}reports\.filed_by/);
  assert.match(said, /make d1-reset/, 'and it names the command that ends it');
});

test('a whole table the database never got is one line, not one per column', () => {
  const want = declaredSchema();
  const got = copy(want);
  got.delete('work_runs');
  assert.deepEqual(drift(want, got), { missing: ['work_runs'], extra: [] });
});

test('a column the migrations no longer declare is drift too', () => {
  // The other direction: a migration edited to REMOVE something leaves a database ahead of
  // its own files, which is the same fault and the same fix.
  const want = declaredSchema();
  const got = copy(want);
  got.get('reports').add('work_priority');
  got.set('work_locks', new Set(['id']));
  const found = drift(want, got);
  assert.deepEqual(found, { missing: [], extra: ['reports.work_priority', 'work_locks'] });
  assert.match(report(found), /unknown {2}reports\.work_priority/);
});

test('SCHEMA_QUERY is a statement sqlite will actually run', () => {
  // The query lives in one place and is handed to wrangler by the Makefile, so nothing else
  // proves it still parses. A typo in it would otherwise read as an unreadable database.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE reports (id TEXT PRIMARY KEY, filed_by TEXT)');
  assert.deepEqual(db.prepare(SCHEMA_QUERY).all().map((r) => `${r.t}.${r.c}`),
    ['reports.id', 'reports.filed_by']);
  db.close();
});

test("wrangler's own failures are read as failures, not as an empty database", () => {
  // --json prints an error object on stdout and the pipe swallows the exit code, so an
  // unreadable database has to be told from a database with nothing in it.
  assert.throws(() => localSchema('{"error":{"text":"not authorized: SQLITE_AUTH"}}'),
    /could not read the local database: not authorized/);
  assert.throws(() => localSchema('\n✅ no migrations to apply!\n'), /printed no JSON/);
  assert.throws(() => localSchema('[{"results":[],"success":true}]'), /none of the migrations/);
  assert.match(FIX, /make d1-reset/);
});

test('the script exits 0 on a database that matches', () => {
  const { code, out } = run(payload(declaredSchema()));
  assert.equal(code, 0, out);
  assert.match(out, /matches worker\/migrations/);
});

test('the script exits 1 on the drift, naming the column and the fix', () => {
  const got = copy(declaredSchema());
  got.get('reports').delete('filed_by');
  const { code, out } = run(payload(got));
  assert.equal(code, 1, out);
  assert.match(out, /missing {2}reports\.filed_by/);
  assert.match(out, /make d1-reset/);
});

test('--query prints the statement and reads nothing', () => {
  const out = execFileSync('node', [SCRIPT, '--query'], { encoding: 'utf8' });
  assert.equal(out.trim(), SCHEMA_QUERY);
});
