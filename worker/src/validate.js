// Every field, every cap. CONTRACTS.md C1, enforced rather than described.
//
// C1.2: every field of a report is hostile input. `site`, `url` and `target` are supplied
// by the browser and can be forged by anyone with curl. This file checks shape and
// length; the desk renders every field with textContent (C5); nothing downstream treats
// `site` as trusted.
//
// Each function returns either { value } or a ready made { code, message, hint } that the
// router turns into a C2 envelope. No function here throws and none of them touches the
// network or the database.

/**
 * The four kinds a REPORT can be. This list is what a stranger may send, and the import
 * route's `open` is deliberately not in it: `kind = 'open'` is written by one route, from
 * an authenticated importer, and can never arrive through POST /report.
 */
export const KINDS = ['wrong', 'missing', 'broken', 'other'];

/** What the desk may ASK for. Reading the open feed is allowed; writing it is not. */
export const LIST_KINDS = [...KINDS, 'open'];

const SITE_RE = /^[a-z0-9-]{1,40}$/;
const TARGET_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

export const URL_MAX = 512;
export const BODY_MIN = 10;
export const BODY_MAX = 2000;
export const CONTACT_MAX = 120;
export const TARGET_ID_MAX = 128;
export const TARGET_LABEL_MAX = 120;

/** The largest request body this Worker will read at all, in bytes. */
export const REQUEST_MAX_BYTES = 8 * 1024;

const bad = (message, hint) => ({ code: 'BAD_FIELD', message, hint });
const missing = (message, hint) => ({ code: 'MISSING_PARAM', message, hint });

const isStr = (x) => typeof x === 'string';

/**
 * The C1 payload. Returns { value } with every field normalised and capped, or an error.
 *
 * Order matters here. `v` is checked first so an old vendored widget fails loudly with
 * BAD_VERSION rather than half succeeding against a schema it does not understand, which
 * is the whole reason the field exists.
 */
export function validateReport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return bad(
      'The report was not a JSON object.',
      'Reopen the beacon on the page you were reading and send it again.',
    );
  }

  if (payload.v !== 1) {
    return {
      code: 'BAD_VERSION',
      message: `This service reads report format 1 and that report says ${JSON.stringify(payload.v)}.`,
      hint: 'Reload the page you were reading so it picks up the current beacon, then report again.',
    };
  }

  const site = isStr(payload.site) ? payload.site.trim() : '';
  if (!site) return missing('No site was named in the report.', 'Reopen the beacon from the page itself so it can fill the site in.');
  if (!SITE_RE.test(site)) {
    return bad(
      'The site id is not in the form this service accepts.',
      'A site id is lowercase letters, digits and hyphens, like parla-site. Reopen the beacon from the page itself.',
    );
  }

  const rawUrl = isStr(payload.url) ? payload.url.trim() : '';
  if (!rawUrl) return missing('No page address was sent with the report.', 'Reopen the beacon on the page you were reading and send it again.');
  // Truncated, never normalised: the hash carries in app state on several sites, so
  // dropping it would lose the very thing being reported.
  const url = rawUrl.slice(0, URL_MAX);

  const target = normaliseTarget(payload.target);
  if (target && target.code) return target;

  const kind = isStr(payload.kind) ? payload.kind.trim() : '';
  if (!kind) return missing('No report kind was chosen.', `Pick one of ${KINDS.join(', ')} in the beacon and send it again.`);
  if (!KINDS.includes(kind)) {
    return bad(`"${kind}" is not a kind of report this service knows.`, `The kinds are ${KINDS.join(', ')}. Pick one and send it again.`);
  }

  const body = isStr(payload.body) ? payload.body.trim() : '';
  if (!body) return missing('The report has no text in it.', 'Say what is wrong in a sentence or two, then send it again.');
  if (body.length < BODY_MIN) {
    return bad(
      `The report text is ${body.length} characters and this service needs at least ${BODY_MIN}.`,
      'Add a few more words about what is wrong, then send it again.',
    );
  }
  if (body.length > BODY_MAX) {
    return bad(
      `The report text is ${body.length} characters and the limit is ${BODY_MAX}.`,
      `Trim it to ${BODY_MAX} characters, or send the rest as a second report.`,
    );
  }

  const contact = isStr(payload.contact) ? payload.contact.trim() : '';
  if (contact.length > CONTACT_MAX) {
    return bad(
      `The contact field is ${contact.length} characters and the limit is ${CONTACT_MAX}.`,
      `Shorten it to ${CONTACT_MAX} characters, or leave it empty: it is optional.`,
    );
  }

  return {
    value: {
      v: 1,
      site,
      url,
      target: target || null,
      kind,
      body,
      contact,
    },
  };
}

