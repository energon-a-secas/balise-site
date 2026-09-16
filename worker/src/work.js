// The work queue's vocabulary and its action table. Pure: no SQL, no I/O.
//
// docs/DESIGN-WORK-QUEUE.md section 2 is the design. This file is the part of it a reader
// has to be able to check at a glance, the way src/transitions.js is for C4, and
// tests/work-rules.test.mjs asserts the table literally so that widening it by accident
// fails with the offending action named.
//
// THE RULE BEHIND THE TABLE: automation does work and reports it. Only a person starts
// work, judges it, or stops it. Every operator-only row below is one of those three verbs,
// and every row automation holds is doing or reporting.
//
// Execution is its own axis. Nothing here reads or writes C4's `status`, `public_note` or
// `public`, so no action in this file can put anything in front of a reader.

/** The five work states. NULL in the column is `none`: not in the queue. */
export const WORK_STATES = ['approved', 'claimed', 'review', 'accepted', 'done'];

/** What the desk and the runner mean by "the queue". `done` is history. */
export const ACTIVE_STATES = ['approved', 'claimed', 'review', 'accepted'];

/** The C4 statuses that close an item, and the one place the two axes meet: src/store.js
 *  refuses a move to one of these while an item is in ACTIVE_STATES, and approve refuses an
 *  item already at one (closedRule below). Each write repeats its check in its WHERE. */
export const CLOSED_STATUSES = ['fixed', 'rejected', 'spam', 'duplicate'];

/** The states the public board calls in progress: an agent has the item, or has finished
 *  and a person has not closed it yet. `approved` is waiting, not moving. */
export const IN_PROGRESS_STATES = ['claimed', 'review', 'accepted'];

export const WORK_MODES = ['investigate', 'fix', 'ship'];
export const DEFAULT_MODE = 'fix';

export const WORK_OUTCOMES = ['fixed', 'investigated', 'partial', 'blocked', 'failed'];

/** Claims before an item stops being claimable. Three, for the same reason the task skill
 *  stops a fix loop at three: a fourth attempt at something that failed three times is a
 *  sign the item needs a person, not a retry. */
export const MAX_ATTEMPTS = 3;

/** Lease bounds, in seconds. The low bound exists so the suite can expire a lease in real
 *  time; nothing in production has a reason to go near it. */
export const LEASE_DEFAULT_S = 1800;
export const LEASE_MIN_S = 5;
export const LEASE_MAX_S = 7200;

export const NONE = 'none';

/**
 * Every action, where it may start, where it lands, and who may take it. `accept` lands on
 * `accepted` or `done` depending on the run (acceptTarget below); the table records the
 * first because that is the one that still has work left in it.
 *
 * "human" is the operator token and "ai" the automation token (C3, A6). The runner's own
 * actions take either, so the loop can be run by hand with the operator's credential.
 */
export const WORK_ACTIONS = {
  approve: { from: [NONE, 'approved', 'done'], to: 'approved', actors: ['human'] },
  withdraw: { from: ['approved', 'claimed', 'review', 'accepted'], to: NONE, actors: ['human'] },
  claim: { from: ['approved'], to: 'claimed', actors: ['human', 'ai'] },
  heartbeat: { from: ['claimed'], to: 'claimed', actors: ['human', 'ai'] },
  release: { from: ['claimed'], to: 'approved', actors: ['human', 'ai'] },
  submit: { from: ['claimed'], to: 'review', actors: ['human', 'ai'] },
  accept: { from: ['review'], to: 'accepted', actors: ['human'] },
  return: { from: ['review'], to: 'approved', actors: ['human'] },
  dismiss: { from: ['review'], to: NONE, actors: ['human'] },
  land: { from: ['accepted'], to: 'done', actors: ['human', 'ai'] },
  unland: { from: ['accepted'], to: 'review', actors: ['human', 'ai'] },
};

/** A stored value as a state, with anything unknown read as not in the queue. */
export function stateOf(value) {
  return WORK_STATES.includes(value) ? value : NONE;
}

export function canAct(action, from, actor) {
  const rule = WORK_ACTIONS[action];
  return Boolean(rule) && rule.actors.includes(actor) && rule.from.includes(from);
}

/** The actions this actor could take from this state, for a refusal's hint. */
export function actionsFrom(from, actor) {
  return Object.entries(WORK_ACTIONS)
    .filter(([, rule]) => rule.actors.includes(actor) && rule.from.includes(from))
    .map(([name]) => name);
}

/**
 * The C2 envelope for a move this role may not make or this state does not allow. Always
 * BAD_TRANSITION, the code C4 already uses for both, so no new code reaches the site.
 *
 * The role case is checked first and says so plainly: an automation token asking to
 * approve its own work is the one refusal in this file that matters for safety, and it
 * should read as a rule rather than as a state that happened to be wrong.
 */
