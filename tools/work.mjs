#!/usr/bin/env node
// The runner's side of the Balise work queue, and the operator's terminal view of it
// (docs/DESIGN-WORK-QUEUE.md section 8; the protocol that drives it is
// .claude/commands/work.md in the monorepo).
//
//   node tools/work.mjs backlog
//   node tools/work.mjs claim --runner mac
//   node tools/work.mjs submit <id> --run RUN --outcome fixed --summary-file result.md \
//     --needs-landing --ref balise-site#balise/1a2b3c4d-a1@abc1234
//
// Every command but list and backlog prints exactly ONE JSON envelope, the Worker's own
// answer passed through. The usual reader is an agent following the protocol, and one shape
// on stdout is what an agent parses reliably. list and backlog are for a person.
//
// THE TOKEN IS NEVER AN ARGUMENT, because argv is visible to anyone who can run ps. It is
// $BALISE_WORK_TOKEN, else the macOS Keychain item `balise-automation`, which is where the
// release script puts it so an unattended run keeps no token in a file or a shell profile.
//
// backlog IS THE SANITIZED VIEW. From each row it prints the published sentence or the
// importer's suggestion, and nothing else: never the body, the private ref, the
// instruction, the page address or the contact. Every line also goes back through the
// redaction floor on the way out, because a suggestion is a machine's draft and was never a
// person's decision.
//
// FREE TEXT TRAVELS IN FILES. --note, --suggest and --text each have a -file form, and
// anything an item said goes through it: inside double quotes the shell runs a backtick or
// $( ) before this tool ever sees the argument, so no check in here could catch it.
//
// Exit codes: 0 the Worker said ok · 1 it said not ok, or could not be reached · 2 usage.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { redactionFindings } from '../worker/src/redact.js';
import { cleanSuggestion } from '../worker/src/suggestion.js';

const DEFAULT_API = 'http://127.0.0.1:8877';
const KEYCHAIN_SERVICE = 'balise-automation';
const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_PAGES_MAX = 10;
const BACKLOG_PAGES_MAX = 20;
const TITLE_MAX = 90;
const RESOLVED_WINDOW_DAYS = 30;

const COMMANDS = ['list', 'backlog', 'show', 'claim', 'heartbeat', 'release', 'submit', 'land', 'file'];
const LIST_STATES = ['active', 'approved', 'claimed', 'review', 'accepted', 'done'];
const STATE_LABEL = { approved: 'Waiting', claimed: 'Running', review: 'Needs review', accepted: 'To land', done: 'Done' };

const VALUE_FLAGS = new Set([
  '--api', '--state', '--runner', '--id', '--lease', '--run', '--note', '--note-file', '--outcome',
  '--summary-file', '--evidence-file', '--ref', '--suggest', '--suggest-file', '--text', '--text-file',
]);
const BOOLEAN_FLAGS = new Set(['--json', '--all', '--needs-landing', '--landed', '--failed', '--help', '-h']);
const FILE_FLAGS = ['--summary-file', '--evidence-file', '--note-file', '--suggest-file', '--text-file'];
/** The flags that also come in a -file form. */
const TEXT_FLAGS = ['--note', '--suggest', '--text'];
/** The commands whose one positional argument is the item id. The rest take none. */
const ITEM_COMMANDS = new Set(['show', 'heartbeat', 'release', 'submit', 'land']);

