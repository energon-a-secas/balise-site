// The work queue's SQL, half one: the reads, filing an item, and the operator's actions.
// The runner's actions (claim, heartbeat, release, submit, land) are the other half, in
// src/store-work-runner.js. The queue was split in two by WHO ACTS when one file passed the
// fleet's 500 line cap, and that is also the line a reviewer most wants drawn: everything a
// person decides is here, everything automation may do is there. With src/store.js and
// src/store-open.js, these are the four files in this Worker that contain SQL.
//
// Every action has the same three steps, for the reason src/store.js gives on
// applyTransition:
//
//   1. read the row (and its run) and decide against src/work.js's table;
//   2. write with a GUARD that repeats what was decided on (`AND work_state = ?`, and for a
//      lease holder `AND work_run = ?`), so a row that moved in between matches nothing
//      and the caller hears BAD_TRANSITION rather than winning a move that was never legal;
//   3. answer with the item as it now stands.
//
// A step that writes two rows is ONE db.batch(). D1 runs a batch as a single transaction
// and rolls it back whole if a statement fails (D1 Worker API reference, cited in the
// design). The second statement is conditioned with EXISTS on the state the first one
// PRODUCED, on the `work_updated_at` it stamped (the same `now`, bound again), and on its
// own row still being open. The stamp is what ties the second write to the first: the
// state alone let a refused request still write its half whenever another request had
// already produced that state, a return racing a withdraw and a fresh approval being one.
//
// Query budget (A4): claim is the heaviest action, one batch of five statements and the two
// reads of its answer, seven in all and nine with the lockout's two in src/store.js, against
// D1's fifty per invocation. Every reports lookup sits on an index, and a query that uses one
// of the partial indexes from migrations/0003_work.sql repeats its condition
// (`work_state IS NOT NULL`, or `work_run = ?`) so SQLite can prove it may use it.

import { sha256Hex, storeError, normaliseForFingerprint } from './store.js';
import { STATUSES } from './transitions.js';
import { OPEN_KIND } from './store-open.js';
import { cleanSuggestion } from './suggestion.js';
import {
  WORK_STATES, MAX_ATTEMPTS, NONE, stateOf, canAct, refusal, closedRule, approvalRule, acceptTarget, trustOf, titleFor,
} from './work.js';

/** The source of an item filed straight into the queue rather than imported. Not in the
 *  importer's source list, so no import or sync call can write or close one. */
export const DIRECT_SOURCE = 'direct';

const RUNS_SHOWN = 10;

// ── Columns and shapes ────────────────────────────────────────────────────────
//
// `contact`, `ip_hash` and `fingerprint` are in none of these. A runner has no use for a
// reader's address, and no work response carries one (design section 3, rule 4).

// The newest note a person wrote when sending a result back, from any run of the item. It
// is a correlated read on work_runs_report inside the item's own SELECT, so a list stays one
// query, and a card still says why the last attempt went back while the next one runs.
const LAST_REVIEW_NOTE = `(SELECT n.review_note FROM work_runs n
    WHERE n.report_id = r.id AND n.review_note IS NOT NULL AND n.review_note <> ''
    ORDER BY n.claimed_at DESC LIMIT 1) AS last_review_note`;

const ITEM_COLUMNS = `r.id, r.kind, r.status, r.site, r.source, r.source_ref, r.public_note, r.suggested,
  r.body, r.filed_by, r.work_state, r.work_mode, r.work_instruction, r.work_run, r.work_attempts,
  r.work_lease_until, r.work_approved_at, r.work_updated_at, ${LAST_REVIEW_NOTE}`;

const DETAIL_COLUMNS = `${ITEM_COLUMNS}, r.url, r.target_kind, r.target_id, r.target_label, r.opened_at, r.source_closed_at`;

