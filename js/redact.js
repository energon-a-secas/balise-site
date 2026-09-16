// The redaction floor for the open-items board (queue #58).
//
// The board publishes a DIRECTION and never a defect site. The internal trackers it is
// fed from do the opposite: they name file paths and line numbers, tracker ids, run ids,
// the exact command that reproduces a thing, and occasionally a credential-shaped
// finding. Published verbatim, that is a map of the fleet's soft spots.
//
// THIS FILE IS A FLOOR, NOT A JUDGEMENT. It catches the shapes a machine can recognise.
// It cannot tell a harmless sentence from one that quietly says which door is unlocked,
// and it is not allowed to try: the operator's reading is the real check, and this runs
// underneath it so that a slip of the paste buffer cannot reach a public page.
//
// It has NO imports, touches no browser API and no Workers API, and is pure. That is a
// requirement, not a style: `js/redact.js` on the site is a BYTE-IDENTICAL copy of this
// file, so the desk shows the same verdict the Worker will enforce, and
// `worker/tests/api.test.mjs` asserts the two files are equal. Copy it, never fork it:
//
//     cp worker/src/redact.js js/redact.js
//
// NO REGEX LOOKBEHIND, anywhere in this file. Safari before 16.4 cannot parse one, and the
// desk imports this module statically, so a single lookbehind stops the whole desk from
// loading with no message. A rule that needs to look behind matches the character in front
// and declares `group` instead.
//
// Applied in three places, and it is the same code each time:
//   1. every drafted suggestion, through src/suggestion.js, which asks this file which
//      clauses of a machine's sentence carry a finding and keeps the ones before the first
//      that does. It never CUTS: see stripRedactions below for why.
//   2. PATCH /reports/:id, when public_note is set on a kind = 'open' row;
//   3. the desk, live under the sentence field.

const MAKE_STOPLIST = new Set([
  'sure', 'it', 'a', 'an', 'the', 'this', 'that', 'them', 'those', 'these',
  'us', 'you', 'me', 'one', 'more', 'less', 'sense', 'up', 'do', 'its',
  'their', 'my', 'our', 'his', 'her', 'no', 'any', 'some', 'good', 'better',
  'clear', 'clearer', 'room', 'time', 'way', 'progress', 'for', 'of', 'to', 'and',
]);

/**
 * Every rule, in the order a finding is reported. `rule` is a noun phrase that reads
 * after "contains a", because it is shown to a person in exactly that sentence.
 *
 * `filter` narrows a deliberately loose pattern. Where one exists, the comment above it
 * says what it lets through: a rule that fires on good sentences teaches the operator to
 * stop reading it, which costs more than the case it was written for.
 *
 * `group` names the capture that is the finding, for a rule that has to match a character
 * in front of it. The finding, and so the text a strip cuts, is that capture alone.
 */
