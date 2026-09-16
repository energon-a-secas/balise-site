// The work routes' shape checks, and the pure rules beside them, with no database at all
// (docs/DESIGN-WORK-QUEUE.md section 5).
//
// Every refusal is tripped at its boundary: one step inside and one step outside. The D1
// suites only ever send well formed bodies, so a check deleted or loosened by a character
// here would otherwise leave every test green. Several of these values reach git on the
// runner's machine (a branch, a commit) or decide whether it pushes (landed, needs_landing),
// which is why a string "false" or a branch with a semicolon in it has a line of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateWorkList, validateApproval, validateDirectItem, validateClaim, validateHeartbeat,
  validateRelease, validateSubmit, validateReview, validateLand, WORK_REQUEST_MAX_BYTES,
  TEXT_MIN, TEXT_MAX, INSTRUCTION_MAX, SUMMARY_MAX, EVIDENCE_MAX, NOTE_MIN, NOTE_MAX, SUGGESTION_MAX, REFS_MAX, ID_MAX,
} from '../src/validate-work.js';
import { REQUEST_MAX_BYTES } from '../src/validate.js';
import { parseWorkPath } from '../src/routes-work.js';
import {
  ACTIVE_STATES, WORK_OUTCOMES, LEASE_MIN_S, LEASE_MAX_S, LEASE_DEFAULT_S, INSTRUCTION_MIN,
  approvalRule, submitRule, trustOf,
} from '../src/work.js';
import { cleanSuggestion } from '../src/store-work.js';
import { redactionFindings, stripRedactions } from '../src/redact.js';

const RUN = '1a2b3c4d-0000-4000-8000-000000000000';
const x = (n) => 'x'.repeat(n);
const code = (result) => result.code;
const list = (query) => validateWorkList(new URLSearchParams(query));
const submit = (over) => validateSubmit({ run: RUN, outcome: 'fixed', summary: 'Committed the fix.', ...over });

test('every work body that is not a JSON object is refused before a field is read', () => {
  const validators = [validateApproval, validateDirectItem, validateClaim, validateHeartbeat, validateRelease, validateSubmit, validateReview, validateLand];
  for (const validate of validators) {
    for (const body of [null, undefined, [], 'text', 42, true]) {
      assert.equal(code(validate(body)), 'BAD_FIELD', `${validate.name} took ${JSON.stringify(body)}`);
    }
  }
});

test('#50: a mode is one of the three, trimmed, so nothing ship-shaped gets past approvalRule', () => {
  for (const mode of ['Ship', 'SHIP', 'shipit', 'ship-it', 7, true, ['ship'], { mode: 'ship' }]) {
    assert.equal(code(validateApproval({ mode })), 'BAD_FIELD', `${JSON.stringify(mode)} passed as a mode`);
  }
  for (const mode of [undefined, null, '']) assert.equal(validateApproval({ mode }).value.mode, 'fix');
  const padded = validateApproval({ mode: ' ship ', instruction: '  Correct the gloss against the page itself.  ' }).value;
  assert.deepEqual(padded, { mode: 'ship', instruction: 'Correct the gloss against the page itself.' });
  const rule = approvalRule(trustOf('wrong'), padded.mode, padded.instruction);
  assert.equal(rule.code, 'BAD_FIELD', 'a trimmed ship slipped past the rule for a stranger\'s report');
  assert.match(rule.message, /ship mode/);

  assert.equal(validateApproval({ instruction: x(INSTRUCTION_MAX) }).value.instruction.length, INSTRUCTION_MAX);
  assert.equal(code(validateApproval({ instruction: x(INSTRUCTION_MAX + 1) })), 'BAD_FIELD');
  assert.equal(code(validateApproval({ instruction: 42 })), 'BAD_FIELD');
});

