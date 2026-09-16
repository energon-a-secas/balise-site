// The work queue's races, over node:sqlite (tests/sqlite-d1.mjs), because no two HTTP
// requests can be made to land between one request's read and its write.
//
// Each test runs the real store functions and lets another request's writes happen at
// exactly the point a contract item names, then reads the rows. Three items of the fix round
// exist only for these interleavings: C-b (a batch's second write is tied to the stamp its
// first write made), C-c (an edit computes the attempts from the row it writes), and C-e (a
// filing takes its created_at inside its own INSERT). #64 adds two more, an approval and a
// close each landing inside the other, and C-g's swept run is here too, because a clock the
// test sets reaches a lapsed last attempt without waiting for one. The flows are in
// tests/work.test.mjs and tests/work-guards.test.mjs, against a real D1.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sqliteD1 } from './sqlite-d1.mjs';
import { applyTransition, insertReport } from '../src/store.js';
import { insertDirectItem, approveWork, withdrawWork, reviewWork } from '../src/store-work.js';
import { claimWork, heartbeatWork, releaseWork, submitWork, landWork } from '../src/store-work-runner.js';

const T = 1_757_000_000_000;
const REF = { repo: 'balise-site', branch: 'balise/abcd1234-a1', commit: 'abc1234' };
const APPROVE_UPDATE = /^\s*UPDATE reports SET work_state = 'approved', work_mode/;
const CLOSE_UPDATE = /^\s*UPDATE reports SET\s+status\s+=/;

// A row C4 has closed that the work queue still holds, which #64 says must never exist.
const CLOSED_AND_QUEUED = `SELECT id, status, work_state FROM reports
  WHERE status IN ('fixed', 'rejected', 'spam', 'duplicate') AND work_state IN ('approved', 'claimed', 'review', 'accepted')`;

const runRow = (db, id) => ({ ...db.sqlite.prepare('SELECT * FROM work_runs WHERE id = ?').get(id) });
const reportRow = (db, id) => ({ ...db.sqlite.prepare('SELECT * FROM reports WHERE id = ?').get(id) });
const closedAndQueued = (db) => db.sqlite.prepare(CLOSED_AND_QUEUED).all().map((row) => ({ ...row }));

async function fileItem(db, text, { actor = 'human', now = T } = {}) {
  const filed = await insertDirectItem(db, { text, suggested: '', actor, now });
  assert.ok(filed.id, JSON.stringify(filed));
  return filed.id;
}

async function claim(db, id, now) {
  const out = await claimWork(db, { actor: 'ai', runner: 'mac', id, leaseSeconds: 1800, now });
  assert.ok(out.item, JSON.stringify(out));
  return out.item.work.run.id;
}

/** An item approved, claimed and submitted, waiting at review. Returns its run id. */
async function inReview(db, id, { mode = 'investigate', needsLanding = false, now = T + 10 } = {}) {
  assert.equal((await approveWork(db, { id, actor: 'human', mode, instruction: '', now })).code, undefined);
  const run = await claim(db, id, now + 1);
  const out = await submitWork(db, {
    id,
    actor: 'ai',
    run,
    outcome: mode === 'investigate' ? 'investigated' : 'fixed',
    summary: 'Done.',
    evidence: '',
    refs: needsLanding ? [REF] : [],
    needsLanding,
    suggestedNote: '',
    now: now + 2,
  });
  assert.equal(out.item && out.item.work.state, 'review', JSON.stringify(out));
  return run;
}

test('C-b: a return that loses to a withdraw and a fresh approval writes nothing on the run it read', async () => {
  const db = sqliteD1();
  const id = await fileItem(db, 'An item whose result is returned too late.');
  const run = await inReview(db, id);
  db.beforeBatch(async () => {
    assert.equal((await withdrawWork(db, { id, actor: 'human', now: T + 100 })).item.work, null);
    assert.equal((await approveWork(db, { id, actor: 'human', mode: 'investigate', instruction: '', now: T + 101 })).item.work.state, 'approved');
  });
  const out = await reviewWork(db, { id, actor: 'human', decision: 'return', note: 'Look at the header as well.', now: T + 102 });
  assert.equal(out.code, 'BAD_TRANSITION');
  const after = runRow(db, run);
  assert.equal(after.review, null, 'a refused return still wrote its verdict on the run');
  assert.equal(after.review_note, null);
});

