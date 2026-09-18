// One of the six files in this Worker that contain SQL. Everything about the open-items
// board that touches D1 is here; src/store.js owns the corrections desk, src/store-public.js
// the two credential-free queries, src/store-auth.js the lockout, and src/store-work.js with
// src/store-work-runner.js the work queue. Each says so in its header.
//
// C6, AND WHY EVERY PREDICATE IN THIS FILE IS THE LITERAL 'fleet'.
//
// An open item is a row with kind = 'open', and invariant 4.3 says a row with kind = 'open'
// is ALWAYS the fleet's. That is not a hope about the data, it is a property of the writes:
// the only INSERT that sets kind = 'open' is in this file, it is reachable only through the
// two import routes, both of which need the operator's or the automation credential, and it
// writes app_id = 'fleet' as a literal. Nothing else in the Worker writes that kind.
//
// So no function here takes a scope, and none should be given one. The board is the FLEET's
// board: it is served at addresses with no credential on them, and C6.5 is that a public
// query names its tenant as a literal so that no tenant row CAN be published, whatever a
// caller sends. A bound parameter would move that guarantee out to every call site.
//
// The literals are still written on every statement rather than left implicit in the kind,
// because a `kind = 'open'` term is an invariant one edit away from being wrong, and the
// cost of the second term on a row set that all matches is a per-row check that rows_read
// does not notice. The invariant is asserted, not assumed: tests/tenant-scope.test.mjs
// counts the rows that would break it and requires zero.
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
//   2. rows_read counts rows SCANNED, and the indexes these queries sit on come from THREE
//      migrations rather than one. This note used to say every query here sits on an index from
//      migrations/0002_open_items.sql, which stopped being true when 0004 added the
//      app_id-leading indexes. What is true, by the plans pinned in
//      tests/local-d1-plans.test.mjs: the board's open list seeks reports_board from 0002, the
//      resolved list and the summary's newest resolution are both served by reports_public_log
//      from 0001_baseline.sql, and the summary's count is on reports_app_status_created from
//      0004_tenants.sql (A28 has the numbers and why that cost is accepted knowingly).
//      tests/open-items.test.mjs asserts the desk and board budgets.
//
//      THE FLEET TERM MOVED FOUR OF THESE STATEMENTS, AND WHICH FOUR DEPENDS ON THE BATCH SIZE.
//      Re-measured 2026-09-18 with make d1-query, each statement against itself without the term,
//      and at IN-list sizes 1, 2, 3 and 50. The threshold is the part that matters: a statement
//      whose fingerprint term is `= ?` keeps the UNIQUE reports_fp, and so does an IN list of one
//      or two entries, but AT THREE ENTRIES SQLITE ABANDONS reports_fp AND SEEKS ON app_id ALONE.
//
//        the dedupe read below    IN 1 or 2: reports_fp on (fingerprint). IN 3 or more:
//                                 reports_app_site_created on (app_id), walking the fleet's half
//                                 of the table and testing the fingerprint per row. The real
//                                 batches are 25, so this is the plan production runs.
//        the sync's chunked write  the same threshold and the same pair of plans. The chunks are
//                                 50, so again the wide plan is the one that runs. An earlier
//                                 reading of this file said this write was unmoved; that was
//                                 measured with a short IN list and it is wrong.
//        the sync's read          reports_app_site_created on (app_id), where it took
//                                 reports_open_status_created on (kind): one prefix seek for
//                                 another, on terms that both match nearly every row.
//        the INSERT's inner MAX   reports_app_created on (app_id), where it had a covering seek
//                                 on reports_open_created. Still one indexed MAX per row.
//
//      The two single-fingerprint UPDATEs (close and reopen) are genuinely unmoved: `= ?` on a
//      UNIQUE index, reports_fp, at any batch size.
//
//      ALL THREE WIDE PLANS ARE NOW PINNED, by SEEK SHAPE rather than by index name, in
//      tests/local-d1-plans.test.mjs, which carries the argument for that choice and the reason
//      every IN list there is three long; the cost is pinned through the route in
//      tests/local-d1-rows.test.mjs, which is why upsertOpenItems returns rowsRead and
//      POST /open-items reports it. This paragraph is no longer the whole record.
//
//      Note also that reports_app_site_created is what serves the wide plans, so it is not the
//      dead weight A21 took it for. And do not move a term to change any of this: A28 settled
//      that position is not the mechanism, presence is.
//
//      WHAT WOULD FIX IT IS AN INDEX, AND AN INDEX IS NOT THIS FILE'S TO ADD. Reported to
//      delivery-lead in the phase 2 pass 0 report for data-engineer. Do not "fix" the dedupe read
//      by dropping the tenant term: the comment on the statement says what the term is for.
//
// D1 also caps BOUND PARAMETERS per query at 100, which is why the sync route resolves
// what to close in JS from one small SELECT instead of sending the whole ref set into a
// NOT IN list that would silently overflow once a source grows.

