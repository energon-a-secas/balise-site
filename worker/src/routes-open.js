// The open-items feed: three routes, and not one of them can publish anything.
//
//   POST /open-items       one import batch          (Bearer, either credential)
//   POST /open-items/sync  what the importer saw     (Bearer, either credential)
//   GET  /board            the public board          (no auth, cacheable)
//
// C3 happens in src/index.js, which owns authentication, and the parsed body arrives
// here already read under the 8 KB cap. What is left in this file is the shape check and
// the call into src/store-open.js, so the reasoning that matters is easy to find:
//
// THE IMPORT CREDENTIAL CANNOT PUBLISH. The import routes write `status = 'new'`, which
// is private on both feeds, and the transition table gives the automation credential NO
// edge at all on kind = 'open'. So the worst a leaked import token can do is put text
// into a queue only the operator reads. That is why the importer is allowed to hold the
// automation token rather than the operator's.
//
// The board is the other half of the same rule: it reads five columns and returns three
// fields, and the only string on it is a sentence a person typed on purpose.

import { fail, ok } from './envelope.js';
import { validateOpenBatch, validateOpenSync, validateListQuery } from './validate.js';
import { STATUSES } from './store.js';
import {
  OPEN_SOURCES,
  IMPORT_BATCH_MAX,
  SYNC_REFS_MAX,
  BOARD_LIMIT_MAX,
  upsertOpenItems,
  syncOpenSource,
  board,
} from './store-open.js';

/** POST /open-items. Returns { created, unchanged, closed }. */
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
  }, { origin, env });
}

/**
 * POST /open-items/sync. Returns { closed }.
 *
 * Everything of that source NOT in the ref list is marked as having left its tracker.
 * That is a real decision made from an absence, so the importer sends the complete set
 * or nothing: a truncated list here would quietly close half the board.
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
export async function openBoard(request, env, { origin }) {
  const P = 'log';
  const params = validateListQuery(new URL(request.url).searchParams, STATUSES);
  if (params.code) return fail(params.code, { provider: P, origin, env, message: params.message, hint: params.hint });

  const limit = Math.min(params.value.limit, BOARD_LIMIT_MAX);
  const read = await board(env.DB, { limit });
  if (read.code) return fail(read.code, { provider: P, origin, env, message: read.message, hint: read.hint });

  return ok(P, { resolved: read.resolved, open: read.open, rows_read: read.rowsRead }, {
    origin,
    env,
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
