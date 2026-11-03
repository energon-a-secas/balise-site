// The `apps` and `app_keys` tables (0004), the per-app daily counter in `submit_counters`, and
// /health's two tenant numbers. Authorization never happens here: a route asks scopeFor() and
// passes the scope in. `owner_label` is display only. A key is stored and found by its SHA-256.

import { storeError } from './store.js';
import { sha256Hex, mintAppKey } from './keys.js';
import { FLEET, tenantKey } from './scope.js';

/** Q5: switched-on apps per owner. Refused with RATE_LIMITED and A14's own sentence. */
export const APP_CAP = 10;
/** Q9: items per app per UTC day, counted in D1 so the number is one a test can prove. */
export const DAILY_ITEM_CAP = 1000;
export const KEY_KINDS = ['public', 'secret'];
const PREFIX_SHOWN = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const refuse = (code, message, hint) => ({ code, message, hint });

const CAP_REACHED = refuse(
  'RATE_LIMITED',
  `That owner already has ${APP_CAP} apps switched on, which is the limit for one owner.`,
  'Turn off an app that is no longer used, or ask the Balise operator to raise the limit.',
);
const NO_APP = refuse('NOT_FOUND', 'There is no switched-on app with that id.', 'Check the app id. A turned-off app cannot be changed.');
const NO_KEY = refuse('NOT_FOUND', 'That app has no live key with that id.', 'List the app\'s keys and pick one that is not revoked.');

/** 16 characters, 70 random bits, never 'fleet' and always a valid `site` value. */
export function newAppId() {
  return `ap${[...crypto.getRandomValues(new Uint8Array(14))].map((b) => ID_ALPHABET[b & 31]).join('')}`;
}

/** The UTC day a timestamp falls in, as the YYYY-MM-DD `app_keys.last_used_date` stores. */
export const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

const appOf = (row) => row && {
  id: row.id,
  owner: row.owner,
  name: row.name,
  origins: JSON.parse(row.origins || '[]'),
  created_at: row.created_at,
  disabled_at: row.disabled_at || null,
};

/** The scope's app id, refusing the fleet's: no apps row is the fleet's, and none may be addressed as one. */
function appIdOf(scope) {
  const appId = tenantKey(scope);
  if (appId === FLEET) throw new Error('store-apps: the fleet is not an app');
  return appId;
}

// The app must exist and be switched on, inside the same statement, so a key cannot be minted
// for an app that a concurrent disable has just turned off.
const INSERT_KEY = `INSERT INTO app_keys (id, app_id, kind, key_hash, prefix, created_at)
  SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM apps WHERE id = ? AND disabled_at IS NULL)`;

async function newKey(kind, now) {
  const key = mintAppKey(kind);
  return { key, id: crypto.randomUUID(), kind, hash: await sha256Hex(key), prefix: key.slice(0, PREFIX_SHOWN), created_at: now };
}

const insertKey = (db, appId, k) => db.prepare(INSERT_KEY).bind(k.id, appId, k.kind, k.hash, k.prefix, k.created_at, appId);
const shown = (k) => ({ id: k.id, kind: k.kind, prefix: k.prefix, key: k.key, created_at: k.created_at });

/**
 * A new app with one key of each kind, in one batch. The cap is counted INSIDE the app's INSERT,
 * so two registrations racing for the last slot cannot both land, and each key INSERT requires
 * the app to exist, so a refused app leaves no orphan keys. The keys are returned once.
 */
export async function registerApp(db, { owner, ownerLabel, name, origins, now }) {
  const id = newAppId();
  const keys = await Promise.all(KEY_KINDS.map((kind) => newKey(kind, now)));
  try {
    const [made] = await db.batch([
      db
        .prepare(
          `INSERT INTO apps (id, owner, owner_label, name, origins, created_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM apps WHERE owner = ? AND disabled_at IS NULL) < ?`,
        )
        .bind(id, owner, ownerLabel, name, JSON.stringify(origins), now, owner, APP_CAP),
      ...keys.map((k) => insertKey(db, id, k)),
    ]);
    if (!made.meta || made.meta.changes === 0) return CAP_REACHED;
  } catch (err) {
    return storeError('register app', err);
  }
  return {
    app: { id, name, origins, created_at: now, disabled_at: null },
    keys: Object.fromEntries(keys.map((k) => [k.kind, shown(k)])),
  };
}

/** One app by id, switched on or not. A disabled app's items stay readable by their owner. */
export async function getApp(db, appId) {
  try {
    const row = await db.prepare('SELECT id, owner, name, origins, created_at, disabled_at FROM apps WHERE id = ?').bind(appId).first();
    return { app: row ? appOf(row) : null };
  } catch (err) {
    return storeError('app read', err);
  }
}

