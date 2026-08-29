// Small shared helpers. Everything that writes text to the DOM in this site
// goes through setText, and that is on purpose.
//
// CONTRACTS.md C5: every field of a report is rendered with textContent, never
// innerHTML. The desk and the report page both display text typed by strangers,
// and the desk also holds the operator credential. Having exactly one text
// setter means the C5 audit is a grep for innerHTML across js/, and a single
// hit is a real finding rather than something to triage.

/** The one way this site puts untrusted text on screen. */
export function setText(node, value) {
  if (!node) return;
  node.textContent = value == null ? '' : String(value);
}

export function show(node) {
  if (node) node.hidden = false;
}

export function hide(node) {
  if (node) node.hidden = true;
}

/**
 * Move focus to something that just appeared, so a screen reader and a keyboard
 * user both land on it. Used for the error box and the confirmation.
 */
export function announce(node) {
  if (!node) return;
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  node.focus({ preventScroll: false });
}

/**
 * A date a person can read, in the visitor's own locale. Falls back to the raw
 * value rather than throwing, since these come from the network.
 */
export function formatDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Date(n).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return String(ms);
  }
}

/**
 * Build an element with text content. Returns a real node, so callers compose
 * DOM instead of concatenating HTML strings. This is the constructive half of
 * the C5 rule: without it, "no innerHTML" is a prohibition with no alternative.
 */
export function elem(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}
