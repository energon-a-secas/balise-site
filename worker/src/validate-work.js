// Shape checks for the work queue's routes (docs/DESIGN-WORK-QUEUE.md section 5).
//
// Split from src/validate.js, which owns C1 and the import route and was already most of
// the way to the fleet's 500 line cap. Same contract as that file: each function returns
// { value } or a ready made { code, message, hint }, throws nothing, and touches neither
// the network nor the database.
//
// The rules that depend on the ROW are not here. A stranger's item cannot ship, an
// investigation lands nothing, only the lease holder may submit: each of those needs the
// row's kind, who filed it, or the run it holds, which only the store has read. The first
// two live in src/work.js and the lease check in src/store-work.js, and they are applied in
// src/store-work.js (approve) and src/store-work-runner.js (submit). This file only decides
// whether a body is well formed, and how large a work body may be.

import {
  WORK_STATES, ACTIVE_STATES, WORK_MODES, DEFAULT_MODE, WORK_OUTCOMES,
  LEASE_DEFAULT_S, LEASE_MIN_S, LEASE_MAX_S,
} from './work.js';

export const TEXT_MIN = 10;
export const TEXT_MAX = 4000;
export const INSTRUCTION_MAX = 2000;
export const SUMMARY_MAX = 4000;
export const EVIDENCE_MAX = 4000;
export const NOTE_MIN = 3;
export const NOTE_MAX = 2000;
export const SUGGESTION_MAX = 500;
export const REFS_MAX = 20;
export const ID_MAX = 64;

/**
 * The largest body a POST /work route reads, in bytes. Every other route stops at 8 KB, and
 * the caps above do not fit in that: a summary and evidence at their limits are 8 KB before
 * JSON has escaped a single newline, and a submit refused at the door after passing every
 * field check leaves the runner no rule to trim by. 64 KB holds the largest body those caps
 * allow even with every character escaped to six bytes.
 */
export const WORK_REQUEST_MAX_BYTES = 64 * 1024;

const RUNNER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const DECISIONS = ['accept', 'return', 'dismiss'];

const bad = (message, hint) => ({ code: 'BAD_FIELD', message, hint });
const missing = (message, hint) => ({ code: 'MISSING_PARAM', message, hint });
const isStr = (x) => typeof x === 'string';
const isObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

const notAnObject = (shape) => bad('The request body was not a JSON object.', `Send ${shape}.`);

/** An optional text field, trimmed and capped. Absent reads as ''. */
function textField(value, field, max, hint) {
  if (value === undefined || value === null) return { value: '' };
  if (!isStr(value)) return bad(`${field} has to be text.`, hint);
  const trimmed = value.trim();
  if (trimmed.length > max) return bad(`${field} is ${trimmed.length} characters and the limit is ${max}.`, hint);
  return { value: trimmed };
}

/** The run id a lease holder quotes. Required on every action a runner takes after claim. */
function runField(value) {
  const run = isStr(value) ? value.trim() : '';
  if (!run) {
    return missing('No run id was sent.', 'Send the run id the claim handed back. It is how the Worker knows this is the lease holder.');
  }
  if (run.length > ID_MAX) return bad('That run id is longer than any this service hands out.', 'Send it exactly as the claim returned it.');
  return { value: run };
}

function leaseField(value) {
  if (value === undefined || value === null) return { value: LEASE_DEFAULT_S };
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < LEASE_MIN_S || seconds > LEASE_MAX_S) {
    return bad(
      `lease_seconds has to be a whole number from ${LEASE_MIN_S} to ${LEASE_MAX_S}.`,
      `Leave it out for ${LEASE_DEFAULT_S}, and heartbeat during long work rather than asking for a long lease.`,
    );
  }
  return { value: seconds };
}

/** [{ repo, branch?, commit? }], what a result says to look at or to land. */
function refsField(value) {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return bad('refs has to be an array.', 'Send [{ "repo": "balise-site", "commit": "abc1234" }].');
  if (value.length > REFS_MAX) {
    return bad(`refs carries ${value.length} entries and the limit is ${REFS_MAX}.`, 'Name each repository once, with its newest commit.');
  }
  const refs = [];
  for (const raw of value) {
    if (!isObject(raw)) return bad('A ref was not an object.', 'Each ref is { repo, branch?, commit? }.');
    const repo = isStr(raw.repo) ? raw.repo.trim() : '';
    const branch = isStr(raw.branch) ? raw.branch.trim() : '';
    const commit = isStr(raw.commit) ? raw.commit.trim().toLowerCase() : '';
    if (!REPO_RE.test(repo)) return bad('A ref names no repository, or one in a form this service does not accept.', 'A repo is its directory name, like balise-site.');
    if (branch && !BRANCH_RE.test(branch)) return bad(`The branch on ${repo} is not in a form this service accepts.`, 'Letters, digits, dots, dashes, underscores and slashes.');
    if (commit && !COMMIT_RE.test(commit)) return bad(`The commit on ${repo} is not a hex sha.`, 'Send 7 to 40 hex characters.');
    if (!branch && !commit) return bad(`The ref for ${repo} has neither a branch nor a commit.`, 'Send at least one, so the result says what to look at.');
    refs.push({ repo, ...(branch ? { branch } : {}), ...(commit ? { commit } : {}) });
  }
  return { value: refs };
}

