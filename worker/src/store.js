// The corrections desk half of the store, and one of the SIX files in this Worker that
// contain SQL. The others are src/store-public.js, which owns the two queries a stranger
// can reach; src/store-auth.js, which owns the operator lockout; src/store-open.js, which
// owns the open-items feed (queue #58); and src/store-work.js with
// src/store-work-runner.js, which own the work queue. If you are about to write a query
// somewhere else, put it in one of these instead: a short list of files is a short list of
// places to audit what touches the store. The C4 tables themselves are pure and live in
// src/transitions.js; this file is where they are enforced.
//
// C6: EVERY STATEMENT BELOW THAT TOUCHES `reports` CARRIES A PREDICATE ON `app_id`, OR
// CARRIES A COMMENT NAMING THE INVARIANT THAT MAKES ONE UNNECESSARY. There is no third
// option, and a statement with neither is a defect whether or not it can be reached. The
// tenant key comes from src/scope.js and from nowhere else: a store function takes the
// scope as the argument right after `db`, and never a request, a header or a token. The
// per-statement audit is DESIGN.md section 5.
//
// Two D1 limits shape everything below, and they bite at our SHAPE, not our volume
// (https://developers.cloudflare.com/d1/platform/limits/, CONTRACTS.md A4):
//
//   1. 50 queries per Worker invocation on the free plan. A desk that ran one query per
//      row to render a 50 row list would hit that ceiling exactly. Every list here is
//      ONE query returning many rows. The most any request costs is four.
//   2. rows_read counts rows SCANNED, not rows returned, so OFFSET is billed for every
//      row it skips. There is no OFFSET in this file. Paging is keyset:
//      `WHERE created_at < ?` plus LIMIT, over an index that matches the predicate.
//
// Every list function hands `rowsRead` back to the router, which warns when it exceeds
// the budget below. Local D1 enforces no limit and no quota, so that number and the test
// asserting it are the only things that would catch a scan before production.

import { redactionFindings } from './redact.js';
import { ACTIVE_STATES, CLOSED_STATUSES } from './work.js';
import { tenantKey, scopeKeyId } from './scope.js';

// ── C4: the status vocabulary and the transition tables ───────────────────────
//
// Defined in src/transitions.js, which is pure. Re-exported here because this file is
// where C4 is ENFORCED and because every caller already imports it from the store.

import { STATUSES, TRANSITIONS, AI_TRANSITIONS, OPEN_TRANSITIONS, canTransition } from './transitions.js';

export { STATUSES, TRANSITIONS, AI_TRANSITIONS, OPEN_TRANSITIONS, canTransition };

// ── Budgets and derived keys, re-exported ─────────────────────────────────────
//
// Both groups MOVED OUT in the phase 2 router split and are re-exported here, the same way
// and for the same reason src/transitions.js is above: this file is where they are used, every
// existing caller already imports them from here, and neither group contains any SQL. The
// header above says this is one of the six files in the Worker that contain SQL, and the two
// budget functions and the five key functions were the parts of it that a reader auditing the
// store had to page past. They are in src/budget.js and src/keys.js now, both of which are
// reachable from any file here without closing an import cycle.

import { rowsReadBudget, warnRowsRead } from './budget.js';
import { sha256Hex, normaliseForFingerprint, fingerprintInput, ipHash, actorKey } from './keys.js';

export { rowsReadBudget, warnRowsRead };
export { sha256Hex, normaliseForFingerprint, fingerprintInput, ipHash, actorKey };

// ── Errors ────────────────────────────────────────────────────────────────────

export const storeError = (where, err) => {
  console.error(`d1 ${where} failed:`, err);
  return {
    code: 'STORE_ERROR',
    message: 'The report store did not answer.',
    hint: 'Try again in a minute. If it keeps happening, the address of the page is enough to report it by hand.',
  };
};

const refuse = (code, message, hint) => ({ code, message, hint });

// ── Ingest ────────────────────────────────────────────────────────────────────

