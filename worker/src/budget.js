// What a page is allowed to cost in rows SCANNED, and the line that says so out loud.
//
// Two functions and no SQL. They were in src/store.js and src/index.js respectively until the
// router split, and they are here rather than in either for two reasons. The warning belongs
// beside the budget it compares against or the two drift; and once the route bodies left
// src/index.js, two files needed the warning, so it could not stay module-private in a file
// that both of them are imported BY (src/index.js imports them, so either arrow back would
// close a cycle). This module imports nothing, so every file in the Worker can reach it and
// none of them can create a cycle doing so.
//
// It is also what kept src/store.js under the 500 line cap that the split exists to honour.

/**
 * What a keyset page of `limit` rows should cost in rows SCANNED.
 *
 * The multiplier is not a guess. Measured against local D1 with 104 rows on 2026-08-29,
 * every keyset page read EXACTLY `limit` rows, at limits of 1, 5, 25 and 50, filtered and
 * unfiltered. Dropping reports_created and reports_status_created and repeating the same
 * requests read 208 rows for a page of 5, so the indexes are load bearing and the gap
 * between the two numbers is wide. Doubling the measurement and adding ten leaves room
 * for a range scan stepping over non-matching rows without leaving room for a table scan.
 *
 * THAT MEASUREMENT IS FROM BEFORE migrations/0004_tenants.sql AND IT DID NOT INCLUDE kind=open.
 * "Every keyset page read exactly `limit` rows" is no longer true of every page: read the
 * enumeration on warnRowsRead below before quoting this paragraph. The budget itself is
 * unchanged, because what moved is a query's cost and not what a page ought to cost.
 *
 * IT IS A BUDGET FOR A PAGE, so it takes a `limit` and only a route with one may use it. The
 * fixed-shape reads have no limit to hand it and are bounded a different way: see the growth
 * law written down at the foot of src/routes-open.js.
 */
export function rowsReadBudget(limit) {
  return limit * 2 + 10;
}

