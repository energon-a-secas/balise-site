// The second tenancy, as rows in a real local D1, plus the one-statement query helper the
// workerd suites read it back with. NOT a *.test.mjs file, so `node --test tests/*.test.mjs`
// never runs it as a suite; it only ever gets imported.
//
// It was lifted out of tests/local-d1.test.mjs when that file was split three ways (A31), for
// the same reason ./harness.mjs exists: two definitions of "what the tenant fixture is" is how
// two suites come to disagree about the thing they are both testing. The row shape itself is
// defined once more precisely, in ./tenant-fixture.mjs, and `plantReport` below is that file's.
//
// WHY THESE ROWS EXIST AT ALL (A22). Pass 3 asserted `rows_read < SEEDED + OPEN_SEEDED` against
// a table holding nothing but fleet rows. With one tenancy in the table a scoped index and an
// unscoped one read the same rows, so those assertions passed on either plan and detected
// nothing.
//
// These rows are the detector. Every one of them is NEWER than every fleet row the suites seed,
// so an index whose leading column is not `app_id` must walk all of them before it reaches a
// single row the query can return. The `app_id = 'fleet'` term in the statement still rejects
// them, so nothing leaks either way and `rows_read` is the ONLY thing that moves: that is the
// measurement, and 'the fleet's answer is unchanged' is not.
//
// Measured 2026-09-18, at a page of 25, six new indexes present against the same six dropped so
// the planner has to fall back to a kept one. Same Worker, same SQL, same fixture, 672 rows in
// the table:
//
//   GET /reports?kind=wrong&limit=25             55 rows_read  ->  625
//   GET /reports?kind=wrong&status=new&limit=25  55            ->  325
//   GET /reports?limit=25                        25            ->  625
//   GET /reports?status=new&limit=25             25            ->  325
//   GET /log?limit=25                             3            ->  303
//
// Forcing the fallback by dropping the six is a closer model of the risk than an `INDEXED BY`
// hint would be: the Worker's own statement is left exactly as it is and SQLite is left to
// choose freely among the indexes a rollback to 1.1.0 would leave behind.
//
// AMENDED. The left-hand column above is the SCOPED cost as it was on 2026-09-18, and two of its
// five lines have since improved: `0005_indexes.sql` added an index carrying `kind`, so the two
// `kind=wrong` pages stopped stepping over the open items and read a page instead of 55. The
// right-hand column, which is what this fixture exists to make impossible, is unchanged and is
// still what `UNSCOPED_FLOOR` is about. The fleet half of the fixture also grew, by the later
// corrections tests/local-d1-rows.test.mjs now seeds so that its open-tab case has rows of the
// other kind above it, and twelve of its imported open items are now accepted without being
// published, so that the board's cost law can tell a plan that seeks `public` from one that
// tests it. The tenant half is untouched, and none of those changes moves a number on the right.
//
// Two groups because the queries filter on different things: an unscoped plan for a
// `status = 'new'` query walks only the tenant's `new` rows, and one for the public log walks
// only its `fixed` ones. Each group on its own is therefore the floor an unscoped plan cannot
// get under, which is what `UNSCOPED_FLOOR` names.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from './harness.mjs';
import { plantReport, TENANT } from './tenant-fixture.mjs';

export const TENANT_NEW = 300;
export const TENANT_FIXED = 300;
export const TENANT_ROWS = TENANT_NEW + TENANT_FIXED;
/** The fewest tenant rows ANY unscoped plan among the six must read. Under a scoped plan the
 *  worst of the cases reads a page, so the gap is wide in both directions. It was 55 until 0005
 *  took the two kind-filtered pages down to `limit`; see the amendment above. */
export const UNSCOPED_FLOOR = Math.min(TENANT_NEW, TENANT_FIXED);
/** An hour ahead, so every tenant row is newer than every fleet row a suite seeds however long
 *  the seeding takes. The test 'the fixture is positioned' asserts that it worked, because a
 *  fixture that quietly slid under the fleet's rows is exactly how these cases would go
 *  vacuous again. */
export const PLANTED_AT = Date.now() + 3_600_000;

/**
 * The tenant rows, as one SQL file, built by tenant-fixture's own `plantReport`. The recorder
 * stands in for its `db.sqlite`: `plant` prepares one INSERT and runs it with the values, so
 * capturing the pair and rendering it as a literal statement is the same row by a different
 * road. Bindings are rendered rather than bound because `wrangler d1 execute` takes a file of
 * statements and no parameters.
 */
export function tenantInserts() {
  const statements = [];
  const recorder = { sqlite: { prepare: (sql) => ({ run: (...params) => statements.push({ sql, params }) }) } };
  for (let i = 0; i < TENANT_NEW; i += 1) {
    plantReport(recorder, TENANT, {
      id: `pass3b-new-${i}`,
      over: { created_at: PLANTED_AT + i, status: 'new', fingerprint: `pass3b-new-${i}` },
    });
  }
  for (let i = 0; i < TENANT_FIXED; i += 1) {
    const at = PLANTED_AT + TENANT_NEW + i;
    plantReport(recorder, TENANT, {
      id: `pass3b-fixed-${i}`,
      // `site` is the fleet's own site on purpose: if the public log or the per-site read-back
      // ever stopped scoping, these rows would land in the middle of an answer a human reads.
      over: { created_at: at, status: 'fixed', public: 1, fixed_at: at, site: 'parla-site', fingerprint: `pass3b-fixed-${i}` },
    });
  }
  const literal = (v) => {
    if (v === null || v === undefined) return 'NULL';
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  };
  return statements
    .map(({ sql, params }) => `${sql.split('?').map((piece, i) => piece + (i < params.length ? literal(params[i]) : '')).join('')};`)
    .join('\n');
}

/** Plant them. The SQL file goes to a temp directory outside the repo and is removed either
 *  way: a stray .sql next to the suite is a scratch file someone will later mistake for a
 *  fixture. */
export async function plantTenant(state) {
  const dir = mkdtempSync(join(tmpdir(), 'balise-tenant-'));
  try {
    const file = join(dir, 'tenant-rows.sql');
    writeFileSync(file, tenantInserts());
    await run(['d1', 'execute', 'balise', '--local', '--persist-to', state, '--file', file, '--yes']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One or more statements against the same local D1 a Worker is bound to, as one result set per
 * statement. `--local` is spelled out here as it is in every other D1 command in this project.
 * Reading this file while `wrangler dev` holds it open is safe and is verified by the tests
 * that do it.
 */
export function d1For(state) {
  return async function d1(...commands) {
    const out = await run(['d1', 'execute', 'balise', '--local', '--persist-to', state, '--json', '--command', commands.join('; ')]);
    return JSON.parse(out.slice(out.indexOf('['))).map((set) => set.results);
  };
}
