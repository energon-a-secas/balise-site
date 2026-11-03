// Phase 2's routes, in process: the real router over node:sqlite (tests/sqlite-d1.mjs), the way
// tests/open-store.test.mjs drives it. Every app here is registered through registerApp(), because
// POST /apps takes the operator token and node has no crypto.subtle.timingSafeEqual; that route,
// and the same flows against a real D1, are tests/apps-d1.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sqliteD1 } from './sqlite-d1.mjs';
import { invariantCounts } from './tenant-fixture.mjs';
import worker from '../src/index.js';
import { FLEET_SCOPE, scopeFor } from '../src/scope.js';
import { insertReport } from '../src/store.js';
import { fingerprintInput, sha256Hex } from '../src/keys.js';
import { registerApp, disableApp, revokeKey, listApps, DAILY_ITEM_CAP } from '../src/store-apps.js';
import { listItems } from '../src/store-tenant.js';
import { readAs, moveAs } from '../src/routes-apps.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const BALISE = 'https://balise.neorgon.com';
const A_ORIGIN = 'https://a.example';
const B_ORIGIN = 'https://b.example';

/** One isolated world: a database, an env, two registered apps, and a log of limiter keys. */
async function world({ limiter = true } = {}) {
  const db = sqliteD1();
  const limited = [];
  const env = { DB: db, BALISE_IP_SALT: 'test-salt' };
  if (limiter) env.APP_INGEST_LIMITER = { limit: async ({ key }) => { limited.push(key); return { success: !env.refuse }; } };
  const a = await registerApp(db, { owner: 'owner-a', ownerLabel: null, name: 'App A', origins: [A_ORIGIN], now: NOW });
  const b = await registerApp(db, { owner: 'owner-b', ownerLabel: null, name: 'App B', origins: [B_ORIGIN], now: NOW });
  return { db, env, limited, a, b };
}

