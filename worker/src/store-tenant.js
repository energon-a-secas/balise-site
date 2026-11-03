// A tenant's own reads of `reports`. One of the Worker's files that contain SQL.
//
// Every statement binds `app_id = ?` from a scope, and the scope comes from scopeFor() with the
// app the path named (DESIGN.md section 5.5), never from a request field. The fleet's scope is
// refused outright: nothing here may read the operator's desk.
//
// NO STATEMENT HERE NAMES public, public_note, fixed_ref OR ANY work_ COLUMN (C6.4, C6.5), in
// what it reads or in what it writes. tests/apps.test.mjs reads this file's SQL to hold that.
// A tenant item is written by insertReport() in src/store.js, the same INSERT /report uses,
// with the app's scope bound.

import { storeError } from './store.js';
import { FLEET, tenantKey } from './scope.js';
import { PERSON_TRANSITIONS, canTransition } from './transitions.js';
import { TENANT_STATUSES } from './validate-apps.js';

/** Another tenant's id and no id answer with this one object (C6.4). */
export const NO_ITEM = {
  code: 'NOT_FOUND',
  message: 'Nothing at this address belongs to an app you own.',
  hint: 'Open your apps at balise.neorgon.com/apps and pick the item from there.',
};
const DECIDED = ['fixed', 'rejected', 'duplicate'];

const TENANT_COLUMNS = `id, created_at, site, url, target_kind, target_id, target_label,
                        kind, body, status, decided_at, app_key_id`;

function appIdOf(scope) {
  const appId = tenantKey(scope);
  if (appId === FLEET) throw new Error('store-tenant: the fleet is not a tenant');
  return appId;
}

const toItem = (row) => ({
  id: row.id,
  created_at: row.created_at,
  site: row.site,
  url: row.url,
  target: row.target_kind ? { kind: row.target_kind, id: row.target_id, label: row.target_label || '' } : null,
  kind: row.kind,
  body: row.body,
  status: TENANT_STATUSES.includes(row.status) ? row.status : 'new',
  decided_at: row.decided_at || null,
  key_id: row.app_key_id || null,
});

/**
 * One app's items, newest first, keyset paged. On reports_app_created with no status and
 * reports_app_status_created with one, both leading on app_id; the two plans are pinned in
 * tests/apps.test.mjs.
 */
export async function listItems(db, scope, { status, before, limit }) {
  const cursor = before === null || before === undefined ? Number.MAX_SAFE_INTEGER : before;
  const statusTerm = status ? 'status = ? AND ' : '';
  const sql = `SELECT ${TENANT_COLUMNS} FROM reports
        WHERE app_id = ? AND ${statusTerm}created_at < ?
        ORDER BY created_at DESC LIMIT ?`;
  try {
    const res = await db.prepare(sql).bind(appIdOf(scope), ...(status ? [status] : []), cursor, limit).run();
    const rows = res.results || [];
    return {
      items: rows.map(toItem),
      rowsRead: res.meta ? res.meta.rows_read : null,
      next: rows.length === limit ? rows[rows.length - 1].created_at : null,
    };
  } catch (err) {
    return storeError('tenant list', err);
  }
}

/** C6.4: one owner's status move, read then guarded write as in applyTransition(). Both statements
 *  bind the tenant and the write repeats the status read; `fixed_at`, the log's, is never written. */
export async function moveItem(db, scope, { id, to, now }) {
  let current;
  try {
    current = await db.prepare('SELECT id, status, kind FROM reports WHERE id = ? AND app_id = ?').bind(id, appIdOf(scope)).first();
  } catch (err) {
    return storeError('tenant move read', err);
  }
  if (!current) return NO_ITEM;
  if (!canTransition(current.status, to, 'person', current.kind)) {
    const legal = PERSON_TRANSITIONS[current.status];
    return {
      code: 'BAD_TRANSITION',
      message: `An item at "${current.status}" cannot move to "${to}".`,
      hint: legal ? `From "${current.status}" it can move to ${legal.join(', ')}.` : `An item at "${current.status}" stays there.`,
    };
  }
  try {
    const res = await db
      .prepare('UPDATE reports SET status = ?, decided_at = ? WHERE id = ? AND app_id = ? AND status = ?')
      .bind(to, DECIDED.includes(to) ? now : null, id, appIdOf(scope), current.status)
      .run();
    if (!res.meta || res.meta.changes === 0) {
      return { code: 'BAD_TRANSITION', message: 'That item moved while this change was in flight.', hint: 'Reload the list and look at where it is now.' };
    }
  } catch (err) {
    return storeError('tenant move write', err);
  }
  return getItem(db, scope, id);
}

/** One item, by primary key and tenant. Another tenant's id answers exactly as no id does. */
export async function getItem(db, scope, id) {
  try {
    const row = await db.prepare(`SELECT ${TENANT_COLUMNS} FROM reports WHERE id = ? AND app_id = ?`).bind(id, appIdOf(scope)).first();
    return { item: row ? toItem(row) : null };
  } catch (err) {
    return storeError('tenant get', err);
  }
}
