// The Balise error envelope (CONTRACTS.md C2), and the CORS rules around it.
//
// Every non-success response from this Worker is JSON with the same five keys:
//
//   { "ok": false, "code": "...", "provider": "...", "message": "...", "hint": "..." }
//
// `provider` keeps its name for fleet consistency with
// docs/architecture/cloudflare-workers.md even though Balise has no third party
// upstream. Its value is the Balise SURFACE: 'ingest', 'desk', 'log', or the empty
// string when the path names none. Renaming the key would give the fleet two envelope
// shapes; reusing it means one client can read any Neorgon worker.
//
// `message` and `hint` are shown to a person verbatim. Every hint ends by naming
// something the person can still do.
//
// readJson() and tooLarge() are at the foot of this file rather than in a module of their
// own. They were in src/index.js until the router was split out of the handlers, and they
// belong here because every outcome either one has is a C2 envelope: readJson returns a
// parsed value or one of the three envelopes above, and tooLarge IS an envelope. Nothing
// about reading a body under a cap is a route's business, so no route file owns a copy.

import { REQUEST_MAX_BYTES } from './validate.js';

/**
 * Every code this Worker can put in an error envelope.
 *
 * `js/api.js` on the Balise site exports the codes it handles as HANDLED_CODES and
 * `tests/api.test.mjs` asserts the two sets are equal (C2.1). The Worker and the Pages
 * site deploy on different schedules and nothing else in the system would notice them
 * drifting apart, so that test is the read-back.
 *
 * ADDITIVE ONLY. Renaming one of these breaks the drift test on purpose. Adding one
 * breaks it too until the site adds words for it, which is also on purpose: a code the
 * site has no sentence for reaches a person as a blank.
 */
export const ERROR_CODES = [
  'BAD_VERSION',
  'MISSING_PARAM',
  'BAD_FIELD',
  'TOO_LARGE',
  'FORBIDDEN_ORIGIN',
  'CHALLENGE_FAILED',
  'UNAUTHORIZED',
  'DUPLICATE',
  'RATE_LIMITED',
  'BAD_TRANSITION',
  'NOT_FOUND',
  'NOT_A_ROUTE',
  'NOT_CONFIGURED',
  'STORE_ERROR',
];

/** The HTTP status each code rides on. 500 appears nowhere, by contract. */
export const HTTP_FOR = {
  BAD_VERSION: 400,
  MISSING_PARAM: 400,
  BAD_FIELD: 400,
  TOO_LARGE: 413,
  FORBIDDEN_ORIGIN: 403,
  CHALLENGE_FAILED: 403,
  UNAUTHORIZED: 401,
  DUPLICATE: 409,
  RATE_LIMITED: 429,
  BAD_TRANSITION: 409,
  NOT_FOUND: 404,
  NOT_A_ROUTE: 404,
  NOT_CONFIGURED: 501,
  STORE_ERROR: 502,
};

/** The four legal values of `provider`, which is a Balise surface and not an upstream. */
export const SURFACES = ['ingest', 'desk', 'log', ''];

const DEFAULT_ORIGINS = [
  'https://balise.neorgon.com',
  'http://localhost:8876',
  'http://127.0.0.1:8876',
];

/**
 * The origin allowlist, from the BALISE_ALLOWED_ORIGINS var, falling back to the three
 * above so a misconfigured deployment still answers its own site rather than nothing.
 */
export function allowedOrigins(env) {
  const raw = env && typeof env.BALISE_ALLOWED_ORIGINS === 'string' ? env.BALISE_ALLOWED_ORIGINS : '';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ORIGINS;
}

/**
 * Origin policy, in one place so no route can quietly disagree with another.
 *
 *   No Origin header      -> allowed everywhere. That is curl, a crawler, or the local
 *                            AI triage job. CORS restricts a BROWSER from reading a
 *                            response; it does not stop curl, so refusing here would buy
 *                            nothing and would break the public log for crawlers.
 *   Origin on the list    -> allowed, and the response echoes that one origin.
 *   Origin off the list   -> FORBIDDEN_ORIGIN, and NO CORS headers at all (C2.2), so a
 *                            browser sees a CORS failure and never reads the body.
 *
 * This is hygiene and telemetry, not the defence. The defences are Turnstile on ingest
 * and the bearer token on the desk.
 */