const RUN_FIELDS = [
  'id', 'attempt', 'runner', 'mode', 'instruction', 'claimed_at', 'heartbeat_at', 'lease_until', 'ended_at',
  'end_reason', 'outcome', 'summary', 'evidence', 'refs', 'needs_landing', 'suggested_note', 'review',
  'review_note', 'reviewed_at', 'landed_at', 'land_note',
];
const RUN_COLUMNS = RUN_FIELDS.join(', ');
const RUN_JOINED = RUN_FIELDS.map((f) => `w.${f} AS run_${f}`).join(', ');

const FROM_JOINED = 'FROM reports r LEFT JOIN work_runs w ON w.id = r.work_run';

/** Chosen from this map and never from a request, because the value reaches a WHERE. */
const DETAIL_KEYS = { id: 'r.id = ?', run: 'r.work_run = ?' };

function parseRefs(raw) {
  if (!raw) return [];
  try {
    const refs = JSON.parse(raw);
    return Array.isArray(refs) ? refs : [];
  } catch {
    return [];
  }
}

function toRun(row, { withInstruction = false } = {}) {
  if (!row || !row.id) return null;
  return {
    id: row.id,
    attempt: row.attempt,
    runner: row.runner,
    mode: row.mode,
    ...(withInstruction ? { instruction: row.instruction || '' } : {}),
    claimed_at: row.claimed_at,
    heartbeat_at: row.heartbeat_at,
    lease_until: row.lease_until,
    ended_at: row.ended_at || null,
    end_reason: row.end_reason || null,
    outcome: row.outcome || null,
    summary: row.summary || '',
    evidence: row.evidence || '',
    refs: parseRefs(row.refs),
    needs_landing: row.needs_landing === 1,
    suggested_note: row.suggested_note || '',
    review: row.review || null,
    review_note: row.review_note || '',
    reviewed_at: row.reviewed_at || null,
    landed_at: row.landed_at || null,
    land_note: row.land_note || '',
  };
}

function joinedRun(row) {
  if (!row.run_id) return null;
  const run = {};
  for (const field of RUN_FIELDS) run[field] = row[`run_${field}`];
  return toRun(run);
}

function toItem(row, run) {
  const state = stateOf(row.work_state);
  return {
    id: row.id,
    kind: row.kind,
    status: STATUSES.includes(row.status) ? row.status : 'new',
    site: row.site,
    source: row.source || null,
    source_ref: row.source_ref || null,
    title: titleFor(row),
    public_note: row.public_note || '',
    trust: trustOf(row.kind, row.filed_by),
    last_review_note: row.last_review_note || '',
    work: state === NONE ? null : {
      state,
      mode: row.work_mode || null,
      instruction: row.work_instruction || '',
      attempts: row.work_attempts || 0,
      max_attempts: MAX_ATTEMPTS,
      approved_at: row.work_approved_at || null,
      updated_at: row.work_updated_at || null,
      lease_until: state === 'claimed' ? row.work_lease_until || null : null,
      run,
    },
  };
}

// ── Answers both halves share ─────────────────────────────────────────────────

export const notFound = () => ({
  code: 'NOT_FOUND',
  message: 'There is no item with that id.',
  hint: 'Reload the queue: it may have been withdrawn or merged into another item.',
});

const lostLease = () => ({
  code: 'BAD_TRANSITION',
  message: 'This run no longer holds that item.',
  hint: 'Its lease ran out and another run took it, or the operator withdrew it. Stop working on it and claim again.',
});

// The claim's sweep ends a lapsed last attempt and puts its row back at approved without
// touching work_run, so the run it ended still matches its own id. Told only the state, it
// would hear that approved takes a claim, which is the one move the attempt cap refuses.
const lapsedAtCap = () => ({
  code: 'BAD_TRANSITION',
  message: 'This run\'s lease ran out on the item\'s last attempt, so the item went back to the operator.',
  hint: 'Stop working on it. It needs a person now: the operator withdraws it and approves it again, usually with a new instruction.',
});

const inFlight = () => ({
  code: 'BAD_TRANSITION',
  message: 'That item moved while this change was in flight.',
  hint: 'Reload the queue and look at where it is now before deciding again.',
});

export const changed = (res) => Boolean(res && res.meta && res.meta.changes > 0);

