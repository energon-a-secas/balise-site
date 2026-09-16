// The work queue under workerd, against a real local D1 (docs/DESIGN-WORK-QUEUE.md). These
// tests run IN ORDER on one database and read as the life of a few items. What only a real
// database can show is here: one item to one run, only the lease holder acting, every guard
// the design names tripping, a lease running out in real time, and the board saying only
// that a published item is moving. The action table itself is in tests/work-rules.test.mjs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  WORKER_DIR, TOKEN, AI_TOKEN, SALT, TURNSTILE_PASS,
  migrate, run, startWorker, stopWorker, requester, report, seedReports, seedOpenItems,
} from './harness.mjs';
import { rowsReadBudget } from '../src/store.js';

const STATE = join(WORKER_DIR, '.wrangler/work-state');
const PORT = 8893;
const call = requester(`http://127.0.0.1:${PORT}`);

const SEEDED = 3;
const OPEN_SEEDED = 12;
const CONTACT = 'reader-contact@example.com';
const ELSEWHERE = 'https://elsewhere.example';
const NOT_A_RUN = '00000000-0000-0000-0000-000000000000';

const as = (token, ip) => (path, body, method) =>
  call(path, { method: method || (body === undefined ? 'GET' : 'POST'), body, token, ip });
const op = as(TOKEN, '192.0.2.60');
const ai = as(AI_TOKEN, '192.0.2.61');

let worker = null;
const claims = {};

before(async () => {
  rmSync(STATE, { recursive: true, force: true });
  await migrate(STATE);
  worker = await startWorker(PORT, {
    BALISE_OPERATOR_TOKEN: TOKEN,
    BALISE_AUTOMATION_TOKEN: AI_TOKEN,
    BALISE_IP_SALT: SALT,
    BALISE_TURNSTILE_SECRET: TURNSTILE_PASS,
  }, STATE);
  await seedReports(call, SEEDED, assert);
  // One correction carries a contact address, so "the runner never sees it" has something
  // real not to see.
  const { res } = await call('/report', { method: 'POST', body: report(99, { contact: CONTACT }), ip: '198.51.100.99' });
  assert.equal(res.status, 200);
  await seedOpenItems(call, OPEN_SEEDED, assert);
}, { timeout: 300_000 });

after(async () => {
  await stopWorker(worker);
});

async function openRow(ref) {
  const { body } = await op('/reports?kind=open&limit=50');
  const row = body.reports.find((r) => r.source_ref === ref);
  assert.ok(row, `seeded item ${ref} is missing`);
  return row;
}

async function correctionWithContact() {
  const { body } = await op('/reports?limit=50');
  const row = body.reports.find((r) => r.contact === CONTACT);
  assert.ok(row, 'the correction with a contact address is missing');
  return row;
}

test('the migrations build the work columns and the runs table', async () => {
  const columns = async (table) => {
    const out = await run(['d1', 'execute', 'balise', '--local', '--persist-to', STATE, '--json',
      '--command', `SELECT name FROM pragma_table_info('${table}')`]);
    return JSON.parse(out.slice(out.indexOf('[')))[0].results.map((r) => r.name);
  };
  const reports = await columns('reports');
  for (const c of ['work_state', 'work_mode', 'work_instruction', 'work_run', 'work_attempts', 'work_lease_until', 'work_approved_at', 'work_updated_at']) {
    assert.ok(reports.includes(c), `reports.${c} is missing after the migrations`);
  }
  const runs = await columns('work_runs');
  for (const c of ['report_id', 'attempt', 'runner', 'lease_until', 'outcome', 'refs', 'needs_landing', 'suggested_note', 'review', 'review_note', 'landed_at']) {
    assert.ok(runs.includes(c), `work_runs.${c} is missing after the migrations`);
  }
});

