#!/usr/bin/env node
// Read the fleet's internal trackers, and put a PRIVATE draft in the Balise desk for
// every open item and every item that has just closed. Queue #58.
//
// THIS SCRIPT CANNOT PUBLISH ANYTHING, and that is the whole design. It writes rows at
// status 'new', which is private on both feeds; the credential it holds is refused every
// transition on this kind; and the sentence a reader eventually sees is typed by the
// operator at the desk, checked again by src/redact.js on the way in. The trackers name
// file paths, line numbers, tracker ids and the occasional credential-shaped finding, and
// publishing any of that verbatim would hand a reader a map of the fleet's soft spots.
// So the machine's job stops at "here is something worth saying", and the saying is a
// person's.
//
// Cannot publish is not the same as harmless: the automation token it holds also reads every
// report and can plant a draft the desk trusts like an import (worker/src/routes-open.js).
//
// Run it from anywhere; it reads the monorepo, not the working directory:
//
//   export BALISE_IMPORT_TOKEN=...            # the AUTOMATION token, printed by make worker-dev
//   node tools/import-open-items.mjs --dry-run
//   node tools/import-open-items.mjs --source queue
//
// Flags:
//   --api URL       default http://127.0.0.1:8877; production is passed by hand
//   --source NAME   queue | brief | harness | registry | all (default all)
//   --dry-run       print every batch and send nothing
//   --root DIR      the monorepo root; default three levels up from this file
//
// The token comes from the environment and NEVER from an argument, because argv is
// visible to anyone who can run ps.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactionFindings, stripRedactions } from '../worker/src/redact.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(HERE, '..', '..', '..');
const DEFAULT_API = 'http://127.0.0.1:8877';

/** Matches the worker's IMPORT_BATCH_MAX, which is a query budget and not a size one. */
const BATCH_MAX = 25;
/** Bytes. The worker refuses a body over 8 KB before reading it; this leaves headroom. */
const BODY_BUDGET = 7000;
/** How much of a tracker line is kept as the private body of a draft. */
const TEXT_MAX = 2000;
/** How long a suggested direction may be before it stops being one sentence. */
const SUGGESTION_MAX = 240;
/** Open runs asked of run.py in one read. Far more than a ledger holds open; a read that
 *  comes back this full may have been cut short, and is refused rather than synced. */
const HARNESS_LIST_LIMIT = 1000;
/** The task a runner gives its own harness record (.claude/commands/work.md). */
const RUNNER_TASK_RE = /^balise-work [0-9a-f]{8}: /;

const SOURCES = ['queue', 'brief', 'harness', 'registry'];

/** Every flag this script knows, so a value that is one of them reads as a forgotten value. */
const FLAGS = new Set(['--api', '--source', '--root', '--dry-run', '--help', '-h']);

// ── Arguments ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { api: DEFAULT_API, source: 'all', dryRun: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--api') opts.api = flagValue(argv, ++i, arg);
    else if (arg === '--source') opts.source = flagValue(argv, ++i, arg);
    else if (arg === '--root') opts.root = flagValue(argv, ++i, arg);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else die(`Unknown argument: ${arg}. Run with --help.`);
  }
  if (opts.source !== 'all' && !SOURCES.includes(opts.source)) {
    die(`Unknown source: ${opts.source}. The sources are ${SOURCES.join(', ')}, or all.`);
  }
  if (!opts.api || !/^https?:\/\//.test(opts.api)) die(`--api needs a full URL, got ${JSON.stringify(opts.api)}.`);
  return opts;
}

/** The value after a flag, or a usage error. A trailing --source read as a source named undefined,
 *  a trailing --root failed every tracker in path.join, and a blank one read the working directory. */
function flagValue(argv, i, flag) {
  const value = argv[i];
  if (value === undefined || !value.trim()) die(`${flag} needs a value.`);
  if (FLAGS.has(value)) die(`${flag} needs a value, and the next argument is the flag ${value}.`);
  return value;
}

const die = (message) => {
  console.error(`import-open-items: ${message}`);
  process.exit(2);
};

