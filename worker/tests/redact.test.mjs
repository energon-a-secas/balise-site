// The redaction floor, rule by rule. No network, no database, no workerd.
//
// This is the check that decides whether a sentence may appear on a public page, so it is
// tested on its own rather than as a section of another file: a rule that quietly stops
// firing is invisible everywhere else in the system, and a rule that fires on good
// sentences teaches the operator to stop reading it.
//
// The last test in this file is a drift test, and it is the important one. The desk shows
// a live verdict from js/redact.js and the Worker refuses on worker/src/redact.js, and the
// two are the same bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactionFindings, stripRedactions, isRedactionClear } from '../src/redact.js';

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');
const SITE = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'js');

const flags = (text) => redactionFindings(text).map((f) => f.rule);

test('redaction: the four shapes the board must never carry', () => {
  // The spec's own list: a path, a line number, a tracker id, a token-shaped string.
  assert.deepEqual(flags('The fix landed in packages/neorgon-ui/footer.'), ['file path']);
  assert.ok(flags('The guard at line 217 never fires.').includes('line number'));
  assert.ok(flags('That scan stops at :646.').includes('line number'));
  assert.deepEqual(flags('Closing #41 finishes it.'), ['tracker id']);
  assert.ok(flags('Rotate ghp_AbCdEf0123456789 first.').includes('credential-shaped string'));
});

test('redaction: a file extension is a path even with no slash in front of it', () => {
  for (const ext of ['js', 'mjs', 'py', 'md', 'html', 'css', 'toml', 'yaml', 'yml', 'sql', 'sh']) {
    assert.ok(flags(`It is in enforce.${ext} today.`).includes('file path'), ext);
  }
});

test('redaction: a line number survives having its path cut off', () => {
  // The defect this rule was rewritten for. Strip the path out of a "file:line" pair and
  // an anchored rule stops seeing the number that is still sitting there.
  assert.ok(flags('the fix is at ::217 now').includes('line number'));
  assert.ok(flags('js/export.js:210-217 emits it').includes('line number'));
  assert.equal(stripRedactions('js/export.js:210-217 emits it'), 'emits it');
});

test('redaction: a bare date is NOT a finding, and a run id is', () => {
  // Every entry on the board carries a date, so flagging one would make the board
  // unwritable. A date followed by a slug is a harness run and is a finding.
  assert.deepEqual(flags('Shipped on 2026-09-05 after review.'), []);
  assert.deepEqual(flags('The run 2026-09-05-feat-rush-q was abandoned.'), ['run id']);
});

test('redaction: variable names and long opaque strings', () => {
  assert.deepEqual(flags('Set BALISE_OPERATOR_TOKEN first.'), ['variable name']);
  assert.ok(flags('sha 0fe4d96aa1b2c3d4e5f60718293a4b5c6d7e8f90 carries it').includes('credential-shaped string'));
  assert.ok(flags('header sends Bearer eyJhbGciOiJIUzI1NiJ9').includes('credential-shaped string'));
  assert.ok(flags('key AKIAIOSFODNN7EXAMPLE is live').includes('credential-shaped string'));
  assert.ok(flags('append token=abc123 to it').includes('credential-shaped string'));
});

test('redaction: a hyphenated English phrase is not a credential', () => {
  // The filter that makes the base64url rule usable. Without it this exact phrase, which
  // is the kind of sentence the board is FOR, matches a 24+ character token.
  assert.deepEqual(flags('the fleet-wide-compliance-checker is being reworked'), []);
  assert.ok('fleet-wide-compliance-checker'.length >= 24, 'the phrase must be long enough to be the real test');
});

test('redaction: a make target is a finding and ordinary English is not', () => {
  assert.deepEqual(flags('Run make d1-migrate to pick it up.'), ['make target']);
  assert.deepEqual(flags('Run make smoke before committing.'), ['make target']);
  for (const sentence of [
    'Make sure the reader can tell what changed.',
    'It should make it clearer, not longer.',
    'That would make the entry harder to read.',
  ]) {
    assert.deepEqual(flags(sentence), [], sentence);
  }
});

test('redaction: the sentences this board exists to publish all clear the floor', () => {
  for (const sentence of [
    'The fleet-wide compliance checker is being reworked and its exit codes change.',
    'A shared footer bug drops the attribution line on a few sites; a fix is on the way.',
    'Carnet has an address and is not served there yet.',
    'Lockfiles are now committed across the fleet, so a fresh install is reproducible.',
  ]) {
    assert.ok(isRedactionClear(sentence), sentence);
  }
});

test('redaction: the same text scanned twice gives the same answer', () => {
  // The rules carry /g. A shared regex keeps lastIndex between calls, which would make
  // the second scan of one string disagree with the first.
  const text = 'enforce.py:646 and #49 and ghp_AbCdEf0123456789';
  assert.deepEqual(redactionFindings(text), redactionFindings(text));
  assert.ok(redactionFindings(text).length >= 3);
});

test('redaction: stripping never leaves a finding behind', () => {
  for (const text of [
    'packages/neorgon-ui/footer/neorgon-footer.js:217 skips the hub link',
    'run 2026-09-05-feat-rush-q with BALISE_IP_SALT set and make d1-reset after',
    'see #58 and #59, both in docs/prompt-queue.md line 21',
  ]) {
    assert.deepEqual(redactionFindings(stripRedactions(text)), [], text);
  }
});

test('redaction: the check is total on non-strings rather than throwing', () => {
  for (const x of [null, undefined, 42, {}, []]) assert.deepEqual(redactionFindings(x), []);
  assert.equal(stripRedactions(null), '');
});

/**
 * The site's copy of the redaction rules must be THE SAME FILE. The desk shows a verdict
 * live under the sentence field and the worker refuses on the same rules; if the two
 * drift, the desk tells the operator a sentence is fine and the worker rejects it, or
 * worse, the other way around.
 *
 * Same shape as the C2.1 drift test above, and it fails rather than skips for the same
 * reason: js/redact.js belongs to the site workstream, and a skipped contract test is a
 * contract test that never runs again.
 */
test('the site and the worker share one copy of the redaction rules', () => {
  const worker = readFileSync(join(SRC, 'redact.js'), 'utf8');
  let site;
  try {
    site = readFileSync(join(SITE, 'redact.js'), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      assert.fail(
        'projects/balise-site/js/redact.js does not exist yet, so the desk cannot show the\n' +
        '  redaction verdict the worker enforces. It is a BYTE-IDENTICAL copy of\n' +
        '  worker/src/redact.js, which is written to have no imports for exactly this reason:\n' +
        '    cp worker/src/redact.js js/redact.js\n' +
        '  Do not edit the copy and do not hand-port it. Until it exists this failure is the\n' +
        '  point: it is the only thing that would notice the desk and the worker disagreeing.',
      );
    }
    throw err;
  }
  assert.equal(site, worker, 'js/redact.js has drifted from worker/src/redact.js; re-copy it');
});

