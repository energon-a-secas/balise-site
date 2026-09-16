// What a run did, or is doing, on a work card: its runner and lease, its outcome, summary,
// evidence and refs, and whether any of it landed (docs/DESIGN-WORK-QUEUE.md section 7).
// Lifted out of desk-work.js when that file reached the fleet's 500 line cap; the move added
// only `unlanded` and the line it decides.
//
// C5 holds here as in every desk file: every value is rendered through elem(). A runner's
// summary is no more trusted than a stranger's report, because on a correction the runner
// read one.

import { elem, formatDate } from './utils.js';

const OUTCOME_LABEL = {
  fixed: 'Fixed',
  investigated: 'Investigated',
  partial: 'Partly done',
  blocked: 'Blocked',
  failed: 'Failed',
};

const refText = (ref) => `${ref.repo}${ref.branch ? `#${ref.branch}` : ''}${ref.commit ? `@${ref.commit}` : ''}`;

function timeOf(ms) {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(ms);
  }
}

export function noteLine(key, value) {
  const line = elem('p', 'desk-work__note');
  line.append(elem('span', 'desk-card__key', key), elem('span', 'desk-card__value', value));
  return line;
}

/**
 * Whether a result's commits are still only on their branch, with nothing in Balise left to land
 * them. A fix run lands only through needs_landing, so its refs without it never land: a
 * repository with no origin, or an attempt that stopped short. A ship run lands before it
 * submits, and submits `blocked` when that landing was refused (.claude/commands/work.md 3.4).
 * A ship run's `partial` may already have landed what passed its checks, so it is not called
 * unlanded: that line would invite a second ship of a change already on the default branch.
 */
export function unlanded(run) {
  if (!run || !Array.isArray(run.refs) || !run.refs.length || run.needs_landing || run.landed_at) return false;
  return run.mode === 'fix' || run.outcome === 'blocked';
}

/** A lapsed lease means something different by mode and count (C-g). A ship run may already
 *  have pushed, so no runner takes that item again, and the operator is the one who checks. */
function lapsedText(item, run) {
  if (item.work.mode === 'ship' || run.mode === 'ship') {
    return 'lease ran out. A ship run may already have pushed, so no runner takes it again: check the repository for its commit before you withdraw it.';
  }
  if (item.work.attempts >= item.work.max_attempts) {
    return 'lease ran out on its last attempt, so the next claim puts it back in Waiting for you to decide';
  }
  return 'lease ran out, so another run can take it';
}

/** What the current run did, or is doing. */
export function runNode(item, run, state) {
  const box = elem('div', 'desk-work__run');
  const head = elem('p', 'desk-work__run-head');
  if (state === 'claimed') {
    const until = item.work.lease_until;
    const lapsed = typeof until === 'number' && until < Date.now();
    head.append(elem('span', null, `Runner ${run.runner}, `));
    head.append(elem('span', lapsed ? 'desk-work__lapsed' : null, lapsed ? lapsedText(item, run) : `lease until ${timeOf(until)}`));
  } else {
    if (run.outcome) head.append(elem('span', `desk-badge desk-badge--outcome-${run.outcome}`, OUTCOME_LABEL[run.outcome] || run.outcome));
    head.append(elem('span', 'muted', `by ${run.runner}, attempt ${run.attempt}`));
  }
  box.append(head);

  if (run.summary) box.append(elem('p', 'desk-work__summary', run.summary));
  if (run.evidence) {
    const evidence = elem('details', 'desk-open__source');
    evidence.append(elem('summary', 'desk-open__summary', 'Evidence'), elem('pre', 'desk-work__evidence', run.evidence));
    box.append(evidence);
  }
  if (run.refs && run.refs.length) {
    const list = elem('ul', 'desk-work__refs');
    run.refs.forEach((ref) => {
      const entry = elem('li');
      entry.append(elem('code', null, refText(ref)));
      list.append(entry);
    });
    box.append(list);
  }
  // Only while a person is deciding. Once accepted, the card's own line says the runner
  // lands it next, and repeating "accepting lets it land" under that reads as a contradiction.
  if (state === 'review' && run.needs_landing && !run.landed_at) {
    box.append(elem('p', 'desk-work__note muted', 'Committed on a branch and not landed. Accepting lets the runner land it.'));
  }
  // Said plainly and in the warning colour: refs under a result read like a landing, and a
  // resolution published for a change still on its branch puts a fix on the board nobody has.
  if (unlanded(run)) {
    box.append(elem('p', 'desk-work__note desk-work__lapsed', 'Not landed: these commits are still only on their branch, and nothing in Balise lands them.'));
  }
  if (run.landed_at) box.append(elem('p', 'desk-work__note muted', `Landed ${formatDate(run.landed_at)}`));
  if (run.land_note) box.append(noteLine('Landing: ', run.land_note));
  // A new claim makes a new run, so the note that sent the last one back is the item's, not
  // this run's, and the operator judging the next attempt needs to see what they asked for.
  if (run.review_note) box.append(noteLine(run.review === 'returned' ? 'You sent it back: ' : 'Your note: ', run.review_note));
  else if (item.last_review_note) box.append(noteLine('Your note on an earlier attempt: ', item.last_review_note));
  return box;
}