// ── Shared helpers ────────────────────────────────────────────────────────────

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** Midnight UTC of a YYYY-MM-DD date, in milliseconds. The board shows days, not times. */
function dayMs(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The draft direction the desk will prefill: the first sentence of the tracker text with
 * every redaction match cut out.
 *
 * It is a STARTING POINT and nothing more. A stripped sentence can still be a map (drop
 * the path from "the auth guard at x.js:12 never fires" and it still says which guard is
 * inert), so the operator rewrites it and the worker checks whatever they type. A
 * suggestion that still trips the check after stripping is returned EMPTY rather than
 * prefilled: half a redacted sentence in the box is worse than an empty box, because it
 * invites an edit instead of a rewrite.
 */
function suggest(text) {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0] || text;
  const plain = firstSentence
    // The trackers are Markdown and the board is not. Backticks and bold markers would
    // arrive in the desk field as literal characters for the operator to delete by hand.
    // The underscore is deliberately NOT in this class: stripping it would turn a secret's
    // name into one unbroken word and walk it straight past the variable-name rule.
    .replace(/[`*]{1,2}/g, '')
    // An em or en dash, written as an escape so this file does not carry one. The fleet's
    // writing rule applies to a sentence a machine drafted for a person as much as to one
    // a person typed.
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\s+/g, ' ');
  const stripped = stripRedactions(plain).slice(0, SUGGESTION_MAX).trim();
  if (!stripped) return '';
  return redactionFindings(stripped).length ? '' : stripped;
}

const item = (ref, text, { opened_at = null, closed_at = null, suggested } = {}) => ({
  ref,
  text: text.slice(0, TEXT_MAX),
  suggested: suggested === undefined ? suggest(text) : suggested,
  opened_at,
  closed_at,
});

// ── Source: the prompt queue ──────────────────────────────────────────────────

/**
 * One line per item is what docs/prompt-queue.md's own format promises, and this parser
 * takes it at its word: a paragraph that happens to follow an item line is not attributed
 * to it, because several of them belong to no item at all.
 *
 * A `## Done` line carries `opened -> closed`, and closing an item is the entry this
 * board exists to show, so those are imported too and arrive already carrying the date
 * they closed on, or on the import's own time when that date does not parse.
 */
function readQueue(root) {
  const path = join(root, 'docs', 'prompt-queue.md');
  if (!existsSync(path)) throw new Error(`no prompt queue at ${path}`);
  const items = [];
  let section = '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      continue;
    }
    const m = /^-\s+`(#\d+)`\s+·\s+(\d{4}-\d{2}-\d{2})(?:\s+.\s+(\d{4}-\d{2}-\d{2}))?\s+·\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, ref, opened, closed, text] = m;
    const isDone = section === 'done';
    items.push(item(ref, text.trim(), {
      opened_at: dayMs(opened),
      closed_at: isDone ? (dayMs(closed || opened) ?? Date.now()) : null,
    }));
  }
  return items;
}

// ── Source: the .forge briefs ─────────────────────────────────────────────────

/**
 * The bullets under `## Open` (and `## Still open`, which no brief writes today) in every
 * project's brief. A block that carries the `_Closed ..._` marker yields nothing: the
 * brief itself is saying that section is settled.
 *
 * The ref is the project plus a hash of the normalised bullet, so REWORDING a bullet
 * closes the old item and opens a new one. That is deliberate and it is the honest
 * reading: the file no longer says what the old item said, and pretending a reworded line
 * is the same line would let a change of meaning slip past the desk unnoticed.
 */
function readBriefs(root) {
  const projects = join(root, 'projects');
  if (!existsSync(projects)) throw new Error(`no projects directory at ${projects}`);
  const items = [];
  for (const project of readdirSync(projects).sort()) {
    const path = join(projects, project, '.forge', 'brief.md');
    if (!existsSync(path)) continue;
    for (const bullet of openBullets(readFileSync(path, 'utf8'))) {
      const normalised = bullet.toLowerCase().replace(/\s+/g, ' ').trim();
      items.push(item(`${project}:${sha(normalised).slice(0, 12)}`, `${project}: ${bullet}`));
    }
  }
  return items;
}

function openBullets(markdown) {
  const lines = markdown.split('\n');
  const bullets = [];
  let inBlock = false;
  let block = [];
  const flush = () => {
    if (block.length && !block.some((l) => /^_Closed\b/.test(l.trim()))) {
      bullets.push(...bulletsIn(block));
    }
    block = [];
  };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush();
      inBlock = /^##\s+(still\s+)?open\s*$/i.test(line.trim());
      continue;
    }
    if (inBlock) block.push(line);
  }
  flush();
  return bullets;
}

/** Top level bullets only, with their continuation lines folded in. */
function bulletsIn(block) {
  const out = [];
  let current = null;
  for (const raw of block) {
    const line = raw.replace(/<!--[\s\S]*?-->/g, '');
    const start = /^[-*]\s+(.*)$/.exec(line);
    if (start) {
      if (current) out.push(current);
      current = start[1];
      continue;
    }
    if (current !== null && /^\s+\S/.test(line)) current += ` ${line.trim()}`;
    else if (current !== null && !line.trim()) { out.push(current); current = null; }
  }
  if (current) out.push(current);
  return out
    .map((b) => b.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim())
    // A bullet that opens with a strikethrough is the brief saying that one is settled
    // while leaving it on the page as a record. Importing it would put a finished item in
    // the queue as though it were open, which is the one thing this board must not do.
    .filter((b) => b.length > 3 && !b.startsWith('~~'));
}

