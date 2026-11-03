// Phase 2 of the multi-tenant campaign, offline: the app key format, the /apps shapes, the
// person transition table, the apps and tenant stores, and identify(). Over node:sqlite
// (tests/sqlite-d1.mjs), so it needs nothing installed and nothing listening.
//
// The routes are tests/apps-routes.test.mjs, in process, and tests/apps-d1.test.mjs, under
// workerd against a real local D1, which is the only place the operator token can be checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sqliteD1 } from './sqlite-d1.mjs';
import { T, TENANT, json, plantReport, source, codeOf } from './tenant-fixture.mjs';
import { FLEET, FLEET_SCOPE, scopeFor } from '../src/scope.js';
import { mintAppKey, appKeyKind, sha256Hex } from '../src/keys.js';
import { PERSON_TRANSITIONS, STATUSES, canTransition } from '../src/transitions.js';
import {
  validateRegistration, validateOrigin, validateTenantItem, validateItemQuery, validateItemMove, isAppId, TENANT_STATUSES,
} from '../src/validate-apps.js';
import {
  APP_CAP, registerApp, getApp, listApps, listKeys, resolveKey, mintKey, revokeKey, disableApp,
  countAppItem, tenantTally, newAppId,
} from '../src/store-apps.js';
import { listItems, getItem, moveItem, NO_ITEM } from '../src/store-tenant.js';
import { identify, KEY_REFUSED } from '../src/identity.js';

const register = (db, owner = 'owner-a', over = {}) =>
  registerApp(db, { owner, ownerLabel: null, name: 'An app', origins: ['https://a.example'], now: T, ...over });

const bearer = (key) => new Request('https://balise-api.test/apps/x/items', { method: 'POST', headers: { Authorization: `Bearer ${key}` } });

// ── C6.2: the key format ──────────────────────────────────────────────────────

test('C6.2: a key carries its kind in its prefix and ends in a checksum that catches one changed character', () => {
  for (const [kind, prefix] of [['public', 'bpk_'], ['secret', 'bsk_']]) {
    const key = mintAppKey(kind);
    assert.ok(key.startsWith(prefix), key);
    assert.equal(key.length, 53);
    assert.match(key, /^[A-Za-z0-9_-]+$/);
    assert.equal(appKeyKind(key), kind);
    assert.notEqual(mintAppKey(kind), key, 'two keys came out the same');
    // Every position past the prefix, changed to another character the alphabet allows.
    for (let i = 4; i < key.length; i += 1) {
      const swapped = key.slice(0, i) + (key[i] === 'A' ? 'B' : 'A') + key.slice(i + 1);
      assert.equal(appKeyKind(swapped), null, `a change at position ${i} kept a valid checksum`);
    }
    // The other kind's prefix on this key's body is not that kind: the prefix is inside the sum.
    const other = (prefix === 'bpk_' ? 'bsk_' : 'bpk_') + key.slice(4);
    assert.equal(appKeyKind(other), null);
  }
  for (const text of [null, undefined, '', 'bpk_', 'not-a-key', 'test-operator-token-local-only-not-a-secret', `${mintAppKey('public')}x`]) {
    assert.equal(appKeyKind(text), null, `${json(text)} passed as a key`);
  }
  assert.throws(() => mintAppKey('read'), /no key kind/);
});

// ── The shapes ────────────────────────────────────────────────────────────────

