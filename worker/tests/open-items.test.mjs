// The open-items feed under workerd, against a real local D1 (queue #58).
//
// A separate file from tests/local-d1.test.mjs for one reason: BOTH feeds have to be in
// the same table for these assertions to mean anything, and one file carrying both suites
// went past the fleet's 500 line cap. Process control, the request helper and the two
// seeders are shared through ./harness.mjs, so there is still exactly one definition of
// "start the Worker and wait for it".
//
// What only a real database can show, and therefore what is here:
//   1. the migrations, and that migrations/0001 is still schema.sql byte for byte;
//   2. idempotence, which is the UNIQUE index on the fingerprint doing its job;
//   3. that an import writing 25 rows in one invocation is still fully reachable by a
//      keyset cursor, which it was not before those rows got distinct timestamps;
//   4. the redaction refusal at the point it actually matters, on the way into the store;
//   5. the board serving three fields and nothing else, with 68 private rows beside it.
//
// The rules themselves are asserted with no database at all in tests/api.test.mjs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  WORKER_DIR, TOKEN, AI_TOKEN, SALT, TURNSTILE_PASS,
  migrate, run, startWorker, stopWorker, requester, openBatch, seedReports, seedOpenItems,
} from './harness.mjs';
import { rowsReadBudget } from '../src/store.js';

const STATE = join(WORKER_DIR, '.wrangler/open-items-state');
const PORT = 8882;
const BASE = `http://127.0.0.1:${PORT}`;
const call = requester(BASE);

const SEEDED = 12;
const OPEN_SEEDED = 30;

let worker = null;

before(async () => {
  rmSync(STATE, { recursive: true, force: true });
  await migrate(STATE);
  worker = await startWorker(PORT, {
    BALISE_OPERATOR_TOKEN: TOKEN,
    BALISE_AUTOMATION_TOKEN: AI_TOKEN,
    BALISE_IP_SALT: SALT,
    BALISE_TURNSTILE_SECRET: TURNSTILE_PASS,
  }, STATE);

  // Corrections first, then imports, both through their real routes. The corrections are
  // here so that every "the two feeds do not see each other" assertion has something on
  // the other side of it.
  await seedReports(call, SEEDED, assert);
  await seedOpenItems(call, OPEN_SEEDED, assert);
}, { timeout: 300_000 });

after(async () => {
  await stopWorker(worker);
});

test('the migration file IS the schema file, so the two cannot drift', () => {
  // schema.sql is the baseline alone and the migrations are the store's shape: 0001 is
  // schema.sql, and every migration after it adds to that (0002 open items, 0003 work, 0004
  // tenants; the list is migrations/ and not this line). The two files are the same bytes, and this is
  // the only thing that would notice one of them being edited alone.
  const schema = readFileSync(join(WORKER_DIR, 'schema.sql'), 'utf8');
  const baseline = readFileSync(join(WORKER_DIR, 'migrations/0001_baseline.sql'), 'utf8');
  assert.equal(baseline, schema, 'migrations/0001_baseline.sql has drifted from schema.sql');
});

test('the migrations build the columns the open feed needs', async () => {
  const out = await run(['d1', 'execute', 'balise', '--local', '--persist-to', STATE, '--json',
    '--command', "SELECT name FROM pragma_table_info('reports')"]);
  const names = JSON.parse(out.slice(out.indexOf('[')))[0].results.map((r) => r.name);
  for (const column of ['source', 'source_ref', 'suggested', 'opened_at', 'source_closed_at']) {
    assert.ok(names.includes(column), `${column} is missing after the migrations`);
  }
  // And the corrections columns are all still there: 0002 adds, it never rewrites.
  for (const column of ['id', 'created_at', 'site', 'kind', 'body', 'public_note', 'fixed_at', 'fingerprint']) {
    assert.ok(names.includes(column), `${column} went missing`);
  }
});

// ── The import route ──────────────────────────────────────────────────────────

async function openList(query = '') {
  const { body } = await call(`/reports?kind=open&limit=50${query}`, { token: TOKEN, ip: '192.0.2.30' });
  return body;
}

