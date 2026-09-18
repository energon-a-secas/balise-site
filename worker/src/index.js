// Balise: the fleet's correction-reporting Worker, the fleet's open-items board, and the
// work queue that lets an agent pick those items up.
//
// The routes:
//   POST   /report            public ingest, Turnstile gated, rate limited
//   GET    /reports           the private queue            (Authorization: Bearer, C3)
//   PATCH  /reports/:id       one status transition        (Authorization: Bearer, C3 + C4)
//   GET    /log               the public corrections log   (no auth, cacheable)
//   POST   /open-items        one import batch             (Authorization: Bearer, C3)
//   POST   /open-items/sync   what the importer saw        (Authorization: Bearer, C3)
//   GET    /board             the public open-items board  (no auth, cacheable, any origin)
//   GET    /board/summary     the board as counts          (no auth, cacheable, any origin)
//   GET    /work, /work/:id   the work queue               (Authorization: Bearer, C3)
//   POST   /work/...          one work action              (Authorization: Bearer, C3 + src/work.js)
//   GET    /health            which secrets are bound, and the per-site read-back
//
// The feeds share one table, one desk and one rule: text arrives in PRIVATE, a person
// decides, and only a sentence that person typed reaches a public page. Corrections arrive
// from strangers and open items from the fleet's own trackers; the work queue lets an agent
// do the work behind either and hands the result back to a person. NOTHING ON ANY FEED
// PUBLISHES ITSELF.
//
// Contracts this file enforces, all frozen in docs/delivery/CONTRACTS.md:
//   C1  the report shape        -> src/validate.js
//   C2  the error envelope      -> src/envelope.js
//   C3  operator authentication -> src/auth.js, plus auth_attempts in src/store.js
//   C4  the status vocabulary   -> src/transitions.js, enforced in src/store.js
// and the work queue's action table (docs/DESIGN-WORK-QUEUE.md) -> src/work.js.
//
// No response from this Worker is ever HTTP 500. The router is wrapped in a try/catch in
// the default export at the bottom, the same shape as
// projects/resume-forge-site/worker/src/index.js:341-365.
//
// /report, /log, /board and /board/summary NEVER read the Authorization header. A public
// route that also honours an operator credential is one refactor away from leaking the queue.

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
  rowsReadBudget,
} from './store.js';
import { publicLog, healthSites } from './store-public.js';
import { FLEET_SCOPE, scopeFor } from './scope.js';
import { verifyTurnstile } from './turnstile.js';
import { authenticate, actorKey } from './auth.js';
import { openImport, openSync, openBoard, openBoardSummary } from './routes-open.js';
import { parseWorkPath, workRoute } from './routes-work.js';
import { WORK_REQUEST_MAX_BYTES } from './validate-work.js';

export { ERROR_CODES };

// 1.1.0 is the open-items board and the work queue together: 1.0.0 shipped the corrections
// feed alone, and the board was built after it without a bump, so the release checks this
// number to tell the two builds apart.
const VERSION = '1.1.0';
const HEALTH_WINDOW_DAYS = 30;

// ── Small helpers ─────────────────────────────────────────────────────────────

/**
 * Read a JSON body under a byte cap: 8 KB on every route but the work actions, which pass
 * WORK_REQUEST_MAX_BYTES because a result's summary and evidence do not fit in 8 KB.
 * Content-Length is checked first so an oversized request is refused before anything is
 * read; a chunked request has no Content-Length, so the decoded length is checked as well.
 *
 * `allowEmpty` is for the work actions, where a body-less POST (withdraw) means "no
 * fields" rather than a malformed request. Every other route keeps refusing an empty body.
 */
