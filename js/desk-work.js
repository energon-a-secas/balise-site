// The work queue's half of the desk: the card for an item an agent has, the panel that
// hands an item over, and the form that files a new one (docs/DESIGN-WORK-QUEUE.md
// section 7).
//
// The desk is the only place a person starts, judges or stops work, and every one of those
// moves goes through callbacks desk.js owns, so the token stays in desk.js's module scope
// (C3, A1) and this file never sees it. C5 holds as well: every value is rendered through
// elem() and setText(). A runner's summary is no more trusted than a stranger's report,
// because on a correction the runner read one.

import { redactionFindings } from './redact.js';
import { setText, elem, formatDate } from './utils.js';
import { runNode, noteLine, unlanded } from './desk-run.js';

const WORK_LABEL = {
  approved: 'Waiting',
  claimed: 'Running',
  review: 'Needs review',
  accepted: 'To land',
  done: 'Done',
};

/** The three modes, in the words the operator chooses between. Each one is how far the
 *  agent may go before a person looks, which is the whole decision an approval makes. */
const MODE = {
  investigate: { label: 'Investigate', hint: 'Read only. Reports whether it is still true and what it would take.' },
  fix: { label: 'Fix', hint: 'Commits on a branch. Lands only after you accept.' },
  ship: { label: 'Ship', hint: 'Lands as soon as its own checks pass. You review after.' },
};

/** Publishing a resolution is `fixed`, which an open item reaches only from `new` or
 *  `accepted` (OPEN_TRANSITIONS in worker/src/transitions.js). */
const RESOLVABLE = new Set(['new', 'accepted']);

/** The status moves the Worker refuses while an agent has the item, for either actor (C-i):
 *  closing it under a run would leave the runner working on, or landing, a closed item. */
const HOLDING = new Set(['approved', 'claimed', 'review', 'accepted']);
const CLOSING = new Set(['fixed', 'rejected', 'spam', 'duplicate']);

// The Worker's own minimums (worker/src/validate-work.js, src/work.js), mirrored so a button
// is not offered for a request the Worker will refuse. The Worker still decides.
const NOTE_MIN = 3;
const INSTRUCTION_MIN = 10;
const TEXT_MIN = 10;

let groupSeq = 0;

/** A sentence sent to publish, by item id, until it is published. A refused publish reloads
 *  the list, and the card it comes back on should hold the operator's words, not the draft. */
const kept = new Map();

export function forgetSentences() {
  kept.clear();
}

/**
 * The client half of the redaction check (DESIGN-OPEN-ITEMS.md section 3). It refuses
 * nothing on its own: the Worker refuses, every time, on a copy of these rules this page
 * cannot reach. What it buys is that the operator sees WHY before pressing anything.
 *
 * Three states, not two. An empty field is not a breach, it is a sentence nobody has
 * written yet, and colouring it like a refusal teaches the operator that the red line
 * under the box means nothing.
 */
export function verdictFor(text) {
  const trimmed = text.trim();
  if (!trimmed) return { clear: false, state: 'empty', text: 'Write one sentence for the board.' };
  const findings = redactionFindings(trimmed);
  if (!findings.length) return { clear: true, state: 'clear', text: 'Clear to publish' };
  const first = findings[0];
  const more = findings.length > 1 ? ` (and ${findings.length - 1} more)` : '';
  return { clear: false, state: 'blocked', text: `Contains a ${first.rule}: ${first.match}${more}` };
}

