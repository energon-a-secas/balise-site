// The SECOND file in this Worker that contains SQL, and the last one. Everything about
// the open-items board that touches D1 is here; src/store.js owns the corrections half
// and says so in its own header.
//
// The split is by FEED, not by table: an open item is a row in `reports` with
// kind = 'open', so C3's token gate, C4's transition guard, C5's rendering rule and the
// keyset paging all apply to it unchanged. What is different is where the row comes from
// (an importer, never a stranger) and where it goes (a board, never the corrections log).
//
// The same two D1 limits shape this file as shape store.js:
//
//   1. 50 queries per invocation. THIS IS WHY A BATCH IS 25 AND NOT 100. An import batch
//      costs two SELECTs plus at most one write per item, so 25 items is 27 queries with
//      room to spare, and a second run of the same batch costs two, because every item is
//      already there and nothing is written.
//   2. rows_read counts rows SCANNED. Every query below sits on an index created in
//      migrations/0002_open_items.sql, and tests/local-d1.test.mjs asserts the budget.
//
// D1 also caps BOUND PARAMETERS per query at 100, which is why the sync route resolves
// what to close in JS from one small SELECT instead of sending the whole ref set into a
// NOT IN list that would silently overflow once a source grows.

import { sha256Hex, storeError } from './store.js';

/** The kind that makes a row an open item. Written only by the import route. */
export const OPEN_KIND = 'open';

/** The four trackers the importer reads. A source outside this list is refused. */
export const OPEN_SOURCES = ['queue', 'brief', 'harness', 'registry'];

/** Items per import batch. See the query-limit note at the top of this file. */
export const IMPORT_BATCH_MAX = 25;

/** Refs per sync call. The 8 KB body cap bites first; this stops a runaway list. */
export const SYNC_REFS_MAX = 400;

/** Entries per array on the public board. */
export const BOARD_LIMIT_MAX = 50;

/**
 * SHA-256('open', source, source_ref). The UNIQUE index on `fingerprint` IS the
 * idempotency guard: a second import of the same tracker line conflicts and writes
 * nothing, so re-running the importer costs no rows and cannot produce a second draft of
 * an item the operator already published.
 *
 * NUL separated for the same reason fingerprintInput() is: it makes the three parts
 * unambiguous, so no pair of (source, ref) values can ever collide by concatenation.
 */
export function openFingerprintInput(source, ref) {
  return `${OPEN_KIND}\x00${source}\x00${ref}`;
}

/**
 * A day stamp for the board, from a millisecond timestamp. The board shows a DATE and
 * never a time: a time would say when an operator was at their desk, which is nobody's
 * business and is not what the entry is about.
 */
export function dayStamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── The import route ──────────────────────────────────────────────────────────

/**
 * Upsert one batch. Returns { created, unchanged, closed }.
 *
 * NOTHING HERE PUBLISHES, and nothing here can. The route that calls this writes
 * `status = 'new'` as a literal, and 'new' is private on both feeds. An imported row
 * reaches a reader only when a person moves it with PATCH and types the sentence
 * themselves. Do not add a status argument to this function.
 *
 * An existing row is touched in exactly one case: its source has closed since the last
 * run and `source_closed_at` is still NULL. The operator's own columns (status,
 * public_note, public, duplicate_of) are never written here, so re-running the importer
 * over an item that has already been published as OPEN cannot walk it back to a draft.
 */
