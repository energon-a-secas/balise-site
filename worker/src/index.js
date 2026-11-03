// Balise: the fleet's correction-reporting Worker, the fleet's open-items board, and the
// work queue that lets an agent pick those items up.
//
// THIS FILE IS THE ROUTER AND NOTHING ELSE: which handler a path and method reach, the two
// shared gates (origin, then a bound database), the version constant and the never-500 wrapper.
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
//   /apps, /apps/:app/items    registered apps and their items      (src/routes-apps.js)
//
// The feeds share one table and one rule: text arrives PRIVATE, a person decides, and only a
// sentence that person typed reaches a public page. NOTHING ON ANY FEED PUBLISHES ITSELF.
//
// Contracts this file enforces, all frozen in docs/delivery/CONTRACTS.md:
//   C1  the report shape        -> src/validate.js
//   C2  the error envelope      -> src/envelope.js
//   C3  operator authentication -> src/auth.js, plus auth_attempts in src/store.js
//   C4  the status vocabulary   -> src/transitions.js, enforced in src/store.js
// and the work queue's action table (docs/DESIGN-WORK-QUEUE.md) -> src/work.js.
//
// No response from this Worker is ever HTTP 500: see the wrapper at the bottom.
//
// /report, /log, /board and /board/summary NEVER read the Authorization header. A public
// route that also honours an operator credential is one refactor away from leaking the queue.
//
// WHERE THE ROUTE BODIES LIVE, split along the credential:
//
//   src/routes-public.js  ingest, resolvedLog, health                      no credential
//   src/routes-open.js    openBoard, openBoardSummary                      no credential
//   src/routes-desk.js    deskList, deskPatch, importRoute, work           C3
//   src/routes-apps.js    the /apps routes                                 an app key, C3 or a person
//
// Every credential is read through identify() in src/identity.js, the only file that imports
// src/auth.js; tests/tenant-scope.test.mjs gives every file under src/ a credential role.

import { ERROR_CODES, fail, corsHeaders, originVerdict } from './envelope.js';
import { ingest, resolvedLog, health } from './routes-public.js';
import { deskList, deskPatch, importRoute, work } from './routes-desk.js';
import { openBoard, openBoardSummary } from './routes-open.js';
import { parseWorkPath } from './routes-work.js';
import { ingestAppId, parseAppsPath, appPreflight, appIngest, appRegister, appRead } from './routes-apps.js';

export { ERROR_CODES };

// 1.1.0 is the open-items board and the work queue; 1.0.0 shipped corrections alone. A15 PINS
// THIS CONSTANT TO THIS FILE and holds it at 1.1.0 until the tenant campaign's last phase, because
// scripts/release-work-queue.sh refuses any other value. GET /health is handed it, not importing it.
const VERSION = '1.1.0';

const notARoute = (origin, env, hint) =>
  fail('NOT_A_ROUTE', { provider: '', origin, env, message: 'That path and method are not a route on this worker.', hint });

const ROUTES_HINT =
  'The routes are POST /report, GET /reports, PATCH /reports/:id, GET /log, POST /open-items, POST /open-items/sync, GET /board, GET /board/summary, the /work routes, the /apps routes and GET /health.';

// ── The router ────────────────────────────────────────────────────────────────
// THE ROUTER PASSES NO CREDENTIAL AND DERIVES NO PRINCIPAL. Every handler that needs one calls
// identify() itself and derives its scope there, so `request` goes through whole. Handlers that
// take no scope carry the fleet literal in their SQL instead: invariant 4.3 for the import and
// the work queue, C6.5 for every credential-free read.

const router = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;
    const now = Date.now();
    const ip = request.headers.get('CF-Connecting-IP') || '';

    // An app's ingest route answers its own origin list, not BALISE_ALLOWED_ORIGINS (C6.3), so it
    // runs before the gate below. A Balise origin's preflight keeps the Balise answer, which is
    // what lets the console read GET /apps/:app/items from the same path.
    const appId = ingestAppId(path);
    if (appId !== null && method === 'POST') return await appIngest(request, env, { origin, ip, now, appId });
    if (method === 'OPTIONS') {
      if (appId !== null && originVerdict(origin, env) !== 'allowed') return await appPreflight(env, { origin, appId });
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
      return await ingest(request, env, { origin, ip, now });
    }
    if (path === '/reports') {
      if (method !== 'GET') return notARoute(origin, env, 'The queue is read with GET /reports.');
      return await deskList(request, env, { origin, ip, now });
    }
    if (path.startsWith('/reports/')) {
      if (method !== 'PATCH') return notARoute(origin, env, 'A status change is PATCH /reports/:id.');
      return await deskPatch(request, env, { origin, ip, now, id: decodeURIComponent(path.slice('/reports/'.length)) });
    }
    if (path === '/log') {
      if (method !== 'GET') return notARoute(origin, env, 'The public log is read with GET /log.');
      return await resolvedLog(request, env, { origin });
    }
    if (path === '/open-items' || path === '/open-items/sync') {
      if (method !== 'POST') return notARoute(origin, env, 'An import is POST /open-items, and POST /open-items/sync closes what it did not see.');
      return await importRoute(request, env, { origin, ip, now, isSync: path === '/open-items/sync' });
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
      return await work(request, env, { origin, ip, now, target });
    }
    if (path === '/apps' || path.startsWith('/apps/')) {
      const target = parseAppsPath(path, method);
      if (target.hint) return notARoute(origin, env, target.hint);
      if (target.route === 'register') return await appRegister(request, env, { origin, ip, now });
      return await appRead(request, env, { origin, ip, now, target });
    }
    if (path === '/health') {
      if (method !== 'GET') return notARoute(origin, env, 'Health is read with GET /health.');
      return await health(env, { origin, now, version: VERSION });
    }
    return notARoute(origin, env, ROUTES_HINT);
  },
};

const surfaceFor = (path) => {
  if (path === '/report') return 'ingest';
  if (path === '/reports' || path.startsWith('/reports/')) return 'desk';
  if (path.startsWith('/open-items') || path === '/work' || path.startsWith('/work/')) return 'desk';
  if (path === '/log' || path === '/board' || path === '/board/summary') return 'log';
  if (path === '/apps' || path.startsWith('/apps/')) return 'apps';
  return '';
};

// ── The never-500 wrapper ─────────────────────────────────────────────────────

export default {
  /** C2: no response is ever HTTP 500, including the ones a bug produces. An uncaught throw
   *  would reach the site as a 500 page with no CORS headers, which it cannot read. */
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