test('nothing is in the work queue until a person puts it there', async () => {
  const { body } = await op('/reports?kind=open&limit=50');
  assert.ok(body.reports.every((r) => r.work === null), 'an imported item arrived already in the work queue');
  const queue = await op('/work');
  assert.equal(queue.res.status, 200, JSON.stringify(queue.body));
  assert.deepEqual(queue.body.items, []);
  assert.deepEqual(queue.body.counts, { approved: 0, claimed: 0, review: 0, accepted: 0, done: 0 });
  const nothing = await ai('/work/claim', { runner: 'mac' });
  assert.equal(nothing.res.status, 200);
  assert.equal(nothing.body.item, null);
});

test('automation cannot hand work to itself', async () => {
  const row = await openRow('#900');
  const { res, body } = await ai(`/work/${row.id}/approve`, { mode: 'ship' });
  assert.equal(res.status, 409);
  assert.equal(body.code, 'BAD_TRANSITION');
  assert.match(body.message, /Only the operator/);
  assert.equal((await openRow('#900')).work, null, 'the refused approval still moved the item');
});

test('the operator approves an open item; fix is the default, and an edit keeps its place', async () => {
  const row = await openRow('#901');
  const first = await op(`/work/${row.id}/approve`, {});
  assert.equal(first.res.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.item.work.state, 'approved');
  assert.equal(first.body.item.work.mode, 'fix');
  assert.equal(first.body.item.work.attempts, 0);
  assert.equal(first.body.item.trust, 'fleet');

  const edit = await op(`/work/${row.id}/approve`, { mode: 'investigate', instruction: 'Only check whether it is still true.' });
  assert.equal(edit.res.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.item.work.mode, 'investigate');
  assert.equal(edit.body.item.work.approved_at, first.body.item.work.approved_at, 'an edit cost the item its place in the queue');
  assert.equal((await openRow('#901')).work.state, 'approved', 'the desk row does not show the approval');
});

test('a reader\'s report needs the operator\'s instruction, and never ships', async () => {
  const target = await correctionWithContact();
  const bare = await op(`/work/${target.id}/approve`, { mode: 'fix' });
  assert.equal(bare.res.status, 400);
  assert.equal(bare.body.code, 'BAD_FIELD');
  assert.match(bare.body.message, /instruction you wrote/);

  const ship = await op(`/work/${target.id}/approve`, { mode: 'ship', instruction: 'Correct the gloss against the page itself.' });
  assert.equal(ship.res.status, 400);
  assert.match(ship.body.message, /ship mode/);

  const approved = await op(`/work/${target.id}/approve`, { mode: 'fix', instruction: 'Correct the gloss against the page itself.' });
  assert.equal(approved.res.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.item.trust, 'stranger');
});

test('a claim takes the oldest approval, the next runner gets the next, a held item is not handed out twice, and no reader\'s contact reaches a runner', async () => {
  const one = await ai('/work/claim', { runner: 'mac' });
  assert.equal(one.res.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.item.source_ref, '#901');
  assert.equal(one.body.item.work.state, 'claimed');
  assert.equal(one.body.item.work.attempts, 1);
  assert.equal(one.body.item.work.run.mode, 'investigate');
  assert.match(one.body.item.body, /Seeded tracker line/);

  const two = await ai('/work/claim', { runner: 'second' });
  assert.equal(two.res.status, 200, JSON.stringify(two.body));
  assert.equal(two.body.item.kind, 'wrong');
  assert.notEqual(two.body.item.work.run.id, one.body.item.work.run.id);
  assert.equal((await ai('/work/claim', { runner: 'third' })).body.item, null, 'a held item was claimed a second time');

  assert.ok(!JSON.stringify(two.body).includes(CONTACT), 'the claim carried the contact address');
  assert.ok(!('contact' in two.body.item));
  const detail = await ai(`/work/${two.body.item.id}`);
  assert.ok(!JSON.stringify(detail.body).includes(CONTACT), 'the detail carried the contact address');
  assert.match(detail.body.item.work.instruction, /Correct the gloss/);

  claims.open = one.body.item;
  claims.correction = two.body.item;
});

