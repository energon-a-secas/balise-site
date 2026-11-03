// The /apps routes: registered apps, their keys, and their items.
//
//   POST    /apps                    register an app    operator token (phase 2's stand-in, P4)
//   OPTIONS /apps/:app/items         the app's preflight, decided by the app's own origin list
//   POST    /apps/:app/items         one item           the app's bpk_ or bsk_ key (C6.2, C6.3)
//   GET     /apps                    my apps            a signed-in person: NOT_CONFIGURED until phase 3
//   GET     /apps/:app/items[/:id]   my app's items     a signed-in person: NOT_CONFIGURED until phase 3
//
// POST /apps/:app/items and its preflight are the ONE place in the Worker governed by an app's
// origin list instead of BALISE_ALLOWED_ORIGINS, so src/index.js sends them here before its own
// origin gate. The two lists are never merged (C6.3), and the beacon's /report is untouched.

import { fail, ok, readJson } from './envelope.js';
import { identify } from './identity.js';
import { scopeFor } from './scope.js';
import { insertReport } from './store.js';
import { fingerprintInput, sha256Hex, ipHash, actorKey } from './keys.js';
import { registerApp, getApp, listApps, touchKey, countAppItem, dayOf, DAILY_ITEM_CAP } from './store-apps.js';
import { listItems, getItem } from './store-tenant.js';
import { validateRegistration, validateTenantItem, validateItemQuery, isAppId } from './validate-apps.js';

const P = 'apps';
const ITEMS_PATH = /^\/apps\/([^/]+)\/items$/;
const ITEM_PATH = /^\/apps\/([^/]+)\/items\/([^/]+)$/;
const ID_MAX = 64;

// Unknown app, switched-off app, origin not on its list: one answer, no CORS headers (C6.3, C6.8).
const NO_SUCH_APP = {
  message: 'No app at this address takes items from here.',
  hint: 'Check the app id in the address, and that this page\'s web address is on the app\'s list.',
};
// Another person's app, another app's item, no such item: one answer (C6.4).
const NOTHING_HERE = {
  message: 'Nothing at this address belongs to an app you own.',
  hint: 'Open your apps at balise.neorgon.com/apps and pick the item from there.',
};

/** The app id in POST|OPTIONS /apps/:app/items, or null for any other path. */
export function ingestAppId(path) {
  const match = ITEMS_PATH.exec(path);
  return match ? safeDecode(match[1]) : null;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return '';
  }
}

/** Which /apps route a path and method reach, or { hint } for NOT_A_ROUTE. */
export function parseAppsPath(path, method) {
  if (path === '/apps') {
    if (method === 'POST') return { route: 'register' };
    return method === 'GET' ? { route: 'apps' } : { hint: 'An app is registered with POST /apps, and listed with GET /apps.' };
  }
  const items = ITEMS_PATH.exec(path);
  if (items) return method === 'GET' ? { route: 'items', appId: safeDecode(items[1]) } : { hint: 'Items are sent with POST /apps/:app/items and read with GET.' };
  const item = ITEM_PATH.exec(path);
  if (item) return method === 'GET' ? { route: 'item', appId: safeDecode(item[1]), id: safeDecode(item[2]) } : { hint: 'One item is read with GET /apps/:app/items/:id.' };
  return { hint: 'The app routes are POST and GET /apps, and POST and GET /apps/:app/items.' };
}

/** CORS for an origin on an app's own list. POST only, and a ten-minute preflight cache. */
export const appCors = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
});

/** The app row if it exists and is switched on, else null; or a store error. */
async function liveApp(env, appId) {
  if (!env || !env.DB || !isAppId(appId)) return { app: null };
  const found = await getApp(env.DB, appId);
  if (found.code) return found;
  return { app: found.app && !found.app.disabled_at ? found.app : null };
}

/** 'absent', 'allowed' or 'refused'. `Origin: null` is never on a list, so it is refused. */
const originFor = (origin, app) => {
  if (!origin) return 'absent';
  return origin !== 'null' && app.origins.includes(origin) ? 'allowed' : 'refused';
};

// ── OPTIONS /apps/:app/items ──────────────────────────────────────────────────

export async function appPreflight(env, { origin, appId }) {
  const found = await liveApp(env, appId);
  const allowed = !found.code && found.app && originFor(origin, found.app) === 'allowed';
  return new Response(null, { status: 204, headers: allowed ? appCors(origin) : {} });
}

// ── POST /apps/:app/items ─────────────────────────────────────────────────────

