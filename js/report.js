// The report page. This is where a stranger's text is typed, and it is the only
// page on the site that reads a URL fragment a hostile page could have written.
//
// CONTRACTS.md C1.3: the Beacon carries {v, site, url, target} and nothing else.
// The visitor supplies kind, body and contact here, same-origin. This file
// assembles the full C1 payload and is the only place that does.
//
// C5, extended to this page by the D1 amendment: every value read from
// location.hash is hostile input. A hostile host page can embed a Beacon with
// any fragment it likes and send someone here. So this file validates the
// fragment against C1 before showing any of it, and renders every field with
// textContent. There is no innerHTML in this file, deliberately.

import { postReport } from './api.js';
import { setText, show, hide, announce } from './utils.js';

const BODY_MIN = 10;
const BODY_MAX = 2000;
const URL_MAX = 512;
const KINDS = ['wrong', 'missing', 'broken', 'other'];

const SITE_RE = /^[a-z0-9-]{1,40}$/;
const TARGET_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

const el = {};
let context = null;

/**
 * Parse and validate the fragment against C1. Returns null for anything that
 * does not match, which is treated exactly like arriving with no fragment at
 * all: the page still works, it just cannot say what you are reporting.
 *
 * Every rule here is C1's rule. Duplicating the Worker's validation on the
 * client is not defence (the Worker validates again and is the only thing that
 * counts). It is so we never render a value we would not have accepted.
 */
