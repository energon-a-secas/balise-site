-- Queue #58: the fleet's open-items board. A second KIND of report, not a second table.
--
-- Everything an open item needs already exists in `reports`: the private body, the
-- operator's public_note, the status vocabulary, the C3 token gate, the C5 rendering
-- rule. This migration adds the five columns that describe where an item came from,
-- and nothing else. All five are NULL for a correction, which is what makes this a
-- kind rather than a second surface.
--
-- Applied with an EXPLICIT --local, through `make d1-migrate`. Never type a bare
-- `wrangler d1` command: the reference documents --local and --remote and marks
-- NEITHER as the default.

-- Where the item came from: queue, brief, harness, registry.
ALTER TABLE reports ADD COLUMN source TEXT;

-- The private key inside that source: an id, a project plus a hash of the bullet, a run
-- id, a site id. NEVER selected by a public query. The board's SELECT lists its columns
-- one by one for exactly this reason.
ALTER TABLE reports ADD COLUMN source_ref TEXT;

-- The importer's draft direction, already stripped by src/redact.js. It PREFILLS the
-- desk field and is never published as it stands: publishing goes through public_note,
-- which the operator types and which is checked again server side.
ALTER TABLE reports ADD COLUMN suggested TEXT;

-- The date the board shows for an open entry: the queue line's date, a harness run's
-- started_at, otherwise the first import. Distinct from created_at, which is when THIS
-- service first heard about the item and would make a two-year-old item look new.
ALTER TABLE reports ADD COLUMN opened_at INTEGER;

-- Set when the item left its source. It is not a publish: an item whose source closed
-- is still private until an operator writes the sentence. It is the signal that turns a
-- draft into a candidate RESOLUTION, which is the entry this board exists to show.
ALTER TABLE reports ADD COLUMN source_closed_at INTEGER;

-- ── Indexes ───────────────────────────────────────────────────────────────────
--
-- D1 bills rows_read as rows SCANNED, so every list shape in this service has an index
-- that matches its predicate, and tests/local-d1.test.mjs asserts the budget. Mixing two
-- kinds in one table means the desk's two lists and the public log all gained a `kind`
-- term, and without the indexes below each of those degrades to stepping over every row
-- of the OTHER kind before it can fill a page.

-- The board's two queries: kind, then public, then status.
CREATE INDEX IF NOT EXISTS reports_board ON reports(kind, public, status);

-- The desk's open-item lists. `kind = 'open'` is an equality, so a plain composite index
-- serves the keyset page directly.
CREATE INDEX IF NOT EXISTS reports_open_created ON reports(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_open_status_created ON reports(kind, status, created_at DESC);

-- The desk's CORRECTIONS lists and the public log. `kind <> 'open'` is not an equality
-- and cannot seek an index prefix, so these three are PARTIAL indexes: SQLite uses one
-- when the query's WHERE clause implies the index's, and the term is written the same
-- way in both places on purpose.
--
-- MEASURED 2026-09-09, with 70 imported open items and no corrections in the table: an
-- unfiltered corrections page read 1 row with these indexes and 70 without them, and a
-- status-filtered page read 1 against 65. Both returned the same zero rows either way, so
-- nothing but rows_read would ever have said the list had started scanning the table.
CREATE INDEX IF NOT EXISTS reports_fix_created ON reports(created_at DESC) WHERE kind <> 'open';
CREATE INDEX IF NOT EXISTS reports_fix_status_created ON reports(status, created_at DESC) WHERE kind <> 'open';
CREATE INDEX IF NOT EXISTS reports_fix_public_log ON reports(status, public, fixed_at DESC) WHERE kind <> 'open';
