// Balise: the fleet's correction-reporting Worker, the fleet's open-items board, and the
// work queue that lets an agent pick those items up.
//
// THIS FILE IS THE ROUTER AND NOTHING ELSE. It decides which handler a path and method reach,
// applies the two gates every route shares (origin, then a bound database), holds the version
// constant and the never-500 wrapper, and hands everything else away. No route body lives here.
// It was 522 lines with every handler inline, over the fleet's 500 line convention in
// CLAUDE.md, and the split that fixed that is recorded at the foot of this header.
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
//
// WHERE THE ROUTE BODIES WENT, and why that seam. Three files, drawn along the credential and
// not along the verb, because the credential is the line the contracts care about:
//
//   src/routes-public.js  ingest, resolvedLog, health                      no credential
//   src/routes-open.js    openBoard, openBoardSummary                      no credential
//                         openImport, openSync            called only from routes-desk.js,
//                                                         which is where their C3 gate is
//   src/routes-desk.js    deskList, deskPatch, importRoute, work, principalFor         C3
//
// The paragraph above about the four credential-free routes used to be a claim about which
// functions inside THIS file called authenticate(), in a file that imported src/auth.js for
// the desk, so nothing could check it: a handler that started reading Authorization would have
// been a two-line diff in an already-imported module. Now src/routes-desk.js is the only file
// in the Worker that imports src/auth.js, this file does not import it either, and the rule is
// one grep. Four smaller moves were needed to get there and each is recorded where it landed:
// `actorKey` went from src/auth.js to src/keys.js (it is the key the credential-free ingest
// limiter and the C3 lockout share, and it was the one thing making /report import C3's own
// file); readJson/tooLarge went to src/envelope.js (every outcome either one has is a C2
// envelope); and src/store.js gave up its two SQL-free sections, the budgets to src/budget.js
// and the derived keys to src/keys.js, because moving `warnRowsRead` INTO it would have pushed
// that file over the same 500 line cap this split exists to respect. src/store.js re-exports
// all seven, so no existing caller of any of them changed. No route's behaviour changed: the
// handler bodies moved verbatim, and the only signature change is that they take the
// per-request values as one object rather than as four positional arguments, plus `health`
// receiving VERSION as an argument so the constant below stays in the file the release checks.
//
// src/store-open.js (520) and src/store-work.js (502) are ALSO over the convention and are
// deliberately left that way: an accepted deviation recorded by delivery-lead at A31, not an
// oversight. Do not split them as a side effect of touching this one.

import { ERROR_CODES, fail, corsHeaders, originVerdict } from './envelope.js';
import { ingest, resolvedLog, health } from './routes-public.js';
import { deskList, deskPatch, importRoute, work } from './routes-desk.js';
import { openBoard, openBoardSummary } from './routes-open.js';
import { parseWorkPath } from './routes-work.js';

export { ERROR_CODES };

// 1.1.0 is the open-items board and the work queue together: 1.0.0 shipped the corrections
// feed alone, and the board was built after it without a bump, so the release checks this
// number to tell the two builds apart.
//
// A15 PINS THIS CONSTANT TO THIS FILE. It is read by GET /health, which lives in
// src/routes-public.js now and is handed the value below rather than importing it: that file is
// one of the four this one imports, so reading it back from there would be a cycle. Check it by
// name and not by line number: `grep -n "const VERSION" src/index.js`.
const VERSION = '1.1.0';

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
//
// THE ROUTER PASSES NO CREDENTIAL AND DERIVES NO PRINCIPAL. Every handler that needs one calls
// authenticate() itself, inside src/routes-desk.js. That is why `request` goes through whole:
// a router that read the header once and handed an actor down would make every handler's
// credential-free-ness a property of the router's bookkeeping rather than of the handler.

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
  return '';
};

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