/** One request through the router. Returns status, every header, and the body as text and JSON. */
async function call(env, path, { method = 'GET', key, origin, body, ip = '203.0.113.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  if (origin) headers.Origin = origin;
  const res = await worker.fetch(new Request(`https://balise-api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: Object.fromEntries(res.headers), text, body: json };
}

const item = (n, over = {}) => ({ v: 1, kind: 'wrong', body: `Item ${n}: the label on this button is wrong.`, ...over });
const post = (env, app, key, origin, body, ip) => call(env, `/apps/${app.app.id}/items`, { method: 'POST', key, origin, body, ip });
const rows = (db, appId) => db.sqlite.prepare('SELECT id, body FROM reports WHERE app_id = ? ORDER BY created_at').all(appId);
const corsOf = (headers) => Object.keys(headers).filter((h) => h.startsWith('access-control-'));

test('#83: two apps each post with their own key from their own origin, and neither key works for the other', async () => {
  const { db, env, a, b } = await world();
  for (const [app, origin] of [[a, A_ORIGIN], [b, B_ORIGIN]]) {
    const browser = await post(env, app, app.keys.public.key, origin, item(1));
    assert.equal(browser.status, 200, browser.text);
    assert.deepEqual(Object.keys(browser.body).sort(), ['id', 'ok', 'provider', 'status']);
    assert.equal(browser.body.provider, 'apps');
    assert.equal(browser.headers['access-control-allow-origin'], origin);
    const server = await post(env, app, app.keys.secret.key, null, item(2));
    assert.equal(server.status, 200, server.text);
    assert.equal(corsOf(server.headers).length, 0, 'a server-side post was answered with CORS headers');
  }
  assert.equal(rows(db, a.app.id).length, 2);
  assert.equal(rows(db, b.app.id).length, 2);
  // A's key on B's path, and A's key from B's page.
  assert.equal((await post(env, b, a.keys.public.key, B_ORIGIN, item(3))).body.code, 'UNAUTHORIZED');
  assert.equal((await post(env, b, a.keys.secret.key, null, item(3))).body.code, 'UNAUTHORIZED');
  assert.equal((await post(env, a, a.keys.public.key, B_ORIGIN, item(3))).body.code, 'NOT_FOUND');
  assert.equal(rows(db, a.app.id).length + rows(db, b.app.id).length, 4, 'a refused post stored a row');
  // The key decides which app is written, not the body.
  assert.equal((await post(env, a, a.keys.secret.key, null, item(4, { app_id: b.app.id }))).status, 200);
  assert.equal(rows(db, a.app.id).length, 3);
  assert.deepEqual(invariantCounts(db), { "an open item is always the fleet's": 0, "a row in the work queue is always the fleet's": 0 });
});

test('7.1: two apps filing the same thing both get a row, a repeat inside one gets none, and the fleet keeps its own', async () => {
  const { db, env, a, b } = await world();
  const same = item(1, { site: 'checkout', url: 'https://shop.example/cart', target: { kind: 'button', id: 'pay', label: 'Pay' } });
  assert.equal((await post(env, a, a.keys.secret.key, null, same)).status, 200);
  assert.equal((await post(env, b, b.keys.secret.key, null, same)).status, 200);
  assert.equal((await post(env, a, a.keys.secret.key, null, same)).body.code, 'DUPLICATE');
  const scopeA = scopeFor({ kind: 'app', app_id: a.app.id });
  const scopeB = scopeFor({ kind: 'app', app_id: b.app.id });
  const seenA = (await listItems(db, scopeA, { status: null, before: null, limit: 50 })).items;
  const seenB = (await listItems(db, scopeB, { status: null, before: null, limit: 50 })).items;
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 1);
  assert.notEqual(seenA[0].id, seenB[0].id);

  // The beacon's own path for the same sentence: the fleet's fingerprint, the fleet's row.
  const fleetRow = async (id) => insertReport(db, FLEET_SCOPE, {
    ...same, contact: null, id, created_at: NOW, ip_hash: null,
    fingerprint: await sha256Hex(fingerprintInput(FLEET_SCOPE.appId, same.site, same.target.id, same.body)),
  });
  assert.equal((await fleetRow('fleet-1')).id, 'fleet-1');
  assert.deepEqual(await fleetRow('fleet-2'), { duplicate: true });
  assert.deepEqual(db.sqlite.prepare('SELECT app_id, COUNT(*) AS n FROM reports GROUP BY app_id ORDER BY app_id').all().map((r) => [r.app_id, r.n]),
    [[a.app.id, 1], [b.app.id, 1], ['fleet', 1]].sort());
});

test('C6.3 and C6.8: an unknown app, a switched-off app, an origin off the list and Origin null answer byte for byte alike', async () => {
  const { db, env, a, b } = await world();
  await disableApp(db, scopeFor({ kind: 'app', app_id: b.app.id }), { now: NOW });
  const answers = [
    ['an unknown app', await call(env, '/apps/apzzzzzzzzzzzzzz/items', { method: 'POST', key: a.keys.public.key, origin: A_ORIGIN, body: item(1) })],
    ['the fleet as an app', await call(env, '/apps/fleet/items', { method: 'POST', key: a.keys.public.key, origin: A_ORIGIN, body: item(1) })],
    ['a malformed app id', await call(env, '/apps/%E0%A4%A/items', { method: 'POST', key: a.keys.public.key, origin: A_ORIGIN, body: item(1) })],
    ['a switched-off app', await post(env, b, b.keys.public.key, B_ORIGIN, item(1))],
    ['an origin off the list', await post(env, a, a.keys.public.key, 'https://elsewhere.example', item(1))],
    ['a Balise origin', await post(env, a, a.keys.public.key, BALISE, item(1))],
    ['Origin: null', await post(env, a, a.keys.public.key, 'null', item(1))],
  ];
  const [, first] = answers[0];
  assert.equal(first.status, 404);
  assert.equal(first.body.code, 'NOT_FOUND');
  for (const [name, answer] of answers) {
    assert.equal(answer.status, first.status, name);
    assert.equal(answer.text, first.text, `${name} answered differently from an unknown app`);
    assert.deepEqual(answer.headers, first.headers, `${name} carried different headers`);
    assert.equal(corsOf(answer.headers).length, 0, `${name} carried CORS headers`);
  }
  assert.equal(rows(db, a.app.id).length + rows(db, b.app.id).length, 0);
});

test('C6.3: the preflight answers an app\'s own origins, identically refuses everything else, and the lists never merge', async () => {
  const { db, env, a, b } = await world();
  await disableApp(db, scopeFor({ kind: 'app', app_id: b.app.id }), { now: NOW });
  const preflight = (app, origin) => call(env, `/apps/${app}/items`, { method: 'OPTIONS', origin });
  const allowed = await preflight(a.app.id, A_ORIGIN);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], A_ORIGIN);
  assert.equal(allowed.headers['access-control-allow-methods'], 'POST, OPTIONS');
  assert.equal(allowed.headers['access-control-max-age'], '600');
  assert.match(allowed.headers.vary, /Origin/);

  const refused = await preflight(a.app.id, 'https://elsewhere.example');
  assert.equal(refused.status, 204);
  assert.equal(corsOf(refused.headers).length, 0);
  for (const [app, origin] of [['apzzzzzzzzzzzzzz', A_ORIGIN], [b.app.id, B_ORIGIN], [a.app.id, 'null'], [a.app.id, B_ORIGIN]]) {
    const answer = await preflight(app, origin);
    assert.deepEqual([answer.status, answer.headers, answer.text], [refused.status, refused.headers, refused.text], `${app} from ${origin}`);
  }
  // Balise's own page keeps Balise's answer on the same path, which is what lets the console read.
  assert.match((await preflight(a.app.id, BALISE)).headers['access-control-allow-methods'], /PATCH/);
  // And an app's origin opens nothing else in the Worker.
  for (const [path, method] of [['/report', 'POST'], ['/log', 'GET'], ['/apps', 'POST'], [`/apps/${a.app.id}/items`, 'GET']]) {
    const answer = await call(env, path, { method, origin: A_ORIGIN, body: method === 'POST' ? {} : undefined });
    assert.equal(answer.body.code, 'FORBIDDEN_ORIGIN', `${method} ${path} accepted an app's origin`);
  }
  assert.equal(corsOf((await call(env, '/log', { method: 'OPTIONS', origin: A_ORIGIN })).headers).length, 0);
});

test('C6.2: a bsk_ key from a page and a bpk_ key from no page are refused, and so are a revoked key and a contact field', async () => {
  const { db, env, a } = await world();
  const fromPage = await post(env, a, a.keys.secret.key, A_ORIGIN, item(1));
  assert.equal(fromPage.status, 403);
  assert.equal(fromPage.body.code, 'FORBIDDEN_ORIGIN');
  assert.match(fromPage.body.hint, /Revoke this bsk_ key/);
  assert.equal(fromPage.headers['access-control-allow-origin'], A_ORIGIN, 'the page cannot read why it was refused');
  const fromServer = await post(env, a, a.keys.public.key, null, item(1));
  assert.equal(fromServer.body.code, 'FORBIDDEN_ORIGIN');

  await revokeKey(db, scopeFor({ kind: 'app', app_id: a.app.id }), { keyId: a.keys.public.id, now: NOW });
  assert.equal((await post(env, a, a.keys.public.key, A_ORIGIN, item(1))).body.code, 'UNAUTHORIZED');
  assert.equal((await post(env, a, 'not-a-key', A_ORIGIN, item(1))).body.code, 'UNAUTHORIZED');
  assert.equal((await post(env, a, undefined, null, item(1))).body.code, 'UNAUTHORIZED');

  const contact = await post(env, a, a.keys.secret.key, null, item(1, { contact: 'reader@example.com' }));
  assert.equal(contact.body.code, 'BAD_FIELD');
  assert.equal((await post(env, a, a.keys.secret.key, null, '{not json')).body.code, 'BAD_FIELD');
  assert.equal(rows(db, a.app.id).length, 0, 'a refused post stored a row');
});

test('Q9: the binding counts a bpk_ per app and visitor and a bsk_ per app, and refuses with a sentence that names no number', async () => {
  const { db, env, limited, a } = await world();
  await post(env, a, a.keys.public.key, A_ORIGIN, item(1), '203.0.113.1');
  await post(env, a, a.keys.public.key, A_ORIGIN, item(2), '203.0.113.2');
  await post(env, a, a.keys.secret.key, null, item(3));
  assert.equal(limited.length, 3);
  assert.ok(limited[0].startsWith(`${a.app.id}:`) && limited[1].startsWith(`${a.app.id}:`));
  assert.notEqual(limited[0], limited[1], 'two visitors shared a bucket');
  assert.ok(!limited[0].includes('203.0.113'), 'the raw address reached the binding while a salt is bound');
  assert.equal(limited[2], a.app.id);

  env.refuse = true;
  const refused = await post(env, a, a.keys.public.key, A_ORIGIN, item(4));
  assert.equal(refused.body.code, 'RATE_LIMITED');
  assert.doesNotMatch(`${refused.body.message} ${refused.body.hint}`, /\d/, 'the binding\'s number was promised (Q9)');
  assert.equal(refused.headers['access-control-allow-origin'], A_ORIGIN);
  assert.equal(rows(db, a.app.id).length, 3);

  const open = await world({ limiter: false });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await post(open.env, open.a, open.a.keys.secret.key, null, item(1))).status, 200, 'an unbound limiter refused the post');
  } finally {
    console.warn = warn;
  }
});

