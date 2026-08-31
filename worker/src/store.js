// The ONLY file in this Worker that contains SQL. If you are about to write a query
// somewhere else, put it here instead: one file means one place to audit what touches
// the store, and one place where CONTRACTS.md C4's transition table is enforced.
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

// ── C4: the status vocabulary and the transition table ────────────────────────

/** The seven statuses. Reading is whitelisted against this list on both sides. */
export const STATUSES = ['new', 'triaged', 'accepted', 'fixed', 'rejected', 'spam', 'duplicate'];

/**
 * Legal transitions, enforced in code. Anything not listed here is 409 BAD_TRANSITION.
 * `fixed` is terminal and has no entry.
 */
export const TRANSITIONS = {
  new: ['triaged', 'accepted', 'rejected', 'spam', 'duplicate'],
  triaged: ['accepted', 'rejected', 'spam', 'duplicate'],
  accepted: ['fixed', 'rejected'],
  fixed: [],
  rejected: ['accepted'],
  spam: ['accepted'],
  duplicate: ['accepted'],
};

/**
 * The AI is authorised for exactly one edge: new -> triaged. Settled decision 4 of this
 * campaign ("triage and propose, never auto-apply") is enforced here rather than
 * described in a comment somewhere.
 *
 * READ THIS BEFORE TRUSTING IT. The AI job and the desk hold the SAME token today, so
 * the Worker tells them apart by the `X-Balise-Actor: ai` header, which the caller sets
 * about itself. That is an HONESTY MECHANISM, NOT A SECURITY BOUNDARY: it stops the job
 * from doing the wrong thing, and it does nothing at all against an attacker who already
 * holds the token, because that attacker simply omits the header. Do not later cite this
 * check as the reason the AI "cannot" change a report's status. If it ever needs to be a
 * boundary, the AI needs its own credential.
 */
/**
 * What the AUTOMATION credential may do. Enforced against the token that
 * authenticated, never against a header the caller sets, so this is a real
 * boundary rather than the honesty mechanism it used to be.
 *
 * The rule behind the list: automation may write a verdict and it may CLOSE
 * junk, but it may never move a report toward anything a reader will see.
 *
 *   - `triaged` records an opinion and its evidence. Publishes nothing.
 *   - `spam` and `duplicate` are closing moves. They publish nothing either,
 *     they are the bulk of the volume, and they are the judgement an AI is
 *     actually good at. Both are cheap to get wrong: a human reopen
 *     (spam -> accepted) is already legal and is deliberately NOT granted here,
 *     so automation can close junk but only a person can bring one back.
 *
 * `accepted` and `fixed` stay human. `fixed` in particular requires a
 * public_note, and C4 says an operator writes that note and never derives it
 * from the reporter's text, because it lands on a public page. An AI writing it
 * would route stranger-influenced text onto neorgon.com through a paraphrase,
 * which is the exact thing settled decision 3 exists to prevent.
 */
export const AI_TRANSITIONS = {
  new: ['triaged', 'spam', 'duplicate'],
  triaged: ['spam', 'duplicate'],
};

