// CONTRACTS.md C6, asserted, part one: no fleet credential reaches a tenant's row, through any
// read or write that takes a scope or a caller-supplied handle. Part two, the import path, the
// work queue and the two invariants of DESIGN.md section 4.3, is tests/tenant-invariants.test.mjs.
//
// The two-copy shape every test here uses, the two canary marks, and why this runs over
// node:sqlite rather than workerd, are all explained once in tests/tenant-fixture.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from './sqlite-d1.mjs';
import { FLEET, FLEET_SCOPE, scopeFor } from '../src/scope.js';
import { principalFor } from '../src/routes-desk.js';
import {
  fingerprintInput, listReports, getReport, applyTransition,
} from '../src/store.js';
import { publicLog, healthSites } from '../src/store-public.js';
import { board, boardSummary } from '../src/store-open.js';
import {
  readRow, workItem, readDetail, approveWork, withdrawWork, reviewWork,
} from '../src/store-work.js';
import {
  claimWork, heartbeatWork, releaseWork, submitWork, landWork,
} from '../src/store-work-runner.js';
import {
  T, FLEET_MARK, TENANT_MARK, TENANT, TENANT_KEY, markOf, json,
  snapshot, plantReport, fleetOnly, source, srcFiles, codeOf, bareOf, literalsOf, stripComments,
} from './tenant-fixture.mjs';

/** How many SQL statements over `reports` live in each of the two files that serve a
 *  credential-free route. Pinned so that a statement the extractor in C6.5 cannot see is a red
 *  rather than a silent gap in what that assertion covers: the assertion is per statement, so its
 *  reach is exactly the statements this number counts. */
const SQL_STATEMENTS = { 'store-public.js': 2, 'store-open.js': 9 };

// ── The seam ──────────────────────────────────────────────────────────────────

test('C6: the scope seam has one answer per principal kind and refuses to invent one', () => {
  // Phase 1 has two principals and both are the fleet's, which is what makes this phase
  // reviewable: no externally visible behaviour changes. A third kind is WS-C's, and until it
  // exists scopeFor must THROW rather than fall back, because a fallback to the fleet is
  // invisible in phase 1 and a cross-tenant read in phase 2.
  assert.equal(scopeFor({ kind: 'operator' }).appId, FLEET);
  assert.equal(scopeFor({ kind: 'automation' }).appId, FLEET);
  assert.equal(scopeFor({ kind: 'operator' }).appKeyId, null);
  for (const principal of [{ kind: 'app' }, { kind: 'person' }, { kind: '' }, {}, null, undefined]) {
    assert.throws(() => scopeFor(principal), /no scope is defined/, `scopeFor accepted ${json(principal)}`);
  }
  // The sentinel is a STRING and never NULL: `WHERE app_id = ?` bound to NULL matches nothing
  // silently, and the symptom is an empty page rather than an error.
  assert.equal(FLEET, 'fleet');
  assert.equal(typeof FLEET_SCOPE.appId, 'string');
});

test('C6: the actor seam above scopeFor has one answer per actor and refuses to invent one', () => {
  // The seam above the seam. scopeFor throws on a kind it does not know, but principalFor in
  // src/routes-desk.js is what decides the kind, and while it read
  // `actor === 'ai' ? 'automation' : 'operator'` every unknown actor arrived as an OPERATOR:
  // fleet-scoped, silent, and the throw above unreachable from any route. That is the failure
  // this test exists to keep red. It costs nothing in phase 1, where authenticate() returns
  // 'human' or 'ai' and nothing else; it is WS-C's `person` and `app` kinds that would pay.
  assert.deepEqual(principalFor('human'), { kind: 'operator', actor: 'human' });
  assert.deepEqual(principalFor('ai'), { kind: 'automation', actor: 'ai' });
  // And both still reach the fleet, so phase 1 behaves exactly as it did.
  assert.equal(scopeFor(principalFor('human')).appId, FLEET);
  assert.equal(scopeFor(principalFor('ai')).appId, FLEET);
  // Anything else throws by name. 'operator' and 'automation' are in this list on purpose: the
  // lookup is keyed by ACTOR, so passing a principal KIND to it is a caller's mistake and not a
  // second spelling. 'constructor' and '__proto__' are here because an object literal would
  // have answered both of them.
  const refused = ['person', 'app', 'operator', 'automation', 'Human', 'ai ', '', null, undefined, 0, 'constructor', '__proto__'];
  for (const actor of refused) {
    assert.throws(() => principalFor(actor), /principalFor: no principal kind is defined/, `principalFor accepted ${json(actor)}`);
  }
});

