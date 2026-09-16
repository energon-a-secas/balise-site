// The operator desk. The private half of Balise.
//
// This is the page CONTRACTS.md C5 was written for: it is the only page in the
// fleet that renders text typed by strangers AND holds the operator credential.
// Those two facts on one page are the whole risk. Two rules follow, and neither
// is optional:
//
//   1. Every value from a report is rendered with textContent (C5). There is no
//      innerHTML in this file. `elem()` exists so building DOM is easier than
//      concatenating HTML, because a rule with no convenient alternative gets
//      broken eventually.
//   2. The token lives in a module-scoped variable and nowhere else (C3, A1).
//      Not localStorage, not sessionStorage, not a cookie, not the URL. Closing
//      the tab ends the session. The architect argued this against the original
//      brief and was right: it removes a moving part rather than adding one.
//
// Three views share this page: corrections, open items, and the work queue
// (docs/DESIGN-WORK-QUEUE.md). The work view's cards and the "hand to an agent"
// panel live in desk-work.js and reach the Worker only through the callbacks
// below, so rule 2 still has exactly one home.

import {
  fetchQueue, patchReport, fetchWork, submitWorkItem, approveWork, withdrawWork, reviewWork,
} from './api.js';
import { openReportNode } from './desk-open.js';
import {
  workCardNode, agentPanelNode, newItemNode, actionButton, movesWhileWorked, heldNode, forgetSentences,
} from './desk-work.js';
import { setText, show, hide, elem, formatDate, announce } from './utils.js';

/** C4's vocabulary. A status off this list is rendered as `new`, never raw. */
const STATUSES = ['new', 'triaged', 'accepted', 'fixed', 'rejected', 'spam', 'duplicate'];

/** C4's transition table, mirrored so the desk offers only legal moves. The
 *  Worker enforces it regardless and answers BAD_TRANSITION; this copy exists
 *  so the operator is not offered a button that cannot work. */
const NEXT = {
  new: ['accepted', 'rejected', 'spam', 'duplicate'],
  triaged: ['accepted', 'rejected', 'spam', 'duplicate'],
  accepted: ['fixed', 'rejected'],
  fixed: [],
  rejected: ['accepted'],
  spam: ['accepted'],
  duplicate: ['accepted'],
};

/** The work filters desk.html offers, and the states `active` lists (worker/src/work.js). */
const WORK_FILTERS = ['active', 'review', 'approved', 'claimed', 'accepted', 'done'];
const ACTIVE = ['approved', 'claimed', 'review', 'accepted'];

/** What a status move did, in the words each feed uses for it, for the status line. */
const MOVED = { accepted: 'Accepted.', fixed: 'Marked fixed.', rejected: 'Rejected.', spam: 'Marked as spam.', duplicate: 'Marked as a duplicate.' };
const PUBLISHED = { accepted: 'Published as open.', fixed: 'Published as resolved.', rejected: 'Kept private.', duplicate: 'Marked as a duplicate.' };

// C3/A1: in memory, for this tab, and that is the entire lifetime.
let token = '';
let filter = 'new';
// Which view the desk is showing: '' is the corrections queue as it has always
// been, 'open' is the imported open items, 'work' is the work queue. The first two
// ride as `?kind=` on the list call; the third is its own route.
let kind = '';
let workFilter = 'active';
let cursor = null;
// Every list request takes the next number and only the newest may draw its answer: a slow
// answer for a view the operator already left would otherwise empty the one on screen.
let loadSeq = 0;
// Where in the list the card whose button started a move sat, so focus can return there.
let actedAt = -1;
// A two-call move whose second call found the token rejected, told over the first list drawn after
// signing in again. In memory only, like the token, and Sign out forgets it.
let untold = null;

const el = {};

function safeStatus(value) {
  return STATUSES.includes(value) ? value : 'new';
}

/** Ask for the note and reference a `fixed` transition needs (C4). */
function promptForFix() {
  const note = window.prompt(
    'Public note. This is what visitors see on the log, so write it yourself.\n'
    + 'It is never derived from the reporter\'s text.'
  );
  if (note === null) return null;
  const trimmed = note.trim();
  if (!trimmed) {
    window.alert('A fixed report needs a public note, since that is the whole entry.');
    return null;
  }
  const ref = window.prompt('Reference (commit, PR, or URL). Optional.') || '';
  return { public_note: trimmed, fixed_ref: ref.trim() };
}