function button(label, className, onClick) {
  const node = elem('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/**
 * A button that sends a request. Its card takes nothing else until the request settles: a
 * second click would send the move twice, and the refusal of the repeat would be left on
 * screen above a list where the first one went through.
 */
export function actionButton(label, className, onClick) {
  const node = button(label, className, async () => {
    const scope = node.closest('.desk-card') || node;
    if (scope.getAttribute('aria-busy') === 'true') return;
    const focused = document.activeElement === node;
    const controls = [...new Set([node, ...scope.querySelectorAll('button, input, textarea')])].filter((n) => !n.disabled);
    scope.setAttribute('aria-busy', 'true');
    controls.forEach((n) => { n.disabled = true; });
    try {
      await onClick();
    } finally {
      // A move that went through rebuilt the list, so only a card still on the page is freed.
      if (scope.isConnected) {
        scope.removeAttribute('aria-busy');
        controls.forEach((n) => { n.disabled = false; });
        if (focused && (!document.activeElement || document.activeElement === document.body)) node.focus();
      }
    }
  });
  return node;
}

/** The status moves a card may offer, given its work state, and whether any were held back. */
export function movesWhileWorked(report, moves) {
  if (!report.work || !HOLDING.has(report.work.state)) return { moves, held: false };
  const left = moves.filter((move) => !CLOSING.has(move));
  return { moves: left, held: left.length < moves.length };
}

/** Said where the held moves would have been, so their absence reads as a rule. */
export function heldNode() {
  return elem('span', 'desk-card__held muted', 'Resolving or closing it waits while it is in the work queue: withdraw it in Work first, or let the result finish.');
}

/** Said where Approve, Reopen or Hand over again would have been. The Worker refuses approve on a
 *  closed item (CLOSING above), and all three are approvals, so none is offered on one. */
function closedNode(record) {
  return elem('p', 'desk-work__note muted', record.status === 'fixed'
    ? 'Resolved, so no agent takes it again: file follow-up work as a new item.'
    : 'Closed, so no agent takes it: reopen it first.');
}

function textarea(rows) {
  const node = document.createElement('textarea');
  node.className = 'desk-open__note';
  node.rows = rows;
  node.spellcheck = true;
  return node;
}

function labelled(label, control) {
  const field = elem('label', 'desk-open__field');
  field.append(elem('span', 'desk-open__label', label), control);
  return field;
}

/** Whose text the item is (C-h). A correction is a reader's, and so, possibly, is anything
 *  automation filed, because the run that filed it may have been reading a correction. */
function isStranger(record) {
  return record.kind !== 'open' || record.filed_by === 'ai' || record.trust === 'stranger';
}

const STRANGER_NOTE = {
  correction: 'Write the instruction yourself. The reader\'s words reach the agent as quoted data, never as the instruction. Ship is not offered: a change a reader\'s text influenced lands only after you have read it.',
  filed: 'Write the instruction yourself. An agent filed this item, perhaps from a reader\'s words, so its text reaches the agent as quoted data, never as the instruction. Ship is not offered: a change that text influenced lands only after you have read it.',
};

/** The mode choice, with the chosen mode's consequence spelled out under it and announced
 *  when it changes. `sync` re-reads the checked radio, for a form reset, which fires no change. */
function modeField(selected, { allowShip }) {
  const initial = MODE[selected] && (allowShip || selected !== 'ship') ? selected : 'fix';
  const set = elem('fieldset', 'desk-work__modes');
  set.append(elem('legend', 'desk-work__legend', 'How far the agent may go'));
  const name = `work-mode-${(groupSeq += 1)}`;
  const hint = elem('p', 'desk-work__mode-hint muted');
  hint.id = `${name}-hint`;
  hint.setAttribute('aria-live', 'polite');
  set.setAttribute('aria-describedby', hint.id);
  const value = () => (set.querySelector('input:checked') || { value: initial }).value;
  const sync = () => setText(hint, MODE[value()].hint);
  Object.keys(MODE).filter((mode) => allowShip || mode !== 'ship').forEach((mode) => {
    const option = elem('label', 'desk-work__mode');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = mode;
    input.checked = mode === initial;
    input.defaultChecked = mode === initial;
    input.addEventListener('change', sync);
    option.append(input, elem('span', null, MODE[mode].label));
    set.append(option);
  });
  set.append(hint);
  sync();
  return { node: set, value, sync };
}

/** Mode, instruction and one button. Handing an item over and changing a waiting one are the
 *  same decision, so both follow the rules the Worker's approvalRule applies. */
function approvalPanel(record, { summary, mode, instruction, label, onSend }) {
  const stranger = isStranger(record);
  const panel = elem('details', 'desk-work');
  panel.append(elem('summary', 'desk-open__summary', summary));
  const modes = modeField(mode, { allowShip: !stranger });
  const text = textarea(3);
  text.value = instruction || '';
  panel.append(modes.node, labelled(stranger ? 'Instruction for the agent (required)' : 'Instruction for the agent (optional)', text));
  if (stranger) panel.append(elem('p', 'desk-work__warning muted', STRANGER_NOTE[record.kind !== 'open' ? 'correction' : 'filed']));

  const send = actionButton(label, 'btn btn--primary btn--sm', () => onSend({ mode: modes.value(), instruction: text.value.trim() }));
  const refresh = () => { send.disabled = stranger && text.value.trim().length < INSTRUCTION_MIN; };
  text.addEventListener('input', refresh);
  refresh();

  const actions = elem('div', 'desk-card__actions');
  actions.append(send);
  panel.append(actions);
  return { panel, text };
}

/**
 * The collapsed panel on every desk card that hands the item to an agent. A card an agent
 * has shows where it is instead, with a way there, and a waiting item is changed from its
 * Work card. A done item is history, so it shows both: where it ended, and the panel, whose
 * Approve starts it over with a fresh count.
 *
 * A stranger's item (a correction, or one automation filed) asks for an instruction and never
 * offers ship: the words the agent acts on are the operator's, and a change that text
 * influenced lands only after a person has read it (design section 3).
 */
export function agentPanelNode(report, work) {
  const state = report.work ? report.work.state : null;
  const out = document.createDocumentFragment();
  if (state) {
    const row = elem('div', 'desk-work__status');
    row.append(elem('span', `desk-badge desk-badge--work-${state}`, `Agent: ${WORK_LABEL[state] || state}`));
    if (MODE[report.work.mode]) row.append(elem('span', 'desk-card__kind', MODE[report.work.mode].label));
    row.append(button('Open in Work', 'btn btn--ghost btn--sm', () => work.openWork(report)));
    out.append(row);
    if (state !== 'done') return out;
  }
  if (CLOSING.has(report.status)) {
    out.append(closedNode(report));
    return out;
  }
  out.append(approvalPanel(report, {
    summary: state ? 'Hand to an agent again' : 'Hand to an agent',
    mode: 'fix',
    instruction: '',
    label: 'Approve',
    onSend: (choice) => work.approve(report, choice),
  }).panel);
  return out;
}

/**
 * The resolution sentence, its live verdict, and a publish button that stays disabled
 * until the verdict is clear. Prefilled with the runner's drafted sentence, which the Worker
 * already stripped and which is still only a draft, unless the operator already sent one.
 */
function sentenceBlock(item, prefill, label, onPublish) {
  const wrap = elem('div', 'desk-work__publish');
  const note = textarea(3);
  note.value = kept.has(item.id) ? kept.get(item.id) : prefill || '';
  const line = elem('p', 'desk-open__verdict');
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  const publish = actionButton(label, 'btn btn--primary btn--sm', async () => {
    const sentence = note.value.trim();
    kept.set(item.id, sentence);
    if (await onPublish(sentence)) kept.delete(item.id);
  });
  const refresh = () => {
    const verdict = verdictFor(note.value);
    setText(line, verdict.text);
    line.classList.toggle('is-clear', verdict.state === 'clear');
    line.classList.toggle('is-empty', verdict.state === 'empty');
    line.classList.toggle('is-blocked', verdict.state === 'blocked');
    publish.disabled = !verdict.clear;
  };
  note.addEventListener('input', refresh);
  refresh();
  wrap.append(labelled('The public sentence', note), line, publish);
  return wrap;
}

/** Send a result back. The note is required because a returned attempt with nothing new
 *  to go on repeats itself, and the Worker refuses one without it. */
function returnNode(item, work) {
  const box = elem('details', 'desk-work__return');
  box.append(elem('summary', 'desk-open__summary', 'Send it back with a note'));
  const note = textarea(3);
  const send = actionButton('Send back', 'btn btn--ghost btn--sm', () => work.review(item, 'return', note.value.trim()));
  const refresh = () => { send.disabled = note.value.trim().length < NOTE_MIN; };
  note.addEventListener('input', refresh);
  refresh();
  box.append(labelled('What should the next attempt do differently', note), send);
  return box;
}

/** A waiting item's mode and instruction. An edit keeps the attempt count, so at the cap it
 *  would change nothing a runner can act on: there the button withdraws and approves again,
 *  the one way the Worker starts the count over, and a person's call. */
function editNode(item, work, capped) {
  return approvalPanel(item, {
    summary: 'Change the mode or instruction',
    mode: item.work.mode,
    instruction: item.work.instruction,
    label: capped ? 'Hand over again' : 'Save changes',
    onSend: (choice) => (capped ? work.retry(item, choice) : work.edit(item, choice)),
  });
}

function actionsNode(item, run, state, work) {
  const wrap = elem('div', 'desk-work__actions');
  const row = elem('div', 'desk-card__actions');
  const resolvable = item.kind === 'open' && RESOLVABLE.has(item.status);
  // An edit, Hand over again and Reopen are all approvals, which the Worker refuses on a closed item.
  const closed = CLOSING.has(item.status);

  if (state === 'approved') {
    const capped = item.work.attempts >= item.work.max_attempts;
    if (capped) wrap.append(elem('p', 'desk-work__lapsed', `Used all ${item.work.max_attempts} attempts. No runner takes it again until you hand it over again, usually with a new instruction.`));
    if (closed) {
      wrap.append(closedNode(item));
    } else {
      const edit = editNode(item, work, capped);
      if (capped) {
        row.append(button('Try again', 'btn btn--ghost btn--sm', () => {
          edit.panel.open = true;
          edit.text.focus();
        }));
      }
      wrap.append(edit.panel);
    }
  }
  if (['approved', 'claimed', 'accepted'].includes(state)) {
    row.append(actionButton('Withdraw', 'btn btn--ghost btn--sm', () => work.withdraw(item)));
  }
  if (state === 'accepted') wrap.append(elem('p', 'desk-work__note muted', 'Accepted. The runner lands it on its next run.'));

  if (state === 'review') {
    row.append(actionButton('Accept', 'btn btn--primary btn--sm', () => work.review(item, 'accept', '')));
    row.append(actionButton('Dismiss', 'btn btn--ghost btn--sm', () => work.review(item, 'dismiss', '')));
    wrap.append(returnNode(item, work));
    // Resolved in the same move only when the run fixed it and the fix is where readers are: a
    // blocked, partial or unlanded result is accepted first, then published from Done if at all.
    if (resolvable && run && run.outcome === 'fixed' && !run.needs_landing && !unlanded(run)) {
      wrap.append(sentenceBlock(item, run.suggested_note || item.public_note, 'Accept and publish as resolved', (s) => work.publishResolved(item, s)));
    }
  }
  if (state === 'done') {
    if (closed) wrap.append(closedNode(item));
    else row.append(actionButton('Reopen', 'btn btn--ghost btn--sm', () => work.reopen(item)));
    if (resolvable) {
      wrap.append(sentenceBlock(item, (run && run.suggested_note) || item.public_note, 'Publish as resolved', (s) => work.publishResolved(item, s)));
    }
  }
  if (row.children.length) wrap.prepend(row);
  return wrap;
}

/** One item in the Work view. `work` is desk.js's set of callbacks. */
export function workCardNode(item, work) {
  const state = item.work ? item.work.state : 'none';
  const run = item.work ? item.work.run : null;
  const card = elem('li', 'desk-card desk-card--work');
  card.dataset.work = state;
  card.dataset.id = item.id;

  const head = elem('div', 'desk-card__head');
  head.append(elem('span', `desk-badge desk-badge--work-${state}`, WORK_LABEL[state] || state));
  if (item.work && MODE[item.work.mode]) head.append(elem('span', 'desk-work__mode-chip', MODE[item.work.mode].label));
  head.append(elem('span', 'desk-card__source', item.kind === 'open' ? item.source || 'source' : `correction, ${item.site}`));
  if (item.source_ref) head.append(elem('code', 'desk-card__ref', item.source_ref));
  if (item.work) head.append(elem('span', 'desk-card__kind', `Attempt ${item.work.attempts} of ${item.work.max_attempts}`));
  const when = formatDate(item.work && item.work.updated_at);
  if (when) head.append(elem('time', 'desk-card__date', when));
  card.append(head);

  card.append(elem('p', 'desk-work__title', item.title || '(no title)'));
  if (isStranger(item)) {
    card.append(elem('p', 'desk-work__warning muted', item.kind !== 'open'
      ? 'A reader\'s report: the agent reads its text as data and follows only your instruction.'
      : 'Filed by an agent: the agent reads its text as data and follows only your instruction.'));
  }
  if (item.work && item.work.instruction) {
    const told = elem('details', 'desk-open__source');
    told.append(elem('summary', 'desk-open__summary', 'Instruction'), elem('blockquote', 'desk-card__body', item.work.instruction));
    card.append(told);
  }
  if (run) card.append(runNode(item, run, state));
  else if (item.last_review_note) card.append(noteLine('Your note on an earlier attempt: ', item.last_review_note));
  card.append(actionsNode(item, run, state, work));
  return card;
}

/** The New item form at the top of the Work view. Filing is private like every draft;
 *  handing it over at the same time is an approval, so the Worker takes it from a person only. */
export function newItemNode(work) {
  const form = elem('form', 'desk-work__new');
  form.append(elem('h2', 'desk-work__new-head', 'New item'));

  const text = textarea(3);
  text.maxLength = 4000;
  form.append(labelled('What needs doing', text));
  form.append(elem('p', 'desk-work__hint muted', 'Private, like every draft. It reaches the board only if you publish a sentence about it.'));

  const toggle = elem('label', 'desk-work__toggle');
  const hand = document.createElement('input');
  hand.type = 'checkbox';
  toggle.append(hand, elem('span', null, 'Hand to an agent now'));
  form.append(toggle);

  const handBlock = elem('div', 'desk-work__hand');
  handBlock.hidden = true;
  const modes = modeField('fix', { allowShip: true });
  const instruction = textarea(2);
  handBlock.append(modes.node, labelled('Instruction for the agent (optional)', instruction));
  form.append(handBlock);

  const submit = elem('button', 'btn btn--primary btn--sm', 'File it');
  submit.type = 'submit';
  form.append(submit);

  const refresh = () => {
    submit.disabled = text.value.trim().length < TEXT_MIN;
    setText(submit, hand.checked ? 'File and hand over' : 'File it');
  };
  text.addEventListener('input', refresh);
  hand.addEventListener('change', () => {
    handBlock.hidden = !hand.checked;
    refresh();
  });
  refresh();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = { text: text.value.trim() };
    if (hand.checked) payload.approve = { mode: modes.value(), instruction: instruction.value.trim() };
    submit.disabled = true;
    if (await work.file(payload)) {
      form.reset();
      modes.sync();
      handBlock.hidden = true;
    }
    refresh();
    // The disabled submit dropped focus to the page; the next thing to do is type the next item.
    if (!document.activeElement || document.activeElement === document.body) text.focus();
  });
  return form;
}