/** An owner's apps, newest first, on apps_owner. */
export async function listApps(db, owner, { limit = APP_CAP } = {}) {
  try {
    const res = await db
      .prepare('SELECT id, owner, name, origins, created_at, disabled_at FROM apps WHERE owner = ? ORDER BY created_at DESC LIMIT ?')
      .bind(owner, limit)
      .run();
    return { apps: (res.results || []).map(appOf) };
  } catch (err) {
    return storeError('app list', err);
  }
}

/** One app's keys, newest first, on app_keys_app. Never the key text, which is not stored. */
export async function listKeys(db, scope) {
  try {
    const res = await db
      .prepare('SELECT id, kind, prefix, created_at, last_used_date, revoked_at FROM app_keys WHERE app_id = ? ORDER BY created_at DESC LIMIT 20')
      .bind(appIdOf(scope))
      .run();
    return { keys: res.results || [] };
  } catch (err) {
    return storeError('key list', err);
  }
}

/** A presented key, by its hash, on the UNIQUE app_keys_hash. One row or none. */
export async function resolveKey(db, keyHash) {
  try {
    const row = await db
      .prepare('SELECT id, app_id, kind, last_used_date FROM app_keys WHERE key_hash = ? AND revoked_at IS NULL')
      .bind(keyHash)
      .first();
    return { key: row || null };
  } catch (err) {
    return storeError('key read', err);
  }
}

/** C6.2's readback: written only when the day changed, so one write per key per day. A failure is
 *  logged and swallowed, because forensics must not refuse an item that was already stored. */
export async function touchKey(db, keyId, day) {
  try {
    await db
      .prepare('UPDATE app_keys SET last_used_date = ? WHERE id = ? AND (last_used_date IS NULL OR last_used_date <> ?)')
      .bind(day, keyId, day)
      .run();
  } catch (err) {
    console.error('d1 key touch failed:', err);
  }
}

/** Rotation is a second live key of the same kind, then a revoke of the old one (C6.2). */
export async function mintKey(db, scope, { kind, now }) {
  if (!KEY_KINDS.includes(kind)) return refuse('BAD_FIELD', `"${kind}" is not a key kind.`, `The kinds are ${KEY_KINDS.join(' and ')}.`);
  const appId = appIdOf(scope);
  const k = await newKey(kind, now);
  try {
    const res = await insertKey(db, appId, k).run();
    if (!res.meta || res.meta.changes === 0) return NO_APP;
  } catch (err) {
    return storeError('key mint', err);
  }
  return { key: shown(k) };
}

/** A timestamp, never a delete, so a revoked key still posting is recognised rather than unknown. */
export async function revokeKey(db, scope, { keyId, now }) {
  try {
    const res = await db
      .prepare('UPDATE app_keys SET revoked_at = ? WHERE id = ? AND app_id = ? AND revoked_at IS NULL')
      .bind(now, keyId, appIdOf(scope))
      .run();
    return res.meta && res.meta.changes > 0 ? { revoked_at: now } : NO_KEY;
  } catch (err) {
    return storeError('key revoke', err);
  }
}

/** C6.8: disable only. Ingest stops at once; the items stay, and the 90-day purge is phase 4's. */
export async function disableApp(db, scope, { now }) {
  try {
    const res = await db.prepare('UPDATE apps SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL').bind(now, appIdOf(scope)).run();
    return res.meta && res.meta.changes > 0 ? { disabled_at: now } : NO_APP;
  } catch (err) {
    return storeError('app disable', err);
  }
}

/**
 * Count one item against the app's UTC day and return the new count, in one statement. A new
 * day starts the count again at one. Refused items are counted too: the cap bounds what an app
 * can make this service do, not only what it stores.
 */
export async function countAppItem(db, appId, now) {
  try {
    const count = await db
      .prepare(
        `INSERT INTO submit_counters (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           count        = CASE WHEN submit_counters.window_start = excluded.window_start THEN submit_counters.count + 1 ELSE 1 END,
           window_start = excluded.window_start
         RETURNING count`,
      )
      .bind(`app-day:${appId}`, Math.floor(now / DAY_MS) * DAY_MS)
      .first('count');
    return { count };
  } catch (err) {
    return storeError('app counter', err);
  }
}

/**
 * C6.6: /health counts tenants and lists none. `items` is tenant items inside the health window,
 * counted app by app with a seek on reports_app_created, so it reads no fleet row. A JOIN planned
 * the other way round, walking every report in the window; the plan is pinned in tests/apps.test.mjs.
 */
export async function tenantTally(db, since) {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS apps,
                COALESCE(SUM((SELECT COUNT(*) FROM reports r WHERE r.app_id = a.id AND r.created_at >= ?)), 0) AS items
           FROM apps a`,
      )
      .bind(since)
      .first();
    return { apps: row ? row.apps : 0, items: row ? row.items : 0 };
  } catch (err) {
    return storeError('tenant tally', err);
  }
}
