-- Balise D1 schema. Applied with an EXPLICIT --local, through `make d1-schema` in
-- ../Makefile. Never apply this by typing a bare `wrangler d1 execute`: the command
-- reference documents --local and --remote and marks neither as the default.
--
-- Three tables. The public log is a filter on `reports.status`, not a second table
-- (CONTRACTS.md C4), so there is exactly one place a report's state can be wrong.

CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,

  -- C1.2: site, url and target are supplied by the browser and can be forged with curl.
  -- The Worker validates shape and length and nothing downstream treats `site` as
  -- trusted: it is a grouping hint the operator confirms by opening `url`.
  site          TEXT NOT NULL,
  url           TEXT NOT NULL,
  target_kind   TEXT,
  target_id     TEXT,
  target_label  TEXT,

  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  contact       TEXT,

  status        TEXT NOT NULL DEFAULT 'new',

  -- Defaults to 1. An operator clears it at accept or fix time for a report that is real
  -- but unpublishable: personal data, or abuse in the body.
  public        INTEGER NOT NULL DEFAULT 1,

  -- Written by the operator, never derived from `body`. The stranger's raw text is never
  -- served from a neorgon.com domain (C4).
  public_note   TEXT,
  duplicate_of  TEXT,

  ai_verdict    TEXT,
  ai_confidence REAL,
  ai_notes      TEXT,
  ai_at         INTEGER,

  decided_at    INTEGER,
  fixed_at      INTEGER,
  fixed_ref     TEXT,

  -- SHA-256(BALISE_IP_SALT || CF-Connecting-IP), truncated. Never the address itself.
  -- NULL when no salt is bound, because an unsalted hash of an IPv4 address is
  -- reversible by brute force and would be worse than storing nothing.
  ip_hash       TEXT,

  -- SHA-256(site || target_id || normalised body). The UNIQUE index below IS the
  -- duplicate guard: a repeat submission costs one no-op insert rather than a read plus
  -- a write.
  fingerprint   TEXT NOT NULL
);

-- The desk's filtered list: WHERE status = ? AND created_at < ? ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS reports_status_created ON reports(status, created_at DESC);

-- The desk's unfiltered list, same keyset shape with no status predicate. Without this
-- index that query degrades to a full scan, and D1 bills rows_read as rows SCANNED, so a
-- scan is billed even though the response looks identical.
CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at DESC);

-- C4's public log query, exactly: status = 'fixed' AND public = 1 ORDER BY fixed_at DESC.
-- Three columns in the order the query uses them, so the keyset cursor on fixed_at is a
-- range scan over matching rows only.
CREATE INDEX IF NOT EXISTS reports_public_log ON reports(status, public, fixed_at DESC);

-- The /health per-site read-back: one GROUP BY over a 30 day window.
CREATE INDEX IF NOT EXISTS reports_site_created ON reports(site, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS reports_fp ON reports(fingerprint);

-- C3's operator lockout. Five failures then fifteen minutes, keyed on ip_hash. It lives
-- here and not on the ratelimit binding because that binding's period must be exactly 10
-- or 60 seconds and cannot express fifteen minutes at all (CONTRACTS.md A3).
CREATE TABLE IF NOT EXISTS auth_attempts (
  key           TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- Reserved for a per-site or global ingest counter in D1 if the ratelimit binding ever
-- has to be replaced. Nothing writes it today, and it is created rather than left out so
-- that adding the counter later is a code change and not a schema migration.
CREATE TABLE IF NOT EXISTS submit_counters (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
