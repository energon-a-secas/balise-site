// The public open-items board, and the tabs that choose between it and the log.
//
// Two lists on one page answering two different questions. The log says what a
// reader reported and what got fixed because of it. The board says what the
// fleet is working on and what it has closed, which nobody reported and nobody
// outside would otherwise know. Keeping them apart is not tidiness: an entry
// under the wrong heading claims a stranger asked for it.
//
// Everything rendered here was typed by an operator. The Worker's /board query
// names no source text, no private ref and no site, so there is nothing on this
// surface to redact at render time. C5 still holds anyway: elem() and setText()
// only, no innerHTML.
//
// RESOLVED IS THE POINT. A board that only grows is a graveyard, so resolutions
// come first, the newest one is labelled and given the accent, and the open
// items sit under them. The ordering is the Worker's; this file does not sort.

import { fetchBoard, fetchBoardSummary } from './api.js';
import { setText, show, hide, elem, formatDate } from './utils.js';

const el = {};
const tabs = [];

let loading = false;
let loaded = false;

/**
 * The states an entry can be in, and the only words shown for them. `in_progress`
 * is an open entry an agent is working on (docs/DESIGN-WORK-QUEUE.md section 6),
 * which says the fleet is moving and nothing about who, how or where. A state this
 * file has never heard of falls back to its group's word, which is still true.
 */
const STATE_LABEL = { resolved: 'Resolved', in_progress: 'In progress', open: 'Open' };

/**
 * A board date is a DAY, sent as `YYYY-MM-DD`, and it is a day on purpose: a
 * timestamp would say when an operator was at their desk, which is nobody's
 * business and is not what the entry is about (worker/src/store-open.js
 * dayStamp). So it is not milliseconds and utils.formatDate cannot read it,
 * which would drop every date on this surface without erroring.
 *
 * Parsed through Date.UTC and rendered in UTC. Feeding "2026-09-09" to the Date
 * constructor gives UTC midnight, and formatting that in a timezone west of
 * Greenwich shows the 8th. A number is still accepted, so a route that sends a
 * millisecond value renders instead of vanishing.
 */
function dayLabel(value) {
  if (typeof value !== 'string') return formatDate(value);
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return '';
  const at = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  try {
    return new Date(at).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return value;
  }
}

/**
 * One entry: a state, a sentence, a date. Three fields is the whole contract,
 * so there is no branch here for a fourth.
 */
function entryNode(entry, fallbackState, latest) {
  const state = STATE_LABEL[entry.state] ? entry.state : fallbackState;
  const item = elem('li', `board-entry board-entry--${state}`);
  if (latest) {
    item.classList.add('board-entry--latest');
    // First in the DOM as well as first on screen: a screen reader should hear
    // what makes this entry different before it hears the entry.
    item.append(elem('span', 'board-entry__latest', 'Latest resolution'));
  }

  item.append(elem('span', 'board-entry__state', STATE_LABEL[state]));
  item.append(elem('p', 'board-entry__text', entry.text || ''));

  const when = dayLabel(entry.date);
  if (when) item.append(elem('time', 'board-entry__date', when));

  return item;
}

function render(result) {
  const resolved = Array.isArray(result.resolved) ? result.resolved : [];
  const open = Array.isArray(result.open) ? result.open : [];

  el.resolvedList.replaceChildren();
  el.openList.replaceChildren();
  resolved.forEach((entry, i) => el.resolvedList.append(entryNode(entry, 'resolved', i === 0)));
  open.forEach((entry) => el.openList.append(entryNode(entry, 'open', false)));

  el.resolvedGroup.hidden = resolved.length === 0;
  el.openGroup.hidden = open.length === 0;
  if (resolved.length + open.length === 0) show(el.empty); else hide(el.empty);
}

/**
 * The one line under the lede, from GET /board/summary. It is the same line other
 * sections of the fleet can show, so this page is its first reader and the place
 * a wrong count would be noticed. A failed summary hides the line and nothing else:
 * the board does not depend on it.
 */