export function parseContext(hash) {
  if (!hash || hash.length < 2) return null;
  let raw;
  try {
    raw = JSON.parse(decodeURIComponent(hash.slice(1)));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== 1) return null;
  if (typeof raw.site !== 'string' || !SITE_RE.test(raw.site)) return null;
  if (typeof raw.url !== 'string' || !raw.url) return null;

  // Only http(s). A fragment carrying javascript: or data: must never reach an
  // href, and this page puts the url in one.
  let parsed;
  try {
    parsed = new URL(raw.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  let target = null;
  if (raw.target !== null && raw.target !== undefined) {
    const t = raw.target;
    if (typeof t !== 'object') return null;
    if (typeof t.kind !== 'string' || !TARGET_KIND_RE.test(t.kind)) return null;
    if (typeof t.id !== 'string' || !t.id || t.id.length > 128) return null;
    if (typeof t.label !== 'string' || !t.label || t.label.length > 120) return null;
    target = { kind: t.kind, id: t.id, label: t.label };
  }

  return { v: 1, site: raw.site, url: raw.url.slice(0, URL_MAX), target };
}

/** Show the visitor what they are reporting, in their own words where possible. */
function renderContext() {
  if (!context) {
    show(el.noContext);
    hide(el.context);
    return;
  }
  hide(el.noContext);
  show(el.context);

  // textContent everywhere. `label` and `url` are attacker-influenceable (C5).
  if (context.target) {
    setText(el.targetLabel, context.target.label);
    show(el.targetRow);
  } else {
    hide(el.targetRow);
  }
  setText(el.siteName, context.site);
  setText(el.pageUrl, context.url);
  el.pageLink.href = context.url;
}

function updateCount() {
  const n = el.body.value.trim().length;
  setText(el.count, `${n} / ${BODY_MAX}`);
  el.count.classList.toggle('is-over', n > BODY_MAX);
  el.count.classList.toggle('is-short', n > 0 && n < BODY_MIN);
}

function failWith(result) {
  // The Worker writes message and hint to be read by a person. Show them
  // verbatim rather than inventing wording per code (C2).
  setText(el.errorMessage, result.message || 'That did not go through.');
  setText(el.errorHint, result.hint || '');
  show(el.error);
  announce(el.error);
  el.submit.disabled = false;
  setText(el.submit, 'Send report');
}

/**
 * A challenge that cannot run used to be invisible. getResponse returns no
 * token, challengeToken() correctly yields '', and the reader was handed the
 * Worker's CHALLENGE_FAILED hint telling them to wait for a checkbox that is
 * not on the page. Cloudflare reports the real reason to an error callback,
 * so show that instead of guessing.
 *
 * Families, per Cloudflare's client-side error docs: 110 is configuration,
 * which the reader cannot fix; 300 and 600 are the challenge failing to
 * execute, which is nearly always the browsing context rather than this site.
 */
function challengeFailed(code) {
  const family = String(code).slice(0, 3);
  let hint;
  if (family === '110') {
    hint = 'The check is misconfigured for this domain, which is ours to fix and not yours. Nothing you type here can get past it today.';
  } else if (family === '300' || family === '600') {
    hint = 'This usually means third party cookies are blocked for challenges.cloudflare.com, or the page is open inside an embedded browser. Try a normal browser window.';
  } else {
    hint = 'Reload the page and try once more.';
  }
  failWith({ message: `The security check could not run (code ${code}).`, hint });
  // failWith hands the button back, which is right for a failed send and wrong
  // here: without a challenge there is nothing to send.
  el.submit.disabled = true;
}

async function submit(event) {
  event.preventDefault();
  hide(el.error);

  const body = el.body.value.trim();
  if (body.length < BODY_MIN) {
    failWith({
      message: `That is shorter than ${BODY_MIN} characters.`,
      hint: 'Say what is wrong and what it should say instead. A sentence is plenty.',
    });
    el.body.focus();
    return;
  }
  if (body.length > BODY_MAX) {
    failWith({
      message: `That is longer than ${BODY_MAX} characters.`,
      hint: 'Trim it to the part that matters and send again.',
    });
    el.body.focus();
    return;
  }

  el.submit.disabled = true;
  setText(el.submit, 'Sending…');

  // Everything from here is wrapped, because the one outcome worse than a
  // rejected report is a button that says "Sending…" forever. An unexpected
  // throw used to leave exactly that: the promise rejected, nothing was
  // re-enabled, and the visitor had no way to tell a slow network from a dead
  // page. Whatever goes wrong, the visitor gets told and gets the button back.
  try {
    // The full C1 payload is assembled HERE and only here (C1.3).
    const payload = {
      v: 1,
      site: context ? context.site : 'balise-site',
      url: context ? context.url : location.href.slice(0, URL_MAX),
      target: context ? context.target : null,
      kind: KINDS.includes(el.kind.value) ? el.kind.value : 'other',
      body,
      contact: el.contact.value.trim().slice(0, 120),
    };

    const result = await postReport(payload, challengeToken());
    if (!result.ok) {
      resetChallenge();
      failWith(result);
      return;
    }

    hide(el.form);
    show(el.done);
    announce(el.done);
  } catch {
    resetChallenge();
    failWith({
      message: 'Something went wrong on this page before the report could be sent.',
      hint: 'Reload the page and try once more. Nothing was recorded.',
    });
  }
}

/**
 * The Turnstile object exists as soon as its script loads, but its methods only
 * exist once a widget has actually rendered, and no widget renders without a
 * site key. Testing `window.turnstile` alone threw `getResponse is not a
 * function` on every unconfigured deployment, which is the default state until
 * a key is set. Test for the method, not the namespace.
 */
function challengeToken() {
  const api = typeof window !== 'undefined' ? window.turnstile : null;
  if (!api || typeof api.getResponse !== 'function' || !el.challenge) return '';
  try {
    return api.getResponse(el.challenge) || '';
  } catch {
    return '';
  }
}

function resetChallenge() {
  const api = typeof window !== 'undefined' ? window.turnstile : null;
  if (!api || typeof api.reset !== 'function' || !el.challenge) return;
  try {
    api.reset(el.challenge);
  } catch { /* a widget that never rendered has nothing to reset */ }
}

export function initReport() {
  [
    'context', 'noContext', 'targetRow', 'targetLabel', 'siteName', 'pageUrl',
    'pageLink', 'form', 'kind', 'body', 'contact', 'count', 'submit', 'error',
    'errorMessage', 'errorHint', 'done', 'challenge',
  ].forEach((id) => { el[id] = document.getElementById(id); });

  context = parseContext(location.hash);

  // The fragment is read once and then removed from the address bar. It has
  // done its job, and leaving it there puts the reported page's URL into this
  // page's history entry and into anything the visitor copies from the bar.
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }

  renderContext();
  document.addEventListener('neo:challenge-error', (e) => challengeFailed(e.detail));
  // The widget can fail before this module runs, so read what the bridge kept.
  if (window.__neoChallengeError) challengeFailed(window.__neoChallengeError);

  el.body.addEventListener('input', updateCount);
  el.form.addEventListener('submit', submit);
  updateCount();
}
