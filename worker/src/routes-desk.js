// The four route bodies that require C3, and the only file in the Worker that imports
// src/auth.js:
//
//   GET    /reports           the private queue            (Authorization: Bearer, C3)
//   PATCH  /reports/:id       one status transition        (Authorization: Bearer, C3 + C4)
//   POST   /open-items        one import batch             (Authorization: Bearer, C3)
//   POST   /open-items/sync   what the importer saw        (Authorization: Bearer, C3)
//   GET    /work, POST /work/...  the work queue           (Authorization: Bearer, C3)
//
// THIS FILE IS THE OTHER HALF OF THE SPLIT, and it is the half that gives the split its
// point. src/index.js and src/auth.js both carry the sentence "/report, /log, /board and
// /board/summary NEVER read the Authorization header", and until this file existed that was a
// claim about which four functions inside a 522 line module happened to call authenticate().
// Now every call to authenticate() in the Worker is in this file, every route body in this
// file requires one, and the credential-free bodies live in two other files that do not
// import it. The rule is checkable with grep instead of by reading four functions.
//
// So: DO NOT PUT A CREDENTIAL-FREE HANDLER HERE, and do not import this file from
// src/routes-public.js or src/routes-open.js. The first four lines of each handler below are
// deliberately identical, and that repetition is the shape of the contract rather than
// duplication to factor away: a handler that is missing them is visible at a glance.

import { fail, ok, readJson } from './envelope.js';
import { validatePatch, validateListQuery } from './validate.js';
import { STATUSES, listReports, applyTransition } from './store.js';
import { ipHash, actorKey } from './keys.js';
import { warnRowsRead } from './budget.js';
import { scopeFor } from './scope.js';
import { authenticate } from './auth.js';
import { openImport, openSync } from './routes-open.js';
import { workRoute } from './routes-work.js';
import { WORK_REQUEST_MAX_BYTES } from './validate-work.js';

/** Every handler here opens with the same two lines, so they are one call. `key` is the
 *  lockout key, which is the ip hash when the salt is bound and the raw ip when it is not
 *  (src/keys.js actorKey). */
async function gate(request, env, ip, now) {
  const key = actorKey(await ipHash(env.BALISE_IP_SALT, ip), ip);
  return await authenticate(request, env, env.DB, key, now);
}

/**
 * The principal behind a matched credential, phase 1. C6.1 makes identify() in src/identity.js
 * the only function allowed to turn a request into an identity; that file is WS-C's and does not
 * exist yet, so this is the smallest possible stand-in for it, reading nothing from the request
 * and only the actor authenticate() decided from which secret matched. When identify() lands,
 * every call below becomes a call to it and this goes. Both kinds scope to 'fleet' (C6.1), which
 * is why phase 1 changes nothing an outside caller can see; `person` and `app` are phase 2, do
 * not add them here. And the actor is NEVER read from a request field (A13): a caller who can
 * name their own role names the more privileged one, so X-Balise-Actor is gone for good.
 *
 * IT IS A LOOKUP AND IT THROWS, for the same reason scopeFor() in src/scope.js throws: a
 * default arm here is that file's guard defeated one layer up. This used to read
 * `actor === 'ai' ? 'automation' : 'operator'`, so every actor value that was not 'ai' became
 * an operator, and an operator is fleet-scoped. Nothing could have caught that: the throw in
 * scopeFor was unreachable from production, because this function never handed it an unknown
 * kind. WS-C ADDS THE `person` AND `app` KINDS, and that is when it would have cost something.
 * So when a new actor value appears in authenticate() (src/auth.js returns 'human' or 'ai' and
 * nothing else today), it gets an entry here and a scope arm there, or the request fails closed
 * as a STORE_ERROR through the never-500 wrapper at the bottom of src/index.js. A Map rather
 * than an object literal, so no inherited property name can answer the lookup.
 *
 * It lives beside the handlers that call it, which is why it moved here with them and not into
 * src/index.js: the router no longer knows what an actor is, and this is now the only file that
 * turns one into a principal.
 *
 * Exported for tests/tenant-scope.test.mjs, which is what proves the throw fires. No other
 * module calls it, and none should. */
const PRINCIPAL_KINDS = new Map([
  ['human', 'operator'],
  ['ai', 'automation'],
]);

export const principalFor = (actor) => {
  const kind = PRINCIPAL_KINDS.get(actor);
  if (!kind) throw new Error(`principalFor: no principal kind is defined for actor ${JSON.stringify(actor)}`);
  return { kind, actor };
};

// ── GET /reports ──────────────────────────────────────────────────────────────

