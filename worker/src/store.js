// The corrections half of the store, and one of the four files in this Worker that
// contain SQL. The others are src/store-open.js, which owns the open-items feed (queue
// #58), and src/store-work.js with src/store-work-runner.js, which own the work queue. If
// you are about to write a query somewhere else, put it in one of these instead: a short
// list of files is a short list of places to audit what touches the store. The
// C4 tables themselves are pure and live in src/transitions.js; this file is where they
// are enforced.
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

// ── C4: the status vocabulary and the transition tables ───────────────────────
//
// Defined in src/transitions.js, which is pure. Re-exported here because this file is
// where C4 is ENFORCED and because every caller already imports it from the store.

import { STATUSES, TRANSITIONS, AI_TRANSITIONS, OPEN_TRANSITIONS, canTransition } from './transitions.js';

export { STATUSES, TRANSITIONS, AI_TRANSITIONS, OPEN_TRANSITIONS, canTransition };

// ── Budgets ───────────────────────────────────────────────────────────────────

/**
 * What a keyset page of `limit` rows should cost in rows SCANNED.
 *
 * The multiplier is not a guess. Measured against local D1 with 104 rows on 2026-08-29,
 * every keyset page read EXACTLY `limit` rows, at limits of 1, 5, 25 and 50, filtered and
 * unfiltered. Dropping reports_created and reports_status_created and repeating the same
 * requests read 208 rows for a page of 5, so the indexes are load bearing and the gap
 * between the two numbers is wide. Doubling the measurement and adding ten leaves room
 * for a range scan stepping over non-matching rows without leaving room for a table scan.
 */
export function rowsReadBudget(limit) {
  return limit * 2 + 10;
}

// ── Hashing ───────────────────────────────────────────────────────────────────

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256(site, target id, normalised body). The UNIQUE index on this column IS the
 * duplicate guard: the insert below conflicts and writes nothing, which costs one no-op
 * insert rather than a read plus a write.
 *
 * Normalising case and runs of whitespace means "the same complaint typed twice" is one
 * report. It does not catch a reworded duplicate, and it is not meant to: that is the
 * `duplicate` status and a human.
 */
export function normaliseForFingerprint(body) {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function fingerprintInput(site, targetId, body) {
  return `${site}\x00${targetId || ''}\x00${normaliseForFingerprint(body)}`;
}

/**
 * SHA-256(salt, address), truncated to 32 hex characters. Returns null with no salt,
 * because an unsalted hash of an IPv4 address is reversible by brute force in seconds and
 * storing that would be worse than storing nothing.
 */
export async function ipHash(salt, address) {
  if (!salt || !address) return null;
  return (await sha256Hex(`${salt}\x00${address}`)).slice(0, 32);
}

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
 */
export async function insertReport(db, row) {
  try {
    const res = await db
      .prepare(
        `INSERT INTO reports
           (id, created_at, site, url, target_kind, target_id, target_label,
            kind, body, contact, status, public, ip_hash, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 1, ?, ?)
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
 */
export async function listReports(db, { status, kind, before, limit }) {
  const cursor = before === null || before === undefined ? Number.MAX_SAFE_INTEGER : before;
  const kindTerm = kind ? 'kind = ?' : "kind <> 'open'";
  const statusTerm = status ? 'status = ? AND ' : '';
  const sql = `SELECT ${DESK_COLUMNS} FROM reports
        WHERE ${kindTerm} AND ${statusTerm}created_at < ?
        ORDER BY created_at DESC LIMIT ?`;
  const args = [...(kind ? [kind] : []), ...(status ? [status] : []), cursor, limit];
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

export async function getReport(db, id) {
  try {
    const row = await db.prepare(`SELECT ${DESK_COLUMNS} FROM reports WHERE id = ?`).bind(id).first();
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
 */
export async function applyTransition(db, { id, actor, patch, now }) {
  let current;
  try {
    current = await db.prepare('SELECT id, status, kind, work_state FROM reports WHERE id = ?').bind(id).first();
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
         WHERE id = ? AND status = ? ${closing ? OUT_OF_QUEUE : ''}`,
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
      )
      .run();
    if (!res.meta || res.meta.changes === 0) {
      return refuse('BAD_TRANSITION', 'That report moved while this change was in flight.', 'Reload the queue and look at where it is now before deciding again.');
    }
  } catch (err) {
    return storeError('transition write', err);
  }

  return getReport(db, id);
}

// ── The public log ────────────────────────────────────────────────────────────

/**
 * C4's public log query, byte for byte the shape the contract froze, plus the keyset
 * cursor and limit. Two conditions, one table, still a filter.
 *
 * `body` and `contact` are absent from this SELECT and that is the point: the stranger's
 * raw text is never served from a neorgon.com domain. Only the operator's `public_note`
 * is. Adding `body` here would break settled decision 3 in one line, so do not.
 *
 * `kind <> 'open'` is the one amendment this query has taken. A resolved open item is a
 * board entry and not a correction: it names no site, no page and no reporter, so it
 * would land in the corrections log as a line about nothing. The term is written the same
 * way in migrations/0002_open_items.sql, which is what lets its partial index serve this.
 *
 * `url` is TRIMMED on the way out, by `publicUrl` below, for the same reason `body` is
 * absent: a page address the reporter was looking at is not neutral. /log is the only
 * cacheable, crawler-visible route this service has, and the Beacon sends `location.href`,
 * so the query string arrives whole. The stored column stays whole too, because the desk
 * needs it to reproduce the report. Only this projection is cut.
 */
export async function publicLog(db, { before, limit }) {
  const cursor = before === null || before === undefined ? Number.MAX_SAFE_INTEGER : before;
  try {
    const res = await db
      .prepare(
        `SELECT site, url, target_label, public_note, fixed_ref, fixed_at
           FROM reports
          WHERE kind <> 'open' AND status = 'fixed' AND public = 1 AND fixed_at < ?
          ORDER BY fixed_at DESC LIMIT ?`,
      )
      .bind(cursor, limit)
      .run();
    const rows = res.results || [];
    return {
      entries: rows.map((row) => ({ ...row, url: publicUrl(row.url) })),
      rowsRead: res.meta ? res.meta.rows_read : null,
      next: rows.length === limit ? rows[rows.length - 1].fixed_at : null,
    };
  } catch (err) {
    return storeError('log', err);
  }
}

/**
 * A stored page address as the public log may show it: origin plus pathname, and nothing
 * else. The key keeps the name `url`: the /log response shape is a frozen contract, and
 * the suite asserts its exact key set. This changes the value, never the envelope.
 *
 * What this drops, and why each one is not a hypothetical:
 *
 *   - the QUERY. A report filed from a Vitrina public shelf carries the owner's handle
 *     there, which privacy/index.html promises is kept out of any directory, and one filed
 *     from a Sash claim page carries a live bearer token until it expires.
 *   - the FRAGMENT. Purely client state, and the one place a page puts a value it never
 *     meant to send anywhere.
 *   - the USERINFO prefix. `new URL().origin` drops it, which is the reason the trim goes
 *     through the parser rather than through a regex over the string.
 *
 * Anything that does not parse, or is not http(s), becomes `null` rather than being passed
 * through: a `javascript:` or `data:` address reaching a public page as a rendered link is
 * a worse outcome than a log entry with no address on it.
 */
function publicUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
}

