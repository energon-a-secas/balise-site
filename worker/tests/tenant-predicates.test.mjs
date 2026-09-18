// CONTRACTS.md C6, asserted, part three: the eleven tenant predicates that A30 found nobody
// was watching, plus the four A17 found were not there at all. Part one is
// tests/tenant-scope.test.mjs (every read and write that takes a scope or a handle) and part two
// is tests/tenant-invariants.test.mjs (the import path, the work queue, and the two invariants
// of DESIGN.md section 4.3).
//
// THE FILE HAS TWO HALVES NOW AND THEY ARE NOT THE SAME KIND OF TEST. The first eleven cases
// pin a predicate that already existed and needed the reassignment hook to be seen at all. The
// last four (RUNNER_WRITES, at the foot) pin predicates this pass ADDED to heartbeat, release
// and both branches of land, and they need no hook, because those three actions run no scoped
// read for the hook to race. Read that section's own header before adding to either half: which
// half a new case belongs in is decided by whether the write it guards is preceded by a read.
//
// WHY A THIRD FILE RATHER THAN MORE CASES IN THE OTHER TWO. `qa-engineer` neutered all 24
// tenant predicates one at a time, keeping the SQL valid and the bind count identical, and 13
// of the 24 turned a test red. These are the other 11:
//
//   store.js:405        store-open.js:178, 218, 235, 277, 299, 408
//   store-work.js:373, 417, 443, 484
//
// (Line numbers as of 2026-09-18, before the A28 comment correction moved store-open.js's
// board statements down; each test below names its statement, which does not move.) They all
// survived for one of two reasons, and neither is a reason the other two files could fix by
// planting another row:
//
//   1. A SCOPED READ RUNS FIRST AND REFUSES THE ROW BEFORE THE WRITE IS REACHED.
//      applyTransition, approveWork, withdrawWork and reviewWork each read the row with a
//      predicate of their own, so a tenant row is already gone by the time the guarded write
//      runs. DESIGN.md 5.1 line 1058 is explicit that this is not a duplicate: "Both, not one,
//      and neither substitutes for the other." Pinning the write half therefore needs the read
//      to succeed and the write to disagree with it, which is exactly the time-of-check to
//      time-of-use gap the comment on store.js's UPDATE says the term closes. THE HOOK IN
//      tests/sqlite-d1.mjs IS THE ONLY WAY TO OPEN THAT GAP, and it is why this file exists.
//   2. THE PREDICATE IS INSIDE A SUBQUERY OR DECIDES A LATER STATEMENT, so it changes a
//      timestamp or a statement count rather than an answer. Nothing in the other two files
//      looks at either.
//
// WHAT THE REASSIGNMENT HOOK MODELS, SAID PLAINLY. Several tests below move a row from the
// fleet to a tenant between the read and the write, with db.beforeStatement / db.beforeBatch.
// Nothing in phase 1 can do that: `reports.app_id` is written once, by the INSERT. So this is
// not a reachable attack and it is not claimed to be one. It is the only way to exercise the
// write predicate SEPARATELY from the read predicate that shadows it, which is what makes
// deleting the write predicate red instead of silent. A29 is the standing reminder of what
// happens when a property is argued instead of measured, and A30 is what happens when it is
// neither.
//
// Each test names the neutering that must make it fail. The two forms are QA's, because they
// keep the SQL valid and the bind count identical, so nothing fails for an unrelated reason:
//
//   `AND app_id = ?`       becomes  `AND ? IS NOT NULL`
//   `AND app_id = 'fleet'` becomes  `AND 1 = 1`

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sqliteD1 } from './sqlite-d1.mjs';
import { FLEET, FLEET_SCOPE } from '../src/scope.js';
import { applyTransition } from '../src/store.js';
import {
  OPEN_KIND, openFingerprintInput, upsertOpenItems, syncOpenSource, boardSummary,
} from '../src/store-open.js';
import { sha256Hex } from '../src/store.js';
import { insertDirectItem, approveWork, withdrawWork, reviewWork } from '../src/store-work.js';
import { heartbeatWork, releaseWork, landWork } from '../src/store-work-runner.js';
import {
  T, FLEET_MARK, TENANT_MARK, TENANT, json, plantReport,
} from './tenant-fixture.mjs';