/**
 * A4's read-back. rows_read counts rows SCANNED and not rows returned, and local D1 enforces no
 * quota at all, so locally a query that walks the table answers as quickly as one that seeks and
 * the difference is only visible in this number. That is why the number is printed here and
 * asserted against these budgets in tests/local-d1-rows.test.mjs.
 *
 * IT LOGS AND DOES NOTHING ELSE. It has exactly two callers, GET /log in src/routes-public.js
 * and GET /reports in src/routes-desk.js, and the first of those is cacheable and public, so it
 * may never touch a response body, a status, a header or the cache policy: a caller that starts
 * branching on this function has turned an observation into behaviour, and a warning that can
 * change an answer is a warning nobody may leave switched on. It returns undefined on both
 * arms for that reason, so there is nothing for a caller to branch on, and 'C2: warnRowsRead
 * observes and returns nothing' in tests/api.test.mjs is what holds that: it captures
 * console.warn and requires undefined from both arms and from a rows_read that is not a number.
 * That much is unchanged, and it is the load-bearing half: nothing here may become behaviour.
 *
 * IT FIRES THROUGH A ROUTE, ON THE DESK'S DEFAULT VIEW, TODAY. This block said the opposite in
 * capitals until pass 0b: "NO POPULATION CAN PUT A KEYSET PAGE OVER ITS OWN BUDGET ... so the
 * warning has never fired through a route and cannot be made to". It is false. Measured through
 * the real handler under workerd, on a scratch local D1 carrying 50 imported open items under 96
 * newer fleet corrections with the tenant fixture planted (re-measured twice on 2026-09-18, pass
 * 0c):
 *
 *   GET /reports?kind=open&limit=1     returned  1   rows_read  96   budget  12   OVER
 *   GET /reports?kind=open&limit=5     returned  5   rows_read 101   budget  20   OVER
 *   GET /reports?kind=open&limit=25    returned 25   rows_read 121   budget  60   OVER
 *   GET /reports?kind=open&limit=50    returned 50   rows_read 146   budget 110   OVER
 *
 * The bottom three repeated to the row on both runs. The limit=1 cell did not: 97 on one run and
 * 96 on the other, same population both times, so read that one as 96 or 97 and not as a constant.
 *
 * No index serves `app_id = ? AND kind = 'open'` in created_at order, so under that filter the
 * kind term is a per-row test over reports_app_created and every newer correction is walked and
 * discarded. The cost is (fleet corrections) + `limit`, exact at limits 5, 25 and 50 and within a
 * row at limit=1, and limit=1 is the worst case, because the budget shrinks with the page and the
 * walk does not. THE CALLER IS THE SHIPPED DESK: the open-items view sends exactly this request on
 * every load (js/api.js fetchQueue, from js/desk.js). So this warning is on a live cost rather
 * than on a tripwire, and tests/api.test.mjs calls the function directly for the ordinary reason a
 * unit test does, to reach both arms with chosen numbers and capture what they write.
 *
 * HOW THE FALSE CLAIM WAS REACHED, which is worth more than the correction. Pass 0 measured the
 * TWO BOARD ROUTES, found that a budget keyed on `limit` says nothing about either of them, and
 * wrote that down as a property of this function rather than of those two routes. It never ran
 * the route that already calls it. A negative claim about reachability is a claim about EVERY
 * caller, so it may not be written until the callers have been enumerated and each one measured.
 * The enumeration, so the next such claim starts from a list:
 *
 *   GET /log       src/routes-public.js   CALLS THIS. Under budget: 'A4: the public log reads
 *                                         matching rows, not the table' in
 *                                         tests/local-d1-rows.test.mjs holds that at 1, 5, 25.
 *   GET /reports   src/routes-desk.js     CALLS THIS. Over budget under kind=open, above. Under
 *                                         budget unfiltered, by status, and on the corrections
 *                                         feed, all three asserted in the same file.
 *   GET /work      src/routes-work.js     NOT a caller. Measured against this budget on
 *                                         2026-09-18 (pass 0c), through the real handler under
 *                                         workerd on a scratch local D1: its rows_read is
 *                                         INDEPENDENT of `limit` and linear in population, 62 at
 *                                         a fleet of 60 with nothing ever queued and 160 with 50
 *                                         queued, 246 on the 146-row fixture above at every one
 *                                         of limits 1, 5, 25 and 50. So it is over
 *                                         rowsReadBudget(1) = 12 on an EMPTY queue, and a call
 *                                         here would warn on every request. Two statements do it:
 *                                         the unbounded GROUP BY tally in src/store-work.js, and
 *                                         the page, whose `app_id = 'fleet'` term selects
 *                                         reports_app_site_created and sorts the whole fleet in a
 *                                         temp b-tree instead of seeking reports_work_updated.
 *                                         A page size is the wrong instrument for either, so this
 *                                         route is not made a caller. The index is
 *                                         data-engineer's.
 *   GET /board     src/routes-open.js     NOT callers, deliberately, see below.
 *   GET /board/summary
 *
 * THE TWO BOARD ROUTES ARE NOT CALLERS AND THAT IS ON PURPOSE. See the growth laws at
 * src/routes-open.js, measured: neither board read is bounded by a `limit`, so this function
 * has nothing true to say about either one. That decision is unaffected by the correction above.
 * The over-budget arm being reachable on /reports makes no board route instrumentable: what is
 * wrong there is that `rowsReadBudget` takes a page size and those two routes do not have one.
 */
export function warnRowsRead(what, rowsRead, limit) {
  const budget = rowsReadBudget(limit);
  if (typeof rowsRead === 'number' && rowsRead > budget) {
    console.warn(`${what} query scanned ${rowsRead} rows for a page of ${limit}, over the budget of ${budget}`);
  }
}