/** The Worker's own ref patterns (worker/src/validate-work.js), joined into one argument. */
const REF_RE = /^([A-Za-z0-9._-]{1,100})(?:#([A-Za-z0-9._/-]{1,120}))?(?:@([0-9a-fA-F]{7,40}))?$/;

/** Drafts `backlog` lists before it counts the rest; --all lists every one. */
const DRAFTS_SHOWN = 10;

const HELP = `work: the Balise work queue from a terminal.

  list      [--state ${LIST_STATES.join('|')}] [--json]
  backlog   [--all] [--json]           every open item, one sanitized line each
  show      <id>
  claim     --runner NAME [--id ID] [--lease SECONDS]
  heartbeat <id> --run RUN [--lease SECONDS]
  release   <id> --run RUN [--note TEXT | --note-file F]
  submit    <id> --run RUN --outcome O --summary-file F [--evidence-file F]
            [--ref R]... [--needs-landing] [--suggest TEXT | --suggest-file F]
  land      <id> --run RUN (--landed | --failed) [--note TEXT | --note-file F] [--ref R]...
            (--failed needs the note)
  file      (--text TEXT | --text-file F) [--suggest TEXT | --suggest-file F]

  --ref is repo@commit, repo#branch or repo#branch@commit.
  A file argument of - reads stdin, and only one per call can be -. Text that came from an
  item goes in a file, never in an argument: the shell runs a backtick or $( ) inside
  double quotes before this tool starts.
  --api picks the Worker; else $BALISE_API; else ${DEFAULT_API}.

  The token is $BALISE_WORK_TOKEN, else the macOS Keychain item ${KEYCHAIN_SERVICE}.
  It is never read from an argument.`;

// ── Arguments ─────────────────────────────────────────────────────────────────
//
// Every usage error is raised as Usage and turned into exit 2 in one place, and all of them
// happen BEFORE the token is looked up: a typo never costs a Keychain prompt, and never
// reaches the Worker, where five wrong tries lock the desk for fifteen minutes.

class Usage extends Error {}
const usage = (message) => {
  throw new Usage(message);
};

const camel = (flag) => flag.replace(/^-+/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseRef(text) {
  const m = REF_RE.exec(text);
  if (!m || (!m[2] && !m[3])) usage(`--ref ${JSON.stringify(text)} is not repo@commit, repo#branch or repo#branch@commit.`);
  return { repo: m[1], ...(m[2] ? { branch: m[2] } : {}), ...(m[3] ? { commit: m[3].toLowerCase() } : {}) };
}

function parseArgs(argv) {
  const opts = { positional: [], refs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (BOOLEAN_FLAGS.has(arg)) {
      opts[camel(arg)] = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) usage(`${arg} needs a value.`);
      // A forgotten value would otherwise swallow the next flag: `--suggest --needs-landing`
      // sent that flag as the sentence and dropped needs_landing. Other dash-led text is
      // still a value.
      if (VALUE_FLAGS.has(value) || BOOLEAN_FLAGS.has(value)) usage(`${arg} needs a value, and the next argument is the flag ${value}.`);
      i += 1;
      if (arg === '--ref') opts.refs.push(parseRef(value));
      else opts[camel(arg)] = value;
    } else if (arg.startsWith('-') && arg !== '-') {
      usage(`Unknown flag ${arg}.`);
    } else {
      opts.positional.push(arg);
    }
  }
  // Both checked before any file is read, so neither can leave the command waiting on a
  // stdin that is never going to be used.
  for (const flag of TEXT_FLAGS) {
    if (opts[camel(flag)] !== undefined && opts[camel(`${flag}-file`)] !== undefined) usage(`Give ${flag} or ${flag}-file, not both.`);
  }
  const fromStdin = FILE_FLAGS.filter((flag) => opts[camel(flag)] === '-');
  if (fromStdin.length > 1) usage(`Only one file argument can be -, and ${fromStdin.join(' and ')} both are.`);
  return opts;
}

/** A word left over is usually the rest of an unquoted note, and dropping it sent "lease"
 *  for `--note lease ran out`. */
function checkPositionals(opts, command) {
  const takes = ITEM_COMMANDS.has(command) ? 1 : 0;
  const extra = opts.positional.slice(1 + takes);
  if (!extra.length) return;
  const hint = {
    claim: ' A named item is claimed with --id.',
    release: ' A note goes in a file, through --note-file.',
    land: ' A note goes in a file, through --note-file.',
    submit: ' A sentence goes in a file, through --suggest-file.',
    file: ' Text goes in a file, through --text-file and --suggest-file.',
  }[command] || '';
  usage(`${command} takes ${takes ? 'only the item id' : 'no item id'}, and ${JSON.stringify(extra.join(' '))} was left over.${hint}`);
}

function required(opts, key, flag) {
  if (opts[key] === undefined || opts[key] === '') usage(`${flag} is required here.`);
  return opts[key];
}

function itemId(opts, command) {
  const id = opts.positional[1];
  if (!id) usage(`${command} needs the item id: node tools/work.mjs ${command} <id> ...`);
  return encodeURIComponent(id);
}

function leaseSeconds(opts) {
  if (opts.lease === undefined) return undefined;
  const seconds = Number(opts.lease);
  if (!Number.isInteger(seconds) || seconds <= 0) usage('--lease is a whole number of seconds.');
  return seconds;
}

/** parseArgs has already refused a second -, so stdin is read at most once. */
function readText(path, flag) {
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (err) {
    return usage(`${flag} ${JSON.stringify(path)} could not be read (${err.code || err.message}).`);
  }
}

/** The text of a flag, or of its -file form; undefined when neither was given. */
function textOrFile(opts, flag) {
  const file = opts[camel(`${flag}-file`)];
  return file === undefined ? opts[camel(flag)] : readText(file, `${flag}-file`);
}

const compact = (body) => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));

