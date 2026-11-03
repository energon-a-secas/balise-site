// scripts/release-work-queue.sh has to say what it applies (queue #138).
//
// The script computes the migrations it applies from `git ls-tree` at the release commit, so it
// applies whatever worker/migrations holds. For a while its screens said "0002 and 0003" while
// it would also have applied 0004_tenants.sql and 0005_indexes.sql, its hand-edited-database
// guard covered two columns, and its post-check read back three. It now narrates and checks
// every file from two tables, migration_note and migration_objects, and stage 2 refuses a
// migration missing from either.
//
// These tests are what keep those tables true. Each one runs the script's own shell functions,
// cut out of the script by name, against a database built from worker/migrations over
// node:sqlite one file at a time, so "what a migration creates" is measured and not read from
// its comments. A new 0006 that nobody narrated turns the first two red, and so does an index
// added to the post-check's list that no migration creates. Stage 1 of the release runs this
// suite, so a red here stops the release before it reads production.
//
// No database other than :memory: and no network: this is a test of the script's text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/release-work-queue.sh', import.meta.url));
const SOURCE = readFileSync(SCRIPT, 'utf8');
const FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

/** One shell function's definition, cut out of the script: a one-liner, or up to its closing `}`. */
function shellFunction(name) {
  const lines = SOURCE.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}() `));
  assert.ok(start >= 0, `scripts/release-work-queue.sh defines no ${name}()`);
  if (lines[start].trimEnd().endsWith('}')) return lines[start];
  const end = lines.findIndex((line, i) => i > start && line === '}');
  assert.ok(end > start, `${name}() in scripts/release-work-queue.sh has no closing brace`);
  return lines.slice(start, end + 1).join('\n');
}

const DEFS = ['has_col', 'migration_note', 'migration_objects', 'migration_counts', 'tenant_indexes', 'has_object']
  .map(shellFunction)
  .join('\n');

/** Runs `body` under bash with the script's functions defined and its shell options set. */
function sh(body, args = [], vars = {}) {
  const env = { ...process.env, MIGRATIONS: '', COLS: '', OBJECTS: '', ...vars };
  const res = spawnSync('bash', ['-c', `set -uo pipefail\n${DEFS}\n${body}`, 'release-script-test', ...args], {
    encoding: 'utf8', env,
  });
  assert.equal(res.error, undefined, `could not run bash: ${res.error}`);
  return { code: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
}

const lines = (text) => text.split('\n').filter(Boolean);

/**
 * One function run once per name, in a single bash, so the suite does not pay a process per
 * migration: a Map of name to { code, out }. Records are split on ASCII RS and fields on US,
 * written as escapes on both sides.
 */
function eachFile(fn, names = FILES) {
  const body = `for f in "$@"; do out=$(${fn} "$f"); code=$?; printf '\\036%s\\037%s\\037%s' "$f" "$code" "$out"; done`;
  const res = sh(body, names);
  assert.equal(res.code, 0, res.err);
  const results = new Map();
  for (const record of res.out.split('\x1e').filter(Boolean)) {
    const [name, code, out] = record.split('\x1f');
    results.set(name, { code: Number(code), out: out.trim() });
  }
  assert.deepEqual([...results.keys()], names);
  return results;
}

/** Every table, index and column in the database, as the kind:name strings the script uses. */
function snapshot(db) {
  const names = new Set();
  const rows = db.prepare(`SELECT type, name FROM sqlite_master
    WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'`).all();
  for (const { type, name } of rows) {
    names.add(`${type}:${name}`);
    if (type !== 'table') continue;
    for (const col of db.prepare('SELECT name FROM pragma_table_info(?)').all(name)) {
      names.add(`column:${name}.${col.name}`);
    }
  }
  return names;
}

/**
 * What each migration creates, measured: the database before and after applying it, one file
 * at a time. A table counts once, as the table; a column counts only when it is added to a
 * table that already existed, which is the one statement that can collide on production.
 */
function measure() {
  const db = new DatabaseSync(':memory:');
  const created = new Map();
  let before = snapshot(db);
  for (const file of FILES) {
    db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'));
    const after = snapshot(db);
    const fresh = [...after].filter((name) => !before.has(name));
    const tables = new Set(fresh.filter((n) => n.startsWith('table:')).map((n) => n.slice('table:'.length)));
    created.set(file, fresh.filter((n) => !(n.startsWith('column:') && tables.has(n.slice('column:'.length).split('.')[0]))).sort());
    before = after;
  }
  return { db, created };
}

const MEASURED = measure();

test('every migration file has a note and an object list, and an unknown one has neither', () => {
  const unknown = '0099_unnamed.sql';
  const notes = eachFile('migration_note', [...FILES, unknown]);
  const objects = eachFile('migration_objects', [...FILES, unknown]);
  for (const file of FILES) {
    assert.equal(notes.get(file).code, 0, `${file} has no migration_note entry in scripts/release-work-queue.sh`);
    assert.ok(notes.get(file).out.length > 0, `${file}'s migration_note is empty`);
    assert.equal(objects.get(file).code, 0, `${file} has no migration_objects entry in scripts/release-work-queue.sh`);
  }
  // Stage 2's stop depends on both functions failing for a name they do not know.
  assert.notEqual(notes.get(unknown).code, 0);
  assert.notEqual(objects.get(unknown).code, 0);
});