// ── The two things every test here needs ──────────────────────────────────────

/**
 * A row's stored shape WITHOUT `app_id`, so the reassignment the hook performs is not itself
 * mistaken for the write being tested. Everything else in the row is compared, which is what
 * says "the guarded write landed nothing".
 */
function shapeOf(db, id) {
  const row = db.sqlite.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!row) return null;
  const { app_id: _tenancy, ...rest } = row;
  return json({ ...rest });
}

/** Hand this row to a tenant once, just before the next single statement matching `match`. */
function reassignBefore(db, match, id) {
  db.beforeStatement(match, () => {
    db.sqlite.prepare('UPDATE reports SET app_id = ? WHERE id = ?').run(TENANT, id);
  });
}

/** The same, for the three actions whose write is the first statement of a batch. */
function reassignBeforeBatch(db, id) {
  db.beforeBatch(() => {
    db.sqlite.prepare('UPDATE reports SET app_id = ? WHERE id = ?').run(TENANT, id);
  });
}

/** Did any statement matching `match` reach SQL at all? tests/sqlite-d1.mjs records every one. */
const ran = (db, match) => db.log.some((sql) => match.test(sql));

// ── store.js:405, applyTransition's guarded UPDATE ────────────────────────────

test('C6: applyTransition\'s WRITE refuses a row that stopped being the fleet\'s after the read', async () => {
  // NEUTER `AND app_id = ?` on store.js's UPDATE to `AND ? IS NOT NULL` and this test fails.
  //
  // A30 names this one because DESIGN.md 5.1 line 1058 does: the read half has six failing
  // tests and the write half had none, on the one statement in the file whose own comment
  // (store.js:296) calls the term a time-of-check to time-of-use guard.
  const move = { id: 'transitioning', actor: 'human', patch: { status: 'accepted' }, now: T + 100 };

  // The control. The same row, the same call, no reassignment: it must succeed, or the case
  // below is a refusal by some rule and not by the tenant term.
  const clean = sqliteD1();
  plantReport(clean, FLEET, { id: move.id, over: { kind: 'wrong', status: 'new' } });
  const allowed = await applyTransition(clean, FLEET_SCOPE, move);
  assert.equal(allowed.report && allowed.report.status, 'accepted', `the control was refused: ${json(allowed)}`);

  const db = sqliteD1();
  plantReport(db, FLEET, { id: move.id, over: { kind: 'wrong', status: 'new' } });
  reassignBefore(db, /^UPDATE reports SET/, move.id);
  const before = shapeOf(db, move.id);
  const out = await applyTransition(db, FLEET_SCOPE, move);

  assert.equal(shapeOf(db, move.id), before, 'the guarded UPDATE wrote a row that is no longer the fleet\'s');
  assert.equal(out.code, 'BAD_TRANSITION', `the write did not refuse: ${json(out)}`);
  assert.equal(db.sqlite.prepare('SELECT status FROM reports WHERE id = ?').get(move.id).status, 'new');
});

// ── store-open.js:178 and store-work.js:373, the two inner MAX subqueries ─────
//
// Both INSERTs take their `created_at` as one past the newest OPEN row, inside the statement,
// and the subquery that finds that row is a read over `reports`. So the predicate decides a
// TIMESTAMP rather than an answer, and no assertion anywhere looked at it. A tenant open row
// far in the future is the detector: without the term the fleet's next open item is stamped
// past it, which is invisible until the desk's keyset paging starts skipping rows.
//
// Both tests plant a tenant row with `kind = 'open'`, which invariant 4.3 forbids. That is
// deliberate and it is the same argument tenant-invariants.test.mjs makes: the predicate is
// what MAKES the invariant true, so a term can only be tested against the row it excludes.

