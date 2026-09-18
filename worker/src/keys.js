// The four derived keys this Worker computes, and the digest under all of them:
//
//   fingerprintInput + sha256Hex   the duplicate guard, scoped per tenant (A11)
//   ipHash                         a reporter's address, salted, truncated, never stored raw
//   actorKey                       the bucket the rate limit and the C3 lockout count against
//
// No SQL, no D1, no request, no env. Lifted out of src/store.js in the phase 2 router split:
// that file's own header says it is one of the six files in this Worker that contain SQL, and
// these five functions contain none, so they were the part of it that a reader auditing the
// store had to skip. src/store.js re-exports all five, so every existing caller is unchanged.
//
// It imports only src/scope.js, which imports nothing, so no file that needs a key can create
// a cycle by reaching for one.

import { FLEET } from './scope.js';

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256(site, target id, normalised body). The UNIQUE index on this column IS the
 * duplicate guard: the insert in src/store.js conflicts and writes nothing, which costs one
 * no-op insert rather than a read plus a write.
 *
 * Normalising case and runs of whitespace means "the same complaint typed twice" is one
 * report. It does not catch a reworded duplicate, and it is not meant to: that is the
 * `duplicate` status and a human.
 */
export function normaliseForFingerprint(body) {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A11: the tenant is scoped INSIDE the hash, not beside it.
 *
 * `reports_fp` is UNIQUE on `fingerprint` alone, and it stays that way. A composite
 * UNIQUE(app_id, fingerprint) would be the obvious move and it is the wrong one: the three
 * `ON CONFLICT(fingerprint) DO NOTHING` clauses in this Worker name that index by column,
 * so replacing it means editing every one of them and getting all three right, and the
 * failure mode of missing one is a thrown constraint error on a path whose whole design is
 * that a duplicate costs a no-op insert. Mixing the key into the hashed input instead
 * gives per-tenant duplicate detection with no index change and no conflict-clause change.
 *
 * `appId` COMES FIRST, NOT LAST. A call site that was not updated passes three arguments,
 * so `site` lands in `appId` and `body` is undefined, and the report is refused loudly.
 * With the key appended instead, the same stale call site would hash exactly as it always
 * did, which is to say it would silently file a tenant's report as the fleet's. That is
 * DESIGN.md section 9 item 13, and it is why the argument order is not a matter of taste.
 *
 * The fleet's input is byte-identical to what it was before this parameter existed, so
 * every fingerprint already in the table stays correct and no backfill is needed. That is
 * what the FLEET branch is for; it is not an optimisation.
 */
export function fingerprintInput(appId, site, targetId, body) {
  const base = `${site}\x00${targetId || ''}\x00${normaliseForFingerprint(body)}`;
  return appId === FLEET ? base : `${appId}\x00${base}`;
}

/**
 * SHA-256(salt, address), truncated to 32 hex characters. Returns null with no salt,
 * because an unsalted hash of an IPv4 address is reversible by brute force in seconds and
 * storing that would be worse than storing nothing.
 */
export async function ipHash(salt, address) {
  if (!salt || !address) return null;
  return (await sha256Hex(`${salt}\x00${address}`)).slice(0, 32);
}

/**
 * The key both the rate limit binding and the C3 lockout count against. The salted hash
 * when a salt is bound, the raw address when it is not, and one shared bucket when there
 * is no address at all. That last case is local development and curl from the same box:
 * everyone shares a bucket, which is stricter than production rather than looser.
 *
 * IT IS HERE AND NOT IN src/auth.js, where it was until the phase 2 split, and the reason is
 * the sentence at the top of that file: /report, /log, /board and /board/summary never import
 * the authentication module. POST /report is rate limited and reads no credential, so it needs
 * this function and nothing else from auth.js, and while this lived there that one need was the
 * only thing making the credential-free ingest handler import C3's own file. It takes `ipHash`'s
 * output and it decides no role, so beside `ipHash` is where it belongs.
 */
export function actorKey(hashed, ip) {
  if (hashed) return hashed;
  return ip ? `ip:${ip}` : 'anonymous';
}
