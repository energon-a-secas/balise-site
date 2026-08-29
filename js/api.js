// The only file that talks to the Balise Worker. Every fetch in this site goes
// through request() below, so there is one place that knows the envelope shape
// and one place that decides what a person is told when something fails.
//
// CONTRACTS.md C2: every non-success response is JSON with the same five keys
// (ok, code, provider, message, hint) and NONE of them ride on an HTTP 500.
// The worker writes `message` and `hint` to be shown to a person verbatim, so
// this file does not invent wording per status code. It only supplies a message
// for the cases the worker cannot answer at all: the network being down, and a
// body that is not the envelope.

/**
 * C2.1, the drift test. `worker/tests/api.test.mjs` imports this list and
 * asserts it equals the Worker's ERROR_CODES in `worker/src/envelope.js`.
 *
 * The Worker and this site deploy on different schedules, so nothing else in
 * the system would notice them drifting apart. Adding a code to the Worker
 * without adding it here fails that test, which is the point: a code this site
 * has never heard of would otherwise reach a visitor as a blank error.
 *
 * Keep it sorted the way the Worker sorts it, so a diff of the two is readable.
 */
export const HANDLED_CODES = [
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

/**
 * Where the Worker lives. A localhost page talks to a local `wrangler dev`, so
 * the desk and the report page can be exercised end to end without deploying.
 * The port is the Makefile's WORKER_PORT.
 *
 * Resolved lazily rather than at import time, and deliberately so: C2.1's drift
 * test imports this module under Node, where `location` does not exist. Reading
 * it at the top level made the whole file unimportable there, which took out
 * the one test that watches the Worker and this site for drift. A module whose
 * only job is a constant list should not need a browser to be read.
 */
export function apiBase() {
  const host = typeof location === 'undefined' ? '' : location.hostname;
  return /^(localhost|127\.0\.0\.1)$/.test(host)
    ? 'http://127.0.0.1:8877'
    : 'https://balise-api.neorgon.workers.dev';
}

/** The two failures the Worker cannot describe, because it never answered. */
const TRANSPORT_FAIL = {
  ok: false,
  code: 'NETWORK',
  provider: '',
  message: 'Balise could not be reached.',
  hint: 'Check your connection and try again. Nothing was sent, so nothing was lost.',
};
const SHAPE_FAIL = {
  ok: false,
  code: 'BAD_ENVELOPE',
  provider: '',
  message: 'Balise answered with something this page could not read.',
  hint: 'This is a bug on our side rather than anything you did. Try again shortly.',
};

/**
 * One request, one normalised result. Never throws and never rejects: every
 * caller gets an object with `ok`, so no call site needs a try/catch and none
 * can forget one.
 *
 * A rejected origin is deliberately indistinguishable from a network failure
 * here (C2.2: the Worker sends no CORS headers on that path, so the browser
 * refuses to let us read the body). That is the contract working, not a gap.
 */
async function request(path, { method = 'GET', body = null, token = null, actor = null } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (actor) headers['X-Balise-Actor'] = actor;

  let response;
  try {
    response = await fetch(apiBase() + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      // The queue must never be served from a cache: a stale desk shows a
      // report someone already triaged.
      cache: 'no-store',
    });
  } catch {
    return TRANSPORT_FAIL;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return SHAPE_FAIL;
  }
  if (!payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
    return SHAPE_FAIL;
  }
  return payload;
}

// ── The four calls this site makes ───────────────────────────────────────────

/**
 * POST /report. Public, unauthenticated, the only write a stranger can make.
 *
 * The challenge token rides as `turnstile`, which is the name the Worker reads
 * at `worker/src/index.js:321`. It is not part of C1: C1 describes the report,
 * and this is proof the sender is a person.
 */
export function postReport(payload, turnstileToken) {
  return request('/report', {
    method: 'POST',
    body: turnstileToken ? { ...payload, turnstile: turnstileToken } : payload,
  });
}

/** GET /log. Public. Only reports a human marked fixed and left public. */
export function fetchLog({ limit = 50, before = null } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set('before', String(before));
  return request(`/log?${q}`);
}

/** GET /reports. Operator only. C3: the token never leaves memory. */
export function fetchQueue({ status = null, limit = 50, before = null }, token) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (status) q.set('status', status);
  if (before) q.set('before', String(before));
  return request(`/reports?${q}`, { token });
}

/** PATCH /reports/:id. Operator only. The Worker enforces C4's transitions. */
export function patchReport(id, patch, token) {
  return request(`/reports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    token,
  });
}
