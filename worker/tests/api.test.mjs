// The offline half of the Balise Worker's tests. No network, no database, no workerd.
//
// Four jobs:
//   1. C2.1's drift test: the Worker's ERROR_CODES must equal the site's HANDLED_CODES.
//   2. C1's field rules, over src/validate.js.
//   3. C4's transition table, over src/store.js, including the AI's single edge.
//   4. What the public log projects, over src/store.js. Pure enough for a stub db.
//
// The flows that need a real D1 (rows_read, the lockout, ingest end to end) are in
// tests/local-d1.test.mjs, which runs the Worker under workerd. They are separate on
// purpose: this file has to stay runnable with nothing installed and nothing listening,
// so a contract break is always cheap to detect.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES, HTTP_FOR, SURFACES, originVerdict, allowedOrigins } from '../src/envelope.js';
import {
  validateReport, validatePatch, validateListQuery, validateOpenBatch, validateOpenSync,
  BODY_MIN, BODY_MAX, URL_MAX, KINDS, LIST_KINDS,
} from '../src/validate.js';
import {
  STATUSES, TRANSITIONS, AI_TRANSITIONS, OPEN_TRANSITIONS, canTransition, rowsReadBudget,
  normaliseForFingerprint,
} from '../src/store.js';
// `publicLog` moved to src/store-public.js with the C6 split: the two queries a stranger can
// reach take the literal 'fleet' rather than a bound scope (C6.5), and that rule is now a
// property of a file. Only the path changed here; every expectation below is untouched.
import { publicLog } from '../src/store-public.js';
import { OPEN_SOURCES, IMPORT_BATCH_MAX, SYNC_REFS_MAX, openFingerprintInput, dayStamp } from '../src/store-open.js';

// ── C2.1: the drift test ──────────────────────────────────────────────────────

/**
 * The Worker and the Pages site deploy on different schedules and NOTHING ELSE in the
 * system would notice them drifting apart on error codes. A rename on one side stays
 * invisible until a person clicks Send and reads a blank.
 *
 * js/api.js belongs to workstream C and is written AFTER this file, so at the moment this
 * test was written it does not exist. That case fails rather than skips, with a sentence
 * naming exactly what is missing: a skipped contract test is a contract test that never
 * runs again.
 */
test('C2.1: the worker and the site agree on the exact set of error codes', async () => {
  let site;
  try {
    site = await import('../../js/api.js');
  } catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) {
      assert.fail(
        'projects/balise-site/js/api.js does not exist yet, so the C2.1 drift test cannot run.\n' +
        '  It is workstream C\'s file. It must export HANDLED_CODES, a list equal to the\n' +
        '  worker\'s ERROR_CODES in src/envelope.js, which is currently:\n' +
        `    ${JSON.stringify(ERROR_CODES)}\n` +
        '  Until that file exists this failure is expected and is the point: it is the only\n' +
        '  thing that would notice the worker and the site disagreeing.',
      );
    }
    throw err;
  }
  assert.ok(Array.isArray(site.HANDLED_CODES), 'js/api.js must export HANDLED_CODES as an array');
  assert.deepEqual([...ERROR_CODES].sort(), [...site.HANDLED_CODES].sort());
});

test('C2: no code is listed twice and every code has an HTTP status', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  for (const code of ERROR_CODES) {
    assert.equal(typeof HTTP_FOR[code], 'number', `${code} has no HTTP status`);
  }
  assert.deepEqual(Object.keys(HTTP_FOR).sort(), [...ERROR_CODES].sort());
});

test('C2: no code rides on an HTTP 500, ever', () => {
  for (const [code, status] of Object.entries(HTTP_FOR)) {
    assert.ok(status < 500 || status > 599 || status === 501 || status === 502, `${code} is ${status}`);
    assert.notEqual(status, 500, `${code} is a 500`);
  }
});

test('C2: the surfaces are the four Balise names', () => {
  assert.deepEqual(SURFACES, ['ingest', 'desk', 'log', '']);
});

// ── C2.2: origin policy ───────────────────────────────────────────────────────