test('C6.3: an origin is accepted only as a browser names it, exactly', () => {
  for (const ok of ['https://app.example.com', 'https://app.example.com:8443', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:8080', 'https://xn--bcher-kva.example']) {
    assert.deepEqual(validateOrigin(ok), { value: ok });
  }
  for (const no of [
    'null', '', '*', 'https://*.example.com', 'https://example.com/', 'https://example.com/path', 'https://Example.com',
    'https://example.com:443', 'http://example.com', 'ws://example.com', 'ftp://example.com', 'https://user@example.com',
    'example.com', 'file:///tmp/x', 42, null,
  ]) {
    assert.equal(validateOrigin(no).code, 'BAD_FIELD', `${json(no)} was accepted as an origin`);
  }
});

test('C6: a registration names an owner, a name and at most five origins, and never chooses its own id', () => {
  const good = { owner: 'owner-a', name: 'Settings app', origins: ['https://a.example'] };
  assert.deepEqual(validateRegistration(good).value, { owner: 'owner-a', ownerLabel: null, name: 'Settings app', origins: ['https://a.example'] });
  assert.deepEqual(validateRegistration({ owner: 'o', name: 'n' }).value.origins, [], 'a server-only app needs no origins');
  assert.equal(validateRegistration({ ...good, app_id: 'apaaaaaaaaaaaaaa' }).code, 'BAD_FIELD');
  assert.equal(validateRegistration({ ...good, id: FLEET }).code, 'BAD_FIELD');
  assert.equal(validateRegistration({ ...good, owner: '' }).code, 'MISSING_PARAM');
  assert.equal(validateRegistration({ ...good, name: 'x'.repeat(61) }).code, 'BAD_FIELD');
  assert.equal(validateRegistration({ ...good, name: 'two\nlines' }).code, 'BAD_FIELD');
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((h) => `https://${h}.example`);
  assert.equal(validateRegistration({ ...good, origins: six }).code, 'BAD_FIELD');
  assert.equal(validateRegistration({ ...good, origins: ['https://a.example', 'https://a.example'] }).code, 'BAD_FIELD');
  assert.equal(validateRegistration({ ...good, origins: 'https://a.example' }).code, 'BAD_FIELD');
  assert.equal(validateRegistration([]).code, 'BAD_FIELD');
});

test('C6.7: a tenant item with a contact field is refused, even an empty one, and the key decides the app', () => {
  const item = { v: 1, kind: 'wrong', body: 'The total on the receipt page is off by one.' };
  const app = 'apaaaaaaaaaaaaaa';
  assert.deepEqual(validateTenantItem(item, app).value, { site: app, url: '', target: null, kind: 'wrong', body: item.body });
  for (const contact of ['someone@example.com', '', null]) {
    const out = validateTenantItem({ ...item, contact }, TENANT);
    assert.equal(out.code, 'BAD_FIELD', `contact ${json(contact)} was not refused`);
    assert.match(out.message, /contact/);
  }
  assert.equal(validateTenantItem({ ...item, app_id: 'someone-else' }, app).value.site, app, 'a body app_id steered the item');
  assert.equal(validateTenantItem({ ...item, v: 2 }, app).code, 'BAD_VERSION');
  assert.equal(validateTenantItem({ ...item, kind: 'open' }, app).code, 'BAD_FIELD', 'a tenant filed an open item');
  assert.equal(validateTenantItem({ ...item, body: 'short' }, app).code, 'BAD_FIELD');
  assert.equal(validateTenantItem({ ...item, site: 'Not A Site' }, app).code, 'BAD_FIELD');
  assert.equal(validateTenantItem({ ...item, target: { kind: 'button', id: 'save', label: 'Save' } }, app).value.target.id, 'save');
  assert.equal(validateTenantItem({ ...item, target: 'save' }, app).code, 'BAD_FIELD');
  assert.equal(validateItemQuery(new URLSearchParams('kind=open')).code, 'BAD_FIELD');
  assert.equal(validateItemQuery(new URLSearchParams('status=accepted')).code, 'BAD_FIELD', 'a tenant list offered a status no tenant item can hold');
  assert.deepEqual(validateItemQuery(new URLSearchParams('status=fixed&limit=5')).value, { status: 'fixed', kind: null, limit: 5, before: null });
});

test('an app id is generated in one shape, which is never the fleet and always a valid site', () => {
  for (let i = 0; i < 50; i += 1) {
    const id = newAppId();
    assert.ok(isAppId(id), id);
    assert.match(id, /^[a-z0-9-]{1,40}$/);
  }
  for (const no of [FLEET, '', 'ap', 'APAAAAAAAAAAAAAA', 'apaaaaaaaaaaaaa1', 'apaaaaaaaaaaaaaaa', null]) assert.equal(isAppId(no), false, json(no));
});

// ── C6.4 and A12: the person table ────────────────────────────────────────────

test('C6.4: a person moves their item along their own table and nowhere else', () => {
  assert.deepEqual(PERSON_TRANSITIONS, {
    new: ['triaged', 'fixed', 'rejected', 'duplicate'],
    triaged: ['fixed', 'rejected', 'duplicate'],
    fixed: ['new'],
    rejected: ['new'],
  });
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const legal = (PERSON_TRANSITIONS[from] || []).includes(to);
      assert.equal(canTransition(from, to, 'person'), legal, `person ${from} -> ${to}`);
      assert.equal(canTransition(from, to, 'person', 'open'), false, `person moved an open item ${from} -> ${to}`);
    }
  }
  for (const reserved of ['accepted', 'spam']) {
    assert.ok(!Object.values(PERSON_TRANSITIONS).flat().includes(reserved), `${reserved} is reachable by a person`);
  }
  assert.deepEqual(TENANT_STATUSES, ['new', 'triaged', 'fixed', 'rejected', 'duplicate']);
});

