// The route bodies that require C3:
//
//   GET    /reports           the private queue            (Authorization: Bearer, C3)
//   PATCH  /reports/:id       one status transition        (Authorization: Bearer, C3 + C4)
//   POST   /open-items        one import batch             (Authorization: Bearer, C3)
//   POST   /open-items/sync   what the importer saw        (Authorization: Bearer, C3)
//   GET    /work, POST /work/...  the work queue           (Authorization: Bearer, C3)
//
// Every route body here takes the operator or the automation token, through identify() in
// src/identity.js, which is the only file that imports src/auth.js. DO NOT PUT A
// CREDENTIAL-FREE HANDLER HERE: those live in src/routes-public.js and src/routes-open.js.

import { fail, ok, readJson } from './envelope.js';
import { validatePatch, validateListQuery } from './validate.js';
import { STATUSES, listReports, applyTransition } from './store.js';
import { warnRowsRead } from './budget.js';
import { scopeFor } from './scope.js';
import { identify } from './identity.js';
import { openImport, openSync } from './routes-open.js';
import { workRoute } from './routes-work.js';
import { WORK_REQUEST_MAX_BYTES } from './validate-work.js';

/** Both fleet credentials, under the C3 lockout keyed on the ip hash (src/keys.js actorKey). */
const gate = (request, env, ip, now) => identify(request, env, env.DB, { now, ip, accept: ['operator', 'automation'] });

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
  const page = await listReports(env.DB, scopeFor(auth.principal), params.value);
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
  const scope = scopeFor(auth.principal);
  const result = await applyTransition(env.DB, scope, { id, actor: auth.principal.actor, patch: patch.value, now });
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
  return await workRoute(env, target, { url: new URL(request.url), actor: auth.principal.actor, body, origin, now });
}