export function refusal(action, from, actor) {
  const rule = WORK_ACTIONS[action];
  if (rule && !rule.actors.includes(actor)) {
    return {
      code: 'BAD_TRANSITION',
      message: `Only the operator can ${action} work.`,
      hint: 'Automation does the work and reports it. Starting, judging and stopping it stay with a person at the desk.',
    };
  }
  const moves = actionsFrom(from, actor);
  return {
    code: 'BAD_TRANSITION',
    message: from === NONE
      ? `That item is not in the work queue, so it cannot take "${action}".`
      : `A work item at "${from}" cannot take "${action}".`,
    hint: moves.length
      ? `From "${from}" the actions are ${moves.join(', ')}. Reload the queue to see where it is now.`
      : 'Reload the queue to see where it is now.',
  };
}

/** The one state an accepted result moves to: a fix that still has to land waits for the
 *  runner, anything else is finished. */
export function acceptTarget(run) {
  return run && run.needs_landing ? 'accepted' : 'done';
}

/**
 * How much the runner may trust the row's own text. A correction's body is a stranger's.
 * So, as far as anyone can tell, is an open item automation filed: a runner that read a
 * reader's report may have written its follow-up from that report's words, and nothing on
 * the row could say otherwise. `filedBy` is reports.filed_by, NULL for an import.
 */
export function trustOf(kind, filedBy) {
  return kind === 'open' && filedBy !== 'ai' ? 'fleet' : 'stranger';
}

/** The shortest instruction a stranger's item can be handed over with. */
export const INSTRUCTION_MIN = 10;

/**
 * Mode rules the operator's approval must satisfy, by trustOf's answer. Returns null or a
 * C2 error.
 *
 * A stranger's item needs an instruction a person wrote, and it can never ship: the runner
 * has write access, so the words it acts on are the operator's, and a change that text
 * influenced lands only after a person has read it. Anything but 'fleet' is held to this,
 * so a caller that passes the wrong value fails closed.
 */
export function approvalRule(trust, mode, instruction) {
  if (trust === 'fleet') return null;
  if (mode === 'ship') {
    return {
      code: 'BAD_FIELD',
      message: 'A reader\'s report, or an item automation filed, cannot be handed over in ship mode.',
      hint: 'Use fix, so the change lands only after you have read it, or investigate.',
    };
  }
  if ((instruction || '').trim().length < INSTRUCTION_MIN) {
    return {
      code: 'BAD_FIELD',
      message: 'A reader\'s report, or an item automation filed, needs an instruction you wrote before an agent can take it.',
      hint: `Say what should be done in your own words, at least ${INSTRUCTION_MIN} characters. The item's own text goes to the agent as quoted data, never as the instruction.`,
    };
  }
  return null;
}

/**
 * Why an item C4 has closed cannot be approved, or null. Checked before approvalRule, since
 * no instruction makes a closed item one to work on. A rejected, spam or duplicate item comes
 * back through C4's one reopening edge, to accepted; `fixed` has no edge out, so more work on
 * a resolved item is a new item of its own.
 */
export function closedRule(status) {
  if (!CLOSED_STATUSES.includes(status)) return null;
  if (status === 'fixed') {
    return {
      code: 'BAD_TRANSITION',
      message: 'That item is resolved, so it cannot be handed to an agent.',
      hint: 'Fixed is final. File any follow-up work as a new item under Work, and hand that one over.',
    };
  }
  return {
    code: 'BAD_TRANSITION',
    message: `That item is closed as "${status}", so it cannot be handed to an agent.`,
    hint: 'Reopen it first by moving it to accepted, then hand it to an agent.',
  };
}

/**
 * What a submitted result must look like for the mode it was claimed in. Returns null or a
 * C2 error. The run's mode is the one it was CLAIMED in, not whatever the approval says
 * now, since an edit after the claim did not reach the runner.
 */
export function submitRule(mode, { outcome, needs_landing: needsLanding, refs }) {
  if (mode === 'investigate') {
    if (!['investigated', 'blocked', 'failed'].includes(outcome)) {
      return {
        code: 'BAD_FIELD',
        message: `An investigation reports investigated, blocked or failed, not "${outcome}".`,
        hint: 'Investigate is read only. Submit what you found; a fix is a new approval.',
      };
    }
    if (needsLanding) {
      return {
        code: 'BAD_FIELD',
        message: 'An investigation has nothing to land.',
        hint: 'Drop needs_landing. If a change is worth making, say so in the summary.',
      };
    }
  }
  if (mode === 'ship' && needsLanding) {
    return {
      code: 'BAD_FIELD',
      message: 'A ship run lands before it submits, so it cannot still need landing.',
      hint: 'Land it once its checks pass, then submit with the landed refs.',
    };
  }
  if (needsLanding && !(Array.isArray(refs) && refs.length)) {
    return {
      code: 'BAD_FIELD',
      message: 'A result that needs landing has to say what to land.',
      hint: 'Send refs with the branch or commit for each repository the fix touched.',
    };
  }
  return null;
}

const firstLine = (text) => (text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The one line a list shows for an item. PRIVATE: it can fall back to the instruction or
 * the body, so it is for the desk and the runner and never for a public surface. The CLI's
 * backlog builds its own line from public_note and suggested for exactly that reason.
 */
export function titleFor(row) {
  const text = (row.public_note || '').trim()
    || (row.suggested || '').trim()
    || firstLine(row.work_instruction)
    || firstLine(row.body);
  return clip(text, 140);
}