test('Q9 and A14: past the daily cap an item is refused with the daily sentence, and tomorrow it is taken again', async () => {
  const { db, env, a } = await world();
  const window = Math.floor(NOW / 86_400_000) * 86_400_000;
  db.sqlite.prepare('INSERT INTO submit_counters (key, window_start, count) VALUES (?, ?, ?)').run(`app-day:${a.app.id}`, window, DAILY_ITEM_CAP);
  const over = await post(env, a, a.keys.secret.key, null, item(1));
  assert.equal(over.body.code, 'RATE_LIMITED');
  assert.match(over.body.message, /daily limit/);
  assert.match(over.body.hint, /midnight UTC/);
  assert.equal(rows(db, a.app.id).length, 0);

  const tomorrow = { ...env };
  const realNow = Date.now;
  Date.now = () => NOW + 86_400_000;
  try {
    assert.equal((await post(tomorrow, a, a.keys.secret.key, null, item(1))).status, 200, 'the cap did not reset on a new day');
  } finally {
    Date.now = realNow;
  }
});

test('A4: a tenant post costs at most five D1 statements, and a key\'s last-used date is written once a day', async () => {
  const { db, env, a } = await world();
  const from = db.log.length;
  assert.equal((await post(env, a, a.keys.public.key, A_ORIGIN, item(1))).status, 200);
  const first = db.log.slice(from);
  assert.ok(first.length <= 5, `one post sent ${first.length} statements: ${first.join('\n')}`);
  const mid = db.log.length;
  assert.equal((await post(env, a, a.keys.public.key, A_ORIGIN, item(2))).status, 200);
  const second = db.log.slice(mid);
  assert.equal(second.filter((sql) => /UPDATE app_keys/.test(sql)).length, 0, 'the last-used date was written twice in a day');
  assert.equal(second.length, first.length - 1);
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  assert.equal(db.sqlite.prepare('SELECT last_used_date FROM app_keys WHERE id = ?').get(a.keys.public.id).last_used_date, day);
  assert.equal(db.sqlite.prepare('SELECT last_used_date FROM app_keys WHERE id = ?').get(a.keys.secret.id).last_used_date, null);
});

