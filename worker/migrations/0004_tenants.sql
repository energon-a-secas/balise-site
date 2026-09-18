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
-- FOURTEEN INDEXES EXIST BEFORE THIS MIGRATION and the taxonomy below accounts for every
-- one of them: five from 0001_baseline.sql, six from 0002_open_items.sql, three from
-- 0003_work.sql. Counted from the migration files themselves, not from DESIGN.md, whose
-- inventory A29 found to be one index short. The count is stated because this comment is
-- where an index's justification is read when somebody proposes dropping it, and an
-- enumeration that presents itself as complete while omitting an index is how a live index
-- reaches a drop list. It used to enumerate two groups of six and stop at twelve.
--
-- Six are deliberately left alone (reports_board, reports_open_created,
-- reports_open_status_created, reports_work_updated, reports_work_run, work_runs_report)
-- because every query that uses them is fleet-only by invariant (DESIGN.md section 4.3),
-- and the invariants are asserted by tests/tenant-scope.test.mjs. Mechanically, each is
-- keyed on or restricted to a column only an open item carries (kind, work_state,
-- work_run), or sits on work_runs, so a seek through one does not reach a tenant's
-- correction in the first place.
--
-- Six others (reports_created, reports_status_created, reports_fix_created,
-- reports_fix_status_created, reports_fix_public_log, reports_site_created) are NOT
-- dropped here, even though the six below supersede them. Dropping them would leave
-- Worker 1.1.0's unscoped queries with no index at all, and 1.1.0 is what a rollback
-- goes back to. Removing them is a follow-up queue item for after 1.2.0 is live, and that
-- queue item covers THESE SIX AND NOTHING ELSE: none of the six created below belongs on
-- it. reports_app_site_created in particular does not, for the measured reason in its own
-- comment further down.
--
-- The remaining two belong to neither group, so they are named here rather than left to be
-- inferred from a list that does not mention them:
--
--   reports_public_log (0001_baseline.sql) is LIVE AND MUST NOT REACH ANY DROP LIST. A29
--   withdrew a "dead weight" claim about it after measuring: tests/local-d1-plans.test.mjs
--   pins both `board, resolved list` and `boardSummary, latest` onto it by name. It is not
--   superseded by reports_app_fix_public_log, which is the near-twin it gets mistaken for:
--   that index is partial on kind <> 'open' and every board query carries kind = 'open',
--   so the two cover disjoint sets of rows and neither can ever substitute for the other.
--   Nor does it sit with the first six: keyed on (status, public, fixed_at), it holds every
--   row in the table, so a seek through it CAN reach a tenant's row and only the query's
--   own predicate stops it (A26).
--
--   reports_fp (0001_baseline.sql) is the UNIQUE fingerprint index and stays global on
--   purpose. It gets no app_id because it needs none: fingerprintInput() takes appId as its
--   first field, so two tenants cannot produce the same fingerprint and table-wide
--   uniqueness is already the tenant-safe shape (A11). The import path's reads are the
--   reason this matters here, and they are covered at reports_app_site_created below.

-- listReports with a kind given, and the tenant item list with no status filter.
-- Supersedes reports_created.
CREATE INDEX IF NOT EXISTS reports_app_created ON reports(app_id, created_at DESC);

-- listReports with kind and status, and the tenant list with a status filter.
-- Supersedes reports_status_created.
CREATE INDEX IF NOT EXISTS reports_app_status_created ON reports(app_id, status, created_at DESC);

-- listReports with no kind, the corrections queue. The predicate text is copied verbatim
-- from reports_fix_created in 0002_open_items.sql and from the `kindTerm` default inside
-- listReports() in src/store.js, per the implication rule: SQLite uses a partial index only
-- where it can prove the query's WHERE implies the index's own predicate, and it proves that
-- by matching the text, so the three copies must stay identical. Referred to by function
-- name rather than by line number: this campaign's own split of store.js moved the line the
-- old reference named (store.js:173) onto an unrelated bind inside insertReport(), which
-- reads as though the predicate had no consumer.
CREATE INDEX IF NOT EXISTS reports_app_fix_created ON reports(app_id, created_at DESC) WHERE kind <> 'open';

-- listReports with a status and no kind.
CREATE INDEX IF NOT EXISTS reports_app_fix_status_created ON reports(app_id, status, created_at DESC) WHERE kind <> 'open';

-- publicLog() in src/store-public.js, which reads kind <> 'open' AND status = 'fixed' AND
-- public = 1 AND fixed_at < ? ordered by fixed_at DESC. Every column of the WHERE is a
-- prefix of the index and the sort is the index order, which is what makes a page of
-- limit read limit rows. Pinned by name, with all four seek columns, in
-- tests/local-d1-plans.test.mjs, so this is a measurement and not an intention.
CREATE INDEX IF NOT EXISTS reports_app_fix_public_log ON reports(app_id, status, public, fixed_at DESC) WHERE kind <> 'open';

-- Created for healthSites() in src/store-public.js, which groups by site inside a 30-day
-- window. THE GROUP BY DOES SORT, AND THIS IS NOT THE INDEX IT RUNS ON (A21). This comment
-- used to claim the grouping walked the index order. Measured, that statement seeks
-- reports_app_fix_created on (app_id, created_at), the smaller partial index whose predicate
-- the WHERE's own kind <> 'open' term implies, and then takes a temp B-tree for the GROUP BY
-- and a second one for the ORDER BY. Both B-trees and the index name are pinned in
-- tests/local-d1-plans.test.mjs, and the same correction is written at healthSites() itself,
-- so the two records say one thing rather than three.
--
-- DO NOT READ THAT AS "THIS INDEX IS UNUSED". Measured 2026-09-18 on a freshly migrated
-- local D1, the import's dedupe read and the open sync read, both in src/store-open.js, plan
-- onto this index: adding the fleet literal moved the dedupe read off the UNIQUE reports_fp
-- it used before this migration (A36). The three import UPDATEs did not move and are still
-- on reports_fp, so it is the two reads and only the two reads. A drop here is therefore a
-- measurement over every statement that could use the index, never an inference from one
-- query's plan. Two "this index is dead weight" claims in this campaign have already been
-- wrong that way, A29's about reports_public_log and A21's about this one.
--
-- WHAT IS GENUINELY OPEN is a 0005 question and deliberately not answered here. It cannot be
-- answered here: d1_migrations records a migration by name with no content hash, so an
-- applied 0004 is never re-run and an index added to this file would reach no database that
-- has already seen it. The open question is this: those two reads seek the app_id prefix
-- ALONE, and reports_app_created and reports_app_status_created serve them identically when
-- forced with INDEXED BY, while the three partial indexes are refused outright because
-- neither read carries a kind term to imply their predicate. Nothing in src/ keys on the
-- `site` column at all: its only use is healthSites' GROUP BY, which as measured above goes
-- elsewhere. What the dedupe read wants is (app_id, fingerprint), one entry per fingerprint,
-- instead of the whole fleet behind an (app_id) seek. That is a schema decision for the owner,
-- carried as an open item, so no reader of this file should settle it from the comment.
CREATE INDEX IF NOT EXISTS reports_app_site_created ON reports(app_id, site, created_at DESC);

-- ── Statistics ────────────────────────────────────────────────────────────────
--
-- PRAGMA optimize runs ANALYZE and gives the planner the statistics it needs to choose
-- the indexes above. Without it a correctly created index can simply not be picked, and
-- the symptom is indistinguishable from a wrong index shape (DESIGN.md section 4.1,
-- Cloudflare's own guidance).
PRAGMA optimize;
