// The work queue's SQL, half two: what a runner does with an item it holds. Claim,
// heartbeat, release, submit, land. The reads, filing and every action a person takes are
// half one, src/store-work.js, whose header carries the three-step shape and the batch
// reasoning that every function here follows.
//
// Nothing in this file can refuse or grant a ROLE: every action below is one the table in
// src/work.js gives to either credential. What these functions guard is the LEASE. A run
// proves it holds an item by quoting its run id, every write repeats that id in its guard,
// and a run that lost its lease is told so rather than overwriting the run that replaced it.

import { storeError } from './store.js';
import { OPEN_KIND } from './store-open.js';
import { MAX_ATTEMPTS, stateOf, refusal, submitRule } from './work.js';
import {
  notFound, changed, readRow, holderRefusal, explain, workItem, readDetail, cleanSuggestion,
} from './store-work.js';

// A lapsed lease is claimable again, EXCEPT in ship mode. A ship run pushes before it
// submits, so a run that went silent may already have landed its commit, and a second run
// handed the item would ship it again with nothing on record that the first one did. That
// item waits at claimed for a person, who looks at the repository and withdraws it.
const CLAIMABLE = `work_state IS NOT NULL
  AND (work_state = 'approved' OR (work_state = 'claimed' AND work_lease_until < ? AND work_mode IS NOT 'ship'))
  AND work_attempts < ?`;

// A lapsed lease on an item's last attempt. CLAIMABLE's attempt cap means no claim will ever
// take such a row over, so without the sweep below it would sit at claimed indefinitely,
// listed as running under a lease nobody holds. Ship stays out for the reason above.
const LAPSED_AT_CAP = `work_state IS NOT NULL AND work_state = 'claimed' AND work_lease_until < ?
  AND work_attempts >= ? AND work_mode IS NOT 'ship'`;

/**
 * claim: the oldest approval, or one named item. One batch: the sweep that ends every
 * LAPSED_AT_CAP run as expired and puts its row back at approved, where the desk says it
 * needs a person; the guarded claim; the end of any run whose lease this claim overtook;
 * and the new run built from the row the claim just wrote. The guard is repeated outside
 * the subquery, which is what makes two runners safe: the second one's UPDATE matches
 * nothing and it claims the next item or none.
 */
export async function claimWork(db, { actor, runner, id, leaseSeconds, now }) {
  const runId = crypto.randomUUID();
  const leaseUntil = now + leaseSeconds * 1000;
  const pick = id ? `${CLAIMABLE} AND id = ?` : CLAIMABLE;

  let claimed;
  try {
    [, , claimed] = await db.batch([
      // Runs first, while their rows still say claimed and so can still be found.
      db.prepare(
        `UPDATE work_runs SET ended_at = ?, end_reason = 'expired'
          WHERE ended_at IS NULL AND id IN (SELECT work_run FROM reports WHERE ${LAPSED_AT_CAP})`,
      ).bind(now, now, MAX_ATTEMPTS),
      db.prepare(
        `UPDATE reports SET work_state = 'approved', work_lease_until = NULL, work_updated_at = ?
          WHERE ${LAPSED_AT_CAP}`,
      ).bind(now, now, MAX_ATTEMPTS),
      db.prepare(
        `UPDATE reports SET work_state = 'claimed', work_run = ?, work_lease_until = ?,
                work_attempts = work_attempts + 1, work_updated_at = ?
          WHERE id = (SELECT id FROM reports WHERE ${pick} ORDER BY work_approved_at LIMIT 1)
            AND ${CLAIMABLE}`,
      ).bind(runId, leaseUntil, now, now, MAX_ATTEMPTS, ...(id ? [id] : []), now, MAX_ATTEMPTS),
      db.prepare(
        `UPDATE work_runs SET ended_at = ?, end_reason = 'expired'
          WHERE ended_at IS NULL AND id <> ? AND report_id = (SELECT id FROM reports WHERE work_run = ?)`,
      ).bind(now, runId, runId),
      db.prepare(
        `INSERT INTO work_runs (id, report_id, attempt, runner, mode, instruction, claimed_at, heartbeat_at, lease_until)
         SELECT ?, id, work_attempts, ?, COALESCE(work_mode, 'fix'), work_instruction, ?, ?, ?
           FROM reports WHERE work_run = ? AND work_state = 'claimed'`,
      ).bind(runId, runner, now, now, leaseUntil, runId),
    ]);
  } catch (err) {
    return storeError('work claim', err);
  }

  if (changed(claimed)) return readDetail(db, 'run', runId);
  if (!id) return { item: null };
  return whyNotClaimable(db, id, actor, now);
}