async function readJson(request, provider, origin, env, { allowEmpty = false, maxBytes = REQUEST_MAX_BYTES, tooLargeHint } = {}) {
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

/**
 * The principal behind a matched credential, phase 1. C6.1 makes identify() in src/identity.js
 * the only function allowed to turn a request into an identity; that file is WS-C's and does not
 * exist yet, so this is the smallest possible stand-in for it, reading nothing from the request
 * and only the actor authenticate() decided from which secret matched. When identify() lands,
 * every call below becomes a call to it and this goes. Both kinds scope to 'fleet' (C6.1), which
 * is why phase 1 changes nothing an outside caller can see; `person` and `app` are phase 2, do
 * not add them here. And the actor is NEVER read from a request field (A13): a caller who can
 * name their own role names the more privileged one, so X-Balise-Actor is gone for good. */
const principalFor = (actor) => ({ kind: actor === 'ai' ? 'automation' : 'operator', actor });

const tooLarge = (provider, origin, env, maxBytes, hint) =>
  fail('TOO_LARGE', {
    provider,
    origin,
    env,
    message: `The request is over ${maxBytes / 1024} KB, which this service refuses before reading it.`,
    hint: hint || 'Shorten the report to a couple of paragraphs and send it again.',
  });

const notARoute = (origin, env, hint) =>
  fail('NOT_A_ROUTE', { provider: '', origin, env, message: 'That path and method are not a route on this worker.', hint });

const ROUTES_HINT =
  'The routes are POST /report, GET /reports, PATCH /reports/:id, GET /log, POST /open-items, POST /open-items/sync, GET /board, GET /board/summary, the /work routes and GET /health.';

// ── The router ────────────────────────────────────────────────────────────────
// WHICH HANDLERS TAKE A SCOPE, AND WHY THE REST DO NOT. Three derive one and hand it to the
// store: `deskList` and `deskPatch` from the credential that matched, and `ingest` from the
// route itself (FLEET_SCOPE, reading no credential at all). The others pass none, which is a
// statement rather than an omission, an unused scope parameter reading as a guard that is not
// there. `importRoute` and `work` are fleet-only by invariant 4.3, open items and queued items
// both, so src/store-open.js, src/store-work.js and src/store-work-runner.js carry the literal
// and there is nothing to bind. `openBoard`, `openBoardSummary`, `resolvedLog` and `health`
// carry the literal because C6.5 requires it: written that way, no tenant row CAN be published,
// structurally, whatever a caller sends. So when a handler gains a scope argument, answer first
// which statement binds it; if none does, it should not have one.

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
    //
    // The two board reads are the exception, amendment A8 (docs/DESIGN-WORK-QUEUE.md
    // section 6). They serve only sentences a person published and counts of them, they
    // never read a credential, and they exist so other sections of the fleet can show
    // them, which a three-origin allowlist would make impossible. Everything else keeps C2.2.
    const publicRead = method === 'GET' && (path === '/board' || path === '/board/summary');
    if (!publicRead && originVerdict(origin, env) === 'denied') {
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
    if (path === '/open-items' || path === '/open-items/sync') {
      if (method !== 'POST') return notARoute(origin, env, 'An import is POST /open-items, and POST /open-items/sync closes what it did not see.');
      return await importRoute(request, env, origin, ip, now, path === '/open-items/sync');
    }
    if (path === '/board/summary') {
      if (method !== 'GET') return notARoute(origin, env, 'The board counts are read with GET /board/summary.');
      return await openBoardSummary(env, { now });
    }
    if (path === '/board') {
      if (method !== 'GET') return notARoute(origin, env, 'The open-items board is read with GET /board.');
      return await openBoard(request, env);
    }
    if (path === '/work' || path.startsWith('/work/')) {
      const target = parseWorkPath(path, method);
      if (target.hint) return notARoute(origin, env, target.hint);
      return await work(request, env, origin, ip, now, target);
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
  if (path.startsWith('/open-items') || path === '/work' || path.startsWith('/work/')) return 'desk';
  if (path === '/log' || path === '/board' || path === '/board/summary') return 'log';
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

// ── GET /reports ──────────────────────────────────────────────────────────────

async function deskList(request, env, origin, ip, now) {
  const P = 'desk';
  const key = actorKey(await ipHash(env.BALISE_IP_SALT, ip), ip);
  const auth = await authenticate(request, env, env.DB, key, now);
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
async function importRoute(request, env, origin, ip, now, isSync) {
  const P = 'desk';
  const key = actorKey(await ipHash(env.BALISE_IP_SALT, ip), ip);
  const auth = await authenticate(request, env, env.DB, key, now);
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
async function work(request, env, origin, ip, now, target) {
  const P = 'desk';
  const key = actorKey(await ipHash(env.BALISE_IP_SALT, ip), ip);
  const auth = await authenticate(request, env, env.DB, key, now);
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
 * so this line plus the budgets in tests/local-d1-rows.test.mjs is the only thing that
 * would notice a query that scans the table before it reaches production and burns the
 * daily allowance.
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
