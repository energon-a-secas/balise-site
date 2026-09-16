# Balise open-items board: design

Queue `#58`. The importer writes PRIVATE drafts, the operator writes the PUBLIC sentence,
and nothing reaches the board that a person did not type. Read with `README.md` and
`docs/architecture/balise.md`; contract names are the archived Balise contracts
(`docs/delivery/archive/2026-08-29-balise/CONTRACTS.md`).

## 1. A second kind, not a second surface

An open item is a report of `kind = 'open'` in the existing `reports` table. The desk,
the C3 token gate and lockout, the C4 transition guard, the C5 rendering rule and the
keyset paging all apply unchanged. A separate table was rejected: it needs a second list
route, a second transition table and a second card renderer, and the spec's own hint is
right that a kind is far less code. `KINDS` in `validate.js` stays `wrong, missing,
broken, other`, so `kind = 'open'` is only ever written by the import route (section 4).

## 2. D1 change

`worker/migrations/0001_baseline.sql` (today's `schema.sql`, verbatim) and
`0002_open_items.sql`, applied by a new `make d1-migrate` target that spells out `--local`.
`schema.sql` is the baseline alone: `tests/open-items.test.mjs` asserts it is still `0001` byte
for byte, and checks with `PRAGMA table_info` that the migrations build the columns below. The
migrations are the store's shape.

Columns reused: `kind` (`'open'`), `status` (C4 vocabulary), `body` (the source text,
private, same protection as a stranger's text), `public_note` (the public direction),
`fixed_at` (resolution time), `public`, `duplicate_of`, `fingerprint`
(`sha256` of `open`, the source and the source ref, NUL separated: the existing UNIQUE index is
the idempotency guard, and a batch reads which of its fingerprints exist before it writes, so a
repeat run of a batch is one read and no write).

Columns added, all NULL for corrections:

| column | meaning |
|---|---|
| `source` | `queue`, `brief`, `harness`, `registry` |
| `source_ref` | private key inside the source: `#58`, `bouquin-site:3f9a…`, a run id, a site id. Never selected by a public query |
| `suggested` | the importer's draft direction, already stripped (section 4); prefills the desk field |
| `opened_at` | the date the board shows for an open entry: the queue date, a run's `started_at`, otherwise first import |
| `source_closed_at` | set when the item left its source (a `closed_at` in an import, or a sync that no longer lists the ref); cleared by an import that sends the ref as open again (section 4) |

Index: `reports_board ON (kind, public, status)`; the board's two queries stay inside the
four-per-request budget.

Status meaning for `kind = 'open'`: `new` draft, private · `accepted` published as OPEN ·
`fixed` published as RESOLVED · `rejected` kept private · `duplicate` as today. The human
table gains one kind-scoped edge, `new -> fixed`, so an item whose source closed before it
was ever published becomes a resolution in one move instead of flashing as open for a
cache period. The automation credential gets no edge at all on this kind: `PATCH` from
actor `ai` on an open item is `BAD_TRANSITION`. Recorded as amendment A7 alongside the one
change to C4's frozen query: `/log` gains `AND kind <> 'open'`, so a resolved open item
appears on the board and not in the corrections log.

## 3. The redaction check

`worker/src/redact.js`, pure, exported as `redactionFindings(text)` returning a list of
`{ rule, match }`. Rules: a file path (two segments joined by `/`, or a word ending in
`.js .mjs .py .md .html .css .toml .yaml .yml .sql .sh`), a line number (`:NN` after a
word, `line NN`), a hash id (`#` followed by digits), an env-var name (`[A-Z0-9]{3,}_[A-Z0-9_]+`),
a harness run id (`YYYY-MM-DD-` followed by a slug), a `make` target, and a
credential-shaped token (24+ base64url characters, 32+ hex, `ghp_`, `sk-`, `AKIA`,
`Bearer `, `token=`). It is applied in three places and it is the same code each time:

1. the import route, to `suggested` (a suggestion that still matches is stored empty);
2. `PATCH /reports/:id` when `public_note` is set on a `kind = 'open'` row: any finding is
   refused as `BAD_FIELD` naming the rule and the match, an existing code so the C2.1 drift
   test stays green;
3. the desk, live under the sentence field, from `js/redact.js`, a byte-identical copy
   that `worker/tests/api.test.mjs` asserts equal to the worker file, the same drift test
   pattern as `HANDLED_CODES`.

The check is a floor, not a judgement: it cannot tell a harmless sentence from one that
quietly maps a soft spot, and that stays the operator's reading.

## 4. The importer

`tools/import-open-items.mjs`, Node 18, no dependencies, run by the operator from the
monorepo root. Token from `BALISE_IMPORT_TOKEN` only, never an argument (argv is visible to
`ps`). It holds the automation credential, because no separate import credential exists: the
routes below cannot publish, so a leaked import token cannot either, but the same token reads
every report and can plant a draft the desk trusts like an import (`DESIGN-WORK-QUEUE.md`
section 10). Flags: `--api` (default `http://127.0.0.1:8877`; production is passed by hand),
`--source` (one, or `all`), `--dry-run` (prints every batch and sends nothing), `--root`
(default: three levels up). A value flag given last, or followed by another flag or a blank
value, is a usage error with exit 2, before anything is read.

Sources, and the private ref each produces:

- **queue**: `docs/prompt-queue.md`. `## Queue` lines are open with the line's date as
  `opened_at`; `## Done` lines carry `opened -> closed` and close with that date. Ref `#N`.
- **brief**: every `projects/*/.forge/brief.md`, the bullets under `## Open` (also
  `## Still open` if one ever appears; today no brief uses those words). Ref
  `<project>:<12 hex of the normalised bullet>`, so a reworded bullet closes the old ref
  and opens a new one, which is honest about what the file says. `opened_at` is first import.
- **harness**: `python3 neorgon-harness/bin/run.py list`, runs with `status = 'open'`.
  Ref the run id, text the task, `opened_at` its `started_at`; closes when the status
  becomes `passed`, `blocked` or `abandoned`. Zero open runs today, so the test is a fixture.
- **registry**: `docs/site-registry.json`, `lifecycle = 'ready'` (four today). Ref the
  site id; the suggestion is the one template the importer can write well: "<display
  name> has an address and is not served there yet". Closes when the lifecycle changes.

The suggested direction for free-text sources is the first sentence of the source text
with every redaction match removed and whitespace collapsed. It is a starting point the
operator overwrites, and the publish-time check treats it as untrusted anyway.

Requests, batched at 25 items and 7 KB (the Worker's query budget and its 8 KB body cap):
`POST /open-items` per batch, then one `POST /open-items/sync` per source with every ref
seen, `## Done` lines included. A source that failed to read, or whose batches did not all go
through, is not synced. The script prints `created / unchanged / closed / reopened` per source
and in total, exits non-zero on any envelope error, and never publishes.

**Closed at source, and open again.** A row is marked closed at its source by an import that
sends its ref with a `closed_at`, or by a sync that no longer lists the ref. Only an import
clears the mark: an item it sends with no `closed_at` while its row is marked gets
`source_closed_at` set back to NULL, and nothing else on the row, and counts as `reopened`. A
sync never clears one, because its list is every ref the importer saw, `## Done` lines
included, so being listed is no evidence of being open. So a wrong close, from a sync that left
refs out or a `closed_at` sent by mistake, heals on the next import that lists the item as open,
while a ref its tracker no longer lists stays closed. A `## Done` line always arrives closed:
when its date does not parse, the import's own time stands in, because an item sent with no
`closed_at` would read as open again. An import marks only a row that is not marked and never
rewrites a mark, so a `## Done` line gives its row the date its tracker closed it on only when
nothing marked the row first. After a sync or a mistaken `closed_at`, with no import listing
the item as open in between, the row keeps that earlier date, and so does the desk. A sync
with an empty `refs` list is refused with `MISSING_PARAM`, but one naming a single ref still
closes every other row of its source until that next import.

## 5. The desk flow

`desk.html` gains a kind toggle next to the status filters: `Corrections` (today's list)
and `Open items`, sent as `?kind=` on `GET /reports`. The open-item card, in a new
`js/desk-open.js` (desk.js stays under the cap): status badge, source label and private
ref, `opened_at`, a `Source closed <date>` mark when set, the source text collapsed under
`<details>`, a `<textarea>` prefilled with `suggested`, the live redaction verdict, then the
legal moves as buttons: `Publish as open`, `Publish as resolved`, `Keep private`,
`Duplicate of`. Both publish moves send the textarea as `public_note` and are disabled
while the client check reports a finding; the worker refuses regardless. Rejected cards
keep the two publish moves so a sentence can be reconsidered. No `window.prompt` here:
the sentence is the whole entry, so it is edited in place.

## 6. The public board

`index.html` gains two tabs above the log, `Corrections` and `Open items`, default
Corrections; `#open` in the URL selects the board so the link is what gets shared. The board
is `GET /board`: `{ resolved: [...], open: [...] }`, each entry `{ text, state, date }` and
nothing else (no site, no ref, no source). Resolved first, newest first, the newest carrying
a `Latest resolution` label and the accent border; then Open, newest first. Each entry is
one line: state, the sentence, the date. `js/board.js` renders through `elem()` and
`setText()` only. Tokens used are the ones `style.css` already draws from the CDN base
(`--accent`, `--border`, `--text-muted`, `--space-*`, `--radius-sm`). English only, which is
what every page of this site does today.

## 7. Worker routes

| Route | Auth | Notes |
|---|---|---|
| `POST /open-items` | Bearer, either credential | `{ v:1, source, items:[{ ref, text, opened_at, closed_at? }] }`, max 25; upsert by fingerprint; returns `{ source, created, unchanged, closed, reopened }`, each item counted once |
| `POST /open-items/sync` | Bearer, either credential | `{ source, refs:[...] }`, at least one ref (`400 MISSING_PARAM` otherwise); sets `source_closed_at` on that source's rows whose ref is absent, clears none; returns `{ source, closed }` |
| `GET /reports?kind=` | Bearer | existing list, `kind` validated against `KINDS` plus `open` |
| `PATCH /reports/:id` | Bearer | existing; kind-scoped transitions and the redaction refusal |
| `GET /board` | none, `max-age=300`, any origin (A8) | the two arrays above, `SELECT public_note, status, opened_at, fixed_at, source_closed_at, work_state` and no other column |

`/health.config` gains `automation_token`. Files: `worker/src/store-open.js` (the second
file with SQL; `store.js`'s header says so), `worker/src/routes-open.js`, and the Turnstile
block moves from `index.js` to `worker/src/turnstile.js`, which puts `index.js` (513 lines
today) back under the cap.

## 8. Strings

Public: tabs `Corrections`, `Open items`; lede "What the fleet is working on, one line
each, and what it has closed. Written by the person doing the work."; states `Resolved`,
`Open`; `Latest resolution`; empty "Nothing is listed yet."; loading "Loading the board…".
Desk: `Open items`, `Publish as open`, `Publish as resolved`, `Keep private`, `Source
closed`, `Source text`, verdict "Clear to publish" / "Contains a <rule>: <match>". Worker:
"That sentence contains a <rule> (<match>) and the board never shows one." with hint
"Say what is being done, not where. Rewrite it and publish again."

## 9. Out of scope

Running the importer on a schedule; any automated publish; editing a published sentence
without a status change; a per-site board or a feed; the AI triage job; the corrections
flow's `window.prompt`; Spanish strings; the beacon kit; deploy and the remote migration.
