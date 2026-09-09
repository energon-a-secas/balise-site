// The open-item card. The second feed's half of the desk.
//
// A correction arrives as a stranger's sentence and the operator decides whether
// it is true. An open item arrives from the fleet's own trackers, where every
// line names a file, a line number, an id or a credential, so the operator is
// not deciding whether it is true. They are deciding what a reader outside the
// fleet is allowed to know about it, and then writing that sentence themselves.
// That is why the card is mostly one textarea: the sentence IS the entry.
//
// Two rules carry over from desk.js unchanged, because the source text on this
// card is no safer than a stranger's: C5 says every value is rendered with
// textContent, through elem() and setText(), and there is no innerHTML here.
// C3 says the token stays in desk.js's module scope; this file never sees it.

import { redactionFindings } from './redact.js';
import { setText, elem, formatDate } from './utils.js';

/** DESIGN-OPEN-ITEMS.md section 4. Anything else is shown as "source". */
const SOURCES = ['queue', 'brief', 'harness', 'registry'];

/**
 * What a C4 status MEANS on this kind. The vocabulary is shared with
 * corrections, and it has to be: reusing the status column is what let this
 * feed reuse the transition guard, the paging and the token gate. But `fixed`
 * on a correction means a defect was repaired, and `fixed` on an open item
 * means the fleet closed the thing and the board now leads with it, so the
 * badge says the second thing rather than making the operator translate.
 */
const BADGE = {
  new: 'draft, private',
  triaged: 'draft, private',
  accepted: 'published as open',
  fixed: 'published as resolved',
  rejected: 'kept private',
  spam: 'kept private',
  duplicate: 'duplicate',
};

/**
 * C4's table as it applies to this kind, plus amendment A7's one added edge,
 * `new -> fixed`: an item whose source closed before it was ever published
 * becomes a resolution in one move instead of appearing as open for a cache
 * period and then flipping.
 *
 * `spam` and `triaged` are legal on this kind and are deliberately not offered.
 * An imported item is not junk mail, so the private answer for one that should
 * never be public is `rejected`; and `triaged` is the AI's edge, which the
 * corrections desk does not offer either.
 *
 * `rejected` offers ONE move, and this is the one place the design reads two
 * ways: section 5 says a rejected card keeps both publish moves so a sentence
 * can be reconsidered, section 2 adds only `new -> fixed`. Checked against the
 * Worker rather than guessed: OPEN_TRANSITIONS in worker/src/transitions.js has
 * `rejected: ['accepted']`, so a second button here would be one that cannot
 * work. Reconsidering a rejected item is Publish as open, then Publish as
 * resolved, and the sentence survives both because it is stored on the row.
 */
const NEXT = {
  new: ['accepted', 'fixed', 'rejected', 'duplicate'],
  triaged: ['accepted', 'rejected', 'duplicate'],
  accepted: ['fixed', 'rejected'],
  fixed: [],
  rejected: ['accepted'],
  spam: ['accepted'],
  duplicate: ['accepted'],
};

const LABEL = {
  accepted: 'Publish as open',
  fixed: 'Publish as resolved',
  rejected: 'Keep private',
  duplicate: 'Duplicate of',
};

/** The two moves that put the sentence on the board, so the two the check gates. */
const PUBLISHES = new Set(['accepted', 'fixed']);

/**
 * The client half of the redaction check (section 3). It refuses nothing on its
 * own: the Worker refuses, every time, on a copy of these rules that this page
 * cannot reach. What this buys is that the operator sees WHY before they press
 * anything, instead of writing a sentence, publishing it, and reading a rejection.
 */
function verdictFor(text) {
  const trimmed = text.trim();
  // Three states, not two. An empty field is not a breach, it is a sentence
  // nobody has written yet, and colouring it like a refusal teaches the operator
  // that the red line under the box means nothing.
  if (!trimmed) {
    return { clear: false, state: 'empty', text: 'Write one sentence for the board.' };
  }
  const findings = redactionFindings(trimmed);
  if (!findings.length) {
    return { clear: true, state: 'clear', text: 'Clear to publish' };
  }
  const first = findings[0];
  const more = findings.length > 1 ? ` (and ${findings.length - 1} more)` : '';
  return { clear: false, state: 'blocked', text: `Contains a ${first.rule}: ${first.match}${more}` };
}