/**
 * One INSERT. `ON CONFLICT DO NOTHING` turns a duplicate into `changes === 0` instead of
 * a thrown constraint error, so the duplicate path never depends on matching the text of
 * a D1 error message.
 *
 * C6: this is a WRITE, so the predicate is the column, bound from the scope. `app_id` and
 * `app_key_id` are appended to the end of the column list rather than slotted in beside
 * `site`, because a column list is order-sensitive against its VALUES and the two lists
 * are read together far more often than either is read alone.
 *
 * `ON CONFLICT(fingerprint)` is UNCHANGED and must stay so: the tenant is already inside
 * the hashed input (A11 above), so two tenants filing the same sentence about the same page
 * produce two different fingerprints and both rows land. Naming a different index here
 * would be the change A11 exists to avoid.
 *
 * `app_key_id` is null for every principal that exists in phase 1, because only an `app`
 * principal presents a key. It is written now rather than in phase 2 so that the column
 * list and the VALUES do not have to be touched again to start recording it.
 */
export async function insertReport(db, scope, row) {
  try {
    const res = await db
      .prepare(
        `INSERT INTO reports
           (id, created_at, site, url, target_kind, target_id, target_label,
            kind, body, contact, status, public, ip_hash, fingerprint,
            app_id, app_key_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 1, ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO NOTHING`,
      )
      .bind(
        row.id,
        row.created_at,
        row.site,
        row.url,
        row.target ? row.target.kind : null,
        row.target ? row.target.id : null,
        row.target ? row.target.label : null,
        row.kind,
        row.body,
        row.contact || null,
        row.ip_hash,
        row.fingerprint,
        tenantKey(scope),
        scopeKeyId(scope),
      )
      .run();
    if (!res.meta || res.meta.changes === 0) return { duplicate: true };
    return { id: row.id };
  } catch (err) {
    return storeError('insert', err);
  }
}

// ── The desk ──────────────────────────────────────────────────────────────────

const DESK_COLUMNS = `id, created_at, site, url, target_kind, target_id, target_label,
                      kind, body, contact, status, public, public_note, duplicate_of,
                      ai_verdict, ai_confidence, ai_notes, ai_at,
                      decided_at, fixed_at, fixed_ref,
                      source, source_ref, suggested, opened_at, source_closed_at,
                      work_state, work_mode, work_attempts, work_updated_at, filed_by`;

/**
 * The private queue. ONE query returning many rows, never a query per row.
 *
 * The SQL is built from a handful of CONSTANT fragments and is deliberately not one
 * string with `(?1 IS NULL OR status = ?1)`. That form is shorter and it defeats the
 * index: SQLite cannot use reports_status_created for a predicate whose column may not
 * participate, so the filtered list would silently become a full scan and only rows_read
 * would show it. Nothing below is ever interpolated from a request; the fragments are
 * chosen, and every value is bound.
 *
 * THE DEFAULT LIST IS CORRECTIONS, not everything. Two feeds share this table now, and
 * an operator who has never opened the Open items tab must not find sixty imported drafts
 * sitting in the queue of stranger reports. `kind` selects the feed:
 *
 *   absent            -> kind <> 'open', the corrections queue this route has always been
 *   'open'            -> the imported drafts
 *   a correction kind -> that one kind
 *
 * Each of the four combinations lands on an index created for it. The two `kind <> 'open'`
 * shapes need PARTIAL indexes, because an inequality cannot seek an index prefix: the
 * term is written here exactly as it is written in migrations/0002_open_items.sql, since
 * SQLite matches a partial index by implication and a reworded predicate silently loses
 * the index while returning identical rows.
 *
 * C6: the tenant term is bound, and it is written FIRST because `app_id` is the LEADING
 * column of all four indexes this query now seeks (reports_app_created,
 * reports_app_status_created, reports_app_fix_created, reports_app_fix_status_created, from
 * migrations/0004_tenants.sql). The ORDER of the terms in this string is for the reader:
 * SQLite reorders WHERE terms itself, so it is the term's PRESENCE that matters, and
 * Cloudflare's rule is what makes presence non-optional. A multi-column index is used only
 * if the query names every column to the left of the ones it needs, so a page that did not
 * mention `app_id` at all would seek none of these four, be perfectly correct, and become a
 * scan that only rows_read would report. Writing it first keeps the string in the shape of
 * the index it is meant to land on, which is how the next person checks that it still does.
 *
 * No partial predicate mentions `app_id`, so the implication that matches `kind <> 'open'`
 * against the two partial indexes is unaffected.
 */
