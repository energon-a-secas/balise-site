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

import { fetchQueue, patchReport } from './api.js';
import { setText, show, hide, elem, formatDate } from './utils.js';

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

// C3/A1: in memory, for this tab, and that is the entire lifetime.
let token = '';
let filter = 'new';
let cursor = null;

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

async function move(report, status) {
  let extra = {};
  if (status === 'fixed') {
    const answers = promptForFix();
    if (!answers) return;
    extra = answers;
  }
  if (status === 'duplicate') {
    const of = window.prompt('Duplicate of which report id?');
    if (of === null) return;
    extra = { duplicate_of: of.trim() };
  }

  const result = await patchReport(report.id, { status, ...extra }, token);
  if (!result.ok) {
    setText(el.errorMessage, result.message || 'That change did not go through.');
    setText(el.errorHint, result.hint || '');
    show(el.error);
    return;
  }
  hide(el.error);
  await load();
}

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

  if (report.target_label) {
    const t = elem('p', 'desk-card__target');
    t.append(elem('span', 'desk-card__key', 'Item: '));
    t.append(elem('span', 'desk-card__value', report.target_label));
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

  const actions = elem('div', 'desk-card__actions');
  (NEXT[status] || []).forEach((next) => {
    const button = elem('button', 'btn btn--ghost btn--sm', next);
    button.type = 'button';
    button.addEventListener('click', () => move(report, next));
    actions.append(button);
  });
  if (!actions.children.length) {
    actions.append(elem('span', 'muted', 'Terminal. Nothing further to do.'));
  }
  item.append(actions);

  return item;
}

async function load({ append = false } = {}) {
  hide(el.error);
  show(el.loading);
  const result = await fetchQueue(
    { status: filter === 'all' ? null : filter, ...(append && cursor ? { before: cursor } : {}) },
    token
  );
  hide(el.loading);

  if (!result.ok) {
    setText(el.errorMessage, result.message || 'The queue could not be read.');
    setText(el.errorHint, result.hint || '');
    show(el.error);
    // A rejected token sends us back to the gate rather than leaving a desk
    // that looks logged in and does nothing.
    if (result.code === 'UNAUTHORIZED') {
      token = '';
      show(el.gate);
      hide(el.queue);
    }
    return;
  }

  const reports = Array.isArray(result.reports) ? result.reports : [];
  if (!append) el.list.replaceChildren();
  reports.forEach((r) => el.list.append(reportNode(r)));

  cursor = result.next || null;
  if (cursor) show(el.more); else hide(el.more);
  setText(el.count, `${el.list.children.length} shown`);

  if (!el.list.children.length) show(el.empty); else hide(el.empty);
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

export function initDesk() {
  [
    'gate', 'tokenForm', 'tokenInput', 'queue', 'list', 'empty', 'loading',
    'error', 'errorMessage', 'errorHint', 'more', 'count', 'filters', 'signOut',
  ].forEach((id) => { el[id] = document.getElementById(id); });

  el.tokenForm.addEventListener('submit', signIn);
  el.more.addEventListener('click', () => load({ append: true }));

  el.filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    cursor = null;
    [...el.filters.querySelectorAll('[data-filter]')].forEach((b) => {
      b.classList.toggle('is-active', b === button);
    });
    load();
  });

  el.signOut.addEventListener('click', () => {
    token = '';
    cursor = null;
    el.list.replaceChildren();
    hide(el.queue);
    show(el.gate);
  });
}
