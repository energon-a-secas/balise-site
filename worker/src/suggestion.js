// The one rule that turns a tracker line, or any other sentence a machine drafted, into
// something the desk can prefill (queue #81).
//
// A SUGGESTION IS A SPAN OF ITS SOURCE, NEVER A REPAIR OF ONE.
//
// This file replaces a rule that repaired. The importer used to cut every redaction finding
// out of a tracker sentence and keep whatever was left standing, and the result was measured
// on the 2026-09-15 import: 89 of 92 drafts read like `(closeMenu in)` or `uncommented ()`.
// The work queue's sanitized backlog is built from the same field, so a whole board's worth
// of one-line summaries said nothing.
//
// A remnant is worse than an empty box, and not only because it is unreadable. The desk
// prefills this field into the sentence the operator publishes, and a half-sentence invites
// an EDIT where the job is a REWRITE: the operator repairs the grammar, keeps the machine's
// framing, and never notices that the framing was assembled out of the parts of a defect
// report that were safe to show. An empty field asks the right question instead.
//
// So the rule cuts nothing. It keeps the leading clauses that carry no finding and stops at
// the first one that does, which means every suggestion is a verbatim prefix of its source
// (tests/suggestion.test.mjs asserts exactly that, word by word). A prefix rather than the
// first clean clause anywhere: a fragment lifted out of the middle of a sentence reads as
// the source's own opening when it is not, and that is the same borrowed authority the
// remnants had.
//
// Applied in four places, and it is the same function each time:
//   1. tools/import-open-items.mjs, building a draft direction from a tracker line;
//   2. src/store-open.js, on the `suggested` an import batch sends, because whoever holds
//      the automation token is not necessarily the importer;
//   3. src/store-work.js, on the suggestion filed with a direct work item;
//   4. src/store-work-runner.js, on the resolution sentence a runner drafts.
//
// Pure, and it imports the floor and nothing else. src/redact.js is the floor's own file
// and is byte-identical to js/redact.js; this file is deliberately NOT part of that pair,
// because the desk shows the floor's verdict on what a person typed and never builds a
// sentence of its own.

import { redactionFindings } from './redact.js';

/**
 * Characters. The same 500 as `OPEN_SUGGESTED_MAX` and `SUGGESTION_MAX` in src/validate.js,
 * which is what the routes accept into this column; a caller with a tighter budget passes
 * its own (the importer's is one sentence's worth).
 */
const DEFAULT_MAX = 500;

/**
 * Words below which a surviving prefix is a label rather than a direction. Two words is
 * "vitrina-site CSP", which names a subject and says nothing about it; three is
 * "Auth Kit follow-ups", which is the item. Measured against the real corpus in
 * tests/suggestion.test.mjs rather than chosen.
 */
const MIN_WORDS = 3;

/**
 * The draft, or an empty string when the source has no readable opening.
 *
 * `max` is a budget for the whole result, and a clause that would not fit is left out
 * whole rather than sliced, so no suggestion ends in half a word.
 */
export function cleanSuggestion(text, max = DEFAULT_MAX) {
  const kept = [];
  let length = 0;
  for (const clause of clausesOf(plain(text))) {
    if (redactionFindings(clause).length) break;
    const grown = length + (length ? 1 : 0) + clause.length;
    if (grown > max) break;
    kept.push(clause);
    length = grown;
  }
  const span = kept.join(' ');
  return wordCount(span) >= MIN_WORDS ? finish(span) : '';
}

/**
 * The source with its Markdown and its dashes gone, on one line.
 *
 * The trackers are Markdown and the board is not, so a backtick or a bold marker would
 * arrive in the desk field as a character for the operator to delete by hand. The
 * UNDERSCORE is deliberately not in that class: stripping it would turn a secret's name
 * into one unbroken word and walk it straight past the floor's variable-name rule.
 *
 * The dashes are an em and an en, written as escapes so this file does not carry one. The
 * fleet's writing rule covers a sentence a machine drafted for a person as much as one a
 * person typed.
 */
function plain(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[`*]{1,2}/g, '')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The text split into clauses, each keeping the punctuation that ended it.
 *
 * A boundary is `, ; :` or a sentence's own end, and it has to be FOLLOWED BY WHITESPACE or
 * be the last character. Without that condition `og:image` splits between its halves and
 * the surviving prefix reads "the template ships og", which is a repair in everything but
 * name; `1,000` and `e.g.` split the same way.
 *
 * Nothing inside brackets is a boundary, tracked by depth rather than by pattern, so a
 * clause is always balanced and a surviving prefix can never end on an open bracket.
 */
function clausesOf(text) {
  const out = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ',;:.!?'.includes(ch) && (i + 1 === text.length || text[i + 1] === ' ')) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** Tokens that contain a letter or a digit. Punctuation left standing is not a word. */
const wordCount = (text) => text.split(' ').filter((token) => /\w/.test(token)).length;

/**
 * The span as a sentence: the punctuation that joined it to the clause it lost is dropped,
 * and it ends the way a sentence ends. A closing bracket is a fine last character and still
 * takes a full stop after it.
 */
function finish(span) {
  const trimmed = span.replace(/[\s,;:([-]+$/, '');
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
