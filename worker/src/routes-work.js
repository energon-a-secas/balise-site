// The work queue's routes (docs/DESIGN-WORK-QUEUE.md section 5).
//
//   GET  /work                 the queue, one page, with a count per state
//   GET  /work/:id             one item, with its body and run history
//   POST /work/items           file an item, and optionally hand it over (operator only)
//   POST /work/claim           a runner takes the oldest approval, or a named one
//   POST /work/:id/<action>    approve, withdraw, heartbeat, release, submit, review, land
//
// Authentication has already happened in src/index.js and the body arrives parsed under
// WORK_REQUEST_MAX_BYTES (64 KB, src/validate-work.js), the one route family allowed past
// the Worker's 8 KB. What is left here is choosing the action, the shape check and the
// envelope.
//
// THE ROLE RULE IS NOT CHECKED HERE. Which credential may take which action is decided
// once, against src/work.js's table, inside src/store-work.js. A route that also checked
// roles would be a second copy of the rule, and a second copy is the one that drifts.
// The single exception is below, for a reason given where it happens.
//
// Nothing reachable from this file writes `status`, `public_note` or `public`, so nothing
// here can put anything in front of a reader.

import { fail, ok } from './envelope.js';
import {
  validateWorkList, validateDirectItem, validateApproval, validateClaim, validateHeartbeat,
  validateRelease, validateSubmit, validateReview, validateLand, ID_MAX,
} from './validate-work.js';
import {
  listWork, readDetail, workItem, insertDirectItem, approveWork, withdrawWork, reviewWork,
} from './store-work.js';
import { claimWork, heartbeatWork, releaseWork, submitWork, landWork } from './store-work-runner.js';
import { refusal, NONE } from './work.js';

const P = 'desk';

const ITEM_ACTIONS = ['approve', 'withdraw', 'heartbeat', 'release', 'submit', 'review', 'land'];

export const WORK_ROUTES_HINT =
  'The work routes are GET /work, GET /work/:id, POST /work/items, POST /work/claim, and POST /work/:id/ followed by approve, withdraw, heartbeat, release, submit, review or land.';

/**
 * Which work route a path and method name, or a hint for NOT_A_ROUTE. Decided BEFORE
 * authentication, like every other route in this Worker, so a wrong method is a 404 with a
 * sentence rather than a 401 that sends the caller looking at their token.
 */
export function parseWorkPath(path, method) {
  if (path === '/work') return method === 'GET' ? { route: 'list' } : { hint: 'The work queue is read with GET /work.' };
  if (path === '/work/items') return method === 'POST' ? { route: 'items' } : { hint: 'An item is filed with POST /work/items.' };
  if (path === '/work/claim') return method === 'POST' ? { route: 'claim' } : { hint: 'A runner claims with POST /work/claim.' };

  const match = /^\/work\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (!match) return { hint: WORK_ROUTES_HINT };
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return { hint: 'That item id could not be read. Use the id exactly as GET /work returned it.' };
  }
  if (!id || id.length > ID_MAX) return { hint: 'That is not an item id this service hands out.' };

  const action = match[2];
  if (!action) return method === 'GET' ? { route: 'detail', id } : { hint: 'One item is read with GET /work/:id.' };
  if (!ITEM_ACTIONS.includes(action)) return { hint: WORK_ROUTES_HINT };
  return method === 'POST' ? { route: action, id } : { hint: `That action is POST /work/:id/${action}.` };
}

/** One work request, already authenticated. Always answers a Response. */
export async function workRoute(env, target, { url, actor, body, origin, now }) {
  const db = env.DB;
  const reply = (result) => (result.code
    ? fail(result.code, { provider: P, origin, env, message: result.message, hint: result.hint })
    : ok(P, result, { origin, env }));
  const { id } = target;

  switch (target.route) {
    case 'list': {
      const query = validateWorkList(url.searchParams);
      if (query.code) return reply(query);
      const page = await listWork(db, query.value);
      if (page.code) return reply(page);
      return reply({ items: page.items, next: page.next, counts: page.counts, rows_read: page.rowsRead });
    }

    case 'detail': {
      const read = await readDetail(db, 'id', id);
      if (read.code) return reply(read);
      if (!read.item) {
        return reply({ code: 'NOT_FOUND', message: 'There is no item with that id.', hint: 'Reload the queue: it may have been withdrawn.' });
      }
      return reply(read);
    }

    case 'items': {
      const checked = validateDirectItem(body);
      if (checked.code) return reply(checked);
      const { text, suggested, approve } = checked.value;
      // The one role check in this file, and it has to be here: filing then approving is
      // two writes, and refusing the approval only after the insert would leave automation
      // able to file an item while being told its request failed. So the refusal comes
      // first and nothing is written.
      if (approve && actor !== 'human') return reply(refusal('approve', NONE, actor));

      const created = await insertDirectItem(db, { text, suggested, actor, now });
      if (created.code) return reply(created);
      if (created.duplicate) {
        return reply({
          code: 'DUPLICATE',
          message: 'That item is already in the queue.',
          hint: 'There is nothing more to do. File a separate item if this is something else.',
        });
      }
      return reply(approve
        ? await approveWork(db, { id: created.id, actor, mode: approve.mode, instruction: approve.instruction, now })
        : await workItem(db, created.id));
    }

    case 'claim': {
      const checked = validateClaim(body);
      if (checked.code) return reply(checked);
      const { runner, id: wanted, lease_seconds: leaseSeconds } = checked.value;
      return reply(await claimWork(db, { actor, runner, id: wanted, leaseSeconds, now }));
    }

    case 'approve': {
      const checked = validateApproval(body);
      if (checked.code) return reply(checked);
      return reply(await approveWork(db, { id, actor, ...checked.value, now }));
    }

    case 'withdraw':
      return reply(await withdrawWork(db, { id, actor, now }));

    case 'heartbeat': {
      const checked = validateHeartbeat(body);
      if (checked.code) return reply(checked);
      return reply(await heartbeatWork(db, { id, actor, run: checked.value.run, leaseSeconds: checked.value.lease_seconds, now }));
    }

    case 'release': {
      const checked = validateRelease(body);
      if (checked.code) return reply(checked);
      return reply(await releaseWork(db, { id, actor, ...checked.value, now }));
    }

    case 'submit': {
      const checked = validateSubmit(body);
      if (checked.code) return reply(checked);
      const v = checked.value;
      return reply(await submitWork(db, {
        id,
        actor,
        run: v.run,
        outcome: v.outcome,
        summary: v.summary,
        evidence: v.evidence,
        refs: v.refs,
        needsLanding: v.needs_landing,
        suggestedNote: v.suggested_note,
        now,
      }));
    }

    case 'review': {
      const checked = validateReview(body);
      if (checked.code) return reply(checked);
      return reply(await reviewWork(db, { id, actor, ...checked.value, now }));
    }

    case 'land': {
      const checked = validateLand(body);
      if (checked.code) return reply(checked);
      return reply(await landWork(db, { id, actor, ...checked.value, now }));
    }

    default:
      return fail('NOT_A_ROUTE', { provider: P, origin, env, message: 'That path and method are not a route on this worker.', hint: WORK_ROUTES_HINT });
  }
}