/** The row and the fields of its current run that a rule reads. */
export function readRow(db, id) {
  return db
    .prepare(
      `SELECT r.id, r.kind, r.status, r.filed_by, r.work_state, r.work_mode, r.work_run, r.work_attempts, r.work_lease_until,
              w.mode AS run_mode, w.needs_landing AS run_needs_landing, w.ended_at AS run_ended_at, w.end_reason AS run_end_reason
         ${FROM_JOINED} WHERE r.id = ?`,
    )
    .bind(id)
    .first();
}

/**
 * Why a lease holder's action was refused, from the row as it stands. A run whose id no
 * longer matches, or whose item left the queue, has lost its lease; a run that still
 * matches but the sweep ended ran out on its last attempt, while the item is still at the
 * cap; anything else is a state that does not allow the action. A run that released its
 * item keeps the state answer, and so does a swept run once the operator withdraws the item
 * and approves it again: neither step touches work_run, and the fresh count makes it
 * claimable, so "it needs a person" would no longer be true.
 */
export function holderRefusal(row, run, action, actor) {
  const from = stateOf(row.work_state);
  if (row.work_run !== run || from === NONE) return lostLease();
  if (row.run_ended_at && row.run_end_reason === 'expired' && row.work_attempts >= MAX_ATTEMPTS) return lapsedAtCap();
  return canAct(action, from, actor) ? null : refusal(action, from, actor);
}

export async function explain(db, id, run, action, actor) {
  let row;
  try {
    row = await readRow(db, id);
  } catch (err) {
    return storeError('work explain', err);
  }
  if (!row) return notFound();
  return holderRefusal(row, run, action, actor) || inFlight();
}