const FUTURE = T + 1_000_000;

function withAFutureTenantOpenRow() {
  const db = sqliteD1();
  plantReport(db, TENANT, {
    id: 'tenant-open-future',
    over: { kind: OPEN_KIND, status: 'new', created_at: FUTURE, fingerprint: 'fp-tenant-future' },
  });
  plantReport(db, FLEET, {
    id: 'fleet-open-newest',
    over: { kind: OPEN_KIND, status: 'new', created_at: T + 5, fingerprint: 'fp-fleet-newest' },
  });
  return db;
}

const createdAt = (db, id) => db.sqlite.prepare('SELECT created_at FROM reports WHERE id = ?').get(id).created_at;

test('C6: an import stamps an open item past the newest FLEET open row and no further', async () => {
  // NEUTER the subquery's `AND app_id = 'fleet'` in store-open.js's INSERT to `AND 1 = 1` and
  // this test fails: the stamp becomes FUTURE + 1 instead of T + 6.
  const db = withAFutureTenantOpenRow();
  const out = await upsertOpenItems(db, {
    source: 'queue',
    items: [{ ref: '#stamped', text: `An imported line, ${FLEET_MARK}.`, suggested: '', opened_at: T, closed_at: null }],
    now: T,
  });
  assert.equal(out.created, 1, json(out));
  const row = db.sqlite.prepare("SELECT id, created_at FROM reports WHERE source_ref = '#stamped'").get();
  assert.equal(
    row.created_at, T + 6,
    `the import stamped ${row.created_at}: one past the tenant's ${FUTURE} rather than one past the fleet's ${T + 5}`,
  );
});

test('C6: a direct filing stamps past the newest FLEET open row and no further', async () => {
  // NEUTER the subquery's `AND app_id = 'fleet'` in store-work.js's INSERT to `AND 1 = 1` and
  // this test fails the same way.
  const db = withAFutureTenantOpenRow();
  const filed = await insertDirectItem(db, { text: `A follow-up, ${FLEET_MARK}.`, suggested: '', actor: 'human', now: T });
  assert.ok(filed.id, json(filed));
  assert.equal(
    createdAt(db, filed.id), T + 6,
    `the filing stamped ${createdAt(db, filed.id)} rather than one past the fleet's ${T + 5}`,
  );
});

// ── store-open.js:218 and :235, the two import UPDATEs keyed by fingerprint ───
//
// Both are aimed by a fingerprint that came out of the scoped dedupe SELECT above them, and
// `reports_fp` is UNIQUE on `fingerprint` alone, so no tenant row can hold a fingerprint that
// read returned. A19 is the standing statement that the collision case is unreachable and the
// defence stays anyway. That is exactly why these two survived: the case they guard cannot be
// planted, so the gap has to be opened between the read and the write.

async function importFixture(overRow) {
  const ref = '#tracked';
  const fingerprint = await sha256Hex(openFingerprintInput('queue', ref));
  const db = sqliteD1();
  plantReport(db, FLEET, {
    id: 'fleet-tracked',
    over: {
      kind: OPEN_KIND, status: 'new', fingerprint, source: 'queue', source_ref: ref, ...overRow,
    },
  });
  return { db, ref, id: 'fleet-tracked' };
}

const closedMark = (db, id) => db.sqlite.prepare('SELECT source_closed_at FROM reports WHERE id = ?').get(id).source_closed_at;