test('C-h: trust follows who filed the item, and a stranger\'s item needs ten characters of instruction and never ships', () => {
  for (const filedBy of [null, undefined, 'human']) assert.equal(trustOf('open', filedBy), 'fleet', `open filed by ${filedBy}`);
  assert.equal(trustOf('open', 'ai'), 'stranger');
  for (const kind of ['wrong', 'missing', 'broken', 'other']) {
    for (const filedBy of [null, 'human', 'ai']) assert.equal(trustOf(kind, filedBy), 'stranger', `${kind} filed by ${filedBy}`);
  }

  assert.equal(INSTRUCTION_MIN, 10);
  assert.equal(approvalRule('stranger', 'fix', x(INSTRUCTION_MIN - 1)).code, 'BAD_FIELD');
  assert.equal(approvalRule('stranger', 'fix', x(INSTRUCTION_MIN)), null);
  assert.equal(approvalRule('stranger', 'investigate', x(INSTRUCTION_MIN)), null);
  // Measured after trimming, so padding cannot stand in for words (#59).
  assert.equal(approvalRule('stranger', 'fix', ' '.repeat(12)).code, 'BAD_FIELD');
  assert.equal(approvalRule('stranger', 'fix', `   ${x(INSTRUCTION_MIN - 1)}   `).code, 'BAD_FIELD');
  assert.match(approvalRule('stranger', 'ship', x(200)).message, /ship mode/);
  assert.equal(approvalRule('fleet', 'ship', ''), null);
  // Anything but 'fleet' is held to the stranger's rule, so passing a kind by mistake fails closed.
  for (const trust of ['open', 'wrong', 'bogus', '', null, undefined]) {
    assert.equal(approvalRule(trust, 'ship', 'A perfectly good instruction.').code, 'BAD_FIELD', `trust ${trust} shipped`);
  }
});

test('#59: an investigation may end investigated, blocked or failed, and nothing else', () => {
  for (const outcome of ['investigated', 'blocked', 'failed']) {
    assert.equal(submitRule('investigate', { outcome, needs_landing: false, refs: [] }), null, outcome);
  }
  for (const outcome of ['fixed', 'partial']) {
    assert.equal(submitRule('investigate', { outcome, needs_landing: false, refs: [] }).code, 'BAD_FIELD', outcome);
  }
});

test('#59: a drafted sentence the strip cannot clear is dropped whole, never kept half clean', () => {
  // Nested deeper than the strip's passes reach: the cut leaves "line 5", a line number.
  const nested = 'line line line line line a/b 5 5 5 5 5';
  assert.notDeepEqual(redactionFindings(stripRedactions(nested)), [], 'the fixture no longer outlasts the strip');
  assert.equal(cleanSuggestion(nested), '');
  assert.equal(cleanSuggestion('The checker at enforce.py:612 is being reworked.'), 'The checker at is being reworked.');
  assert.equal(cleanSuggestion('See packages/neorgon-ui/beacon for the widget.'), 'See for the widget.');
  assert.equal(cleanSuggestion('  A clean\n\nsentence.  '), 'A clean sentence.');
  for (const empty of ['', null, undefined]) assert.equal(cleanSuggestion(empty), '');
  assert.ok(cleanSuggestion('word '.repeat(300)).length <= SUGGESTION_MAX);
});

test('#51: a claim names its runner in the accepted form, and asks for a lease inside the bounds', () => {
  for (const runner of [undefined, '   ', 7]) assert.equal(code(validateClaim({ runner })), 'MISSING_PARAM', JSON.stringify(runner));
  for (const runner of ['Mac', '-mac', 'mac_1', 'mac 1', 'mac.local', x(41)]) {
    assert.equal(code(validateClaim({ runner })), 'BAD_FIELD', runner);
  }
  for (const runner of ['mac', 'mac-1', '0', x(40)]) assert.equal(validateClaim({ runner }).value.runner, runner);

  assert.deepEqual([LEASE_MIN_S, LEASE_MAX_S], [5, 7200]);
  for (const lease of [LEASE_MIN_S - 1, LEASE_MAX_S + 1, 1e9, 5.5, -30, 0, 'abc']) {
    assert.equal(code(validateClaim({ runner: 'mac', lease_seconds: lease })), 'BAD_FIELD', `lease ${lease}`);
  }
  for (const lease of [LEASE_MIN_S, LEASE_MAX_S]) assert.equal(validateClaim({ runner: 'mac', lease_seconds: lease }).value.lease_seconds, lease);
  assert.equal(validateClaim({ runner: 'mac' }).value.lease_seconds, LEASE_DEFAULT_S);

  assert.equal(validateClaim({ runner: 'mac', id: x(ID_MAX) }).value.id, x(ID_MAX));
  assert.equal(code(validateClaim({ runner: 'mac', id: x(ID_MAX + 1) })), 'BAD_FIELD');
  assert.equal(code(validateClaim({ runner: 'mac', id: 42 })), 'BAD_FIELD');
  assert.equal(validateClaim({ runner: 'mac', id: '' }).value.id, null);
});

