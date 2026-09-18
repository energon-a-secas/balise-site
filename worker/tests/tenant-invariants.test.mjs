// CONTRACTS.md C6, asserted, part two: the import path, whose handle is a fingerprint rather
// than an id, the fleet work queue, and the two invariants of DESIGN.md section 4.3, counted
// after every write path in the Worker has run. Part one is tests/tenant-scope.test.mjs.
//
// The two-copy shape every test here uses, the two canary marks, and why this runs over
// node:sqlite rather than workerd, are all explained once in tests/tenant-fixture.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sqliteD1 } from './sqlite-d1.mjs';
import { FLEET, FLEET_SCOPE } from '../src/scope.js';
import {
  sha256Hex, fingerprintInput, insertReport, listReports, applyTransition,
} from '../src/store.js';
import {
  openFingerprintInput, upsertOpenItems, syncOpenSource,
} from '../src/store-open.js';
import {
  listWork, insertDirectItem, approveWork, withdrawWork, reviewWork,
} from '../src/store-work.js';
import {
  claimWork, heartbeatWork, releaseWork, submitWork, landWork,
} from '../src/store-work-runner.js';
import {
  T, FLEET_MARK, TENANT, json, snapshot, plantReport, fleetOnly, invariantCounts,
} from './tenant-fixture.mjs';

// ── The import path, where the handle is a fingerprint ────────────────────────

/**
 * The import's handle is a FINGERPRINT rather than an id, and its three statements are keyed
 * on it: one SELECT that decides whether a row exists, and two UPDATEs on the row that does.
 * So the row to plant is a tenant row already holding the fingerprint the import is about to
 * compute. A11 keeps that collision improbable by putting the tenant inside the hash;
 * improbable is not a predicate, and what the literal does is make the case unreachable.
 *
 * WHAT THE COLLISION COSTS IS AN INSERT, NOT A ROW. `reports_fp` is UNIQUE on `fingerprint`
 * alone, deliberately (A11), so the fleet's INSERT hits ON CONFLICT DO NOTHING against the
 * tenant's row and the import reports `unchanged` instead of `created`. It reads nothing of the
 * tenant's, writes nothing of the tenant's, and answers a count that is one short. That is the
 * safe end of the trade and it needs saying out loud, because the alternative shape
 * (`UNIQUE(app_id, fingerprint)`) would have made the three ON CONFLICT clauses ambiguous.
 */
test('C6: an import never reads or writes a tenant row that collides on fingerprint', async () => {
  const ref = '#collide';
  const collision = await sha256Hex(openFingerprintInput('queue', ref));

  // The discriminating case is a CLOSE. With the predicate, the dedupe SELECT sees nothing, the
  // import takes its INSERT branch and stops at the unique index. Without it, the tenant's row
  // reads as an existing open item and the close UPDATE is aimed straight at it.
  for (const [name, planted, item] of [
    ['a close', { source_closed_at: null }, { closed_at: T + 5 }],
    ['a reopen', { source_closed_at: T - 5 }, { closed_at: null }],
  ]) {
    const db = sqliteD1();
    const tenantId = plantReport(db, TENANT, {
      id: 'tenant-collision',
      over: {
        kind: 'wrong', status: 'new', fingerprint: collision, source: 'queue', source_ref: ref, ...planted,
      },
    });
    const before = snapshot(db, 'reports', tenantId);
    const out = await upsertOpenItems(db, {
      source: 'queue',
      items: [{ ref, text: `An imported line, ${FLEET_MARK}.`, suggested: '', opened_at: T, ...item }],
      now: T,
    });
    assert.deepEqual(
      { closed: out.closed, reopened: out.reopened },
      { closed: 0, reopened: 0 },
      `${name} reached a tenant's row: ${json(out)}`,
    );
    assert.equal(out.unchanged, 1, `${name} did not stop at the unique index: ${json(out)}`);
    assert.equal(snapshot(db, 'reports', tenantId), before, `${name} wrote a tenant's row`);
    // The positive control: without a collision the same import creates a row, so the case
    // above is a refused close and not an import that cannot work at all.
    const clean = await upsertOpenItems(db, {
      source: 'queue',
      items: [{ ref: '#clean', text: `Another line, ${FLEET_MARK}.`, suggested: '', opened_at: T, ...item }],
      now: T,
    });
    assert.equal(clean.created, 1, `the import creates nothing even with no collision: ${json(clean)}`);
  }
});

