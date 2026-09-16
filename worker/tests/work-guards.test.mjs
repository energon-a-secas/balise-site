// The work queue's guards under workerd, against a real local D1, each one tripped on purpose
// (docs/DESIGN-WORK-QUEUE.md). tests/work.test.mjs reads as the life of a few items that
// mostly go right; this file is the steps that have to be REFUSED, and the contract items of
// the fix round only a real database shows: the lockout starting again (C-a), the cursor
// (C-d), who filed an item (C-f, C-h), a lapsed ship lease (C-g), closing a queued item
// (C-i), the fields automation may not set (C-k), the body caps (C-l), and the newest review
// note in a list (C-n). The races (C-b, C-c, C-e) cannot be interleaved over HTTP and are in
// tests/work-races.test.mjs; the shapes are in tests/validate-work.test.mjs.
//
// The tests run IN ORDER on one database, and each leaves nothing approved behind it, because
// the lease test asserts that a claim naming no item finds nothing to take.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  WORKER_DIR, TOKEN, AI_TOKEN, SALT, TURNSTILE_PASS,
  migrate, run, startWorker, stopWorker, requester, report, seedReports, seedOpenItems,
} from './harness.mjs';
import { ipHash } from '../src/store.js';
import { SUMMARY_MAX, EVIDENCE_MAX } from '../src/validate-work.js';

const STATE = join(WORKER_DIR, '.wrangler/work-guards-state');
const PORT = 8894;
const call = requester(`http://127.0.0.1:${PORT}`);

const CONTACT = 'guards-contact@example.com';
const ELSEWHERE = 'https://elsewhere.example';
const NOT_AN_ID = '00000000-0000-4000-8000-000000000000';
const REF = { repo: 'balise-site', branch: 'balise/abcd1234-a1', commit: 'abc1234' };

const as = (token, ip) => (path, body, method) =>
  call(path, { method: method || (body === undefined ? 'GET' : 'POST'), body, token, ip });
const op = as(TOKEN, '192.0.2.80');
const ai = as(AI_TOKEN, '192.0.2.81');
const patch = (token, id, body) =>
  call(`/reports/${id}`, { method: 'PATCH', body, token, ip: token === TOKEN ? '192.0.2.80' : '192.0.2.81' });

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
  await seedReports(call, 6, assert);
  const { res } = await call('/report', { method: 'POST', body: report(99, { contact: CONTACT }), ip: '198.51.100.99' });
  assert.equal(res.status, 200);
  await seedOpenItems(call, 25, assert);
}, { timeout: 300_000 });

after(async () => {
  await stopWorker(worker);
});