/** What a command will send, fully checked, or a marker for the two reading commands. */
function plan(command, opts) {
  switch (command) {
    case 'list':
      if (opts.state && !LIST_STATES.includes(opts.state)) usage(`--state ${opts.state} is not one of ${LIST_STATES.join(', ')}.`);
      return { read: 'list' };
    case 'backlog':
      return { read: 'backlog' };
    case 'show':
      return { method: 'GET', path: `/work/${itemId(opts, command)}` };
    case 'claim':
      // A blank id is how an unset shell variable arrives, and the Worker reads it as no id:
      // it would claim the oldest approval rather than the item this command meant.
      if (opts.id !== undefined && !opts.id.trim()) usage('--id needs an item id. Leave --id out to claim the oldest approval.');
      return {
        method: 'POST',
        path: '/work/claim',
        body: compact({ runner: required(opts, 'runner', '--runner'), id: opts.id, lease_seconds: leaseSeconds(opts) }),
      };
    case 'heartbeat':
      return {
        method: 'POST',
        path: `/work/${itemId(opts, command)}/heartbeat`,
        body: compact({ run: required(opts, 'run', '--run'), lease_seconds: leaseSeconds(opts) }),
      };
    case 'release': {
      const path = `/work/${itemId(opts, command)}/release`;
      const run = required(opts, 'run', '--run');
      return { method: 'POST', path, body: compact({ run, note: textOrFile(opts, '--note') }) };
    }
    case 'submit': {
      const path = `/work/${itemId(opts, command)}/submit`;
      const body = {
        run: required(opts, 'run', '--run'),
        outcome: required(opts, 'outcome', '--outcome'),
        summary: readText(required(opts, 'summaryFile', '--summary-file'), '--summary-file'),
      };
      if (opts.evidenceFile) body.evidence = readText(opts.evidenceFile, '--evidence-file');
      if (opts.refs.length) body.refs = opts.refs;
      if (opts.needsLanding) body.needs_landing = true;
      const suggested = textOrFile(opts, '--suggest');
      if (suggested && suggested.trim()) body.suggested_note = suggested;
      return { method: 'POST', path, body };
    }
    case 'land': {
      const path = `/work/${itemId(opts, command)}/land`;
      if (Boolean(opts.landed) === Boolean(opts.failed)) usage('land needs exactly one of --landed or --failed.');
      const run = required(opts, 'run', '--run');
      const note = textOrFile(opts, '--note');
      if (opts.failed && !(note || '').trim()) usage('--failed needs --note or --note-file saying what stopped the landing.');
      return {
        method: 'POST',
        path,
        body: compact({ run, landed: Boolean(opts.landed), refs: opts.refs.length ? opts.refs : undefined, note }),
      };
    }
    case 'file': {
      const text = textOrFile(opts, '--text');
      if (!text) usage('file needs exactly one of --text or --text-file.');
      return { method: 'POST', path: '/work/items', body: compact({ text, suggested: textOrFile(opts, '--suggest') }) };
    }
    default:
      return usage(`Unknown command ${command}.`);
  }
}

// ── The Worker ────────────────────────────────────────────────────────────────

