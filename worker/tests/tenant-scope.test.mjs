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
import { principalFor } from '../src/index.js';
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
  snapshot, plantReport, fleetOnly, source,
} from './tenant-fixture.mjs';

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
  // src/index.js is what decides the kind, and while it read
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
  // asserted over the source: no file with a public read in it binds `app_id` at all.
  for (const file of ['store-public.js', 'store-open.js']) {
    const text = source(file);
    const literals = text.match(/app_id = 'fleet'/g) || [];
    assert.ok(literals.length >= 2, `src/${file} carries ${literals.length} fleet literals`);
    assert.doesNotMatch(text, /app_id\s*=\s*\?/, `src/${file} binds app_id, which C6.5 says it must not`);
    assert.doesNotMatch(text, /tenantKey|scopeFor/, `src/${file} reaches for a scope, which C6.5 says it must not`);
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
    invariantGuarded: true,
    call: (db, id, runId) => heartbeatWork(db, { id, actor: 'ai', run: runId, leaseSeconds: 1800, now: T + 100 }),
  },
  {
    name: 'releaseWork',
    over: { work_state: 'claimed', work_run: 'run', work_lease_until: T + 1_800_000 },
    runId: 'run',
    invariantGuarded: true,
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
    invariantGuarded: true,
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

      if (entry.invariantGuarded) {
        // THREE WRITES ARE GUARDED BY INVARIANT 4.3 AND NOT BY A TERM, and this branch is where
        // that costs something. heartbeat, release and land do not read the row first: they go
        // straight to a batch whose first statement is
        // `UPDATE reports SET ... WHERE id = ? AND work_state = 'claimed' AND work_run = ?`,
        // which DESIGN.md section 5 assigns no predicate because a claimed row is the fleet's.
        // On the row planted here, which the invariant forbids, that write lands.
        //
        // It is asserted rather than hidden. What it takes to reach: a row that already breaks
        // invariant 4.3, plus its id, plus its run id, which is a UUID this Worker generates and
        // never gives to a tenant. The answer still leaks nothing, because it comes back through
        // workItem and explain, and both of those carry the literal. The two counts asserted
        // below are therefore the whole defence, which is the reason they are asserted at all.
        //
        // If this ever fails because the row did NOT change, a predicate was added to one of
        // those three statements. That is a good change and it is a contract change: move the
        // entry out of this branch deliberately rather than loosening the assertion.
        assert.notEqual(
          after.report, before.report,
          `${entry.name} no longer writes a row that breaks invariant 4.3, so its taxonomy in section 5 changed: update this table`,
        );
        continue;
      }
      assert.equal(after.report, before.report, `${where} wrote a tenant's report row`);
      assert.equal(after.run, before.run, `${where} wrote a tenant's run row`);
    }
  }
});

