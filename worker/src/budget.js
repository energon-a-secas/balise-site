// What a page is allowed to cost in rows SCANNED, and the line that says so out loud.
//
// Two functions and no SQL. This module imports nothing, so every file in the Worker can reach
// it and none of them can create a cycle doing so. That is why the warning lives here rather
// than in src/index.js, which imports it.

/**
 * What a keyset page of `limit` rows should cost in rows SCANNED.
 *
 * A budget for a page, so it takes a `limit` and only a route with one may use it. The
 * fixed-shape reads have no limit to hand it and are bounded a different way.
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
 * may never touch a response body, a status, a header or the cache policy. It returns undefined
 * on both arms so there is nothing for a caller to branch on, and test 'C2' in
 * tests/api.test.mjs holds that: it captures console.warn and requires undefined from both arms
 * and from a rows_read that is not a number.
 *
 * The over-budget arm is reachable through GET /reports?kind=open, the shipped desk's default
 * view. Under budget on the other /reports shapes and on GET /log, asserted in
 * tests/local-d1-rows.test.mjs. GET /work and the two board routes are not callers: their reads
 * are not bounded by a `limit`, so a page-size budget has nothing to say about them.
 */
export function warnRowsRead(what, rowsRead, limit) {
  const budget = rowsReadBudget(limit);
  if (typeof rowsRead === 'number' && rowsRead > budget) {
    console.warn(`${what} query scanned ${rowsRead} rows for a page of ${limit}, over the budget of ${budget}`);
  }
}