test("C6: a sync closes the fleet's unlisted items and never a tenant's", async () => {
  const db = sqliteD1();
  // The sync closes every row of one source whose ref the importer did not see this run. It is
  // the widest read in the file and its UPDATE takes a LIST of fingerprints, so it is the one
  // statement where a single collision could reach fifty rows at once.
  const imported = await upsertOpenItems(db, {
    source: 'queue',
    items: [
      { ref: '#listed', text: `A line still open, ${FLEET_MARK}.`, suggested: '', opened_at: T, closed_at: null },
      { ref: '#unlisted', text: `A line the importer stopped seeing, ${FLEET_MARK}.`, suggested: '', opened_at: T, closed_at: null },
    ],
    now: T,
  });
  assert.equal(imported.created, 2, json(imported));
  const tenantOpen = plantReport(db, TENANT, {
    id: 'tenant-open-unlisted',
    over: {
      kind: 'open', status: 'new', fingerprint: 'fp-tenant-unlisted',
      source: 'queue', source_ref: '#tenant-unlisted', source_closed_at: null,
    },
  });
  const before = snapshot(db, 'reports', tenantOpen);
  const swept = await syncOpenSource(db, { source: 'queue', refs: ['#listed'], now: T + 10 });
  assert.equal(swept.closed, 1, `the sync closed ${swept.closed} rows rather than the one unlisted fleet row: ${json(swept)}`);
  assert.equal(snapshot(db, 'reports', tenantOpen), before, "the sync closed a tenant's row");
});

// ── The work queue, and the one statement with no predicate ───────────────────