function resolveToken() {
  const fromEnv = (process.env.BALISE_WORK_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin') {
    try {
      const fromKeychain = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15_000,
      }).trim();
      if (fromKeychain) return fromKeychain;
    } catch {
      // Not stored there. Falls through to the usage error, which names both sources.
    }
  }
  return usage(`No token. Set BALISE_WORK_TOKEN, or store the automation token in the macOS Keychain as ${KEYCHAIN_SERVICE}.`);
}

/** One request, one envelope. Never throws: a network failure is an envelope too. */
async function request(api, token, method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    const why = (err.cause && err.cause.code) || err.message;
    return { ok: false, code: 'NETWORK', provider: '', message: `Balise could not be reached at ${api}.`, hint: `${why}. Is the Worker running there?` };
  }
  try {
    const payload = await res.json();
    if (payload && typeof payload.ok === 'boolean') return payload;
  } catch {
    // Not JSON. Reported below with the status, which is the useful part.
  }
  return {
    ok: false,
    code: 'BAD_ENVELOPE',
    provider: '',
    message: `${method} ${path} answered ${res.status} with something that was not the envelope.`,
    hint: 'Point --api at the Worker, not at the site.',
  };
}

const emit = (envelope) => {
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  return envelope.ok ? 0 : 1;
};

/** Every page of a keyset list, up to a cap, or the first envelope that was not ok. */
async function collect(api, token, base, key, maxPages) {
  const rows = [];
  let before = null;
  let last = null;
  for (let page = 0; page < maxPages; page += 1) {
    // Handed back exactly as the Worker gave it, and encoded: /work's cursor is
    // "<work_updated_at>:<id>", and an id is not ours to assume is URL-safe.
    const cursor = before === null ? '' : `&before=${encodeURIComponent(before)}`;
    const answer = await request(api, token, 'GET', `${base}${cursor}`);
    if (!answer.ok) return { error: answer };
    rows.push(...(answer[key] || []));
    last = answer;
    if (!answer.next) return { rows, last, complete: true };
    before = answer.next;
  }
  return { rows, last, complete: false };
}

// ── The two reading commands ──────────────────────────────────────────────────

const ageDays = (ms, now) => (typeof ms === 'number' && ms > 0 ? Math.max(0, Math.floor((now - ms) / DAY_MS)) : null);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** The private queue, one line an item. The title can fall back to the body, which is fine
 *  for the operator's own terminal and is exactly why `backlog` does not use it. */
async function list(api, token, opts) {
  const state = opts.state || 'active';
  const got = await collect(api, token, `/work?state=${state}&limit=50`, 'items', LIST_PAGES_MAX);
  if (got.error) return emit(got.error);
  const counts = got.last.counts || {};
  if (opts.json) return emit({ ok: true, provider: 'desk', items: got.rows, counts, complete: got.complete });

  const now = Date.now();
  console.log(['review', 'claimed', 'approved', 'accepted', 'done'].map((s) => `${STATE_LABEL[s].toLowerCase()} ${counts[s] || 0}`).join('   '));
  if (!got.rows.length) console.log('  nothing in this list');
  for (const item of got.rows) {
    const work = item.work || {};
    const age = ageDays(work.updated_at, now);
    console.log([
      `  ${item.id.slice(0, 8)}`,
      (STATE_LABEL[work.state] || String(work.state)).padEnd(12),
      String(work.mode || '').padEnd(11),
      `${work.attempts}/${work.max_attempts}`,
      `${age === null ? '-' : age}d`.padStart(4),
      clip(item.title || '', TITLE_MAX),
    ].join('  '));
  }
  if (!got.complete) console.log(`  (stopped after ${LIST_PAGES_MAX} pages)`);
  return 0;
}

/**
 * The one line the sanitized backlog may show for a row, and the two sources are not
 * treated alike.
 *
 * A published note is a PERSON'S decision that already cleared the floor at publish time,
 * so it prints whole; if it trips the floor here, that is worth saying rather than papering
 * over, because the floor's rules have grown since some notes were written. A suggestion is
 * a MACHINE'S draft, so it goes through the same rule as everywhere else (#81): as much of
 * its opening as needs no cut, and otherwise nothing. This used to strip both, which is how
 * a whole board of backlog lines came to read like "(closeMenu in)".
 */
