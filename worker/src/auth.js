// C3: operator and automation authentication. Lifted out of src/index.js when the work
// queue's routes arrived and that file reached the fleet's 500 line cap; nothing about how
// a token is checked changed in the move.
//
// Every authenticated route calls authenticate() and nothing else. /report, /log, /board
// and /board/summary NEVER import this file: a public route that also honours a credential
// is one refactor away from leaking the queue.

import { checkLock, recordAuthResult } from './store-auth.js';

/** The one sentence a failed operator auth ever gets. It does not say which of the three
 *  things went wrong, because telling a prober "wrong token" rather than "no token" or
 *  "locked out" hands them a free oracle. */
const AUTH_GENERIC = {
  message: 'That did not unlock the review desk.',
  hint: 'Check the operator token and try once more. After five wrong tries the desk stops answering for fifteen minutes.',
};

async function sha256Bytes(input) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/**
 * The key both the rate limit binding and the C3 lockout count against. The salted hash
 * when a salt is bound, the raw address when it is not, and one shared bucket when there
 * is no address at all. That last case is local development and curl from the same box:
 * everyone shares a bucket, which is stricter than production rather than looser.
 */
export function actorKey(hashed, ip) {
  if (hashed) return hashed;
  return ip ? `ip:${ip}` : 'anonymous';
}

/**
 * Constant-time compare of an already hashed presentation against a candidate secret.
 * Returns false for an unset secret, which is how a deployment with no automation token
 * simply has no automation role rather than an error.
 *
 * timingSafeEqual throws on unequal length buffers, so both sides are SHA-256 first.
 * The length branch is unreachable at a fixed 32 bytes and is written out anyway, so a
 * later change of digest cannot silently reintroduce the leak. Comparing the input
 * against itself and negating is the current documented form
 * (https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/);
 * the pre-2026 example returned early on a length mismatch, which is the leak it claimed
 * to prevent.
 */
async function matches(presentedHash, candidate) {
  if (!candidate) return false;
  const secret = await sha256Bytes(candidate);
  return presentedHash.byteLength === secret.byteLength
    ? crypto.subtle.timingSafeEqual(presentedHash, secret)
    : !crypto.subtle.timingSafeEqual(presentedHash, presentedHash);
}

/** Returns { actor } on success, or { error } ready for the envelope. Every failure returns
 *  the same sentence, whichever of the three things went wrong. */
export async function authenticate(request, env, db, key, now) {
  if (!env || !env.BALISE_OPERATOR_TOKEN) {
    return {
      error: {
        code: 'NOT_CONFIGURED',
        message: 'This deployment has no operator token set, so the review desk cannot be unlocked.',
        hint: 'Run wrangler secret put BALISE_OPERATOR_TOKEN. The public log at /log keeps working meanwhile.',
      },
    };
  }

  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  // An absent or malformed header is not counted against the lockout. It costs no D1
  // write, it tells a prober nothing the generic sentence does not, and counting it would
  // let one bug in the desk lock the operator out of their own queue.
  if (!match) return { error: { code: 'UNAUTHORIZED', ...AUTH_GENERIC } };

  const lock = await checkLock(db, key, now);
  if (lock.locked) return { error: { code: 'UNAUTHORIZED', ...AUTH_GENERIC } };

  const presented = await sha256Bytes(match[1]);

  /* The actor is decided by WHICH credential matched, never by a header. It used to
     be `X-Balise-Actor: ai`, self declared, which meant anything holding the operator
     token could simply omit the header and take the human transition table: C4's limit
     on automation was unenforceable. That header is gone; do not reintroduce it.

     Both candidates are compared every time, and the result is folded rather than
     short circuited, so the work does not depend on which token was presented and a
     wrong guess cannot be told from a right-token-wrong-role by timing. */
  const operator = await matches(presented, env.BALISE_OPERATOR_TOKEN);
  const automation = await matches(presented, env.BALISE_AUTOMATION_TOKEN);

  const equal = operator || automation;
  await recordAuthResult(db, key, equal, now);
  if (!equal) return { error: { code: 'UNAUTHORIZED', ...AUTH_GENERIC } };

  // The operator wins if both secrets are somehow the same value, so a misconfiguration
  // degrades to the MORE restrictive outcome being unreachable rather than the reverse.
  return { actor: operator ? 'human' : 'ai' };
}
