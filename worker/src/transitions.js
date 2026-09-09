// C4: the status vocabulary and the transition tables. Pure, no SQL, no I/O.
//
// Lifted out of src/store.js when the open-items feed arrived and that file passed the
// fleet's 500 line cap. The split is a good one on its own terms: this is the part of C4
// a reader has to be able to check at a glance, and src/store.js is now only the SQL that
// enforces it. Nothing here changed in the move except OPEN_TRANSITIONS being added.
//
// Every table below is spelled out in full rather than derived from another one. A
// derived table reads as clever and hides the one edge that matters, and tests/api.test.mjs
// asserts each of them literally so that widening one by accident fails with the offending
// edge named.

/** The seven statuses. Reading is whitelisted against this list on both sides. */
export const STATUSES = ['new', 'triaged', 'accepted', 'fixed', 'rejected', 'spam', 'duplicate'];

/**
 * Legal transitions, enforced in code. Anything not listed here is 409 BAD_TRANSITION.
 * `fixed` is terminal and has no entry.
 */
export const TRANSITIONS = {
  new: ['triaged', 'accepted', 'rejected', 'spam', 'duplicate'],
  triaged: ['accepted', 'rejected', 'spam', 'duplicate'],
  accepted: ['fixed', 'rejected'],
  fixed: [],
  rejected: ['accepted'],
  spam: ['accepted'],
  duplicate: ['accepted'],
};

/**
 * The AI is authorised for exactly one edge: new -> triaged. Settled decision 4 of this
 * campaign ("triage and propose, never auto-apply") is enforced here rather than
 * described in a comment somewhere.
 *
 * READ THIS BEFORE TRUSTING IT. The AI job and the desk hold the SAME token today, so
 * the Worker tells them apart by the `X-Balise-Actor: ai` header, which the caller sets
 * about itself. That is an HONESTY MECHANISM, NOT A SECURITY BOUNDARY: it stops the job
 * from doing the wrong thing, and it does nothing at all against an attacker who already
 * holds the token, because that attacker simply omits the header. Do not later cite this
 * check as the reason the AI "cannot" change a report's status. If it ever needs to be a
 * boundary, the AI needs its own credential.
 */
/**
 * What the AUTOMATION credential may do. Enforced against the token that
 * authenticated, never against a header the caller sets, so this is a real
 * boundary rather than the honesty mechanism it used to be.
 *
 * The rule behind the list: automation may write a verdict and it may CLOSE
 * junk, but it may never move a report toward anything a reader will see.
 *
 *   - `triaged` records an opinion and its evidence. Publishes nothing.
 *   - `spam` and `duplicate` are closing moves. They publish nothing either,
 *     they are the bulk of the volume, and they are the judgement an AI is
 *     actually good at. Both are cheap to get wrong: a human reopen
 *     (spam -> accepted) is already legal and is deliberately NOT granted here,
 *     so automation can close junk but only a person can bring one back.
 *
 * `accepted` and `fixed` stay human. `fixed` in particular requires a
 * public_note, and C4 says an operator writes that note and never derives it
 * from the reporter's text, because it lands on a public page. An AI writing it
 * would route stranger-influenced text onto neorgon.com through a paraphrase,
 * which is the exact thing settled decision 3 exists to prevent.
 */
export const AI_TRANSITIONS = {
  new: ['triaged', 'spam', 'duplicate'],
  triaged: ['spam', 'duplicate'],
};

/**
 * The human table for an OPEN ITEM (kind = 'open'), which is the corrections table plus
 * exactly one edge: new -> fixed.
 *
 * That edge exists because of how the feed actually behaves. An item whose source closed
 * before anyone published it is a RESOLUTION and nothing else, and without this edge the
 * operator would have to publish it as open first and resolve it a moment later, so the
 * board would flash an entry that was already finished and a cache would keep showing it
 * as open for five minutes. One move, one entry, and the entry is the true one.
 *
 * Everything else is deliberately identical to the corrections table, because the
 * meanings line up: `new` is a private draft, `accepted` is published as OPEN, `fixed` is
 * published as RESOLVED, `rejected` stays private, `duplicate` is what it always was.
 */
export const OPEN_TRANSITIONS = {
  new: ['triaged', 'accepted', 'fixed', 'rejected', 'spam', 'duplicate'],
  triaged: ['accepted', 'rejected', 'spam', 'duplicate'],
  accepted: ['fixed', 'rejected'],
  fixed: [],
  rejected: ['accepted'],
  spam: ['accepted'],
  duplicate: ['accepted'],
};

/**
 * Pure, and exported so a test can assert the whole table without a database.
 *
 * `kind` is optional and only ever narrows. AUTOMATION HAS NO EDGE AT ALL on an open
 * item: the corrections feed is stranger text where an AI closing junk is the judgement
 * it is good at, and this feed is the fleet's own trackers, where every move either
 * publishes a sentence or decides not to. There is no volume here for a machine to
 * absorb and nothing for it to be right about, so it gets nothing.
 */
export function canTransition(from, to, actor, kind = null) {
  if (kind === 'open' && actor === 'ai') return false;
  const table = actor === 'ai' ? AI_TRANSITIONS : kind === 'open' ? OPEN_TRANSITIONS : TRANSITIONS;
  const allowed = table[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

