// C6: the tenant key, and the ONE seam it reaches SQL through.
//
// Every row in `reports` belongs to exactly one tenant, named by `reports.app_id`. The
// reserved value 'fleet' is the operator's own desk, and it is what every row created
// before migrations/0004_tenants.sql holds. The audit that says which statement carries
// which predicate is docs/delivery/DESIGN.md section 5, and it is the artifact to read
// before adding a query anywhere in this Worker.
//
// THREE RULES, AND NONE OF THEM IS NEGOTIABLE (CONTRACTS.md C6).
//
//   1. 'fleet' is a STRING SENTINEL and never NULL. `WHERE app_id = ?` bound to NULL
//      matches nothing, silently, so the symptom of getting this wrong is an empty page
//      rather than an error. The column is NOT NULL DEFAULT 'fleet' for that reason.
//   2. The key is chosen from the PRINCIPAL, never from a request field. A body or query
//      parameter naming an app_id is ignored where the principal already implies one.
//   3. Every statement that touches `reports` carries a predicate on `app_id`, or carries
//      a comment naming the invariant that makes one unnecessary. There is no third
//      option, and a statement with neither is a defect whether or not it can be reached.
//
// WHAT PHASE 1 IS. Only two principal kinds exist yet, `operator` and `automation`, and
// both scope to 'fleet'. So every row is still the fleet's and nothing visible from
// outside this Worker changes: that is what makes the predicates reviewable, because any
// behaviour difference is a bug rather than a feature. The `person` and `app` kinds, and
// identify() in src/identity.js which is the only function allowed to build a principal
// from a request, are phase 2 (C6.1). Do not add them here.
//
// WHY THE SCOPE IS AN OBJECT AND NOT A BARE STRING. A store function takes it as the
// argument right after `db`, so an un-updated call site passes something that is not a
// scope and tenantKey() throws by name, before any SQL runs. That is the same reasoning
// A11 gives for putting `appId` first in fingerprintInput(): a loud failure beats
// silently reading as the fleet.

/** The operator's own desk. Refused as a registered app id. */
export const FLEET = 'fleet';

/**
 * The scope of every principal that exists in phase 1. Frozen, and shared rather than
 * rebuilt per request, because it is a constant: nothing about the fleet's own scope
 * depends on who is asking.
 */
export const FLEET_SCOPE = Object.freeze({ appId: FLEET, appKeyId: null });

/**
 * A principal's scope. The only function in this Worker that decides which tenant a
 * request reads and writes.
 *
 * It THROWS on a kind it does not know rather than returning the fleet's scope, and the
 * difference matters: a default would make a principal added without a scope read the
 * operator's desk, which is the exact failure this file exists to prevent. A throw lands
 * in the never-500 wrapper in src/index.js as STORE_ERROR, so the request fails closed.
 */
export function scopeFor(principal) {
  const kind = principal && principal.kind;
  switch (kind) {
    // C3 and A6. Both hold a shared secret, both act for the fleet, and which one a
    // caller is was decided by which credential matched, never by a header.
    case 'operator':
    case 'automation':
      return FLEET_SCOPE;
    default:
      throw new Error(`scopeFor: no scope is defined for principal kind ${JSON.stringify(kind)}`);
  }
}

/**
 * The value a statement binds to `app_id = ?`. Called by every scoped store function
 * before it prepares anything.
 *
 * The validation is not ceremony. A missing scope is the one mistake in this design that
 * no predicate catches, because `WHERE app_id = ?` bound to undefined or null is a query
 * that matches nothing and answers with an empty page. This turns that into a named
 * failure at the seam.
 */
export function tenantKey(scope) {
  const appId = scope && scope.appId;
  if (typeof appId !== 'string' || appId === '') {
    throw new Error('tenantKey: a store call reached SQL with no scope (CONTRACTS.md C6)');
  }
  return appId;
}

/**
 * Which key wrote a row, or null. Forensics only: when a published key leaks and 400
 * items arrive, this is what says which key to revoke and which rows to delete. It is
 * null for every principal that exists in phase 1, because only an `app` principal
 * presents a key, and nothing reads it for authorization.
 */
export function scopeKeyId(scope) {
  return (scope && scope.appKeyId) || null;
}
