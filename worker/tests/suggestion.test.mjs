// The one rule that turns a tracker line into a sentence a person can read (queue #81).
//
// THE RULE: A SUGGESTION IS A SPAN OF ITS SOURCE, NEVER A REPAIR OF ONE. The importer used
// to cut every finding out of a tracker sentence and keep whatever was left, and on the
// 2026-09-15 import 89 of 92 drafts came out like "(closeMenu in)" or "uncommented ()".
// A remnant is worse than an empty box for the reason src/suggestion.js states: it invites
// an edit where the operator needs to write the line themselves.
//
// The corpus below is shaped from what that import read, with the fleet's own lines
// replaced by invented ones. This repository is public, and a real corpus would publish the
// map of soft spots that the private queue, the redaction floor and the operator-writes-the
// -sentence rule all exist to keep off a page. Every assertion here is about shape, so an
// invented line in the same shape tests exactly what a real one did. The last
// test is the one that matters most: whatever comes out, its words are a leading run of the
// words that went in, so no output can ever be a sentence the machine assembled.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanSuggestion } from '../src/suggestion.js';
import { redactionFindings } from '../src/redact.js';

/** Tracker lines in the shapes the import reads, invented, longest first in each pair. */
const CORPUS = [
  'Draft suggestions come out unreadable after the floor runs: tools/sample-import.mjs strips each tracker sentence, and on the last import 80 of 90 drafts read like `(openMenu in)`.',
  'Widget a11y, two measured findings from the sample verification (2026-01-07): Escape closes the menu but drops focus to body instead of returning it to the button that opened it (openMenu in js/sample-widget.js:118).',
  'See packages/sample-kit/widget for the control.',
  'The checker at sample_rules.py:120 is being reworked.',
  'scripts/sample.sh done and reopen move only an item first line, so an item written across several lines leaves its body behind.',
  'the sample page ships its preview tag uncommented (lines 12-18) while the rule says it stays commented.',
  'sample-site share links: every public share link and QR code opens the 404 page.',
  'Finish publishing the sample section from the DNS stage.',
];

/** Words, punctuation discarded. Two texts with the same word list say the same thing. */
const words = (text) => text.replace(/[^\w\s]+/g, ' ').split(/\s+/).filter(Boolean);

test('#81: a suggestion stops at the clause that would have needed a cut', () => {
  // The item's own line. Everything up to the colon is a direction; the path is what
  // follows it, so the path's whole clause goes and the direction stays.
  assert.equal(
    cleanSuggestion(CORPUS[0]),
    'Draft suggestions come out unreadable after the floor runs.',
  );
  // The line that produced "(closeMenu in)". Two clauses survive, and the bare date in the
  // middle of them is not a finding, so the reader keeps the date the finding was measured.
  assert.equal(
    cleanSuggestion(CORPUS[1]),
    'Widget a11y, two measured findings from the sample verification (2026-01-07).',
  );
});

test('#81: a sentence whose only clause carries a finding suggests nothing at all', () => {
  // Both of these used to come out as a sentence with a hole in it: "See for the widget."
  // and "The checker at is being reworked." An empty desk field says the true thing.
  assert.equal(cleanSuggestion(CORPUS[2]), '');
  assert.equal(cleanSuggestion(CORPUS[3]), '');
  assert.equal(cleanSuggestion(CORPUS[4]), '');
});

test('#81: a clean sentence is prefilled whole, whatever its punctuation', () => {
  assert.equal(cleanSuggestion(CORPUS[6]), 'sample-site share links: every public share link and QR code opens the 404 page.');
  assert.equal(cleanSuggestion(CORPUS[7]), 'Finish publishing the sample section from the DNS stage.');
  assert.equal(cleanSuggestion('The sample section has an address and is not served there yet.'), 'The sample section has an address and is not served there yet.');
});

test('#81: a surviving prefix too short to be a direction is dropped', () => {
  // "sample-site CSP" names a subject and says nothing about it. A label is not a
  // direction, and prefilling one reads as though the machine had an opinion.
  assert.equal(cleanSuggestion('sample-site CSP: no page sets one at packages/sample-kit/header.js.'), '');
  assert.equal(cleanSuggestion('other-site: js/plan.js draws the room twice.'), '');
  // Three words is enough when they are the item.
  assert.equal(cleanSuggestion('Sample kit follow-ups, none blocking (docs/architecture/sample.md).'), 'Sample kit follow-ups.');
});

test('#81: markdown, an em dash and stray whitespace are normalised, not carried', () => {
  // The trackers are Markdown and the board is not, so a backtick would arrive in the desk
  // field as a character to delete by hand. The dash is written as an escape because the
  // fleet's own writing rule covers a sentence a machine drafted for a person.
  assert.equal(cleanSuggestion('**Publish** the `sample-site` DNS stage.'), 'Publish the sample-site DNS stage.');
  assert.equal(cleanSuggestion('Ship the board\u2014then the queue.'), 'Ship the board, then the queue.');
  assert.equal(cleanSuggestion('  A clean\n\nsentence.  '), 'A clean sentence.');
});

test('#81: nothing to read gives nothing back, and a long clause is not cut mid-word', () => {
  for (const empty of ['', '   ', null, undefined, 42, {}]) assert.equal(cleanSuggestion(empty), '');
  // A clause that does not fit is left out whole, so no output ends in half a word.
  const long = cleanSuggestion(`${'word '.repeat(60)}stop.`, 120);
  assert.equal(long, '');
  const pair = cleanSuggestion('This clause fits. This second one is far too long to keep beside it.', 30);
  assert.equal(pair, 'This clause fits.');
});

test('#81: a dangling open parenthesis is impossible, because a clause is never split inside one', () => {
  // The comma inside the brackets is not a clause boundary. Were it one, the surviving
  // prefix would read "...(only on the first step." with the bracket still open.
  const out = cleanSuggestion('The kit hides its header (only on the first step, per the panel), and js/auth.js sets the logo.');
  assert.equal(out, 'The kit hides its header (only on the first step, per the panel).');
});

test('#81: whatever comes out is a leading run of the words that went in, and clears the floor', () => {
  for (const source of CORPUS) {
    const out = cleanSuggestion(source);
    if (!out) continue;
    const before = words(source);
    const after = words(out);
    // The invariant the old rule broke. "See packages/sample-kit/widget for the control."
    // came out as "See for the control.", whose second word is not the source's second word.
    assert.deepEqual(before.slice(0, after.length), after, source);
    assert.deepEqual(redactionFindings(out), [], out);
  }
});