test('migration_objects lists exactly what each migration creates', () => {
  const objects = eachFile('migration_objects');
  for (const file of FILES) {
    const listed = lines(objects.get(file).out).sort();
    const created = MEASURED.created.get(file);
    assert.deepEqual(listed, created,
      `migration_objects ${file} in scripts/release-work-queue.sh disagrees with the file. It creates:\n  ${created.join('\n  ')}`);
  }
});

test('every column a migration adds is on reports, the one table the post-check reads columns from', () => {
  for (const [file, created] of MEASURED.created) {
    for (const name of created.filter((n) => n.startsWith('column:'))) {
      assert.ok(name.startsWith('column:reports.'),
        `${file} adds ${name}: teach has_object and stage 3's read-back in scripts/release-work-queue.sh that table`);
    }
  }
});

test('every migration statement only adds, which the way back and the column-only guard both assume', () => {
  const shapes = [
    /^CREATE TABLE IF NOT EXISTS \w+ ?\(/i,
    /^CREATE (UNIQUE )?INDEX IF NOT EXISTS \w+ ON \w+ ?\(/i,
    /^ALTER TABLE \w+ ADD COLUMN \w+ /i,
    /^PRAGMA optimize$/i,
  ];
  for (const file of FILES) {
    const text = readFileSync(MIGRATIONS_DIR + file, 'utf8');
    const statements = text.replace(/--[^\n]*/g, '').split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    assert.ok(statements.length > 0, `${file} holds no statement`);
    for (const statement of statements) {
      assert.ok(shapes.some((shape) => shape.test(statement)),
        `${file} holds a statement that does not only add, and the release script's way back says every migration does:\n  ${statement.slice(0, 120)}`);
    }
    // Stage 3 finds PRAGMA optimize with grep -x on the whole line, so it has to be one.
    if (statements.some((s) => /^PRAGMA optimize$/i.test(s))) {
      assert.match(text, /^PRAGMA optimize;$/m, `${file}'s PRAGMA optimize is not on a line of its own`);
    }
  }
});

test('an index on reports leads on app_id exactly when its name starts reports_app_, the rule tenant_indexes counts by', () => {
  const indexes = MEASURED.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reports'").all();
  let leading = 0;
  for (const { name } of indexes) {
    const first = MEASURED.db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno LIMIT 1').get(name);
    const leads = first?.name === 'app_id';
    assert.equal(name.startsWith('reports_app_'), leads,
      `${name} ${leads ? 'leads on app_id but is not' : 'is'} named reports_app_*, so the way back miscounts the tenant indexes`);
    if (leads) leading += 1;
  }
  const counted = sh('tenant_indexes', [], { MIGRATIONS: FILES.join('\n') });
  assert.equal(Number(counted.out), leading);
});

test('migration_counts counts what migration_objects lists', () => {
  const words = [['column', 'columns'], ['table', 'tables'], ['index', 'indexes']];
  const counts = eachFile('migration_counts');
  for (const [file, created] of MEASURED.created) {
    const expected = words
      .map(([one, many]) => [created.filter((n) => n.startsWith(`${one}:`)).length, one, many])
      .filter(([n]) => n > 0)
      .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
      .join(', ') || 'nothing new';
    assert.equal(counts.get(file).out, expected, file);
  }
});

test('the #76 gate runs against the module that exports publicLog, and says so when it cannot', () => {
  // The gate imported src/store.js for a month after publicLog moved to src/store-public.js,
  // and reported the missing export as "#76 is not in this tree", which stopped the release at
  // every commit while reading like the privacy fix was absent.
  const module = SOURCE.match(/^GATE76_MODULE=(\S+)$/m);
  const code = SOURCE.match(/^NODE_GATE76='([^']*)'$/m);
  assert.ok(module && code, 'scripts/release-work-queue.sh no longer defines GATE76_MODULE and NODE_GATE76');
  const gate = (path) => spawnSync(process.execPath, ['--input-type=module', '-e', code[1], path], { encoding: 'utf8' }).status;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(gate(root + module[1]), 0, `the #76 gate fails against ${module[1]} in this tree`);
  // A module with no publicLog is "could not run the check" (3), never "publishes too much" (1).
  assert.equal(gate(root + 'worker/src/scope.js'), 3);
});

test('the post-check finds every name on a fully migrated database and misses one that is gone', () => {
  const all = [...MEASURED.created.values()].flat();
  const cols = MEASURED.db.prepare("SELECT name FROM pragma_table_info('reports')").all().map((r) => r.name);
  const objects = MEASURED.db.prepare("SELECT type || ':' || name AS name FROM sqlite_master WHERE type IN ('table', 'index')")
    .all().map((r) => r.name);
  const check = 'for o in "$@"; do has_object "$o" || echo "missing $o"; done';

  const full = sh(check, all, { COLS: cols.join('\n'), OBJECTS: objects.join('\n') });
  assert.equal(full.code, 0, full.err);
  assert.equal(full.out, '', 'has_object misses names a fully migrated database holds');

  // What a database that recorded 0004 and 0005 without holding all of them looks like.
  const gone = sh(check, all, {
    COLS: cols.filter((c) => c !== 'app_key_id').join('\n'),
    OBJECTS: objects.filter((o) => o !== 'index:reports_app_board' && o !== 'table:app_keys').join('\n'),
  });
  assert.deepEqual(lines(gone.out).sort(),
    ['missing column:reports.app_key_id', 'missing index:reports_app_board', 'missing table:app_keys']);
});