/** One statement against this suite's own --local state, for what no route reads or writes. */
async function sql(command) {
  const out = await run(['d1', 'execute', 'balise', '--local', '--persist-to', STATE, '--json', '--command', command]);
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

function ok(out) {
  assert.equal(out.res.status, 200, JSON.stringify(out.body));
  return out.body;
}

function refused(out, status, code, message) {
  assert.equal(out.res.status, status, JSON.stringify(out.body));
  assert.equal(out.body.code, code, JSON.stringify(out.body));
  if (message) assert.match(out.body.message, message);
}

const desk = async (kind) => ok(await op(`/reports?limit=50${kind ? `&kind=${kind}` : ''}`)).reports;
const detail = async (id) => ok(await op(`/work/${id}`)).item;
const claim = (id, extra = {}) => ai('/work/claim', { runner: 'mac', id, ...extra });
const withdraw = (id) => op(`/work/${id}/withdraw`, undefined, 'POST');
const boardEntry = async (text) => ok(await call('/board?limit=50')).open.find((e) => e.text === text);
const newCorrections = async () => (await desk()).filter((r) => r.status === 'new' && !r.contact);

async function openRow(ref) {
  const row = (await desk('open')).find((r) => r.source_ref === ref);
  assert.ok(row, `seeded item ${ref} is missing`);
  return row;
}

/** Everything a reader could ever see of a row. No work step may move any of it (#57). */
async function readerView(id) {
  const row = [...(await desk('open')), ...(await desk())].find((r) => r.id === id);
  assert.ok(row, `row ${id} is not on the desk`);
  return { status: row.status, public: row.public, public_note: row.public_note, fixed_at: row.fixed_at, fixed_ref: row.fixed_ref };
}

test('C-f: the migration adds filed_by and builds no index nothing reads, and no import or reader report has a filer', async () => {
  const columns = (await sql("SELECT name FROM pragma_table_info('reports')")).map((r) => r.name);
  assert.ok(columns.includes('filed_by'), 'reports.filed_by is missing after the migrations');
  const indexes = (await sql("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reports'")).map((r) => r.name);
  assert.ok(!indexes.includes('reports_work_queue'), 'the unused reports_work_queue index is still built');
  assert.ok(indexes.includes('reports_work_updated') && indexes.includes('reports_work_run'), indexes.join(', '));
  for (const row of [...(await desk('open')), ...(await desk())]) {
    assert.ok('filed_by' in row, 'a desk row does not carry filed_by');
    assert.equal(row.filed_by, null, `${row.kind} ${row.source_ref || row.id} has a filer`);
  }
});

test('C-a: a wrong try after a lock has run out starts the count again instead of relocking', async () => {
  const ip = '192.0.2.99';
  for (let i = 0; i < 5; i += 1) refused(await call('/work', { token: `wrong-${i}`, ip }), 401, 'UNAUTHORIZED');
  refused(await call('/work', { token: TOKEN, ip }), 401, 'UNAUTHORIZED');

  await sql('UPDATE auth_attempts SET locked_until = 1 WHERE locked_until > 0');
  refused(await call('/work', { token: 'wrong-after-the-lock', ip }), 401, 'UNAUTHORIZED');
  const [row] = await sql(`SELECT failures, locked_until FROM auth_attempts WHERE key = '${await ipHash(SALT, ip)}'`);
  assert.deepEqual({ ...row }, { failures: 1, locked_until: 0 }, 'the count carried on past an expired lock');
  ok(await call('/work', { token: TOKEN, ip }));
});

test('C-h: an item automation filed is trusted like a stranger\'s report, and one the operator filed like the fleet\'s', async () => {
  const bot = ok(await ai('/work/items', { text: 'Automation filed this follow-up from a report it had read.' })).item;
  const mine = ok(await op('/work/items', { text: 'The operator filed this item for the fleet to pick up.' })).item;
  assert.equal(bot.trust, 'stranger');
  assert.equal(mine.trust, 'fleet');

  const open = await desk('open');
  const stored = (id) => open.find((r) => r.id === id);
  assert.equal(stored(bot.id).filed_by, 'ai');
  assert.equal(stored(mine.id).filed_by, 'human');
  // C-e: each filing steps past the newest open item.
  const imported = Math.max(...open.filter((r) => r.source !== 'direct').map((r) => r.created_at));
  assert.ok(stored(bot.id).created_at > imported && stored(mine.id).created_at > stored(bot.id).created_at);

  refused(await op(`/work/${bot.id}/approve`, { mode: 'ship', instruction: 'Ship it, the text is fine.' }), 400, 'BAD_FIELD', /ship mode/);
  refused(await op(`/work/${bot.id}/approve`, { mode: 'fix' }), 400, 'BAD_FIELD', /instruction you wrote/);
  refused(await op(`/work/${bot.id}/approve`, { mode: 'fix', instruction: 'Check it.' }), 400, 'BAD_FIELD', /instruction you wrote/);
  assert.equal(ok(await op(`/work/${bot.id}/approve`, { mode: 'fix', instruction: 'Check this' })).item.work.mode, 'fix');
  assert.equal(ok(await op(`/work/${mine.id}/approve`, { mode: 'ship' })).item.work.mode, 'ship');

  const listed = ok(await op('/work?state=approved')).items;
  assert.equal(listed.find((i) => i.id === bot.id).trust, 'stranger');
  assert.equal(listed.find((i) => i.id === mine.id).trust, 'fleet');
  const taken = ok(await claim(bot.id)).item;
  assert.equal(taken.trust, 'stranger', 'the runner was not told whose words it is reading');
  ok(await ai(`/work/${bot.id}/release`, { run: taken.work.run.id }));
  for (const id of [bot.id, mine.id]) assert.equal(ok(await withdraw(id)).item.work, null);
});

test('C-g, #52, #53: leases lapse in real time; the holder revives its own, a reclaim wins, a ship lease waits for a person, a last attempt goes back', async () => {
  const [revive, reclaim, shipOne, shipCap, fixCap] = await Promise.all(['#900', '#901', '#902', '#903', '#904'].map(openRow));
  const modes = [[revive, 'investigate'], [reclaim, 'investigate'], [shipOne, 'ship'], [shipCap, 'ship'], [fixCap, 'fix']];
  for (const [item, mode] of modes) ok(await op(`/work/${item.id}/approve`, { mode }));
  for (const item of [shipCap, fixCap]) {
    for (let n = 0; n < 2; n += 1) {
      const held = ok(await claim(item.id)).item;
      ok(await ai(`/work/${item.id}/release`, { run: held.work.run.id }));
    }
  }
  const runs = {};
  for (const [item] of modes) runs[item.id] = ok(await claim(item.id, { lease_seconds: 5 })).item.work.run.id;
  await new Promise((resolve) => setTimeout(resolve, 6000));

  // #53: nobody took it over, so the holder's heartbeat revives the lapsed lease.
  const beat = ok(await ai(`/work/${revive.id}/heartbeat`, { run: runs[revive.id] }));
  assert.equal(beat.item.work.state, 'claimed');
  assert.ok(beat.item.work.lease_until > Date.now() + 60_000, 'the heartbeat did not revive a lapsed lease');

  // #52: another runner takes a lapsed lease over, and the first run can no longer release it.
  const second = ok(await ai('/work/claim', { runner: 'second', id: reclaim.id })).item;
  refused(await ai(`/work/${reclaim.id}/release`, { run: runs[reclaim.id], note: 'Giving it back.' }), 409, 'BAD_TRANSITION', /no longer holds/);
  const kept = await detail(reclaim.id);
  assert.equal(kept.work.state, 'claimed', 'a stale release put the item back');
  assert.equal(kept.work.run.id, second.work.run.id);
  assert.equal(kept.work.run.ended_at, null, 'a stale release ended the live run');

  // C-g: that claim first swept the lapsed last attempt back to approved, ending its run...
  const swept = await detail(fixCap.id);
  assert.equal(swept.work.state, 'approved', 'a lapsed last attempt still reads as running');
  assert.equal(swept.runs[0].id, runs[fixCap.id]);
  assert.equal(swept.runs[0].end_reason, 'expired');
  refused(await claim(fixCap.id), 409, 'BAD_TRANSITION', /used all 3 attempts/);
  // ...its run is told the last attempt ran out, rather than that the item takes a claim...
  const late = await ai(`/work/${fixCap.id}/heartbeat`, { run: runs[fixCap.id] });
  refused(late, 409, 'BAD_TRANSITION', /^This run's lease ran out on the item's last attempt, so the item went back to the operator\.$/);
  assert.doesNotMatch(late.body.hint, /claim/i, 'the swept run was sent to claim');

  // ...and no claim takes a lapsed ship lease, named or not: that run may already have pushed.
  assert.equal(ok(await ai('/work/claim', { runner: 'second' })).item, null, 'a lapsed ship lease was handed to another run');
  for (const item of [shipOne, shipCap]) {
    refused(await ai('/work/claim', { runner: 'second', id: item.id }), 409, 'BAD_TRANSITION', /ship run held that item/);
    const held = await detail(item.id);
    assert.equal(held.work.state, 'claimed', `the ship item ${item.source_ref} was swept or taken`);
    assert.equal(held.work.run.id, runs[item.id]);
    assert.equal(held.work.run.ended_at, null);
  }
  ok(await ai(`/work/${shipOne.id}/heartbeat`, { run: runs[shipOne.id] }));
  for (const [item] of modes) ok(await withdraw(item.id));
});

test('#47, #48, #55, #57, C-i: only an accepted result lands, only the operator stops work, a queued item is not closed, and no step moves what a reader sees', async () => {
  const [row, other] = await Promise.all(['#905', '#906'].map(openRow));
  let view = await readerView(row.id);
  ok(await op(`/work/${row.id}/approve`, { mode: 'fix' }));
  const runId = ok(await claim(row.id)).item.work.run.id;
  const land = (landed) => ai(`/work/${row.id}/land`, { run: runId, landed, refs: [REF], note: 'Trying to land it anyway.' });

  refused(await ai(`/work/${row.id}/withdraw`, undefined, 'POST'), 409, 'BAD_TRANSITION', /Only the operator/);
  for (const landed of [true, false]) refused(await land(landed), 409, 'BAD_TRANSITION');
  const dup = await patch(TOKEN, row.id, { status: 'duplicate', duplicate_of: other.id });
  refused(dup, 409, 'BAD_TRANSITION', /work queue at "claimed"/);
  assert.match(dup.body.hint, /Withdraw it from the work queue first/);
  let item = await detail(row.id);
  assert.equal(item.work.state, 'claimed');
  assert.equal(item.work.run.ended_at, null, 'a refused step ended the run');
  assert.deepEqual(await readerView(row.id), view);

  ok(await ai(`/work/${row.id}/submit`, { run: runId, outcome: 'fixed', summary: 'Committed the fix.', needs_landing: true, refs: [REF] }));
  assert.deepEqual(await readerView(row.id), view, 'a submit moved what a reader sees');
  for (const landed of [true, false]) refused(await land(landed), 409, 'BAD_TRANSITION');
  refused(await claim(row.id), 409, 'BAD_TRANSITION');
  refused(await patch(TOKEN, row.id, { status: 'rejected' }), 409, 'BAD_TRANSITION', /work queue at "review"/);
  item = await detail(row.id);
  assert.equal(item.work.state, 'review', 'a landing before acceptance moved the result');
  assert.equal(item.work.run.landed_at, null);
  assert.equal(item.work.run.review, null);

  assert.equal(ok(await op(`/work/${row.id}/review`, { decision: 'accept' })).item.work.state, 'accepted');
  assert.deepEqual(await readerView(row.id), view, 'accepting a result moved what a reader sees');
  refused(await claim(row.id), 409, 'BAD_TRANSITION');
  refused(await patch(TOKEN, row.id, { status: 'fixed', public_note: 'The fix has landed.' }), 409, 'BAD_TRANSITION', /work queue at "accepted"/);
  // Publishing as open closes nothing, so it stays allowed while an agent has the item.
  const sentence = 'A fix for the report page is on its way.';
  assert.equal(ok(await patch(TOKEN, row.id, { status: 'accepted', public_note: sentence })).report.status, 'accepted');
  assert.equal((await boardEntry(sentence)).state, 'in_progress', 'a result waiting to land did not read as moving');
  view = await readerView(row.id);

  assert.equal(ok(await land(true)).item.work.state, 'done');
  assert.deepEqual(await readerView(row.id), view, 'landing a result moved what a reader sees');
  assert.equal((await boardEntry(sentence)).state, 'open', 'a finished item still read as moving');
  refused(await claim(row.id), 409, 'BAD_TRANSITION');
  refused(await claim(NOT_AN_ID), 404, 'NOT_FOUND');

  // #54: approving a finished item starts its count and its place again.
  const again = ok(await op(`/work/${row.id}/approve`, { mode: 'investigate' })).item;
  assert.equal(again.work.attempts, 0);
  assert.ok(again.work.approved_at > item.work.approved_at, 'a fresh approval kept the old place');
  assert.equal(ok(await withdraw(row.id)).item.work, null);
  assert.deepEqual(await readerView(row.id), view, 'a withdraw moved what a reader sees');

  // A finished item closes as it always did, and #64: once resolved, no approval queues it again.
  ok(await op(`/work/${row.id}/approve`, { mode: 'investigate' }));
  const last = ok(await claim(row.id)).item.work.run.id;
  ok(await ai(`/work/${row.id}/submit`, { run: last, outcome: 'investigated', summary: 'Nothing is left to do.' }));
  assert.equal(ok(await op(`/work/${row.id}/review`, { decision: 'accept' })).item.work.state, 'done');
  ok(await patch(TOKEN, row.id, { status: 'fixed', public_note: 'The report page now says when the challenge cannot load.' }));
  view = await readerView(row.id);
  refused(await op(`/work/${row.id}/approve`, { mode: 'investigate' }), 409, 'BAD_TRANSITION', /resolved, so it cannot be handed to an agent/);
  assert.equal((await detail(row.id)).work.state, 'done', 'a refused approval moved a resolved item');
  assert.deepEqual(await readerView(row.id), view, 'a refused approval moved what a reader sees');
});

test('#54: an edit keeps the attempts, a claimed item is not approved over its run, and a dismiss drops the item and records it', async () => {
  const row = await openRow('#907');
  const view = await readerView(row.id);
  const first = ok(await op(`/work/${row.id}/approve`, { mode: 'investigate' })).item;
  const spent = ok(await claim(row.id)).item;
  ok(await ai(`/work/${row.id}/release`, { run: spent.work.run.id }));
  const edit = ok(await op(`/work/${row.id}/approve`, { mode: 'fix', instruction: 'Look again at the header first.' })).item;
  assert.equal(edit.work.attempts, 1, 'an edit gave back an attempt');
  assert.equal(edit.work.approved_at, first.work.approved_at);

  const held = ok(await claim(row.id)).item;
  refused(await op(`/work/${row.id}/approve`, { mode: 'investigate' }), 409, 'BAD_TRANSITION');
  let item = await detail(row.id);
  assert.equal(item.work.state, 'claimed', 'approving a claimed item moved it');
  assert.equal(item.work.lease_until, held.work.lease_until);
  assert.equal(item.work.run.ended_at, null);

  ok(await ai(`/work/${row.id}/submit`, { run: held.work.run.id, outcome: 'partial', summary: 'Half of it is done.' }));
  assert.equal(ok(await op(`/work/${row.id}/review`, { decision: 'dismiss' })).item.work, null, 'a dismissed result is still queued');
  item = await detail(row.id);
  assert.equal(item.runs[0].id, held.work.run.id);
  assert.equal(item.runs[0].review, 'dismissed');
  assert.deepEqual(await readerView(row.id), view, 'a dismiss moved what a reader sees');
});

test('C-n: a list carries the newest note a person wrote when sending a result back, through every attempt after it', async () => {
  const row = await openRow('#908');
  const listed = async (state) => ok(await op(`/work?state=${state}&limit=50`)).items.find((i) => i.id === row.id);
  ok(await op(`/work/${row.id}/approve`, { mode: 'investigate' }));
  assert.equal((await listed('approved')).last_review_note, '');
  const newest = 'Now say which pages are affected.';
  for (const note of ['Check the live site too.', newest]) {
    const held = ok(await claim(row.id)).item;
    ok(await ai(`/work/${row.id}/submit`, { run: held.work.run.id, outcome: 'investigated', summary: 'Still true.' }));
    ok(await op(`/work/${row.id}/review`, { decision: 'return', note }));
    assert.equal((await listed('approved')).last_review_note, note);
  }
  const last = ok(await claim(row.id)).item;
  assert.equal((await listed('claimed')).last_review_note, newest, 'the running attempt lost the note it was sent back with');
  ok(await ai(`/work/${row.id}/submit`, { run: last.work.run.id, outcome: 'investigated', summary: 'Two pages.' }));
  assert.equal((await listed('review')).last_review_note, newest);
  ok(await op(`/work/${row.id}/review`, { decision: 'accept' }));
  assert.equal((await listed('done')).last_review_note, newest, 'an accept with no note hid the last one written');
});

test('#49, #60: a correction\'s result keeps no drafted sentence, and no work answer carries its contact, ip hash or fingerprint', async () => {
  const target = (await desk()).find((r) => r.contact === CONTACT);
  assert.ok(target, 'the correction with a contact address is missing');
  const [secrets] = await sql(`SELECT contact, ip_hash, fingerprint FROM reports WHERE id = '${target.id}'`);
  assert.ok(secrets.contact && secrets.ip_hash && secrets.fingerprint, 'the correction has nothing that could leak');

  const answers = [await op(`/work/${target.id}/approve`, { mode: 'fix', instruction: 'Correct the gloss against the page itself.' })];
  answers.push(await op('/work?limit=50'));
  const held = await claim(target.id);
  answers.push(held, await ai(`/work/${target.id}`));
  const submitted = await ai(`/work/${target.id}/submit`, {
    run: held.body.item.work.run.id, outcome: 'fixed', summary: 'Corrected the gloss.', needs_landing: true, refs: [REF],
    suggested_note: 'The gloss for this entry now matches the page.',
  });
  answers.push(submitted, await op('/work?state=review'), await op(`/work/${target.id}/review`, { decision: 'dismiss' }));
  for (const { res, body } of answers) {
    assert.equal(res.status, 200, JSON.stringify(body));
    const text = JSON.stringify(body);
    for (const [name, value] of Object.entries(secrets)) assert.ok(!text.includes(value), `a work answer carried the ${name}`);
  }
  assert.equal(submitted.body.item.work.run.suggested_note, '', 'a drafted sentence was kept on a stranger\'s report');
});

test('#56: the board summary counts published open items only, inside its window, and moving only while an agent holds one', async () => {
  const counts = async () => {
    const s = ok(await call('/board/summary'));
    return { open: s.open, in_progress: s.in_progress, resolved: s.resolved, latest: s.latest };
  };
  const base = await counts();
  const [shown, hidden, recent, old] = await Promise.all(['#909', '#910', '#911', '#912'].map(openRow));
  const [accepted, fixed] = await newCorrections();

  // A published correction moves no board number, and neither does an open item the operator hid,
  // even while an agent holds it.
  ok(await patch(TOKEN, accepted.id, { status: 'accepted' }));
  ok(await patch(TOKEN, fixed.id, { status: 'accepted' }));
  ok(await patch(TOKEN, fixed.id, { status: 'fixed', public_note: 'The gloss now matches the page.' }));
  ok(await patch(TOKEN, hidden.id, { status: 'accepted', public: false, public_note: 'A hidden entry nobody should count.' }));
  ok(await op(`/work/${hidden.id}/approve`, { mode: 'investigate' }));
  ok(await claim(hidden.id));
  assert.deepEqual(await counts(), base, 'a correction or a hidden item moved a board number');

  // Approved is waiting, not moving; claimed and in review are moving; done is not.
  const sentence = 'The report page is getting a clearer message for a failed challenge.';
  ok(await patch(TOKEN, shown.id, { status: 'accepted', public_note: sentence }));
  ok(await op(`/work/${shown.id}/approve`, { mode: 'investigate' }));
  assert.equal((await boardEntry(sentence)).state, 'open', 'an approved item nobody holds read as moving');
  assert.deepEqual(await counts(), { ...base, open: base.open + 1 });
  const held = ok(await claim(shown.id)).item;
  assert.equal((await boardEntry(sentence)).state, 'in_progress');
  assert.equal((await counts()).in_progress, base.in_progress + 1);
  ok(await ai(`/work/${shown.id}/submit`, { run: held.work.run.id, outcome: 'investigated', summary: 'Still true.' }));
  assert.equal((await boardEntry(sentence)).state, 'in_progress');
  ok(await op(`/work/${shown.id}/review`, { decision: 'accept' }));
  assert.equal((await boardEntry(sentence)).state, 'open', 'a finished item still read as moving');
  assert.equal((await counts()).in_progress, base.in_progress);

  // A resolution older than the window is not counted, and the newest one is the latest.
  ok(await patch(TOKEN, old.id, { status: 'fixed', public_note: 'An old resolution outside the window.' }));
  ok(await patch(TOKEN, recent.id, { status: 'fixed', public_note: 'A recent resolution inside the window.' }));
  await sql(`UPDATE reports SET fixed_at = fixed_at - ${31 * 86_400_000} WHERE id = '${old.id}'`);
  const after = await counts();
  assert.equal(after.resolved, base.resolved + 1, 'a resolution from outside the window was counted');
  assert.equal(after.latest.text, 'A recent resolution inside the window.');

  // The board's errors are readable from any origin, like its answers.
  const bad = await call('/board?limit=abc', { origin: ELSEWHERE });
  refused(bad, 400, 'BAD_FIELD');
  assert.equal(bad.res.headers.get('access-control-allow-origin'), '*');
  ok(await withdraw(hidden.id));
});

test('C-i: a move that closes a queued item is refused for either credential, and allowed once it is withdrawn', async () => {
  const ship = await openRow('#913');
  const [correction] = await newCorrections();
  ok(await op(`/work/${ship.id}/approve`, { mode: 'ship' }));
  ok(await op(`/work/${correction.id}/approve`, { mode: 'fix', instruction: 'Correct the gloss against the page itself.' }));
  const note = 'The report page now explains a failed challenge.';

  refused(await patch(TOKEN, ship.id, { status: 'fixed', public_note: note }), 409, 'BAD_TRANSITION', /work queue at "approved", so it cannot move to "fixed"/);
  refused(await patch(AI_TOKEN, correction.id, { status: 'spam' }), 409, 'BAD_TRANSITION', /work queue at "approved"/);
  refused(await patch(AI_TOKEN, correction.id, { status: 'duplicate', duplicate_of: ship.id }), 409, 'BAD_TRANSITION', /work queue/);
  refused(await patch(TOKEN, correction.id, { status: 'rejected' }), 409, 'BAD_TRANSITION', /work queue/);
  for (const id of [ship.id, correction.id]) assert.equal((await readerView(id)).status, 'new');

  for (const id of [ship.id, correction.id]) ok(await withdraw(id));
  assert.equal(ok(await patch(AI_TOKEN, correction.id, { status: 'spam' })).report.status, 'spam');
  assert.equal(ok(await patch(TOKEN, ship.id, { status: 'fixed', public_note: note })).report.status, 'fixed');

  // #64: closed, neither goes back into the queue; the spam does once a person reopens it.
  const instruction = 'Correct the gloss against the page itself.';
  refused(await op(`/work/${correction.id}/approve`, { mode: 'fix', instruction }), 409, 'BAD_TRANSITION', /closed as "spam"/);
  refused(await op(`/work/${ship.id}/approve`, { mode: 'ship' }), 409, 'BAD_TRANSITION', /resolved/);
  for (const id of [ship.id, correction.id]) assert.equal((await detail(id)).work, null, 'a refused approval queued a closed item');
  ok(await patch(TOKEN, correction.id, { status: 'accepted' }));
  assert.equal(ok(await op(`/work/${correction.id}/approve`, { mode: 'fix', instruction })).item.work.state, 'approved');
  ok(await withdraw(correction.id));
});

test('C-k: automation cannot set public, public_note or fixed_ref, even on a move it is allowed', async () => {
  const [correction, other] = await newCorrections();
  const view = await readerView(correction.id);
  for (const [field, body] of [
    ['public_note', { status: 'triaged', public_note: 'Automation wrote this.' }],
    ['public', { status: 'spam', public: false }],
    ['fixed_ref', { status: 'duplicate', duplicate_of: other.id, fixed_ref: 'abc1234' }],
  ]) {
    refused(await patch(AI_TOKEN, correction.id, body), 400, 'BAD_FIELD', new RegExp(`cannot set ${field}\\.`));
  }
  // A move automation may not make at all is refused as a move, before its fields are read.
  refused(await patch(AI_TOKEN, correction.id, { status: 'accepted', public_note: 'Automation wrote this.' }), 409, 'BAD_TRANSITION');
  assert.deepEqual(await readerView(correction.id), view);
  assert.equal(ok(await patch(AI_TOKEN, correction.id, { status: 'triaged', ai_verdict: 'plausible' })).report.status, 'triaged');
});

test('C-j: a sync that names no refs is refused and closes nothing', async () => {
  const closed = async () => (await desk('open')).filter((r) => r.source_closed_at).length;
  const before = await closed();
  refused(await ai('/open-items/sync', { source: 'queue', refs: [] }), 400, 'MISSING_PARAM', /no refs/);
  assert.equal(await closed(), before, 'an empty sync closed items');
});

test('C-l: a work body may pass 8 KB and stops at 64 KB, while every other route still stops at 8 KB', async () => {
  const row = await openRow('#914');
  ok(await op(`/work/${row.id}/approve`, { mode: 'investigate' }));
  const runId = ok(await claim(row.id)).item.work.run.id;
  const body = { run: runId, outcome: 'investigated', summary: '€'.repeat(SUMMARY_MAX), evidence: '€'.repeat(EVIDENCE_MAX) };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 16 * 1024, 'the body does not pass the 8 KB cap');
  assert.equal(ok(await ai(`/work/${row.id}/submit`, body)).item.work.state, 'review');

  refused(await op(`/work/${row.id}/review`, { decision: 'accept', note: 'x'.repeat(70_000) }), 413, 'TOO_LARGE', /over 64 KB/);
  assert.equal((await detail(row.id)).work.state, 'review', 'a refused body still moved the item');
  const bulky = 'x'.repeat(9000);
  refused(await patch(TOKEN, row.id, { status: 'accepted', public_note: bulky }), 413, 'TOO_LARGE', /over 8 KB/);
  refused(await ai('/open-items', { v: 1, source: 'queue', items: [{ ref: '#999', text: bulky }] }), 413, 'TOO_LARGE', /over 8 KB/);
  ok(await op(`/work/${row.id}/review`, { decision: 'dismiss' }));
});