// ── store-apps ────────────────────────────────────────────────────────────────

test('C6.2: registering returns each key once and stores only its hash and an eight-character prefix', async () => {
  const db = sqliteD1();
  const made = await register(db);
  assert.equal(made.code, undefined, json(made));
  assert.ok(isAppId(made.app.id));
  const { public: pub, secret } = made.keys;
  assert.equal(appKeyKind(pub.key), 'public');
  assert.equal(appKeyKind(secret.key), 'secret');
  const stored = json(db.sqlite.prepare('SELECT * FROM app_keys').all());
  for (const k of [pub, secret]) {
    assert.ok(!stored.includes(k.key), 'a key was stored in the clear');
    assert.ok(stored.includes(await sha256Hex(k.key)), 'a key hash is missing');
    assert.equal(k.prefix, k.key.slice(0, 8));
  }
  const found = await resolveKey(db, await sha256Hex(pub.key));
  assert.deepEqual(found.key, { id: pub.id, app_id: made.app.id, kind: 'public', last_used_date: null });
  const keys = await listKeys(db, scopeFor({ kind: 'app', app_id: made.app.id }));
  assert.equal(keys.keys.length, 2);
  assert.ok(!json(keys).includes(pub.key) && !json(keys).includes(secret.key), 'the key list showed a key');
});

test('Q5 and A14: the tenth switched-on app is the last, the refusal names its own remedy, and a refused app leaves no keys', async () => {
  const db = sqliteD1();
  for (let i = 0; i < APP_CAP; i += 1) assert.equal((await register(db)).code, undefined);
  const refused = await register(db);
  assert.equal(refused.code, 'RATE_LIMITED');
  assert.doesNotMatch(refused.hint, /wait/i, 'A14: waiting is not a remedy for the app cap');
  assert.match(refused.hint, /Turn off an app/);
  const count = (table) => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  assert.equal(count('apps'), APP_CAP);
  assert.equal(count('app_keys'), APP_CAP * 2, 'the refused registration left keys behind');
  assert.equal((await register(db, 'owner-b')).code, undefined, 'the cap is per owner');

  const [first] = (await listApps(db, 'owner-a')).apps;
  assert.deepEqual(await disableApp(db, scopeFor({ kind: 'app', app_id: first.id }), { now: T + 1 }), { disabled_at: T + 1 });
  assert.equal((await register(db)).code, undefined, 'turning an app off did not free its slot');
});

test('C6.8 and C6.2: a disabled app mints nothing, a revoked key resolves to nothing, and the fleet is never an app', async () => {
  const db = sqliteD1();
  const made = await register(db);
  const scope = scopeFor({ kind: 'app', app_id: made.app.id });
  const rotated = await mintKey(db, scope, { kind: 'public', now: T + 1 });
  assert.equal(appKeyKind(rotated.key.key), 'public', json(rotated));
  assert.deepEqual(await revokeKey(db, scope, { keyId: made.keys.public.id, now: T + 2 }), { revoked_at: T + 2 });
  assert.equal((await resolveKey(db, await sha256Hex(made.keys.public.key))).key, null, 'a revoked key still resolves');
  assert.ok((await resolveKey(db, await sha256Hex(rotated.key.key))).key, 'the rotated key does not resolve');
  assert.equal((await revokeKey(db, scope, { keyId: made.keys.public.id, now: T + 3 })).code, 'NOT_FOUND');
  assert.equal((await mintKey(db, scope, { kind: 'read', now: T })).code, 'BAD_FIELD');

  assert.deepEqual(await disableApp(db, scope, { now: T + 4 }), { disabled_at: T + 4 });
  assert.equal((await disableApp(db, scope, { now: T + 5 })).code, 'NOT_FOUND');
  assert.equal((await mintKey(db, scope, { kind: 'public', now: T + 6 })).code, 'NOT_FOUND', 'a key was minted for a disabled app');
  assert.equal((await getApp(db, made.app.id)).app.disabled_at, T + 4, 'disabling deleted the app');

  for (const call of [() => listKeys(db, FLEET_SCOPE), () => disableApp(db, FLEET_SCOPE, { now: T }), () => revokeKey(db, FLEET_SCOPE, { keyId: 'k', now: T })]) {
    const out = await call();
    assert.equal(out.code, 'STORE_ERROR', `the fleet scope reached the apps tables: ${json(out)}`);
  }
});