test('a second import of the same lines creates nothing and loses nothing', async () => {
  const first = await openList();
  const items = openBatch(0, 25);
  const { res, body } = await call('/open-items', { method: 'POST', body: { v: 1, source: 'queue', items }, token: AI_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.created, 0, 're-importing created a second draft of an item already in the queue');
  assert.equal(body.unchanged, 25);
  const second = await openList();
  assert.equal(second.reports.length, first.reports.length);
});

test('every imported row is reachable by paging, ties included', async () => {
  // The defect this guards: an import writes 25 rows inside one invocation, so without
  // distinct timestamps they all share `now` and the keyset cursor skips every row that
  // ties with it. Measured before the fix: 70 imported, 65 reachable.
  const seen = new Set();
  let before = null;
  for (let page = 0; page < 10; page += 1) {
    const { body } = await call(`/reports?kind=open&limit=10${before ? `&before=${before}` : ''}`, { token: TOKEN, ip: '192.0.2.31' });
    for (const r of body.reports) seen.add(r.id);
    if (!body.next || !body.reports.length) break;
    before = body.next;
  }
  assert.equal(seen.size, OPEN_SEEDED, `paging reached ${seen.size} of ${OPEN_SEEDED} imported items`);
});

test('an imported item arrives PRIVATE, carrying its tracker date and its own ref', async () => {
  const { reports } = await openList();
  const row = reports.find((r) => r.source_ref === '#900');
  assert.ok(row, 'the imported item is not in the queue');
  assert.equal(row.status, 'new', 'an import may not arrive at any status but new');
  assert.equal(row.kind, 'open');
  assert.equal(row.source, 'queue');
  assert.equal(row.public_note, '', 'an import may not arrive with a public sentence');
  // opened_at is the TRACKER's date, not the import's, or a two year old item would
  // arrive looking new.
  assert.equal(row.opened_at, Date.UTC(2026, 7, 1));
  assert.ok(row.created_at > row.opened_at);
});

test('an item whose tracker line closed arrives marked closed, and still private', async () => {
  const { reports } = await openList();
  const closed = reports.filter((r) => r.source_closed_at);
  assert.ok(closed.length >= 7, `expected the closed quarter of the seed, saw ${closed.length}`);
  for (const row of closed) assert.equal(row.status, 'new', 'a closed source published itself');
});

test('the import route refuses a batch over the query budget, and an unknown tracker', async () => {
  const many = Array.from({ length: 26 }, (_, i) => ({ ref: `#z${i}`, text: 'x' }));
  const big = await call('/open-items', { method: 'POST', body: { v: 1, source: 'queue', items: many }, token: AI_TOKEN });
  assert.equal(big.res.status, 400);
  assert.equal(big.body.code, 'BAD_FIELD');

  const wrong = await call('/open-items', { method: 'POST', body: { v: 1, source: 'inbox', items: [{ ref: 'a', text: 'b' }] }, token: AI_TOKEN });
  assert.equal(wrong.body.code, 'BAD_FIELD');
});

test('the import routes are behind the token, like the desk', async () => {
  const bare = await call('/open-items', { method: 'POST', body: { v: 1, source: 'queue', items: [{ ref: 'a', text: 'b' }] }, ip: '192.0.2.32' });
  assert.equal(bare.res.status, 401);
  assert.equal(bare.body.code, 'UNAUTHORIZED');
  // No token, so the 401 comes before the body is read. With a token, an empty refs list is
  // refused MISSING_PARAM (tests/api.test.mjs), because it would close the whole source.
  const sync = await call('/open-items/sync', { method: 'POST', body: { source: 'queue', refs: [] }, ip: '192.0.2.32' });
  assert.equal(sync.res.status, 401);
});

test('sync closes what the importer no longer sees, and only that', async () => {
  const before = await openList();
  // The list names the seed's closed lines too, as the importer's does with its ## Done lines.
  // A sync clears no mark, so #908 is still closed for the resolution test below; only an
  // import that sends a ref with no closed_at clears one.
  const kept = before.reports.filter((r) => r.source_ref !== '#901').map((r) => r.source_ref);
  const { res, body } = await call('/open-items/sync', { method: 'POST', body: { source: 'queue', refs: kept }, token: AI_TOKEN });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.closed, 1, 'sync closed something other than the one missing ref');

  const after = await openList();
  assert.ok(after.reports.find((r) => r.source_ref === '#901').source_closed_at, '#901 was not marked closed');
  // Running it again closes nothing: the second pass has nothing left to decide.
  const again = await call('/open-items/sync', { method: 'POST', body: { source: 'queue', refs: kept }, token: AI_TOKEN });
  assert.equal(again.body.closed, 0);
});