test('C-b: a landing writes its run only beside the move it made: accepted, needing a landing, at its own stamp', async () => {
  const db = sqliteD1();
  const land = (id, run, now) => landWork(db, { id, actor: 'ai', run, landed: true, refs: [], note: '', now });

  // Reachable: an investigation accepted straight to done, and a landing in the same millisecond.
  const done = await fileItem(db, 'An investigation that has nothing to land.');
  const doneRun = await inReview(db, done);
  assert.equal((await reviewWork(db, { id: done, actor: 'human', decision: 'accept', note: '', now: T + 80 })).item.work.state, 'done');
  assert.equal((await land(done, doneRun, T + 80)).code, 'BAD_TRANSITION');
  assert.equal(runRow(db, doneRun).landed_at, null, 'a run with nothing to land was marked landed');

  // Set by hand, since no action produces them today: a done row stamped by another request,
  // and a done row whose run was never accepted. Each term has to hold on its own.
  for (const [name, review, stamp] of [['another stamp', 'accepted', T + 70], ['a run that was not accepted', 'returned', T + 90]]) {
    const id = await fileItem(db, `A fix that is done by ${name}.`);
    const run = await inReview(db, id, { mode: 'fix', needsLanding: true });
    db.sqlite.prepare('UPDATE work_runs SET review = ? WHERE id = ?').run(review, run);
    db.sqlite.prepare("UPDATE reports SET work_state = 'done', work_updated_at = ? WHERE id = ?").run(stamp, id);
    assert.equal((await land(id, run, T + 90)).code, 'BAD_TRANSITION', name);
    assert.equal(runRow(db, run).landed_at, null, `a landing wrote its run beside ${name}`);
  }

  // And the landing that did make the move writes both halves.
  const fix = await fileItem(db, 'A fix that lands the ordinary way.');
  const fixRun = await inReview(db, fix, { mode: 'fix', needsLanding: true });
  assert.equal((await reviewWork(db, { id: fix, actor: 'human', decision: 'accept', note: '', now: T + 95 })).item.work.state, 'accepted');
  assert.equal((await land(fix, fixRun, T + 96)).item.work.state, 'done');
  assert.equal(runRow(db, fixRun).landed_at, T + 96);
});

test('C-c: an edit that lands after a claim and a release keeps the attempt that claim spent', async () => {
  const db = sqliteD1();
  const id = await fileItem(db, 'An item edited while a runner takes and returns it.');
  await approveWork(db, { id, actor: 'human', mode: 'investigate', instruction: '', now: T + 1 });
  db.beforeStatement(APPROVE_UPDATE, async () => {
    const run = await claim(db, id, T + 2);
    assert.equal((await releaseWork(db, { id, actor: 'ai', run, note: '', now: T + 3 })).item.work.state, 'approved');
  });
  const edit = await approveWork(db, { id, actor: 'human', mode: 'fix', instruction: 'Fix it rather than report it.', now: T + 4 });
  assert.equal(edit.item.work.mode, 'fix');
  assert.equal(edit.item.work.attempts, 1, 'the edit wrote back the count it read and erased a claim');
  assert.equal(edit.item.work.approved_at, T + 1, 'the edit cost the item its place in the queue');
});

test('C-c: an edit that lands after a withdraw and a fresh approval keeps the fresh count and the fresh place', async () => {
  const db = sqliteD1();
  const id = await fileItem(db, 'An item edited while the operator starts it over.');
  await approveWork(db, { id, actor: 'human', mode: 'investigate', instruction: '', now: T + 1 });
  const run = await claim(db, id, T + 2);
  await releaseWork(db, { id, actor: 'ai', run, note: '', now: T + 3 });
  db.beforeStatement(APPROVE_UPDATE, async () => {
    await withdrawWork(db, { id, actor: 'human', now: T + 5 });
    assert.equal((await approveWork(db, { id, actor: 'human', mode: 'investigate', instruction: '', now: T + 6 })).item.work.attempts, 0);
  });
  const edit = await approveWork(db, { id, actor: 'human', mode: 'fix', instruction: 'Fix it rather than report it.', now: T + 7 });
  assert.equal(edit.item.work.attempts, 0, 'the edit restored attempts a fresh approval had reset');
  assert.equal(edit.item.work.approved_at, T + 6, 'the edit restored a place a fresh approval had given up');
});