export async function listReports(db, scope, { status, kind, before, limit }) {
  const cursor = before === null || before === undefined ? Number.MAX_SAFE_INTEGER : before;
  const kindTerm = kind ? 'kind = ?' : "kind <> 'open'";
  const statusTerm = status ? 'status = ? AND ' : '';
  const sql = `SELECT ${DESK_COLUMNS} FROM reports
        WHERE app_id = ? AND ${kindTerm} AND ${statusTerm}created_at < ?
        ORDER BY created_at DESC LIMIT ?`;
  const args = [tenantKey(scope), ...(kind ? [kind] : []), ...(status ? [status] : []), cursor, limit];
  try {
    const res = await db.prepare(sql).bind(...args).run();
    const rows = res.results || [];
    return {
      reports: rows.map(toReport),
      rowsRead: res.meta ? res.meta.rows_read : null,
      next: rows.length === limit ? rows[rows.length - 1].created_at : null,
    };
  } catch (err) {
    return storeError('list', err);
  }
}

/**
 * One report by id.
 *
 * C6: the tenant term is bound, and it is what makes an id a per-tenant handle rather than
 * a global one. An id is not a secret: it is in a URL, in a desk card, in an operator's
 * clipboard. Without this term, knowing an id would be enough to read another tenant's
 * report text, and the answer would look ordinary. With it, the row is simply not found,
 * and NOT_FOUND is the honest answer to "a report you cannot see".
 *
 * The term is written after `id` because `reports` has `id` as its PRIMARY KEY: the lookup
 * is one row by rowid and the tenant check is a comparison on that row, so no index choice
 * turns on the order here.
 */
export async function getReport(db, scope, id) {
  try {
    const row = await db
      .prepare(`SELECT ${DESK_COLUMNS} FROM reports WHERE id = ? AND app_id = ?`)
      .bind(id, tenantKey(scope))
      .first();
    return { report: row ? toReport(row) : null };
  } catch (err) {
    return storeError('get', err);
  }
}

// The work queue check below, repeated in the write of a closing move: an approval landing
// between the read and the UPDATE leaves the row queued, so the write matches nothing.
const OUT_OF_QUEUE = "AND (work_state IS NULL OR work_state NOT IN ('approved', 'claimed', 'review', 'accepted'))";

/**
 * One status change, C4 enforced. Two queries: read the current status and work state,
 * then a guarded UPDATE.
 *
 * The UPDATE carries `AND status = ?` on purpose. Between the read and the write another
 * operator could have moved the report, and without that guard the second writer would
 * win a transition that was never legal from the state the row is actually in. With it,
 * the write matches nothing and the caller gets BAD_TRANSITION, which is the truth.
 *
 * C6: BOTH statements carry the bound tenant term, and the second one is not redundant.
 * The read establishing that the row is this tenant's does not constrain the write: they
 * are separate statements with a decision between them, so the write is guarded on its own
 * terms exactly as it already is for `status`. Adding the term to the read alone would make
 * the tenant check a time-of-check-to-time-of-use gap in the one function in this file that
 * has already been written twice to close such a gap.
 *
 * The write's tenant term is LAST, after the interpolated OUT_OF_QUEUE, and its position is
 * not a preference. tests/work-rules.test.mjs's #64 tripwire matches the source text
 * `WHERE id = ? AND status = ? ${closing ? OUT_OF_QUEUE : ''}` as one contiguous string, so a
 * term inserted between `id` and `status` breaks a test that is watching something else
 * entirely (that a closing move repeats the work-queue check inside its write). Keeping the
 * shape it asserts means nothing here loosened an existing expectation to make room. The
 * lookup is by primary key, so the term's position costs nothing: `id = ?` picks one row and
 * `app_id = ?` decides whether this caller may have it.
 */
