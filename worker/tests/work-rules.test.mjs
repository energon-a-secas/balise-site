// The work queue's rules with no database at all (docs/DESIGN-WORK-QUEUE.md section 2).
//
// Two kinds of test live here. The table is asserted LITERALLY, the way tests/api.test.mjs
// asserts C4's, so widening an action by accident fails with that action named. And the
// one property the whole design rests on, that no work action can move anything toward a
// reader, is checked against the SOURCE of src/store-work.js and src/store-work-runner.js
// rather than described: a future UPDATE that sets `status` or `public_note` there fails
// this file before it runs. tests/work-guards.test.mjs reads the columns after each action
// against a real D1, because a scan of text cannot see every way of writing one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WORK_ACTIONS, WORK_STATES, ACTIVE_STATES, IN_PROGRESS_STATES, CLOSED_STATUSES, WORK_MODES, MAX_ATTEMPTS, NONE,
  canAct, actionsFrom, refusal, closedRule, approvalRule, submitRule, acceptTarget, trustOf, titleFor, stateOf,
} from '../src/work.js';
import { STATUSES, TRANSITIONS, OPEN_TRANSITIONS } from '../src/transitions.js';

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');

// Both halves of the work queue's SQL, read as one, so a query moved from one file to the
// other is still checked.
const WORK_SQL = ['store-work.js', 'store-work-runner.js'].map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

test('the action table, literally', () => {
  assert.deepEqual(WORK_ACTIONS, {
    approve: { from: ['none', 'approved', 'done'], to: 'approved', actors: ['human'] },
    withdraw: { from: ['approved', 'claimed', 'review', 'accepted'], to: 'none', actors: ['human'] },
    claim: { from: ['approved'], to: 'claimed', actors: ['human', 'ai'] },
    heartbeat: { from: ['claimed'], to: 'claimed', actors: ['human', 'ai'] },
    release: { from: ['claimed'], to: 'approved', actors: ['human', 'ai'] },
    submit: { from: ['claimed'], to: 'review', actors: ['human', 'ai'] },
    accept: { from: ['review'], to: 'accepted', actors: ['human'] },
    return: { from: ['review'], to: 'approved', actors: ['human'] },
    dismiss: { from: ['review'], to: 'none', actors: ['human'] },
    land: { from: ['accepted'], to: 'done', actors: ['human', 'ai'] },
    unland: { from: ['accepted'], to: 'review', actors: ['human', 'ai'] },
  });
  assert.deepEqual(WORK_STATES, ['approved', 'claimed', 'review', 'accepted', 'done']);
  assert.deepEqual(ACTIVE_STATES, ['approved', 'claimed', 'review', 'accepted']);
  assert.deepEqual(IN_PROGRESS_STATES, ['claimed', 'review', 'accepted']);
  assert.deepEqual(CLOSED_STATUSES, ['fixed', 'rejected', 'spam', 'duplicate']);
  assert.deepEqual(WORK_MODES, ['investigate', 'fix', 'ship']);
  assert.equal(MAX_ATTEMPTS, 3);
});

test('automation holds none of the three verbs that belong to a person: start, judge, stop', () => {
  for (const action of ['approve', 'withdraw', 'accept', 'return', 'dismiss']) {
    assert.deepEqual(WORK_ACTIONS[action].actors, ['human'], `automation can ${action}`);
    for (const from of [NONE, ...WORK_STATES]) {
      assert.equal(canAct(action, from, 'ai'), false, `automation can ${action} from ${from}`);
    }
  }
  // And every action automation does hold is doing or reporting.
  assert.deepEqual(actionsFrom('claimed', 'ai').sort(), ['heartbeat', 'release', 'submit']);
  assert.deepEqual(actionsFrom('review', 'ai'), [], 'automation can act on a result waiting for a person');
});