export async function appIngest(request, env, { origin, ip, now, appId }) {
  const found = await liveApp(env, appId);
  if (found.code) return fail(found.code, { provider: P, message: found.message, hint: found.hint, cors: false });
  const verdict = found.app ? originFor(origin, found.app) : 'refused';
  if (!found.app || verdict === 'refused') return fail('NOT_FOUND', { provider: P, ...NO_SUCH_APP, cors: false });
  const app = found.app;
  const cors = verdict === 'allowed' ? appCors(origin) : {};
  const refuse = (code, message, hint) => fail(code, { provider: P, message, hint, cors: false, headers: cors });

  const who = await identify(request, env, env.DB, { now, ip, accept: ['app'], app: app.id });
  if (who.error) return refuse(who.error.code, who.error.message, who.error.hint);
  const key = who.principal;
  if (key.key_kind === 'secret' && verdict !== 'absent') {
    return refuse('FORBIDDEN_ORIGIN', 'A bsk_ key was sent from a web page, and a web page cannot keep it secret.', 'Send items from the page with the app\'s bpk_ key. Revoke this bsk_ key and make a new one for your server.');
  }
  if (key.key_kind === 'public' && verdict === 'absent') {
    return refuse('FORBIDDEN_ORIGIN', 'A bpk_ key only works from a web page on the app\'s list.', 'Send it from that page, or use the app\'s bsk_ key from a server.');
  }

  // Before the body is read, as on /report. Fails open when unbound: the D1 daily cap below is
  // the limit that holds, and this binding is an abuse ceiling that counts per location (A3).
  const hashed = await ipHash(env.BALISE_IP_SALT, ip);
  if (env.APP_INGEST_LIMITER && typeof env.APP_INGEST_LIMITER.limit === 'function') {
    const limitKey = key.key_kind === 'public' ? `${app.id}:${actorKey(hashed, ip)}` : app.id;
    if (!(await env.APP_INGEST_LIMITER.limit({ key: limitKey })).success) {
      return refuse('RATE_LIMITED', 'That is more items than this app takes from one place in a short time.', 'Wait a minute and send it again.');
    }
  } else {
    console.warn('APP_INGEST_LIMITER is not bound; app ingest is running on the daily cap alone');
  }

  const parsed = await readJson(request, P, null, env);
  if (parsed.error) return refuse(...(await envelopeOf(parsed.error)));
  const checked = validateTenantItem(parsed.value, app.id);
  if (checked.code) return refuse(checked.code, checked.message, checked.hint);
  const item = checked.value;

  const counted = await countAppItem(env.DB, app.id, now);
  if (counted.code) return refuse(counted.code, counted.message, counted.hint);
  if (counted.count > DAILY_ITEM_CAP) {
    return refuse('RATE_LIMITED', `This app has sent its ${DAILY_ITEM_CAP} items for today, which is the daily limit.`, 'The count starts again at midnight UTC. The app\'s owner can see what already arrived.');
  }

  const scope = scopeFor(key);
  const fingerprint = await sha256Hex(fingerprintInput(scope.appId, item.site, item.target && item.target.id, item.body));
  const result = await insertReport(env.DB, scope, { ...item, contact: null, id: crypto.randomUUID(), created_at: now, ip_hash: hashed, fingerprint });
  if (result.code) return refuse(result.code, result.message, result.hint);
  if (result.duplicate) return refuse('DUPLICATE', 'That exact item has already been sent to this app.', 'It is already on the app\'s list, so there is nothing more to do.');

  const day = dayOf(now);
  if (key.last_used_date !== day) await touchKey(env.DB, key.key_id, day);
  return ok(P, { id: result.id, status: 'new' }, { headers: cors });
}

/** readJson answers with a finished Response; this reads its code and sentences back out, so the
 *  refusal can carry the app's CORS headers instead of the Balise allowlist's. */
async function envelopeOf(response) {
  const body = await response.json();
  return [body.code, body.message, body.hint];
}

// ── POST /apps ────────────────────────────────────────────────────────────────

export async function appRegister(request, env, { origin, ip, now }) {
  const reply = (r) => fail(r.code, { provider: P, origin, env, message: r.message, hint: r.hint });
  const who = await identify(request, env, env.DB, { now, ip, accept: ['operator'] });
  if (who.error) return reply(who.error);
  const parsed = await readJson(request, P, origin, env);
  if (parsed.error) return parsed.error;
  const checked = validateRegistration(parsed.value);
  if (checked.code) return reply(checked);
  const made = await registerApp(env.DB, { ...checked.value, now });
  if (made.code) return reply(made);
  const endpoint = `${new URL(request.url).origin}/apps/${made.app.id}/items`;
  return ok(P, { app: { ...made.app, endpoint }, keys: made.keys }, { origin, env });
}

// ── GET /apps, GET /apps/:app/items[/:id] ─────────────────────────────────────

export async function appRead(request, env, { origin, ip, now, target }) {
  const who = await identify(request, env, env.DB, { now, ip, accept: ['person'] });
  if (who.error) return fail(who.error.code, { provider: P, origin, env, message: who.error.message, hint: who.error.hint });
  return await readAs(env, who.principal, target, { url: new URL(request.url), origin });
}

/**
 * One read for a person identify() has already proved. The app comes from the path and the owner
 * check comes second (DESIGN.md 5.5), so another person's app and no app answer alike.
 */
export async function readAs(env, principal, target, { url, origin }) {
  const reply = (r) => (r.code
    ? fail(r.code, { provider: P, origin, env, message: r.message, hint: r.hint })
    : ok(P, r, { origin, env }));
  if (target.route === 'apps') return reply(await listApps(env.DB, principal.person_id));

  const nothing = () => fail('NOT_FOUND', { provider: P, origin, env, ...NOTHING_HERE });
  const found = isAppId(target.appId) ? await getApp(env.DB, target.appId) : { app: null };
  if (found.code) return reply(found);
  const scope = found.app ? scopeFor(principal, found.app) : null;
  if (!scope) return nothing();

  if (target.route === 'item') {
    if (!target.id || target.id.length > ID_MAX) return nothing();
    const got = await getItem(env.DB, scope, target.id);
    if (got.code) return reply(got);
    return got.item ? reply({ item: got.item }) : nothing();
  }
  const query = validateItemQuery(url.searchParams);
  if (query.code) return reply(query);
  const page = await listItems(env.DB, scope, query.value);
  if (page.code) return reply(page);
  return reply({ items: page.items, next: page.next, rows_read: page.rowsRead });
}
