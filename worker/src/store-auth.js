// C3: the operator lockout. Split out of src/store.js because it is the only part of the
// store that has nothing to do with reports, and keeping it next to them invited the
// question this comment exists to close.
//
// NOTHING IN THIS FILE CARRIES A TENANT PREDICATE, AND `auth_attempts` MUST NOT GAIN A
// TENANT COLUMN.
//
// The invariant that makes a predicate unnecessary here (C6, and DESIGN.md section 5.1):
// `auth_attempts` is keyed by a hash of the credential and the address that presented it,
// so a row is a FAILED attempt by someone with no established identity. There is no tenant
// to attribute it to, by construction: the whole point of the row is that the credential
// did not match anything. Adding app_id would mean asking a caller who they are before
// deciding whether to let them ask, which is the loop this table exists to cut.
//
// The consequence is deliberate and worth stating so it is not read as an oversight: the
// lockout is per credential-and-address and therefore SHARED across tenants. Someone
// brute-forcing an app key from one address is slowed for every key from that address.
// That is the correct direction to be wrong in.
//
// Both functions swallow their own errors and log rather than returning a store error,
// because both are called from the authentication path where a store failure must not
// become a way through.

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Checked BEFORE the token comparison, so a locked out caller never reaches the
 * comparison at all. Five failures then fifteen minutes. The binding cannot express this
 * (A3), which is why it is here.
 */
export async function checkLock(db, key, now) {
  try {
    const row = await db.prepare('SELECT failures, locked_until FROM auth_attempts WHERE key = ?').bind(key).first();
    if (!row) return { locked: false };
    return { locked: row.locked_until > now, until: row.locked_until };
  } catch (err) {
    // A store failure must not open the door. Treat it as locked and let the operator
    // read STORE_ERROR from /health rather than silently dropping the lockout.
    console.error('d1 lock read failed:', err);
    return { locked: true, unavailable: true };
  }
}

/** Recorded AFTER the comparison. Success clears the counter; failure advances it. A failure
 *  once a lock has run out starts again at one, so an expired lock costs five more tries:
 *  counting on from five, a stale credential on a schedule relocked the address every run. */
export async function recordAuthResult(db, key, success, now) {
  try {
    if (success) {
      await db.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
      return;
    }
    await db
      .prepare(
        `INSERT INTO auth_attempts (key, failures, locked_until, updated_at)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(key) DO UPDATE SET
           failures     = CASE WHEN auth_attempts.locked_until > 0 AND auth_attempts.locked_until <= ? THEN 1
                               ELSE auth_attempts.failures + 1 END,
           locked_until = CASE WHEN auth_attempts.locked_until > 0 AND auth_attempts.locked_until <= ? THEN 0
                               WHEN auth_attempts.failures + 1 >= ? THEN ? ELSE auth_attempts.locked_until END,
           updated_at   = ?`,
      )
      .bind(key, now, now, now, LOCKOUT_MAX_FAILURES, now + LOCKOUT_MS, now)
      .run();
  } catch (err) {
    console.error('d1 lock write failed:', err);
  }
}