test('A16: the fleet work queue hands out nothing of a tenant\'s, and the tally is why 4.3 is asserted', async () => {
  const db = sqliteD1();
  // A tenant row IN THE WORK QUEUE. Invariant 4.3 says this row cannot exist, and the only two
  // writes that could make one carry the literal 'fleet', so it is planted here rather than
  // produced: CLAIMABLE's own term is the subject of this test, and a term can only be tested
  // against the row it excludes.
  const tenantQueued = plantReport(db, TENANT, {
    id: 'tenant-approved',
    over: { work_state: 'approved', work_approved_at: T, work_updated_at: T, work_mode: 'fix' },
  });
  const before = snapshot(db, 'reports', tenantQueued);
  const fleetQueued = plantReport(db, FLEET, {
    id: 'fleet-approved',
    over: {
      work_state: 'approved', work_approved_at: T + 1, work_updated_at: T + 1, work_mode: 'fix',
      fingerprint: `fp-fleet-approved-${FLEET_MARK}`,
    },
  });

  // CLAIMABLE is the only statement in the Worker that hands a runner a row NOBODY NAMED, so
  // it is the only one where a missing term is reached without guessing an id. The tenant row
  // is the older approval, so a claim with no id would take it first if it could.
  const claimed = await claimWork(db, { actor: 'ai', runner: 'a-runner', leaseSeconds: 1800, now: T + 100 });
  // The row first and the answer second, in that order deliberately. A claim that took the
  // tenant's item cannot describe it (readDetail carries the literal too) and answers
  // `{ item: null }`, so asserting the answer first would report a missing property and hide
  // what actually happened, which is a lease written on somebody else's row.
  assert.equal(snapshot(db, 'reports', tenantQueued), before, "a claim with no id claimed a tenant's item");
  assert.equal(claimed.item && claimed.item.id, fleetQueued, `a claim with no id did not take the fleet's item: ${json(claimed)}`);
  fleetOnly(claimed, 'claimWork with no id');
  // And once the fleet's queue is empty it hands out NOTHING, rather than reaching further.
  await withdrawWork(db, { id: fleetQueued, actor: 'human', now: T + 110 });
  const empty = await claimWork(db, { actor: 'ai', runner: 'a-runner', leaseSeconds: 1800, now: T + 120 });
  assert.equal(empty.item, null, `a claim reached past the fleet's queue: ${json(empty)}`);
  assert.equal(snapshot(db, 'reports', tenantQueued), before, "a claim wrote a tenant's row");

  // THE ONE STATEMENT IN SECTION 5 THAT CARRIES NO PREDICATE, and this is what it costs.
  // listWork's page is scoped and shows the fleet's item only; its per-state TALLY is not, so
  // a row that breaks invariant 4.3 is counted. The predicate cannot go back on it: it makes
  // the planner take an app_id index that in a fleet-only table matches every row, and the
  // existing rows_read budget in tests/work.test.mjs fails. So the count above is the exact
  // and only cross-tenant effect a broken invariant has anywhere in this Worker, and the
  // invariant is asserted by the two tests below rather than assumed by a comment.
  const listed = await listWork(db, { states: ['approved'], limit: 25, before: null });
  assert.deepEqual(listed.items.map((i) => i.id), [], 'the page showed an item the fleet had withdrawn');
  assert.equal(
    listed.counts.approved, 1,
    'the tally no longer counts the planted violation, so either it gained a predicate or 4.3 is being enforced elsewhere: check the comment on the statement',
  );
  const counts = invariantCounts(db);
  assert.equal(counts["a row in the work queue is always the fleet's"], 1, 'the fixture did not plant the violation it says it plants');
});

// ── The invariants, after a real exercise ─────────────────────────────────────