/**
 * `target` is optional and `null` is a first class value, not a fallback: a widget with
 * no target MUST send null and the report is page level (C1). That degradation is the
 * property that makes the sixty site sweep a one liner, so a missing target is never an
 * error here.
 */
function normaliseTarget(target) {
  if (target === null || target === undefined) return null;
  if (typeof target !== 'object' || Array.isArray(target)) {
    return bad('The report target was not an object.', 'Reopen the beacon and click the item you meant to report, or send a page level report.');
  }

  const kind = isStr(target.kind) ? target.kind.trim() : '';
  const id = isStr(target.id) ? target.id.trim() : '';
  const label = isStr(target.label) ? target.label.trim() : '';

  if (!kind || !id) {
    return bad(
      'The report target is missing its kind or its id.',
      'Reopen the beacon and click the item you meant to report, or send a page level report instead.',
    );
  }
  // Site owned vocabulary, not a fleet enum. Balise never joins on it and never renders
  // it as anything but text.
  if (!TARGET_KIND_RE.test(kind)) {
    return bad(
      'The report target kind is not in the form this service accepts.',
      'A target kind is lowercase letters, digits and hyphens, like concept or shortcut. Send a page level report if that is easier.',
    );
  }
  if (id.length > TARGET_ID_MAX) {
    return bad(`The report target id is longer than ${TARGET_ID_MAX} characters.`, 'Send a page level report instead: the address alone is enough to find it.');
  }
  if (label.length > TARGET_LABEL_MAX) {
    return bad(`The report target label is longer than ${TARGET_LABEL_MAX} characters.`, 'Send a page level report instead: the address alone is enough to find it.');
  }

  // Display only, never joined on. An empty label is legal: the desk falls back to the id.
  return { kind, id, label };
}

/**
 * The desk's list parameters. `before` is a keyset cursor and never an OFFSET: D1 bills
 * rows_read as rows SCANNED, so an OFFSET is charged for every row it skips (A4).
 */
export function validateListQuery(params, statuses) {
  const status = (params.get('status') || '').trim();
  if (status && !statuses.includes(status)) {
    return bad(`"${status}" is not a report status.`, `The statuses are ${statuses.join(', ')}. Drop the filter to see everything.`);
  }

  // Which FEED the desk is asking for. Absent means the corrections queue, which is what
  // this route has always returned; `open` is the imported items. The whitelist is here
  // rather than in the store because the value reaches a SQL predicate.
  const kind = (params.get('kind') || '').trim();
  if (kind && !LIST_KINDS.includes(kind)) {
    return bad(`"${kind}" is not a kind of report.`, `The kinds are ${LIST_KINDS.join(', ')}. Drop the filter for the correction queue.`);
  }

  const rawLimit = (params.get('limit') || '').trim();
  let limit = 25;
  if (rawLimit) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return bad('The limit has to be a whole number from 1 to 50.', 'Drop the limit parameter to get the default page of 25.');
    }
  }

  const rawBefore = (params.get('before') || '').trim();
  let before = null;
  if (rawBefore) {
    before = Number(rawBefore);
    if (!Number.isInteger(before) || before < 0) {
      return bad('The cursor has to be the whole number this service handed back.', 'Drop the before parameter to start again from the newest report.');
    }
  }

  return { value: { status: status || null, kind: kind || null, limit, before } };
}