export const REDACTION_RULES = [
  // Two segments joined by a slash, or a word ending in a source extension. "and/or"
  // matches, and that is the accepted cost: the finding names the match, so the operator
  // sees which two words did it and rewrites four characters.
  { rule: 'file path', re: /\b[\w.-]+\/[\w.-]+/g },
  { rule: 'file path', re: /\b[\w.-]+\.(?:js|mjs|py|md|html|css|toml|yaml|yml|sql|sh)\b/gi },
  // A segment wrapped in slashes and standing on its own, "/auth/". It is what cutting a
  // longer path leaves behind: the first rule takes "packages/neorgon-ui" and cannot start
  // again on the slash it consumed, so "/auth/" survived the strip and read as clean.
  // Measured 2026-09-15 in the work queue's sanitized backlog, on a real import. The
  // character in front has to be one no path segment contains, which keeps this off the
  // inside of a path the first rule already reports, so a path is still one finding.
  { rule: 'file path', re: /(?:^|[^\w.-])(\/[\w.-]+\/)/g, group: 1 },
  // The same remnant with no closing slash: cutting "packages/neorgon-ui" out of
  // "packages/neorgon-ui/beacon" leaves "/beacon". The lookahead hands a segment that goes
  // on into another slash to the rule above, and a colon or slash in front is a URL's
  // scheme, which was never a finding without a path after its host.
  { rule: 'file path', re: /(?:^|[^\w.:\/-])(\/[\w.-]+)(?![\w.\/-])/g, group: 1 },

  // A line number, in both of the shapes the trackers use. The first pattern deliberately
  // does NOT require a word before the colon. Measured while building the importer: cut
  // the path out of "footer/neorgon-footer.js:217" and what is left is "::217", which a
  // rule anchored on a leading word no longer sees, so a stripped sentence carried a line
  // number straight past the second check. A colon followed by digits is the shape,
  // whatever sits in front of it.
  //
  // The RANGE half was measured the same way: the trackers write "js/export.js:210-217",
  // and a pattern that stopped at the first number cut the file name and left "-217"
  // sitting in the sentence.
  { rule: 'line number', re: /\S*:\d{1,6}(?:-\d{1,6})?\b/g },
  // "lines 26-30" as well as "line 217". The trackers cite a block in the plural with a
  // range, and the singular-only pattern let that through into a suggestion that then read
  // as clean. Measured 2026-09-15 in the work queue's sanitized backlog, on a real import.
  { rule: 'line number', re: /\blines?\s+\d+(?:-\d+)?\b/gi },

  // A tracker id. The board carries a date and a sentence; an id is a lookup into a
  // private file, and it is the single most common thing to paste by accident.
  { rule: 'tracker id', re: /#\d+/g },

  // SCREAMING_SNAKE. Nothing in ordinary prose is shaped like this, so it needs no
  // filter, and it catches the name of a secret even when the value is nowhere near it.
  { rule: 'variable name', re: /\b[A-Z0-9]{3,}_[A-Z0-9_]+\b/g },

  // A harness run id: a date followed by a slug. A BARE date is deliberately not a
  // finding, because every entry on the board carries one.
  { rule: 'run id', re: /\b\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*/gi },

  // A make target, which is a command a reader could run. The stoplist is the ordinary
  // English that follows the word "make" in a sentence; without it this rule fires on
  // "make sure" and gets switched off within a week.
  {
    rule: 'make target',
    re: /\bmake\s+(?:-[A-Za-z]\s+\S+|[a-z][a-z0-9-]*)/g,
    filter: (m) => !MAKE_STOPLIST.has(m.replace(/\s+/g, ' ').split(' ')[1]),
  },

  // Named credential prefixes. Cheap, exact, no filter needed.
  { rule: 'credential-shaped string', re: /\bghp_[A-Za-z0-9]+/g },
  { rule: 'credential-shaped string', re: /\bsk-[A-Za-z0-9_-]+/g },
  { rule: 'credential-shaped string', re: /\bAKIA[0-9A-Z]{8,}\b/g },
  { rule: 'credential-shaped string', re: /\bBearer\s+\S+/gi },
  { rule: 'credential-shaped string', re: /\btoken=\S+/gi },

  // A long hex run: a sha, a database id, a fingerprint.
  { rule: 'credential-shaped string', re: /\b[0-9a-f]{32,}\b/gi },

  // A long base64url run. The filter is what makes this usable: an unfiltered 24+ run of
  // the base64url alphabet also matches "fleet-wide-compliance-checker", which is exactly
  // the kind of phrase this board is FOR. A real token carries both a digit and a capital;
  // a hyphenated English phrase carries neither. A token that happens to be all lower
  // case and digit-free is missed, and that is the trade, stated rather than hidden.
  {
    rule: 'credential-shaped string',
    re: /\b[A-Za-z0-9_-]{24,}\b/g,
    filter: (m) => /[0-9]/.test(m) && /[A-Z]/.test(m),
  },
];

/**
 * Every finding in `text`, as { rule, match }, deduplicated on the pair and in rule
 * order. An empty list means the text cleared the floor; it does NOT mean the text is
 * publishable, which is a judgement this file does not make.
 */
export function redactionFindings(text) {
  const subject = typeof text === 'string' ? text : '';
  const out = [];
  const seen = new Set();
  for (const { rule, re, filter, group } of REDACTION_RULES) {
    // A fresh RegExp per call. The module-level literals carry /g, and a shared /g regex
    // keeps lastIndex between calls, so reusing them would make the SECOND call on the
    // same string return different findings from the first.
    const scan = new RegExp(re.source, re.flags);
    let m;
    while ((m = scan.exec(subject)) !== null) {
      if (m[0] === '') { scan.lastIndex += 1; continue; }
      const found = group ? m[group] : m[0];
      if (!found || (filter && !filter(found))) continue;
      const key = `${rule} ${found}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule, match: found });
    }
  }
  return out;
}

/** True when the text carries nothing this file can recognise. */
export function isRedactionClear(text) {
  return redactionFindings(text).length === 0;
}

/** Cutting passes before stripping gives up. Every pass removes at least one match, and
 *  a real tracker line clears in two; the bound is for a pathological string, which should
 *  end with what it has rather than hold a Worker invocation open. */
const STRIP_PASSES = 5;

/**
 * The text with every finding cut out and the whitespace closed up.
 *
 * NEVER USE THIS TO BUILD A SENTENCE A PERSON WILL READ. It built the importer's suggested
 * direction until #81, and the 2026-09-15 import measured what that produces: 89 of 92
 * drafts read like "(closeMenu in)" or "uncommented ()". A sentence with a hole in it is
 * worse than an empty field, because it invites an edit where a rewrite is needed.
 * src/suggestion.js is the rule for a readable draft, and it cuts nothing.
 *
 * What this is for is the ADVERSARY in tests/redact.test.mjs: cutting every finding out and
 * asking whether anything above still fires is how the rules above are shown to leave no
 * remnant behind, which is where two of them came from. Repeated until nothing is found,
 * because a cut can expose a shape that was not a finding before it: cutting
 * "packages/neorgon-ui" out of a longer path leaves "/auth/" or "/beacon" standing.
 *
 * Stripping is not sanitising either way. A sentence can lose its path and still describe
 * the defect precisely enough to be a map, so nothing that comes out of here is trusted.
 */
export function stripRedactions(text) {
  let out = typeof text === 'string' ? text : '';
  for (let pass = 0; pass < STRIP_PASSES; pass += 1) {
    // Longest match first, so cutting a short match cannot split a longer one and leave
    // half of it behind.
    const matches = redactionFindings(out).map((f) => f.match).sort((a, b) => b.length - a.length);
    if (!matches.length) break;
    for (const match of matches) out = out.split(match).join(' ');
  }
  return out
    .replace(/\s+/g, ' ')
    // Punctuation the cut left stranded between two spaces. A semicolon or a comma that
    // still sits against its own word is left alone, so the shape of the sentence
    // survives and only the orphans go.
    .replace(/\s[/:;,.-]+(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .trim();
}