/** `<work_updated_at>:<id>`, the only cursor GET /work hands back. */
const CURSOR_RE = /^(\d{1,16}):(.+)$/;

/** GET /work's query. `before` is the keyset cursor the last page handed back as `next`,
 *  never an OFFSET (A4). It carries the id because work_updated_at alone ties: two requests
 *  in one millisecond stamp the same value, and a page break between them lost one. */
export function validateWorkList(params) {
  const raw = (params.get('state') || '').trim();
  let states;
  if (!raw || raw === 'active') states = ACTIVE_STATES;
  else if (WORK_STATES.includes(raw)) states = [raw];
  else return bad(`"${raw}" is not a work state.`, `The states are ${WORK_STATES.join(', ')}, or active for everything but done.`);

  const rawLimit = (params.get('limit') || '').trim();
  let limit = 25;
  if (rawLimit) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return bad('The limit has to be a whole number from 1 to 50.', 'Drop the limit parameter to get the default page of 25.');
    }
  }

  const rawBefore = (params.get('before') || '').trim();
  let before = null;
  if (rawBefore) {
    const match = CURSOR_RE.exec(rawBefore);
    const updatedAt = match ? Number(match[1]) : NaN;
    if (!match || !Number.isSafeInteger(updatedAt) || match[2].length > ID_MAX) {
      return bad(
        'The cursor is not one this service handed back.',
        'Send next back exactly as it came, URL encoded, or drop the before parameter to start again from the newest change.',
      );
    }
    before = { updatedAt, id: match[2] };
  }
  return { value: { states, limit, before } };
}

/** POST /work/:id/approve, and the optional approve block of POST /work/items. */
export function validateApproval(value) {
  if (!isObject(value)) return notAnObject('{ "mode": "fix", "instruction": "..." }');
  const rawMode = value.mode === undefined || value.mode === null || value.mode === '' ? DEFAULT_MODE : value.mode;
  const mode = isStr(rawMode) ? rawMode.trim() : '';
  if (!WORK_MODES.includes(mode)) {
    return bad(`${JSON.stringify(rawMode)} is not a work mode.`, `The modes are ${WORK_MODES.join(', ')}. Leave it out for ${DEFAULT_MODE}.`);
  }
  const instruction = textField(value.instruction, 'The instruction', INSTRUCTION_MAX, 'Say what should be done in a few sentences.');
  if (instruction.code) return instruction;
  return { value: { mode, instruction: instruction.value } };
}

/** POST /work/items: { text, suggested?, approve? }. */
export function validateDirectItem(value) {
  if (!isObject(value)) return notAnObject('{ "text": "what needs doing" }');
  const text = isStr(value.text) ? value.text.trim() : '';
  if (!text) return missing('The item has no text.', 'Say what needs doing. It stays private until someone publishes a sentence about it.');
  if (text.length < TEXT_MIN) return bad(`The item is ${text.length} characters and needs at least ${TEXT_MIN}.`, 'Add enough that someone reading it later knows what was meant.');
  if (text.length > TEXT_MAX) return bad(`The item is ${text.length} characters and the limit is ${TEXT_MAX}.`, 'Trim it, or split it into two items.');

  const suggested = textField(value.suggested, 'The suggested sentence', SUGGESTION_MAX, 'One sentence, or leave it out.');
  if (suggested.code) return suggested;

  let approve = null;
  if (value.approve !== undefined && value.approve !== null) {
    const checked = validateApproval(value.approve);
    if (checked.code) return checked;
    approve = checked.value;
  }
  return { value: { text, suggested: suggested.value, approve } };
}

/** POST /work/claim: { runner, id?, lease_seconds? }. */
export function validateClaim(value) {
  if (!isObject(value)) return notAnObject('{ "runner": "mac" }');
  const runner = isStr(value.runner) ? value.runner.trim() : '';
  if (!runner) return missing('The claim did not name its runner.', 'Send a short runner name, like mac. It is how a result says where it came from.');
  if (!RUNNER_RE.test(runner)) return bad('The runner name is not in the form this service accepts.', 'Lowercase letters, digits and hyphens, up to 40 characters.');

  let id = null;
  if (value.id !== undefined && value.id !== null && value.id !== '') {
    if (!isStr(value.id) || value.id.trim().length > ID_MAX) return bad('The id to claim is not one this service hands out.', 'Send the item id from GET /work, or leave it out to take the oldest approval.');
    id = value.id.trim();
  }
  const lease = leaseField(value.lease_seconds);
  if (lease.code) return lease;
  return { value: { runner, id, lease_seconds: lease.value } };
}