/** The head row: what it is, where it came from, and when it opened. */
function headNode(report, status) {
  const head = elem('div', 'desk-card__head');
  head.append(elem('span', `desk-badge desk-badge--${status}`, BADGE[status] || BADGE.new));

  const source = SOURCES.includes(report.source) ? report.source : 'source';
  head.append(elem('span', 'desk-card__source', source));

  // Private, and it stays private: no public query selects this column. It is
  // here because it is the only way the operator can find the item again in the
  // tracker it came from.
  if (report.source_ref) {
    head.append(elem('code', 'desk-card__ref', report.source_ref));
  }

  const opened = formatDate(report.opened_at || report.created_at);
  if (opened) head.append(elem('time', 'desk-card__date', opened));

  return head;
}

/**
 * One open item, as DOM. `move(report, status, extra)` is desk.js's, so the
 * token, the error box and the reload stay in one place.
 */
export function openReportNode(report, status, move) {
  const item = elem('li', 'desk-card desk-card--open');
  item.dataset.status = status;
  item.append(headNode(report, status));

  // The source said this is over. Said loudly, because it is the cue to publish
  // a resolution, and a resolution is the entry the board leads with.
  if (report.source_closed_at) {
    const closed = elem('p', 'desk-open__closed');
    closed.append(elem('span', 'desk-card__key', 'Source closed '));
    closed.append(elem('time', 'desk-card__value', formatDate(report.source_closed_at)));
    item.append(closed);
  }

  // Collapsed, and collapsed on purpose. This is the tracker's own words: file
  // paths, line numbers, ids, sometimes a map of what is currently weak. It is
  // evidence for writing the sentence, never the sentence.
  if (report.body) {
    const details = elem('details', 'desk-open__source');
    details.append(elem('summary', 'desk-open__summary', 'Source text'));
    details.append(elem('blockquote', 'desk-card__body', report.body));
    item.append(details);
  }

  const field = elem('label', 'desk-open__field');
  field.append(elem('span', 'desk-open__label', 'The public sentence'));
  const note = document.createElement('textarea');
  note.className = 'desk-open__note';
  note.rows = 3;
  note.spellcheck = true;
  // `suggested` is the importer's draft with every match already stripped. It is
  // a starting point and nothing more: it is checked again on every keystroke
  // below, and again by the Worker, because the importer is not a person.
  note.value = report.public_note || report.suggested || '';
  field.append(note);
  item.append(field);

  const line = elem('p', 'desk-open__verdict');
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  item.append(line);

  const actions = elem('div', 'desk-card__actions');
  const publishButtons = [];

  (NEXT[status] || []).forEach((next) => {
    const button = elem('button', 'btn btn--ghost btn--sm', LABEL[next] || next);
    button.type = 'button';
    if (PUBLISHES.has(next)) {
      publishButtons.push(button);
      button.addEventListener('click', () => move(report, next, { public_note: note.value.trim() }));
    } else {
      // `duplicate` still asks for an id the way the corrections desk does.
      // Section 5's "no window.prompt here" is about the SENTENCE, which is the
      // whole entry and is edited in place above; an id is not the entry, and
      // section 9 leaves the corrections prompt alone.
      button.addEventListener('click', () => move(report, next));
    }
    actions.append(button);
  });

  if (!actions.children.length) {
    actions.append(elem('span', 'muted', 'Terminal. Nothing further to do.'));
  }
  item.append(actions);

  const refresh = () => {
    const result = verdictFor(note.value);
    setText(line, result.text);
    line.classList.toggle('is-clear', result.state === 'clear');
    line.classList.toggle('is-empty', result.state === 'empty');
    line.classList.toggle('is-blocked', result.state === 'blocked');
    publishButtons.forEach((button) => { button.disabled = !result.clear; });
  };
  note.addEventListener('input', refresh);
  refresh();

  return item;
}