const ENV = { BALISE_ALLOWED_ORIGINS: 'https://balise.neorgon.com,http://localhost:8876' };

test('C2.2: an unknown origin is denied, an absent one is not checked', () => {
  assert.equal(originVerdict('https://balise.neorgon.com', ENV), 'allowed');
  assert.equal(originVerdict('https://evil.example', ENV), 'denied');
  assert.equal(originVerdict(null, ENV), 'absent');
  assert.equal(originVerdict('', ENV), 'absent');
});

test('an empty allowlist var falls back to the built in origins rather than to nothing', () => {
  assert.ok(allowedOrigins({ BALISE_ALLOWED_ORIGINS: '' }).includes('https://balise.neorgon.com'));
  assert.ok(allowedOrigins({}).includes('https://balise.neorgon.com'));
});

// ── C1: the report shape ──────────────────────────────────────────────────────

const good = () => ({
  v: 1,
  site: 'parla-site',
  url: 'https://parla.neorgon.com/?q=bacan',
  target: { kind: 'concept', id: 'cool', label: 'bacan' },
  kind: 'wrong',
  body: 'The gloss for bacan says Peru and it is Chilean.',
  contact: '',
});

test('C1: a well formed report passes and comes back normalised', () => {
  const r = validateReport(good());
  assert.equal(r.code, undefined);
  assert.equal(r.value.site, 'parla-site');
  assert.deepEqual(r.value.target, { kind: 'concept', id: 'cool', label: 'bacan' });
});

test('C1: target null is a first class value, not an error', () => {
  for (const t of [null, undefined]) {
    const r = validateReport({ ...good(), target: t });
    assert.equal(r.code, undefined, `target ${String(t)} was rejected`);
    assert.equal(r.value.target, null);
  }
});

test('C1: any v other than 1 is BAD_VERSION, so an old widget fails loudly', () => {
  for (const v of [0, 2, '1', null, undefined]) {
    assert.equal(validateReport({ ...good(), v }).code, 'BAD_VERSION', `v=${JSON.stringify(v)}`);
  }
});

test('C1: the site id rule is the registry id rule', () => {
  assert.equal(validateReport({ ...good(), site: 'Parla-Site' }).code, 'BAD_FIELD');
  assert.equal(validateReport({ ...good(), site: 'a'.repeat(41) }).code, 'BAD_FIELD');
  assert.equal(validateReport({ ...good(), site: '' }).code, 'MISSING_PARAM');
  assert.equal(validateReport({ ...good(), site: 'parla-site' }).code, undefined);
});

test('C1: body is 10 to 2000 characters after trimming', () => {
  assert.equal(validateReport({ ...good(), body: '   ' }).code, 'MISSING_PARAM');
  assert.equal(validateReport({ ...good(), body: 'x'.repeat(BODY_MIN - 1) }).code, 'BAD_FIELD');
  assert.equal(validateReport({ ...good(), body: 'x'.repeat(BODY_MIN) }).code, undefined);
  assert.equal(validateReport({ ...good(), body: 'x'.repeat(BODY_MAX) }).code, undefined);
  assert.equal(validateReport({ ...good(), body: 'x'.repeat(BODY_MAX + 1) }).code, 'BAD_FIELD');
});

test('C1: kind is one of the four', () => {
  for (const k of ['wrong', 'missing', 'broken', 'other']) {
    assert.equal(validateReport({ ...good(), kind: k }).code, undefined, k);
  }
  assert.equal(validateReport({ ...good(), kind: 'typo' }).code, 'BAD_FIELD');
});

test('C1: url is truncated to 512 characters and never normalised away', () => {
  const long = `https://parla.neorgon.com/?q=${'a'.repeat(700)}#state`;
  const r = validateReport({ ...good(), url: long });
  assert.equal(r.value.url.length, URL_MAX);
  const hash = validateReport({ ...good(), url: 'https://x.neorgon.com/#deep/state' });
  assert.equal(hash.value.url, 'https://x.neorgon.com/#deep/state');
});