export async function upsertOpenItems(db, { source, items, now }) {
  if (!items.length) return { created: 0, unchanged: 0, closed: 0 };

  const prints = await Promise.all(items.map((item) => sha256Hex(openFingerprintInput(source, item.ref))));

  let existing;
  try {
    const res = await db
      .prepare(
        `SELECT fingerprint, source_closed_at
           FROM reports
          WHERE fingerprint IN (${prints.map(() => '?').join(',')})`,
      )
      .bind(...prints)
      .run();
    existing = new Map((res.results || []).map((r) => [r.fingerprint, r]));
  } catch (err) {
    return storeError('open items read', err);
  }

  /* EVERY IMPORTED ROW GETS A DISTINCT created_at, and this is not a nicety.
   *
   * The desk pages by keyset: `WHERE created_at < ?` with the last row's timestamp as the
   * cursor. That is exact only while timestamps are distinct, which they always were when
   * rows arrived one browser at a time. An import writes twenty five rows inside a single
   * invocation, so they all carry the same `now`, and the second page then skips EVERY row
   * that ties with the cursor.
   *
   * Measured on 2026-09-09 before this existed: 70 items imported, 65 reachable through
   * paging, and the five lost ones looked exactly like nothing had gone wrong.
   *
   * The base steps past the newest open item rather than trusting the clock, so two
   * batches a millisecond apart cannot collide either. It costs one indexed MAX.
   */
  let base = now;
  try {
    const newest = await db
      .prepare('SELECT MAX(created_at) AS newest FROM reports WHERE kind = ?')
      .bind(OPEN_KIND)
      .first();
    if (newest && typeof newest.newest === 'number') base = Math.max(now, newest.newest + 1);
  } catch (err) {
    return storeError('open items clock', err);
  }

  let created = 0;
  let unchanged = 0;
  let closed = 0;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const fingerprint = prints[i];
    const row = existing.get(fingerprint);

    if (!row) {
      try {
        const res = await db
          .prepare(
            `INSERT INTO reports
               (id, created_at, site, url, kind, body, status, public, fingerprint,
                source, source_ref, suggested, opened_at, source_closed_at)
             VALUES (?, ?, ?, '', ?, ?, 'new', 1, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(fingerprint) DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(),
            base + i,
            // `site` is NOT NULL and every open item needs a value. It holds the SOURCE
            // NAME, not a project: the project (where there is one) lives in source_ref,
            // which no public query selects. healthSites() excludes this kind for the
            // same reason, so an import can never be mistaken for a live Beacon.
            source,
            OPEN_KIND,
            item.text,
            fingerprint,
            source,
            item.ref,
            item.suggested || '',
            item.opened_at || now,
            item.closed_at || null,
          )
          .run();
        if (res.meta && res.meta.changes > 0) created += 1;
        else unchanged += 1;
      } catch (err) {
        return storeError('open items insert', err);
      }
      continue;
    }

    if (item.closed_at && !row.source_closed_at) {
      try {
        await db
          .prepare('UPDATE reports SET source_closed_at = ? WHERE fingerprint = ? AND source_closed_at IS NULL')
          .bind(item.closed_at, fingerprint)
          .run();
        closed += 1;
      } catch (err) {
        return storeError('open items close', err);
      }
      continue;
    }

    unchanged += 1;
  }

  return { created, unchanged, closed };
}

/**
 * Close every row of one source whose ref the importer did not see this run. Returns
 * { closed }.
 *
 * Resolved in JS from one SELECT rather than as `source_ref NOT IN (...)`, because D1
 * caps bound parameters at 100 per query: a NOT IN over every ref works today and starts
 * closing rows that are still open the day a source passes the cap. The importer refuses
 * to send a partial ref set for the same reason, since a partial set here reads as
 * "everything else is finished".
 */
export async function syncOpenSource(db, { source, refs, now }) {
  const seen = new Set(refs);
  let open;
  try {
    const res = await db
      .prepare(
        `SELECT fingerprint, source_ref
           FROM reports
          WHERE kind = ? AND source = ? AND source_closed_at IS NULL`,
      )
      .bind(OPEN_KIND, source)
      .run();
    open = res.results || [];
  } catch (err) {
    return storeError('open sync read', err);
  }

  const gone = open.filter((r) => !seen.has(r.source_ref)).map((r) => r.fingerprint);
  if (!gone.length) return { closed: 0 };

  let closed = 0;
  // Chunked well under D1's 100 bound parameters per query.
  for (let i = 0; i < gone.length; i += 50) {
    const chunk = gone.slice(i, i + 50);
    try {
      const res = await db
        .prepare(
          `UPDATE reports SET source_closed_at = ?
            WHERE source_closed_at IS NULL
              AND fingerprint IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(now, ...chunk)
        .run();
      closed += res.meta ? res.meta.changes : 0;
    } catch (err) {
      return storeError('open sync write', err);
    }
  }
  return { closed };
}

// ── The public board ──────────────────────────────────────────────────────────

/**
 * The board, as two arrays of { text, state, date } and NOTHING else.
 *
 * The SELECT names five columns one at a time, and that is the security property of this
 * file: `source`, `source_ref`, `body` and `site` are not in it, so no public response
 * can carry the tracker's own words, the private ref, or which project an item belongs
 * to. Adding a column here is how this board would become the map it exists not to be.
 *
 * `text` is `public_note`, which is the operator's sentence. It is the only string a
 * reader ever sees from this feed.
 *
 * RESOLVED IS FIRST, and it is first on purpose: a board that only grows is a graveyard,
 * so closing something has to be the most visible thing on the page.
 */
export async function board(db, { limit = BOARD_LIMIT_MAX } = {}) {
  const capped = Math.max(1, Math.min(limit, BOARD_LIMIT_MAX));
  const query = async (status, order) => {
    const res = await db
      .prepare(
        `SELECT public_note, status, opened_at, fixed_at, source_closed_at
           FROM reports
          WHERE kind = ? AND public = 1 AND status = ?
          ORDER BY ${order} DESC LIMIT ?`,
      )
      .bind(OPEN_KIND, status, capped)
      .run();
    return res;
  };

  try {
    // Two queries, which is inside the four-per-request budget the store keeps.
    const [resolvedRes, openRes] = [await query('fixed', 'fixed_at'), await query('accepted', 'opened_at')];
    const rowsRead =
      (resolvedRes.meta ? resolvedRes.meta.rows_read : 0) + (openRes.meta ? openRes.meta.rows_read : 0);
    return {
      resolved: (resolvedRes.results || []).map((r) => entry(r, 'resolved')).filter(Boolean),
      open: (openRes.results || []).map((r) => entry(r, 'open')).filter(Boolean),
      rowsRead,
    };
  } catch (err) {
    return storeError('board', err);
  }
}

/**
 * One line: a state, a sentence, a date. A row with no sentence is dropped rather than
 * rendered blank, which cannot happen through the desk (both publish moves require a
 * note) and is cheap insurance against a hand-written row.
 */
function entry(row, state) {
  const text = (row.public_note || '').trim();
  if (!text) return null;
  const at = state === 'resolved' ? row.fixed_at || row.opened_at : row.opened_at || row.fixed_at;
  return { text, state, date: dayStamp(at) };
}
