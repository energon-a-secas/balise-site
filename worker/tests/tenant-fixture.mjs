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

/** Every JavaScript source file under src/, RECURSIVELY, as paths relative to src/ with forward
 *  slashes.
 *
 *  Recursive because the assertions that enumerate this directory are about what no file does,
 *  and a one-level readdir answers that question for one level: A39 found that a module under
 *  src/<dir>/ was never scanned by the credential-boundary test and so was never covered by it.
 *  There is no such directory today, and this is what stops the day there is one from being the
 *  day the property quietly stops holding.
 *
 *  The suffix test takes `.js`, `.mjs` and `.cjs` in ANY case, and the widening is the same hole
 *  one level down: this list is what every rule in tests/tenant-scope.test.mjs is applied TO, so
 *  a file the list leaves out is a file no rule looks at. `item.name.endsWith('.js')` left out
 *  `routes-status.mjs` and `routes-status.JS`, both of which workerd loads and both of which QA-3
 *  walked past the whole test with a credential read spelled out in full. The file list is the
 *  test's reach, and a file's reach is decided by what the runtime will load, not by one spelling
 *  of one suffix. */
export function srcFiles(dir = SRC, prefix = '') {
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) out.push(...srcFiles(join(dir, item.name), `${prefix}${item.name}/`));
    else if (/\.[cm]?js$/i.test(item.name)) out.push(`${prefix}${item.name}`);
  }
  return out.sort();
}

/** The punctuation a `/` may follow and still open a REGEX rather than divide. */
const PUNCT_BEFORE_REGEX = '=(,:[!&|?{};+-*%~^<>';
/** The KEYWORDS a `/` may follow and still open a regex. `return /x/` and `typeof /x/` are regex
 *  literals and `total / 2` is a division, and the character before the slash is a letter in both
 *  cases, so the last complete word is what tells them apart. `return` missing from this set is
 *  what QA-3 exploited: `return /\/*x/` was read as code, the `/*` two characters later opened a
 *  block comment that the source never had, and everything up to the next comment terminator
 *  was deleted with it. */
const WORD_BEFORE_REGEX = new Set([
  'return', 'typeof', 'case', 'throw', 'do', 'else', 'in', 'of', 'new', 'delete', 'void',
  'await', 'yield', 'instanceof',
]);
/** The keywords whose `(...)` is a HEAD and not a call, which is the other position QA-3 named:
 *  `sum(a)/2` divides, `if (a) /x/.test(s)` does not, and the character before the slash is `)`
 *  in both. */
const CONTROL_HEAD = new Set(['if', 'while', 'for', 'catch', 'with']);
const CLOSER = { '(': ')', '[': ']', '{': '}' };

/**
 * One pass over a Worker source file, giving three views of it:
 *
 *   code      comments removed and everything else left where it was, for the assertions that
 *             are about what the code does rather than what a comment says about it.
 *   bare      comments removed AND every string, template and regex literal emptied, so a name
 *             in it is a name the CODE uses. `headers` in `{ 'Cache-Control': 'x' }` is a name
 *             the code uses; `headers` inside a sentence a reader will see is not.
 *   literals  the body of every string and template literal, for the assertions that are about
 *             what a file may NAME. A specifier or a header name assembled out of pieces is a
 *             hole in any matcher that reads the code and not the pieces.
 *
 * IT IS A SCANNER AND NOT A REGEX, and the reason is a hole A39 found by exploiting it. The
 * first version was `text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')`, which cannot tell a
 * comment from a `//` inside a string: one `https://` on a line DELETED THE REST OF THAT LINE,
 * real code included, so a credential read written after a URL literal was invisible to the test
 * that exists to find it. Strings, template literals and regex literals are tracked for that
 * reason, and newlines are preserved so a reported position still means something.
 *
 * IT REFUSES RATHER THAN RETURNS when its own reading of the file has come apart, because both
 * of the failures this function can have are SILENT in the direction that matters. Deleting text
 * that was never a comment hides a credential read from the matcher downstream; leaving a comment
 * in place only makes the matcher strict, which is a red with a name on it. So it throws on a
 * block comment that never closes and on brackets that do not balance once the comments are out,
 * and the two bracket counts are what would have caught QA-3's exploit even in a position this
 * function still reads wrongly.
 *
 * What it is not: a parser. A `${...}` expression inside a template literal is treated as literal
 * content rather than as code, so a name used only there is in `literals` and not in `bare`; the
 * files this matters for are asserted to contain no `${` at all.
 */
