// The index sets SQLite breaks a tie among, shared by every suite that pins a plan. NOT a
// *.test.mjs file, so `node --test tests/*.test.mjs` never runs it as a suite.
//
// Lifted out of tests/local-d1-plans.test.mjs when tests/work.test.mjs and
// tests/analysed-plans.test.mjs started pinning seeks of the same shape (queue #139). Three
// copies of "which indexes tie for a bare app_id seek" is how one suite comes to call a
// tie-break a cost change while another calls it nothing. The reasoning for pinning a seek
// and not a name is in that file, beside the import pins it was written for.

/** The indexes that tie for a bare `app_id` seek: app_id leading, no partial predicate. The last
 *  three arrived with 0005 and joined the tie rather than changing anyone's cost: measured,
 *  POST /open-items scanned the same rows before and after they existed. */
export const APP_LEADING = ['reports_app_created', 'reports_app_status_created', 'reports_app_site_created',
  'reports_app_kind_created', 'reports_app_kind_status_created', 'reports_app_board'];

/** The three that can serve an (app_id, kind) seek, which is a NARROWER seek than the above and so
 *  a different assertion, not a wider tie list. Which of the three wins is a tie SQLite breaks for
 *  itself: with 0005 applied the sync read takes reports_app_board, and it took
 *  reports_app_kind_status_created when that was the only one of the three that existed. Same two
 *  seek terms, same cost, measured both ways. */
export const APP_KIND_LEADING = ['reports_app_kind_created', 'reports_app_kind_status_created', 'reports_app_board'];

/** The UNIQUE index on the fingerprint. A28's rule applies here too: this is a measurement. */
export const FP_UNIQUE = ['reports_fp'];

/** Each seek that is a tie, with the set that ties for it and the name a pin writes instead. */
export const TIES = [
  { seek: '(app_id=?)', anyOf: APP_LEADING, as: '{app_id-leading}' },
  { seek: '(app_id=? AND kind=?)', anyOf: APP_KIND_LEADING, as: '{app_id,kind-leading}' },
];

/**
 * One plan line with a tie-break written as its tie set, so a pin states the SEEK, which is
 * what decides the cost, and does not go red when a planner build breaks the same tie the
 * other way. A seek outside the sets, or a name outside its set, is left exactly as it was.
 */
export function untie(detail) {
  return detail.replace(/USING (COVERING )?INDEX (\S+) (\(.+\))$/, (whole, covering, index, seek) => {
    const tie = TIES.find((t) => t.seek === seek && t.anyOf.includes(index));
    return tie ? `USING ${covering || ''}INDEX ${tie.as} ${seek}` : whole;
  });
}
