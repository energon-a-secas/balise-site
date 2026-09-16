-- The work queue: an operator approves an item, a runner claims it, does the work where the
-- code is, and hands a result back to be accepted, returned or dropped. The design is
-- docs/DESIGN-WORK-QUEUE.md; this file is only what that design needs from D1.
--
-- EXECUTION IS A SECOND AXIS, NOT A STATUS. C4's `status` says what a reader can see, and
-- `work_state` says whether an agent is on it. Most work happens on drafts nobody has
-- published yet, so the two move independently and never share a column. Every column
-- below is NULL (or 0) for every existing row, which is what "not in the work queue" means.
--
-- Applied with an EXPLICIT --local, through `make d1-migrate`. Never type a bare
-- `wrangler d1` command: the reference documents --local and --remote and marks NEITHER as
-- the default.

-- approved | claimed | review | accepted | done. NULL when the row is not in the queue.
ALTER TABLE reports ADD COLUMN work_state TEXT;

-- investigate | fix | ship, chosen by the operator per approval.
ALTER TABLE reports ADD COLUMN work_mode TEXT;

-- The operator's words to the runner. Optional on an open item, where the tracker text is
-- the fleet's own. REQUIRED on a correction, where the body is a stranger's and reaches the
-- runner only as quoted data.
ALTER TABLE reports ADD COLUMN work_instruction TEXT;

-- The current or latest run. The lease holder proves itself by quoting this id, so a runner
-- whose item was reclaimed after its lease ran out cannot submit over the new attempt.
ALTER TABLE reports ADD COLUMN work_run TEXT;

-- Claims so far. Three and the item stops being claimable until a person approves it again.
-- A third lease that runs out puts the item back at approved, where the desk says so.
ALTER TABLE reports ADD COLUMN work_attempts INTEGER NOT NULL DEFAULT 0;

-- Milliseconds. Set while claimed; a claim past this moment is claimable by the next runner,
-- except in ship mode, where the lapsed run may already have pushed and a person decides.
ALTER TABLE reports ADD COLUMN work_lease_until INTEGER;

-- Queue order: oldest approval is claimed first.
ALTER TABLE reports ADD COLUMN work_approved_at INTEGER;

-- List order and, with the id as the tiebreak, the keyset cursor for GET /work.
ALTER TABLE reports ADD COLUMN work_updated_at INTEGER;

-- Which credential filed an item through POST /work/items: 'human' for the operator's,
-- 'ai' for automation's. NULL for every other row, an import or a reader's report. A runner
-- that read a stranger's report may file its follow-up in that stranger's words, so
-- src/work.js trusts an 'ai' item no further than a correction: an instruction a person
-- wrote, and never ship.
ALTER TABLE reports ADD COLUMN filed_by TEXT;

-- One row per claim. Nothing here is ever public: no public query reads this table, and the
-- board learns only whether a published item is moving, from `reports.work_state`.
CREATE TABLE IF NOT EXISTS work_runs (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL,
  attempt        INTEGER NOT NULL,
  runner         TEXT NOT NULL,
  mode           TEXT NOT NULL,
  -- What the runner was told when it claimed, kept even if the operator edits it later, so
  -- a result can always be read against the instruction it was produced from.
  instruction    TEXT,
  claimed_at     INTEGER NOT NULL,
  heartbeat_at   INTEGER NOT NULL,
  lease_until    INTEGER NOT NULL,
  ended_at       INTEGER,
  -- submitted | released | expired | withdrawn
  end_reason     TEXT,
  -- fixed | investigated | partial | blocked | failed
  outcome        TEXT,
  summary        TEXT,
  evidence       TEXT,
  -- JSON: [{ repo, branch?, commit? }]
  refs           TEXT,
  needs_landing  INTEGER NOT NULL DEFAULT 0,
  -- The runner's draft resolution sentence. Open items only, stripped by src/redact.js,
  -- and it only ever prefills the desk field.
  suggested_note TEXT,
  -- accepted | returned | dismissed
  review         TEXT,
  review_note    TEXT,
  reviewed_at    INTEGER,
  landed_at      INTEGER,
  land_note      TEXT
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
--
-- PARTIAL, so the corrections queue, the open feed and the board keep exactly the indexes
-- and the rows_read they had: a row outside the work queue is not in any of these. Every
-- query in src/store-work.js and src/store-work-runner.js carries a term that implies the
-- index's WHERE clause, because SQLite uses a partial index only when it can prove that
-- implication.
--
-- There is no (work_state, work_approved_at) index for the claim. The claim picks from two
-- states at once, approved or claimed past its lease, and SQLite answers that OR from two
-- seeks and a sort whichever index it has, so one here was written on every state change
-- and read by no query.

-- The desk's Work view: newest change first, one state or the active four. Also the
-- claim's pick, its sweep of lapsed last attempts, and the count per state.
CREATE INDEX IF NOT EXISTS reports_work_updated ON reports(work_state, work_updated_at DESC) WHERE work_state IS NOT NULL;

-- The lease check and the claim's read-back, by run id.
CREATE INDEX IF NOT EXISTS reports_work_run ON reports(work_run) WHERE work_run IS NOT NULL;

-- An item's run history, newest first.
CREATE INDEX IF NOT EXISTS work_runs_report ON work_runs(report_id, claimed_at DESC);