test("4.3: both invariants hold after every write in the Worker has run, and the counts are zero", async () => {
  const db = sqliteD1();
  // Every write path this Worker has, through the real store functions and nothing planted.
  // If any of them can make an open item or a queued row that is not the fleet's, one of the
  // two counts below stops being zero, and every "no predicate, by invariant 4.3" comment in
  // src/store-work.js and src/store-work-runner.js becomes a hole.
  const body = `A reader's report, ${FLEET_MARK}.`;
  const filed = await insertReport(db, FLEET_SCOPE, {
    id: 'exercise-correction',
    created_at: T,
    site: 'parla-site',
    url: 'https://parla.neorgon.com/x',
    target: { kind: 'concept', id: 'seed1', label: 'seed 1' },
    kind: 'wrong',
    body,
    contact: null,
    ip_hash: null,
    fingerprint: await sha256Hex(fingerprintInput(FLEET_SCOPE.appId, 'parla-site', 'seed1', body)),
  });
  assert.equal(filed.id, 'exercise-correction', json(filed));

  const imported = await upsertOpenItems(db, {
    source: 'queue',
    items: [
      { ref: '#1', text: 'An imported tracker line.', suggested: '', opened_at: T, closed_at: null },
      { ref: '#2', text: 'A second imported line.', suggested: '', opened_at: T, closed_at: T + 1 },
    ],
    now: T,
  });
  assert.equal(imported.created, 2, json(imported));
  // #2 arrived with a closed_at, so it is already marked and the sync's SELECT skips it. Naming
  // #2 and not #1 is what leaves the sync one row to close.
  assert.equal((await syncOpenSource(db, { source: 'queue', refs: ['#2'], now: T + 2 })).closed, 1);

  const direct = await insertDirectItem(db, { text: 'A follow-up filed straight into the queue.', suggested: '', actor: 'ai', now: T + 3 });
  assert.ok(direct.id, json(direct));

  // The whole life of one item: approved, claimed, heartbeat, submitted, accepted, landed.
  // An item automation filed is low trust, so the approval carries an instruction (src/work.js).
  const approved = await approveWork(db, {
    id: direct.id, actor: 'human', mode: 'fix', instruction: 'Correct the gloss against the page itself.', now: T + 4,
  });
  assert.equal(approved.item ? approved.item.work.state : json(approved), 'approved');
  const run = (await claimWork(db, { actor: 'ai', runner: 'a-runner', leaseSeconds: 1800, now: T + 5 })).item.work.run.id;
  assert.ok(run, 'the claim produced no run');
  assert.equal((await heartbeatWork(db, { id: direct.id, actor: 'ai', run, leaseSeconds: 1800, now: T + 6 })).item.work.state, 'claimed');
  assert.equal((await releaseWork(db, { id: direct.id, actor: 'ai', run, note: '', now: T + 7 })).item.work.state, 'approved');
  const second = (await claimWork(db, { actor: 'ai', runner: 'a-runner', leaseSeconds: 1800, now: T + 8 })).item.work.run.id;
  assert.equal((await submitWork(db, {
    id: direct.id, actor: 'ai', run: second, outcome: 'fixed', summary: 'Done.', evidence: null,
    refs: [{ repo: 'balise-site', commit: 'abc1234' }], needsLanding: true, suggestedNote: '', now: T + 9,
  })).item.work.state, 'review');
  assert.equal((await reviewWork(db, { id: direct.id, actor: 'human', decision: 'accept', note: '', now: T + 10 })).item.work.state, 'accepted');
  assert.equal((await landWork(db, {
    id: direct.id, actor: 'ai', run: second, landed: true, refs: [{ repo: 'balise-site', commit: 'abc1234' }], note: '', now: T + 11,
  })).item.work.state, 'done');

  // And the operator's own moves on the corrections feed.
  assert.equal((await applyTransition(db, FLEET_SCOPE, { id: 'exercise-correction', actor: 'human', patch: { status: 'accepted' }, now: T + 12 })).report.status, 'accepted');
  assert.equal((await applyTransition(db, FLEET_SCOPE, { id: 'exercise-correction', actor: 'human', patch: { status: 'fixed', public_note: 'A resolution.' }, now: T + 13 })).report.status, 'fixed');

  assert.ok((await listReports(db, FLEET_SCOPE, { status: null, kind: 'open', before: null, limit: 50 })).reports.length >= 3);
  assert.deepEqual(invariantCounts(db), {
    "an open item is always the fleet's": 0,
    "a row in the work queue is always the fleet's": 0,
  });
  // Every row this exercise wrote is the fleet's, and none is NULL. A NULL here would match no
  // `app_id = ?` page at all, silently, which is the failure the sentinel exists to prevent.
  assert.deepEqual(
    db.sqlite.prepare('SELECT app_id, COUNT(*) AS n FROM reports GROUP BY app_id').all().map((r) => ({ ...r })),
    [{ app_id: 'fleet', n: 4 }],
  );
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reports WHERE app_id IS NULL').get().n, 0);
});

test('4.3: the invariant counts are a detector, and each one can be made to fail', () => {
  // A query that returns zero because it can never return anything else is not a detector, and
  // the two counts above are the only thing standing behind every unpredicated statement in
  // the work queue. So each is shown failing on the row it exists to find.
  for (const [name, over] of [
    ["an open item is always the fleet's", { kind: 'open', status: 'new' }],
    ["a row in the work queue is always the fleet's", { work_state: 'approved', work_approved_at: 1 }],
  ]) {
    const db = sqliteD1();
    assert.deepEqual(Object.values(invariantCounts(db)), [0, 0], 'an empty database is not clean');
    plantReport(db, TENANT, { id: 'violation', over });
    assert.equal(invariantCounts(db)[name], 1, `${name} did not see its own violation`);
  }
});
