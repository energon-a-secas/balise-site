// The shapes the /apps routes read, as in src/validate.js: { value } or { code, message, hint }.
// All hostile input: an app's name and origins are rendered back with textContent (A9).

import {
  KINDS, SITE_RE, TARGET_KIND_RE, URL_MAX, BODY_MIN, BODY_MAX, TARGET_ID_MAX, TARGET_LABEL_MAX,
  validateListQuery,
} from './validate.js';
import { PERSON_TRANSITIONS, STATUSES } from './transitions.js';

export const APP_NAME_MAX = 60;
export const OWNER_MAX = 200;
export const OWNER_LABEL_MAX = 120;
export const ORIGINS_MAX = 5;

/** The statuses a tenant item can hold, which are the states C6.4 moves between. */
export const TENANT_STATUSES = [...new Set([...Object.keys(PERSON_TRANSITIONS), ...Object.values(PERSON_TRANSITIONS).flat()])];

const APP_ID_RE = /^ap[a-z2-7]{14}$/;
// A Clerk user id, the `sub` of the session token phase 3 verifies (Q3, P2b).
const OWNER_RE = /^user_[A-Za-z0-9]{1,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HOST_RE = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

const bad = (message, hint) => ({ code: 'BAD_FIELD', message, hint });
const missing = (message, hint) => ({ code: 'MISSING_PARAM', message, hint });
const isStr = (x) => typeof x === 'string';
const isObject = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** Whether a path segment can be an app id this service generated. Anything else is unknown. */
export const isAppId = (text) => isStr(text) && APP_ID_RE.test(text);

/** Short text a person typed for display: trimmed, capped, and free of control characters. */
function label(raw, field, max, { required }) {
  const text = isStr(raw) ? raw.trim() : '';
  if (!text) return required ? missing(`No ${field} was sent.`, `Send a ${field} of up to ${max} characters.`) : { value: null };
  if (text.length > max) return bad(`The ${field} is ${text.length} characters and the limit is ${max}.`, `Shorten the ${field} to ${max} characters.`);
  if (CONTROL_RE.test(text)) return bad(`The ${field} contains a control character or a line break.`, `Send the ${field} as one line of plain text.`);
  return { value: text };
}

/**
 * One exact origin, as a browser sends it in the Origin header: scheme, host, optional port, and
 * nothing else (C6.3). No wildcard, no path, no `null`. Plain http is accepted only for the
 * loopback names a developer tests on.
 */
export function validateOrigin(raw) {
  const text = isStr(raw) ? raw.trim() : '';
  const hint = 'Send each address the way a browser names it, like https://app.example.com or http://localhost:5173, with no path and no wildcard.';
  if (!text || text === 'null' || text.includes('*')) return bad(`${JSON.stringify(text)} is not a web address this service accepts.`, hint);
  let url;
  try {
    url = new URL(text);
  } catch {
    return bad(`${JSON.stringify(text)} is not a web address.`, hint);
  }
  if (url.origin !== text || !HOST_RE.test(url.hostname)) return bad(`${JSON.stringify(text)} is not written as an origin.`, hint);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return bad(`${text} is not an http or https address.`, hint);
  if (url.protocol === 'http:' && !LOOPBACK.includes(url.hostname)) {
    return bad(`${text} uses plain http.`, 'Use the https address, or localhost, 127.0.0.1 or [::1] while developing.');
  }
  return { value: text };
}

/**
 * POST /apps: { owner, owner_label?, name, origins? }. In phase 2 the operator registers on a
 * person's behalf; phase 3 takes `owner` from the signed-in person. Either way it is compared,
 * byte for byte, with the `sub` of a verified Clerk token (scope.js), so it has to be a Clerk
 * user id now: an app registered under a name or an address could never be read by its owner.
 * An app id is generated, never chosen, so a body naming one is refused (C6).
 */
export function validateRegistration(body) {
  if (!isObject(body)) return bad('The registration was not a JSON object.', 'Send { "owner": "...", "name": "...", "origins": [...] }.');
  if (body.app_id !== undefined || body.id !== undefined) {
    return bad('An app id cannot be chosen.', 'Leave out app_id and id. Balise generates the id and sends it back with the keys.');
  }
  const owner = label(body.owner, 'owner', OWNER_MAX, { required: true });
  if (owner.code) return owner;
  if (!OWNER_RE.test(owner.value)) {
    return bad('The owner has to be the person\'s Clerk user id, which starts with user_.', 'Copy the id from the person\'s page in the Clerk dashboard. Signing in matches that exact id, so an app registered under a name or an address could never be opened by its owner.');
  }
  const ownerLabel = label(body.owner_label, 'owner_label', OWNER_LABEL_MAX, { required: false });
  if (ownerLabel.code) return ownerLabel;
  const name = label(body.name, 'name', APP_NAME_MAX, { required: true });
  if (name.code) return name;

  const raw = body.origins === undefined ? [] : body.origins;
  if (!Array.isArray(raw)) return bad('origins has to be a list.', 'Send origins as a list of web addresses, or an empty list for an app that only posts from a server.');
  if (raw.length > ORIGINS_MAX) return bad(`That is ${raw.length} web addresses and an app may list ${ORIGINS_MAX}.`, `Keep the ${ORIGINS_MAX} the app really posts from.`);
  const origins = [];
  for (const entry of raw) {
    const origin = validateOrigin(entry);
    if (origin.code) return origin;
    if (origins.includes(origin.value)) return bad(`${origin.value} is listed twice.`, 'List each web address once.');
    origins.push(origin.value);
  }
  return { value: { owner: owner.value, ownerLabel: ownerLabel.value, name: name.value, origins } };
}

function target(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (!isObject(raw)) return bad('target has to be an object or null.', 'Send { "kind", "id", "label" }, or null for an item about the whole page.');
  const kind = isStr(raw.kind) ? raw.kind.trim() : '';
  const id = isStr(raw.id) ? raw.id.trim() : '';
  const name = isStr(raw.label) ? raw.label.trim() : '';
  if (!TARGET_KIND_RE.test(kind) || !id) {
    return bad('target needs a kind and an id.', 'A target kind is lowercase letters, digits and hyphens, like button or chapter. Send null instead if there is no one thing.');
  }
  if (id.length > TARGET_ID_MAX || name.length > TARGET_LABEL_MAX) {
    return bad(`A target id is at most ${TARGET_ID_MAX} characters and a label at most ${TARGET_LABEL_MAX}.`, 'Shorten them, or send null and let the address say where.');
  }
  return { value: { kind, id, label: name } };
}

/**
 * POST /apps/:app/items: { v: 1, kind, body, site?, url?, target? }.
 *
 * `contact` is REFUSED, not dropped (C6.7): an integrator whose field vanished would believe
 * Balise holds a reply address for their user. `app_id` is ignored, because the key decides the
 * app. `site` is a grouping hint inside the app and defaults to the app id.
 */
export function validateTenantItem(body, appId) {
  if (!isObject(body)) return bad('The item was not a JSON object.', 'Send { "v": 1, "kind": "wrong", "body": "..." }.');
  if (body.contact !== undefined) {
    return bad('Balise does not keep a way of contacting your users, so an item with a contact field is refused.', 'Remove the contact field and send the item again.');
  }
  if (body.v !== 1) {
    return { code: 'BAD_VERSION', message: `This service reads item format 1 and that item says ${JSON.stringify(body.v)}.`, hint: 'Send "v": 1.' };
  }
  const kind = isStr(body.kind) ? body.kind.trim() : '';
  if (!KINDS.includes(kind)) return (kind ? bad : missing)(`The kind has to be one of ${KINDS.join(', ')}.`, `Send one of ${KINDS.join(', ')} as kind.`);
  const text = isStr(body.body) ? body.body.trim() : '';
  if (!text) return missing('The item has no text.', 'Send what is wrong, in a sentence or two, as body.');
  if (text.length < BODY_MIN || text.length > BODY_MAX) {
    return bad(`The text is ${text.length} characters and has to be ${BODY_MIN} to ${BODY_MAX}.`, `Send between ${BODY_MIN} and ${BODY_MAX} characters.`);
  }
  const site = body.site === undefined ? appId : (isStr(body.site) ? body.site.trim() : '');
  if (!SITE_RE.test(site)) return bad('site has to be lowercase letters, digits and hyphens, at most 40.', 'Leave site out, or send a short name like settings-page.');
  if (body.url !== undefined && !isStr(body.url)) return bad('url has to be text.', 'Send the address the item is about, or leave url out.');
  const aimed = target(body.target);
  if (aimed.code) return aimed;
  return { value: { site, url: isStr(body.url) ? body.url.trim().slice(0, URL_MAX) : '', target: aimed.value, kind, body: text } };
}

/** PATCH /apps/:app/items/:id: { status } and nothing else, any other field refused by name
 *  (C6.4). Whether the move is legal is the store's question, answered with BAD_TRANSITION. */
export function validateItemMove(body) {
  if (!isObject(body)) return bad('The change was not a JSON object.', 'Send { "status": "fixed" }.');
  const extra = Object.keys(body).filter((key) => key !== 'status');
  if (extra.length) return bad(`An app's owner can change the status and nothing else, so ${extra.join(', ')} was refused.`, 'Send only { "status": ... }.');
  const status = isStr(body.status) ? body.status.trim() : '';
  if (!status) return missing('No new status was sent.', `Send one of ${TENANT_STATUSES.join(', ')}.`);
  if (!STATUSES.includes(status)) return bad(`"${status}" is not a status.`, `Send one of ${TENANT_STATUSES.join(', ')}.`);
  return { value: { status } };
}

/** GET /apps/:app/items: the desk's keyset parameters, over the statuses a tenant item has. */
export function validateItemQuery(params) {
  if ((params.get('kind') || '').trim()) return bad('A tenant list has no kind filter.', 'Drop the kind parameter; filter by status instead.');
  return validateListQuery(params, TENANT_STATUSES);
}
