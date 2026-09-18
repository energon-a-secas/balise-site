// The fixture the two tenant suites share: tests/tenant-scope.test.mjs (every read and write
// that can be handed a scope or a handle) and tests/tenant-invariants.test.mjs (the import
// path, the work queue, and the two invariants of DESIGN.md section 4.3). Not a test file, so
// `node --test tests/*.test.mjs` does not run it on its own.
//
// THE SHAPE OF EVERY TEST BUILT ON THIS IS THE SAME ONE IDEA. A row is planted TWICE, identical
// in every column but `app_id`, and the store is then asked the same question about both. The
// fleet's copy must come back; the tenant's copy must not. So a deleted predicate does not make
// a test "less thorough", it makes the two copies behave alike, and that is exactly what each
// assertion is looking at. Nothing in either suite is a snapshot of expected output, and nothing
// has to be updated when a column or a message changes.
//
// Two marks do the work. Every string column of the fleet's copy carries FLEET-CANARY and every
// string column of the tenant's carries TENANT-CANARY, so an answer can be checked whole, by its
// JSON, without a test knowing the shape of it. The fleet mark being PRESENT is asserted as hard
// as the tenant mark being ABSENT: a query that returns nothing at all would otherwise pass
// every one of these and prove nothing, which is the failure mode a scope test is most likely
// to have.
//
// Over node:sqlite (tests/sqlite-d1.mjs) rather than workerd, for three reasons: it is built
// from worker/migrations so the schema is the real one, a tenant row can be PLANTED (nothing in
// phase 1 can create one through a route, because there is no tenant principal yet), and its
// undefined-binding guard turns a store function that reached SQL with no scope into a loud
// failure instead of a silent one.
//
// The rows are planted with raw SQL on purpose. `apps` and `app_keys` are WS-C's and neither
// suite writes them: `reports.app_id` is the column every predicate in the Worker reads, so a
// planted value in that column is a faithful tenant row for every question asked.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FLEET } from '../src/scope.js';

/** Exported because one assertion is about which FILE does something, so it has to enumerate
 *  the directory rather than name a file (see the auth.js importer test in tenant-scope). */
export const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');

/** A Worker source file as text, for the assertions that are about an ABSENCE (C6.5). */
export const source = (file) => readFileSync(join(SRC, file), 'utf8');

/** Every `*.js` under src/, RECURSIVELY, as paths relative to src/ with forward slashes.
 *
 *  Recursive because the assertions that enumerate this directory are about what no file does,
 *  and a one-level readdir answers that question for one level: A39 found that a module under
 *  src/<dir>/ was never scanned by the credential-boundary test and so was never covered by it.
 *  There is no such directory today, and this is what stops the day there is one from being the
 *  day the property quietly stops holding. */
export function srcFiles(dir = SRC, prefix = '') {
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) out.push(...srcFiles(join(dir, item.name), `${prefix}${item.name}/`));
    else if (item.name.endsWith('.js')) out.push(`${prefix}${item.name}`);
  }
  return out.sort();
}

/**
 * A Worker source file with its COMMENTS REMOVED and everything else left where it was, for the
 * assertions that are about what the code does rather than what a comment says about it.
 *
 * IT IS A SCANNER AND NOT A REGEX, and the reason is a hole A39 found by exploiting it. The
 * previous version was `text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')`, which cannot tell a
 * comment from a `//` inside a string: one `https://` on a line DELETED THE REST OF THAT LINE,
 * real code included, so a credential read written after a URL literal was invisible to the test
 * that exists to find it. Strings, template literals and regex literals are tracked here for that
 * reason, and newlines are preserved so a reported position still means something.
 *
 * What it is not: a parser. A `//` inside a template literal's ${} expression is treated as
 * string content rather than as a comment, which leaves a comment in place (a false POSITIVE, so
 * it fails loudly) and never removes code.
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  // The last character that was neither whitespace nor part of a comment. It is what tells a
  // regex literal from a division: `/` after a value divides, `/` after an operator opens one.
  let prev = '';
  const REGEX_MAY_START = '=(,:[!&|?{};+-*%~^<>';
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        // Newlines are kept so that nothing downstream reads a 40-line comment as one line.
        if (text[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || (c === '/' && (prev === '' || REGEX_MAY_START.includes(prev)))) {
      const close = c;
      out += c;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
        out += text[i];
        i += 1;
        if (text[i - 1] === close) break;
        // An unterminated literal would otherwise run to the end of the file and hide
        // everything after it, which is the failure mode this whole function exists to refuse.
        if (text[i - 1] === '\n' && close !== '`') break;
      }
      prev = close;
      continue;
    }
    out += c;
    i += 1;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

/** One Worker source file, comments removed. The pairing the assertions use. */
export const codeOf = (file) => stripComments(source(file));