test("C6: the import's CLOSE marks a fleet row and refuses one handed to a tenant mid-flight", async () => {
  // NEUTER `WHERE app_id = 'fleet'` on the close UPDATE to `WHERE 1 = 1` and this test fails.
  const match = /UPDATE reports SET source_closed_at = \?/;
  const item = { ref: '#tracked', text: `A line now closed, ${FLEET_MARK}.`, suggested: '', opened_at: T, closed_at: T + 5 };

  const control = await importFixture({ source_closed_at: null });
  await upsertOpenItems(control.db, { source: 'queue', items: [item], now: T });
  assert.equal(closedMark(control.db, control.id), T + 5, 'the control did not mark the fleet row, so nothing below is a refusal');

  const { db, id } = await importFixture({ source_closed_at: null });
  reassignBefore(db, match, id);
  const out = await upsertOpenItems(db, { source: 'queue', items: [item], now: T });
  assert.equal(closedMark(db, id), null, "the close marked a row that is no longer the fleet's");
  // And the COUNT says so too. This asserted `closed: 1` until 2026-09-18, because the branch
  // incremented unconditionally and reported a close the database had declined; the close now
  // counts `changes` like the reopen below, so a write the tenant literal refused is reported as
  // `unchanged`. A route answering `closed: 1` over a row it did not touch was the gap.
  assert.deepEqual({ closed: out.closed, unchanged: out.unchanged }, { closed: 0, unchanged: 1 }, json(out));
  assert.ok(ran(db, match), 'the close UPDATE never ran, so this case proves nothing about its predicate');
});

test("C6: the import's REOPEN clears a fleet mark and refuses one handed to a tenant mid-flight", async () => {
  // NEUTER `WHERE app_id = 'fleet'` on the reopen UPDATE to `WHERE 1 = 1` and this test fails.
  const match = /UPDATE reports SET source_closed_at = NULL/;
  const item = { ref: '#tracked', text: `A line open again, ${FLEET_MARK}.`, suggested: '', opened_at: T, closed_at: null };

  const control = await importFixture({ source_closed_at: T - 5 });
  const allowed = await upsertOpenItems(control.db, { source: 'queue', items: [item], now: T });
  assert.equal(allowed.reopened, 1, `the control did not reopen the fleet row: ${json(allowed)}`);
  assert.equal(closedMark(control.db, control.id), null);

  const { db, id } = await importFixture({ source_closed_at: T - 5 });
  reassignBefore(db, match, id);
  const out = await upsertOpenItems(db, { source: 'queue', items: [item], now: T });
  assert.equal(closedMark(db, id), T - 5, "the reopen cleared the mark on a row that is no longer the fleet's");
  assert.deepEqual({ reopened: out.reopened, unchanged: out.unchanged }, { reopened: 0, unchanged: 1 }, json(out));
});

// ── store-open.js:277 and :299, the sync's read and its chunked write ─────────

test('C6: the sync decides what to close from FLEET rows only, and attempts no write without one', async () => {
  // NEUTER the SELECT's `WHERE app_id = 'fleet'` to `WHERE 1 = 1` and this test fails.
  //
  // Why the statement count and not the answer: the UPDATE below carries its own literal, so a
  // tenant fingerprint that got into the close list closes nothing and `{ closed: 0 }` comes
  // back either way. What changes is that a write is ATTEMPTED over a row set this read must
  // not be able to see. It is the widest read in the file and it decides a write that takes
  // fifty fingerprints at a time, so "it read nothing of theirs" is the property, not "it
  // wrote nothing of theirs".
  const match = /UPDATE reports SET source_closed_at = \?[\s\S]*fingerprint IN/;
  const tenantUnlisted = {
    kind: OPEN_KIND,
    status: 'new',
    fingerprint: 'fp-tenant-unlisted',
    source: 'queue',
    source_ref: '#tenant-unlisted',
    source_closed_at: null,
  };

  const db = sqliteD1();
  plantReport(db, TENANT, { id: 'tenant-unlisted', over: tenantUnlisted });
  const out = await syncOpenSource(db, { source: 'queue', refs: ['#listed'], now: T + 10 });
  assert.deepEqual(out, { closed: 0 }, json(out));
  assert.ok(!ran(db, match), "the sync built a close list out of a tenant's rows and ran the UPDATE over it");
  assert.equal(closedMark(db, 'tenant-unlisted'), null, "the sync closed a tenant's row");

  // The control: one unlisted FLEET row in the same table and the same call does run the write
  // and does close it, so the absence asserted above is a scoped read and not a dead route.
  plantReport(db, FLEET, {
    id: 'fleet-unlisted',
    over: { ...tenantUnlisted, fingerprint: 'fp-fleet-unlisted', source_ref: '#fleet-unlisted' },
  });
  const swept = await syncOpenSource(db, { source: 'queue', refs: ['#listed'], now: T + 11 });
  assert.deepEqual(swept, { closed: 1 }, json(swept));
  assert.ok(ran(db, match), 'the sync closed a row without running its UPDATE, so the match above is wrong');
  assert.equal(closedMark(db, 'tenant-unlisted'), null, "the sync's write reached a tenant's row");
});