/** The PATCH body. The transition itself is checked in store.js, which owns C4. */
export function validatePatch(body, statuses) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('The change was not a JSON object.', 'Send { "status": "accepted" } and any fields that status needs.');
  }
  const status = isStr(body.status) ? body.status.trim() : '';
  if (!status) return missing('No new status was sent.', `Send a status: one of ${statuses.join(', ')}.`);
  if (!statuses.includes(status)) {
    return bad(`"${status}" is not a report status.`, `The statuses are ${statuses.join(', ')}.`);
  }

  const out = { status };

  // `public_note` is written by the operator and never derived from `body` (C4). The
  // stranger's raw text is never served from a neorgon.com domain, so this field is the
  // only thing the public log can ever show, and `fixed` is refused without it.
  if (body.public_note !== undefined) {
    if (!isStr(body.public_note)) return bad('public_note has to be text.', 'Write one sentence a reader outside the fleet would understand.');
    out.public_note = body.public_note.trim().slice(0, 500);
  }
  if (body.fixed_ref !== undefined) {
    if (!isStr(body.fixed_ref)) return bad('fixed_ref has to be text.', 'Use a commit sha or a short reference, or leave it out.');
    out.fixed_ref = body.fixed_ref.trim().slice(0, 200);
  }
  if (body.duplicate_of !== undefined) {
    if (!isStr(body.duplicate_of)) return bad('duplicate_of has to be a report id.', 'Copy the id of the report this one repeats.');
    out.duplicate_of = body.duplicate_of.trim().slice(0, 64);
  }
  if (body.public !== undefined) {
    if (typeof body.public !== 'boolean') return bad('public has to be true or false.', 'Send false for a report that is real but not publishable.');
    out.public = body.public ? 1 : 0;
  }

  if (body.ai_verdict !== undefined) {
    if (!isStr(body.ai_verdict)) return bad('ai_verdict has to be text.', 'Send the verdict as a short string, or leave it out.');
    out.ai_verdict = body.ai_verdict.trim().slice(0, 64);
  }
  if (body.ai_notes !== undefined) {
    if (!isStr(body.ai_notes)) return bad('ai_notes has to be text.', 'Send the evidence as text, or leave it out.');
    out.ai_notes = body.ai_notes.trim().slice(0, 2000);
  }
  if (body.ai_confidence !== undefined) {
    const c = Number(body.ai_confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) return bad('ai_confidence has to be a number from 0 to 1.', 'Leave it out if the job did not produce one.');
    out.ai_confidence = c;
  }

  return { value: out };
}

/* ── The open-items import (queue #58) ─────────────────────────────────────────
 *
 * The importer is authenticated and runs on the operator's own machine, so this is not
 * hostile input in the way a report is. It is checked to the same standard anyway: the
 * caps below are what stops a runaway parse of a tracker file from writing a megabyte
 * into the queue, and one shape check here is cheaper than a store error at 3am.
 */

export const OPEN_REF_MAX = 128;
export const OPEN_TEXT_MAX = 4000;
export const OPEN_SUGGESTED_MAX = 500;

/** The largest sensible millisecond timestamp, so a seconds-based value is caught. */
const TIME_MIN = 946684800000; // 2000-01-01
const TIME_MAX = 4102444800000; // 2100-01-01

function timestamp(value, field) {
  if (value === undefined || value === null || value === '') return { value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < TIME_MIN || n > TIME_MAX) {
    return bad(
      `${field} has to be a millisecond timestamp.`,
      'Send Date.now() style milliseconds, not seconds and not a date string.',
    );
  }
  return { value: n };
}

/**
 * One import batch: { v: 1, source, items: [{ ref, text, suggested?, opened_at?, closed_at? }] }.
 *
 * `max` is the batch cap, which exists because of D1's 50 queries per invocation and not
 * because of the body size: see the note at the top of src/store-open.js.
 */