test('C6.5 and C6.6: /log, /board, /board/summary and /health carry nothing of either app, and /health counts them', async () => {
  const { db, env, a, b } = await world();
  for (const [app, origin] of [[a, A_ORIGIN], [b, B_ORIGIN]]) await post(env, app, app.keys.public.key, origin, item(1));
  // The adversarial case: tenant rows in every published shape a public query selects.
  db.sqlite.prepare(`UPDATE reports SET status = 'fixed', public = 1, fixed_at = ?, public_note = 'TENANT-NOTE' WHERE app_id = ?`).run(NOW, a.app.id);
  db.sqlite.prepare(`UPDATE reports SET kind = 'open', status = 'accepted', public = 1, public_note = 'TENANT-NOTE' WHERE app_id = ?`).run(b.app.id);
  const secrets = [a.app.id, b.app.id, 'App A', 'App B', 'TENANT-NOTE', 'label on this button', a.keys.public.prefix, b.keys.public.prefix, 'owner-a'];
  for (const path of ['/log?limit=50', '/board?limit=50', '/board/summary', '/health']) {
    const answer = await call(env, path);
    assert.equal(answer.status, 200, `${path}: ${answer.text}`);
    for (const secret of secrets) assert.ok(!answer.text.includes(secret), `${path} carried ${secret}: ${answer.text}`);
  }
  const health = (await call(env, '/health')).body;
  assert.equal(health.apps, 2);
  assert.equal(typeof health.tenant_items, 'number');
  assert.equal(health.config.app_rate_limiter, true);
  assert.equal(health.store_ok, true);
});