test('#51: every later runner action quotes a run id of a size this service hands out', () => {
  for (const validate of [validateHeartbeat, validateRelease, validateSubmit, validateLand]) {
    for (const run of [undefined, '   ', 42]) assert.equal(code(validate({ run })), 'MISSING_PARAM', `${validate.name} ${JSON.stringify(run)}`);
    assert.equal(code(validate({ run: x(ID_MAX + 1) })), 'BAD_FIELD', validate.name);
  }
  assert.equal(validateHeartbeat({ run: x(ID_MAX) }).value.run, x(ID_MAX));
  assert.equal(code(validateHeartbeat({ run: RUN, lease_seconds: LEASE_MAX_S + 1 })), 'BAD_FIELD');
  assert.equal(validateRelease({ run: RUN, note: x(NOTE_MAX) }).value.note.length, NOTE_MAX);
  assert.equal(code(validateRelease({ run: RUN, note: x(NOTE_MAX + 1) })), 'BAD_FIELD');
  assert.equal(code(validateRelease({ run: RUN, note: 5 })), 'BAD_FIELD');
});

test('#51: a result names a known outcome, carries a summary, keeps each text under its cap, and says needs_landing with a boolean', () => {
  assert.equal(code(submit({ outcome: undefined })), 'MISSING_PARAM');
  assert.equal(code(submit({ outcome: 'done' })), 'BAD_FIELD');
  assert.deepEqual(WORK_OUTCOMES, ['fixed', 'investigated', 'partial', 'blocked', 'failed']);
  for (const outcome of WORK_OUTCOMES) assert.equal(submit({ outcome }).value.outcome, outcome);

  for (const summary of [undefined, ' \n ']) assert.equal(code(submit({ summary })), 'MISSING_PARAM');
  assert.equal(submit({ summary: x(SUMMARY_MAX) }).value.summary.length, SUMMARY_MAX);
  assert.equal(code(submit({ summary: x(SUMMARY_MAX + 1) })), 'BAD_FIELD');
  assert.equal(submit({ evidence: x(EVIDENCE_MAX) }).value.evidence.length, EVIDENCE_MAX);
  assert.equal(code(submit({ evidence: x(EVIDENCE_MAX + 1) })), 'BAD_FIELD');
  assert.equal(code(submit({ evidence: ['ran it'] })), 'BAD_FIELD');
  assert.equal(submit({ suggested_note: x(SUGGESTION_MAX) }).value.suggested_note.length, SUGGESTION_MAX);
  assert.equal(code(submit({ suggested_note: x(SUGGESTION_MAX + 1) })), 'BAD_FIELD');

  for (const needs of ['true', 'false', 1, 0, null]) assert.equal(code(submit({ needs_landing: needs })), 'BAD_FIELD', JSON.stringify(needs));
  assert.equal(submit({ needs_landing: true }).value.needs_landing, true);
  assert.equal(submit({}).value.needs_landing, false);
});

test('#51: refs are an array of at most twenty, each naming a repo and a branch or commit in a form git cannot misread', () => {
  const ref = { repo: 'balise-site', branch: 'balise/abcd1234-a1', commit: 'abc1234' };
  const refs = (value) => submit({ refs: value });
  for (const empty of [undefined, null]) assert.deepEqual(refs(empty).value.refs, []);
  for (const value of [{}, 'balise-site', 7]) assert.equal(code(refs(value)), 'BAD_FIELD', JSON.stringify(value));
  assert.equal(refs(Array(REFS_MAX).fill(ref)).value.refs.length, REFS_MAX);
  assert.equal(code(refs(Array(REFS_MAX + 1).fill(ref))), 'BAD_FIELD');

  for (const bad of [
    'balise-site', null, ['balise-site'], { commit: 'abc1234' }, { repo: 'balise-site' }, { repo: 'balise-site', branch: '', commit: '' },
    { ...ref, repo: 'balise site' }, { ...ref, repo: '../balise-site' }, { ...ref, repo: x(101) },
    { ...ref, branch: 'balise/a b' }, { ...ref, branch: 'main;rm -rf ~' }, { ...ref, branch: '--upload-pack=touch' }, { ...ref, branch: x(121) },
    { ...ref, commit: 'abc123' }, { ...ref, commit: 'ghijklm' }, { ...ref, commit: 'a'.repeat(41) },
  ]) {
    assert.equal(code(refs([bad])), 'BAD_FIELD', JSON.stringify(bad));
  }
  assert.deepEqual(refs([{ repo: ' balise-site ', commit: 'ABC1234' }]).value.refs, [{ repo: 'balise-site', commit: 'abc1234' }]);
  assert.equal(refs([{ repo: x(100), branch: x(120), commit: 'f'.repeat(40) }]).value.refs.length, 1);
});

