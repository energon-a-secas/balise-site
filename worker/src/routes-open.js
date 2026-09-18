// The open-items feed: four routes, and not one of them can publish anything.
//
//   POST /open-items       one import batch          (Bearer, either credential)
//   POST /open-items/sync  what the importer saw     (Bearer, either credential)
//   GET  /board            the public board          (no auth, cacheable, any origin)
//   GET  /board/summary    the board as counts       (no auth, cacheable, any origin)
//
// C3 happens in src/index.js, which owns authentication, and the parsed body arrives
// here already read under the 8 KB cap. What is left in this file is the shape check and
// the call into src/store-open.js.
//
// The import routes write `status = 'new'`, which is private on both feeds, and the transition
// table gives the automation credential no edge on kind = 'open'. The importer nonetheless holds
// the automation token, because the narrower import credential is not built; the resulting
// exposure is stated as open in docs/DESIGN-WORK-QUEUE.md section 10 and in the monorepo's
// docs/architecture/balise.md. Which fix to build is the owner's decision.
//
// The board reads six columns and returns three fields, and the only string on it is a sentence
// a person typed on purpose.

import { fail, ok } from './envelope.js';
import { validateOpenBatch, validateOpenSync, validateListQuery } from './validate.js';
import { STATUSES } from './store.js';
import {
  OPEN_SOURCES,
  IMPORT_BATCH_MAX,
  SYNC_REFS_MAX,
  BOARD_LIMIT_MAX,
  SUMMARY_WINDOW_DAYS,
  upsertOpenItems,
  syncOpenSource,
  board,
  boardSummary,
} from './store-open.js';

/**
 * Amendment A8: the two board reads answer any origin, so other sections of the fleet can
 * show them. Sent as an extra header with no origin passed to the envelope, so corsHeaders()
 * adds nothing and can never echo one origin beside the wildcard. Safe for exactly one
 * reason, which is also why it stops at these two routes: neither reads a credential, and
 * everything either one returns is already on the public page.
 */
const ANY_ORIGIN = { 'Access-Control-Allow-Origin': '*' };

const CACHED = { 'Cache-Control': 'public, max-age=300', ...ANY_ORIGIN };

/**
 * POST /open-items. Returns { source, created, unchanged, closed, reopened, rows_read }.
 *
 * `rows_read` is additive: no caller loses a field. It is here because this is the one import
 * read whose cost is NOT the size of what the caller sent. See upsertOpenItems in
 * src/store-open.js; the cost law is pinned in tests/local-d1-rows.test.mjs and the plan it
 * comes from in tests/local-d1-plans.test.mjs.
 *
 * docs/DESIGN-OPEN-ITEMS.md section 7 still lists the four counters without this field.
 */
export async function openImport(env, payload, { origin, now }) {
  const P = 'desk';
  const checked = validateOpenBatch(payload, OPEN_SOURCES, IMPORT_BATCH_MAX);
  if (checked.code) return fail(checked.code, { provider: P, origin, env, message: checked.message, hint: checked.hint });

  const result = await upsertOpenItems(env.DB, { ...checked.value, now });
  if (result.code) return fail(result.code, { provider: P, origin, env, message: result.message, hint: result.hint });

  return ok(P, {
    source: checked.value.source,
    created: result.created,
    unchanged: result.unchanged,
    closed: result.closed,
    reopened: result.reopened,
    rows_read: result.rowsRead,
  }, { origin, env });
}

/**
 * POST /open-items/sync. Returns { closed }.
 *
 * Everything of that source NOT in the ref list is marked as having left its tracker.
 * That is a real decision made from an absence, so the importer sends the complete set
 * or nothing: a truncated list here would quietly close half the board.
 *
 * It clears no mark. The next import batch that lists an item as open does, which is how a
 * close made here in error heals (upsertOpenItems says why the sync cannot).
 */
export async function openSync(env, payload, { origin, now }) {
  const P = 'desk';
  const checked = validateOpenSync(payload, OPEN_SOURCES, SYNC_REFS_MAX);
  if (checked.code) return fail(checked.code, { provider: P, origin, env, message: checked.message, hint: checked.hint });

  const result = await syncOpenSource(env.DB, { ...checked.value, now });
  if (result.code) return fail(result.code, { provider: P, origin, env, message: result.message, hint: result.hint });

  return ok(P, { source: checked.value.source, closed: result.closed }, { origin, env });
}

/**
 * GET /board. Public, no auth, cached for five minutes like the log.
 *
 * `rows_read` rides along for the same reason it does on /log: it counts rows SCANNED, and local
 * D1 enforces no quota, so a query that reads the table costs nothing here and everything in
 * production.
 *
 * Neither board read calls warnRowsRead. `rowsReadBudget` takes a page size and neither of these
 * reads is bounded by one. What they cost instead, as an equality over the populations that move
 * it, is written down and asserted in tests/local-d1-rows.test.mjs (section 'what the two board
 * reads cost'); the plan behind each of the four board statements is pinned by index name in
 * tests/local-d1-plans.test.mjs. Those two tests are where the numbers live, deliberately: the
 * copies that used to sit in this comment drifted from the measurement twice.
 *
 * The `app_id = 'fleet'` literals on the board statements belong to DESIGN.md 4.3 and contract
 * C6.5, asserted per statement in tests/tenant-scope.test.mjs and as a count over the database in
 * tests/tenant-invariants.test.mjs.
 */
export async function openBoard(request, env) {
  const P = 'log';
  const params = validateListQuery(new URL(request.url).searchParams, STATUSES);
  if (params.code) return fail(params.code, { provider: P, env, message: params.message, hint: params.hint, headers: ANY_ORIGIN });

  const limit = Math.min(params.value.limit, BOARD_LIMIT_MAX);
  const read = await board(env.DB, { limit });
  if (read.code) return fail(read.code, { provider: P, env, message: read.message, hint: read.hint, headers: ANY_ORIGIN });

  return ok(P, { resolved: read.resolved, open: read.open, rows_read: read.rowsRead }, { env, headers: CACHED });
}

/**
 * GET /board/summary. The board as numbers, for sections of the fleet that have room for
 * one line: how many published entries are open, how many of those are being worked on,
 * how many resolutions in the window, and the newest resolution's sentence. Published rows
 * only; see boardSummary() for why a draft may never move one of these numbers.
 */
export async function openBoardSummary(env, { now }) {
  const P = 'log';
  const read = await boardSummary(env.DB, { now });
  if (read.code) return fail(read.code, { provider: P, env, message: read.message, hint: read.hint, headers: ANY_ORIGIN });

  return ok(P, {
    window_days: SUMMARY_WINDOW_DAYS,
    open: read.open,
    in_progress: read.inProgress,
    resolved: read.resolved,
    latest: read.latest,
    rows_read: read.rowsRead,
  }, { env, headers: CACHED });
}
