// The public resolved log: the only Balise surface a stranger or a crawler sees.
//
// Settled decision 3, made concrete: the queue is private, the outcome is
// public. CONTRACTS.md C4 says the public log is one query, `status = 'fixed'
// AND public = 1`, and that `public_note` is written by an operator and never
// derived from `body`. So nothing a stranger typed is ever served from this
// domain. That rule lives in the Worker; this file only renders what it sends.
//
// C5: textContent everywhere, via elem() and setText(). No innerHTML.

import { fetchLog } from './api.js';
import { setText, show, hide, elem, formatDate } from './utils.js';

const el = {};
let cursor = null;
let loading = false;

/** One resolved report, as a DOM node. Built, never concatenated. */
function entryNode(entry) {
  const item = elem('li', 'log-entry');

  const head = elem('div', 'log-entry__head');
  head.append(elem('span', 'log-entry__site', entry.site || 'unknown'));
  const when = formatDate(entry.fixed_at);
  if (when) head.append(elem('time', 'log-entry__date', when));
  item.append(head);

  // The operator's note is the substance of the entry. It is the only prose
  // here, and an operator wrote it.
  item.append(elem('p', 'log-entry__note', entry.public_note || 'Fixed.'));

  if (entry.target_label) {
    const target = elem('p', 'log-entry__target');
    target.append(elem('span', 'log-entry__target-key', 'Item: '));
    target.append(elem('span', 'log-entry__target-value', entry.target_label));
    item.append(target);
  }

  // fixed_ref is a commit, a PR, or whatever the operator pasted. Render it as
  // a link only when it is one, so a hand-typed note cannot become an href.
  if (entry.fixed_ref) {
    let href = null;
    try {
      const u = new URL(entry.fixed_ref);
      if (u.protocol === 'https:' || u.protocol === 'http:') href = u.href;
    } catch { /* not a URL, show it as text */ }
    if (href) {
      const link = elem('a', 'log-entry__ref', entry.fixed_ref);
      link.href = href;
      link.rel = 'noopener noreferrer';
      item.append(link);
    } else {
      item.append(elem('code', 'log-entry__ref', entry.fixed_ref));
    }
  }

  return item;
}

async function load({ append = false } = {}) {
  if (loading) return;
  loading = true;
  hide(el.error);
  if (!append) show(el.loading);

  const result = await fetchLog(cursor ? { before: cursor } : {});
  loading = false;
  hide(el.loading);

  if (!result.ok) {
    setText(el.errorMessage, result.message || 'The log could not be loaded.');
    setText(el.errorHint, result.hint || '');
    show(el.error);
    hide(el.more);
    return;
  }

  const entries = Array.isArray(result.entries) ? result.entries : [];
  if (!append) el.list.replaceChildren();
  entries.forEach((entry) => el.list.append(entryNode(entry)));

  cursor = result.next || null;
  if (cursor) show(el.more); else hide(el.more);

  const total = el.list.children.length;
  if (total === 0) {
    show(el.empty);
    hide(el.list);
  } else {
    hide(el.empty);
    show(el.list);
  }
}

export function initLog() {
  ['list', 'empty', 'loading', 'error', 'errorMessage', 'errorHint', 'more']
    .forEach((id) => { el[id] = document.getElementById(id); });

  el.more.addEventListener('click', () => load({ append: true }));
  load();
}