test('a heartbeat from anything but the lease holder is refused', async () => {
  const item = claims.open;
  const wrong = await ai(`/work/${item.id}/heartbeat`, { run: NOT_A_RUN });
  assert.equal(wrong.res.status, 409);
  assert.match(wrong.body.message, /no longer holds/);
  const right = await ai(`/work/${item.id}/heartbeat`, { run: item.work.run.id, lease_seconds: 3600 });
  assert.equal(right.res.status, 200, JSON.stringify(right.body));
  assert.ok(right.body.item.work.lease_until > item.work.lease_until, 'the heartbeat did not extend the lease');
});

test('an investigation cannot claim a fix or a landing, and a clean one reaches review with its sentence redacted', async () => {
  const item = claims.open;
  const path = `/work/${item.id}/submit`;
  const runId = item.work.run.id;

  const asFix = await ai(path, { run: runId, outcome: 'fixed', summary: 'Changed the file.' });
  assert.equal(asFix.res.status, 400);
  assert.match(asFix.body.message, /investigation reports/);
  const landing = await ai(path, { run: runId, outcome: 'investigated', summary: 'Still true.', needs_landing: true, refs: [{ repo: 'balise-site', commit: 'abc1234' }] });
  assert.equal(landing.res.status, 400);
  assert.equal((await ai(path, { run: NOT_A_RUN, outcome: 'investigated', summary: 'Still true.' })).res.status, 409);

  const good = await ai(path, {
    run: runId,
    outcome: 'investigated',
    summary: 'Still true: the checker still exits non-zero on drift.',
    evidence: 'ran the checker, exit 1',
    suggested_note: 'The drift checker is being reworked, and the run at enforce.py:612 shows it.',
  });
  assert.equal(good.res.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.item.work.state, 'review');
  // Equal, not merely free of the path: an assertion that a dropped sentence also passes
  // cannot tell a kept opening from a discarded one. The clause naming the path goes and the
  // clause before it stays whole, which is #81's rule reaching the desk through the runner.
  assert.equal(
    good.body.item.work.run.suggested_note,
    'The drift checker is being reworked.',
    'the drafted sentence was not held to the clauses that clear the floor',
  );

  const again = await ai(path, { run: runId, outcome: 'investigated', summary: 'A second, different answer.' });
  assert.equal(again.res.status, 409, 'a result was submitted twice');
  assert.equal((await ai(`/work/${item.id}`)).body.item.work.run.summary, good.body.item.work.run.summary, 'the second submit overwrote the first');
});

test('only the operator judges a result, a return carries its note to the next attempt, and an accepted investigation is done', async () => {
  const item = claims.open;
  const byBot = await ai(`/work/${item.id}/review`, { decision: 'accept' });
  assert.equal(byBot.res.status, 409);
  assert.match(byBot.body.message, /Only the operator/);

  const silent = await op(`/work/${item.id}/review`, { decision: 'return' });
  assert.equal(silent.res.status, 400);
  assert.match(silent.body.message, /needs a note/);

  const note = 'Check the live site too, not only the repository.';
  const back = await op(`/work/${item.id}/review`, { decision: 'return', note });
  assert.equal(back.res.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.item.work.state, 'approved');
  assert.equal(back.body.item.work.attempts, 1, 'a return reset the attempts');

  const retry = await ai('/work/claim', { runner: 'mac', id: item.id });
  assert.equal(retry.res.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.item.last_review_note, note);
  assert.equal(retry.body.item.work.attempts, 2);
  assert.equal(retry.body.item.runs.length, 2);

  const submitted = await ai(`/work/${item.id}/submit`, { run: retry.body.item.work.run.id, outcome: 'investigated', summary: 'Checked the live site as asked: still true.' });
  assert.equal(submitted.res.status, 200, JSON.stringify(submitted.body));
  const accepted = await op(`/work/${item.id}/review`, { decision: 'accept', note: 'Good.' });
  assert.equal(accepted.body.item.work.state, 'done');
  assert.equal(accepted.body.item.work.run.review, 'accepted');
});