test('C1: a malformed target is refused rather than silently dropped', () => {
  assert.equal(validateReport({ ...good(), target: { kind: 'Concept', id: 'x' } }).code, 'BAD_FIELD');
  assert.equal(validateReport({ ...good(), target: { kind: 'concept' } }).code, 'BAD_FIELD');
  assert.equal(validateReport({ ...good(), target: [] }).code, 'BAD_FIELD');
  assert.equal(validateReport({ ...good(), target: { kind: 'concept', id: 'x'.repeat(129) } }).code, 'BAD_FIELD');
});

test('C1: contact is optional and capped, and never validated as an email', () => {
  assert.equal(validateReport({ ...good(), contact: 'ping me on the thing' }).code, undefined);
  assert.equal(validateReport({ ...good(), contact: 'x'.repeat(121) }).code, 'BAD_FIELD');
});

// ── C4: the status vocabulary and the transition table ────────────────────────

test('C4: the seven statuses, in the contract order', () => {
  assert.deepEqual(STATUSES, ['new', 'triaged', 'accepted', 'fixed', 'rejected', 'spam', 'duplicate']);
});

test('C4: the transition table matches the contract exactly', () => {
  assert.deepEqual(TRANSITIONS, {
    new: ['triaged', 'accepted', 'rejected', 'spam', 'duplicate'],
    triaged: ['accepted', 'rejected', 'spam', 'duplicate'],
    accepted: ['fixed', 'rejected'],
    fixed: [],
    rejected: ['accepted'],
    spam: ['accepted'],
    duplicate: ['accepted'],
  });
});

test('C4: every pair not in the table is refused', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const legal = TRANSITIONS[from].includes(to);
      assert.equal(canTransition(from, to, 'human'), legal, `${from} -> ${to}`);
    }
  }
});

test('C4: fixed is terminal', () => {
  for (const to of STATUSES) assert.equal(canTransition('fixed', to, 'human'), false, `fixed -> ${to}`);
});

test('C4: automation may record a verdict and close junk, and nothing else', () => {
  assert.deepEqual(AI_TRANSITIONS, {
    new: ['triaged', 'spam', 'duplicate'],
    triaged: ['spam', 'duplicate'],
  });
  // Spelled out as a set rather than a count, so widening the table by accident
  // fails here with the offending edge named instead of an off-by-one.
  const PERMITTED = new Set([
    'new->triaged', 'new->spam', 'new->duplicate',
    'triaged->spam', 'triaged->duplicate',
  ]);
  const seen = new Set();
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (canTransition(from, to, 'ai')) seen.add(`${from}->${to}`);
    }
  }
  assert.deepEqual(seen, PERMITTED);
});

test('C4: automation can never reach a reader, and can never reopen', () => {
  // The whole point of the scope: nothing automation does may publish, and a
  // close it got wrong must need a person to undo.
  for (const from of STATUSES) {
    assert.equal(canTransition(from, 'fixed', 'ai'), false, `ai ${from} -> fixed`);
    assert.equal(canTransition(from, 'accepted', 'ai'), false, `ai ${from} -> accepted`);
    assert.equal(canTransition(from, 'rejected', 'ai'), false, `ai ${from} -> rejected`);
  }
  // Reopening is the human's, so automation cannot walk a report back out of a
  // state it put it in.
  for (const from of ['spam', 'duplicate', 'rejected']) {
    assert.equal(canTransition(from, 'accepted', 'ai'), false, `ai reopen from ${from}`);
  }
  // A human still has the full table, including the reopen.
  assert.equal(canTransition('spam', 'accepted', 'human'), true);
  assert.equal(canTransition('accepted', 'fixed', 'human'), true);
});

// ── The desk's patch body ─────────────────────────────────────────────────────

test('a patch must name a status this service knows', () => {
  assert.equal(validatePatch({}, STATUSES).code, 'MISSING_PARAM');
  assert.equal(validatePatch({ status: 'done' }, STATUSES).code, 'BAD_FIELD');
  assert.equal(validatePatch({ status: 'accepted' }, STATUSES).code, undefined);
});