export function scanSource(text, where = 'the text') {
  let code = '';
  let bare = '';
  const literals = [];
  let i = 0;
  // The last character that was neither whitespace nor part of a comment, the last complete word
  // before it, and whether the `)` we just passed closed an `if (...)` rather than a call.
  let prev = '';
  let word = '';
  let inWord = false;
  let afterControlClose = false;
  const heads = [];
  const brackets = [];
  const regexMayStart = () => prev === ''
    || PUNCT_BEFORE_REGEX.includes(prev)
    || WORD_BEFORE_REGEX.has(word)
    || (prev === ')' && afterControlClose);
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
        if (text[i] === '\n') { code += '\n'; bare += '\n'; }
        i += 1;
      }
      if (i >= text.length) {
        throw new Error(`scanSource: ${where} has a block comment that is never closed, so this scanner would have deleted the rest of the file and every assertion over it would have passed on nothing`);
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || (c === '/' && regexMayStart())) {
      const close = c;
      let body = '';
      // A `/` inside a regex's CHARACTER CLASS does not end the regex: `/^\/work\/([^/]+)$/`
      // ends at the last slash and not at the one inside `[^/]`. Reading it as ending early
      // leaves `]+)$/` behind as code, which is how the bracket count below found this.
      let inClass = false;
      code += c;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { code += text.slice(i, i + 2); body += text.slice(i, i + 2); i += 2; continue; }
        const ch = text[i];
        code += ch;
        body += ch;
        i += 1;
        if (close === '/' && ch === '[') inClass = true;
        else if (close === '/' && ch === ']') inClass = false;
        else if (ch === close && !inClass) break;
        // An unterminated literal would otherwise run to the end of the file and hide
        // everything after it, which is the failure mode this whole function exists to refuse.
        if (ch === '\n' && close !== '`') break;
      }
      // The quotes stay in `bare` so that an empty string is still visibly a string, and the
      // newlines of a multi-line template stay so that positions do not move.
      bare += c + (body.match(/\n/g) || []).join('') + (body.endsWith(close) ? close : '');
      if (close !== '/') literals.push({ quote: close, body: body.endsWith(close) ? body.slice(0, -1) : body });
      prev = close;
      word = '';
      inWord = false;
      afterControlClose = false;
      continue;
    }
    code += c;
    bare += c;
    i += 1;
    if (/[A-Za-z0-9_$]/.test(c)) {
      word = inWord ? word + c : c;
      inWord = true;
    } else {
      inWord = false;
      if (!/\s/.test(c)) word = '';
    }
    if (c === '(') heads.push(CONTROL_HEAD.has(prevWordAt(code)));
    if (c === ')') afterControlClose = heads.length ? heads.pop() : false;
    else if (!/\s/.test(c)) afterControlClose = false;
    if (CLOSER[c]) brackets.push(c);
    if (c === ')' || c === ']' || c === '}') {
      const open = brackets.pop();
      if (!open || CLOSER[open] !== c) {
        throw new Error(`scanSource: ${where} closes a '${c}' that was never opened once the comments are out, which means this scanner deleted code rather than a comment. A credential read inside the deleted part would be invisible to every assertion built on it, so this refuses instead of handing back a file it has misread`);
      }
    }
    if (!/\s/.test(c)) prev = c;
  }
  if (brackets.length) {
    throw new Error(`scanSource: ${where} has ${brackets.length} unclosed '${brackets[brackets.length - 1]}' once the comments are out, which means this scanner deleted code rather than a comment. A credential read inside the deleted part would be invisible to every assertion built on it, so this refuses instead of handing back a file it has misread`);
  }
  return { code, bare, literals };
}

/** The word immediately before the `(` that has just been emitted, for the control-head test. */
function prevWordAt(code) {
  const m = code.slice(0, -1).match(/([A-Za-z0-9_$]+)\s*$/);
  return m ? m[1] : '';
}

/** Comment removal on its own, kept as its own name because the unit test below is about it. */
export const stripComments = (text, where) => scanSource(text, where).code;

/** One Worker source file, comments removed. The pairing the assertions use. */
export const codeOf = (file) => scanSource(source(file), `src/${file}`).code;

/** One Worker source file, comments removed and every literal emptied. */
export const bareOf = (file) => scanSource(source(file), `src/${file}`).bare;

/** Every string and template literal in one Worker source file, bodies only. */
export const literalsOf = (file) => scanSource(source(file), `src/${file}`).literals;

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