test('C-d: GET /work pages by "<updated_at>:<id>", newest first with the id breaking a tie, and refuses any other cursor', async () => {
  const rows = await Promise.all(['#915', '#916', '#917'].map(openRow));
  for (const row of rows) ok(await op(`/work/${row.id}/approve`, { mode: 'investigate' }));
  const stamp = Date.now() - 1000;
  await sql(`UPDATE reports SET work_updated_at = ${stamp} WHERE id IN (${rows.map((r) => `'${r.id}'`).join(', ')})`);

  const walked = [];
  let next = null;
  for (let page = 0; page < 20; page += 1) {
    const body = ok(await op(`/work?state=approved&limit=1${next ? `&before=${encodeURIComponent(next)}` : ''}`));
    walked.push(...body.items);
    if (!body.next) break;
    assert.match(body.next, /^\d{1,16}:[0-9a-f-]{36}$/);
    next = body.next;
  }
  const ids = walked.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'a page repeated an item');
  assert.equal(ids.length, ok(await op('/work')).counts.approved, 'paging lost an item');
  const tied = walked.filter((i) => i.work.updated_at === stamp).map((i) => i.id);
  assert.deepEqual(tied, rows.map((r) => r.id).sort().reverse(), 'items tied on the time are not in id order');
  for (let i = 1; i < walked.length; i += 1) {
    const [a, b] = [walked[i - 1], walked[i]];
    assert.ok(a.work.updated_at > b.work.updated_at || (a.work.updated_at === b.work.updated_at && a.id > b.id), 'the list is out of order');
  }

  for (const before of [String(stamp), 'abc', `${stamp}:`]) refused(await op(`/work?before=${encodeURIComponent(before)}`), 400, 'BAD_FIELD');
  for (const row of rows) ok(await withdraw(row.id));
});

test('#51: an id that names no item is NOT_FOUND on a read and on every action, and a string "false" never lands', async () => {
  refused(await op(`/work/${NOT_AN_ID}`), 404, 'NOT_FOUND');
  refused(await op(`/work/${NOT_AN_ID}/approve`, { mode: 'fix' }), 404, 'NOT_FOUND');
  refused(await withdraw(NOT_AN_ID), 404, 'NOT_FOUND');
  refused(await op(`/work/${NOT_AN_ID}/review`, { decision: 'accept' }), 404, 'NOT_FOUND');
  for (const [action, body] of [['heartbeat', {}], ['release', {}], ['submit', { outcome: 'blocked', summary: 'Nothing there.' }], ['land', { landed: true }]]) {
    refused(await ai(`/work/${NOT_AN_ID}/${action}`, { run: NOT_AN_ID, ...body }), 404, 'NOT_FOUND');
  }
  refused(await ai(`/work/${NOT_AN_ID}/land`, { run: NOT_AN_ID, landed: 'false', note: 'Main moved.' }), 400, 'MISSING_PARAM');
});