test('public is a boolean on the wire and an integer in the store', () => {
  assert.equal(validatePatch({ status: 'fixed', public: false }, STATUSES).value.public, 0);
  assert.equal(validatePatch({ status: 'fixed', public: true }, STATUSES).value.public, 1);
  assert.equal(validatePatch({ status: 'fixed', public: 'no' }, STATUSES).code, 'BAD_FIELD');
});

// ── A4: paging is keyset, and the budget is a number, not a hope ──────────────

test('A4: the list query refuses an out of range limit rather than scanning', () => {
  const p = (s) => validateListQuery(new URLSearchParams(s), STATUSES);
  assert.equal(p('limit=0').code, 'BAD_FIELD');
  assert.equal(p('limit=51').code, 'BAD_FIELD');
  assert.equal(p('limit=abc').code, 'BAD_FIELD');
  assert.equal(p('limit=50').value.limit, 50);
  assert.equal(p('').value.limit, 25);
});

test('A4: the cursor is a number, and there is no offset parameter to misuse', () => {
  const p = (s) => validateListQuery(new URLSearchParams(s), STATUSES);
  assert.equal(p('before=abc').code, 'BAD_FIELD');
  assert.equal(p('before=-1').code, 'BAD_FIELD');
  assert.equal(p('before=1756000000000').value.before, 1756000000000);
  assert.equal(p('offset=100').value.before, null);
});

test('A4: the rows_read budget grows with the page and stays a small multiple of it', () => {
  assert.ok(rowsReadBudget(25) < 200);
  assert.ok(rowsReadBudget(50) < 200);
  assert.ok(rowsReadBudget(1) < rowsReadBudget(50));
});

// ── The duplicate guard ───────────────────────────────────────────────────────

test('the fingerprint ignores case and whitespace, and nothing else', () => {
  assert.equal(normaliseForFingerprint('  The  Same\nthing '), normaliseForFingerprint('the same thing'));
  assert.notEqual(normaliseForFingerprint('the same thing'), normaliseForFingerprint('the same things'));
});

/* ── The open-items board (queue #58) ──────────────────────────────────────────
 *
 * The kind-scoped transition table and the shape of an import batch. The redaction rules
 * are in tests/redact.test.mjs, which is a file of its own because that check is the one
 * piece of this feed that also ships to the site. The flows are in
 * tests/open-items.test.mjs.
 */

// ── C4, kind-scoped ───────────────────────────────────────────────────────────

test('C4: an open item takes the human table plus one edge, new -> fixed', () => {
  assert.deepEqual(OPEN_TRANSITIONS, {
    new: ['triaged', 'accepted', 'fixed', 'rejected', 'spam', 'duplicate'],
    triaged: ['accepted', 'rejected', 'spam', 'duplicate'],
    accepted: ['fixed', 'rejected'],
    fixed: [],
    rejected: ['accepted'],
    spam: ['accepted'],
    duplicate: ['accepted'],
  });
  // The one edge, and the reason for it: an item whose source closed before anyone
  // published it is a resolution, not an open item that resolved a second later.
  assert.equal(canTransition('new', 'fixed', 'human', 'open'), true);
  assert.equal(canTransition('new', 'fixed', 'human'), false);
  assert.equal(canTransition('new', 'fixed', 'human', null), false);
});

test('C4: the corrections table is untouched by the open feed existing', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      assert.equal(canTransition(from, to, 'human'), TRANSITIONS[from].includes(to), `${from} -> ${to}`);
    }
  }
});

test('C4: automation has NO edge on an open item, not one', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      assert.equal(canTransition(from, to, 'ai', 'open'), false, `ai open ${from} -> ${to}`);
    }
  }
  // And it keeps the corrections edges it already had, so this narrowed nothing else.
  assert.equal(canTransition('new', 'triaged', 'ai'), true);
  assert.equal(canTransition('new', 'spam', 'ai'), true);
});

// ── The list filter ───────────────────────────────────────────────────────────