test('a bpk_ key cannot read, list, patch or register, and nothing it reaches answers with an item', async () => {
  const { env, a } = await world();
  await post(env, a, a.keys.public.key, A_ORIGIN, item(1));
  const [stored] = rows(env.DB, a.app.id);
  for (const [path, method] of [
    [`/apps/${a.app.id}/items`, 'GET'], [`/apps/${a.app.id}/items/${stored.id}`, 'GET'], ['/apps', 'GET'],
    [`/apps/${a.app.id}/items/${stored.id}`, 'PATCH'], ['/apps', 'POST'], ['/reports', 'GET'],
  ]) {
    for (const key of [a.keys.public.key, a.keys.secret.key]) {
      const answer = await call(env, path, { method, key, body: method === 'GET' ? undefined : { status: 'fixed', owner: 'x', name: 'x' } });
      assert.notEqual(answer.status, 200, `${method} ${path} answered a key`);
      assert.ok(!answer.text.includes(stored.body) && !answer.text.includes(stored.id), `${method} ${path} leaked the item`);
    }
  }
  assert.equal((await call(env, `/apps/${a.app.id}/items`, { key: a.keys.public.key })).body.code, 'NOT_CONFIGURED');
  assert.equal((await call(env, `/apps/${a.app.id}/items/x`, { method: 'PATCH', body: { status: 'fixed' } })).body.code, 'NOT_CONFIGURED');
  assert.equal((await call(env, `/apps/${a.app.id}/items/x`, { method: 'DELETE' })).body.code, 'NOT_A_ROUTE');
});

test('7.1 at the route: a person reads their own app, and another person\'s app or another app\'s item answers exactly as nothing', async () => {
  const { db, env, a, b } = await world();
  await post(env, a, a.keys.secret.key, null, item(1));
  await post(env, b, b.keys.secret.key, null, item(2));
  const [itemA] = rows(db, a.app.id);
  const [itemB] = rows(db, b.app.id);
  const ownerA = { kind: 'person', person_id: 'owner-a' };
  const ownerB = { kind: 'person', person_id: 'owner-b' };
  const read = async (principal, target, query = '') => {
    const res = await readAs(env, principal, target, { url: new URL(`https://balise-api.test/x${query}`), origin: null });
    return { status: res.status, text: await res.text() };
  };

  const mine = JSON.parse((await read(ownerA, { route: 'items', appId: a.app.id })).text);
  assert.deepEqual(mine.items.map((i) => i.id), [itemA.id]);
  assert.equal(JSON.parse((await read(ownerA, { route: 'item', appId: a.app.id, id: itemA.id })).text).item.body, itemA.body);

  const nothing = await read(ownerB, { route: 'item', appId: a.app.id, id: 'never-existed' });
  assert.equal(nothing.status, 404);
  for (const [name, target] of [
    ["another person's app, by its item", { route: 'item', appId: a.app.id, id: itemA.id }],
    ["another person's app, listed", { route: 'items', appId: a.app.id }],
    ["another app's item on my own path", { route: 'item', appId: b.app.id, id: itemA.id }],
    ['no such app', { route: 'items', appId: 'apzzzzzzzzzzzzzz' }],
    ['a malformed app id', { route: 'items', appId: '../fleet' }],
  ]) {
    const answer = await read(ownerB, target);
    assert.deepEqual(answer, nothing, `${name} answered differently from nothing`);
  }
  assert.equal(JSON.parse((await read(ownerB, { route: 'item', appId: b.app.id, id: itemB.id })).text).item.id, itemB.id);

  await disableApp(db, scopeFor(ownerA, (await listApps(db, 'owner-a')).apps[0]), { now: NOW });
  assert.equal(JSON.parse((await read(ownerA, { route: 'items', appId: a.app.id })).text).items.length, 1, "a disabled app's items stopped being readable by their owner");
  const apps = JSON.parse((await read(ownerA, { route: 'apps' })).text).apps;
  assert.deepEqual(apps.map((x) => x.id), [a.app.id]);
  assert.equal(JSON.parse((await read(ownerA, { route: 'items', appId: a.app.id }, '?status=accepted')).text).code, 'BAD_FIELD');
});