test("C6: the sync's chunked UPDATE closes nothing once a listed row stops being the fleet's", async () => {
  // NEUTER the chunked UPDATE's `WHERE app_id = 'fleet'` to `WHERE 1 = 1` and this test fails.
  // The fingerprints it is given all came from the scoped read above it, so the only way to
  // aim it at a tenant row is to reassign the row it is already about to close.
  const db = sqliteD1();
  plantReport(db, FLEET, {
    id: 'fleet-unlisted',
    over: {
      kind: OPEN_KIND, status: 'new', fingerprint: 'fp-fleet-unlisted',
      source: 'queue', source_ref: '#fleet-unlisted', source_closed_at: null,
    },
  });
  reassignBefore(db, /UPDATE reports SET source_closed_at = \?[\s\S]*fingerprint IN/, 'fleet-unlisted');
  const swept = await syncOpenSource(db, { source: 'queue', refs: ['#listed'], now: T + 10 });
  assert.deepEqual(swept, { closed: 0 }, `the chunked UPDATE closed a row that is no longer the fleet's: ${json(swept)}`);
  assert.equal(closedMark(db, 'fleet-unlisted'), null);
});

// ── store-open.js's boardSummary, the `latest` query ─────────────────────────

test("C6.5: the board summary's newest resolution is the fleet's, even when a tenant's is newer", async () => {
  // NEUTER the latest query's `AND app_id = 'fleet'` to `AND 1 = 1` and this test fails.
  //
  // Why the existing fixture in tenant-scope.test.mjs does not catch it: both copies carry the
  // same fixed_at, so `ORDER BY fixed_at DESC LIMIT 1` returns the fleet's row on a tie
  // whatever the predicate says. The tenant's resolution here is strictly newer, which is the
  // only arrangement that discriminates.
  const db = sqliteD1();
  plantReport(db, FLEET, {
    id: 'fleet-resolved',
    over: { kind: OPEN_KIND, status: 'fixed', public: 1, fixed_at: T + 10, fingerprint: 'fp-fleet-resolved' },
  });
  plantReport(db, TENANT, {
    id: 'tenant-resolved-newer',
    over: { kind: OPEN_KIND, status: 'fixed', public: 1, fixed_at: T + 9_999, fingerprint: 'fp-tenant-resolved' },
  });
  const summary = await boardSummary(db, { now: T + 10_000 });
  assert.ok(summary.latest, `the summary has no newest resolution, so this case proves nothing: ${json(summary)}`);
  assert.ok(summary.latest.text.includes(FLEET_MARK), `the summary lost the fleet's own sentence: ${json(summary)}`);
  assert.ok(!summary.latest.text.includes(TENANT_MARK), `the summary published a tenant's sentence: ${json(summary)}`);
  assert.equal(summary.resolved, 1, `the summary counted a tenant's resolution: ${json(summary)}`);
});

// ── store-work.js:417, :443 and :484, the three operator writes ───────────────
//
// Same shape as applyTransition and the same reason they survived: readRow carries the literal
// and refuses a tenant row before the write is reached, so the write's own term is only
// reachable once the two disagree. approveWork is the one A30 names, because DESIGN.md 4.3 and
// A16 both call it an enforcement point for invariant 2 and `delivery-lead` confirmed by hand
// that removing its term left 226 of 226 green.