test('A11: the fingerprint takes the app id first, and only a tenant is inside the hash', () => {
  const args = ['parla-site', 'seed1', 'The body.'];
  // The fleet's input is unchanged by the campaign, which is what keeps every existing row's
  // fingerprint valid: a change here would silently stop deduplicating reports filed before it.
  assert.equal(fingerprintInput(FLEET, ...args), fingerprintInput(FLEET, ...args));
  assert.ok(!fingerprintInput(FLEET, ...args).includes(FLEET));
  // A tenant's is prefixed, so two tenants filing the same sentence about the same page get
  // two rows. That is why reports_fp stays UNIQUE(fingerprint) and every
  // ON CONFLICT(fingerprint) clause in the Worker is untouched.
  assert.ok(fingerprintInput(TENANT, ...args).startsWith(`${TENANT}\x00`));
  assert.notEqual(fingerprintInput(TENANT, ...args), fingerprintInput(FLEET, ...args));
  assert.notEqual(fingerprintInput(TENANT, ...args), fingerprintInput(`${TENANT}x`, ...args));
  // The app id is the FIRST argument so that a call site left on the old three-argument shape
  // hashes the site as the tenant and fails loudly, rather than hashing as the fleet.
  assert.equal(fingerprintInput.length, 4);
});

// ── Every read that answers without a handle ──────────────────────────────────

/**
 * Four pairs, eight rows, one database: a correction and an open item on each side of the
 * tenant line, published the two ways a public surface can show them. Every query in the
 * Worker that answers WITHOUT being given an id has something here it would return if its
 * predicate went missing.
 *
 * Three of these tenant rows carry `kind = 'open'`, which invariant 4.3 forbids. They are
 * planted anyway and deliberately: the predicate is what MAKES the invariant true, so a test
 * that only planted rows the invariant allows would be asserting the predicate against data
 * that could not reach it.
 */
function feedFixture() {
  const db = sqliteD1();
  for (const appId of [FLEET, TENANT]) {
    const mark = markOf(appId);
    // A resolved correction: the public log's only row shape.
    plantReport(db, appId, {
      id: `${appId}-fixed-correction`,
      over: {
        kind: 'wrong', status: 'fixed', public: 1, fixed_at: T + 10, created_at: T + 1,
        fingerprint: `fp-correction-${mark}`, source: null, source_ref: null, opened_at: null,
      },
    });
    // An open item published as OPEN: a board entry.
    plantReport(db, appId, {
      id: `${appId}-open-accepted`,
      over: {
        kind: 'open', status: 'accepted', public: 1, created_at: T + 2,
        fingerprint: `fp-open-${mark}`, source_ref: `#open-${mark}`,
      },
    });
    // An open item resolved: the board's newest resolution, and the summary's sentence.
    plantReport(db, appId, {
      id: `${appId}-open-fixed`,
      over: {
        kind: 'open', status: 'fixed', public: 1, fixed_at: T + 20, created_at: T + 3,
        fingerprint: `fp-resolved-${mark}`, source_ref: `#resolved-${mark}`,
      },
    });
    // A private draft, for the desk's two feeds.
    plantReport(db, appId, {
      id: `${appId}-open-new`,
      over: {
        kind: 'open', status: 'new', public: 1, created_at: T + 4,
        fingerprint: `fp-draft-${mark}`, source_ref: `#draft-${mark}`,
      },
    });
  }
  return db;
}

const FEED_READS = [
  ['listReports, the corrections queue', (db) => listReports(db, FLEET_SCOPE, { status: null, kind: null, before: null, limit: 50 })],
  ['listReports, a status filter', (db) => listReports(db, FLEET_SCOPE, { status: 'fixed', kind: null, before: null, limit: 50 })],
  ['listReports, the open items feed', (db) => listReports(db, FLEET_SCOPE, { status: null, kind: 'open', before: null, limit: 50 })],
  ['listReports, open items by status', (db) => listReports(db, FLEET_SCOPE, { status: 'accepted', kind: 'open', before: null, limit: 50 })],
  ['publicLog', (db) => publicLog(db, { before: null, limit: 50 })],
  ['healthSites', (db) => healthSites(db, T - 1)],
  ['board', (db) => board(db, {})],
  ['boardSummary', (db) => boardSummary(db, { now: T + 30 })],
];

test('C6: no read that answers without a handle can return a tenant row', async () => {
  const db = feedFixture();
  for (const [where, call] of FEED_READS) {
    const out = await call(db);
    assert.equal(out.code, undefined, `${where} failed: ${json(out)}`);
    fleetOnly(out, where);
  }
});