test('Q9: the daily count rises within a UTC day and starts again on the next', async () => {
  const db = sqliteD1();
  const day = Date.UTC(2026, 10, 3, 12);
  assert.equal((await countAppItem(db, TENANT, day)).count, 1);
  assert.equal((await countAppItem(db, TENANT, day + 60_000)).count, 2);
  assert.equal((await countAppItem(db, 'apbbbbbbbbbbbbbb', day)).count, 1, 'two apps share a counter');
  assert.equal((await countAppItem(db, TENANT, Date.UTC(2026, 10, 4, 0, 0, 1))).count, 1, 'the count did not start again on a new day');
});

test('C6.6: the tenant tally counts apps and their windowed items, and never a fleet row', async () => {
  const db = sqliteD1();
  const made = await register(db);
  await register(db, 'owner-b');
  plantReport(db, made.app.id, { id: 'recent', over: { created_at: T + 10, fingerprint: 'fp-1' } });
  plantReport(db, made.app.id, { id: 'old', over: { created_at: T - 10, fingerprint: 'fp-2' } });
  plantReport(db, FLEET, { id: 'fleet', over: { created_at: T + 10, fingerprint: 'fp-3' } });
  // An orphan tenant row, whose app has no apps row, is not a registered tenant's and is not counted.
  plantReport(db, TENANT, { id: 'orphan', over: { created_at: T + 10, fingerprint: 'fp-4' } });
  assert.deepEqual(await tenantTally(db, T), { apps: 2, items: 1 });

  const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS apps,
    COALESCE(SUM((SELECT COUNT(*) FROM reports r WHERE r.app_id = a.id AND r.created_at >= ?)), 0) AS items FROM apps a`).all().map((r) => r.detail);
  assert.ok(plan.includes('SEARCH r USING COVERING INDEX reports_app_created (app_id=? AND created_at>?)'), json(plan));
  assert.ok(!plan.some((d) => /SCAN r\b|SCAN reports/.test(d)), `the tally walks reports: ${json(plan)}`);
  assert.match(source('store-apps.js'), /SUM\(\(SELECT COUNT\(\*\) FROM reports r WHERE r\.app_id = a\.id AND r\.created_at >= \?\)\)/, 'the pinned statement is not the one the store runs');
});

// ── store-tenant ──────────────────────────────────────────────────────────────

test("7.1: another tenant's item answers exactly as an item that never existed, on the list and on the single read", async () => {
  const db = sqliteD1();
  const a = 'apaaaaaaaaaaaaaa';
  const b = 'apbbbbbbbbbbbbbb';
  plantReport(db, a, { id: 'item-a', over: { fingerprint: 'fp-a', body: 'A body of app a.' } });
  plantReport(db, b, { id: 'item-b', over: { fingerprint: 'fp-b', body: 'A body of app b.' } });
  plantReport(db, FLEET, { id: 'item-fleet', over: { fingerprint: 'fp-f' } });
  const scopeA = scopeFor({ kind: 'person', person_id: 'owner-a' }, { id: a, owner: 'owner-a' });
  const scopeB = scopeFor({ kind: 'app', app_id: b });

  assert.equal((await getItem(db, scopeA, 'item-a')).item.body, 'A body of app a.');
  assert.deepEqual(await getItem(db, scopeB, 'item-a'), await getItem(db, scopeB, 'never-existed'));
  assert.deepEqual(await getItem(db, scopeB, 'item-fleet'), { item: null });
  const page = await listItems(db, scopeA, { status: null, before: null, limit: 50 });
  assert.deepEqual(page.items.map((i) => i.id), ['item-a']);
  assert.ok(!json(page).includes('app b') && !json(page).includes('CANARY. Published'), json(page));
  assert.deepEqual((await listItems(db, scopeA, { status: 'fixed', before: null, limit: 50 })).items, []);
  // What a tenant reads leaves out every public, work and AI column.
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['body', 'created_at', 'decided_at', 'id', 'key_id', 'kind', 'site', 'status', 'target', 'url']);

  assert.equal((await listItems(db, FLEET_SCOPE, { status: null, before: null, limit: 5 })).code, 'STORE_ERROR', 'a tenant list reached the fleet');
  assert.equal((await getItem(db, FLEET_SCOPE, 'item-fleet')).code, 'STORE_ERROR', 'a tenant read reached the fleet');
});

test('C6.4 and C6.5: no tenant statement names a public, published or work column, and both reads seek an app-first index', () => {
  const code = codeOf('store-tenant.js');
  const sql = code.match(/`[^`]*\b(?:SELECT|UPDATE|INSERT|DELETE)\b[^`]*`|'[^'\n]*\b(?:SELECT|UPDATE)\b[^'\n]*'/g) || [];
  assert.ok(sql.length >= 2, `the extractor found ${sql.length} statements, so this proves nothing`);
  const columns = code.match(/TENANT_COLUMNS = `([^`]*)`/)[1];
  for (const text of [...sql, columns]) {
    assert.doesNotMatch(text, /\bpublic\b|public_note|fixed_ref|\bwork_|\bai_|contact/, `a tenant statement names a column a tenant may not touch: ${text}`);
  }
  assert.match(code, /WHERE app_id = \? AND \$\{statusTerm\}created_at < \?/);
  assert.match(code, /WHERE id = \? AND app_id = \?/);

  const db = sqliteD1();
  const plan = (sql) => db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  const list = 'SELECT id FROM reports WHERE app_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?';
  const byStatus = 'SELECT id FROM reports WHERE app_id = ? AND status = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?';
  assert.equal(plan(list), 'SEARCH reports USING INDEX reports_app_created (app_id=? AND created_at<?)');
  assert.equal(plan(byStatus), 'SEARCH reports USING INDEX reports_app_status_created (app_id=? AND status=? AND created_at<?)');
});

test('C6.4: every legal person move lands and every illegal one is BAD_TRANSITION, from every status', async () => {
  const app = 'apaaaaaaaaaaaaaa';
  const scope = scopeFor({ kind: 'person', person_id: 'owner-a' }, { id: app, owner: 'owner-a' });
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const db = sqliteD1();
      plantReport(db, app, { id: 'item', over: { status: from, kind: 'wrong', fixed_at: null, decided_at: null } });
      const out = await moveItem(db, scope, { id: 'item', to, now: T + 9 });
      const row = db.sqlite.prepare('SELECT status, decided_at, fixed_at, public FROM reports WHERE id = ?').get('item');
      if ((PERSON_TRANSITIONS[from] || []).includes(to)) {
        assert.equal(out.item && out.item.status, to, `${from} -> ${to} was refused: ${json(out)}`);
        assert.equal(row.decided_at, ['fixed', 'rejected', 'duplicate'].includes(to) ? T + 9 : null, `${from} -> ${to} decided_at`);
      } else {
        assert.equal(out.code, 'BAD_TRANSITION', `${from} -> ${to} was allowed`);
        assert.equal(row.status, from, `a refused ${from} -> ${to} wrote the row`);
      }
      assert.equal(row.fixed_at, null, 'a person move wrote fixed_at, which the public log reads');
    }
  }
});

