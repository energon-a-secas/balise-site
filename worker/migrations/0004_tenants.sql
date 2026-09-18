-- Multi-tenant support: apps, keys, and per-tenant reports. Additive only, safe to apply
-- under Worker 1.1.0 and 1.0.0. DESIGN.md section 4 is the specification, and section 6.1
-- is why this migration drops nothing: Worker 1.1.0 can run on a database that has applied
-- this, and rolling 1.2.0 back to 1.1.0 needs no database action at all.
--
-- Applied with an EXPLICIT --local, through `make d1-migrate`. Never type a bare
-- `wrangler d1` command: the reference documents --local and --remote and marks NEITHER as
-- the default.

-- ── Tenant columns on reports ─────────────────────────────────────────────────

-- The tenant key. NOT NULL with a sentinel, never NULL for the fleet: with NULL,
-- WHERE app_id = ? bound to NULL matches nothing, silently, and every fleet page would
-- come back empty. The default backfills every existing row as the fleet's without a
-- table rewrite.
ALTER TABLE reports ADD COLUMN app_id TEXT NOT NULL DEFAULT 'fleet';

-- Which key posted this item. Forensics: when a bpk_ leaks and 400 items arrive, this
-- is what says which key to revoke and what to delete. NULL on every fleet row.
ALTER TABLE reports ADD COLUMN app_key_id TEXT;

-- ── Apps ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS apps (
  -- The public app id, in the endpoint the owner is given. Generated, not chosen: a
  -- chosen id is a name people fight over and a way to probe for other people's apps.
  -- 'fleet' is refused.
  id            TEXT PRIMARY KEY,

  -- The person_id from the principal. Opaque. The only field authorization ever reads.
  owner         TEXT NOT NULL,

  -- A cached display name or address, captured at registration so the operator can tell
  -- who owns what. Never read for authorization.
  owner_label   TEXT,

  -- The person's own label for the app. Hostile input: length and charset validated,
  -- rendered with setText.
  name          TEXT NOT NULL,

  -- A JSON array, at most five exact origins. JSON because D1 has SQLite's JSON
  -- functions and because five short strings do not deserve a table.
  origins       TEXT NOT NULL DEFAULT '[]',

  created_at    INTEGER NOT NULL,

  -- Set by the operator to stop an app's ingest without deleting the person's items.
  disabled_at   INTEGER
);

-- The console's "my apps, newest first" query, in exactly `limit` rows.
CREATE INDEX IF NOT EXISTS apps_owner ON apps(owner, created_at DESC);

-- ── App keys ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_keys (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL,

  -- 'public' or 'secret' (C6.2). The kind is data, so answering owner question Q1
  -- later is a row, not a code change.
  kind          TEXT NOT NULL,

  -- SHA-256 hex of the key text. The key itself is never stored (C3's rule, and A10
  -- says why this path does not also need timingSafeEqual).
  key_hash      TEXT NOT NULL,

  -- The first eight characters, so the console can show which key is which after it
  -- has stopped showing the key.
  prefix        TEXT NOT NULL,

  created_at    INTEGER NOT NULL,

  -- YYYY-MM-DD, written only when it differs from what is stored, so it is one row
  -- written per key per day and not one per post. Without it an operator cannot tell
  -- whether a rotated-away key is safe to revoke, which is the step Stripe's own
  -- rotation guidance names (C6.2).
  last_used_date TEXT,

  -- Revocation is a timestamp, not a delete, so a revoked key that is still posting
  -- can be recognised rather than becoming an unknown key.
  revoked_at    INTEGER
);

-- The whole authentication path: one indexed lookup, one row or none.
CREATE UNIQUE INDEX IF NOT EXISTS app_keys_hash ON app_keys(key_hash);

-- The console's key list.
CREATE INDEX IF NOT EXISTS app_keys_app ON app_keys(app_id, created_at DESC);

-- ── Indexes on reports ────────────────────────────────────────────────────────
--
-- app_id is the leading column of every index, bound or written as a literal in the
-- query, and no partial-index predicate ever mentions app_id (DESIGN.md section 4.1).
-- This is Cloudflare's own rule: "For a multi-column index, queries will only use the
-- index if they specify either all of the columns, or a subset of the columns provided
-- all columns to the 'left' are also within the query."
--
-- Six existing indexes (reports_board, reports_open_created, reports_open_status_created,
-- reports_work_updated, reports_work_run, work_runs_report) are deliberately left alone
-- because every query that uses them is fleet-only by invariant (DESIGN.md section 4.3),
-- and the invariants are asserted by tests/tenant-scope.test.mjs.
--
-- Six other indexes (reports_created, reports_status_created, reports_fix_created,
-- reports_fix_status_created, reports_fix_public_log, reports_site_created) are NOT
-- dropped here, even though the six below supersede them. Dropping them would leave
-- Worker 1.1.0's unscoped queries with no index at all, and 1.1.0 is what a rollback
-- goes back to. Removing them is a follow-up queue item for after 1.2.0 is live.

-- listReports with a kind given, and the tenant item list with no status filter.
-- Supersedes reports_created.
CREATE INDEX IF NOT EXISTS reports_app_created ON reports(app_id, created_at DESC);

-- listReports with kind and status, and the tenant list with a status filter.
-- Supersedes reports_status_created.
CREATE INDEX IF NOT EXISTS reports_app_status_created ON reports(app_id, status, created_at DESC);

-- listReports with no kind, the corrections queue. The predicate text is copied verbatim
-- from 0002_open_items.sql and from store.js:173, per the implication rule.
CREATE INDEX IF NOT EXISTS reports_app_fix_created ON reports(app_id, created_at DESC) WHERE kind <> 'open';

-- listReports with a status and no kind.
CREATE INDEX IF NOT EXISTS reports_app_fix_status_created ON reports(app_id, status, created_at DESC) WHERE kind <> 'open';

-- publicLog (store.js:361-365), which reads kind <> 'open' AND status = 'fixed' AND
-- public = 1 AND fixed_at < ? ordered by fixed_at DESC. Every column of the WHERE is a
-- prefix of the index and the sort is the index order, which is what makes a page of
-- limit read limit rows.
CREATE INDEX IF NOT EXISTS reports_app_fix_public_log ON reports(app_id, status, public, fixed_at DESC) WHERE kind <> 'open';

-- healthSites (store.js:429-434), which groups by site inside a 30-day window. The
-- GROUP BY uses the index order rather than a sort.
CREATE INDEX IF NOT EXISTS reports_app_site_created ON reports(app_id, site, created_at DESC);

-- ── Statistics ────────────────────────────────────────────────────────────────
--
-- PRAGMA optimize runs ANALYZE and gives the planner the statistics it needs to choose
-- the indexes above. Without it a correctly created index can simply not be picked, and
-- the symptom is indistinguishable from a wrong index shape (DESIGN.md section 4.1,
-- Cloudflare's own guidance).
PRAGMA optimize;
