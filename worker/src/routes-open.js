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

/**
 * POST /open-items. Returns { source, created, unchanged, closed, reopened, rows_read }.
 *
 * `rows_read` is new in phase 2 pass 0 and it is additive: no caller loses a field. It is here
 * because this was the last read in the Worker with no cost read-back on it, and it is the one
 * whose cost is NOT the size of what the caller sent. See upsertOpenItems in src/store-open.js:
 * the dedupe read seeks on `app_id` alone once the batch reaches three items, so a 25-item import
 * scans the fleet's half of the table. tests/local-d1-rows.test.mjs pins that as a law and
 * tests/local-d1-plans.test.mjs pins the plan it comes from.
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
 * `rows_read` rides along for the same reason it does on /log: local D1 enforces no
 * quota, so that number is the only thing that would notice this query starting to scan
 * the table. Three tests read it, and none is on this file's side of the wire:
 * tests/open-items.test.mjs, tests/local-d1-rows.test.mjs, which asserts the law below by
 * EQUALITY, and tests/local-d1-plans.test.mjs, which pins both board plans by index name.
 *
 * NEITHER BOARD ROUTE CALLS warnRowsRead, AND THAT IS NOW A DECISION RATHER THAN A DEFERRAL.
 * Phase 1's review condition C2 asked for the call on both, on the reading that /board has a
 * `limit` so `rowsReadBudget(limit)` applies to it. Measured through these two routes, it does
 * not. FOUR populations of `reports` move these numbers, not two, and naming all four is the
 * whole point of writing them down (re-measured 2026-09-18, pass 0b, ten populations with each
 * term moved on its own through the real PATCH route):
 *
 *   O     published entries: fleet rows at kind='open', public=1, status='accepted'
 *   Ra    ALL published resolutions: every row at status='fixed' AND public=1, any tenant,
 *         either kind. Unscoped, and that is the finding rather than a detail; see below.
 *   Af    fleet rows at status='accepted', WHATEVER their kind and visibility
 *   Ff    fleet rows at status='fixed', WHATEVER their kind and visibility
 *   rank  how far down the published resolutions the newest FLEET entry's resolution sits,
 *         counted over Ra in fixed_at DESC order. A RANK AND NOT A COUNT: one tenant
 *         resolution newer than the fleet's costs this term 1, and 300 of them cost it 300.
 *
 *   GET /board            rows_read = 2 x O + Ra + 2      independent of `limit`
 *   GET /board/summary    rows_read = Af + Ff + rank + 4  it has no `limit`
 *
 * Exact at all ten. The trailing constant is one per statement whose seek range is NOT empty, so
 * a board with nothing published of some kind pays less: measured 7 rather than 8 for /board at
 * O=3 with Ra=0, and 6 rather than 7 for the summary at Af=3, Ff=0, rank=0. Read both constants
 * as the upper bound they are at a board that has published anything at all.
 *
 * WHAT THE SUMMARY'S LAW USED TO SAY HERE, and how it was got wrong, because the shape repeats.
 * This block said `rows_read = O + 2 x R + 3`, from four populations that only ever moved O and
 * R together. Both statements behind the summary seek on terms that EXCLUDE kind and public
 * (counts on (app_id, status), latest on (status, public)), so a private draft at `accepted` and
 * a resolved CORRECTION each cost rows while moving neither O nor R: holding O and R fixed and
 * adding seven such rows moved the number from 14 to 21 while the old law predicted 15 at all
 * three populations. A curve fitted to a fixture is not a law, and four points that move two
 * variables in step cannot tell the two apart. The four terms above were derived from the SQL
 * first and then measured against populations built to move one term at a time.
 *
 * Three things follow and all three are why a runtime threshold is the wrong instrument here:
 *
 *   1. /board SCANS THE SAME NUMBER OF ROWS AT limit=5 AS AT limit=50. Its open half is on
 *      reports_board, whose trailing column is created_at while the sort is on opened_at, so
 *      SQLite walks every matching entry into a temp b-tree before LIMIT applies. A budget
 *      keyed on `limit` is not a budget for this query in either direction.
 *   2. EVERY TERM GROWS WITH THE BOARD EXISTING, without bound and without any query getting
 *      worse. At the two published resolutions this Worker's fixture has, /board crosses
 *      rowsReadBudget(50) = 110 at O = 54: 2 x 53 + 2 + 2 is exactly 110 and O = 54 is the
 *      first count over it. Fifty-four entries is an ordinary working board. A threshold that
 *      logs there is a warning whoever meets it will delete, and one set past it detects
 *      nothing. (This said 61, which is not reachable under the law at all: 2 x 60 + 2 is
 *      already 122. The 61 came from a mixed population and was read back as a property of
 *      the route.)
 *   3. Both numbers move with rows on NO board at all, which is what Af, Ff and rank say: a
 *      resolved CORRECTION costs /board 1 and the summary 2, a PRIVATE accepted draft costs
 *      the summary 1, and a tenant's published resolution costs /board 1 and the summary 1.
 *      So even a per-entry ratio computed from what the route RETURNED is not a bound.
 *
 * So the detector is the equality assertion in tests/local-d1-rows.test.mjs, not a console.warn
 * against a constant. It measures all four terms from the database and asserts the law, so it is
 * red when the COST OF A ROW changes and silent when the board is merely busy.
 *
 * Two things it is honestly not. It is a build-time check against a fixture, so it cannot see a
 * production population. And it is only PARTLY a scope test, which pass 0b measured rather than
 * assumed: deleting `app_id = 'fleet'` from each of the three board statements in turn, one at a
 * time, against this fixture.
 *
 *   summary, counts    RED     the one statement that spans every kind. Unscoped it walks the
 *                              tenant's rows too, so Af + Ff no longer bound it.
 *   /board             green   both arms filter kind = 'open'
 *   summary, latest    green   filters kind = 'open'
 *
 * The two greens are not holes in the assertion, and this is the useful part: on those statements
 * the literal is REDUNDANT TO THE COST, because no row a `kind = 'open'` seek can reach belongs to
 * a tenant. A rows_read law cannot detect the removal of a predicate that excludes nothing, and no
 * measurement will ever make it. What makes those two literals load-bearing is DESIGN.md 4.3, and
 * what holds 4.3 is a COUNT in tests/tenant-invariants.test.mjs, not this file's arithmetic.
 * (A39 reported two of three blind, which is still the count. The set is not the same set, and the
 * reason per statement is what was missing.)
 *
 * WHICH LEAVES A GAP, MEASURED IN THE SAME PASS AND NOT CLOSED IN IT. Deleting that one literal
 * from the summary's `latest` statement turns NOTHING in the suite red. The C6.5 structural
 * assertion in tests/tenant-scope.test.mjs is `literals.length >= 2` over the whole file, and this
 * file's store carries eleven, so nine of them can go while it stays green: it is COUNTED where it
 * needed to be per statement, which is the same defect A39 filed against the credential matcher
 * one test down. So do not delete a fleet literal on the strength of a green suite. Reported to
 * delivery-lead in the pass 0b report and qa-engineer's to close; not touched here, because this
 * pass was scoped to the credential matcher and widening it silently is how a gate loses its
 * meaning.
 *
 * WHAT IS STILL UNDETECTED, so nobody has to rediscover it: growth in PRODUCTION. The law says
 * a 500-entry board costs about 1,000 rows_read per uncached request, and nothing in this
 * repository would notice that. It is not a query regression, it is the shape of the index, and
 * an index is data-engineer's. Reported to delivery-lead in the phase 2 pass 0 report, not
 * fixed here.
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