test('C-e: a filing is one statement, so two in one millisecond cannot take the same created_at', async () => {
  const db = sqliteD1();
  const before = db.log.length;
  await fileItem(db, 'The first item, filed on an empty feed.');
  assert.equal(db.log.length - before, 1, 'filing an item took more than one statement');

  db.beforeStatement(/^\s*INSERT INTO reports/, async () => {
    await fileItem(db, 'The second item, filed inside the third one.', { actor: 'ai' });
  });
  await fileItem(db, 'The third item, racing the second.');
  const times = db.sqlite.prepare("SELECT created_at FROM reports WHERE kind = 'open' ORDER BY created_at").all().map((r) => r.created_at);
  assert.deepEqual(times.map((t) => t - T), [0, 1, 2], 'two filings in one millisecond share a created_at');
});

test('C-g: a run the sweep ended hears that its last attempt ran out, and is not sent to claim', async () => {
  const db = sqliteD1();
  const id = await fileItem(db, 'An item whose last attempt lapses with nobody holding it.');
  await approveWork(db, { id, actor: 'human', mode: 'fix', instruction: '', now: T + 1 });
  for (let n = 0; n < 2; n += 1) {
    const spent = await claim(db, id, T + 10 + n * 10);
    await releaseWork(db, { id, actor: 'ai', run: spent, note: '', now: T + 15 + n * 10 });
  }
  const run = (await claimWork(db, { actor: 'ai', runner: 'mac', id, leaseSeconds: 5, now: T + 100 })).item.work.run.id;

  // Any later claim runs the sweep: here another runner's, of another item.
  const other = await fileItem(db, 'An unrelated item another runner takes.');
  await approveWork(db, { id: other, actor: 'human', mode: 'fix', instruction: '', now: T + 200 });
  assert.equal((await claimWork(db, { actor: 'ai', runner: 'second', leaseSeconds: 1800, now: T + 10_000 })).item.id, other);
  const swept = reportRow(db, id);
  const sweptRun = runRow(db, run);
  assert.deepEqual([swept.work_state, swept.work_run, sweptRun.end_reason], ['approved', run, 'expired']);

  const at = T + 10_001;
  const late = {
    heartbeat: () => heartbeatWork(db, { id, actor: 'ai', run, leaseSeconds: 1800, now: at }),
    submit: () => submitWork(db, { id, actor: 'ai', run, outcome: 'fixed', summary: 'Late.', evidence: '', refs: [REF], needsLanding: true, suggestedNote: '', now: at }),
    release: () => releaseWork(db, { id, actor: 'ai', run, note: 'Giving it back.', now: at }),
  };
  for (const [action, send] of Object.entries(late)) {
    const out = await send();
    assert.equal(out.code, 'BAD_TRANSITION', `${action}: ${JSON.stringify(out)}`);
    assert.equal(out.message, 'This run\'s lease ran out on the item\'s last attempt, so the item went back to the operator.', action);
    assert.doesNotMatch(out.hint, /claim/i, `${action} sent a swept run to claim`);
  }
  assert.deepEqual(reportRow(db, id), swept, 'a refused call from the swept run moved the item');
  assert.deepEqual(runRow(db, run), sweptRun, 'a refused call from the swept run wrote its run');

  // Once the operator withdraws it and approves it again, the count starts over and the item
  // is claimable, so the swept run hears the state, as any run whose item was restarted does.
  assert.equal((await withdrawWork(db, { id, actor: 'human', now: T + 11_000 })).item.work, null);
  assert.equal((await approveWork(db, { id, actor: 'human', mode: 'fix', instruction: '', now: T + 11_001 })).item.work.attempts, 0);
  assert.equal(reportRow(db, id).work_run, run, 'the restart is only this case while work_run still names the swept run');
  const restarted = await heartbeatWork(db, { id, actor: 'ai', run, leaseSeconds: 1800, now: T + 11_002 });
  assert.equal(restarted.message, 'A work item at "approved" cannot take "heartbeat".', JSON.stringify(restarted));
  assert.ok((await claimWork(db, { actor: 'ai', runner: 'mac', id, leaseSeconds: 1800, now: T + 11_003 })).item, 'the restarted item could not be claimed');

  // What it does not change: a run that released its own item hears the state, and a run
  // another run took over hears that it lost the lease.
  const given = await fileItem(db, 'An item its run gives back.');
  await approveWork(db, { id: given, actor: 'human', mode: 'fix', instruction: '', now: T + 20_000 });
  const giver = await claim(db, given, T + 20_001);
  await releaseWork(db, { id: given, actor: 'ai', run: giver, note: '', now: T + 20_002 });
  const stated = await heartbeatWork(db, { id: given, actor: 'ai', run: giver, leaseSeconds: 1800, now: T + 20_003 });
  assert.equal(stated.message, 'A work item at "approved" cannot take "heartbeat".');

  const taken = await fileItem(db, 'An item another run takes over.');
  await approveWork(db, { id: taken, actor: 'human', mode: 'fix', instruction: '', now: T + 30_000 });
  const first = (await claimWork(db, { actor: 'ai', runner: 'mac', id: taken, leaseSeconds: 5, now: T + 30_001 })).item.work.run.id;
  await claim(db, taken, T + 40_000);
  const lost = await heartbeatWork(db, { id: taken, actor: 'ai', run: first, leaseSeconds: 1800, now: T + 40_001 });
  assert.equal(lost.message, 'This run no longer holds that item.');
});