test('the desk may ask for a kind, and only for a kind this service knows', () => {
  const p = (s) => validateListQuery(new URLSearchParams(s), STATUSES);
  assert.equal(p('kind=open').value.kind, 'open');
  assert.equal(p('kind=wrong').value.kind, 'wrong');
  assert.equal(p('').value.kind, null, 'no kind means the corrections queue, not everything');
  assert.equal(p('kind=secret').code, 'BAD_FIELD');
  assert.deepEqual(LIST_KINDS, [...KINDS, 'open']);
});

// ── The import batch ──────────────────────────────────────────────────────────

const batch = (over = {}) => ({
  v: 1,
  source: 'queue',
  items: [{ ref: '#58', text: 'Balise as the fleet open-items board', opened_at: 1757289600000 }],
  ...over,
});

test('an import batch names one of the four trackers and format 1', () => {
  assert.equal(validateOpenBatch(batch(), OPEN_SOURCES, IMPORT_BATCH_MAX).code, undefined);
  assert.equal(validateOpenBatch(batch({ source: 'inbox' }), OPEN_SOURCES, IMPORT_BATCH_MAX).code, 'BAD_FIELD');
  assert.equal(validateOpenBatch(batch({ source: '' }), OPEN_SOURCES, IMPORT_BATCH_MAX).code, 'MISSING_PARAM');
  assert.equal(validateOpenBatch(batch({ v: 2 }), OPEN_SOURCES, IMPORT_BATCH_MAX).code, 'BAD_VERSION');
  assert.deepEqual(OPEN_SOURCES, ['queue', 'brief', 'harness', 'registry']);
});

test('an import batch is capped at the query budget, not at a size', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ ref: `#${i}`, text: 'x' }));
  assert.equal(validateOpenBatch(batch({ items: many(IMPORT_BATCH_MAX) }), OPEN_SOURCES, IMPORT_BATCH_MAX).code, undefined);
  assert.equal(validateOpenBatch(batch({ items: many(IMPORT_BATCH_MAX + 1) }), OPEN_SOURCES, IMPORT_BATCH_MAX).code, 'BAD_FIELD');
  assert.equal(validateOpenBatch(batch({ items: [] }), OPEN_SOURCES, IMPORT_BATCH_MAX).code, 'MISSING_PARAM');
});

test('an item needs a ref and text, and a ref may not repeat inside one batch', () => {
  assert.equal(validateOpenBatch(batch({ items: [{ text: 'x' }] }), OPEN_SOURCES, IMPORT_BATCH_MAX).code, 'MISSING_PARAM');
  assert.equal(validateOpenBatch(batch({ items: [{ ref: '#1' }] }), OPEN_SOURCES, IMPORT_BATCH_MAX).code, 'MISSING_PARAM');
  // A repeat would insert once and report the second as unchanged, which reads as
  // "already imported" when it means "sent twice".
  const twice = validateOpenBatch(batch({ items: [{ ref: '#1', text: 'a' }, { ref: '#1', text: 'b' }] }), OPEN_SOURCES, IMPORT_BATCH_MAX);
  assert.equal(twice.code, 'BAD_FIELD');
  assert.match(twice.message, /twice/);
});

test('a timestamp is milliseconds, so a seconds value is caught rather than stored', () => {
  const secs = validateOpenBatch(batch({ items: [{ ref: '#1', text: 'a', opened_at: 1757289600 }] }), OPEN_SOURCES, IMPORT_BATCH_MAX);
  assert.equal(secs.code, 'BAD_FIELD');
  assert.match(secs.message, /millisecond/);
  assert.equal(validateOpenBatch(batch({ items: [{ ref: '#1', text: 'a', opened_at: null }] }), OPEN_SOURCES, IMPORT_BATCH_MAX).code, undefined);
});