// ── Source: the harness ledger ────────────────────────────────────────────────

/**
 * Open runs only. A run that has moved to passed, blocked or abandoned is simply absent
 * from the ref list, and POST /open-items/sync closes it: that is what the sync route is
 * for, and it means this parser never has to reason about which terminal states count.
 *
 * That reading is only true of a COMPLETE list. run.py lists the newest 20 runs of any
 * status unless told otherwise, so an open run with twenty newer runs above it went missing,
 * and a sync carrying the newer open runs closed its draft for good. So the status is asked
 * of run.py, and a read that reaches the limit is refused whole.
 *
 * There are zero open runs on this machine today, so this path is exercised by a fixture
 * in the worker tests rather than by the real ledger.
 */
function readHarness(root) {
  const script = join(root, 'neorgon-harness', 'bin', 'run.py');
  if (!existsSync(script)) throw new Error(`no harness at ${script}`);
  let out;
  try {
    const args = [script, 'list', '--status', 'open', '--limit', String(HARNESS_LIST_LIMIT)];
    out = execFileSync('python3', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  } catch (err) {
    throw new Error(`the harness ledger did not answer: ${err.message}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(out);
  } catch {
    throw new Error('the harness ledger did not print JSON');
  }
  if (!envelope || envelope.ok !== true || !Array.isArray(envelope.runs)) {
    throw new Error('the harness ledger answered with something this script could not read');
  }
  if (envelope.runs.length >= HARNESS_LIST_LIMIT) {
    throw new Error(`the harness ledger returned ${envelope.runs.length} open runs, the most one read asks for, so the list may be cut short`);
  }
  return envelope.runs
    .filter((run) => run.status === 'open')
    // A runner working a Balise item opens its own harness record in this shape. Importing
    // it would put the work back into the queue as a fresh draft of itself, so those runs
    // belong to the work queue and are left there. The whole shape, not the prefix, so a
    // person's own "balise-worker ..." task is still imported.
    .filter((run) => !RUNNER_TASK_RE.test(String(run.task || '')))
    .map((run) => item(String(run.id), String(run.task || run.id), {
      opened_at: run.started_at ? Date.parse(`${run.started_at}Z`) || null : null,
    }));
}

// ── Source: the registry ──────────────────────────────────────────────────────

/**
 * Sites at lifecycle `ready`: a domain is assigned and nothing is served there.
 *
 * This is the one source whose suggestion the machine can write well, because the fact is
 * the whole item and there is no defect to leak. It still goes into the desk as a draft
 * like everything else.
 */
function readRegistry(root) {
  const path = join(root, 'docs', 'site-registry.json');
  if (!existsSync(path)) throw new Error(`no registry at ${path}`);
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  const sites = Array.isArray(registry.sites) ? registry.sites : [];
  return sites
    .filter((s) => s.lifecycle === 'ready')
    .map((s) => {
      const name = s.display_name || s.id;
      const suggested = `${name} has an address and is not served there yet.`;
      return item(String(s.id), `${s.id} (${s.domain || 'no domain'}): ${s.description || ''}`.trim(), {
        suggested: redactionFindings(suggested).length ? '' : suggested,
      });
    });
}

const READERS = { queue: readQueue, brief: readBriefs, harness: readHarness, registry: readRegistry };

// ── Sending ───────────────────────────────────────────────────────────────────

/**
 * Batches of at most 25 items AND at most 7 KB. The count is the worker's query budget;
 * the bytes are its request cap. One tracker line can be two thousand characters, so a
 * flat 25 would be four times over the cap on the queue and exactly at it on the registry:
 * both limits are real and the smaller one wins per batch.
 */
function batches(source, items) {
  const out = [];
  let current = [];
  const size = (list) => Buffer.byteLength(JSON.stringify({ v: 1, source, items: list }), 'utf8');
  for (const entry of items) {
    if (current.length && (current.length >= BATCH_MAX || size([...current, entry]) > BODY_BUDGET)) {
      out.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length) out.push(current);
  return out;
}

async function post(api, path, token, body) {
  let res;
  try {
    res = await fetch(api + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, code: 'NETWORK', message: `Balise could not be reached at ${api}.`, hint: err.message };
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, code: 'BAD_ENVELOPE', message: `${path} answered ${res.status} with something that was not JSON.`, hint: 'Point --api at the worker, not at the site.' };
  }
  return payload;
}

// ── The run ───────────────────────────────────────────────────────────────────

const HELP = `import-open-items: read the fleet's trackers into the Balise desk as PRIVATE drafts.

  --api URL       the worker (default ${DEFAULT_API})
  --source NAME   ${SOURCES.join(' | ')} | all
  --dry-run       print every batch and send nothing
  --root DIR      the monorepo root

  BALISE_IMPORT_TOKEN must hold the automation token. Nothing this script does is public.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const token = process.env.BALISE_IMPORT_TOKEN || '';
  if (!token && !opts.dryRun) {
    die('BALISE_IMPORT_TOKEN is not set. It is read from the environment and never from an argument, because argv is visible to ps.');
  }

  const wanted = opts.source === 'all' ? SOURCES : [opts.source];
  const totals = { created: 0, unchanged: 0, closed: 0, reopened: 0 };
  const suggestions = [];
  let failed = 0;

  for (const source of wanted) {
    let items;
    try {
      items = READERS[source](opts.root);
    } catch (err) {
      console.error(`  ${source}: could not be read (${err.message}); NOT syncing it, so nothing of that source is closed`);
      failed += 1;
      continue;
    }

    for (const entry of items) if (entry.suggested) suggestions.push(`${source}  ${entry.suggested}`);

    if (!items.length) {
      console.log(`  ${source}: nothing open`);
      continue;
    }

    const groups = batches(source, items);
    if (opts.dryRun) {
      console.log(`  ${source}: ${items.length} items in ${groups.length} batches, sending nothing`);
      for (const group of groups) {
        for (const entry of group) {
          const when = entry.closed_at ? 'closed' : 'open  ';
          console.log(`    ${when} ${entry.ref}  ${entry.suggested || '(no clean suggestion; the operator writes it)'}`);
        }
      }
      continue;
    }

    let sent = 0;
    let bad = false;
    const counts = { created: 0, unchanged: 0, closed: 0, reopened: 0 };
    for (const group of groups) {
      const answer = await post(opts.api, '/open-items', token, { v: 1, source, items: group });
      if (!answer || answer.ok !== true) {
        console.error(`  ${source}: ${answer.code} ${answer.message}`);
        if (answer.hint) console.error(`    ${answer.hint}`);
        bad = true;
        break;
      }
      counts.created += answer.created;
      counts.unchanged += answer.unchanged;
      counts.closed += answer.closed;
      // Close marks this batch cleared, on rows the tracker lists as open again; older Workers omit it.
      counts.reopened += answer.reopened || 0;
      sent += group.length;
    }

    if (bad) {
      failed += 1;
      console.error(`  ${source}: stopped after ${sent} of ${items.length} items; NOT syncing, so nothing is closed on a half-read source`);
      continue;
    }

    // Sync is a decision made from an ABSENCE: everything of this source that is not in
    // the ref list is marked as having left its tracker. A partial list would therefore
    // close items that are still open, so it is all of them or none of them. It never clears
    // a mark, so a close made in error heals in a later run's batches and not here.
    const refs = items.map((entry) => entry.ref);
    const refBytes = Buffer.byteLength(JSON.stringify({ source, refs }), 'utf8');
    if (refBytes > BODY_BUDGET) {
      console.error(`  ${source}: ${refs.length} refs is ${refBytes} bytes, over the request cap; NOT syncing, so nothing is closed from a partial list`);
      failed += 1;
    } else {
      const synced = await post(opts.api, '/open-items/sync', token, { source, refs });
      if (!synced || synced.ok !== true) {
        console.error(`  ${source}: sync failed, ${synced.code} ${synced.message}`);
        failed += 1;
      } else {
        counts.closed += synced.closed;
      }
    }

    console.log(`  ${source}: ${counts.created} created / ${counts.unchanged} unchanged / ${counts.closed} closed / ${counts.reopened} reopened  (${items.length} read)`);
    totals.created += counts.created;
    totals.unchanged += counts.unchanged;
    totals.closed += counts.closed;
    totals.reopened += counts.reopened;
  }

  if (!opts.dryRun) {
    console.log(`\n  total: ${totals.created} created / ${totals.unchanged} unchanged / ${totals.closed} closed / ${totals.reopened} reopened`);
  }

  // Three suggestions, so whoever ran this can see what kind of sentence arrived without
  // opening the desk. They are DRAFTS. Every one of them is private until a person opens
  // the desk, rewrites it in their own words, and publishes it.
  if (suggestions.length) {
    console.log('\n  Three suggested directions (drafts, private, rewritten by the operator):');
    for (const line of suggestions.slice(0, 3)) console.log(`    ${line}`);
  }

  return failed ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('import-open-items: unexpected failure');
  console.error(err);
  process.exit(1);
});