export async function applyTransition(db, scope, { id, actor, patch, now }) {
  const appId = tenantKey(scope);
  let current;
  try {
    current = await db
      .prepare('SELECT id, status, kind, work_state FROM reports WHERE id = ? AND app_id = ?')
      .bind(id, appId)
      .first();
  } catch (err) {
    return storeError('transition read', err);
  }
  if (!current) {
    return refuse('NOT_FOUND', 'There is no report with that id.', 'Reload the queue: it may have been merged into another report already.');
  }

  const from = STATUSES.includes(current.status) ? current.status : 'new';
  const to = patch.status;
  const isOpenItem = current.kind === 'open';
  if (!canTransition(from, to, actor, isOpenItem ? 'open' : null)) {
    const table = actor === 'ai' ? AI_TRANSITIONS : isOpenItem ? OPEN_TRANSITIONS : TRANSITIONS;
    return {
      code: 'BAD_TRANSITION',
      message: `A report at "${from}" cannot move to "${to}"${actor === 'ai' ? ' for the triage job' : ''}.`,
      hint: actor === 'ai' && isOpenItem
        ? 'An open item is moved by a person, never by the triage job. Nothing on that feed is automatic.'
        : `From "${from}" the legal moves are ${table[from]?.join(', ') || 'none, it is terminal'}.`,
    };
  }

  // Closing an item an agent still holds would leave a runner working, shipping or landing
  // something already closed. Publishing as open closes nothing, so it stays allowed.
  const closing = CLOSED_STATUSES.includes(to);
  if (closing && ACTIVE_STATES.includes(current.work_state)) {
    return refuse('BAD_TRANSITION', `That item is in the work queue at "${current.work_state}", so it cannot move to "${to}" yet.`, 'Withdraw it from the work queue first, or let the result finish and close it then.');
  }

  // Automation writes a verdict and closes junk. What a reader sees, and whether a reader
  // sees it at all, stays with a person on every edge, whatever is steering the token.
  const reserved = actor === 'ai' ? ['public', 'public_note', 'fixed_ref'].filter((field) => patch[field] !== undefined) : [];
  if (reserved.length) {
    return refuse(
      'BAD_FIELD',
      `The automation token cannot set ${reserved.join(' or ')}.`,
      'Send the status with the ai_ fields, and duplicate_of for a duplicate. What a reader sees is set at the desk.',
    );
  }

  // Two required fields, refused here rather than left to the reader of the public log.
  if (to === 'fixed' && !(patch.public_note || '').trim()) {
    return refuse('BAD_FIELD', 'A report cannot be marked fixed without a public note.', 'Write one sentence for the public log, in your own words, then mark it fixed.');
  }

  // An open item published as OPEN carries the same requirement, for the same reason:
  // `accepted` is what puts it on the board, and an entry with no sentence is a blank
  // line telling a reader nothing.
  if (isOpenItem && to === 'accepted' && !(patch.public_note || '').trim()) {
    return refuse('BAD_FIELD', 'An open item cannot be published without a sentence.', 'Say what is being worked on, in your own words. One line is the whole entry.');
  }

  // THE REDACTION FLOOR, server side. The desk runs the same rules live under the field,
  // which is a courtesy to whoever is typing; this is the one that decides. A public_note
  // on an open item is the only string this feed can ever put in front of a reader, and
  // the trackers it is drafted from are full of paths, line numbers and ids.
  if (isOpenItem && patch.public_note !== undefined) {
    const findings = redactionFindings(patch.public_note);
    if (findings.length) {
      const { rule, match } = findings[0];
      return {
        code: 'BAD_FIELD',
        message: `That sentence contains a ${rule} (${match}) and the board never shows one.`,
        hint: 'Say what is being done, not where. Rewrite it and publish again.',
      };
    }
  }
  if (to === 'duplicate' && !(patch.duplicate_of || '').trim()) {
    return refuse('BAD_FIELD', 'A report cannot be marked duplicate without naming the report it repeats.', 'Copy the id of the original into duplicate_of, or reject it instead.');
  }

  const decided = to === 'triaged' ? null : now;
  const fixedAt = to === 'fixed' ? now : null;
  const aiAt = to === 'triaged' ? now : null;

  try {
    const res = await db
      .prepare(
        `UPDATE reports SET
           status        = ?,
           public        = COALESCE(?, public),
           public_note   = COALESCE(?, public_note),
           fixed_ref     = COALESCE(?, fixed_ref),
           duplicate_of  = COALESCE(?, duplicate_of),
           ai_verdict    = COALESCE(?, ai_verdict),
           ai_confidence = COALESCE(?, ai_confidence),
           ai_notes      = COALESCE(?, ai_notes),
           ai_at         = COALESCE(?, ai_at),
           decided_at    = COALESCE(?, decided_at),
           fixed_at      = COALESCE(?, fixed_at)
         WHERE id = ? AND status = ? ${closing ? OUT_OF_QUEUE : ''} AND app_id = ?`,
      )
      .bind(
        to,
        patch.public === undefined ? null : patch.public,
        patch.public_note === undefined ? null : patch.public_note,
        patch.fixed_ref === undefined ? null : patch.fixed_ref,
        patch.duplicate_of === undefined ? null : patch.duplicate_of,
        patch.ai_verdict === undefined ? null : patch.ai_verdict,
        patch.ai_confidence === undefined ? null : patch.ai_confidence,
        patch.ai_notes === undefined ? null : patch.ai_notes,
        aiAt,
        decided,
        fixedAt,
        id,
        from,
        appId,
      )
      .run();
    if (!res.meta || res.meta.changes === 0) {
      return refuse('BAD_TRANSITION', 'That report moved while this change was in flight.', 'Reload the queue and look at where it is now before deciding again.');
    }
  } catch (err) {
    return storeError('transition write', err);
  }

  return getReport(db, scope, id);
}

