// Balise: the fleet's correction-reporting Worker. Ingest, review desk, public log.
//
// Five routes:
//   POST   /report       public ingest, Turnstile gated, rate limited
//   GET    /reports      the private queue          (Authorization: Bearer, C3)
//   PATCH  /reports/:id  one status transition      (Authorization: Bearer, C3 + C4)
//   GET    /log          the public resolved log    (no auth, cacheable)
//   GET    /health       which secrets are bound, and the per-site read-back
//
// Contracts this file enforces, all frozen in docs/delivery/CONTRACTS.md:
//   C1  the report shape        -> src/validate.js
//   C2  the error envelope      -> src/envelope.js
//   C3  operator authentication -> below, plus auth_attempts in src/store.js
//   C4  the status vocabulary   -> src/store.js, which owns the transition table
//
// No response from this Worker is ever HTTP 500. The router is wrapped in a try/catch in
// the default export at the bottom, the same shape as
// projects/resume-forge-site/worker/src/index.js:341-365.
//
// /report and /log NEVER read the Authorization header. A public route that also honours
// an operator credential is one refactor away from leaking the queue.

import { ERROR_CODES, fail, ok, corsHeaders, originVerdict } from './envelope.js';
import { validateReport, validatePatch, validateListQuery, REQUEST_MAX_BYTES } from './validate.js';
import {
  STATUSES,
  fingerprintInput,
  sha256Hex,
  ipHash,
  insertReport,
  listReports,
  applyTransition,
  publicLog,
  healthSites,
  checkLock,
  recordAuthResult,
  rowsReadBudget,
} from './store.js';

export { ERROR_CODES };

const VERSION = '1.0.0';
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const HEALTH_WINDOW_DAYS = 30;

/** The one sentence a failed operator auth ever gets. It does not say which of the three
 *  things went wrong, because telling a prober "wrong token" rather than "no token" or
 *  "locked out" hands them a free oracle. */
const AUTH_GENERIC = {
  message: 'That did not unlock the review desk.',
  hint: 'Check the operator token and try once more. After five wrong tries the desk stops answering for fifteen minutes.',
};

// ── Small helpers ─────────────────────────────────────────────────────────────

async function sha256Bytes(input) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/**
 * The key both the rate limit binding and the C3 lockout count against. The salted hash
 * when a salt is bound, the raw address when it is not, and one shared bucket when there
 * is no address at all. That last case is local development and curl from the same box:
 * everyone shares a bucket, which is stricter than production rather than looser.
 */
function actorKey(hashed, ip) {
  if (hashed) return hashed;
  return ip ? `ip:${ip}` : 'anonymous';
}

/**
 * Read a JSON body under the 8 KB cap. Content-Length is checked first so an oversized
 * request is refused before anything is read; a chunked request has no Content-Length, so
 * the decoded length is checked as well.
 */
async function readJson(request, provider, origin, env) {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (declared > REQUEST_MAX_BYTES) return { error: tooLarge(provider, origin, env) };
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: fail('BAD_FIELD', { provider, origin, env, message: 'The request body could not be read.', hint: 'Send it again from the beacon.' }) };
  }
  if (new TextEncoder().encode(text).length > REQUEST_MAX_BYTES) return { error: tooLarge(provider, origin, env) };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: fail('BAD_FIELD', { provider, origin, env, message: 'The request body was not valid JSON.', hint: 'Reopen the beacon on the page you were reading and send it again.' }) };
  }
}

const tooLarge = (provider, origin, env) =>
  fail('TOO_LARGE', {
    provider,
    origin,
    env,
    message: `The request is over ${REQUEST_MAX_BYTES / 1024} KB, which this service refuses before reading it.`,
    hint: 'Shorten the report to a couple of paragraphs and send it again.',
  });

const notARoute = (origin, env, hint) =>
  fail('NOT_A_ROUTE', { provider: '', origin, env, message: 'That path and method are not a route on this worker.', hint });

const ROUTES_HINT = 'The routes are POST /report, GET /reports, PATCH /reports/:id, GET /log and GET /health.';

// ── C3: operator authentication ───────────────────────────────────────────────

/**
 * Returns { actor } on success or a ready-made 401 envelope. Every failure returns the
 * same sentence.
 *
 * The comparison is constant time: SHA-256 both sides, then crypto.subtle.timingSafeEqual
 * on the two 32 byte digests. Hashing first is REQUIRED, not tidiness: timingSafeEqual
 * throws on unequal length buffers, so comparing raw tokens would both leak the secret's
 * length through timing and throw on most wrong guesses.
 *
 * Cloudflare's own timing-attack example page was WRONG until 2026 and was fixed only
 * after cloudflare-docs#23623. Any pre-2026 copy of it returns early on a length mismatch,
 * which is the leak it claims to prevent. The current documented form
 * (https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/,
 * updated 2026-04-23) compares the input against itself and negates instead of returning
 * early, and that is the branch below. Hashing to a fixed 32 bytes means it should be
 * unreachable; it is written out anyway so that a later change of digest cannot
 * reintroduce the leak silently.
 */