test('#51: a review decides one of three and a return says why; a landing says whether it landed with a real boolean', () => {
  assert.equal(code(validateReview({})), 'MISSING_PARAM');
  for (const decision of ['approve', 'Accept', 'land']) assert.equal(code(validateReview({ decision })), 'BAD_FIELD', decision);
  for (const decision of ['accept', 'dismiss']) assert.deepEqual(validateReview({ decision }).value, { decision, note: '' });
  assert.equal(code(validateReview({ decision: 'return' })), 'BAD_FIELD');
  assert.equal(code(validateReview({ decision: 'return', note: `  ${x(NOTE_MIN - 1)}  ` })), 'BAD_FIELD');
  assert.equal(validateReview({ decision: 'return', note: x(NOTE_MIN) }).value.note, x(NOTE_MIN));
  assert.equal(code(validateReview({ decision: 'accept', note: x(NOTE_MAX + 1) })), 'BAD_FIELD');

  // A string "false" is truthy, so taking one would land a landing that failed.
  for (const landed of ['false', 'true', 0, 1, null, undefined]) {
    assert.equal(code(validateLand({ run: RUN, landed, note: 'Main moved.' })), 'MISSING_PARAM', JSON.stringify(landed));
  }
  assert.equal(code(validateLand({ run: RUN, landed: false })), 'BAD_FIELD');
  assert.equal(code(validateLand({ run: RUN, landed: false, note: x(NOTE_MIN - 1) })), 'BAD_FIELD');
  assert.equal(validateLand({ run: RUN, landed: false, note: x(NOTE_MIN) }).value.landed, false);
  assert.deepEqual(validateLand({ run: RUN, landed: true }).value, { run: RUN, landed: true, refs: [], note: '' });
  assert.equal(code(validateLand({ run: RUN, landed: true, refs: [{ repo: 'balise-site', commit: 'nope' }] })), 'BAD_FIELD');
  assert.equal(code(validateLand({ run: RUN, landed: true, note: x(NOTE_MAX + 1) })), 'BAD_FIELD');
});

test('#51: a filed item is ten to four thousand characters, and its approval block is checked like any approval', () => {
  for (const text of [undefined, '', '   ', 42]) assert.equal(code(validateDirectItem({ text })), 'MISSING_PARAM', JSON.stringify(text));
  assert.equal(code(validateDirectItem({ text: x(TEXT_MIN - 1) })), 'BAD_FIELD');
  assert.equal(validateDirectItem({ text: `  ${x(TEXT_MIN)}  ` }).value.text, x(TEXT_MIN));
  assert.equal(validateDirectItem({ text: x(TEXT_MAX) }).value.text.length, TEXT_MAX);
  assert.equal(code(validateDirectItem({ text: x(TEXT_MAX + 1) })), 'BAD_FIELD');

  const item = (over) => validateDirectItem({ text: 'Write the release checklist.', ...over });
  assert.equal(code(item({ suggested: x(SUGGESTION_MAX + 1) })), 'BAD_FIELD');
  assert.equal(code(item({ suggested: 5 })), 'BAD_FIELD');
  assert.equal(item({}).value.approve, null);
  assert.deepEqual(item({ approve: {} }).value.approve, { mode: 'fix', instruction: '' });
  assert.equal(code(item({ approve: { mode: 'Ship' } })), 'BAD_FIELD');
  assert.equal(code(item({ approve: 'ship' })), 'BAD_FIELD');
});