export async function deskList(request, env, { origin, ip, now }) {
  const P = 'desk';
  const auth = await gate(request, env, ip, now);
  if (auth.error) return fail(auth.error.code, { provider: P, origin, env, message: auth.error.message, hint: auth.error.hint });

  const params = validateListQuery(new URL(request.url).searchParams, STATUSES);
  if (params.code) return fail(params.code, { provider: P, origin, env, message: params.message, hint: params.hint });

  // C6: the scope comes from the credential that matched, and from nothing in the request. A
  // `?app=` is not read here and validateListQuery does not accept one, so there is no parameter
  // for a caller to point at someone else's items.
  const page = await listReports(env.DB, scopeFor(principalFor(auth.actor)), params.value);
  if (page.code) return fail(page.code, { provider: P, origin, env, message: page.message, hint: page.hint });
  warnRowsRead('desk', page.rowsRead, params.value.limit);

  return ok(P, { reports: page.reports, next: page.next, rows_read: page.rowsRead }, { origin, env });
}

// ── PATCH /reports/:id ────────────────────────────────────────────────────────

export async function deskPatch(request, env, { origin, ip, now, id }) {
  const P = 'desk';
  const auth = await gate(request, env, ip, now);
  if (auth.error) return fail(auth.error.code, { provider: P, origin, env, message: auth.error.message, hint: auth.error.hint });

  if (!id) {
    return fail('MISSING_PARAM', { provider: P, origin, env, message: 'No report id was in the path.', hint: 'Use PATCH /reports/:id with the id from the queue.' });
  }

  const parsed = await readJson(request, P, origin, env);
  if (parsed.error) return parsed.error;
  const patch = validatePatch(parsed.value, STATUSES);
  if (patch.code) return fail(patch.code, { provider: P, origin, env, message: patch.message, hint: patch.hint });

  // C6: the id in the path is a per-tenant handle, not a global one. The scope goes to the store
  // so that an id belonging to someone else is simply NOT_FOUND, the honest answer, rather than a
  // report the caller was never entitled to move.
  const scope = scopeFor(principalFor(auth.actor));
  const result = await applyTransition(env.DB, scope, { id, actor: auth.actor, patch: patch.value, now });
  if (result.code) return fail(result.code, { provider: P, origin, env, message: result.message, hint: result.hint });

  return ok(P, { report: result.report }, { origin, env });
}

// ── POST /open-items and /open-items/sync ─────────────────────────────────────

/**
 * C3 first, then the body, then src/routes-open.js. Both import routes take EITHER
 * credential: the importer is a script the operator runs, and it holds the automation token
 * because neither route can move a report toward a reader. That is not the same as
 * harmless: the token also reads every report, contact included, and through these routes
 * it can plant a draft trusted like the fleet's own, which the operator can hand to an agent
 * in ship mode with no instruction, and mark items closed at their source or clear that mark.
 * The separate import credential that would narrow this is not built. src/routes-open.js
 * lists the reach, and docs/architecture/balise.md lists what the token cannot do.
 *
 * The lockout counts these the same way it counts the desk, so a script pointed at the
 * wrong deployment with the wrong token does not get unlimited tries.
 */
export async function importRoute(request, env, { origin, ip, now, isSync }) {
  const P = 'desk';
  const auth = await gate(request, env, ip, now);
  if (auth.error) return fail(auth.error.code, { provider: P, origin, env, message: auth.error.message, hint: auth.error.hint });

  const parsed = await readJson(request, P, origin, env);
  if (parsed.error) return parsed.error;

  return isSync
    ? await openSync(env, parsed.value, { origin, now })
    : await openImport(env, parsed.value, { origin, now });
}

// ── /work ─────────────────────────────────────────────────────────────────────

/**
 * C3 first, then the body, then src/routes-work.js, in the same order as the import routes
 * and under the same lockout. Every work route takes either credential at this layer: WHICH
 * actions a credential may take is decided against src/work.js inside src/store-work.js, so
 * the role rule has exactly one home. The body is read under WORK_REQUEST_MAX_BYTES, and
 * only after authentication, so nobody without a token gets 64 KB read on their behalf.
 */
export async function work(request, env, { origin, ip, now, target }) {
  const P = 'desk';
  const auth = await gate(request, env, ip, now);
  if (auth.error) return fail(auth.error.code, { provider: P, origin, env, message: auth.error.message, hint: auth.error.hint });

  let body = null;
  if (request.method === 'POST') {
    const parsed = await readJson(request, P, origin, env, {
      allowEmpty: true,
      maxBytes: WORK_REQUEST_MAX_BYTES,
      tooLargeHint: 'Trim the evidence to the lines that matter, then the summary, and send it again on the same run.',
    });
    if (parsed.error) return parsed.error;
    body = parsed.value;
  }
  return await workRoute(env, target, { url: new URL(request.url), actor: auth.actor, body, origin, now });
}