test('C6.5: the three public reads count the fleet only, and take the literal rather than a key', async () => {
  const db = feedFixture();
  // A count is the one answer no canary can watch: a number that included a tenant's items
  // would look exactly like a number that did not. So the counts are asserted by value.
  const summary = await boardSummary(db, { now: T + 30 });
  assert.equal(summary.open, 1, `the summary counted a tenant's published item: ${json(summary)}`);
  assert.equal(summary.resolved, 1, `the summary counted a tenant's resolution: ${json(summary)}`);
  assert.equal(summary.inProgress, 0);
  const shown = await board(db, {});
  assert.equal(shown.resolved.length, 1);
  assert.equal(shown.open.length, 1);
  const log = await publicLog(db, { before: null, limit: 50 });
  assert.equal(log.entries.length, 1);
  const health = await healthSites(db, T - 1);
  assert.deepEqual(health.sites.map((s) => s.site), [`site-${FLEET_MARK}`]);

  // C6.5 is STRUCTURAL rather than a policy, and this is the assertion that says so. The
  // statements behind /log, /board and /board/summary take the LITERAL 'fleet', so no call
  // site can ever be handed a key that makes them publish a tenant's row: a bound parameter
  // would put "no tenant row can be published" in the hands of every future caller, and these
  // routes carry no credential to stop one. An absence cannot be shown by a value, so it is
  // asserted over the source.
  //
  // PER STATEMENT, AND OVER THE CODE RATHER THAN THE FILE. This counted `app_id = 'fleet'` over
  // source(file) with the comments in it and asked for two, which src/store-public.js can satisfy
  // with the two comment lines that DECLARE the rule and no SQL at all, and which src/store-open.js
  // can satisfy with two of its nine statements. A count over a file cannot say which statement
  // lost its predicate, and naming the statement is the whole job here (QA-3 finding F1).
  for (const [file, expected] of Object.entries(SQL_STATEMENTS)) {
    const code = codeOf(file);
    const statements = literalsOf(file)
      .map(({ body }) => body.replace(/\s+/g, ' ').trim())
      .filter((sql) => /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(sql) && /\breports\b/.test(sql));
    assert.equal(
      statements.length, expected,
      `src/${file} has ${statements.length} SQL statements over \`reports\` where this test expects ${expected}. If you added one, put the new number here and make sure it carries the literal. If you MOVED one out of a template literal, put it back: a statement this extractor cannot see is a statement no assertion below is applied to.`,
    );
    for (const sql of statements) {
      assert.match(
        sql, /app_id = 'fleet'/,
        `a statement in src/${file} reads or writes \`reports\` without \`app_id = 'fleet'\` in it, and every statement in a file that serves a credential-free route carries the literal (C6.5): ${sql}`,
      );
    }
    assert.doesNotMatch(code, /app_id\s*=\s*\?/, `src/${file} binds app_id, which C6.5 says it must not`);
    assert.doesNotMatch(code, /tenantKey|scopeFor/, `src/${file} reaches for a scope, which C6.5 says it must not`);
  }
});

/**
 * Every JavaScript file under src/, and what each one may do with A CALLER'S CREDENTIAL. The keys
 * are asserted to be exactly srcFiles(), so a file added under src/ turns this test red until
 * somebody has said which of these four it is.
 *
 *   'credential'  may read a credential header out of a request. src/auth.js, alone.
 *   'desk'        may reach src/auth.js. src/routes-desk.js, alone.
 *   'public'      holds a route that answers with NO credential at all. A file in this role may
 *                 NAME only what MAY_NAME lists for it, which is the one rule here that does not
 *                 depend on guessing how a credential might be spelled.
 *   'plain'       everything else. Held to the header and specifier matches below, which are
 *                 matches on SPELLINGS and are the weaker half of this test.
 */
const SRC_ROLES = {
  'auth.js': 'credential',
  'budget.js': 'plain',
  'envelope.js': 'plain',
  'index.js': 'plain',
  'keys.js': 'plain',
  'redact.js': 'plain',
  'routes-desk.js': 'desk',
  'routes-open.js': 'public',
  'routes-public.js': 'public',
  'routes-work.js': 'plain',
  'scope.js': 'plain',
  'store-auth.js': 'plain',
  'store-open.js': 'plain',
  'store-public.js': 'plain',
  'store-work-runner.js': 'plain',
  'store-work.js': 'plain',
  'store.js': 'plain',
  'suggestion.js': 'plain',
  'transitions.js': 'plain',
  'turnstile.js': 'plain',
  'validate-work.js': 'plain',
  'validate.js': 'plain',
  'work.js': 'plain',
};
const filesInRole = (role) => Object.keys(SRC_ROLES).filter((f) => SRC_ROLES[f] === role).sort();

/** The two files the four credential-free routes live in. /report, /log and /health are in the
 *  first, /board and /board/summary in the second. */
const PUBLIC_ROUTE_FILES = filesInRole('public');
/** The only file in the Worker that may read a credential out of a request. */
const MAY_READ_A_CREDENTIAL = filesInRole('credential');
/** The only file that may reach src/auth.js. Named rather than counted: a count passes when the
 *  importer MOVES, and where it lives is the point. */
const MAY_IMPORT_AUTH = filesInRole('desk');
/** Request headers that carry who the caller is. X-Balise-Actor is gone for good (src/auth.js and
 *  src/routes-desk.js both say why) and is listed so that bringing it back is a red. */
const CREDENTIAL_HEADERS = ['authorization', 'x-balise-actor', 'cookie', 'proxy-authorization'];
/** Any `.headers` that is not the spread of a plain object. The lookbehind is what keeps
 *  `...headers` out of it; `request.headers` and `res?.headers` are both in. */
const ANY_HEADERS = /(?<!\.)\.headers\b/g;
/** A header touched BY A NAME THAT IS WRITTEN OUT. Anchored, so it is tested against the text
 *  from one `.headers` onwards. */