export const T = 1_757_000_000_000;
export const FLEET_MARK = 'FLEET-CANARY';
export const TENANT_MARK = 'TENANT-CANARY';

// A tenant app id and one of its keys. Opaque strings: nothing reads them apart from the column,
// which is the whole point of the sentinel being a string like any other.
export const TENANT = 'ba_tenantcanary';
export const TENANT_KEY = 'bak_tenantcanary';

export const markOf = (appId) => (appId === FLEET ? FLEET_MARK : TENANT_MARK);
export const json = (value) => JSON.stringify(value);

/** One INSERT from an object, so no test has to track the column list. */
export function plant(db, table, row) {
  const keys = Object.keys(row);
  db.sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
  return row.id;
}

export const snapshot = (db, table, id) => {
  const row = db.sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  return row ? json({ ...row }) : null;
};

/**
 * One report and its current run, in one tenancy. Every string column carries that tenancy's
 * mark, so an answer that names any part of this row is recognisable by its JSON alone.
 *
 * `over` and `run` are per-case: each entry in a table of cases puts the row in the state its
 * action needs, so a refusal can only be the tenant term and never a rule that was going to
 * refuse anyway. That is the one way a scope test goes quietly vacuous.
 */
export function plantReport(db, appId, { id, runId, over = {}, run = {} } = {}) {
  const mark = markOf(appId);
  const reportId = id || `${appId}-report`;
  plant(db, 'reports', {
    id: reportId,
    created_at: T,
    site: `site-${mark}`,
    url: `https://example.test/${mark}`,
    target_kind: 'concept',
    target_id: `target-${mark}`,
    target_label: `label ${mark}`,
    kind: 'wrong',
    body: `The report body, ${mark}.`,
    contact: null,
    status: 'new',
    public: 1,
    public_note: `The published sentence, ${mark}.`,
    fixed_at: null,
    fingerprint: `fingerprint-${mark}`,
    source: 'queue',
    source_ref: `#ref-${mark}`,
    suggested: `The drafted sentence, ${mark}.`,
    opened_at: T,
    filed_by: 'human',
    work_attempts: 0,
    app_id: appId,
    app_key_id: appId === FLEET ? null : TENANT_KEY,
    ...over,
  });
  if (runId) {
    plant(db, 'work_runs', {
      id: runId,
      report_id: reportId,
      attempt: 1,
      runner: `runner-${mark}`,
      mode: 'fix',
      instruction: `The instruction, ${mark}.`,
      claimed_at: T,
      heartbeat_at: T,
      lease_until: T + 1_800_000,
      needs_landing: 0,
      summary: `The run summary, ${mark}.`,
      ...run,
    });
  }
  return reportId;
}

/** The fleet's copy came back, and the tenant's did not. Both halves are load-bearing. */
export function fleetOnly(out, where) {
  const text = json(out);
  assert.ok(
    text.includes(FLEET_MARK),
    `${where} answered with none of the fleet's own rows, so it would pass with any predicate at all: ${text}`,
  );
  assert.ok(!text.includes(TENANT_MARK), `${where} answered with a tenant's row: ${text}`);
  assert.ok(!text.includes(TENANT), `${where} answered with a tenant's app id: ${text}`);
  assert.ok(!text.includes(TENANT_KEY), `${where} answered with a tenant's key id: ${text}`);
}

// ── The two invariants of DESIGN.md 4.3, as SQL ────────────────────────────────
//
// SQLite cannot express either as a CHECK constraint on an existing table (ALTER TABLE adds no
// constraint, and rebuilding `reports` to carry one is a migration, which is not this
// workstream's to write), so a COUNT is the only detector there can be. It is the reason several
// statements in src/store-work.js and src/store-work-runner.js carry no predicate, and a
// non-zero count turns every one of those comments into a hole.
export const INVARIANTS = {
  "an open item is always the fleet's": `SELECT COUNT(*) AS n FROM reports
     WHERE kind = 'open' AND app_id <> 'fleet'`,
  "a row in the work queue is always the fleet's": `SELECT COUNT(*) AS n FROM reports
     WHERE work_state IS NOT NULL AND app_id <> 'fleet'`,
};

export function invariantCounts(db) {
  return Object.fromEntries(
    Object.entries(INVARIANTS).map(([name, sql]) => [name, db.sqlite.prepare(sql).get().n]),
  );
}