import { sha256Hex, storeError } from './store.js';
import { cleanSuggestion } from './suggestion.js';
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
 * Upsert one batch. Returns { created, unchanged, closed, reopened, rowsRead }.
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
  if (!items.length) return { created: 0, unchanged: 0, closed: 0, reopened: 0, rowsRead: 0 };

  const prints = await Promise.all(items.map((item) => sha256Hex(openFingerprintInput(source, item.ref))));

  /* WHAT THIS BATCH COSTS IN ROWS SCANNED, and why the number leaves the store (phase 2 pass 0).
   *
   * Summed across every statement this function runs and returned, so POST /open-items reports it
   * the way /reports, /log, /board and /work already do. It is not a nicety here: the dedupe read
   * below plans onto `app_id` alone as soon as the IN list reaches three entries, so its cost is
   * the size of the FLEET's half of the table and not the size of the batch. Nothing in this
   * repository could see that before, because the importer's route was the one read with no
   * rows_read on it. Measured and pinned in tests/local-d1-rows.test.mjs; the plans are pinned in
   * tests/local-d1-plans.test.mjs. A4's warnRowsRead is deliberately NOT called on it: a batch has
   * a size but not a `limit`, and rowsReadBudget is a budget for a page. */
  let rowsRead = 0;
  const spent = (res) => {
    if (res && res.meta && typeof res.meta.rows_read === 'number') rowsRead += res.meta.rows_read;
    return res;
  };

  let existing;
  try {
    const res = await db
      .prepare(
        // C6: the tenant literal, and here it does real work rather than restating the
        // kind. A fingerprint is looked up ACROSS kinds by the UNIQUE index, so without
        // this term a tenant row whose fingerprint collided with an open item's would be
        // read as an existing open item and the import would take the UPDATE branch
        // against someone else's row. A11 makes such a collision improbable; the term
        // makes it impossible.
        `SELECT fingerprint, source_closed_at
           FROM reports
          WHERE app_id = 'fleet' AND fingerprint IN (${prints.map(() => '?').join(',')})`,
      )
      .bind(...prints)
      .run();
    spent(res);
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
            // C6: `app_id` is WRITTEN here, as the literal 'fleet', and this is the write
            // that makes invariant 4.3 true. The inner MAX carries the same literal, so
            // the cursor an open row takes is one past the newest FLEET open row: a tenant
            // row could not be one of these anyway (nothing gives a tenant this kind), but
            // the subquery is a read over `reports` and C6 admits no unpredicated read.
            // ON CONFLICT(fingerprint) is UNCHANGED: A11 keeps `reports_fp` UNIQUE on the
            // one column, and naming a different index here is exactly what it avoids.
            `INSERT INTO reports
               (id, created_at, site, url, kind, body, status, public, fingerprint,
                source, source_ref, suggested, opened_at, source_closed_at, app_id)
             VALUES (?, MAX(?, COALESCE((SELECT MAX(created_at) FROM reports
                                          WHERE kind = ? AND app_id = 'fleet'), 0) + 1),
                     ?, '', ?, ?, 'new', 1, ?, ?, ?, ?, ?, ?, 'fleet')
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
            // Redacted HERE and not only in the importer, because whoever holds the
            // automation token does not have to be the importer, and this is the field the
            // desk prefills into the sentence box.
            cleanSuggestion(item.suggested),
            item.opened_at || now,
            item.closed_at || null,
          )
          .run();
        spent(res);
        if (res.meta && res.meta.changes > 0) created += 1;
        else unchanged += 1;
      } catch (err) {
        return storeError('open items insert', err);
      }
      continue;
    }

    if (item.closed_at && !row.source_closed_at) {
      try {
        const res = await db
          // C6: keyed by fingerprint, so the tenant literal is what stops a collision from
          // aiming this write at a row outside the fleet. Same reason as the read above.
          .prepare(`UPDATE reports SET source_closed_at = ?
                     WHERE app_id = 'fleet' AND fingerprint = ? AND source_closed_at IS NULL`)
          .bind(item.closed_at, fingerprint)
          .run();
        // COUNTED FROM `changes`, NOT FROM THE BRANCH, the same as the create above and the
        // reopen below. This used to be an unconditional `closed += 1`, which reported a close
        // the database had declined: the tenant literal is a third way for this UPDATE to match
        // no row, so a row handed to a tenant between the read and this write answered
        // `closed: 1` while its mark stayed where it was.
        spent(res);
        if (res.meta && res.meta.changes > 0) closed += 1;
        else unchanged += 1;
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
          // C6: the tenant literal, for the same reason as the close above.
          .prepare(`UPDATE reports SET source_closed_at = NULL
                     WHERE app_id = 'fleet' AND fingerprint = ? AND source_closed_at IS NOT NULL`)
          .bind(fingerprint)
          .run();
        spent(res);
        if (res.meta && res.meta.changes > 0) reopened += 1;
        else unchanged += 1;
      } catch (err) {
        return storeError('open items reopen', err);
      }
      continue;
    }

    unchanged += 1;
  }

  return { created, unchanged, closed, reopened, rowsRead };
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
        // C6: the tenant literal. The kind term already implies it by invariant 4.3, and it
        // is written anyway because this SELECT decides what the chunked UPDATE below will
        // close, so it is the widest read in the file.
        `SELECT fingerprint, source_ref
           FROM reports
          WHERE app_id = 'fleet' AND kind = ? AND source = ? AND source_closed_at IS NULL`,
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
          // C6: the tenant literal. This write takes a LIST of fingerprints, so it is the
          // one statement here where a single collision could reach fifty rows at once.
          `UPDATE reports SET source_closed_at = ?
            WHERE app_id = 'fleet' AND source_closed_at IS NULL
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
        // C6.5: the tenant term is the LITERAL 'fleet' and never a parameter. GET /board
        // reads no credential and answers 65 origins (A8), so a bound key here would put
        // "no tenant row can be published" in the hands of whatever called this. Written
        // as a literal, this query cannot select one.
        //
        // ONE STATEMENT, TWO PLANS, and the position of the literal decides neither.
        // SQLite reorders WHERE terms itself, so the plan is identical with this term
        // first, last or absent: what moves a plan is the PRESENCE of an app_id term,
        // never where it is written. A28 corrects A18, which said "last" placement was
        // what kept reports_board selected. Measured 2026-09-18 with make d1-query, and
        // pinned by index name in tests/local-d1-plans.test.mjs:
        //
        //   accepted / opened_at   SEARCH reports USING INDEX reports_board, sought on
        //                          (kind, public, status), then USE TEMP B-TREE FOR ORDER BY
        //   fixed / fixed_at       SEARCH reports USING INDEX reports_public_log, sought on
        //                          (status, public)
        //
        // So the open list does keep the full three-term seek on reports_board from
        // migrations/0002_open_items.sql, and the resolved list was never on that index at
        // all: reports_public_log serves it, which is why A29 withdrew the suggestion that
        // that index is dead weight. There is still no tenant twin of either index and 4.2
        // says why there should not be. Do not move this term to make a plan happen; it
        // cannot. The one statement whose seek the term does narrow is the count in
        // boardSummary below, and the note there has the numbers.
        `SELECT public_note, status, opened_at, fixed_at, source_closed_at, work_state
           FROM reports
          WHERE kind = ? AND public = 1 AND status = ? AND app_id = 'fleet'
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
 * many resolutions in the window, and the newest resolution's sentence. Two queries, on two
 * DIFFERENT indexes, and neither of them is the index that serves the open half of the board.
 *
 * That opening line read "Two queries, both on the index that serves the board" until phase 2,
 * and A28's own measurement fifteen lines below it had already refuted it (A36 finding C). The
 * four board plans, all pinned in tests/local-d1-plans.test.mjs:
 *
 *   /board, open list      reports_board                 three-term seek, plus a temp b-tree
 *   /board, resolved list  reports_public_log
 *   summary, counts        reports_app_status_created    the literal's cost, below
 *   summary, latest        reports_public_log            the one index the two routes share
 *
 * So "both" was wrong, "the index" was wrong, and one of the two is an index no board query
 * touches. The sentence was true when it was written and the measurement that made it false was
 * added UNDERNEATH it rather than over it. A docstring's first line is what a reader believes,
 * so a measurement that contradicts one is an edit to it and not a paragraph after it.
 *
 * PUBLISHED ROWS ONLY. Every term carries `public = 1` and a published status. A number
 * that moved when a private draft moved would let anyone watching it learn when the desk is
 * busy with things nobody published, which is the side channel this endpoint must not be.
 *
 * FLEET ROWS ONLY, for the same class of reason and by the same kind of term. Both queries
 * carry `app_id = 'fleet'` as a LITERAL (C6.5): a count that moved when a tenant's item
 * moved would be exactly the side channel above, one tenant wide, on an endpoint with no
 * credential on it.
 *
 * WHAT THAT TERM COSTS THE COUNT, MEASURED. A18 said the literal's placement kept
 * reports_board selected and DESIGN.md 4.2 line 931 says `rows_read` "does not move" here.
 * Both are wrong for this statement, and placement is not the mechanism either way: SQLite
 * reorders WHERE terms itself, so what moves the plan is the PRESENCE of an app_id term.
 * Measured 2026-09-18 with make d1-query (A28). The seek keys are written as column lists
 * rather than in EXPLAIN's own notation on purpose: tests/tenant-scope.test.mjs greps this
 * whole file, comments included, for a BOUND app_id, and a pasted plan line would trip it.
 *
 *   counts, as shipped    SEARCH reports USING INDEX reports_app_status_created,
 *                         sought on (app_id, status)
 *   counts, no literal    SEARCH reports USING INDEX reports_board,
 *                         sought on (kind, public, status)
 *   latest, either way    SEARCH reports USING INDEX reports_public_log,
 *                         sought on (status, public)
 *
 * So the count's seek narrows from three terms to two and `kind` and `public` become
 * per-row tests: 208 index entries walked where the three-term seek walked 6, on the
 * population the measurement was taken against. NO COVERING INDEX WAS LOST and nobody
 * should go looking for one. This statement also reads `work_state` and `fixed_at` and
 * neither is in reports_board, so the table lookup happens under both plans; a
 * SELECT COUNT(*) proxy says otherwise and is the wrong query.
 *
 * THE COST IS ACCEPTED KNOWINGLY AND THE TERM STAYS (A28, the same reasoning as A17). This
 * route carries no credential and is cacheable for five minutes, 202 extra index entries at
 * this volume is nothing, and the term is the only thing that stops it publishing a
 * tenant's counts if invariant 4.3 ever breaks. A fourth-term index would restore the seek
 * and was refused: at 208 rows it does not earn an index write on every insert, so there is
 * no 0005 to write for this. Both plans are pinned by index name in
 * tests/local-d1-plans.test.mjs.
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
          WHERE kind = ? AND public = 1 AND status IN ('accepted', 'fixed') AND app_id = 'fleet'`,
      )
      .bind(...IN_PROGRESS_STATES, since, OPEN_KIND)
      .run();
    const latest = await db
      .prepare(
        `SELECT public_note, status, opened_at, fixed_at, source_closed_at, work_state
           FROM reports
          WHERE kind = ? AND public = 1 AND status = 'fixed' AND app_id = 'fleet'
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