async function fileCorrection(db, id) {
  const out = await insertReport(db, {
    id, created_at: T, site: 'vitrina', url: 'https://vitrina.neorgon.com/x', target: null, kind: 'wrong',
    body: `A reader's report, ${id}.`, contact: null, ip_hash: null, fingerprint: `fp-${id}`,
  });
  assert.equal(out.id, id, JSON.stringify(out));
  return id;
}

test('#64: an approval landing between a close\'s read and its write leaves the item open and queued, for either credential', async () => {
  const db = sqliteD1();
  const open = await fileItem(db, 'An item resolved in one tab while another hands it over.');
  const correction = await fileCorrection(db, 'race-j');
  for (const [id, actor, patch, approval] of [
    [open, 'human', { status: 'fixed', public_note: 'Resolved by hand.' }, { mode: 'ship', instruction: '' }],
    [correction, 'ai', { status: 'spam' }, { mode: 'fix', instruction: 'Correct the gloss against the page itself.' }],
  ]) {
    db.beforeStatement(CLOSE_UPDATE, async () => {
      assert.equal((await approveWork(db, { id, actor: 'human', ...approval, now: T + 1 })).item.work.state, 'approved');
    });
    const out = await applyTransition(db, { id, actor, patch, now: T + 2 });
    assert.equal(out.code, 'BAD_TRANSITION', `${patch.status}: ${JSON.stringify(out)}`);
    const row = reportRow(db, id);
    assert.deepEqual([row.status, row.work_state, row.decided_at], ['new', 'approved', null], `${patch.status} closed an item the queue had taken`);
  }
  assert.deepEqual(closedAndQueued(db), []);
  // So the claims such a row would have fed take items that are still open.
  for (const runner of ['mac', 'second']) {
    const taken = await claimWork(db, { actor: 'ai', runner, leaseSeconds: 1800, now: T + 3 });
    assert.equal(taken.item.status, 'new', JSON.stringify(taken));
  }
});

test('#64: a close landing between an approval\'s read and its write keeps the item out of the queue', async () => {
  const db = sqliteD1();
  const id = await fileItem(db, 'An item handed over in one tab while another rejects it.');
  db.beforeStatement(APPROVE_UPDATE, async () => {
    assert.equal((await applyTransition(db, { id, actor: 'human', patch: { status: 'rejected' }, now: T + 1 })).report.status, 'rejected');
  });
  const out = await approveWork(db, { id, actor: 'human', mode: 'ship', instruction: '', now: T + 2 });
  assert.equal(out.code, 'BAD_TRANSITION', JSON.stringify(out));
  const row = reportRow(db, id);
  assert.deepEqual([row.status, row.work_state, row.work_mode, row.work_approved_at], ['rejected', null, null, null]);
  assert.deepEqual(closedAndQueued(db), []);
  assert.equal((await claimWork(db, { actor: 'ai', runner: 'mac', leaseSeconds: 1800, now: T + 3 })).item, null, 'a rejected item was handed to a runner');
});

