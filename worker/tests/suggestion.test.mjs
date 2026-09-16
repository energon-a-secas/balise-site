// The one rule that turns a tracker line into a sentence a person can read (queue #81).
//
// THE RULE: A SUGGESTION IS A SPAN OF ITS SOURCE, NEVER A REPAIR OF ONE. The importer used
// to cut every finding out of a tracker sentence and keep whatever was left, and on the
// 2026-09-15 import 89 of 92 drafts came out like "(closeMenu in)" or "uncommented ()".
// A remnant is worse than an empty box for the reason src/suggestion.js states: it invites
// an edit where the operator needs to write the line themselves.
//
// So the corpus below is real. Every input is a line the 2026-09-15 import actually read,
// and the expectations are what a person would want prefilled in the desk field. The last
// test is the one that matters most: whatever comes out, its words are a leading run of the
// words that went in, so no output can ever be a sentence the machine assembled.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanSuggestion } from '../src/suggestion.js';
import { redactionFindings } from '../src/redact.js';

/** Real tracker lines from the 2026-09-15 import, longest first in each pair. */
const CORPUS = [
  'Balise importer suggestions are mostly unreadable after redaction: tools/import-open-items.mjs strips each tracker sentence with the floor, and on the 2026-09-15 import 89 of 92 drafts read like `(closeMenu in)`.',
  'Header kit a11y, three measured findings from the Sash and Enamel verification (2026-09-10): Escape closes the mobile overflow menu but drops focus to body instead of returning it to the More actions button (closeMenu in js/neorgon-header.js:412).',
  'See packages/neorgon-ui/beacon for the widget.',
  'The checker at enforce.py:612 is being reworked.',
  'scripts/prompt.sh done and reopen move only an item first line, so an item written across several lines leaves its body behind.',
  'the template ships og:image uncommented (lines 26-30) while the rule says they stay commented.',
  'fitprofile-site share links: every public share link and QR code opens the 404 page.',
  'Finish publishing Sash and Enamel from the DNS stage.',
];

/** Words, punctuation discarded. Two texts with the same word list say the same thing. */
const words = (text) => text.replace(/[^\w\s]+/g, ' ').split(/\s+/).filter(Boolean);

test('#81: a suggestion stops at the clause that would have needed a cut', () => {
  // The item's own line. Everything up to the colon is a direction; the path is what
  // follows it, so the path's whole clause goes and the direction stays.
  assert.equal(
    cleanSuggestion(CORPUS[0]),
    'Balise importer suggestions are mostly unreadable after redaction.',
  );
  // The line that produced "(closeMenu in)". Two clauses survive, and the bare date in the
  // middle of them is not a finding, so the reader keeps the date the finding was measured.
  assert.equal(
    cleanSuggestion(CORPUS[1]),
    'Header kit a11y, three measured findings from the Sash and Enamel verification (2026-09-10).',
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
  assert.equal(cleanSuggestion(CORPUS[6]), 'fitprofile-site share links: every public share link and QR code opens the 404 page.');
  assert.equal(cleanSuggestion(CORPUS[7]), 'Finish publishing Sash and Enamel from the DNS stage.');
  assert.equal(cleanSuggestion('Carnet has an address and is not served there yet.'), 'Carnet has an address and is not served there yet.');
});

test('#81: a surviving prefix too short to be a direction is dropped', () => {
  // "vitrina-site CSP" names a subject and says nothing about it. A label is not a
  // direction, and prefilling one reads as though the machine had an opinion.
  assert.equal(cleanSuggestion('vitrina-site CSP: no page sets one at packages/neorgon-ui/header/header.js.'), '');
  assert.equal(cleanSuggestion('floorplan-site: js/plan.js draws the room twice.'), '');
  // Three words is enough when they are the item.
  assert.equal(cleanSuggestion('Auth Kit follow-ups, none blocking (docs/architecture/auth-flow.md).'), 'Auth Kit follow-ups.');
});

test('#81: markdown, an em dash and stray whitespace are normalised, not carried', () => {
  // The trackers are Markdown and the board is not, so a backtick would arrive in the desk
  // field as a character to delete by hand. The dash is written as an escape because the
  // fleet's own writing rule covers a sentence a machine drafted for a person.
  assert.equal(cleanSuggestion('**Publish** the `sash-site` DNS stage.'), 'Publish the sash-site DNS stage.');
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
    // The invariant the old rule broke. "See packages/neorgon-ui/beacon for the widget."
    // came out as "See for the widget.", whose second word is not the source's second word.
    assert.deepEqual(before.slice(0, after.length), after, source);
    assert.deepEqual(redactionFindings(out), [], out);
  }
});