test('withdrawing a running item ends its run, and the runner learns it lost the lease', async () => {
  const item = claims.correction;
  const out = await op(`/work/${item.id}/withdraw`, undefined, 'POST');
  assert.equal(out.res.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.item.work, null);

  const beat = await ai(`/work/${item.id}/heartbeat`, { run: item.work.run.id });
  assert.equal(beat.res.status, 409);
  assert.match(beat.body.message, /no longer holds/);
  const late = await ai(`/work/${item.id}/submit`, { run: item.work.run.id, outcome: 'fixed', summary: 'Done anyway.' });
  assert.equal(late.res.status, 409, 'a withdrawn run still submitted');
  assert.equal((await op(`/work/${item.id}`)).body.item.runs[0].end_reason, 'withdrawn');
});

test('a fix waits for acceptance before it lands, and a landing that fails goes back to review', async () => {
  const row = await openRow('#902');
  await op(`/work/${row.id}/approve`, { mode: 'fix' });
  const claim = await ai('/work/claim', { runner: 'mac', id: row.id });
  assert.equal(claim.res.status, 200, JSON.stringify(claim.body));
  const runId = claim.body.item.work.run.id;
  const path = `/work/${row.id}/submit`;

  const noRefs = await ai(path, { run: runId, outcome: 'fixed', summary: 'Committed the fix.', needs_landing: true });
  assert.equal(noRefs.res.status, 400);
  assert.match(noRefs.body.message, /say what to land/);
  const bareRef = await ai(path, { run: runId, outcome: 'fixed', summary: 'Committed the fix.', needs_landing: true, refs: [{ repo: 'balise-site' }] });
  assert.equal(bareRef.res.status, 400);

  const ref = { repo: 'balise-site', branch: 'balise/abcd1234', commit: 'abc1234' };
  const submitted = await ai(path, { run: runId, outcome: 'fixed', summary: 'Committed the fix.', needs_landing: true, refs: [ref] });
  assert.equal(submitted.res.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.item.work.run.refs, [ref]);

  const accepted = await op(`/work/${row.id}/review`, { decision: 'accept' });
  assert.equal(accepted.body.item.work.state, 'accepted', 'an unlanded fix was marked done');

  assert.equal((await ai(`/work/${row.id}/land`, { run: NOT_A_RUN, landed: true })).res.status, 409);
  assert.equal((await ai(`/work/${row.id}/land`, { run: runId, landed: false })).res.status, 400);

  const failed = await ai(`/work/${row.id}/land`, { run: runId, landed: false, note: 'Main moved, so the branch no longer fast-forwards.' });
  assert.equal(failed.res.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.item.work.state, 'review');
  assert.match(failed.body.item.work.run.land_note, /fast-forwards/);
  assert.equal(failed.body.item.work.run.review, null);

  assert.equal((await op(`/work/${row.id}/review`, { decision: 'accept' })).body.item.work.state, 'accepted');
  const landed = await ai(`/work/${row.id}/land`, { run: runId, landed: true, refs: [{ ...ref, commit: 'def5678' }] });
  assert.equal(landed.res.status, 200, JSON.stringify(landed.body));
  assert.equal(landed.body.item.work.state, 'done');
  assert.ok(landed.body.item.work.run.landed_at > 0);
  assert.equal(landed.body.item.work.run.refs[0].commit, 'def5678');
});

