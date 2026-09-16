#!/usr/bin/env node
// The local D1's shape against the migrations that were supposed to build it.
//
//   make d1-check                     compare, and name the fix when they disagree
//   node tools/d1-drift.mjs --query   print the one statement the check reads
//
// WHY THIS EXISTS. Wrangler records an applied migration BY FILE NAME and never runs it
// again, so a migration edited after it was applied stays applied: `make d1-migrate`
// answers "No migrations to apply!" and the column the file gained is still missing. On
// 2026-09-16 that column was reports.filed_by, and the operator met it as a 502
// STORE_ERROR from every GET /reports, days after the file had changed (queue #82).
//
// The rule that follows is in docs/DESIGN-WORK-QUEUE.md section 4: a migration may be
// edited while nothing but a local desk has applied it, and is frozen the moment the remote
// records it. Editing an unreleased migration is cheap. A local database silently behind
// one is not, and that is what this catches, at the moment it is created.
//
// WHAT IT COMPARES. The wanted shape is the migrations applied to an in-memory sqlite, the
// way worker/tests/sqlite-d1.mjs already builds a store, so nothing here parses SQL. The
// present shape arrives on stdin, because every D1 command in this project lives behind a
// Makefile target that spells out --local (the Makefile's D1 section says why): that target
// hands wrangler the statement this file prints, and pipes the answer back.
//
// TABLES AND COLUMNS ONLY. D1's authorizer answers SQLITE_AUTH for pragma_index_list, and
// for pragma_table_info on its own bookkeeping tables, so one authorized statement cannot
// also ask about indexes. Every index in the migrations is CREATE INDEX IF NOT EXISTS, so
// re-applying a migration restores a missing one; a column added by an ALTER never comes
// back that way, and a missing column is the one that answers 502.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS = join(HERE, '..', 'worker', 'migrations');

/** Every table and column, one row per column, as `{ t, c }`.
 *
 *  The bookkeeping tables are excluded in the SQL rather than by the reader, because the
 *  filter is what makes the statement runnable at all: D1 refuses pragma_table_info on
 *  _cf_METADATA, and refuses the whole statement with it, so a query that reaches that
 *  table returns SQLITE_AUTH and no schema. */
export const SCHEMA_QUERY = "SELECT m.name AS t, p.name AS c"
  + " FROM sqlite_master m, pragma_table_info(m.name) p"
  + " WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite%'"
  + " AND substr(m.name, 1, 4) <> '_cf_' AND m.name <> 'd1_migrations'";

/** The fix, in one line, because the check exists to save the operator from guessing it. */
export const FIX = 'Run: make d1-reset'
  + '   (drops the local tables and d1_migrations, then applies every migration again)';

/** table -> Set of its column names, from SCHEMA_QUERY's rows. */
function schemaFrom(rows) {
  const tables = new Map();
  for (const { t, c } of rows) {
    if (!tables.has(t)) tables.set(t, new Set());
    tables.get(t).add(c);
  }
  return tables;
}

/** The shape worker/migrations produces, by applying them in name order to :memory:. */
export function declaredSchema(dir = MIGRATIONS) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) throw new Error(`no migrations in ${dir}`);
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of files) db.exec(readFileSync(join(dir, file), 'utf8'));
    return schemaFrom(db.prepare(SCHEMA_QUERY).all());
  } finally {
    db.close();
  }
}

/** The shape the local D1 has, from what `wrangler d1 execute --json` printed.
 *
 *  Wrangler prints its errors as JSON on stdout too, and the pipe swallows its exit code,
 *  so an error payload has to be read as one rather than as an empty schema. */
export function localSchema(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`wrangler printed no JSON:\n${text.trim()}`);
  }
  if (!Array.isArray(payload)) {
    const said = payload && payload.error
      ? payload.error.text || JSON.stringify(payload.error)
      : JSON.stringify(payload);
    throw new Error(`wrangler could not read the local database: ${said}`);
  }
  const rows = payload.flatMap((set) => set.results || []);
  if (!rows.length) throw new Error(`the local database has none of the migrations' tables.\n${FIX}`);
  return schemaFrom(rows);
}

/** What the two disagree about: `table` for a whole table, `table.column` for one column.
 *
 *  `missing` is what the migrations declare and the database has not, `extra` what the
 *  database has and the migrations no longer declare. Both are drift, and both have the
 *  same cause: a migration file that changed after this database applied it. */
export function drift(want, got) {
  const missing = [];
  const extra = [];
  for (const [table, columns] of want) {
    if (!got.has(table)) { missing.push(table); continue; }
    for (const column of columns) if (!got.get(table).has(column)) missing.push(`${table}.${column}`);
  }
  for (const [table, columns] of got) {
    if (!want.has(table)) { extra.push(table); continue; }
    for (const column of columns) if (!want.get(table).has(column)) extra.push(`${table}.${column}`);
  }
  return { missing, extra };
}

/** What the operator reads. Names every difference, then the one command that ends it. */
export function report({ missing, extra }) {
  if (!missing.length && !extra.length) return 'the local D1 matches worker/migrations';
  const lines = ['the local D1 does not match worker/migrations:'];
  for (const name of missing) lines.push(`  missing  ${name}`);
  for (const name of extra) lines.push(`  unknown  ${name}`);
  lines.push('', 'A migration changed after this database applied it, so wrangler will not run it again.', FIX);
  return lines.join('\n');
}

// Run directly: `--query` prints the statement for the Makefile to give wrangler, and
// anything else reads wrangler's answer on stdin. Imported, by worker/tests/d1-drift.test.mjs,
// this does nothing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--query')) {
    process.stdout.write(`${SCHEMA_QUERY}\n`);
  } else {
    try {
      const found = drift(declaredSchema(), localSchema(readFileSync(0, 'utf8')));
      process.stdout.write(`${report(found)}\n`);
      if (found.missing.length || found.extra.length) process.exitCode = 1;
    } catch (err) {
      process.stdout.write(`${err.message}\n`);
      process.exitCode = 1;
    }
  }
}