test('C6.4: a move on another tenant\'s item is NO_ITEM, an open row is refused, and a move that raced another loses', async () => {
  const db = sqliteD1();
  const a = 'apaaaaaaaaaaaaaa';
  plantReport(db, a, { id: 'item-a', over: { kind: 'wrong', status: 'new', fingerprint: 'fp-a' } });
  plantReport(db, a, { id: 'open-a', over: { kind: 'open', status: 'new', fingerprint: 'fp-o' } });
  plantReport(db, FLEET, { id: 'item-f', over: { kind: 'wrong', status: 'new', fingerprint: 'fp-f' } });
  const scopeA = scopeFor({ kind: 'app', app_id: a });
  const scopeB = scopeFor({ kind: 'app', app_id: 'apbbbbbbbbbbbbbb' });
  assert.deepEqual(await moveItem(db, scopeB, { id: 'item-a', to: 'fixed', now: T }), NO_ITEM);
  assert.deepEqual(await moveItem(db, scopeB, { id: 'never', to: 'fixed', now: T }), NO_ITEM);
  assert.equal((await moveItem(db, FLEET_SCOPE, { id: 'item-f', to: 'fixed', now: T })).code, 'STORE_ERROR', 'a tenant move reached the fleet');
  assert.equal((await moveItem(db, scopeA, { id: 'open-a', to: 'fixed', now: T })).code, 'BAD_TRANSITION', 'a person moved an open row');

  db.beforeStatement(/^UPDATE reports SET status = \?, decided_at/, async () => {
    db.sqlite.prepare("UPDATE reports SET status = 'rejected' WHERE id = 'item-a'").run();
  });
  const raced = await moveItem(db, scopeA, { id: 'item-a', to: 'fixed', now: T });
  assert.equal(raced.code, 'BAD_TRANSITION');
  assert.match(raced.message, /in flight/);
  assert.equal(db.sqlite.prepare('SELECT status FROM reports WHERE id = ?').get('item-a').status, 'rejected');

  // The write's own tenant term, seen apart from the read's (the A30 technique): the row changes
  // tenant between the two statements, and the write must then match nothing.
  plantReport(db, a, { id: 'item-moving', over: { kind: 'wrong', status: 'new', fingerprint: 'fp-m' } });
  db.beforeStatement(/^UPDATE reports SET status = \?, decided_at/, async () => {
    db.sqlite.prepare("UPDATE reports SET app_id = 'apbbbbbbbbbbbbbb' WHERE id = 'item-moving'").run();
  });
  assert.equal((await moveItem(db, scopeA, { id: 'item-moving', to: 'fixed', now: T })).code, 'BAD_TRANSITION');
  assert.equal(db.sqlite.prepare('SELECT status FROM reports WHERE id = ?').get('item-moving').status, 'new', "the write landed on another tenant's row");

  assert.deepEqual(validateItemMove({ status: 'fixed' }).value, { status: 'fixed' });
  assert.equal(validateItemMove({ status: 'spam' }).value.status, 'spam', 'the table, not the validator, refuses spam');
  for (const body of [{ status: 'fixed', public: false }, { status: 'fixed', work_state: 'approved' }, { status: 'nope' }, {}, [], null]) {
    assert.ok(validateItemMove(body).code, `${json(body)} passed`);
  }
});