// ── The desk, with two feeds in one table ─────────────────────────────────────

test('the corrections queue does not show imported drafts, and the open feed does not show reports', async () => {
  const corrections = await call('/reports?limit=50', { token: TOKEN, ip: '192.0.2.33' });
  assert.ok(corrections.body.reports.length > 0);
  assert.ok(!corrections.body.reports.some((r) => r.kind === 'open'), 'an imported draft reached the corrections queue');

  const open = await openList();
  assert.ok(open.reports.length > 0);
  assert.ok(open.reports.every((r) => r.kind === 'open'), 'a stranger report reached the open feed');
});

test('A4: neither feed makes the other one scan the table', async () => {
  for (const limit of [1, 5, 25]) {
    const corrections = await call(`/reports?limit=${limit}`, { token: TOKEN, ip: '192.0.2.34' });
    assert.ok(
      corrections.body.rows_read <= rowsReadBudget(limit),
      `corrections page of ${limit} scanned ${corrections.body.rows_read} rows with ${OPEN_SEEDED} open items present`,
    );
    const open = await call(`/reports?kind=open&limit=${limit}`, { token: TOKEN, ip: '192.0.2.34' });
    assert.ok(
      open.body.rows_read <= rowsReadBudget(limit),
      `open page of ${limit} scanned ${open.body.rows_read} rows with ${SEEDED} reports present`,
    );
  }
});

// ── Publishing, and the redaction floor ───────────────────────────────────────

async function anOpenDraft(ref) {
  const { reports } = await openList();
  return reports.find((r) => r.source_ref === ref);
}

test('the redaction floor refuses a path, a line number, a tracker id and a token', async () => {
  const draft = await anOpenDraft('#902');
  const cases = [
    ['packages/neorgon-ui/footer', 'file path'],
    ['The guard at line 217 never fires.', 'line number'],
    ['Closing #41 finishes it.', 'tracker id'],
    ['Rotate ghp_AbCdEf0123456789 first.', 'credential-shaped string'],
    ['Set BALISE_OPERATOR_TOKEN first.', 'variable name'],
  ];
  for (const [note, rule] of cases) {
    const { res, body } = await call(`/reports/${draft.id}`, {
      method: 'PATCH', body: { status: 'accepted', public_note: note }, token: TOKEN, ip: '192.0.2.35',
    });
    assert.equal(res.status, 400, `"${note}" was published`);
    assert.equal(body.code, 'BAD_FIELD');
    assert.match(body.message, new RegExp(rule), `the refusal did not name the ${rule}`);
    assert.match(body.hint, /Rewrite it/);
  }
  // And it is still a draft afterwards: a refused publish changes nothing.
  assert.equal((await anOpenDraft('#902')).status, 'new');
});

test('an open item cannot be published with no sentence at all', async () => {
  const draft = await anOpenDraft('#903');
  const { res, body } = await call(`/reports/${draft.id}`, { method: 'PATCH', body: { status: 'accepted' }, token: TOKEN, ip: '192.0.2.36' });
  assert.equal(res.status, 400);
  assert.equal(body.code, 'BAD_FIELD');
});

test('automation is refused every move on an open item, including the ones it has on reports', async () => {
  const draft = await anOpenDraft('#904');
  for (const to of ['triaged', 'spam', 'duplicate', 'accepted', 'fixed']) {
    const { res, body } = await call(`/reports/${draft.id}`, {
      method: 'PATCH', body: { status: to, public_note: 'A tidy sentence.', duplicate_of: 'x' }, token: AI_TOKEN, ip: '192.0.2.37',
    });
    assert.equal(res.status, 409, `automation took open new -> ${to}`);
    assert.equal(body.code, 'BAD_TRANSITION');
  }
  assert.equal((await anOpenDraft('#904')).status, 'new');
});