test('#64: approve refuses an item C4 has closed, says how to go on from each close, and writes nothing', async () => {
  const db = sqliteD1();
  const original = await fileItem(db, 'The item a duplicate repeats.');
  const closes = {
    fixed: { public_note: 'Resolved before anyone handed it over.' },
    rejected: {},
    spam: {},
    duplicate: { duplicate_of: original },
  };
  const ids = {};
  for (const [status, fields] of Object.entries(closes)) {
    const id = await fileItem(db, `An item closed as ${status} before it was handed over.`);
    assert.equal((await applyTransition(db, { id, actor: 'human', patch: { status, ...fields }, now: T + 1 })).report.status, status);
    const before = reportRow(db, id);
    for (const approval of [{ mode: 'ship', instruction: '' }, { mode: 'investigate', instruction: 'Look at it again all the same.' }]) {
      const out = await approveWork(db, { id, actor: 'human', ...approval, now: T + 2 });
      assert.equal(out.code, 'BAD_TRANSITION', `${status}: ${JSON.stringify(out)}`);
      if (status === 'fixed') {
        assert.equal(out.message, 'That item is resolved, so it cannot be handed to an agent.');
        assert.equal(out.hint, 'Fixed is final. File any follow-up work as a new item under Work, and hand that one over.');
      } else {
        assert.equal(out.message, `That item is closed as "${status}", so it cannot be handed to an agent.`);
        assert.equal(out.hint, 'Reopen it first by moving it to accepted, then hand it to an agent.');
      }
    }
    assert.deepEqual(reportRow(db, id), before, `a refused approval wrote the ${status} item`);
    ids[status] = id;
  }

  // Automation still hears first that approving is not its move at all.
  assert.match((await approveWork(db, { id: ids.spam, actor: 'ai', mode: 'fix', instruction: '', now: T + 3 })).message, /Only the operator/);
  // Reopening a finished item from Work is an approval too, so a resolved one is refused there.
  const finished = await fileItem(db, 'An investigation that finishes and is then resolved.');
  await inReview(db, finished, { now: T + 10 });
  assert.equal((await reviewWork(db, { id: finished, actor: 'human', decision: 'accept', note: '', now: T + 20 })).item.work.state, 'done');
  assert.equal((await applyTransition(db, { id: finished, actor: 'human', patch: { status: 'fixed', public_note: 'Finished.' }, now: T + 21 })).report.status, 'fixed');
  const reopened = await approveWork(db, { id: finished, actor: 'human', mode: 'investigate', instruction: '', now: T + 22 });
  assert.equal(reopened.message, 'That item is resolved, so it cannot be handed to an agent.');
  assert.equal(reportRow(db, finished).work_state, 'done');
  // And the way on the hint gives works: reopened to accepted, a rejected item is handed over.
  assert.equal((await applyTransition(db, { id: ids.rejected, actor: 'human', patch: { status: 'accepted', public_note: 'Being looked at again.' }, now: T + 30 })).report.status, 'accepted');
  assert.equal((await approveWork(db, { id: ids.rejected, actor: 'human', mode: 'fix', instruction: '', now: T + 31 })).item.work.state, 'approved');
  assert.deepEqual(closedAndQueued(db), []);
});

test('#64: what stays allowed: a close after a withdraw or once done, publishing as open while claimed, and filing then approving', async () => {
  const db = sqliteD1();
  const withdrawn = await fileItem(db, 'An item withdrawn and then resolved by hand.');
  await approveWork(db, { id: withdrawn, actor: 'human', mode: 'ship', instruction: '', now: T + 1 });
  assert.equal((await withdrawWork(db, { id: withdrawn, actor: 'human', now: T + 2 })).item.work, null);
  assert.equal((await applyTransition(db, { id: withdrawn, actor: 'human', patch: { status: 'fixed', public_note: 'Done by hand.' }, now: T + 3 })).report.status, 'fixed');

  const held = await fileItem(db, 'An item published as open while a runner holds it.');
  await approveWork(db, { id: held, actor: 'human', mode: 'fix', instruction: '', now: T + 4 });
  await claim(db, held, T + 5);
  const published = await applyTransition(db, { id: held, actor: 'human', patch: { status: 'accepted', public_note: 'Work on this has started.' }, now: T + 6 });
  assert.deepEqual([published.report.status, published.report.work && published.report.work.state], ['accepted', 'claimed'], JSON.stringify(published));

  const finished = await fileItem(db, 'An investigation that finishes and is then closed.');
  await inReview(db, finished, { now: T + 10 });
  assert.equal((await reviewWork(db, { id: finished, actor: 'human', decision: 'accept', note: '', now: T + 20 })).item.work.state, 'done');
  assert.equal((await applyTransition(db, { id: finished, actor: 'human', patch: { status: 'rejected' }, now: T + 21 })).report.status, 'rejected');

  // POST /work/items with approve: the item is filed, then approved, in one call.
  const filed = await fileItem(db, 'An item filed and handed over at once.');
  assert.equal((await approveWork(db, { id: filed, actor: 'human', mode: 'investigate', instruction: '', now: T + 30 })).item.work.state, 'approved');
  assert.deepEqual(closedAndQueued(db), []);
});