test('ship lands before it submits, so a ship result can never still need landing', async () => {
  const row = await openRow('#903');
  await op(`/work/${row.id}/approve`, { mode: 'ship' });
  const claim = await ai('/work/claim', { runner: 'mac', id: row.id });
  const runId = claim.body.item.work.run.id;
  const ref = { repo: 'balise-site', commit: '1234abc' };

  const pending = await ai(`/work/${row.id}/submit`, { run: runId, outcome: 'fixed', summary: 'Landed.', needs_landing: true, refs: [ref] });
  assert.equal(pending.res.status, 400);
  assert.match(pending.body.message, /lands before it submits/);

  const shipped = await ai(`/work/${row.id}/submit`, { run: runId, outcome: 'fixed', summary: 'Landed after the suite passed.', refs: [ref] });
  assert.equal(shipped.res.status, 200, JSON.stringify(shipped.body));
  assert.equal((await op(`/work/${row.id}/review`, { decision: 'accept' })).body.item.work.state, 'done');
});

test('three attempts, then the item needs a person, and a fresh approval starts the count again', async () => {
  const row = await openRow('#904');
  await op(`/work/${row.id}/approve`, { mode: 'investigate' });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claim = await ai('/work/claim', { runner: 'mac', id: row.id });
    assert.equal(claim.res.status, 200, `attempt ${attempt}: ${JSON.stringify(claim.body)}`);
    assert.equal(claim.body.item.work.attempts, attempt);
    const released = await ai(`/work/${row.id}/release`, { run: claim.body.item.work.run.id, note: 'The tree was dirty.' });
    assert.equal(released.body.item.work.state, 'approved');
  }

  const fourth = await ai('/work/claim', { runner: 'mac', id: row.id });
  assert.equal(fourth.res.status, 409);
  assert.match(fourth.body.message, /used all 3 attempts/);
  assert.equal((await ai('/work/claim', { runner: 'mac' })).body.item, null, 'the queue handed out an item past its attempts');

  await op(`/work/${row.id}/withdraw`, undefined, 'POST');
  const fresh = await op(`/work/${row.id}/approve`, { mode: 'investigate', instruction: 'Try once more, and say what blocks it.' });
  assert.equal(fresh.body.item.work.attempts, 0);
  const claim = await ai('/work/claim', { runner: 'mac', id: row.id });
  assert.equal(claim.res.status, 200, JSON.stringify(claim.body));
  await ai(`/work/${row.id}/release`, { run: claim.body.item.work.run.id });
});

test('a lease runs out in real time, and the next claim takes the item over', async () => {
  const row = await openRow('#905');
  await op(`/work/${row.id}/approve`, { mode: 'investigate' });
  const first = await ai('/work/claim', { runner: 'mac', id: row.id, lease_seconds: 5 });
  assert.equal(first.res.status, 200, JSON.stringify(first.body));

  const held = await ai('/work/claim', { runner: 'second', id: row.id });
  assert.equal(held.res.status, 409);
  assert.match(held.body.message, /Another run holds/);

  await new Promise((resolve) => setTimeout(resolve, 6000));
  const second = await ai('/work/claim', { runner: 'second', id: row.id });
  assert.equal(second.res.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.item.work.run.runner, 'second');
  assert.equal(second.body.item.work.attempts, 2);
  assert.equal(second.body.item.runs[1].end_reason, 'expired');

  const stale = await ai(`/work/${row.id}/heartbeat`, { run: first.body.item.work.run.id });
  assert.equal(stale.res.status, 409, 'an expired run revived over the run that replaced it');
});