const WORK_WRITES = [
  {
    name: 'approveWork',
    predicate: "store-work.js's approve UPDATE",
    over: { kind: OPEN_KIND, filed_by: 'human', status: 'new' },
    arm: (db, id) => reassignBefore(db, /UPDATE reports SET work_state = 'approved'/, id),
    call: (db, id) => approveWork(db, { id, actor: 'human', mode: 'fix', instruction: '', now: T + 100 }),
    landed: (row) => row.work_state === 'approved',
  },
  {
    name: 'withdrawWork',
    predicate: "store-work.js's withdraw UPDATE, the first statement of its batch",
    over: { work_state: 'approved', work_approved_at: T },
    arm: (db, id) => reassignBeforeBatch(db, id),
    call: (db, id) => withdrawWork(db, { id, actor: 'human', now: T + 100 }),
    landed: (row) => row.work_state === null,
  },
  {
    name: 'reviewWork',
    predicate: "store-work.js's review UPDATE, the first statement of its batch",
    over: { work_state: 'review', work_run: 'a-run' },
    runId: 'a-run',
    arm: (db, id) => reassignBeforeBatch(db, id),
    call: (db, id) => reviewWork(db, { id, actor: 'human', decision: 'accept', note: '', now: T + 100 }),
    landed: (row) => row.work_state !== 'review',
  },
];

// One test per entry rather than one loop inside one test, so a neutered term is named by the
// test that went red rather than only by an assertion message. Eleven predicates, eleven tests,
// and the same rule applies to the four RUNNER_WRITES cases added below.
for (const entry of WORK_WRITES) {
  test(`C6: ${entry.name} refuses an item that stopped being the fleet's after readRow saw it`, async () => {
    // NEUTER `AND app_id = 'fleet'` on ${entry.predicate} to `AND 1 = 1` and this test fails.
    const id = 'queued-item';
    const plant = (db) => plantReport(db, FLEET, { id, runId: entry.runId, over: entry.over, run: { needs_landing: 0, review: null } });

    const control = sqliteD1();
    plant(control);
    const allowed = await entry.call(control, id);
    assert.equal(allowed.code, undefined, `the control was refused, so the case below proves nothing: ${json(allowed)}`);
    assert.ok(
      entry.landed(control.sqlite.prepare('SELECT * FROM reports WHERE id = ?').get(id)),
      'the control did not write the row it is supposed to write',
    );

    const db = sqliteD1();
    plant(db);
    entry.arm(db, id);
    const before = shapeOf(db, id);
    const out = await entry.call(db, id);
    assert.equal(shapeOf(db, id), before, `wrote a row that is no longer the fleet's: check the predicate on ${entry.predicate}`);
    assert.ok(out.code !== undefined, `answered as though the write had landed: ${json(out)}`);
  });
}

// ── store-work-runner.js, the four UNREAD writes (A17) ────────────────────────
//
// A DIFFERENT SHAPE OF TEST, AND THE DIFFERENCE IS THE FINDING. Every case above needs the
// reassignment hook because a scoped read runs first and would refuse the row before the write
// is reached; the hook exists to open the gap between the two. heartbeat, release and land have
// NO such read. They take an `id` and a `run` from the caller and go straight to a `db.batch`,
// and `explain()` is only consulted once the write has already declined. So the tenant row is
// simply planted as a tenant row: no hook, no gap to open, because the predicate on the write is
// the only thing there is. That is what A17 found and what DESIGN.md 5.4's "none, inherited"
// classification of these three got wrong.
//
// The planted rows carry `work_state` outside the fleet, which invariant 4.3 forbids. Same
// argument as the two MAX subqueries above: a term can only be tested against the row it
// excludes, and the whole point of adding these four literals is to stop depending on an
// invariant that a COUNT can only report AFTER it has been broken.
//
// submit is deliberately absent. It is the one runner action that calls readRow() first, so its
// write is covered the way the four cases above are covered, and giving it a literal too would
// make the four tests below pass for a reason that has nothing to do with them.