/**
 * The one place a refusal from the Worker reaches the page. A rejected token sends
 * the desk back to the gate rather than leaving a desk that looks logged in and
 * does nothing, whichever call it was that found out.
 */
function showError(result, fallback = 'That change did not go through.') {
  setText(el.status, '');
  setText(el.errorMessage, result.message || fallback);
  setText(el.errorHint, result.hint || '');
  show(el.error);
  if (result.code === 'UNAUTHORIZED') {
    token = '';
    loadSeq += 1; // a list still in flight from the refused session draws nothing, as on Sign out
    show(el.gate);
    hide(el.queue);
  }
  return false;
}

/** After a move rebuilds the list, focus returns to the card now in the same place, or to
 *  the empty line, instead of falling to the page body. A refused second call names its item
 *  instead: focus goes to that card while it is on screen, and otherwise to the error. */
function refocus(id = null) {
  const at = actedAt;
  actedAt = -1;
  if ((at < 0 && !id) || (document.activeElement && document.activeElement !== document.body)) return false;
  const cards = [...el.list.children];
  if (id) announce(cards.find((node) => node.dataset.id === id) || el.error);
  else announce(cards.length ? cards[Math.min(at, cards.length - 1)] : el.empty);
  return false;
}

/** A refusal's own hint, after a sentence saying the first of two calls went through. api.js's
 *  NETWORK hint says nothing was sent, which is true of one call and not of the pair. */
const hintAfter = (result) => (result.hint && result.code !== 'NETWORK' ? ` ${result.hint}` : '');

/** A move went through: reload the list it changed, then say what happened. */
async function settle(said) {
  await load();
  setText(el.status, said);
  refocus();
  return true;
}

/** One change, then a reload of the list it changed. Answers whether it went through.
 *  `said` is the status line's sentence, or a function of the Worker's answer. */
async function act(pending, said, fallback) {
  const result = await pending;
  if (!result.ok) return showError(result, fallback);
  return settle(typeof said === 'function' ? said(result) : said);
}

/**
 * One status change, for either report feed.
 *
 * `patch` is how an open item differs: its public sentence is typed into the
 * card rather than asked for after the fact, so desk-open.js hands the sentence
 * in and the prompts below are skipped. Pass nothing and this is the corrections
 * flow, unchanged.
 */
async function move(report, status, patch = null) {
  let extra = patch;
  if (extra === null) {
    extra = {};
    if (status === 'fixed') {
      const answers = promptForFix();
      if (!answers) return false;
      extra = answers;
    }
    if (status === 'duplicate') {
      const of = window.prompt('Duplicate of which report id?');
      if (of === null) return false;
      extra = { duplicate_of: of.trim() };
    }
  }
  const said = (report.kind === 'open' ? PUBLISHED : MOVED)[status] || 'Saved.';
  return act(patchReport(report.id, { status, ...extra }, token), said);
}

const REVIEWED = {
  accept: (result) => (result.item && result.item.work && result.item.work.state === 'accepted'
    ? 'Accepted. The runner lands it on its next run.'
    : 'Accepted. It is under Done.'),
  return: 'Sent back with your note. It waits for the next attempt.',
  dismiss: 'Dismissed. It is out of the work queue.',
};