async function whyNotClaimable(db, id, actor, now) {
  let row;
  try {
    row = await readRow(db, id);
  } catch (err) {
    return storeError('work claim read', err);
  }
  if (!row) return notFound();
  const from = stateOf(row.work_state);
  if (from === 'claimed' && row.work_lease_until >= now) {
    return {
      code: 'BAD_TRANSITION',
      message: 'Another run holds that item.',
      hint: `Its lease runs until ${new Date(row.work_lease_until).toISOString()}. Claim something else meanwhile.`,
    };
  }
  if (from === 'claimed' && row.work_mode === 'ship') {
    return {
      code: 'BAD_TRANSITION',
      message: 'A ship run held that item and its lease ran out, so no other run takes it over.',
      hint: 'That run may already have pushed its commit. The operator checks the repository, withdraws the item, and approves it again only if the work is still undone.',
    };
  }
  if ((from === 'approved' || from === 'claimed') && row.work_attempts >= MAX_ATTEMPTS) {
    return {
      code: 'BAD_TRANSITION',
      message: `That item has used all ${MAX_ATTEMPTS} attempts.`,
      hint: 'It needs a person now: the operator withdraws it and approves it again, usually with a new instruction.',
    };
  }
  return refusal('claim', from, actor);
}

/** heartbeat: extend the lease. A lease that ran out but was not yet reclaimed revives. */
export async function heartbeatWork(db, { id, actor, run, leaseSeconds, now }) {
  const leaseUntil = now + leaseSeconds * 1000;
  try {
    const [moved] = await db.batch([
      db.prepare(
        `UPDATE reports SET work_lease_until = ?, work_updated_at = ?
          WHERE id = ? AND work_state = 'claimed' AND work_run = ?`,
      ).bind(leaseUntil, now, id, run),
      db.prepare(
        `UPDATE work_runs SET heartbeat_at = ?, lease_until = ?
          WHERE id = ? AND report_id = ? AND ended_at IS NULL
            AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND work_state = 'claimed' AND work_run = ? AND work_updated_at = ?)`,
      ).bind(now, leaseUntil, run, id, id, run, now),
    ]);
    if (!changed(moved)) return explain(db, id, run, 'heartbeat', actor);
  } catch (err) {
    return storeError('work heartbeat', err);
  }
  return workItem(db, id);
}

/** release: give the item back without a result. The attempt still counts. */
export async function releaseWork(db, { id, actor, run, note, now }) {
  try {
    const [moved] = await db.batch([
      db.prepare(
        `UPDATE reports SET work_state = 'approved', work_lease_until = NULL, work_updated_at = ?
          WHERE id = ? AND work_state = 'claimed' AND work_run = ?`,
      ).bind(now, id, run),
      db.prepare(
        `UPDATE work_runs SET ended_at = ?, end_reason = 'released', summary = COALESCE(NULLIF(?, ''), summary)
          WHERE id = ? AND report_id = ? AND ended_at IS NULL
            AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND work_run = ? AND work_state = 'approved' AND work_updated_at = ?)`,
      ).bind(now, note, run, id, id, run, now),
    ]);
    if (!changed(moved)) return explain(db, id, run, 'release', actor);
  } catch (err) {
    return storeError('work release', err);
  }
  return workItem(db, id);
}

