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
 * IT IS A BUDGET FOR A PAGE, so it takes a `limit` and only a route with one may use it. The
 * fixed-shape reads have no limit to hand it and are bounded a different way: see the growth
 * law written down at the foot of src/routes-open.js.
 */
export function rowsReadBudget(limit) {
  return limit * 2 + 10;
}

/**
 * A4's read-back. rows_read counts rows SCANNED, and local D1 enforces no quota at all, so
 * this line plus the budgets in tests/local-d1-rows.test.mjs is the only thing that would
 * notice a query that scans the table before it reaches production and burns the daily
 * allowance.
 *
 * IT LOGS AND DOES NOTHING ELSE. It has exactly two callers, GET /log in src/routes-public.js
 * and GET /reports in src/routes-desk.js, and the first of those is cacheable and public, so it
 * may never touch a response body, a status, a header or the cache policy: a caller that starts
 * branching on this function has turned an observation into behaviour, and a warning that can
 * change an answer is a warning nobody may leave switched on. It returns undefined on both
 * arms for that reason, so there is nothing for a caller to branch on, and 'C2: warnRowsRead
 * observes and returns nothing' in tests/api.test.mjs is what holds that: it captures
 * console.warn and requires undefined from both arms and from a rows_read that is not a number.
 * It has to call the function directly, and the reason is worth knowing: NO POPULATION CAN PUT A
 * KEYSET PAGE OVER ITS OWN BUDGET. Both callers read exactly `limit` rows under every index the
 * store has, measured, so the warning has never fired through a route and cannot be made to.
 * It is a tripwire for a future plan regression, not a thing operations will see.
 *
 * THE TWO BOARD ROUTES ARE NOT CALLERS AND THAT IS ON PURPOSE. See the growth laws at
 * src/routes-open.js, measured: neither board read is bounded by a `limit`, so this function
 * has nothing true to say about either one.
 */
export function warnRowsRead(what, rowsRead, limit) {
  const budget = rowsReadBudget(limit);
  if (typeof rowsRead === 'number' && rowsRead > budget) {
    console.warn(`${what} query scanned ${rowsRead} rows for a page of ${limit}, over the budget of ${budget}`);
  }
}