test("C6.4 at the route: an owner moves their own item, and another person's item or app answers exactly as nothing", async () => {
  const { db, env, a, b } = await world();
  await post(env, a, a.keys.secret.key, null, item(1));
  const [itemA] = rows(db, a.app.id);
  const ownerA = { kind: 'person', person_id: 'owner-a' };
  const ownerB = { kind: 'person', person_id: 'owner-b' };
  const move = async (principal, appId, id, body) => {
    const res = await moveAs(env, principal, { route: 'move', appId, id }, { body, origin: null, now: NOW + 5 });
    return { status: res.status, text: await res.text() };
  };
  const columns = () => db.sqlite.prepare('SELECT public, public_note, fixed_ref, fixed_at, work_state, work_mode, work_run FROM reports WHERE id = ?').get(itemA.id);
  const before = { ...columns() };

  const nothing = await move(ownerB, b.app.id, 'never-existed', { status: 'fixed' });
  assert.equal(nothing.status, 404);
  for (const [name, appId, id, body] of [
    ["another person's item on their path", a.app.id, itemA.id, { status: 'fixed' }],
    ["another app's item on my path", b.app.id, itemA.id, { status: 'fixed' }],
    ["another person's item, with a body that would be refused", a.app.id, itemA.id, { status: 'fixed', public: true }],
    ['no such app', 'apzzzzzzzzzzzzzz', itemA.id, { status: 'fixed' }],
  ]) {
    assert.deepEqual(await move(ownerB, appId, id, body), nothing, `${name} answered differently from nothing`);
  }
  assert.equal(rows(db, a.app.id)[0].id, itemA.id);
  assert.equal(db.sqlite.prepare('SELECT status FROM reports WHERE id = ?').get(itemA.id).status, 'new', 'a cross-tenant PATCH moved the item');

  for (const field of ['public', 'public_note', 'fixed_ref', 'work_state', 'duplicate_of']) {
    const refused = JSON.parse((await move(ownerA, a.app.id, itemA.id, { status: 'fixed', [field]: 'x' })).text);
    assert.equal(refused.code, 'BAD_FIELD', `${field} was not refused`);
  }
  for (const to of ['accepted', 'spam']) {
    assert.equal(JSON.parse((await move(ownerA, a.app.id, itemA.id, { status: to })).text).code, 'BAD_TRANSITION', `a person moved to ${to}`);
  }
  const moved = JSON.parse((await move(ownerA, a.app.id, itemA.id, { status: 'fixed' })).text);
  assert.equal(moved.item.status, 'fixed');
  assert.equal(moved.item.decided_at, NOW + 5);
  assert.deepEqual({ ...columns() }, before, 'a tenant move wrote a public, published or work column');
  assert.equal(JSON.parse((await move(ownerA, a.app.id, itemA.id, { status: 'new' })).text).item.decided_at, null);
  for (const path of ['/log?limit=50', '/board?limit=50', '/board/summary']) {
    assert.ok(!(await call(env, path)).text.includes(itemA.id), `${path} published a tenant item after a move`);
  }
});