// ── identify(), the seam ──────────────────────────────────────────────────────

test('C6.1 and A10: an app key is looked up, never locked out, and every refusal is one sentence', async () => {
  const db = sqliteD1();
  const made = await register(db);
  const other = await register(db, 'owner-b');
  const app = made.app.id;
  const as = (key, appId = app) => identify(bearer(key), {}, db, { now: T, ip: '203.0.113.9', accept: ['app'], app: appId });

  const good = await as(made.keys.public.key);
  assert.deepEqual(good.principal, { kind: 'app', app_id: app, key_kind: 'public', key_id: made.keys.public.id, last_used_date: null });
  assert.equal((await as(made.keys.secret.key)).principal.key_kind, 'secret');

  await revokeKey(db, scopeFor({ kind: 'app', app_id: app }), { keyId: made.keys.secret.id, now: T });
  const swapped = made.keys.public.key.slice(0, -1) + (made.keys.public.key.endsWith('A') ? 'B' : 'A');
  for (const [name, out] of [
    ['a revoked key', await as(made.keys.secret.key)],
    ["another app's key", await as(other.keys.public.key)],
    ['a key on another app\'s path', await as(made.keys.public.key, other.app.id)],
    ['a bad checksum', await as(swapped)],
    ['an unknown well formed key', await as(mintAppKey('public'))],
    ['no key at all', await identify(new Request('https://x.test/'), {}, db, { now: T, ip: '', accept: ['app'], app })],
  ]) {
    assert.deepEqual(out, { error: KEY_REFUSED }, `${name} was not refused with the one sentence`);
  }
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_attempts').get().n, 0, 'the app-key path touched the C3 lockout');
});

test('C6.1: a route takes one family of credential, and a person is NOT_CONFIGURED until phase 3', async () => {
  const db = sqliteD1();
  for (const accept of [['operator', 'app'], ['app', 'person'], ['automation', 'person'], ['root'], []]) {
    await assert.rejects(identify(bearer('x'), {}, db, { now: T, ip: '', accept }), /one family of credential/, json(accept));
  }
  const person = await identify(bearer('eyJhbGciOiJSUzI1NiJ9.e30.sig'), {}, db, { now: T, ip: '', accept: ['person'] });
  assert.equal(person.error.code, 'NOT_CONFIGURED');
  // With no operator token bound the shared-secret path answers exactly as the desk always has.
  const shared = await identify(bearer('anything'), {}, db, { now: T, ip: '', accept: ['operator'] });
  assert.equal(shared.error.code, 'NOT_CONFIGURED');
  assert.match(shared.error.message, /operator token/);
});