test('C-d: GET /work takes a state, a limit from 1 to 50, and only the "<updated_at>:<id>" cursor it hands out', () => {
  assert.deepEqual(list('').value, { states: ACTIVE_STATES, limit: 25, before: null });
  assert.deepEqual(list('state=active').value.states, ACTIVE_STATES);
  assert.deepEqual(list('state=done').value.states, ['done']);
  assert.equal(code(list('state=finished')), 'BAD_FIELD');
  for (const limit of ['0', '51', '2.5', 'abc', '-1']) assert.equal(code(list(`limit=${limit}`)), 'BAD_FIELD', limit);
  for (const limit of [1, 50]) assert.equal(list(`limit=${limit}`).value.limit, limit);

  const next = `1757000000000:${RUN}`;
  for (const sent of [encodeURIComponent(next), next]) {
    assert.deepEqual(list(`before=${sent}`).value.before, { updatedAt: 1757000000000, id: RUN });
  }
  // The bare number this route used to take is refused, not read as a time with no tiebreak.
  for (const before of [
    '1757000000000', 'abc', '1757000000000:', `:${RUN}`, `-1:${RUN}`, `1.5:${RUN}`,
    `12345678901234567:${RUN}`, `9007199254740993:${RUN}`, `1:${x(ID_MAX + 1)}`,
  ]) {
    assert.equal(code(list(`before=${encodeURIComponent(before)}`)), 'BAD_FIELD', before);
  }
  assert.equal(list(`before=${encodeURIComponent(`1:${x(ID_MAX)}`)}`).value.before.id, x(ID_MAX));
});

test('#51: each work path is a route under one method, and anything else, an unreadable or over-long id included, is a hint', () => {
  assert.deepEqual(parseWorkPath('/work', 'GET'), { route: 'list' });
  assert.deepEqual(parseWorkPath('/work/items', 'POST'), { route: 'items' });
  assert.deepEqual(parseWorkPath('/work/claim', 'POST'), { route: 'claim' });
  assert.deepEqual(parseWorkPath('/work/abc', 'GET'), { route: 'detail', id: 'abc' });
  assert.deepEqual(parseWorkPath('/work/a%20b', 'GET'), { route: 'detail', id: 'a b' });
  assert.deepEqual(parseWorkPath(`/work/${x(ID_MAX)}`, 'GET'), { route: 'detail', id: x(ID_MAX) });
  for (const action of ['approve', 'withdraw', 'heartbeat', 'release', 'submit', 'review', 'land']) {
    assert.deepEqual(parseWorkPath(`/work/abc/${action}`, 'POST'), { route: action, id: 'abc' });
    assert.match(parseWorkPath(`/work/abc/${action}`, 'GET').hint, new RegExp(`POST /work/:id/${action}`));
  }
  for (const [path, method] of [
    ['/work', 'POST'], ['/work/items', 'GET'], ['/work/claim', 'GET'], ['/work/abc', 'POST'], ['/work/abc', 'PATCH'],
    ['/work/abc/claim', 'POST'], ['/work/abc/explode', 'POST'], ['/work/abc/approve/now', 'POST'], ['/work/abc/Approve', 'POST'],
    ['/work/%E0%A4%A', 'GET'], ['/work/%E0%A4%A/approve', 'POST'], [`/work/${x(ID_MAX + 1)}`, 'GET'],
  ]) {
    const out = parseWorkPath(path, method);
    assert.equal(out.route, undefined, `${method} ${path} became a route`);
    assert.ok(out.hint, `${method} ${path} has no hint`);
  }
  assert.match(parseWorkPath('/work/%E0%A4%A', 'GET').hint, /could not be read/);
});

test('C-l: a work body may be 64 KB, every other route stops at 8 KB, and a submit at every cap fits between the two', () => {
  assert.equal(REQUEST_MAX_BYTES, 8 * 1024);
  assert.equal(WORK_REQUEST_MAX_BYTES, 64 * 1024);
  // Every character JSON escapes to six bytes, and every field sits at its cap.
  const worst = (n) => ''.repeat(n);
  const body = {
    run: x(ID_MAX),
    outcome: 'investigated',
    summary: worst(SUMMARY_MAX),
    evidence: worst(EVIDENCE_MAX),
    suggested_note: worst(SUGGESTION_MAX),
    needs_landing: false,
    refs: Array.from({ length: REFS_MAX }, () => ({ repo: x(100), branch: x(120), commit: 'f'.repeat(40) })),
  };
  assert.equal(code(validateSubmit(body)), undefined, 'the worst-case body is not one the validator accepts');
  const bytes = Buffer.byteLength(JSON.stringify(body));
  assert.ok(bytes > REQUEST_MAX_BYTES && bytes <= WORK_REQUEST_MAX_BYTES, `a submit at every cap is ${bytes} bytes`);
});
