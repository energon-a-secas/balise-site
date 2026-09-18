// The two queries a stranger can reach without a credential, and the trim that decides
// what a public page is allowed to show. Split out of src/store.js so that "what is
// visible from a neorgon.com page with no token" is a file rather than a section, and so
// the rule below has one place to be read.
//
// EVERY QUERY IN THIS FILE CARRIES `app_id = 'fleet'` AS A LITERAL, NOT AS A PARAMETER.
//
// That is contract C6.5, and the literal is the whole of it. A tenant's items are the
// tenant's, and this Worker publishes the fleet's log and the fleet's health readout at
// addresses with no credential on them: /log, /board and /board/summary. If the key were
// bound, then "no tenant row can be published" would be a property of every call site,
// forever, and one handler reading an app id out of a query string would end it. Written
// as a literal, the statement cannot select a tenant row at all, whatever is bound and
// whatever a caller passes. Owner question Q4 was asked and answered No: these stay
// literals, and a tenant-facing public feed, if it is ever wanted, is a new query
// alongside them rather than a parameter threaded through these.
//
// The board's two queries live in src/store-open.js, next to the feed they read, and carry
// the same literal for the same reason.
//
// The budget note from src/store.js applies here too: paging is keyset, there is no
// OFFSET, and `rowsRead` goes back to the router so a scan is visible.

import { storeError } from './store.js';

// ── The public log ────────────────────────────────────────────────────────────

/**
 * C4's public log query, byte for byte the shape the contract froze, plus the keyset
 * cursor and limit. Three conditions and a tenant literal, one table, still a filter.
 *
 * `body` and `contact` are absent from this SELECT and that is the point: the stranger's
 * raw text is never served from a neorgon.com domain. Only the operator's `public_note`
 * is. Adding `body` here would break settled decision 3 in one line, so do not.
 *
 * `kind <> 'open'` is the one amendment this query has taken. A resolved open item is a
 * board entry and not a correction: it names no site, no page and no reporter, so it
 * would land in the corrections log as a line about nothing. The term is written the same
 * way in migrations/0002_open_items.sql, which is what lets its partial index serve this.
 *
 * `app_id = 'fleet'` is the leading column of reports_app_fix_public_log
 * (migrations/0004_tenants.sql), so this whole WHERE is a prefix of that index and the
 * ORDER BY is its order, which is what keeps a page of `limit` at `limit` rows read. Pinned
 * by index name and seek shape in tests/local-d1-plans.test.mjs. The partial predicate is
 * copied verbatim, since SQLite matches a partial index by implication. Term ORDER here is
 * cosmetic: SQLite reorders WHERE terms itself (A28).
 *
 * `url` is TRIMMED on the way out, by `publicUrl` below, for the same reason `body` is
 * absent: a page address the reporter was looking at is not neutral. /log is the only
 * cacheable, crawler-visible route this service has, and the Beacon sends `location.href`,
 * so the query string arrives whole. The stored column stays whole too, because the desk
 * needs it to reproduce the report. Only this projection is cut.
 */
export async function publicLog(db, { before, limit }) {
  const cursor = before === null || before === undefined ? Number.MAX_SAFE_INTEGER : before;
  try {
    const res = await db
      .prepare(
        `SELECT site, url, target_label, public_note, fixed_ref, fixed_at
           FROM reports
          WHERE app_id = 'fleet' AND kind <> 'open' AND status = 'fixed' AND public = 1 AND fixed_at < ?
          ORDER BY fixed_at DESC LIMIT ?`,
      )
      .bind(cursor, limit)
      .run();
    const rows = res.results || [];
    return {
      entries: rows.map((row) => ({ ...row, url: publicUrl(row.url) })),
      rowsRead: res.meta ? res.meta.rows_read : null,
      next: rows.length === limit ? rows[rows.length - 1].fixed_at : null,
    };
  } catch (err) {
    return storeError('log', err);
  }
}

/**
 * A stored page address as the public log may show it: origin plus pathname, and nothing
 * else. The key keeps the name `url`: the /log response shape is a frozen contract, and
 * the suite asserts its exact key set. This changes the value, never the envelope.
 *
 * What this drops, and why each one is not a hypothetical:
 *
 *   - the QUERY. A report filed from a Vitrina public shelf carries the owner's handle
 *     there, which privacy/index.html promises is kept out of any directory, and one filed
 *     from a Sash claim page carries a live bearer token until it expires.
 *   - the FRAGMENT. Purely client state, and the one place a page puts a value it never
 *     meant to send anywhere.
 *   - the USERINFO prefix. `new URL().origin` drops it, which is the reason the trim goes
 *     through the parser rather than through a regex over the string.
 *
 * Anything that does not parse, or is not http(s), becomes `null` rather than being passed
 * through: a `javascript:` or `data:` address reaching a public page as a rendered link is
 * a worse outcome than a log entry with no address on it.
 */
function publicUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
}

// ── The per-site read-back ────────────────────────────────────────────────────

/**
 * One GROUP BY: reports per site over a window, newest first. It reads what actually arrived,
 * where a static check over files can only prove the widget was copied.
 *
 * A site absent from this list either has no visitors or has a broken widget, and the
 * operator can tell which in one click by opening the site.
 *
 * IMPORTED OPEN ITEMS ARE EXCLUDED, and that exclusion is the whole reason this signal
 * still means anything. They carry their source name in `site` because the column is NOT
 * NULL, they arrive in the hundreds from one command, and counting them here would put
 * four invented sites at the top of the list and drown the one number that says a real
 * Beacon is alive.
 *
 * TENANT ITEMS ARE EXCLUDED FOR THE SAME REASON, and by the same kind of term. This
 * readout answers "is the fleet's Beacon alive", so a busy tenant would drown it exactly
 * as an import does.
 *
 * AND THE GROUP BY DOES SORT (A21). The statement seeks reports_app_fix_created, the smaller
 * partial index whose own predicate is the `kind <> 'open'` term in the WHERE below, and then
 * takes a temp B-tree for the GROUP BY and a second for the ORDER BY. Both B-trees and the
 * index name are pinned in tests/local-d1-plans.test.mjs, so a planner that starts choosing
 * differently is a red test rather than a comment nobody rechecked.
 */
export async function healthSites(db, since) {
  try {
    const res = await db
      .prepare(
        `SELECT site, COUNT(*) AS reports, MAX(created_at) AS last_at
           FROM reports
          WHERE app_id = 'fleet' AND kind <> 'open' AND created_at >= ?
          GROUP BY site
          ORDER BY reports DESC`,
      )
      .bind(since)
      .run();
    return { sites: res.results || [], rowsRead: res.meta ? res.meta.rows_read : null };
  } catch (err) {
    return storeError('health', err);
  }
}