/** Pure, and exported so a test can assert the whole table without a database. */
export function canTransition(from, to, actor) {
  const table = actor === 'ai' ? AI_TRANSITIONS : TRANSITIONS;
  const allowed = table[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

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

const storeError = (where, err) => {
  console.error(`d1 ${where} failed:`, err);
  return {
    code: 'STORE_ERROR',
    message: 'The report store did not answer.',
    hint: 'Try again in a minute. If it keeps happening, the address of the page is enough to report it by hand.',
  };
};

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
                      decided_at, fixed_at, fixed_ref`;

/**
 * The private queue. ONE query returning many rows, never a query per row.
 *
 * The two SQL strings are deliberately not one string with `(?1 IS NULL OR status = ?1)`.
 * That form is shorter and it defeats the index: SQLite cannot use
 * reports_status_created for a predicate whose column may not participate, so the filtered
 * list would silently become a full scan and only rows_read would show it.
 */
export async function listReports(db, { status, before, limit }) {
  const cursor = before === null || before === undefined ? Number.MAX_SAFE_INTEGER : before;
  const sql = status
    ? `SELECT ${DESK_COLUMNS} FROM reports
        WHERE status = ? AND created_at < ?
        ORDER BY created_at DESC LIMIT ?`
    : `SELECT ${DESK_COLUMNS} FROM reports
        WHERE created_at < ?
        ORDER BY created_at DESC LIMIT ?`;
  const args = status ? [status, cursor, limit] : [cursor, limit];
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

/**
 * One status change, C4 enforced. Two queries: read the current status, then a guarded
 * UPDATE.
 *
 * The UPDATE carries `AND status = ?` on purpose. Between the read and the write another
 * operator could have moved the report, and without that guard the second writer would
 * win a transition that was never legal from the state the row is actually in. With it,
 * the write matches nothing and the caller gets BAD_TRANSITION, which is the truth.
 */
export async function applyTransition(db, { id, actor, patch, now }) {
  let current;
  try {
    current = await db.prepare('SELECT id, status FROM reports WHERE id = ?').bind(id).first();
  } catch (err) {
    return storeError('transition read', err);
  }
  if (!current) {
    return {
      code: 'NOT_FOUND',
      message: 'There is no report with that id.',
      hint: 'Reload the queue: it may have been merged into another report already.',
    };
  }

  const from = STATUSES.includes(current.status) ? current.status : 'new';
  const to = patch.status;
  if (!canTransition(from, to, actor)) {
    return {
      code: 'BAD_TRANSITION',
      message: `A report at "${from}" cannot move to "${to}"${actor === 'ai' ? ' for the triage job' : ''}.`,
      hint: `From "${from}" the legal moves are ${(actor === 'ai' ? AI_TRANSITIONS[from] : TRANSITIONS[from])?.join(', ') || 'none, it is terminal'}.`,
    };
  }

  // Two required fields, refused here rather than left to the reader of the public log.
  if (to === 'fixed' && !(patch.public_note || '').trim()) {
    return {
      code: 'BAD_FIELD',
      message: 'A report cannot be marked fixed without a public note.',
      hint: 'Write one sentence for the public log, in your own words, then mark it fixed.',
    };
  }
  if (to === 'duplicate' && !(patch.duplicate_of || '').trim()) {
    return {
      code: 'BAD_FIELD',
      message: 'A report cannot be marked duplicate without naming the report it repeats.',
      hint: 'Copy the id of the original into duplicate_of, or reject it instead.',
    };
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
         WHERE id = ? AND status = ?`,
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
      return {
        code: 'BAD_TRANSITION',
        message: 'That report moved while this change was in flight.',
        hint: 'Reload the queue and look at where it is now before deciding again.',
      };
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
 */
export async function publicLog(db, { before, limit }) {
  const cursor = before === null || before === undefined ? Number.MAX_SAFE_INTEGER : before;
  try {
    const res = await db
      .prepare(
        `SELECT site, url, target_label, public_note, fixed_ref, fixed_at
           FROM reports
          WHERE status = 'fixed' AND public = 1 AND fixed_at < ?
          ORDER BY fixed_at DESC LIMIT ?`,
      )
      .bind(cursor, limit)
      .run();
    const rows = res.results || [];
    return {
      entries: rows,
      rowsRead: res.meta ? res.meta.rows_read : null,
      next: rows.length === limit ? rows[rows.length - 1].fixed_at : null,
    };
  } catch (err) {
    return storeError('log', err);
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
 */
export async function healthSites(db, since) {
  try {
    const res = await db
      .prepare(
        `SELECT site, COUNT(*) AS reports, MAX(created_at) AS last_at
           FROM reports
          WHERE created_at >= ?
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

/** Recorded AFTER the comparison. Success clears the counter; failure advances it. */
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
           failures     = auth_attempts.failures + 1,
           locked_until = CASE WHEN auth_attempts.failures + 1 >= ? THEN ? ELSE auth_attempts.locked_until END,
           updated_at   = ?`,
      )
      .bind(key, now, LOCKOUT_MAX_FAILURES, now + LOCKOUT_MS, now)
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
  };
}
