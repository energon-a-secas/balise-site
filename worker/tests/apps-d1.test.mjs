// Phase 2 under workerd, against a real local D1: POST /apps with the operator token (the one
// route node cannot run, having no crypto.subtle.timingSafeEqual), and the #83 flow end to end,
// so the duplicate guard is D1's own UNIQUE index, the daily counter is D1's own RETURNING and the
// rate limit is the real binding in local mode. The same rules in finer detail, in process, are
// tests/apps-routes.test.mjs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { WORKER_DIR, TOKEN, AI_TOKEN, SALT, TURNSTILE_PASS, migrate, startWorker, stopWorker, requester } from './harness.mjs';

const STATE = join(WORKER_DIR, '.wrangler/apps-state');
const PORT = 8904;
const call = requester(`http://127.0.0.1:${PORT}`);
const A_ORIGIN = 'https://a.example';
const B_ORIGIN = 'https://b.example';

let worker = null;
const apps = {};

before(async () => {
  rmSync(STATE, { recursive: true, force: true });
  await migrate(STATE);
  worker = await startWorker(PORT, {
    BALISE_OPERATOR_TOKEN: TOKEN, BALISE_AUTOMATION_TOKEN: AI_TOKEN, BALISE_IP_SALT: SALT, BALISE_TURNSTILE_SECRET: TURNSTILE_PASS,
  }, STATE);
});

after(async () => {
  await stopWorker(worker);
  rmSync(STATE, { recursive: true, force: true });
});

const item = (n, over = {}) => ({ v: 1, kind: 'broken', body: `Item ${n}: the export button does nothing.`, ...over });

test('POST /apps takes the operator token alone, and answers with the endpoint and both keys once', async () => {
  for (const [name, owner, origin] of [['App A', 'owner-a', A_ORIGIN], ['App B', 'owner-b', B_ORIGIN]]) {
    const { res, body } = await call('/apps', { method: 'POST', token: TOKEN, ip: '192.0.2.41', body: { owner, name, origins: [origin] } });
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.provider, 'apps');
    assert.equal(body.app.endpoint, `http://127.0.0.1:${PORT}/apps/${body.app.id}/items`);
    assert.match(body.keys.public.key, /^bpk_/);
    assert.match(body.keys.secret.key, /^bsk_/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    apps[owner] = body;
  }
  const automation = await call('/apps', { method: 'POST', token: AI_TOKEN, ip: '192.0.2.42', body: { owner: 'x', name: 'x' } });
  assert.equal(automation.body.code, 'UNAUTHORIZED');
  assert.match(automation.body.hint, /operator token/);
  for (const token of [undefined, 'wrong', apps['owner-a'].keys.public.key]) {
    const refused = await call('/apps', { method: 'POST', token, ip: '192.0.2.43', body: { owner: 'x', name: 'x' } });
    assert.equal(refused.body.code, 'UNAUTHORIZED', `${token} registered an app`);
  }
  const chosen = await call('/apps', { method: 'POST', token: TOKEN, ip: '192.0.2.41', body: { owner: 'x', name: 'x', app_id: 'apaaaaaaaaaaaaaa' } });
  assert.equal(chosen.body.code, 'BAD_FIELD');
});

test('#83 on a real D1: each app posts with its own key from its own origin, and D1\'s own guard dedupes inside one app only', async () => {
  const a = apps['owner-a'];
  const b = apps['owner-b'];
  const same = item(1, { site: 'export', target: { kind: 'button', id: 'export', label: 'Export' } });
  for (const [app, origin] of [[a, A_ORIGIN], [b, B_ORIGIN]]) {
    const browser = await call(`/apps/${app.app.id}/items`, { method: 'POST', token: app.keys.public.key, origin, ip: '198.51.100.70', body: same });
    assert.equal(browser.res.status, 200, JSON.stringify(browser.body));
    assert.equal(browser.res.headers.get('access-control-allow-origin'), origin);
    const server = await call(`/apps/${app.app.id}/items`, { method: 'POST', token: app.keys.secret.key, body: item(2) });
    assert.equal(server.res.status, 200, JSON.stringify(server.body));
  }
  const again = await call(`/apps/${a.app.id}/items`, { method: 'POST', token: a.keys.public.key, origin: A_ORIGIN, ip: '198.51.100.70', body: same });
  assert.equal(again.body.code, 'DUPLICATE');
  assert.equal((await call(`/apps/${a.app.id}/items`, { method: 'POST', token: a.keys.secret.key, origin: A_ORIGIN, body: item(3) })).body.code, 'FORBIDDEN_ORIGIN');
  assert.equal((await call(`/apps/${b.app.id}/items`, { method: 'POST', token: a.keys.secret.key, body: item(3) })).body.code, 'UNAUTHORIZED');
  const elsewhere = await call(`/apps/${a.app.id}/items`, { method: 'POST', token: a.keys.public.key, origin: B_ORIGIN, body: item(3) });
  assert.equal(elsewhere.body.code, 'NOT_FOUND');
  assert.equal(elsewhere.res.headers.get('access-control-allow-origin'), null);

  const preflight = await fetch(`http://127.0.0.1:${PORT}/apps/${a.app.id}/items`, { method: 'OPTIONS', headers: { Origin: A_ORIGIN } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-max-age'), '600');
});

test('C6.5 and C6.6 on a real D1: no public route and not the operator desk carries anything of either app', async () => {
  const marks = [apps['owner-a'].app.id, apps['owner-b'].app.id, 'App A', 'export button', 'owner-a'];
  for (const [path, token] of [['/log?limit=50'], ['/board?limit=50'], ['/board/summary'], ['/health'], ['/reports?limit=50', TOKEN], ['/reports?kind=broken&limit=50', TOKEN]]) {
    const { res, body } = await call(path, { token, ip: '192.0.2.44' });
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(body)}`);
    const text = JSON.stringify(body);
    for (const mark of marks) assert.ok(!text.includes(mark), `${path} carried ${mark}`);
  }
  const { body } = await call('/health');
  assert.equal(body.apps, 2);
  assert.equal(body.tenant_items, 4);
  assert.equal(body.config.app_rate_limiter, true);
});