function sentence(row) {
  const published = (row.public_note || '').replace(/\s+/g, ' ').trim();
  if (published) return redactionFindings(published).length ? '(published sentence trips the floor)' : published;
  return cleanSuggestion(row.suggested) || '(no sentence yet)';
}

/** In the order a person catching up wants them: what needs them, what is moving, what is
 *  public, what is finished, and last the drafts. A row lands in the first group it fits. */
const GROUPS = [
  ['Needs review', (row) => row.work && row.work.state === 'review'],
  ['Running', (row) => row.work && row.work.state === 'claimed'],
  ['Waiting for a runner', (row) => row.work && row.work.state === 'approved'],
  ['To land', (row) => row.work && row.work.state === 'accepted'],
  ['Published open', (row) => row.status === 'accepted'],
  [`Resolved in the last ${RESOLVED_WINDOW_DAYS} days`, (row, now) => row.status === 'fixed' && row.fixed_at >= now - RESOLVED_WINDOW_DAYS * DAY_MS],
  ['Drafts', (row) => row.status === 'new' || row.status === 'triaged'],
];

async function backlog(api, token, opts) {
  const got = await collect(api, token, '/reports?kind=open&limit=50', 'reports', BACKLOG_PAGES_MAX);
  if (got.error) return emit(got.error);

  const now = Date.now();
  const placed = new Set();
  const groups = GROUPS.map(([name, fits]) => {
    const rows = got.rows.filter((row) => !placed.has(row.id) && fits(row, now));
    rows.forEach((row) => placed.add(row.id));
    // Three fields and no fourth, in both output modes. Adding one here is how this view
    // would start carrying what the desk keeps private.
    return { name, items: rows.map((row) => ({ id: row.id, age_days: ageDays(row.opened_at || row.created_at, now), text: sentence(row) })) };
  });

  if (opts.json) return emit({ ok: true, provider: 'desk', groups, complete: got.complete });

  const shown = groups.filter((group) => group.items.length);
  if (!shown.length) console.log('Nothing open.');
  for (const group of shown) {
    console.log(`\n${group.name} (${group.items.length})`);
    // Drafts are the long tail: measured 89 of 92 rows on a real import, and a wall of them
    // buries the few lines that need a person. The newest few stand in for the rest unless
    // --all asks for every one; --json always carries them all.
    const cap = group.name === 'Drafts' && !opts.all ? DRAFTS_SHOWN : group.items.length;
    for (const item of group.items.slice(0, cap)) {
      console.log(`  ${item.id.slice(0, 8)}  ${`${item.age_days === null ? '-' : item.age_days}d`.padStart(5)}  ${item.text}`);
    }
    if (group.items.length > cap) console.log(`  ... and ${group.items.length - cap} more (--all lists them)`);
  }
  if (!got.complete) console.log(`\n(stopped after ${BACKLOG_PAGES_MAX} pages)`);
  return 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let opts;
  let action;
  let api;
  let token;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help || opts.h) {
      console.log(HELP);
      return 0;
    }
    const command = opts.positional[0];
    if (!command) usage('No command given.');
    if (!COMMANDS.includes(command)) usage(`Unknown command ${command}. The commands are ${COMMANDS.join(', ')}.`);
    checkPositionals(opts, command);
    api = (opts.api || process.env.BALISE_API || DEFAULT_API).replace(/\/+$/, '');
    if (!/^https?:\/\//.test(api)) usage(`--api needs a full URL, got ${JSON.stringify(api)}.`);
    action = plan(command, opts);
    token = resolveToken();
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`work: ${err.message}\n\nRun node tools/work.mjs --help for the commands.`);
      return 2;
    }
    throw err;
  }

  if (action.read === 'list') return list(api, token, opts);
  if (action.read === 'backlog') return backlog(api, token, opts);
  return emit(await request(api, token, action.method, action.path, action.body));
}

// exitCode and never exit(): exit() drops whatever a pipe has not drained yet, which on
// macOS is everything past the first 64 KB of an envelope, and the last key goes first.
main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error('work: unexpected failure');
  console.error(err);
  process.exitCode = 1;
});