/** Press one button of a filter group, in the class and in the state a screen reader reads. */
function pressOnly(group, isOn) {
  group.querySelectorAll('button').forEach((b) => {
    const on = isOn(b);
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/** Choose a work filter without loading, so a caller can switch the view in the same move. */
function selectWorkFilter(next) {
  workFilter = WORK_FILTERS.includes(next) ? next : 'active';
  cursor = null;
  pressOnly(el.workFilters, (b) => b.dataset.workFilter === workFilter);
}

/**
 * The work queue's moves, handed to desk-work.js and desk-open.js as callbacks so the
 * token never leaves this module. Every one is a person starting, judging or stopping
 * work; the runner's moves are not in the site at all.
 */
const work = {
  approve: (report, choice) => act(approveWork(report.id, choice, token), 'Handed to an agent. It waits under Work until a runner takes it.'),
  edit: (item, choice) => act(approveWork(item.id, choice, token), 'Saved. It keeps its place in the queue and its attempt count.'),
  withdraw: (item) => act(withdrawWork(item.id, token), 'Withdrawn from the work queue.'),
  review: (item, decision, note) => act(reviewWork(item.id, { decision, note }, token), REVIEWED[decision]),
  reopen: (item) => act(approveWork(item.id, { mode: item.work.mode, instruction: item.work.instruction }, token), 'Reopened. It waits for a runner with a fresh count.'),
  // At the attempt cap an edit keeps the count, so trying again is a withdrawal and a fresh
  // approval. Two calls: when the second fails the item is already out of the queue, so the
  // list is reloaded and the operator is told where to hand it over again. A rejected token
  // sends the desk to the gate instead, so that is told once the operator is back in.
  retry: async (item, choice) => {
    const out = await withdrawWork(item.id, token);
    if (!out.ok) return showError(out);
    const again = await approveWork(item.id, choice, token);
    if (again.ok) return settle('Handed over again, with a fresh count of attempts.');
    const where = `is out of the work queue now: hand it to an agent from its card under ${item.kind === 'open' ? 'Open items' : 'Corrections'}.`;
    if (again.code === 'UNAUTHORIZED') {
      untold = { message: 'Withdrawn, but not handed over again: the operator token was refused between the two calls.', hint: `${item.title ? `"${item.title}"` : 'It'} ${where}` };
      return showError(again);
    }
    await load();
    showError({ ...again, message: `Withdrawn, but not handed over again. ${again.message || ''}`.trim(), hint: `It ${where}${hintAfter(again)}` });
    return refocus(item.id);
  },
  // Accept, then publish: two calls, each guarded by the Worker. A refused sentence after the
  // accept went through leaves the item under Done, not under the filter that showed it, so
  // the desk follows it there, where the card still holds the operator's sentence.
  publishResolved: async (item, sentence) => {
    let moved = '';
    if (item.work && item.work.state === 'review') {
      const accepted = await reviewWork(item.id, { decision: 'accept' }, token);
      if (!accepted.ok) return showError(accepted);
      moved = accepted.item && accepted.item.work ? accepted.item.work.state : 'done';
    }
    const published = await patchReport(item.id, { status: 'fixed', public_note: sentence }, token);
    if (published.ok) return settle(moved ? 'Accepted, and published as resolved.' : 'Published as resolved.');
    const half = 'The result was accepted, but the sentence was not published.';
    const there = moved === 'done' ? 'is under Done now, and its card there keeps your sentence.' : '';
    if (moved) selectWorkFilter(moved);
    if (published.code === 'UNAUTHORIZED') {
      if (moved) untold = { message: `${half} The operator token was refused between the two calls.`, hint: there && `${item.title ? `"${item.title}"` : 'It'} ${there}` };
      return showError(published);
    }
    await load();
    if (!moved) showError(published);
    else showError({ ...published, message: `${half} ${published.message || ''}`.trim(), hint: there ? `It ${there}${hintAfter(published)}` : published.hint || '' });
    return refocus(item.id);
  },
  file: (payload) => {
    actedAt = -1;
    return act(submitWorkItem(payload, token), payload.approve ? 'Filed and handed to an agent.' : 'Filed as a private draft.');
  },
  // To the item, not only to the view: the filter that lists its state, then its card.
  openWork: async (report) => {
    const state = report.work ? report.work.state : '';
    if (!(workFilter === state || (workFilter === 'active' && ACTIVE.includes(state)))) selectWorkFilter(state);
    await selectKind('work');
    const card = [...el.list.children].find((node) => node.dataset.id === report.id);
    if (card) announce(card);
  },
};

/** One report as DOM. Everything below is a stranger's text. */
function reportNode(report) {
  const item = elem('li', 'desk-card');
  const status = safeStatus(report.status);
  item.dataset.status = status;

  const head = elem('div', 'desk-card__head');
  head.append(elem('span', `desk-badge desk-badge--${status}`, status));
  head.append(elem('span', 'desk-card__site', report.site || 'unknown'));
  head.append(elem('span', 'desk-card__kind', report.kind || 'other'));
  const when = formatDate(report.created_at);
  if (when) head.append(elem('time', 'desk-card__date', when));
  item.append(head);

  // The Worker nests the target (worker/src/store.js toReport), so the label is
  // report.target.label. Reading report.target_label here meant this row never
  // rendered, and the one thing a report points AT was missing from the card.
  const targetLabel = report.target && report.target.label;
  if (targetLabel) {
    const t = elem('p', 'desk-card__target');
    t.append(elem('span', 'desk-card__key', 'Item: '));
    t.append(elem('span', 'desk-card__value', targetLabel));
    item.append(t);
  }

  // The reporter's own words. Rendered as text, never as markup.
  item.append(elem('blockquote', 'desk-card__body', report.body || ''));

  if (report.url) {
    let href = null;
    try {
      const u = new URL(report.url);
      if (u.protocol === 'https:' || u.protocol === 'http:') href = u.href;
    } catch { /* leave it as text */ }
    if (href) {
      const link = elem('a', 'desk-card__url', report.url);
      link.href = href;
      link.rel = 'noopener noreferrer nofollow';
      link.target = '_blank';
      item.append(link);
    } else {
      item.append(elem('code', 'desk-card__url', report.url));
    }
  }

  if (report.contact) {
    const c = elem('p', 'desk-card__contact');
    c.append(elem('span', 'desk-card__key', 'Contact: '));
    c.append(elem('span', 'desk-card__value', report.contact));
    item.append(c);
  }

  // The AI's verdict, when the triage job has written one. The Worker nests it
  // under `ai` and returns null until the job has run (worker/src/store.js:439).
  // It is evidence for the operator to read, never an instruction: settled
  // decision 4 puts the human on every edge except new -> triaged.
  if (report.ai && typeof report.ai === 'object') {
    const ai = elem('div', 'desk-card__ai');
    ai.append(elem('span', 'desk-card__key', 'Triage: '));
    ai.append(elem('span', 'desk-card__value', report.ai.verdict || 'no verdict'));
    if (report.ai.notes) {
      ai.append(elem('p', 'desk-card__ai-notes', report.ai.notes));
    }
    if (typeof report.ai.confidence === 'number') {
      ai.append(elem('span', 'desk-card__ai-confidence', ` (confidence ${report.ai.confidence})`));
    }
    item.append(ai);
  }

  // While an agent has the report, the moves that close it wait (C-i): a correction marked
  // fixed before its fix lands is on the public log with nothing under it.
  const actions = elem('div', 'desk-card__actions');
  const offered = movesWhileWorked(report, NEXT[status] || []);
  offered.moves.forEach((next) => {
    actions.append(actionButton(next, 'btn btn--ghost btn--sm', () => move(report, next)));
  });
  if (offered.held) {
    actions.append(heldNode());
  } else if (!actions.children.length) {
    actions.append(elem('span', 'muted', 'Terminal. Nothing further to do.'));
  }
  item.append(actions);
  item.append(agentPanelNode(report, work));

  return item;
}

/** The count on each work filter, from the one aggregate the list call returns. */
function renderCounts(counts) {
  const active = ACTIVE.reduce((sum, s) => sum + (counts[s] || 0), 0);
  el.workFilters.querySelectorAll('[data-count]').forEach((node) => {
    const key = node.dataset.count;
    setText(node, String(key === 'active' ? active : counts[key] || 0));
  });
}

async function load({ append = false } = {}) {
  const seq = (loadSeq += 1);
  const view = kind;
  hide(el.error);
  show(el.loading);
  if (!append) {
    hide(el.more);
    setText(el.status, '');
  }
  const before = append && cursor ? cursor : null;
  const result = view === 'work'
    ? await fetchWork({ state: workFilter, before }, token)
    : await fetchQueue({ status: filter === 'all' ? null : filter, kind: view || null, before }, token);
  if (seq !== loadSeq) return;
  hide(el.loading);

  if (!result.ok) {
    showError(result, 'The queue could not be read.');
    return;
  }

  if (!append) el.list.replaceChildren();

  if (view === 'work') {
    (Array.isArray(result.items) ? result.items : []).forEach((item) => el.list.append(workCardNode(item, work)));
    renderCounts(result.counts || {});
  } else {
    // Two guards, and the second is the one that matters. The tab decides which
    // feed this is, so a row of the other kind is dropped rather than shown under
    // a heading that misdescribes it: an unfiltered list route still answers with
    // both, and a private import draft must not turn up in a list labelled
    // Corrections. If the Worker later excludes them, this becomes a no-op.
    // Then each row is drawn by ITS OWN kind, so a stray open item could never be
    // rendered by the corrections card and read as a stranger's report.
    const reports = Array.isArray(result.reports) ? result.reports : [];
    reports
      .filter((r) => (view === 'open' ? r.kind === 'open' : r.kind !== 'open'))
      .forEach((r) => {
        el.list.append(r.kind === 'open' ? openReportNode(r, safeStatus(r.status), move, work) : reportNode(r));
      });
  }

  // Opaque: GET /work's is "<updated_at>:<id>", and either route takes it back as it came.
  cursor = result.next || null;
  if (cursor) show(el.more); else hide(el.more);
  setText(el.count, `${el.list.children.length} shown`);

  if (!el.list.children.length) show(el.empty); else hide(el.empty);

  // Only a list drawn with a token the Worker took gets here, so the operator is back in.
  if (!untold) return;
  showError(untold);
  untold = null;
  if (!document.activeElement || document.activeElement === document.body) announce(el.error);
}

async function signIn(event) {
  event.preventDefault();
  const value = el.tokenInput.value.trim();
  if (!value) return;
  token = value;
  // Clear the field immediately: the token is in memory now, and a populated
  // password field survives a bfcache restore.
  el.tokenInput.value = '';
  hide(el.gate);
  show(el.queue);
  await load();
}

/**
 * Switch views. The status filters keep their vocabulary across the two report
 * feeds, since it is one column in one table. The work view has its own filters,
 * because work state is a second axis and C4's words over it would misdescribe
 * every card.
 */
function selectKind(next) {
  kind = next;
  cursor = null;
  pressOnly(el.kinds, (b) => (b.dataset.kind || '') === kind);
  const onWork = kind === 'work';
  [el.workFilters, el.workHint, el.workNew].forEach((node) => (onWork ? show(node) : hide(node)));
  if (onWork) hide(el.filters); else show(el.filters);
  if (kind === 'open') show(el.kindHint); else hide(el.kindHint);
  return load();
}

export function initDesk() {
  [
    'gate', 'tokenForm', 'tokenInput', 'queue', 'list', 'empty', 'loading',
    'error', 'errorMessage', 'errorHint', 'more', 'count', 'filters', 'signOut',
    'kinds', 'kindHint', 'workFilters', 'workHint', 'workNew', 'status',
  ].forEach((id) => { el[id] = document.getElementById(id); });

  el.tokenForm.addEventListener('submit', signIn);
  el.more.addEventListener('click', () => load({ append: true }));
  el.workNew.append(newItemNode(work));

  // Capture phase, so the card's place is known before its button's own handler starts a move.
  el.list.addEventListener('click', (event) => {
    if (!event.target.closest('button')) return;
    actedAt = [...el.list.children].findIndex((card) => card.contains(event.target));
  }, true);

  el.kinds.addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind]');
    if (!button) return;
    selectKind(button.dataset.kind || '');
  });

  el.filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    cursor = null;
    pressOnly(el.filters, (b) => b === button);
    load();
  });

  el.workFilters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-work-filter]');
    if (!button) return;
    selectWorkFilter(button.dataset.workFilter);
    load();
  });

  el.signOut.addEventListener('click', () => {
    token = '';
    cursor = null;
    // An answer still in flight belongs to the session that just ended.
    loadSeq += 1;
    forgetSentences();
    untold = null;
    setText(el.status, '');
    el.list.replaceChildren();
    hide(el.queue);
    show(el.gate);
  });
}