// ── The per-site read-back ────────────────────────────────────────────────────

/**
 * One GROUP BY, and the only thing in the whole system that would ever notice a Beacon
 * that silently stopped working. Every other check this campaign builds is a static check
 * on files: they prove the widget was copied, not that a report ever arrived.
 *
 * A site absent from this list either has no visitors or has a broken widget, and the
 * operator can tell which in one click by opening the site.
 *
 * IMPORTED OPEN ITEMS ARE EXCLUDED, and that exclusion is the whole reason this signal
 * still means anything. They carry their source name in `site` because the column is NOT
 * NULL, they arrive in the hundreds from one command, and counting them here would put
 * four invented sites at the top of the list and drown the one number that says a real
 * Beacon is alive.
 */
export async function healthSites(db, since) {
  try {
    const res = await db
      .prepare(
        `SELECT site, COUNT(*) AS reports, MAX(created_at) AS last_at
           FROM reports
          WHERE kind <> 'open' AND created_at >= ?
          GROUP BY site
          ORDER BY reports DESC`,
      )
      .bind(since)
      .run();
    return { sites: res.results || [], rowsRead: res.meta ? res.meta.rows_read : null };
  } catch (err) {
    return storeError('health', err);
  }
}

// ── C3: the operator lockout ──────────────────────────────────────────────────

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Checked BEFORE the token comparison, so a locked out caller never reaches the
 * comparison at all. Five failures then fifteen minutes. The binding cannot express this
 * (A3), which is why it is here.
 */
export async function checkLock(db, key, now) {
  try {
    const row = await db.prepare('SELECT failures, locked_until FROM auth_attempts WHERE key = ?').bind(key).first();
    if (!row) return { locked: false };
    return { locked: row.locked_until > now, until: row.locked_until };
  } catch (err) {
    // A store failure must not open the door. Treat it as locked and let the operator
    // read STORE_ERROR from /health rather than silently dropping the lockout.
    console.error('d1 lock read failed:', err);
    return { locked: true, unavailable: true };
  }
}

/** Recorded AFTER the comparison. Success clears the counter; failure advances it. A failure
 *  once a lock has run out starts again at one, so an expired lock costs five more tries:
 *  counting on from five, a stale credential on a schedule relocked the address every run. */
export async function recordAuthResult(db, key, success, now) {
  try {
    if (success) {
      await db.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
      return;
    }
    await db
      .prepare(
        `INSERT INTO auth_attempts (key, failures, locked_until, updated_at)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(key) DO UPDATE SET
           failures     = CASE WHEN auth_attempts.locked_until > 0 AND auth_attempts.locked_until <= ? THEN 1
                               ELSE auth_attempts.failures + 1 END,
           locked_until = CASE WHEN auth_attempts.locked_until > 0 AND auth_attempts.locked_until <= ? THEN 0
                               WHEN auth_attempts.failures + 1 >= ? THEN ? ELSE auth_attempts.locked_until END,
           updated_at   = ?`,
      )
      .bind(key, now, now, now, LOCKOUT_MAX_FAILURES, now + LOCKOUT_MS, now)
      .run();
  } catch (err) {
    console.error('d1 lock write failed:', err);
  }
}

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
