// The three route bodies that read no credential at all:
//
//   POST /report    public ingest, Turnstile gated, rate limited
//   GET  /log       the public corrections log   (no auth, cacheable)
//   GET  /health    which secrets are bound, and the per-site read-back
//
// THIS FILE MUST NEVER IMPORT ./auth.js AND MUST NEVER READ THE Authorization HEADER, and
// that is the reason it exists rather than a rule written on top of it. src/index.js says
// "/report, /log, /board and /board/summary NEVER read the Authorization header. A public
// route that also honours an operator credential is one refactor away from leaking the queue",
// and src/auth.js says the same thing about being imported. Until phase 2 both were claims
// about four functions inside a file that DID authenticate, so nothing could check either.
// Split out, the claim is a property of a file: `grep auth.js src/routes-public.js` is empty,
// and so is the same grep over src/routes-open.js, which holds the other two.
//
// The three that are left here are the credential-free ones. src/routes-desk.js holds the four
// that take C3 and is the only file in the Worker that imports src/auth.js.
//
// NOTHING HERE PUBLISHES AND NOTHING HERE DECIDES. /report writes a row at status 'new', which
// is private on both feeds; /log reads only sentences a person typed; /health reports which
// secrets are BOUND and never their values. A person moving a report with PATCH is the only way
// text reaches a reader, and that route is not in this file.

import { fail, ok, readJson } from './envelope.js';
import { validateReport, validateListQuery } from './validate.js';
import { STATUSES, insertReport } from './store.js';
import { fingerprintInput, sha256Hex, ipHash, actorKey } from './keys.js';
import { warnRowsRead } from './budget.js';
import { publicLog, healthSites } from './store-public.js';
import { FLEET_SCOPE } from './scope.js';
import { verifyTurnstile } from './turnstile.js';

/** The window /health counts a site's reports over, in days. */
export const HEALTH_WINDOW_DAYS = 30;

// ── POST /report ──────────────────────────────────────────────────────────────

export async function ingest(request, env, { origin, ip, now }) {
  const P = 'ingest';
  const hashed = await ipHash(env.BALISE_IP_SALT, ip);

  // Rate limited before the body is parsed, so a flood of junk costs one binding call
  // rather than a parse and a validation pass each.
  //
  // FAILS OPEN when the binding is absent, deliberately. Turnstile is the real control
  // here and the binding is the extra (Cloudflare itself calls its counters "permissive,
  // eventually consistent, and intentionally designed to not be used as an accurate
  // accounting system"). Refusing every report because a binding is unbound would take
  // the service down to protect it from nothing.
  if (env.INGEST_LIMITER && typeof env.INGEST_LIMITER.limit === 'function') {
    const key = actorKey(hashed, ip);
    const { success } = await env.INGEST_LIMITER.limit({ key });
    if (!success) {
      return fail('RATE_LIMITED', {
        provider: P,
        origin,
        env,
        message: 'That is more reports than this service accepts from one place in a minute.',
        hint: 'Wait a minute and send it again. Your text is still in this page, so nothing is lost.',
      });
    }
  } else {
    console.warn('INGEST_LIMITER is not bound; ingest is running without the rate limit binding');
  }

  const parsed = await readJson(request, P, origin, env);
  if (parsed.error) return parsed.error;

  const checked = validateReport(parsed.value);
  if (checked.code) return fail(checked.code, { provider: P, origin, env, message: checked.message, hint: checked.hint });
  const report = checked.value;

  const challenge = await verifyTurnstile(env, parsed.value.turnstile, ip);
  if (challenge) return fail(challenge.code, { provider: P, origin, env, message: challenge.message, hint: challenge.hint });

  // THE SCOPE OF /report IS A FACT ABOUT THE ROUTE, NOT ABOUT THE CALLER. This handler never
  // reads Authorization and never imports src/auth.js, which is why the Beacon works from 65
  // origins with no credential at all, so there is no principal to derive a scope from and
  // FLEET_SCOPE is a constant here: a stranger's report through a fleet site is the fleet's.
  // Tenant ingest is a separate route with a key on it. Do not branch on a credential here, and
  // do not let a body field choose an app_id.
  const fpIn = fingerprintInput(FLEET_SCOPE.appId, report.site, report.target && report.target.id, report.body);
  const fingerprint = await sha256Hex(fpIn);
  const result = await insertReport(env.DB, FLEET_SCOPE, {
    ...report,
    id: crypto.randomUUID(),
    created_at: now,
    ip_hash: hashed,
    fingerprint,
  });
  if (result.code) return fail(result.code, { provider: P, origin, env, message: result.message, hint: result.hint });
  if (result.duplicate) {
    return fail('DUPLICATE', {
      provider: P,
      origin,
      env,
      message: 'That exact report has already been sent.',
      hint: 'It is already in the queue, so there is nothing more to do. Send a separate report if you spotted something else.',
    });
  }

  return ok(P, { id: result.id, status: 'new' }, { origin, env });
}

// ── GET /log ──────────────────────────────────────────────────────────────────

export async function resolvedLog(request, env, { origin }) {
  const P = 'log';
  const params = validateListQuery(new URL(request.url).searchParams, STATUSES);
  if (params.code) return fail(params.code, { provider: P, origin, env, message: params.message, hint: params.hint });

  const page = await publicLog(env.DB, params.value);
  if (page.code) return fail(page.code, { provider: P, origin, env, message: page.message, hint: page.hint });
  warnRowsRead('log', page.rowsRead, params.value.limit);

  // The only route a crawler should ever see, and the only one that is cacheable.
  // Everything else carries no-store.
  return ok(P, { entries: page.entries, next: page.next, rows_read: page.rowsRead }, {
    origin,
    env,
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}

// ── GET /health ───────────────────────────────────────────────────────────────

/**
 * Two jobs, and the second one is the important one.
 *
 * `config` reports WHICH secrets are bound and never their values, so an operator can
 * tell a missing secret from an outage without reading anything privileged.
 *
 * `sites` is the per-site read-back. Every other check this campaign builds is static: it
 * proves the widget was copied into a repo, not that a report ever arrived from it. A
 * live site missing from this list either has no visitors or has a Beacon that silently
 * stopped working, and that is the only signal anywhere in the system that would tell the
 * difference. The desk turns it into one line; the query is here so it cannot fall
 * between the two workstreams.
 *
 * `version` ARRIVES AS AN ARGUMENT and is not imported. A15 pins the constant itself to
 * src/index.js, which is the file the release checks, and this file is one of the four that
 * index.js imports: reading it back from there would be a cycle. So the router hands its own
 * version to the handler that reports it, and there is exactly one definition either way.
 */
export async function health(env, { origin, now, version }) {
  const since = now - HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const read = await healthSites(env.DB, since);
  const body = {
    version,
    window_days: HEALTH_WINDOW_DAYS,
    config: {
      db: Boolean(env.DB),
      operator_token: Boolean(env.BALISE_OPERATOR_TOKEN),
      // The second credential. With no automation token bound, this deployment simply
      // has no automation role and the importer has to run as the operator, which is a
      // configuration fact an operator can read here instead of guessing at a 401.
      automation_token: Boolean(env.BALISE_AUTOMATION_TOKEN),
      turnstile: Boolean(env.BALISE_TURNSTILE_SECRET),
      ip_salt: Boolean(env.BALISE_IP_SALT),
      rate_limiter: Boolean(env.INGEST_LIMITER),
    },
    sites: read.code ? [] : read.sites,
    store_ok: !read.code,
  };
  return ok('', body, { origin, env });
}