export function validateOpenBatch(body, sources, max) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('The import batch was not a JSON object.', 'Send { "v": 1, "source": "queue", "items": [...] }.');
  }
  if (body.v !== 1) {
    return {
      code: 'BAD_VERSION',
      message: `This service reads import format 1 and that batch says ${JSON.stringify(body.v)}.`,
      hint: 'Update tools/import-open-items.mjs to the format this worker reads.',
    };
  }

  const source = isStr(body.source) ? body.source.trim() : '';
  if (!source) return missing('The batch did not say which tracker it came from.', `Send a source: one of ${sources.join(', ')}.`);
  if (!sources.includes(source)) {
    return bad(`"${source}" is not a tracker this service reads.`, `The sources are ${sources.join(', ')}.`);
  }

  if (!Array.isArray(body.items)) return missing('The batch had no items array.', 'Send items as an array, even for one item.');
  if (!body.items.length) return missing('The batch had no items in it.', 'Send at least one item, or send nothing at all.');
  if (body.items.length > max) {
    return bad(
      `The batch has ${body.items.length} items and the limit is ${max}.`,
      `Split it into batches of ${max}. The limit is a query budget, not a size one.`,
    );
  }

  const items = [];
  const refs = new Set();
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return bad('An item in the batch was not an object.', 'Each item is { ref, text, opened_at }.');
    }
    const ref = isStr(raw.ref) ? raw.ref.trim() : '';
    if (!ref) return missing('An item in the batch had no ref.', 'The ref is the private key inside the tracker, and it is what makes a re-run idempotent.');
    if (ref.length > OPEN_REF_MAX) return bad(`An item ref is longer than ${OPEN_REF_MAX} characters.`, 'Hash the long part of the ref instead of sending it whole.');
    // A repeat inside ONE batch would insert once and then report the second as
    // unchanged, which reads as "already imported" when it is really "sent twice".
    if (refs.has(ref)) return bad(`The ref ${ref} is in this batch twice.`, 'Deduplicate the batch before sending it.');
    refs.add(ref);

    const text = isStr(raw.text) ? raw.text.trim() : '';
    if (!text) return missing(`The item ${ref} had no text.`, 'Send the tracker line itself. It stays private; only the operator sentence is published.');

    const opened = timestamp(raw.opened_at, 'opened_at');
    if (opened.code) return opened;
    const closed = timestamp(raw.closed_at, 'closed_at');
    if (closed.code) return closed;

    items.push({
      ref,
      text: text.slice(0, OPEN_TEXT_MAX),
      // The suggestion is a DRAFT the desk prefills, never a published string. It is
      // capped and stored as it arrives; the redaction floor decides whether it is kept,
      // and the operator rewrites it either way.
      suggested: (isStr(raw.suggested) ? raw.suggested.trim() : '').slice(0, OPEN_SUGGESTED_MAX),
      opened_at: opened.value,
      closed_at: closed.value,
    });
  }

  return { value: { source, items } };
}

/**
 * One sync call: { source, refs: [...] }.
 *
 * The ref list is the COMPLETE set the importer saw this run, because anything missing
 * from it is about to be marked closed. A partial list therefore says "everything else is
 * finished", which is why the importer refuses to send one and why this cap is generous
 * enough that the 8 KB body limit is what actually bites.
 */
export function validateOpenSync(body, sources, max) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return bad('The sync call was not a JSON object.', 'Send { "source": "queue", "refs": [...] }.');
  }
  const source = isStr(body.source) ? body.source.trim() : '';
  if (!source) return missing('The sync call did not say which tracker it came from.', `Send a source: one of ${sources.join(', ')}.`);
  if (!sources.includes(source)) {
    return bad(`"${source}" is not a tracker this service reads.`, `The sources are ${sources.join(', ')}.`);
  }
  if (!Array.isArray(body.refs)) {
    return missing('The sync call had no refs array.', 'Send every ref the importer saw this run, even if the list is empty.');
  }
  if (body.refs.length > max) {
    return bad(`The sync call carries ${body.refs.length} refs and the limit is ${max}.`, 'Import that source in fewer, longer-lived refs.');
  }
  const refs = [];
  for (const raw of body.refs) {
    if (!isStr(raw) || !raw.trim()) return bad('A ref in the sync call was not text.', 'Every ref is the same string the import batch sent.');
    refs.push(raw.trim().slice(0, OPEN_REF_MAX));
  }
  return { value: { source, refs } };
}