test('a follow-up filed by automation is a private draft, filed once, cannot approve itself, and no import can close it', async () => {
  const count = async () => (await op('/reports?kind=open&limit=50')).body.reports.length;
  const before = await count();
  const approving = await ai('/work/items', { text: 'Automation trying to hand itself this item.', approve: { mode: 'ship' } });
  assert.equal(approving.res.status, 409);
  assert.match(approving.body.message, /Only the operator/);
  assert.equal(await count(), before, 'a refused filing still wrote a row');

  const text = 'The report page could show a clearer message when the challenge cannot load.';
  const filed = await ai('/work/items', { text, suggested: 'See packages/neorgon-ui/beacon for the widget.' });
  assert.equal(filed.res.status, 200, JSON.stringify(filed.body));
  const { item } = filed.body;
  assert.equal(item.kind, 'open');
  assert.equal(item.source, 'direct');
  assert.equal(item.status, 'new');
  assert.equal(item.work, null);
  assert.match(item.source_ref, /^d-[0-9a-f]{8}$/);
  // The whole sentence is one clause and it names a path, so the field is stored empty
  // rather than as "See for the widget." (#81): a hole in a sentence invites an edit where
  // the operator needs to write the line themselves.
  assert.equal((await op(`/work/${item.id}`)).body.item.suggested, '', 'a stored suggestion kept part of a path');

  const twice = await ai('/work/items', { text: `  ${text.toUpperCase()}  ` });
  assert.equal(twice.res.status, 409);
  assert.equal(twice.body.code, 'DUPLICATE');

  const handed = await op('/work/items', { text: 'Write the release checklist for the work queue.', approve: { mode: 'investigate' } });
  assert.equal(handed.res.status, 200, JSON.stringify(handed.body));
  assert.equal(handed.body.item.work.state, 'approved');

  assert.equal((await ai('/open-items', { v: 1, source: 'direct', items: [{ ref: 'd-00000000', text: 'x' }] })).res.status, 400);
  assert.equal((await ai('/open-items/sync', { source: 'direct', refs: [] })).res.status, 400);
});