// ── Moved out ─────────────────────────────────────────────────────────────
//
// `publicLog` and `healthSites` are in src/store-public.js, because both are reachable
// with no credential and both carry `app_id = 'fleet'` as a LITERAL rather than as a bound
// parameter (C6.5). Grouping them makes that rule a property of a file.
//
// `checkLock` and `recordAuthResult` are in src/store-auth.js, with the reason
// `auth_attempts` has no tenant column and must not gain one.
//
// This file stayed under the 500-line repo limit only because they left. Do not move them
// back to keep an import shorter.

// ── Row shaping ───────────────────────────────────────────────────────────────

/**
 * A stored row as the desk reads it. `ip_hash` and `fingerprint` are never returned: the
 * desk has no use for either and both are abuse-tracking internals.
 */
function toReport(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    site: row.site,
    url: row.url,
    target: row.target_kind ? { kind: row.target_kind, id: row.target_id, label: row.target_label || '' } : null,
    kind: row.kind,
    body: row.body,
    contact: row.contact || '',
    // Whitelisted on the way out as well as on the way in. The value round trips through
    // the network and lands in a class attribute on the desk, so an unknown value falls
    // back to 'new' rather than reaching the DOM.
    status: STATUSES.includes(row.status) ? row.status : 'new',
    public: row.public === 1,
    public_note: row.public_note || '',
    duplicate_of: row.duplicate_of || null,
    ai: row.ai_at ? { verdict: row.ai_verdict || '', confidence: row.ai_confidence, notes: row.ai_notes || '', at: row.ai_at } : null,
    decided_at: row.decided_at || null,
    fixed_at: row.fixed_at || null,
    fixed_ref: row.fixed_ref || '',
    // The open-item half. All six are null or empty on a correction, which is what makes
    // this one queue with two feeds rather than two queues. `source_ref` and `body` are
    // the private halves: the desk shows them to the operator and no public query selects
    // either one. `filed_by` is set only on an item filed through POST /work/items.
    source: row.source || null,
    source_ref: row.source_ref || null,
    suggested: row.suggested || '',
    opened_at: row.opened_at || null,
    source_closed_at: row.source_closed_at || null,
    filed_by: row.filed_by === 'human' || row.filed_by === 'ai' ? row.filed_by : null,
    // Whether an agent has this item, so a desk card can say so instead of offering to hand
    // it over twice. The run itself is GET /work's business; this is only the badge.
    work: row.work_state
      ? { state: row.work_state, mode: row.work_mode || null, attempts: row.work_attempts || 0, updated_at: row.work_updated_at || null }
      : null,
  };
}