test('a sync call carries the complete ref set for one tracker', () => {
  assert.equal(validateOpenSync({ source: 'queue', refs: ['#1', '#2'] }, OPEN_SOURCES, SYNC_REFS_MAX).code, undefined);
  // An empty list is refused (C-j). It would mark every item of that tracker closed at its
  // source in one call, and only a later import of each item clears that mark again.
  const empty = validateOpenSync({ source: 'harness', refs: [] }, OPEN_SOURCES, SYNC_REFS_MAX);
  assert.equal(empty.code, 'MISSING_PARAM');
  assert.equal(empty.value, undefined);
  assert.equal(validateOpenSync({ source: 'queue' }, OPEN_SOURCES, SYNC_REFS_MAX).code, 'MISSING_PARAM');
  assert.equal(validateOpenSync({ source: 'queue', refs: [1, 2] }, OPEN_SOURCES, SYNC_REFS_MAX).code, 'BAD_FIELD');
});

test('the open-item fingerprint separates its three parts', () => {
  // No pair of (source, ref) values may collide by concatenation.
  assert.notEqual(openFingerprintInput('queue', 'x#1'), openFingerprintInput('queuex', '#1'));
  assert.equal(openFingerprintInput('queue', '#58'), openFingerprintInput('queue', '#58'));
});

test('the board shows a day and never a time', () => {
  assert.equal(dayStamp(Date.UTC(2026, 8, 9, 23, 59)), '2026-09-09');
  for (const bad of [null, undefined, 0, -1, NaN, 'yesterday']) assert.equal(dayStamp(bad), null);
});

// ── The public projection of a report's url ───────────────────────────────────

/**
 * GET /log is the only public, cacheable, crawler-visible route this service has, and it
 * carries the url of every fixed report. A url is not neutral. The Beacon sends
 * `location.href`, so a report filed from a Vitrina public shelf carries the owner's handle
 * in the query, and one filed from a Sash claim page carries a WORKING bearer token there.
 *
 * Trimming to origin plus pathname keeps what the log is for (which page was wrong) and
 * drops what it was never for (who was looking at it, and with what). The STORED column
 * keeps the whole address: the operator needs it to reproduce the report, and that is the
 * job of the desk routes, not of this one.
 */

/** The smallest thing `publicLog` can read: one prepare, one bind, one run. */
function logStub(urls) {
  const results = urls.map((url, i) => ({
    site: 'vitrina-site',
    url,
    target_label: null,
    public_note: 'Corrected that entry.',
    fixed_ref: null,
    fixed_at: 2_000 - i,
  }));
  const run = async () => ({ results, meta: { rows_read: results.length } });
  return { prepare: () => ({ bind: () => ({ run }) }) };
}

async function loggedUrls(urls) {
  const { entries } = await publicLog(logStub(urls), { before: null, limit: urls.length });
  return entries.map((e) => e.url);
}

test('#76: the public log publishes the page, never the query that identifies the reader', async () => {
  assert.deepEqual(
    await loggedUrls([
      'https://vitrina.neorgon.com/u/?owner=a-real-handle',
      'https://sash.neorgon.com/claim.html?t=eyJhbGciOiJIUzI1NiJ9.made-up.token',
    ]),
    ['https://vitrina.neorgon.com/u/', 'https://sash.neorgon.com/claim.html'],
  );
});

test('#76: a fragment and a userinfo prefix are dropped too', async () => {
  assert.deepEqual(
    await loggedUrls([
      'https://parla.neorgon.com/glossary#deep/state',
      'https://reader:hunter2@vitrina.neorgon.com/shelf/12',
    ]),
    ['https://parla.neorgon.com/glossary', 'https://vitrina.neorgon.com/shelf/12'],
  );
});

test('#76: anything that is not an http address becomes null rather than reaching the page', async () => {
  assert.deepEqual(
    await loggedUrls(['not a url at all', 'javascript:alert(1)', 'data:text/html,<b>x', '', null]),
    [null, null, null, null, null],
  );
});

test('#76: the key is still called url, because the /log response shape is frozen', async () => {
  const { entries } = await publicLog(logStub(['https://vitrina.neorgon.com/u/?owner=x']), { before: null, limit: 1 });
  assert.deepEqual(
    Object.keys(entries[0]).sort(),
    ['fixed_at', 'fixed_ref', 'public_note', 'site', 'target_label', 'url'],
  );
});