test('no work action writes a column a reader can see', () => {
  const sets = WORK_SQL.match(/\bSET\b[\s\S]*?\bWHERE\b/g) || [];
  assert.ok(sets.length >= 10, `expected every action's UPDATE, found ${sets.length}`);
  for (const clause of sets) {
    assert.doesNotMatch(clause, /\b(status|public_note|public|fixed_at|fixed_ref)\s*=/, `a work UPDATE writes a public column:\n${clause}`);
  }
  // The one INSERT into reports files a private draft, and says so in its literal.
  assert.match(WORK_SQL, /VALUES \(\?, \?, \?, '', \?, \?, 'new', 1,/);
});

test('#57: no work module imports a function that writes a report a reader can see', () => {
  // The scan above reads SET clauses. This closes the other road: a work step that calls
  // src/store.js to publish on its behalf.
  for (const file of ['store-work.js', 'store-work-runner.js', 'routes-work.js']) {
    const source = readFileSync(join(SRC, file), 'utf8');
    assert.doesNotMatch(source, /import\s+\*\s+as\s+\w+\s+from\s+'\.\/store\.js'/, `${file} imports all of src/store.js`);
    const named = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/store\.js'/g)]
      .flatMap((m) => m[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    for (const writer of ['applyTransition', 'insertReport']) {
      assert.ok(!named.includes(writer), `${file} imports ${writer} from src/store.js`);
    }
  }
});

test('C-b: the second write of every two-statement action is tied to the stamp its first write made', () => {
  // A tripwire over the text; tests/work-races.test.mjs makes the race happen.
  const guards = WORK_SQL.match(/AND EXISTS \(SELECT 1 FROM reports WHERE [^)]*\)/g) || [];
  assert.ok(guards.length >= 7, `expected withdraw, review, heartbeat, release, submit, land and unland, found ${guards.length}`);
  for (const guard of guards) assert.match(guard, /\bwork_updated_at = \?/, `a second write is not tied to its first:\n${guard}`);
  const landing = WORK_SQL.match(/UPDATE work_runs SET landed_at = \?[\s\S]*?\)`/);
  assert.ok(landing, 'the landing UPDATE is missing');
  assert.match(landing[0], /needs_landing = 1 AND review = 'accepted'/);
});

test('the claim is not in the table as a move from claimed: expiry lives in the SQL guard', () => {
  // Written down because it reads like an omission. A claimed item is claimable again only
  // when its lease has passed, which the table cannot express and store-work-runner.js's
  // CLAIMABLE guard does. Adding `claimed` to claim's `from` here would let a live lease be
  // stolen.
  assert.equal(canAct('claim', 'claimed', 'ai'), false);
  assert.match(WORK_SQL, /work_state = 'claimed' AND work_lease_until < \?/);
});

test('a refusal to automation names the rule, not a state', () => {
  const r = refusal('approve', NONE, 'ai');
  assert.equal(r.code, 'BAD_TRANSITION');
  assert.match(r.message, /Only the operator/);
  const s = refusal('submit', 'review', 'ai');
  assert.equal(s.code, 'BAD_TRANSITION');
  assert.match(s.message, /"review" cannot take "submit"/);
});

test('a correction needs the operator\'s instruction and can never ship; an open item needs neither', () => {
  assert.equal(approvalRule(trustOf('open'), 'ship', ''), null);
  assert.equal(approvalRule(trustOf('open'), 'fix', ''), null);
  for (const kind of ['wrong', 'missing', 'broken', 'other']) {
    assert.equal(approvalRule(trustOf(kind), 'ship', 'A perfectly good instruction.').code, 'BAD_FIELD', `${kind} shipped`);
    assert.equal(approvalRule(trustOf(kind), 'fix', '').code, 'BAD_FIELD', `${kind} went over with no instruction`);
    assert.equal(approvalRule(trustOf(kind), 'fix', 'too short').code, 'BAD_FIELD', `${kind} took a nine character instruction`);
    assert.equal(approvalRule(trustOf(kind), 'investigate', 'Check whether the gloss is right.'), null);
  }
  assert.equal(trustOf('open'), 'fleet');
  assert.equal(trustOf('wrong'), 'stranger');
  assert.equal(trustOf('open', 'human'), 'fleet');
  assert.equal(trustOf('open', 'ai'), 'stranger', 'an item automation filed is trusted like the fleet\'s own');
});

test('what a result must look like for the mode it was claimed in', () => {
  const ref = [{ repo: 'balise-site', commit: 'abc1234' }];
  assert.equal(submitRule('investigate', { outcome: 'fixed', needs_landing: false, refs: [] }).code, 'BAD_FIELD');
  assert.equal(submitRule('investigate', { outcome: 'investigated', needs_landing: true, refs: ref }).code, 'BAD_FIELD');
  assert.equal(submitRule('investigate', { outcome: 'blocked', needs_landing: false, refs: [] }), null);
  assert.equal(submitRule('ship', { outcome: 'fixed', needs_landing: true, refs: ref }).code, 'BAD_FIELD');
  assert.equal(submitRule('ship', { outcome: 'fixed', needs_landing: false, refs: ref }), null);
  assert.equal(submitRule('fix', { outcome: 'fixed', needs_landing: true, refs: [] }).code, 'BAD_FIELD');
  assert.equal(submitRule('fix', { outcome: 'fixed', needs_landing: true, refs: ref }), null);
  assert.equal(submitRule('fix', { outcome: 'partial', needs_landing: false, refs: [] }), null);
});

test('an accepted result waits for landing only when it has something to land', () => {
  assert.equal(acceptTarget({ needs_landing: true }), 'accepted');
  assert.equal(acceptTarget({ needs_landing: false }), 'done');
  assert.equal(acceptTarget(null), 'done');
});

test('a list title prefers the published sentence and falls back in order', () => {
  assert.equal(titleFor({ public_note: 'Published.', suggested: 'Drafted.', work_instruction: 'Told.', body: 'Body.' }), 'Published.');
  assert.equal(titleFor({ public_note: '', suggested: 'Drafted.', work_instruction: 'Told.', body: 'Body.' }), 'Drafted.');
  assert.equal(titleFor({ public_note: '', suggested: '', work_instruction: '\n  Told.\nMore.', body: 'Body.' }), 'Told.');
  assert.equal(titleFor({ body: 'x'.repeat(300) }).length, 140);
  assert.equal(stateOf('bogus'), NONE);
  assert.equal(stateOf(null), NONE);
});

test('#64: a closed item is refused an approval, and the way on matches C4\'s edges out of its status', () => {
  assert.deepEqual(STATUSES.filter((s) => !CLOSED_STATUSES.includes(s)), ['new', 'triaged', 'accepted']);
  for (const status of ['new', 'triaged', 'accepted', 'bogus', null]) assert.equal(closedRule(status), null, `${status} was refused`);
  for (const status of CLOSED_STATUSES) {
    const rule = closedRule(status);
    assert.equal(rule.code, 'BAD_TRANSITION', status);
    for (const table of [TRANSITIONS, OPEN_TRANSITIONS]) {
      assert.deepEqual(table[status], status === 'fixed' ? [] : ['accepted'], `the hint for ${status} no longer matches C4`);
    }
    if (status === 'fixed') {
      assert.equal(rule.message, 'That item is resolved, so it cannot be handed to an agent.');
      assert.match(rule.hint, /new item under Work/);
      assert.doesNotMatch(rule.hint, /accepted|reopen/i, 'a resolved item was sent to an edge C4 does not have');
    } else {
      assert.equal(rule.message, `That item is closed as "${status}", so it cannot be handed to an agent.`);
      assert.equal(rule.hint, 'Reopen it first by moving it to accepted, then hand it to an agent.');
    }
  }
});

test('#64: both writes that could leave a closed item queued repeat their check inside the write', () => {
  // A tripwire over the text; tests/work-races.test.mjs lands each write inside the other.
  const listed = (term) => term.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  const approve = WORK_SQL.match(/UPDATE reports SET work_state = 'approved', work_mode[\s\S]*?`/);
  assert.ok(approve, 'the approve UPDATE is missing');
  const closed = approve[0].match(/\bWHERE\b[^`]*\bAND status NOT IN \(([^)]*)\)/);
  assert.ok(closed, `approve writes with no status term:\n${approve[0]}`);
  assert.deepEqual(listed(closed[1]), CLOSED_STATUSES);

  const store = readFileSync(join(SRC, 'store.js'), 'utf8');
  const term = store.match(/const OUT_OF_QUEUE = "AND \(work_state IS NULL OR work_state NOT IN \(([^)]*)\)\)";/);
  assert.ok(term, 'src/store.js has no OUT_OF_QUEUE term');
  assert.deepEqual(listed(term[1]), ACTIVE_STATES);
  assert.match(store, /const closing = CLOSED_STATUSES\.includes\(to\);/);
  assert.match(store, /WHERE id = \? AND status = \? \$\{closing \? OUT_OF_QUEUE : ''\}/, 'the closing UPDATE does not repeat the work queue check');
});