async function authenticate(request, env, db, key, now) {
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
  const secret = await sha256Bytes(env.BALISE_OPERATOR_TOKEN);
  const sameLength = presented.byteLength === secret.byteLength;
  const equal = sameLength
    ? crypto.subtle.timingSafeEqual(presented, secret)
    : !crypto.subtle.timingSafeEqual(presented, presented);

  await recordAuthResult(db, key, equal, now);
  if (!equal) return { error: { code: 'UNAUTHORIZED', ...AUTH_GENERIC } };

  // Self declared by the caller. See AI_TRANSITIONS in store.js: an honesty mechanism,
  // not a security boundary.
  const actor = request.headers.get('X-Balise-Actor') === 'ai' ? 'ai' : 'human';
  return { actor };
}

// ── Turnstile ─────────────────────────────────────────────────────────────────

/**
 * Server side validation is mandatory: the widget alone protects nothing, because anyone
 * can POST any string to this endpoint. Tokens are single use and expire after five
 * minutes (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
 *
 * Gate on the secret before the fetch, the same rule as the fleet's reference worker: a
 * missing secret is a configuration fact and must not be reported as a challenge failure.
 */
async function verifyTurnstile(env, token, ip) {
  if (!env.BALISE_TURNSTILE_SECRET) {
    return {
      code: 'NOT_CONFIGURED',
      message: 'This service has no Turnstile secret set, so it cannot check that you are a person.',
      hint: 'The site owner needs to set BALISE_TURNSTILE_SECRET. Nothing you can type will get past this one, so tell them what you found instead.',
    };
  }
  if (!token || typeof token !== 'string' || token.length > 2048) {
    return {
      code: 'CHALLENGE_FAILED',
      message: 'The report arrived without a completed challenge.',
      hint: 'Wait for the checkbox on the report page to finish, then send it again.',
    };
  }
  const form = new URLSearchParams({ secret: env.BALISE_TURNSTILE_SECRET, response: token });
  if (ip) form.set('remoteip', ip);
  let body;
  try {
    const res = await fetch(TURNSTILE_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    body = await res.json();
  } catch (err) {
    console.error('turnstile siteverify threw:', err);
    return {
      code: 'CHALLENGE_FAILED',
      message: 'The challenge check could not be completed.',
      hint: 'Try again in a minute. Your text is still in this page, so nothing is lost.',
    };
  }
  if (body && body.success === true) return null;
  console.warn('turnstile refused:', body && body['error-codes']);
  return {
    code: 'CHALLENGE_FAILED',
    message: 'The challenge on the report page was not accepted.',
    hint: 'Reload the report page to get a fresh challenge, then send it again.',
  };
}

// ── The router ────────────────────────────────────────────────────────────────

const router = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;
    const now = Date.now();
    const ip = request.headers.get('CF-Connecting-IP') || '';

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    // A denied origin gets no CORS headers at all, so a browser sees a CORS failure and
    // never reads this body. It is here for curl and for the operator: do not build UI
    // against it (C2.2). A request with no Origin at all is allowed everywhere.
    if (originVerdict(origin, env) === 'denied') {
      return fail('FORBIDDEN_ORIGIN', {
        provider: surfaceFor(path),
        message: 'This service does not answer requests from that origin.',
        hint: 'Report through the beacon on the page itself, which opens the Balise report page.',
        cors: false,
      });
    }

    if (!env || !env.DB) {
      return fail('NOT_CONFIGURED', {
        provider: surfaceFor(path),
        origin,
        env,
        message: 'This deployment has no report database bound.',
        hint: 'The site owner needs to bind the D1 database named in wrangler.toml. Nothing can be stored until then.',
      });
    }

    if (path === '/report') {
      if (method !== 'POST') return notARoute(origin, env, 'Reports are sent with POST /report.');
      return await ingest(request, env, origin, ip, now);
    }
    if (path === '/reports') {
      if (method !== 'GET') return notARoute(origin, env, 'The queue is read with GET /reports.');
      return await deskList(request, env, origin, ip, now);
    }
    if (path.startsWith('/reports/')) {
      if (method !== 'PATCH') return notARoute(origin, env, 'A status change is PATCH /reports/:id.');
      return await deskPatch(request, env, origin, ip, now, decodeURIComponent(path.slice('/reports/'.length)));
    }
    if (path === '/log') {
      if (method !== 'GET') return notARoute(origin, env, 'The public log is read with GET /log.');
      return await resolvedLog(request, env, origin);
    }
    if (path === '/health') {
      if (method !== 'GET') return notARoute(origin, env, 'Health is read with GET /health.');
      return await health(env, origin, now);
    }
    return notARoute(origin, env, ROUTES_HINT);
  },
};