const RUNNER_WRITES = [
  {
    name: 'heartbeatWork',
    predicate: "store-work-runner.js's heartbeat UPDATE, the first statement of its batch",
    over: { work_state: 'claimed', work_run: 'a-run', work_lease_until: T + 60_000 },
    call: (db, id) => heartbeatWork(db, { id, actor: 'ai', run: 'a-run', leaseSeconds: 1800, now: T + 100 }),
    landed: (row) => row.work_lease_until !== T + 60_000,
  },
  {
    name: 'releaseWork',
    predicate: "store-work-runner.js's release UPDATE, the first statement of its batch",
    over: { work_state: 'claimed', work_run: 'a-run', work_lease_until: T + 60_000 },
    call: (db, id) => releaseWork(db, { id, actor: 'ai', run: 'a-run', note: '', now: T + 100 }),
    landed: (row) => row.work_state === 'approved',
  },
  {
    name: 'landWork, the land branch',
    predicate: "store-work-runner.js's land UPDATE, the first statement of its batch",
    over: { work_state: 'accepted', work_run: 'a-run' },
    run: { needs_landing: 1, review: 'accepted', reviewed_at: T + 10, ended_at: T + 5, end_reason: 'submitted' },
    call: (db, id) => landWork(db, { id, actor: 'ai', run: 'a-run', landed: true, refs: ['abc1234'], note: '', now: T + 100 }),
    landed: (row) => row.work_state === 'done',
  },
  {
    // BOTH BRANCHES, because the branch is chosen by a boolean the caller sends. A predicate on
    // the arm that finishes an item and none on the arm that sends it back would be a guard a
    // caller can step around by passing `landed: false`.
    name: 'landWork, the unland branch',
    predicate: "store-work-runner.js's unland UPDATE, the first statement of its batch",
    over: { work_state: 'accepted', work_run: 'a-run' },
    run: { needs_landing: 1, review: 'accepted', reviewed_at: T + 10, ended_at: T + 5, end_reason: 'submitted' },
    call: (db, id) => landWork(db, { id, actor: 'ai', run: 'a-run', landed: false, refs: [], note: 'The push failed.', now: T + 100 }),
    landed: (row) => row.work_state === 'review',
  },
];

for (const entry of RUNNER_WRITES) {
  test(`C6 and A17: ${entry.name} refuses a queued row that is not the fleet's, with no read to refuse it first`, async () => {
    // NEUTER `AND app_id = 'fleet'` on ${entry.predicate} to `AND 1 = 1` and this test fails.
    const id = 'held-item';
    const plant = (db, appId) => plantReport(db, appId, { id, runId: 'a-run', over: entry.over, run: entry.run || {} });

    // The control is the SAME call on the SAME row shape in the fleet's tenancy. Without it, a
    // rule that refuses every one of these calls would leave the four tests below green while
    // proving nothing, which is the failure mode A34 named.
    const control = sqliteD1();
    plant(control, FLEET);
    const allowed = await entry.call(control, id);
    assert.equal(allowed.code, undefined, `the control was refused, so the case below proves nothing: ${json(allowed)}`);
    assert.ok(
      entry.landed(control.sqlite.prepare('SELECT * FROM reports WHERE id = ?').get(id)),
      'the control did not write the row it is supposed to write',
    );

    const db = sqliteD1();
    plant(db, TENANT);
    const before = shapeOf(db, id);
    const out = await entry.call(db, id);
    assert.equal(shapeOf(db, id), before, `wrote a tenant's row: check the predicate on ${entry.predicate}`);
    // NOT_FOUND specifically, and it is worth naming: the write declines, `explain()` calls the
    // fleet-scoped readRow(), that finds nothing, and the caller is told the honest thing rather
    // than being told about a row they were never entitled to.
    assert.equal(out.code, 'NOT_FOUND', `answered as though the write had landed, or named a row it should not: ${json(out)}`);
  });
}
