// The open-items feed: four routes, and not one of them can publish anything.
//
//   POST /open-items       one import batch          (Bearer, either credential)
//   POST /open-items/sync  what the importer saw     (Bearer, either credential)
//   GET  /board            the public board          (no auth, cacheable, any origin)
//   GET  /board/summary    the board as counts       (no auth, cacheable, any origin)
//
// C3 happens in src/index.js, which owns authentication, and the parsed body arrives
// here already read under the 8 KB cap. What is left in this file is the shape check and
// the call into src/store-open.js, so the reasoning that matters is easy to find:
//
// THE IMPORT ROUTES CANNOT PUBLISH. They write `status = 'new'`, which is private on both
// feeds, and the transition table gives the automation credential NO edge at all on
// kind = 'open'. That is not the same as harmless. The importer holds the automation token
// only because the separate import credential that would narrow these routes is not built,
// and whoever else holds that token can do more than write drafts:
//
//   - read every report through GET /reports, a correction's contact included;
//   - plant an open-item draft under a tracker ref. It has no filed_by, so it is trusted
//     like the fleet's own (trustOf('open', null) is 'fleet'): the operator can hand it to
//     an agent in ship mode with no instruction, and a later import of the real line
//     reports it unchanged and leaves the planted text in place;
//   - mark items closed at their source, one at a time with `closed_at` on an import or
//     every row a sync leaves out, and clear that mark again with an import.
//
// docs/DESIGN-WORK-QUEUE.md section 10 and the monorepo's docs/architecture/balise.md state
// this as open. Which fix to build is the owner's decision.
//
// The board is the other half of the same rule: it reads six columns and returns three
// fields, and the only string on it is a sentence a person typed on purpose.

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

/** POST /open-items. Returns { created, unchanged, closed, reopened }. */
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
 * `rows_read` rides along for the same reason it does on /log: local D1 enforces no
 * quota, so that number and the assertion in tests/local-d1.test.mjs are the only things
 * that would notice this query starting to scan the table.
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
