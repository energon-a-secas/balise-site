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

const KINDS = ['wrong', 'missing', 'broken', 'other'];

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

  return { value: { status: status || null, limit, before } };
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