export function originVerdict(origin, env) {
  if (!origin) return 'absent';
  return allowedOrigins(env).includes(origin) ? 'allowed' : 'denied';
}

/**
 * Access-Control-Allow-Origin cannot hold a list, so exactly one validated origin is
 * echoed per response and `Vary: Origin` is mandatory: without it a cache could serve
 * one site's allowed response to another site's request.
 *
 * Allow-Headers names TWO request headers and that is the whole set. X-Balise-Actor was
 * listed here and is gone (A13): the actor is decided by which secret matched, never
 * declared by the caller, so advertising the header invited a client to send one. Nothing
 * in this Worker reads it. Do not add it back, and do not add a header that names a tenant
 * either, for the same reason: the tenant follows from the credential.
 */
export function corsHeaders(origin, env) {
  if (originVerdict(origin, env) !== 'allowed') return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * The one success constructor. `ok: true` and `provider` are always present, so a client
 * can read the surface off any response, success or failure, without branching first.
 */
export function ok(provider, body, { origin = null, env = null, headers = {} } = {}) {
  return json({ ok: true, provider, ...body }, 200, {
    'Cache-Control': 'no-store',
    ...headers,
    ...corsHeaders(origin, env),
  });
}

/**
 * The one error constructor. Errors are never cached: a retry has to reach the Worker.
 *
 * `cors: false` is the FORBIDDEN_ORIGIN path and only that path. Everywhere else the
 * headers are computed from the origin, which for a denied origin is already {}.
 *
 * `headers` exists for the two public board reads (A8), whose errors must be as readable
 * from another origin as their answers, or a failure there looks like a network fault.
 */
export function fail(code, { provider = '', message, hint = '', origin = null, env = null, cors = true, headers = {} } = {}) {
  const merged = { 'Cache-Control': 'no-store', ...headers, ...(cors ? corsHeaders(origin, env) : {}) };
  return json({ ok: false, code, provider, message, hint }, HTTP_FOR[code] || 502, merged);
}

// ── The request body, read under a cap ────────────────────────────────────────

export const tooLarge = (provider, origin, env, maxBytes, hint) =>
  fail('TOO_LARGE', {
    provider,
    origin,
    env,
    message: `The request is over ${maxBytes / 1024} KB, which this service refuses before reading it.`,
    hint: hint || 'Shorten the report to a couple of paragraphs and send it again.',
  });

/**
 * Read a JSON body under a byte cap: 8 KB on every route but the work actions, which pass
 * WORK_REQUEST_MAX_BYTES because a result's summary and evidence do not fit in 8 KB.
 * Content-Length is checked first so an oversized request is refused before anything is
 * read; a chunked request has no Content-Length, so the decoded length is checked as well.
 *
 * `allowEmpty` is for the work actions, where a body-less POST (withdraw) means "no
 * fields" rather than a malformed request. Every other route keeps refusing an empty body.
 */
export async function readJson(request, provider, origin, env, { allowEmpty = false, maxBytes = REQUEST_MAX_BYTES, tooLargeHint } = {}) {
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (declared > maxBytes) return { error: tooLarge(provider, origin, env, maxBytes, tooLargeHint) };
  let text;
  try {
    text = await request.text();
  } catch {
    return { error: fail('BAD_FIELD', { provider, origin, env, message: 'The request body could not be read.', hint: 'Send it again from the beacon.' }) };
  }
  if (new TextEncoder().encode(text).length > maxBytes) return { error: tooLarge(provider, origin, env, maxBytes, tooLargeHint) };
  if (allowEmpty && !text.trim()) return { value: {} };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: fail('BAD_FIELD', { provider, origin, env, message: 'The request body was not valid JSON.', hint: 'Reopen the beacon on the page you were reading and send it again.' }) };
  }
}
