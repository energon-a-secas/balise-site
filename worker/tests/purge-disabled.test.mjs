// C6.8's 90-day purge (tools/purge-disabled.mjs): over node:sqlite for the boundary, the paging and
// the plan, through the CLI the Makefile runs, and once against a real local D1 under wrangler, where
// DELETE ... RETURNING and the --json answer are D1's own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sqliteD1 } from './sqlite-d1.mjs';
import { plantReport } from './tenant-fixture.mjs';
import { WORKER_DIR, migrate, run } from './harness.mjs';
import { purgeStatement, purgedCount, PAGE, PURGE_DAYS, MORE } from '../../tools/purge-disabled.mjs';

const SCRIPT = fileURLToPath(new URL('../../tools/purge-disabled.mjs', import.meta.url));
const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 86_400_000;
const PAST = 'appastpastpastpas';
const INSIDE = 'apinsideinsideins';
const LIVE = 'apliveliveliveliv';

function plantApp(db, id, disabledAt) {
  db.sqlite.prepare('INSERT INTO apps (id, owner, name, origins, created_at, disabled_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `owner-${id}`, id, '[]', NOW - 400 * DAY, disabledAt);
  db.sqlite.prepare("INSERT INTO app_keys (id, app_id, kind, key_hash, prefix, created_at) VALUES (?, ?, 'public', ?, 'bpk_xxxx', ?)")
    .run(`key-${id}`, id, `hash-${id}`, NOW - 400 * DAY);
}
const plantItems = (db, appId, n) => {
  for (let i = 0; i < n; i += 1) plantReport(db, appId, { id: `${appId}-${i}`, over: { fingerprint: `fp-${appId}-${i}`, created_at: NOW - i } });
};
const count = (db, sql, ...args) => db.sqlite.prepare(sql).get(...args).n;

test('C6.8: the purge takes a disabled app\'s items from day 90 on, a page at a time, and nothing else', async () => {
  const db = sqliteD1();
  plantApp(db, PAST, NOW - (PURGE_DAYS + 1) * DAY);
  plantApp(db, INSIDE, NOW - (PURGE_DAYS - 1) * DAY);
  plantApp(db, LIVE, null);
  plantItems(db, PAST, 450);
  plantItems(db, INSIDE, 3);
  plantItems(db, LIVE, 3);
  plantItems(db, 'fleet', 2);

  const pages = [];
  for (let i = 0; i < 6; i += 1) pages.push(db.sqlite.prepare(purgeStatement(NOW)).all().length);
  assert.deepEqual(pages, [PAGE, PAGE, 50, 0, 0, 0], 'the purge did not page, or did not stop');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM reports WHERE app_id = ?', PAST), 0);
  for (const [appId, n] of [[INSIDE, 3], [LIVE, 3], ['fleet', 2]]) {
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM reports WHERE app_id = ?', appId), n, `the purge touched ${appId}`);
  }
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM apps'), 3, 'the purge deleted an app');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM app_keys'), 3, 'the purge deleted a key');

  // The boundary is inclusive: exactly 90 days is purged, a millisecond short of it is kept.
  const edge = sqliteD1();
  plantApp(edge, PAST, NOW - PURGE_DAYS * DAY);
  plantApp(edge, INSIDE, NOW - PURGE_DAYS * DAY + 1);
  plantItems(edge, PAST, 1);
  plantItems(edge, INSIDE, 1);
  assert.deepEqual(edge.sqlite.prepare(purgeStatement(NOW)).all().map((r) => r.app_id), [PAST]);
});

test('C6.8: the purge walks apps first and seeks each app\'s rows, never every report', () => {
  const db = sqliteD1();
  const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${purgeStatement(NOW)}`).all().map((r) => r.detail);
  assert.ok(plan.includes('SCAN a'), JSON.stringify(plan));
  assert.ok(plan.some((d) => /^SEARCH r USING (COVERING )?INDEX reports_app_\w+ \(app_id=\?\)$/.test(d)), JSON.stringify(plan));
  assert.ok(!plan.some((d) => /^SCAN r\b|^SCAN reports/.test(d)), `the purge walks reports: ${JSON.stringify(plan)}`);
  assert.throws(() => purgeStatement(Number.NaN), /must be integers/);
  assert.throws(() => purgeStatement(NOW, 0), /must be integers/);
});

test('the CLI the Makefile runs: --query prints one page, and the exit code says whether to run another', () => {
  const query = execFileSync('node', [SCRIPT, '--query', `--now=${NOW}`], { encoding: 'utf8' });
  assert.equal(query.trim(), purgeStatement(NOW));
  const answer = (n) => JSON.stringify([{ results: Array.from({ length: n }, () => ({ app_id: PAST })), success: true, meta: {} }]);
  const runOn = (input) => {
    try {
      return { code: 0, out: execFileSync('node', [SCRIPT], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  assert.deepEqual(runOn(answer(PAGE)), { code: MORE, out: `purged ${PAGE} items of apps disabled over ${PURGE_DAYS} days ago, and there may be more\n` });
  assert.deepEqual(runOn(answer(7)), { code: 0, out: `purged 7 items of apps disabled over ${PURGE_DAYS} days ago\n` });
  assert.equal(runOn(answer(0)).code, 0);
  assert.match(runOn(answer(0)).out, /no item/);
  for (const bad of ['not json', '[{"success":false}]', '{}']) assert.equal(runOn(bad).code, 1, `${bad} was read as an answer`);
  assert.equal(purgedCount(JSON.stringify([{ results: [{}, {}], success: true }, { results: [{}], success: true }])), 3);
});

test('C6.8 on a real local D1: DELETE ... RETURNING pages, counts and stops, and a second run purges nothing', async () => {
  const state = join(WORKER_DIR, '.wrangler/purge-state');
  rmSync(state, { recursive: true, force: true });
  try {
    await migrate(state);
    const now = Date.now();
    const exec = async (sql) => JSON.parse(await run(['d1', 'execute', 'balise', '--local', '--persist-to', state, '--json', '--command', sql]));
    await exec(`INSERT INTO apps (id, owner, name, origins, created_at, disabled_at) VALUES
      ('${PAST}', 'o1', 'past', '[]', ${now - 400 * DAY}, ${now - 100 * DAY}),
      ('${INSIDE}', 'o2', 'inside', '[]', ${now - 400 * DAY}, ${now - 10 * DAY});
      INSERT INTO reports (id, created_at, site, url, kind, body, fingerprint, app_id) VALUES
      ('p1', ${now}, 's', '', 'wrong', 'one body text', 'fp1', '${PAST}'),
      ('p2', ${now}, 's', '', 'wrong', 'two body text', 'fp2', '${PAST}'),
      ('i1', ${now}, 's', '', 'wrong', 'three body text', 'fp3', '${INSIDE}'),
      ('f1', ${now}, 's', '', 'wrong', 'four body text', 'fp4', 'fleet')`);
    const first = await run(['d1', 'execute', 'balise', '--local', '--persist-to', state, '--json', '--command', purgeStatement(now)]);
    assert.equal(purgedCount(first), 2);
    const second = await run(['d1', 'execute', 'balise', '--local', '--persist-to', state, '--json', '--command', purgeStatement(now)]);
    assert.equal(purgedCount(second), 0, 'a second run purged something');
    const left = await exec('SELECT id FROM reports ORDER BY id');
    assert.deepEqual(left[0].results.map((r) => r.id), ['f1', 'i1']);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