const NAMED_HEADER = /^\.headers\s*\.\s*(get|has|set|append|delete)\s*\(\s*(['"])([^'"\n]*)\2/;
/** The text `auth.js` where it is not part of a longer file name, in any case and under any
 *  quoting. It matches `from './auth.js'`, `from "../auth.js"`, `await import(\`./auth.js\`)`,
 *  `import('./' + 'auth.js')` and `./Auth.js`, none of which the previous form matched except the
 *  first two: it required a matching pair of straight quotes around the whole specifier, so a
 *  backtick, a concatenation and a capital A each walked past it (QA-3 evasions b1, b2, b5).
 *  `./store-auth.js` is excluded by the lookbehind rather than by a path rule. */
const AUTH_SPECIFIER = /(?<![\w-])auth\.js/i;

/**
 * Every NAME the code of one file uses, which is a narrower thing than every token in it: a local
 * variable reaches nothing by itself, and `const bearer = ...` is not interesting. Reaching a
 * credential needs one of exactly three things, and all three are collected here.
 *
 *   a property read     `request.headers`, `res?.headers`, `Reflect.get(request, x)` (`get`)
 *   a key inside braces `const { headers } = request`, `function h({ headers })`
 *   a string literal    `request['headers']`, `'Authorization'`, `import('./' + 'auth.js')`
 *
 * Read off `bareOf`, which is the file with its comments removed and its literals emptied, so a
 * sentence a reader will see cannot put a name on this list. Literals with a space in them are
 * sentences rather than names and are left out for the same reason.
 */
function namesUsed(file) {
  const bare = bareOf(file);
  const names = new Set();
  for (const hit of bare.match(/\.\s*[A-Za-z_$][A-Za-z0-9_$]*/g) || []) names.add(hit.replace(/^\.\s*/, ''));
  const open = [];
  const token = /[{}()[\]]|[A-Za-z_$][A-Za-z0-9_$]*/g;
  let at = token.exec(bare);
  while (at !== null) {
    if ('{(['.includes(at[0])) open.push(at[0]);
    else if (')]}'.includes(at[0])) open.pop();
    else if (open[open.length - 1] === '{') {
      const next = bare.slice(at.index + at[0].length).match(/^\s*(\S)/);
      if (next && ',}='.includes(next[1])) names.add(at[0]);
    }
    at = token.exec(bare);
  }
  for (const { body } of literalsOf(file)) if (body !== '' && !/\s/.test(body)) names.add(body);
  return [...names].sort();
}

/**
 * What a file in the 'public' role may name. POSITIVE, and that is the whole point: every earlier
 * version of this rule was a list of spellings to refuse, and each one lost to the next spelling
 * (`.headers`, then `request['headers']`, then `const { headers } = request`, then `Reflect.get`,
 * then a specifier built with `+`). A list of what may be named cannot be walked around by a new
 * spelling, because a new spelling is a name that is not on it.
 *
 * `get`, `headers`, `Authorization`, `Reflect`, `./auth.js` and every case variant of those are
 * absent from both lists, and the assertion is that absence rather than a rule about it.
 */
const MAY_NAME = {
  'routes-open.js': [
    '*', './envelope.js', './store-open.js', './store.js', './validate.js', 'ANY_ORIGIN',
    'Access-Control-Allow-Origin', 'BOARD_LIMIT_MAX', 'CACHED', 'Cache-Control', 'DB',
    'IMPORT_BATCH_MAX', 'OPEN_SOURCES', 'P', 'STATUSES', 'SUMMARY_WINDOW_DAYS', 'SYNC_REFS_MAX',
    'board', 'boardSummary', 'checked', 'closed', 'code', 'created', 'desk', 'env', 'fail',
    'hint', 'inProgress', 'latest', 'limit', 'log', 'message', 'min', 'now', 'ok', 'open',
    'origin', 'params', 'read', 'reopened', 'resolved', 'result', 'rowsRead', 'searchParams',
    'source', 'syncOpenSource', 'unchanged', 'upsertOpenItems', 'url', 'validateListQuery',
    'validateOpenBatch', 'validateOpenSync', 'value',
  ],
  'routes-public.js': [
    './budget.js', './envelope.js', './keys.js', './scope.js', './store-public.js',
    './store.js', './turnstile.js', './validate.js', 'BALISE_AUTOMATION_TOKEN',
    'BALISE_IP_SALT', 'BALISE_OPERATOR_TOKEN', 'BALISE_TURNSTILE_SECRET', 'Cache-Control', 'DB',
    'DUPLICATE', 'FLEET_SCOPE', 'HEALTH_WINDOW_DAYS', 'INGEST_LIMITER', 'P', 'RATE_LIMITED',
    'STATUSES', 'actorKey', 'appId', 'body', 'challenge', 'checked', 'code', 'duplicate',
    'entries', 'env', 'error', 'fail', 'fingerprint', 'fingerprintInput', 'fpIn', 'function',
    'hashed', 'healthSites', 'hint', 'id', 'ingest', 'insertReport', 'ip', 'ipHash', 'key',
    'limit', 'log', 'message', 'new', 'next', 'now', 'ok', 'origin', 'page', 'params', 'parsed',
    'publicLog', 'randomUUID', 'read', 'readJson', 'report', 'result', 'rowsRead',
    'searchParams', 'sha256Hex', 'since', 'site', 'sites', 'success', 'target', 'turnstile',
    'url', 'validateListQuery', 'validateReport', 'value', 'verifyTurnstile', 'version', 'warn',
    'warnRowsRead',
  ],
};

test('every file under src/ is classified, so none of them can sit outside these rules', () => {
  // The reach of every rule below is srcFiles(), and until this assertion existed the reach was
  // whatever that function happened to return. It returned files ending in a lower-case `.js`,
  // so `routes-status.mjs` and `routes-status.JS` were loadable public routes that no rule looked
  // at, each of them reading `request.headers.get('Authorization')` with nothing red (QA-3
  // evasion b6). The suffix test is widened in tenant-fixture, and this is the other half: a file
  // that exists and is not classified is red, so the next file cannot arrive uncovered whatever
  // it is called.
  assert.deepEqual(
    srcFiles(), Object.keys(SRC_ROLES).sort(),
    `src/ and SRC_ROLES disagree about which files exist. Classify the new one: 'public' if a route that answers WITHOUT a credential lives in it, 'plain' otherwise, and read what each role costs above. An unclassified file is a file none of the credential rules in this test are applied to.`,
  );
  assert.deepEqual(MAY_READ_A_CREDENTIAL, ['auth.js'], 'a second file has been given leave to read a credential header');
  assert.deepEqual(MAY_IMPORT_AUTH, ['routes-desk.js'], 'a second file has been given leave to import src/auth.js');
  assert.deepEqual(
    PUBLIC_ROUTE_FILES, Object.keys(MAY_NAME).sort(),
    `a file in the 'public' role has no list of names it may use, so the positive rule below is not applied to it at all`,
  );
});

test('the four public routes cannot read a credential, because the files they live in may name only what this test lists', () => {
  // The other half of "structural rather than a policy", and it is new with the router split in
  // phase 2 pass 0. /report, /log, /board and /board/summary must never read the Authorization
  // header and must never import src/auth.js. That was a RULE while every route body shared
  // src/index.js with the desk's: nothing could assert it, because the import the rule forbids
  // was in the same file as the routes it forbids it to, and a reviewer reading a 522 line
  // router was the whole detector. Split, it is a property of two files and this is the
  // assertion. It is the reason the seam was cut where it was cut.
  //
  // Asserted over the TEXT, not over behaviour, for the same reason as C6.5 above: this is an
  // absence, and an absence has no value to compare. A public route that started reading a
  // credential would not fail any other test in this repository, it would just quietly answer
  // differently to a caller holding a token.
  //
  // THE FIRST RULE IS POSITIVE AND THE OTHER TWO ARE NOT, and which is which is the thing to
  // carry away. Three versions of this test refused a list of spellings, and each version lost to
  // the next spelling: `grep Authorization`, then `.headers`, then `.headers` again with the file
  // list widened. A39 found five ways past the first, QA-3 found seven past the second, and none
  // of the seven needed obfuscation: `const { headers } = request` walked past it in two lines of
  // ordinary JavaScript.
  //
  //   1. a file in the 'public' role may NAME only what MAY_NAME lists for it. Positive, so a
  //      spelling nobody has thought of fails by not being on the list, which is the opposite of
  //      how the previous two rules failed.
  //   2. only MAY_READ_A_CREDENTIAL may touch a credential header, in ANY file under src/, and
  //      every other file has to name every header it touches as a plain literal. A match on a
  //      spelling: it holds for `.headers` and it is silent on anything reaching a header some
  //      other way, which in a 'plain' file is a gap and not a property.
  //   3. no file in the 'public' role may name a credential header at all. Also a match on a
  //      spelling, and kept because it says plainly which header was named.
  //
  // Comments are removed by tenant-fixture's codeOf(), and literals are emptied by bareOf(), both
  // from one scanner rather than a regex, for a reason recorded there: the regex this test used to
  // use deleted real code that followed a URL literal on the same line, and the scanner that
  // replaced it deleted real code that followed a regex literal after `return`.
  const files = srcFiles();
  for (const file of [...PUBLIC_ROUTE_FILES, ...MAY_READ_A_CREDENTIAL, ...MAY_IMPORT_AUTH]) {
    assert.ok(files.includes(file), `src/${file} is gone, so this test is asserting a rule about files that do not exist`);
  }

  for (const file of PUBLIC_ROUTE_FILES) {
    // A `${...}` expression is literal content to the scanner, so a name used only inside one is
    // invisible to namesUsed(). Neither of these files has one, and this is what keeps it so.
    assert.doesNotMatch(
      bareOf(file), /\$\{/,
      `src/${file} has a template EXPRESSION in it, and the scanner this rule reads the file through treats one as string content, so a name used only inside it would not be on the list namesUsed() builds. Either write it without the expression or teach scanSource() to scan inside one.`,
    );
    for (const name of namesUsed(file)) {
      assert.ok(
        MAY_NAME[file].includes(name),
        `src/${file} names \`${name}\`, and a file holding a credential-free route may name only what MAY_NAME lists for it. The list is positive on purpose: reading a credential takes a property, a key in braces or a string, so a read this test has never heard of still needs a NAME, and an unlisted name is this failure. If the file genuinely needs \`${name}\`, add it to MAY_NAME in a commit that says why, having satisfied yourself it cannot reach a caller's credential.`,
      );
    }
  }

  const importers = [];
  for (const file of files) {
    const code = codeOf(file);
    if (AUTH_SPECIFIER.test(code)) importers.push(file);
    if (MAY_READ_A_CREDENTIAL.includes(file)) continue;

    for (const at of code.matchAll(ANY_HEADERS)) {
      const named = code.slice(at.index).match(NAMED_HEADER);
      assert.ok(
        named,
        `src/${file} touches .headers in a way this test cannot read a header NAME out of: ${code.slice(at.index, at.index + 70).replace(/\s+/g, ' ')}. A file that may not read a credential names every header it touches as a plain string literal, so that reading the source is the whole check. If that is genuinely what this new code needs, the rule to change is this test, in a commit that says why.`,
      );
      assert.ok(
        !CREDENTIAL_HEADERS.includes(named[3].toLowerCase()),
        `src/${file} reads the ${named[3]} request header, and only src/${MAY_READ_A_CREDENTIAL.join(', src/')} may`,
      );
    }
  }
  assert.deepEqual(
    importers, MAY_IMPORT_AUTH,
    `src/auth.js is imported by ${importers.join(', ') || 'nothing'}, and the only file that may is ${MAY_IMPORT_AUTH.join(', ')}`,
  );

  for (const file of PUBLIC_ROUTE_FILES) {
    const code = codeOf(file);
    for (const name of CREDENTIAL_HEADERS) {
      assert.doesNotMatch(code, new RegExp(name, 'i'), `src/${file} names the ${name} header in its code, and the four routes it holds carry no credential`);
    }
  }
});

test('the credential matcher reads the code and not a comment about it', () => {
  // The matcher above is only as good as its comment stripper, and a stripper's failure is
  // SILENT: it makes a planted violation invisible, so nothing goes red until somebody plants
  // one. A39 planted one. This is the unit test that means the next rewrite of codeOf() cannot
  // reopen the hole without a name attached to it.
  // 1. THE EVASION ITSELF: a real credential read after a URL literal on the same line. The old
  //    regex stripper deleted from the `//` of `https://` to the end of the line, so the read
  //    vanished before the matcher saw it.
  const planted = "const u = 'https://balise.neorgon.com/x'; const h = request.headers.get('Authorization');";
  assert.equal(stripComments(`${planted} // a comment naming Authorization`), `${planted} `, 'the stripper either kept a comment or ate the code after a URL literal');
  // 2. A block comment goes and its newlines stay, so a position still means something.
  assert.equal(stripComments('a\n/* two\nlines */\nb'), 'a\n\n\nb', 'the stripper lost or invented a newline');
  // 3. A `//` inside a double-quoted string is not a comment either.
  assert.equal(stripComments('const u = "http://x/y";'), 'const u = "http://x/y";', 'the stripper treated a URL inside a string as a comment');
  // 4. A regex literal holding a quote does not open a string. Without this the rest of the file
  //    reads as one long string and every assertion over it passes on nothing.
  assert.equal(stripComments("const q = /['\"]/; const k = 'x';"), "const q = /['\"]/; const k = 'x';", 'the stripper read a regex literal as a string');
  // 5. And on the real file: the comment lines that DECLARE the prohibition are gone while the
  //    file itself is still there. That declaration is the false positive A39 warned about, and a
  //    red nobody can act on gets deleted, taking the real assertion with it. Matched on the
  //    declaring WORDING rather than on the header name, so that a real violation planted in this
  //    file turns the matcher above red and leaves this one green, which is the difference between
  //    a diagnosis and two alarms.
  const code = codeOf('routes-public.js');
  assert.doesNotMatch(code, /MUST NEVER/, 'the stripper left a comment declaring the prohibition in the code it hands the matcher');
  assert.match(code, /export async function resolvedLog/, 'the stripper ate the file');
  // 6. A REGEX LITERAL WHERE THE SCANNER USED TO SEE A DIVISION, which is QA-3's exploit and the
  //    second stripper hole found by planting a read rather than by reading the stripper. `return`
  //    was not in the set of positions a regex may start in, so `/\/*x/` was read as code, the
  //    `/*` two characters into it opened a block comment the file never had, and everything up to
  //    the next comment terminator was deleted with it. Planted inside resolvedLog with
  //    `request.headers.get('Authorization')` on the next line, it left the whole suite green.
  const afterReturn = 'const slashy = (s) => { return /\\/*x/.test(s); };';
  assert.equal(stripComments(afterReturn), afterReturn, 'a regex literal after `return` was read as the start of a comment, so the code after it was deleted');
  const afterIfHead = 'if (s) /\\/*x/.test(s);';
  assert.equal(stripComments(afterIfHead), afterIfHead, 'a regex literal after an `if` head was read as the start of a comment, so the code after it was deleted');
  // 7. And a division is still a division, in both of those positions, or the scanner would read
  //    the rest of the line as a regex and any comment on it would survive into the code.
  assert.equal(stripComments('const half = (a + b) / 2; // c'), 'const half = (a + b) / 2; ', 'the scanner read a division after `)` as a regex');
  assert.equal(stripComments('function f(t) { return t / 2; } // c'), 'function f(t) { return t / 2; } ', 'the scanner read a division after an identifier as a regex');
  // 8. THE GUARD, which is what 6 and 7 are not: 6 and 7 are two positions somebody thought of,
  //    and this is for the ones nobody has. When a deletion takes a bracket with it, or a block
  //    comment runs to the end of the file, the scanner REFUSES rather than handing back text it
  //    has misread. That direction is deliberate: leaving a comment in makes the matcher strict,
  //    which is a red with a name on it, while deleting code makes a planted credential read
  //    invisible. Both inputs here are synthetic, because the point is the refusal and not the
  //    position.
  assert.throws(() => stripComments('const n = f(a) /\\/*{*/ } ;', 'a snippet'), /misread/, 'the scanner deleted a bracket and handed back the result anyway');
  assert.throws(() => stripComments('function f() { /* never closed', 'a snippet'), /never closed/, 'the scanner ran a comment to the end of the file and handed back the result anyway');
  // 9. And across every file the rules above are applied to: nothing the source EXPORTS may be
  //    missing from the code they read. The guard that existed checked one export in one file, and
  //    QA-3's deletion stopped one line short of it.
  for (const file of srcFiles()) {
    const text = source(file);
    const stripped = codeOf(file);
    for (const declared of text.match(/^export (?:async )?(?:function|const|class) [A-Za-z_$][A-Za-z0-9_$]*/gm) || []) {
      assert.ok(
        stripped.includes(declared),
        `codeOf('${file}') has lost \`${declared}\`, so the scanner deleted code and every assertion built on that file is now reading less than the file`,
      );
    }
  }
});

// ── Every read and every write that takes a handle ────────────────────────────
//
// The table below is the campaign's riskiest surface: each of these takes an id, a run id or a
// fingerprint FROM THE CALLER, so each one is a place where one guessed handle would be enough
// to read or move somebody else's row if its predicate went missing.

const KEYED = [
  {
    name: 'getReport',
    call: (db, id) => getReport(db, FLEET_SCOPE, id),
  },
  {
    name: 'applyTransition, a publish',
    over: { kind: 'wrong', status: 'new' },
    call: (db, id) => applyTransition(db, FLEET_SCOPE, {
      id, actor: 'human', patch: { status: 'accepted' }, now: T + 100,
    }),
  },
  {
    name: 'applyTransition, a close',
    over: { kind: 'wrong', status: 'accepted' },
    call: (db, id) => applyTransition(db, FLEET_SCOPE, {
      id, actor: 'human', patch: { status: 'fixed', public_note: 'A resolution.' }, now: T + 100,
    }),
  },
  {
    name: 'readRow',
    over: { work_state: 'claimed', work_run: 'run', work_lease_until: T + 1_800_000 },
    runId: 'run',
    call: async (db, id) => ({ item: (await readRow(db, id)) || null }),
  },
  {
    name: 'workItem',
    over: { work_state: 'claimed', work_run: 'run', work_lease_until: T + 1_800_000 },
    runId: 'run',
    call: (db, id) => workItem(db, id),
  },
  {
    name: 'readDetail, by report id',
    over: { work_state: 'claimed', work_run: 'run', work_lease_until: T + 1_800_000 },
    runId: 'run',
    call: (db, id) => readDetail(db, 'id', id),
  },
  {
    name: 'readDetail, by run id',
    over: { work_state: 'claimed', work_run: 'run', work_lease_until: T + 1_800_000 },
    runId: 'run',
    call: (db, id, runId) => readDetail(db, 'run', runId),
  },
  {
    name: 'approveWork',
    over: { kind: 'open', filed_by: 'human', status: 'new' },
    call: (db, id) => approveWork(db, { id, actor: 'human', mode: 'fix', instruction: '', now: T + 100 }),
  },
  {
    name: 'withdrawWork',
    over: { work_state: 'approved', work_approved_at: T },
    call: (db, id) => withdrawWork(db, { id, actor: 'human', now: T + 100 }),
  },
  {
    name: 'reviewWork',
    over: { work_state: 'review', work_run: 'run' },
    runId: 'run',
    call: (db, id) => reviewWork(db, { id, actor: 'human', decision: 'accept', note: '', now: T + 100 }),
  },
  {
    name: 'claimWork, a named item',
    over: { work_state: 'approved', work_approved_at: T },
    call: (db, id) => claimWork(db, {
      actor: 'ai', runner: 'a-runner', id, leaseSeconds: 1800, now: T + 100,
    }),
  },
  {
    name: 'heartbeatWork',
    over: { work_state: 'claimed', work_run: 'run', work_lease_until: T + 1_800_000 },
    runId: 'run',
    // A17, phase 2 pass 0: this one carried `invariantGuarded: true` until the first statement of
    // its batch took `AND app_id = 'fleet'`. It is an ordinary keyed write now.
    call: (db, id, runId) => heartbeatWork(db, { id, actor: 'ai', run: runId, leaseSeconds: 1800, now: T + 100 }),
  },
  {
    name: 'releaseWork',
    over: { work_state: 'claimed', work_run: 'run', work_lease_until: T + 1_800_000 },
    runId: 'run',
    // A17: same move as heartbeat above, same statement shape, same pass.
    call: (db, id, runId) => releaseWork(db, { id, actor: 'ai', run: runId, note: '', now: T + 100 }),
  },
  {
    name: 'submitWork',
    over: { work_state: 'claimed', work_run: 'run', work_lease_until: T + 1_800_000 },
    runId: 'run',
    call: (db, id, runId) => submitWork(db, {
      id, actor: 'ai', run: runId, outcome: 'fixed', summary: 'Done.', evidence: null,
      refs: [], needsLanding: false, suggestedNote: '', now: T + 100,
    }),
  },
  {
    name: 'landWork',
    over: { work_state: 'accepted', work_run: 'run' },
    runId: 'run',
    run: { needs_landing: 1, review: 'accepted' },
    // A17: BOTH of land's first statements took the literal, the landed path and the not-landed
    // one, so the entry below covers the landed path and tests/tenant-predicates.test.mjs covers
    // the other. Neither is invariant-guarded any more.
    call: (db, id, runId) => landWork(db, {
      id, actor: 'ai', run: runId, landed: true, refs: [{ repo: 'balise-site', commit: 'abc1234' }],
      note: '', now: T + 100,
    }),
  },
];

test('C6: every read and every write that takes a handle serves the fleet row and refuses the identical tenant row', async () => {
  for (const entry of KEYED) {
    // The same row twice, on two databases, differing in app_id and in nothing else. Each side
    // is put in the state this action needs, so the fleet side SUCCEEDS: that is what proves
    // the tenant side was refused by the tenant term and not by a rule.
    for (const appId of [FLEET, TENANT]) {
      const db = sqliteD1();
      const runId = entry.runId ? `${appId}-${entry.runId}` : null;
      const over = { ...entry.over };
      if (over.work_run === 'run') over.work_run = runId;
      const id = plantReport(db, appId, { runId, over, run: entry.run });

      const before = { report: snapshot(db, 'reports', id), run: runId ? snapshot(db, 'work_runs', runId) : null };
      const out = await entry.call(db, id, runId);
      const after = { report: snapshot(db, 'reports', id), run: runId ? snapshot(db, 'work_runs', runId) : null };
      const where = `${entry.name} against ${appId === FLEET ? 'the fleet' : 'a tenant'}`;

      if (appId === FLEET) {
        assert.equal(out.code, undefined, `${where} was refused, so the tenant case below proves nothing: ${json(out)}`);
        // Saw the row, or wrote it. Not every one of these SELECTs carries a string column
        // (readRow names only the columns a rule reads), so the row's own id counts as having
        // seen it: what matters is that the fleet side did the thing the tenant side must not.
        assert.ok(
          json(out).includes(FLEET_MARK) || json(out).includes(id) || before.report !== after.report,
          `${where} neither answered with the row nor wrote it, so this case is vacuous: ${json(out)}`,
        );
        continue;
      }
      // A refusal is an error envelope or an explicit empty. `{ report: null }` is getReport's
      // and `{ item: null }` is the work queue's: both are "there is no such row for you",
      // which is the right answer and is deliberately the same answer a wrong id gets.
      assert.ok(
        out.code !== undefined || out.item === null || out.report === null,
        `${where} succeeded: ${json(out)}`,
      );
      assert.ok(!json(out).includes(TENANT_MARK), `${where} answered with the tenant's own row: ${json(out)}`);
      assert.ok(!json(out).includes(id), `${where} answered with the tenant's row id: ${json(out)}`);

      // THE THREE WRITES THAT USED TO LAND HERE NOW DECLINE, and the branch that asserted they
      // landed is gone (A17, phase 2 pass 0). What it said, for whoever reads this next to
      // understand what changed rather than only that it did: heartbeat, release and land do not
      // read the row first, they go straight to a batch whose first statement was
      // `UPDATE reports SET ... WHERE id = ? AND work_state = 'claimed' AND work_run = ?`, and
      // DESIGN.md section 5 assigned it no predicate on the argument that a claimed row is the
      // fleet's by invariant 4.3. On a row that already breaks the invariant, which is exactly
      // what this loop plants, that write landed on a tenant's row. The branch asserted that
      // rather than hiding it, and said in as many words that a predicate on those statements
      // would be a good change and a contract change.
      //
      // It is now the literal on all four of those statements, so the three entries fall through
      // to the two assertions below like every other keyed write, and nothing in this file is
      // still resting on an invariant a COUNT can only report after it is broken.
      assert.equal(after.report, before.report, `${where} wrote a tenant's report row`);
      assert.equal(after.run, before.run, `${where} wrote a tenant's run row`);
    }
  }
});

