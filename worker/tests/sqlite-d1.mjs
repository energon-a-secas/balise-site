// A D1 binding over node:sqlite, for the races no pair of HTTP requests can interleave. NOT a
// *.test.mjs file, so `node --test tests/*.test.mjs` never runs it as a suite.
//
// It is built from worker/migrations, so it has the schema the Worker has, and a batch runs
// in one transaction the way D1's does. What it adds is a hook: another request's writes run
// once, at a chosen point, before the next batch or before the next single statement whose
// SQL matches. That is the only reason this file exists. The flows themselves are tested
// against a real D1 under workerd, because this is not one.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'migrations');

export function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  const hooks = { batch: null, statements: [] };
  const log = [];

  const exec = (sql, params) => {
    // D1 refuses an undefined binding, so a store function that sends one must fail here too.
    params.forEach((value, i) => {
      if (value === undefined) throw new Error(`undefined bound at position ${i + 1}:\n${sql}`);
    });
    log.push(sql);
    const statement = sqlite.prepare(sql);
    if (statement.columns().length) {
      const results = statement.all(...params).map((row) => ({ ...row }));
      return { success: true, results, meta: { changes: 0, rows_read: results.length } };
    }
    const { changes } = statement.run(...params);
    return { success: true, results: [], meta: { changes: Number(changes), rows_read: 0 } };
  };

  const fire = async (sql) => {
    const at = hooks.statements.findIndex((hook) => hook.match.test(sql));
    if (at >= 0) await hooks.statements.splice(at, 1)[0].run();
  };

  const bound = (sql, params = []) => ({
    sql,
    params,
    bind: (...values) => bound(sql, values),
    run: async () => { await fire(sql); return exec(sql, params); },
    all: async () => { await fire(sql); return exec(sql, params); },
    first: async (column) => {
      await fire(sql);
      const row = exec(sql, params).results[0];
      if (row === undefined) return null;
      return column ? row[column] : row;
    },
  });

  return {
    sqlite,
    log,
    prepare: (sql) => bound(sql),
    async batch(statements) {
      if (hooks.batch) {
        const run = hooks.batch;
        hooks.batch = null;
        await run();
      }
      sqlite.exec('BEGIN');
      try {
        const out = statements.map((s) => exec(s.sql, s.params));
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    /** Run `fn` once, just before the next batch starts. */
    beforeBatch(fn) {
      hooks.batch = fn;
    },
    /** Run `fn` once, just before the next single statement whose SQL matches `match`. */
    beforeStatement(match, fn) {
      hooks.statements.push({ match, run: fn });
    },
  };
}