export function validateHeartbeat(value) {
  if (!isObject(value)) return notAnObject('{ "run": "..." }');
  const run = runField(value.run);
  if (run.code) return run;
  const lease = leaseField(value.lease_seconds);
  if (lease.code) return lease;
  return { value: { run: run.value, lease_seconds: lease.value } };
}

export function validateRelease(value) {
  if (!isObject(value)) return notAnObject('{ "run": "..." }');
  const run = runField(value.run);
  if (run.code) return run;
  const note = textField(value.note, 'The note', NOTE_MAX, 'Say briefly why the item went back, or leave it out.');
  if (note.code) return note;
  return { value: { run: run.value, note: note.value } };
}

/** POST /work/:id/submit. The mode rules come after this, in src/work.js submitRule. */
export function validateSubmit(value) {
  if (!isObject(value)) return notAnObject('{ "run": "...", "outcome": "fixed", "summary": "..." }');
  const run = runField(value.run);
  if (run.code) return run;

  const outcome = isStr(value.outcome) ? value.outcome.trim() : '';
  if (!outcome) return missing('The result has no outcome.', `Send one of ${WORK_OUTCOMES.join(', ')}.`);
  if (!WORK_OUTCOMES.includes(outcome)) return bad(`"${outcome}" is not an outcome.`, `The outcomes are ${WORK_OUTCOMES.join(', ')}.`);

  const summary = isStr(value.summary) ? value.summary.trim() : '';
  if (!summary) return missing('The result has no summary.', 'Say what was done and what is still open. The operator reads this before anything else.');
  if (summary.length > SUMMARY_MAX) return bad(`The summary is ${summary.length} characters and the limit is ${SUMMARY_MAX}.`, 'Keep what the operator needs to decide; the commits carry the rest.');

  const evidence = textField(value.evidence, 'The evidence', EVIDENCE_MAX, 'The commands that ran and what they said, trimmed to the lines that matter.');
  if (evidence.code) return evidence;
  const refs = refsField(value.refs);
  if (refs.code) return refs;

  if (value.needs_landing !== undefined && typeof value.needs_landing !== 'boolean') {
    return bad('needs_landing has to be true or false.', 'Send true only for a fix that is committed and not yet landed.');
  }
  const suggested = textField(value.suggested_note, 'The suggested sentence', SUGGESTION_MAX, 'One sentence for the board, or leave it out.');
  if (suggested.code) return suggested;

  return {
    value: {
      run: run.value,
      outcome,
      summary,
      evidence: evidence.value,
      refs: refs.value,
      needs_landing: value.needs_landing === true,
      suggested_note: suggested.value,
    },
  };
}

/** POST /work/:id/review: { decision, note? }. A return needs a note. */
export function validateReview(value) {
  if (!isObject(value)) return notAnObject('{ "decision": "accept" }');
  const decision = isStr(value.decision) ? value.decision.trim() : '';
  if (!decision) return missing('The review has no decision.', `Send one of ${DECISIONS.join(', ')}.`);
  if (!DECISIONS.includes(decision)) return bad(`"${decision}" is not a review decision.`, `The decisions are ${DECISIONS.join(', ')}.`);
  const note = textField(value.note, 'The note', NOTE_MAX, 'A few sentences at most.');
  if (note.code) return note;
  if (decision === 'return' && note.value.length < NOTE_MIN) {
    return bad('A returned result needs a note.', 'Say what to do differently. Without one, the next attempt repeats this one.');
  }
  return { value: { decision, note: note.value } };
}

/** POST /work/:id/land: { run, landed, refs?, note? }. A failed landing needs a note. */
export function validateLand(value) {
  if (!isObject(value)) return notAnObject('{ "run": "...", "landed": true }');
  const run = runField(value.run);
  if (run.code) return run;
  if (typeof value.landed !== 'boolean') {
    return missing('The landing did not say whether it landed.', 'Send landed: true once the change is pushed, or false with a note saying why not.');
  }
  const refs = refsField(value.refs);
  if (refs.code) return refs;
  const note = textField(value.note, 'The note', NOTE_MAX, 'A few sentences at most.');
  if (note.code) return note;
  if (!value.landed && note.value.length < NOTE_MIN) {
    return bad('A landing that failed needs a note.', 'Say what stopped it, for example a branch that no longer fast-forwards.');
  }
  return { value: { run: run.value, landed: value.landed, refs: refs.value, note: note.value } };
}
