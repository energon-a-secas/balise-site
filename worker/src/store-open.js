// One of the four files in this Worker that contain SQL. Everything about the open-items
// board that touches D1 is here; src/store.js owns the corrections half, and
// src/store-work.js with src/store-work-runner.js the work queue. Each says so in its header.
//
// The split is by FEED, not by table: an open item is a row in `reports` with
// kind = 'open', so C3's token gate, C4's transition guard, C5's rendering rule and the
// keyset paging all apply to it unchanged. What is different is where the row comes from
// (an importer, never a stranger) and where it goes (a board, never the corrections log).
//
// The same two D1 limits shape this file as shape store.js:
//
//   1. 50 queries per invocation. THIS IS WHY A BATCH IS 25 AND NOT 100. An import batch
//      costs one SELECT plus at most one write per item, so 25 items is 26 queries with
//      room to spare, and a second run of the same batch costs one, because every item is
//      already there and nothing is written.
//   2. rows_read counts rows SCANNED. Every query below sits on an index created in
//      migrations/0002_open_items.sql, and tests/local-d1.test.mjs asserts the budget.
//
// D1 also caps BOUND PARAMETERS per query at 100, which is why the sync route resolves
// what to close in JS from one small SELECT instead of sending the whole ref set into a
// NOT IN list that would silently overflow once a source grows.

import { sha256Hex, storeError } from './store.js';
import { IN_PROGRESS_STATES } from './work.js';

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
 * Upsert one batch. Returns { created, unchanged, closed, reopened }.
 *
 * NOTHING HERE PUBLISHES, and nothing here can. The route that calls this writes
 * `status = 'new'` as a literal, and 'new' is private on both feeds. An imported row
 * reaches a reader only when a person moves it with PATCH and types the sentence
 * themselves. Do not add a status argument to this function.
 *
 * An existing row is touched in exactly two cases, and only in `source_closed_at`: the item
 * arrives with a `closed_at` and the row is not marked closed, which marks it; or the item
 * arrives with none and the row is marked, which clears the mark and counts as reopened.
 * The operator's own columns (status, public_note, public, duplicate_of) are never written
 * here, so re-running the importer over an item that has already been published as OPEN
 * cannot walk it back to a draft.
 *
 * THE MARK CLEARS HERE AND NEVER IN THE SYNC. A batch is the one request that says whether
 * an item is open at its tracker: the importer sends a `## Done` queue line with its
 * `closed_at` and an open line without one. A sync lists every ref the importer SAW, Done
 * lines included, so a ref being in it says nothing about the item being open, and clearing
 * there would undo every Done item's mark on every run. So a wrong close, from a sync that
 * left refs out or a `closed_at` sent by mistake, heals on the next honest import.
 */