test('the queue lists by state, counts every state, pages without loss, and stays in budget', async () => {
  const active = await op('/work?limit=50');
  assert.equal(active.res.status, 200, JSON.stringify(active.body));
  const { counts } = active.body;
  assert.deepEqual(Object.keys(counts).sort(), ['accepted', 'approved', 'claimed', 'done', 'review']);
  assert.ok(active.body.items.every((i) => ['approved', 'claimed', 'review', 'accepted'].includes(i.work.state)));
  assert.equal(active.body.items.length, counts.approved + counts.claimed + counts.review + counts.accepted);
  assert.ok(counts.done >= 3, `expected three finished items, counted ${counts.done}`);
  assert.equal((await op('/work?state=finished')).res.status, 400);

  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const { body } = await op(`/work?state=done&limit=1${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    body.items.forEach((i) => seen.add(i.id));
    if (!body.next) break;
    cursor = body.next;
  }
  assert.equal(seen.size, counts.done, `paging reached ${seen.size} of ${counts.done} finished items`);

  const everQueued = Object.values(counts).reduce((a, b) => a + b, 0);
  for (const limit of [1, 5]) {
    const { body } = await op(`/work?state=done&limit=${limit}`);
    assert.ok(body.rows_read <= rowsReadBudget(limit) + everQueued, `a work page of ${limit} scanned ${body.rows_read} rows with ${everQueued} ever queued`);
  }
  for (const limit of [1, 5, 25]) {
    const { body } = await op(`/reports?limit=${limit}`);
    assert.ok(body.rows_read <= rowsReadBudget(limit), `the corrections page scanned ${body.rows_read} rows once the work queue existed`);
  }
});

test('the board says a published item is moving and nothing more, both board routes answer any origin, and automation still cannot publish', async () => {
  const row = await openRow('#906');
  const sentence = 'The report page is getting a clearer message for when the challenge cannot load.';
  const published = await call(`/reports/${row.id}`, { method: 'PATCH', body: { status: 'accepted', public_note: sentence }, token: TOKEN, ip: '192.0.2.60' });
  assert.equal(published.res.status, 200, JSON.stringify(published.body));
  const resolvedRow = await openRow('#907');
  const resolution = 'The fleet compliance checker now reports drift without failing the build.';
  const resolved = await call(`/reports/${resolvedRow.id}`, { method: 'PATCH', body: { status: 'fixed', public_note: resolution }, token: TOKEN, ip: '192.0.2.60' });
  assert.equal(resolved.res.status, 200, JSON.stringify(resolved.body));

  const quiet = await call('/board');
  assert.equal(quiet.body.open.find((e) => e.text === sentence).state, 'open', 'an item nobody is working on showed as moving');

  await op(`/work/${row.id}/approve`, { mode: 'investigate' });
  const claim = await ai('/work/claim', { runner: 'mac', id: row.id });
  assert.equal(claim.res.status, 200, JSON.stringify(claim.body));

  const board = await call('/board', { origin: ELSEWHERE });
  assert.equal(board.res.status, 200);
  assert.equal(board.res.headers.get('access-control-allow-origin'), '*');
  assert.equal(board.body.open.find((e) => e.text === sentence).state, 'in_progress');
  for (const entry of [...board.body.open, ...board.body.resolved]) {
    assert.deepEqual(Object.keys(entry).sort(), ['date', 'state', 'text']);
  }

  const summary = await call('/board/summary', { origin: ELSEWHERE });
  assert.equal(summary.res.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.res.headers.get('access-control-allow-origin'), '*');
  assert.equal(summary.res.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(summary.body.window_days, 30);
  assert.equal(summary.body.open, 1);
  // #905 is claimed too, and it is a private draft. One in progress, not two, is the proof
  // that a draft never moves a public number.
  assert.equal(summary.body.in_progress, 1);
  assert.equal(summary.body.resolved, 1);
  assert.equal(summary.body.latest.text, resolution);
  assert.match(summary.body.latest.date, /^\d{4}-\d{2}-\d{2}$/);

  const text = JSON.stringify([board.body, summary.body]);
  for (const secret of ['#906', 'Seeded tracker line', 'investigate', claim.body.item.work.run.id, '"runner"', 'source']) {
    assert.ok(!text.includes(secret), `a public board route carried ${secret}`);
  }

  for (const to of ['fixed', 'rejected']) {
    const moved = await call(`/reports/${row.id}`, { method: 'PATCH', body: { status: to, public_note: 'Done by the agent.' }, token: AI_TOKEN, ip: '192.0.2.61' });
    assert.equal(moved.res.status, 409, `automation moved an item it was working on to ${to}`);
  }
});

test('every other route keeps the allowlist', async () => {
  const desk = await call('/reports', { token: TOKEN, ip: '192.0.2.60', origin: ELSEWHERE });
  assert.equal(desk.res.status, 403);
  assert.equal(desk.body.code, 'FORBIDDEN_ORIGIN');
  assert.equal(desk.res.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('/work', { token: TOKEN, ip: '192.0.2.60', origin: ELSEWHERE })).res.status, 403);
  assert.equal((await call('/log', { origin: ELSEWHERE })).res.status, 403, 'the corrections log opened to every origin along with the board');
  const ours = await call('/work', { token: TOKEN, ip: '192.0.2.60', origin: 'https://balise.neorgon.com' });
  assert.equal(ours.res.headers.get('access-control-allow-origin'), 'https://balise.neorgon.com');
});

test('the work routes are behind the token, and a wrong method is a route error rather than an auth error', async () => {
  for (const [path, method] of [['/work', 'GET'], ['/work/claim', 'POST'], ['/work/items', 'POST']]) {
    const { res } = await call(path, { method, body: method === 'POST' ? {} : undefined, ip: '192.0.2.70' });
    assert.equal(res.status, 401, `${method} ${path} answered without a token`);
  }
  const wrong = await call('/work/claim', { ip: '192.0.2.70' });
  assert.equal(wrong.res.status, 404);
  assert.equal(wrong.body.code, 'NOT_A_ROUTE');
  assert.match(wrong.body.hint, /POST \/work\/claim/);
  assert.equal((await op('/work/abc/explode', {})).res.status, 404);
});