export async function workItem(db, id) {
  try {
    const row = await db.prepare(`SELECT ${ITEM_COLUMNS}, ${RUN_JOINED} ${FROM_JOINED} WHERE r.id = ?`).bind(id).first();
    return row ? { item: toItem(row, joinedRun(row)) } : notFound();
  } catch (err) {
    return storeError('work item', err);
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * The keyset term for a page after the first, with the id breaking ties on the time. The
 * `<=` bound adds nothing the OR does not already say: it is there because SQLite cannot
 * seek an index on an OR, and without it every page walks down past every newer row of its
 * state before it reaches its own (measured on 20,000 rows of one state: a deep page of 25
 * walked 19,827 rows without the bound and 29 with it).
 */
const CURSOR_TERM = 'AND r.work_updated_at <= ? AND (r.work_updated_at < ? OR (r.work_updated_at = ? AND r.id < ?))';

/**
 * GET /work. One page, newest change first, plus the count per state from one GROUP BY.
 * The count reads every row that has ever been in the queue, `done` included, which is the
 * one number here that grows with history; it is returned inside rows_read like the rest.
 * `next` is `<work_updated_at>:<id>`, the one form validateWorkList takes back.
 */
export async function listWork(db, { states, limit, before }) {
  const cursor = before ? CURSOR_TERM : '';
  const cursorArgs = before ? [before.updatedAt, before.updatedAt, before.updatedAt, before.id] : [];
  try {
    const page = await db
      .prepare(
        `SELECT ${ITEM_COLUMNS}, ${RUN_JOINED} ${FROM_JOINED}
          WHERE r.work_state IS NOT NULL AND r.work_state IN (${states.map(() => '?').join(',')}) ${cursor}
          ORDER BY r.work_updated_at DESC, r.id DESC LIMIT ?`,
      )
      .bind(...states, ...cursorArgs, limit)
      .run();
    const tally = await db
      .prepare('SELECT work_state, COUNT(*) AS n FROM reports WHERE work_state IS NOT NULL GROUP BY work_state')
      .run();

    const counts = Object.fromEntries(WORK_STATES.map((s) => [s, 0]));
    for (const row of tally.results || []) if (row.work_state in counts) counts[row.work_state] = row.n;
    const rows = page.results || [];
    const last = rows[rows.length - 1];
    return {
      items: rows.map((row) => toItem(row, joinedRun(row))),
      next: rows.length === limit ? `${last.work_updated_at}:${last.id}` : null,
      counts,
      rowsRead: (page.meta ? page.meta.rows_read : 0) + (tally.meta ? tally.meta.rows_read : 0),
    };
  } catch (err) {
    return storeError('work list', err);
  }
}

/**
 * GET /work/:id and the claim's answer. The item plus what a runner needs to do the work:
 * the body, the page it points at, the run history, and the newest note a person wrote
 * when they sent a result back.
 */
export async function readDetail(db, key, value) {
  try {
    const row = await db.prepare(`SELECT ${DETAIL_COLUMNS}, ${RUN_JOINED} ${FROM_JOINED} WHERE ${DETAIL_KEYS[key]}`).bind(value).first();
    if (!row) return { item: null };
    const history = await db
      .prepare(`SELECT ${RUN_COLUMNS} FROM work_runs WHERE report_id = ? ORDER BY claimed_at DESC LIMIT ?`)
      .bind(row.id, RUNS_SHOWN)
      .run();
    return {
      item: {
        ...toItem(row, joinedRun(row)),
        body: row.body || '',
        url: row.url || '',
        target: row.target_kind ? { kind: row.target_kind, id: row.target_id, label: row.target_label || '' } : null,
        suggested: row.suggested || '',
        opened_at: row.opened_at || null,
        source_closed_at: row.source_closed_at || null,
        runs: (history.results || []).map((r) => toRun(r, { withInstruction: true })),
      },
    };
  } catch (err) {
    return storeError('work detail', err);
  }
}

// ── Filing ────────────────────────────────────────────────────────────────────

/**
 * POST /work/items. An open item with source `direct`, private at `new` like any import,
 * and `filed_by` naming the credential that filed it, because src/work.js trusts an item
 * automation filed no further than a reader's report.
 *
 * The fingerprint is the normalised TEXT rather than a ref, because a direct item has no
 * tracker to key it by, and the case worth catching is a runner filing the same follow-up
 * on two attempts. Every row gets a distinct created_at for the reason
 * src/store-open.js upsertOpenItems spells out: the desk pages by keyset on that column.
 * The step past the newest open item is taken INSIDE the INSERT, one statement, so two
 * filings at once cannot both read the same newest value. That is also why created_at is
 * the last column rather than the second.
 */
export async function insertDirectItem(db, { text, suggested, actor, now }) {
  const fingerprint = await sha256Hex(`${OPEN_KIND}\x00${DIRECT_SOURCE}\x00${normaliseForFingerprint(text)}`);
  const ref = `d-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const id = crypto.randomUUID();
  // Anything but the operator's credential is recorded as automation, so an unexpected
  // value costs trust rather than granting it.
  const filedBy = actor === 'human' ? 'human' : 'ai';
  try {
    const res = await db
      .prepare(
        `INSERT INTO reports
           (id, filed_by, site, url, kind, body, status, public, fingerprint, source, source_ref, suggested, opened_at, created_at)
         VALUES (?, ?, ?, '', ?, ?, 'new', 1, ?, ?, ?, ?, ?,
                 MAX(?, COALESCE((SELECT MAX(created_at) FROM reports WHERE kind = ?), 0) + 1))
         ON CONFLICT(fingerprint) DO NOTHING`,
      )
      .bind(id, filedBy, DIRECT_SOURCE, OPEN_KIND, text, fingerprint, DIRECT_SOURCE, ref, cleanSuggestion(suggested), now, now, OPEN_KIND)
      .run();
    if (!changed(res)) return { duplicate: true };
  } catch (err) {
    return storeError('work item insert', err);
  }
  return { id };
}

// ── The operator's actions ────────────────────────────────────────────────────

/** approve: from none, approved (an edit) or done. An edit keeps the attempts and the
 *  item's place in the queue; a fresh approval starts both again. Which one happens is
 *  decided in the SQL from the row being written, never from the values read first: a
 *  claim and a release between the read and the write leave the row approved again, and
 *  writing the count read earlier back would erase that claim. An item C4 has closed is
 *  refused, and the write repeats that, so a close landing in between leaves it unqueued. */
export async function approveWork(db, { id, actor, mode, instruction, now }) {
  let row;
  try {
    row = await readRow(db, id);
  } catch (err) {
    return storeError('work approve read', err);
  }
  if (!row) return notFound();
  const from = stateOf(row.work_state);
  if (!canAct('approve', from, actor)) return refusal('approve', from, actor);
  const rule = closedRule(row.status) || approvalRule(trustOf(row.kind, row.filed_by), mode, instruction);
  if (rule) return rule;

  try {
    const res = await db
      .prepare(
        `UPDATE reports SET work_state = 'approved', work_mode = ?, work_instruction = ?,
                work_attempts = CASE WHEN work_state = 'approved' THEN work_attempts ELSE 0 END,
                work_approved_at = CASE WHEN work_state = 'approved' THEN work_approved_at ELSE ? END,
                work_updated_at = ?, work_lease_until = NULL
          WHERE id = ? AND work_state IS ? AND status NOT IN ('fixed', 'rejected', 'spam', 'duplicate')`,
      )
      .bind(mode, instruction || null, now, now, id, from === NONE ? null : from)
      .run();
    if (!changed(res)) return inFlight();
  } catch (err) {
    return storeError('work approve', err);
  }
  return workItem(db, id);
}

/** withdraw: out of the queue from anywhere but none and done. A run still open ends. */
export async function withdrawWork(db, { id, actor, now }) {
  let row;
  try {
    row = await readRow(db, id);
  } catch (err) {
    return storeError('work withdraw read', err);
  }
  if (!row) return notFound();
  const from = stateOf(row.work_state);
  if (!canAct('withdraw', from, actor)) return refusal('withdraw', from, actor);

  try {
    const [moved] = await db.batch([
      db.prepare('UPDATE reports SET work_state = NULL, work_lease_until = NULL, work_updated_at = ? WHERE id = ? AND work_state = ?')
        .bind(now, id, from),
      db.prepare(
        `UPDATE work_runs SET ended_at = ?, end_reason = 'withdrawn'
          WHERE report_id = ? AND ended_at IS NULL
            AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND work_state IS NULL AND work_updated_at = ?)`,
      ).bind(now, id, id, now),
    ]);
    if (!changed(moved)) return inFlight();
  } catch (err) {
    return storeError('work withdraw', err);
  }
  return workItem(db, id);
}

/** accept, return or dismiss a result in review. Accept lands on `accepted` only when the
 *  run still has something to land. */
export async function reviewWork(db, { id, actor, decision, note, now }) {
  let row;
  try {
    row = await readRow(db, id);
  } catch (err) {
    return storeError('work review read', err);
  }
  if (!row) return notFound();
  const from = stateOf(row.work_state);
  if (!canAct(decision, from, actor)) return refusal(decision, from, actor);

  const to = decision === 'accept'
    ? acceptTarget({ needs_landing: row.run_needs_landing === 1 })
    : decision === 'return' ? 'approved' : null;
  const verdict = { accept: 'accepted', return: 'returned', dismiss: 'dismissed' }[decision];

  try {
    const [moved] = await db.batch([
      db.prepare(
        `UPDATE reports SET work_state = ?, work_lease_until = NULL, work_updated_at = ?
          WHERE id = ? AND work_state = 'review' AND work_run IS ?`,
      ).bind(to, now, id, row.work_run),
      db.prepare(
        `UPDATE work_runs SET review = ?, review_note = ?, reviewed_at = ?
          WHERE id = ? AND report_id = ? AND review IS NULL
            AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND work_state IS ? AND work_run IS ? AND work_updated_at = ?)`,
      ).bind(verdict, note || null, now, row.work_run, id, id, to, row.work_run, now),
    ]);
    if (!changed(moved)) return inFlight();
  } catch (err) {
    return storeError('work review', err);
  }
  return workItem(db, id);
}