function renderSummary(summary) {
  if (!summary || !summary.ok || (!summary.open && !summary.resolved)) {
    hide(el.summary);
    return;
  }
  const parts = [`${summary.open} open`];
  if (summary.in_progress) parts.push(`${summary.in_progress} in progress`);
  parts.push(`${summary.resolved} resolved in the last ${summary.window_days || 30} days`);
  setText(el.summary, `${parts.join(', ')}.`);
  show(el.summary);
}

/**
 * One fetch for the life of the page. The board is short by design and the
 * endpoint takes no cursor, so there is nothing to page and nothing to refresh
 * on a tab switch. A failed load leaves `loaded` false, so returning to the tab
 * tries again rather than showing a stale error forever.
 */
async function load() {
  if (loading || loaded) return;
  loading = true;
  hide(el.error);
  hide(el.summary);
  show(el.loading);

  // Asked for together, drawn apart. A request has no timeout, so waiting on both would let
  // a stalled count line hold back the board it only describes.
  const summary = fetchBoardSummary();
  const result = await fetchBoard();

  loading = false;
  hide(el.loading);

  if (!result.ok) {
    setText(el.errorMessage, result.message || 'The board could not be loaded.');
    setText(el.errorHint, result.hint || '');
    show(el.error);
    return;
  }

  loaded = true;
  render(result);
  summary.then(renderSummary);
}

/**
 * `#open` is the shareable half of this. Someone links the board, not the page
 * with a board on it, so the hash selects the tab on arrival and follows the
 * tab afterwards. replaceState rather than assigning location.hash, which would
 * jump the page to the panel and add a history entry per click.
 */
function syncHash(name) {
  if (typeof history === 'undefined' || !history.replaceState) return;
  const target = name === 'open' ? '#open' : location.pathname + location.search;
  history.replaceState(null, '', target);
}

function selectTab(name, { focus = false, hash = true } = {}) {
  const chosen = name === 'open' ? 'open' : 'log';

  tabs.forEach((button) => {
    const on = button.dataset.tab === chosen;
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-selected', String(on));
    // Roving tabindex: one stop for the whole tablist, arrows move within it.
    button.tabIndex = on ? 0 : -1;
    if (on && focus) button.focus();
  });

  el.panelLog.hidden = chosen !== 'log';
  el.panelBoard.hidden = chosen !== 'open';

  if (hash) syncHash(chosen);
  if (chosen === 'open') load();
}

function onKeydown(event) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const current = tabs.findIndex((b) => b.getAttribute('aria-selected') === 'true');
  let next = current;
  if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = tabs.length - 1;
  event.preventDefault();
  selectTab(tabs[next].dataset.tab, { focus: true });
}

export function initBoard() {
  // Every id on this surface is prefixed. The log owns the bare ones, and two
  // elements answering to getElementById('error') is a bug that surfaces only in
  // the failure path, which is the path nobody exercises by hand.
  const ids = {
    boardTabs: 'boardTabs',
    panelLog: 'panelLog',
    panelBoard: 'panelBoard',
    loading: 'boardLoading',
    error: 'boardError',
    errorMessage: 'boardErrorMessage',
    errorHint: 'boardErrorHint',
    empty: 'boardEmpty',
    summary: 'boardSummary',
    resolvedGroup: 'boardResolvedGroup',
    resolvedList: 'boardResolved',
    openGroup: 'boardOpenGroup',
    openList: 'boardOpen',
  };
  Object.entries(ids).forEach(([key, id]) => { el[key] = document.getElementById(id); });

  if (!el.boardTabs) return;

  // index.html hides the tablist until production serves GET /board. While it is hidden
  // the log is the whole page: nothing below is wired, and `#open` cannot open a panel
  // whose fetch would answer a reader with an API error. Deleting the attribute in the
  // markup restores every path here, with no change to this file.
  if (el.boardTabs.hidden) {
    el.panelBoard.hidden = true;
    el.panelLog.hidden = false;
    return;
  }

  tabs.push(...el.boardTabs.querySelectorAll('[data-tab]'));

  el.boardTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    selectTab(button.dataset.tab);
  });
  el.boardTabs.addEventListener('keydown', onKeydown);

  window.addEventListener('hashchange', () => {
    selectTab(location.hash === '#open' ? 'open' : 'log', { hash: false });
  });

  selectTab(location.hash === '#open' ? 'open' : 'log', { hash: false });
}