test('a person publishes an open item, and a resolution takes one move from the draft', async () => {
  const openDraft = await anOpenDraft('#905');
  const published = await call(`/reports/${openDraft.id}`, {
    method: 'PATCH',
    body: { status: 'accepted', public_note: 'The fleet-wide compliance checker is being reworked and its exit codes change.' },
    token: TOKEN,
    ip: '192.0.2.38',
  });
  assert.equal(published.res.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.report.status, 'accepted');

  // #908 is one of the seeded items whose tracker line closed. new -> fixed directly:
  // publishing it as open first would flash an entry that was already finished.
  const closedDraft = await anOpenDraft('#908');
  assert.ok(closedDraft.source_closed_at, 'the fixture is not a closed one');
  const resolved = await call(`/reports/${closedDraft.id}`, {
    method: 'PATCH',
    body: { status: 'fixed', public_note: 'Lockfiles are committed across the fleet now, so a fresh install is reproducible.' },
    token: TOKEN,
    ip: '192.0.2.38',
  });
  assert.equal(resolved.res.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.report.status, 'fixed');
  assert.ok(resolved.body.report.fixed_at > 0);
});

// ── The public board ──────────────────────────────────────────────────────────

test('the board shows what a person published, resolved first, and nothing else', async () => {
  const { res, body } = await call('/board');
  assert.equal(res.status, 200);
  assert.equal(body.provider, 'log');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');

  assert.ok(body.resolved.length >= 1, 'the resolution is missing from the board');
  assert.ok(body.open.length >= 1, 'the open entry is missing from the board');
  assert.match(body.resolved[0].text, /Lockfiles are committed/);
  assert.match(body.open[0].text, /compliance checker/);

  // One line: a state, a sentence, a date. Nothing else, on any entry.
  for (const entry of [...body.resolved, ...body.open]) {
    assert.deepEqual(Object.keys(entry).sort(), ['date', 'state', 'text']);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    // in_progress arrived with the work queue; nothing in this suite is being worked on,
    // and tests/work.test.mjs is where an entry actually takes that state.
    assert.ok(['open', 'in_progress', 'resolved'].includes(entry.state));
  }
});

test('the board carries no draft, no private text and no private ref', async () => {
  const { body } = await call('/board');
  const text = JSON.stringify(body);
  assert.ok(!text.includes('enforce.py'), 'the board served the tracker line itself');
  assert.ok(!text.includes('#900'), 'the board served a private ref');
  assert.ok(!text.includes('queue'), 'the board named the source');
  assert.ok(!text.includes('Seeded tracker line'), 'the board served the private body');
  // 28 of the 30 seeded items are still drafts and none of them may appear.
  assert.ok(body.open.length + body.resolved.length <= 4, 'a draft reached the board');
});

test('the board answers with no credential, and never honours one', async () => {
  const anonymous = await call('/board');
  const withToken = await call('/board', { token: TOKEN });
  assert.equal(anonymous.res.status, 200);
  assert.deepEqual(anonymous.body, withToken.body, 'the board answered an operator differently');
});

test('A4: the board reads the published rows, not the table', async () => {
  for (const limit of [1, 5, 25, 50]) {
    const { body } = await call(`/board?limit=${limit}`);
    assert.equal(typeof body.rows_read, 'number');
    assert.ok(
      body.rows_read <= rowsReadBudget(limit),
      `board of ${limit} scanned ${body.rows_read} rows with ${SEEDED + OPEN_SEEDED} rows in the table`,
    );
  }
});

test('a resolved open item is on the board and NOT in the corrections log', async () => {
  const { body } = await call('/log?limit=50');
  for (const entry of body.entries) {
    assert.ok(!/Lockfiles are committed/.test(entry.public_note || ''), 'an open item reached the corrections log');
    assert.ok(entry.site !== 'queue', 'an imported row reached the corrections log');
  }
});

test('an imported item is never counted as a live Beacon', async () => {
  // /health is the only read-back that would notice a Beacon that stopped working. Thirty
  // imported rows carrying a source name in `site` would put four invented sites at the
  // top of that list and drown the signal.
  const { body } = await call('/health');
  assert.ok(!body.sites.some((s) => s.site === 'queue'), 'an import showed up as a site with a Beacon');
  const parla = body.sites.find((s) => s.site === 'parla-site');
  assert.equal(parla.reports, SEEDED, 'the per-site count moved when the second feed arrived');
});

test('a draft the operator keeps private stays off the board', async () => {
  const draft = await anOpenDraft('#906');
  const { res } = await call(`/reports/${draft.id}`, { method: 'PATCH', body: { status: 'rejected' }, token: TOKEN, ip: '192.0.2.39' });
  assert.equal(res.status, 200);
  const { body } = await call('/board');
  assert.ok(!JSON.stringify(body).includes('#906'));
  assert.equal((await anOpenDraft('#906')).status, 'rejected');
});