export async function upsertOpenItems(db, { source, items, now }) {
  if (!items.length) return { created: 0, unchanged: 0, closed: 0, reopened: 0 };

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

  /* EVERY OPEN ROW GETS A DISTINCT created_at, and this is not a nicety.
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
   * Each INSERT takes its created_at inside itself: one past the newest open row at the
   * moment it runs, and never earlier than `now`. The same form as insertDirectItem in
   * src/store-work.js, and for the same reason. This used to read that MAX once and count up
   * from it, and a filing that landed between two of the INSERTs took the value the next one
   * was about to write, because D1 runs each statement on its own. It costs one indexed MAX
   * per row, inside the write, so the batch's query count does not move.
   */
  let created = 0;
  let unchanged = 0;
  let closed = 0;
  let reopened = 0;

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
             VALUES (?, MAX(?, COALESCE((SELECT MAX(created_at) FROM reports WHERE kind = ?), 0) + 1),
                     ?, '', ?, ?, 'new', 1, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(fingerprint) DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(),
            now,
            OPEN_KIND,
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

    // Its tracker lists it as open, so the mark on the row is wrong now. See the note above
    // this function for why this is the only place the mark is ever cleared.
    if (!item.closed_at && row.source_closed_at) {
      try {
        const res = await db
          .prepare('UPDATE reports SET source_closed_at = NULL WHERE fingerprint = ? AND source_closed_at IS NOT NULL')
          .bind(fingerprint)
          .run();
        if (res.meta && res.meta.changes > 0) reopened += 1;
        else unchanged += 1;
      } catch (err) {
        return storeError('open items reopen', err);
      }
      continue;
    }

    unchanged += 1;
  }

  return { created, unchanged, closed, reopened };
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
 *
 * It never clears a mark. The list is every ref the importer saw, a `## Done` queue line
 * included, so a ref being in it is no evidence the item is open. An import batch carries
 * that evidence, and upsertOpenItems is where a close made here in error heals.
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

/** The window GET /board/summary counts resolutions over, in days. */
export const SUMMARY_WINDOW_DAYS = 30;

/**
 * The board, as two arrays of { text, state, date } and NOTHING else.
 *
 * The SELECT names six columns one at a time, and that is the security property of this
 * file: `source`, `source_ref`, `body` and `site` are not in it, so no public response
 * can carry the tracker's own words, the private ref, or which project an item belongs
 * to. Adding a column here is how this board would become the map it exists not to be.
 *
 * The sixth, `work_state`, is the one column added since, and it earns its place by saying
 * only WHETHER a published item is moving (docs/DESIGN-WORK-QUEUE.md section 6): an open
 * entry becomes `in_progress`, and nothing says who is on it, how, or where.
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
        `SELECT public_note, status, opened_at, fixed_at, source_closed_at, work_state
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
 * GET /board/summary: how many published open entries, how many of those are moving, how
 * many resolutions in the window, and the newest resolution's sentence. Two queries, both
 * on the index that serves the board.
 *
 * PUBLISHED ROWS ONLY. Every term carries `public = 1` and a published status. A number
 * that moved when a private draft moved would let anyone watching it learn when the desk is
 * busy with things nobody published, which is the side channel this endpoint must not be.
 */
export async function boardSummary(db, { now, windowDays = SUMMARY_WINDOW_DAYS }) {
  const since = now - windowDays * 24 * 60 * 60 * 1000;
  const moving = IN_PROGRESS_STATES.map(() => '?').join(',');
  try {
    const counts = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS open_count,
                COALESCE(SUM(CASE WHEN status = 'accepted' AND work_state IN (${moving}) THEN 1 ELSE 0 END), 0) AS moving_count,
                COALESCE(SUM(CASE WHEN status = 'fixed' AND fixed_at >= ? THEN 1 ELSE 0 END), 0) AS resolved_count
           FROM reports
          WHERE kind = ? AND public = 1 AND status IN ('accepted', 'fixed')`,
      )
      .bind(...IN_PROGRESS_STATES, since, OPEN_KIND)
      .run();
    const latest = await db
      .prepare(
        `SELECT public_note, status, opened_at, fixed_at, source_closed_at, work_state
           FROM reports
          WHERE kind = ? AND public = 1 AND status = 'fixed'
          ORDER BY fixed_at DESC LIMIT 1`,
      )
      .bind(OPEN_KIND)
      .run();

    const row = (counts.results || [])[0] || {};
    const newest = entry((latest.results || [])[0] || {}, 'resolved');
    return {
      open: row.open_count || 0,
      inProgress: row.moving_count || 0,
      resolved: row.resolved_count || 0,
      latest: newest ? { text: newest.text, date: newest.date } : null,
      rowsRead: (counts.meta ? counts.meta.rows_read : 0) + (latest.meta ? latest.meta.rows_read : 0),
    };
  } catch (err) {
    return storeError('board summary', err);
  }
}

/**
 * One line: a state, a sentence, a date. A row with no sentence is dropped rather than
 * rendered blank, which cannot happen through the desk (both publish moves require a
 * note) and is cheap insurance against a hand-written row.
 *
 * An open entry an agent is working on says `in_progress` instead. A client that has
 * never heard the word shows it as open, which is still true.
 */
function entry(row, state) {
  const text = (row.public_note || '').trim();
  if (!text) return null;
  const at = state === 'resolved' ? row.fixed_at || row.opened_at : row.opened_at || row.fixed_at;
  const shown = state === 'open' && IN_PROGRESS_STATES.includes(row.work_state) ? 'in_progress' : state;
  return { text, state: shown, date: dayStamp(at) };
}
