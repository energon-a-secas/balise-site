// C6.1: identify(), the only function that turns a request into a principal, and the only file
// that imports src/auth.js.
//
// A route names the kinds it accepts, all from ONE family, and only that mechanism is consulted:
//
//   operator, automation   the two shared secrets, through authenticate() and the C3 lockout
//   app                    a bpk_ or bsk_ key, looked up by hash (A10: no lockout, which would
//                          let anyone switch off an app whose public key they can read)
//   person                 NOT BUILT: phase 3 verifies a Clerk session token here with verifyJwt
//                          (CONTRACTS.md Q3, A23 to A25). Until then it answers NOT_CONFIGURED.

import { authenticate, bearerOf } from './auth.js';
import { ipHash, actorKey, sha256Hex, appKeyKind } from './keys.js';
import { resolveKey } from './store-apps.js';

const FAMILY = { operator: 'shared', automation: 'shared', app: 'app', person: 'person' };

/** Every key refusal, whatever went wrong: shape, checksum, unknown, revoked or another app's. */
export const KEY_REFUSED = {
  code: 'UNAUTHORIZED',
  message: 'That key does not send items to this app.',
  hint: 'Check that the key and the app id in the address are the pair Balise gave you, and that the key has not been revoked.',
};

const NO_PERSON = {
  code: 'NOT_CONFIGURED',
  message: 'Signing in to Balise is not switched on in this deployment, so no app\'s items can be read here yet.',
  hint: 'Items your app sends are still kept. Ask the Balise operator when the app console opens.',
};

const WRONG_ROLE = {
  code: 'UNAUTHORIZED',
  message: 'That token is valid, but it does not open this route.',
  hint: 'Registering an app takes the operator token. The automation token cannot do it.',
};

// C3 and A6: the actor authenticate() decided from which secret matched. A Map, so no inherited
// property name can answer, and a lookup that throws, so an unknown actor fails closed as
// STORE_ERROR rather than arriving as an operator. Exported for tests/tenant-scope.test.mjs.
const PRINCIPAL_KINDS = new Map([
  ['human', 'operator'],
  ['ai', 'automation'],
]);

export const principalFor = (actor) => {
  const kind = PRINCIPAL_KINDS.get(actor);
  if (!kind) throw new Error(`principalFor: no principal kind is defined for actor ${JSON.stringify(actor)}`);
  return { kind, actor };
};

/**
 * Returns { principal } or { error } shaped for fail(). `accept` lists the kinds the route
 * takes; `app` is the app id the path names, and an app key belonging to another app is refused
 * exactly as an unknown key is.
 */
export async function identify(request, env, db, { now, ip, accept, app = null }) {
  const families = new Set(accept.map((kind) => FAMILY[kind]));
  if (families.size !== 1 || families.has(undefined)) {
    throw new Error(`identify: a route accepts one family of credential, not ${JSON.stringify(accept)}`);
  }
  const [family] = families;
  if (family === 'person') return { error: NO_PERSON };
  if (family === 'app') return await appPrincipal(request, db, app);

  const auth = await authenticate(request, env, db, actorKey(await ipHash(env.BALISE_IP_SALT, ip), ip), now);
  if (auth.error) return auth;
  const principal = principalFor(auth.actor);
  return accept.includes(principal.kind) ? { principal } : { error: WRONG_ROLE };
}

async function appPrincipal(request, db, app) {
  const presented = bearerOf(request);
  const kind = appKeyKind(presented);
  if (!kind) return { error: KEY_REFUSED };
  const found = await resolveKey(db, await sha256Hex(presented));
  if (found.code) return { error: found };
  const key = found.key;
  if (!key || key.kind !== kind || key.app_id !== app) return { error: KEY_REFUSED };
  return {
    principal: { kind: 'app', app_id: key.app_id, key_kind: key.kind, key_id: key.id, last_used_date: key.last_used_date || null },
  };
}