/**
 * submit: the result, into review. The mode rules are checked against the mode the run
 * was CLAIMED in. A drafted sentence survives only on an open item and only if it clears
 * the redaction floor; on a correction it is dropped, because an AI paraphrase of a
 * stranger's report never prefills a public note (A6).
 */
export async function submitWork(db, { id, actor, run, outcome, summary, evidence, refs, needsLanding, suggestedNote, now }) {
  let row;
  try {
    row = await readRow(db, id);
  } catch (err) {
    return storeError('work submit read', err);
  }
  if (!row) return notFound();
  const refused = holderRefusal(row, run, 'submit', actor);
  if (refused) return refused;
  const rule = submitRule(row.run_mode, { outcome, needs_landing: needsLanding, refs });
  if (rule) return rule;

  const sentence = row.kind === OPEN_KIND ? cleanSuggestion(suggestedNote) : '';
  try {
    const [moved] = await db.batch([
      db.prepare(
        `UPDATE reports SET work_state = 'review', work_lease_until = NULL, work_updated_at = ?
          WHERE id = ? AND work_state = 'claimed' AND work_run = ?`,
      ).bind(now, id, run),
      db.prepare(
        `UPDATE work_runs SET ended_at = ?, end_reason = 'submitted', outcome = ?, summary = ?, evidence = ?,
                refs = ?, needs_landing = ?, suggested_note = ?, review = NULL
          WHERE id = ? AND report_id = ? AND ended_at IS NULL
            AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND work_run = ? AND work_state = 'review' AND work_updated_at = ?)`,
      ).bind(now, outcome, summary, evidence || null, JSON.stringify(refs), needsLanding ? 1 : 0, sentence, run, id, id, run, now),
    ]);
    if (!changed(moved)) return explain(db, id, run, 'submit', actor);
  } catch (err) {
    return storeError('work submit', err);
  }
  return workItem(db, id);
}

/** land or unland an accepted result. Landed is done; a landing that failed goes back to
 *  review with the runner's note, and the operator decides again. Only a run that was
 *  accepted AND needed landing can take a landing: an item already done by any other road
 *  (a ship run, an investigation, a fix with nothing to land) is refused, and now writes
 *  nothing either. */
export async function landWork(db, { id, actor, run, landed, refs, note, now }) {
  const action = landed ? 'land' : 'unland';
  const statements = landed
    ? [
      db.prepare(
        `UPDATE reports SET work_state = 'done', work_updated_at = ?
          WHERE id = ? AND work_state = 'accepted' AND work_run = ?`,
      ).bind(now, id, run),
      db.prepare(
        `UPDATE work_runs SET landed_at = ?, refs = COALESCE(?, refs), land_note = COALESCE(NULLIF(?, ''), land_note)
          WHERE id = ? AND report_id = ? AND landed_at IS NULL AND needs_landing = 1 AND review = 'accepted'
            AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND work_run = ? AND work_state = 'done' AND work_updated_at = ?)`,
      ).bind(now, refs.length ? JSON.stringify(refs) : null, note, run, id, id, run, now),
    ]
    : [
      db.prepare(
        `UPDATE reports SET work_state = 'review', work_updated_at = ?
          WHERE id = ? AND work_state = 'accepted' AND work_run = ?`,
      ).bind(now, id, run),
      db.prepare(
        `UPDATE work_runs SET land_note = ?, review = NULL, reviewed_at = NULL
          WHERE id = ? AND report_id = ? AND review = 'accepted'
            AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND work_run = ? AND work_state = 'review' AND work_updated_at = ?)`,
      ).bind(note, run, id, id, run, now),
    ];
  try {
    const [moved] = await db.batch(statements);
    if (!changed(moved)) return explain(db, id, run, action, actor);
  } catch (err) {
    return storeError('work land', err);
  }
  return workItem(db, id);
}
