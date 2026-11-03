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
// THE PRINCIPALS. identify() in src/identity.js is the only function that builds one from a
// request (C6.1). `operator` and `automation` scope to 'fleet'; `app` to the app its key belongs
// to; `person` to ONE app at a time, the one the path names, and only if they own it (DESIGN.md
// section 5.5). A person's apps are never turned into an `app_id IN (...)` list.
//
// WHY THE SCOPE IS AN OBJECT AND NOT A BARE STRING. A store function takes it as the
// argument right after `db`, so an un-updated call site passes something that is not a
// scope and tenantKey() throws by name, before any SQL runs. That is the same reasoning
// A11 gives for putting `appId` first in fingerprintInput(): a loud failure beats
// silently reading as the fleet.

/** The operator's own desk. Refused as a registered app id. */
export const FLEET = 'fleet';

/** The fleet's own scope. Frozen and shared, because nothing about it depends on who asks. */
export const FLEET_SCOPE = Object.freeze({ appId: FLEET, appKeyId: null });

const appScope = (appId, appKeyId) => {
  if (typeof appId !== 'string' || appId === '' || appId === FLEET) {
    throw new Error(`scopeFor: no scope is defined for an app id of ${JSON.stringify(appId)}`);
  }
  return Object.freeze({ appId, appKeyId: appKeyId || null });
};

/**
 * A principal's scope. The only function in this Worker that decides which tenant a request
 * reads and writes. For a person, `app` is the apps row the path named, and the answer is null
 * when that person does not own it: the caller answers NOT_FOUND, the same as for no app.
 *
 * It THROWS on a kind it does not know rather than returning the fleet's scope: a default would
 * make a principal added without a scope read the operator's desk. A throw lands in the
 * never-500 wrapper in src/index.js as STORE_ERROR, so the request fails closed.
 */
export function scopeFor(principal, app = null) {
  const kind = principal && principal.kind;
  switch (kind) {
    case 'operator':
    case 'automation':
      return FLEET_SCOPE;
    case 'app':
      return appScope(principal.app_id, principal.key_id);
    case 'person':
      if (!app || typeof principal.person_id !== 'string' || principal.person_id === '') {
        throw new Error('scopeFor: no scope is defined for a person without the app their path names');
      }
      return app.owner === principal.person_id ? appScope(app.id, null) : null;
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

/** Which key wrote a row, or null. Forensics only: when a published key leaks, this says which
 *  key to revoke and which rows to delete. Nothing reads it for authorization. */
export function scopeKeyId(scope) {
  return (scope && scope.appKeyId) || null;
}