const surfaceFor = (path) => {
  if (path === '/report') return 'ingest';
  if (path === '/reports' || path.startsWith('/reports/')) return 'desk';
  if (path === '/log') return 'log';
  return '';
};

// ── POST /report ──────────────────────────────────────────────────────────────

async function ingest(request, env, origin, ip, now) {
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

  const fingerprint = await sha256Hex(fingerprintInput(report.site, report.target && report.target.id, report.body));
  const result = await insertReport(env.DB, {
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

// ── GET /reports ──────────────────────────────────────────────────────────────

async function deskList(request, env, origin, ip, now) {
  const P = 'desk';
  const key = actorKey(await ipHash(env.BALISE_IP_SALT, ip), ip);
  const auth = await authenticate(request, env, env.DB, key, now);
  if (auth.error) return fail(auth.error.code, { provider: P, origin, env, message: auth.error.message, hint: auth.error.hint });

  const params = validateListQuery(new URL(request.url).searchParams, STATUSES);
  if (params.code) return fail(params.code, { provider: P, origin, env, message: params.message, hint: params.hint });

  const page = await listReports(env.DB, params.value);
  if (page.code) return fail(page.code, { provider: P, origin, env, message: page.message, hint: page.hint });
  warnRowsRead('desk', page.rowsRead, params.value.limit);

  return ok(P, { reports: page.reports, next: page.next, rows_read: page.rowsRead }, { origin, env });
}

// ── PATCH /reports/:id ────────────────────────────────────────────────────────

async function deskPatch(request, env, origin, ip, now, id) {
  const P = 'desk';
  const key = actorKey(await ipHash(env.BALISE_IP_SALT, ip), ip);
  const auth = await authenticate(request, env, env.DB, key, now);
  if (auth.error) return fail(auth.error.code, { provider: P, origin, env, message: auth.error.message, hint: auth.error.hint });

  if (!id) {
    return fail('MISSING_PARAM', { provider: P, origin, env, message: 'No report id was in the path.', hint: 'Use PATCH /reports/:id with the id from the queue.' });
  }

  const parsed = await readJson(request, P, origin, env);
  if (parsed.error) return parsed.error;
  const patch = validatePatch(parsed.value, STATUSES);
  if (patch.code) return fail(patch.code, { provider: P, origin, env, message: patch.message, hint: patch.hint });

  const result = await applyTransition(env.DB, { id, actor: auth.actor, patch: patch.value, now });
  if (result.code) return fail(result.code, { provider: P, origin, env, message: result.message, hint: result.hint });

  return ok(P, { report: result.report }, { origin, env });
}

// ── GET /log ──────────────────────────────────────────────────────────────────

async function resolvedLog(request, env, origin) {
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

/**
 * A4's read-back. rows_read counts rows SCANNED, and local D1 enforces no quota at all,
 * so this line plus the assertion in tests/local-d1.test.mjs is the only thing that would
 * notice a query that scans the table before it reaches production and burns the daily
 * allowance.
 */
function warnRowsRead(what, rowsRead, limit) {
  const budget = rowsReadBudget(limit);
  if (typeof rowsRead === 'number' && rowsRead > budget) {
    console.warn(`${what} query scanned ${rowsRead} rows for a page of ${limit}, over the budget of ${budget}`);
  }
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
 */
async function health(env, origin, now) {
  const since = now - HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const read = await healthSites(env.DB, since);
  const body = {
    version: VERSION,
    window_days: HEALTH_WINDOW_DAYS,
    config: {
      db: Boolean(env.DB),
      operator_token: Boolean(env.BALISE_OPERATOR_TOKEN),
      turnstile: Boolean(env.BALISE_TURNSTILE_SECRET),
      ip_salt: Boolean(env.BALISE_IP_SALT),
      rate_limiter: Boolean(env.INGEST_LIMITER),
    },
    sites: read.code ? [] : read.sites,
    store_ok: !read.code,
  };
  return ok('', body, { origin, env });
}

// ── The never-500 wrapper ─────────────────────────────────────────────────────

export default {
  /**
   * "No response from this Worker is ever HTTP 500" (C2) is a promise about every
   * response, including the ones a bug in these files produces. An uncaught throw in a
   * Workers fetch handler is answered by the runtime with a 500 class error page and no
   * CORS headers, which the site would see only as an unreadable body.
   *
   * This catch existing is not a claim that it never fires. The log line is for the
   * operator; the person still gets a sentence and something they can do.
   */
  async fetch(request, env) {
    try {
      return await router.fetch(request, env);
    } catch (err) {
      console.error('worker threw:', err);
      let origin = null;
      try {
        origin = request.headers.get('Origin');
      } catch {
        origin = null;
      }
      return fail('STORE_ERROR', {
        provider: '',
        origin,
        env,
        message: 'The report service hit an error it did not expect.',
        hint: 'Try again in a minute. The address of the page is enough to report it by hand if this keeps happening.',
      });
    }
  },
};
