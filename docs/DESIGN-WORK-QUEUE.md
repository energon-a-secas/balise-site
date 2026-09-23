# Balise work queue: design

The open-items board (`DESIGN-OPEN-ITEMS.md`) made the fleet's backlog something a person
publishes. This makes it something an agent can work. The operator approves an item, a
runner on the operator's Mac claims it, does the work where the code is, and hands a result
back; the operator accepts it, returns it with a note, or drops it. Read with `README.md`
and `DESIGN-OPEN-ITEMS.md`. Contract names are the archived Balise contracts.

**The rule this whole file enforces: automation may do work and report it. Only a person
starts work, judges it, or stops it, and only a person's sentence reaches a reader.**

## 1. Two axes on one row

A row in `reports` already has a publication axis: C4's `status` (`new` draft, `accepted`
published as open, `fixed` published as resolved, and so on). Execution is a second axis,
`work_state`, and the two never share a column.

They are independent in practice. Most work happens on items nobody has published yet, and
an item can be published as open for weeks before anyone hands it to an agent. One column
for both would break C4's frozen tables and change what the board means. So a draft can be
`status = new` and `work_state = review` at the same time, and that is the common case.

`work_state` is NULL for a row that is not in the work queue, which is every row until an
operator approves it.

**The axes meet in one place, from both sides.** While `work_state` is `approved`, `claimed`,
`review` or `accepted`, C4 refuses a move to `fixed`, `rejected`, `spam` or `duplicate`, from
either credential, with `BAD_TRANSITION`. The message names the work state, and the hint says
to withdraw the item from the work queue first or let the result finish. Closing an item an
agent still holds would leave a runner working on, shipping or landing something already
closed. Publishing as open (`accepted`) and `triaged` close nothing and stay allowed, and an
item at `done` closes as it always did.

The other way round, `approve` refuses an item whose status is already one of those four, with
`BAD_TRANSITION` and nothing written. For `fixed` the message is `That item is resolved, so it
cannot be handed to an agent.`, and the hint says fixed is final and follow-up work is a new
item. For the other three it is `That item is closed as "<status>", so it cannot be handed to
an agent.`, and the hint says to reopen it first by moving it to `accepted`, which on an open
item publishes it and needs its sentence. The closed refusal comes after the operator-only and
work-state refusals and before section 3's rules.

Each check is made on the row it reads and made again inside its write. A closing UPDATE also
requires `work_state` to be NULL or outside the four queued states, and approve's UPDATE
requires `status NOT IN ('fixed', 'rejected', 'spam', 'duplicate')`. An approval that commits
between a close's read and its write leaves the close refused with `That report moved while
this change was in flight.`, and a close that commits inside an approval leaves the approval
refused with `That item moved while this change was in flight.`, so no order of requests leaves
a row both closed and queued. The claim itself reads no status: a row an earlier build left in
both states can still be claimed, until someone withdraws it.

## 2. States, modes, actions

**States:** `approved` (waiting for a runner) · `claimed` (a runner holds a lease) ·
`review` (a result is waiting for the operator) · `accepted` (the operator accepted a
result that still has to land) · `done`.

**Modes**, chosen by the operator per approval, default `fix`:

| Mode | The runner may | Lands |
|---|---|---|
| `investigate` | read only: say whether the item is still true, what it would take, whether to close it | nothing to land |
| `fix` | commit on a branch in a git worktree | only after the operator accepts |
| `ship` | commit and land once its own checks pass | before the result is submitted, or not at all: see below |

**Outcomes** a runner reports: `fixed`, `investigated`, `partial`, `blocked`, `failed`.

**A ship run that cannot land a repository** pushes nothing to it. A ship run lands only by
fast-forward, so when `origin/<default>` has moved past its branch's base, or the repository
has no origin, it submits `blocked`: its branch ref, no `needs_landing` (a ship run that sends it is refused with
`BAD_FIELD`), and a summary saying the change is committed, unlanded, and why. In review the
operator can `accept` it, which records the decision and moves the item to `done` with nothing
landed and nothing published; `return` it with a note, for another attempt cut from the new
origin; or `dismiss` it. Its queue line stays open, since the runner closes lines only for
`fixed`, and the desk offers to publish a resolution in the same move only for `fixed`
(section 7). A run that lands one repository and then cannot land the next submits `blocked`
all the same, with both refs, and what it landed stays landed (section 10).

**Actions.** The API is a set of actions, not raw edges, and this table is the whole of it.
`none` means `work_state IS NULL`. It lives in `worker/src/work.js`, pure, and a test asserts
it literally the way `transitions.js` is asserted. The claim's expired-lease case is not in
that table: it lives in the claim's SQL guard.

| Action | From | To | Actor |
|---|---|---|---|
| `approve` | none, approved, done | approved | operator |
| `withdraw` | approved, claimed, review, accepted | none | operator |
| `claim` | approved (or claimed with an expired lease, except in ship mode) | claimed | either |
| `heartbeat` | claimed | claimed | either, lease holder only |
| `release` | claimed | approved | either, lease holder only |
| `submit` | claimed | review | either, lease holder only |
| `accept` | review | accepted if the run needs landing, else done | operator |
| `return` | review | approved | operator |
| `dismiss` | review | none | operator |
| `land` | accepted | done | either, the accepted run only |
| `unland` | accepted | review | either, the accepted run only |

"Either" means the runner's routes take the operator token too, so the loop can be run by
hand. The operator-only actions refuse the automation token with `BAD_TRANSITION`, the code
C4 already uses for a move a role may not make. No new error code is added anywhere in this
design, so C2.1's drift test is untouched.

**Attempts.** `claim` increments `work_attempts`. An item with three attempts is not
claimable; it sits at `approved` and the desk says it needs a person. `approve` from none or
done resets the count; `approve` on an already approved item (an edit of mode or
instruction) keeps it and keeps its place in the queue. Which of the two happens is decided
inside the UPDATE, from the row it writes (`CASE WHEN work_state = 'approved'`), never from a
count read first: a claim and a release landing between the read and the write leave the row
approved again, and writing the earlier count back would erase that claim. `return` and
`release` keep the count, since a returned or released attempt was a real attempt.

**Leases.** Default 1800 seconds, bounds 5 to 7200 (the low bound exists so the suite can
expire one). A claimed item whose lease has passed is claimable again, and the claim that
takes it ends the old run as `expired`. A heartbeat from a run whose lease ran out but whose
item nobody took revives it; one whose item was taken, swept back or withdrawn gets
`BAD_TRANSITION`.

**A lapsed ship lease is never taken over.** A ship run pushes before it submits, so a run
that went silent may already have landed its commit, and a second run handed the item would
ship it again with nothing on record that the first one did. The claim's expired-lease branch
leaves `work_mode = 'ship'` out, so the item waits at `claimed` for a person, who checks the
repository and withdraws it. A claim naming it is refused with `BAD_TRANSITION` saying so. The
run that held it can still heartbeat and submit.

**A lease that lapses on the last attempt.** The attempt cap means no claim ever takes such a
row over, so every claim first sweeps them: it ends their open run as `expired` and moves the
row back to `approved`, where the desk says it needs a person. Ship stays out of the sweep for
the reason above. Until the next claim runs, the item still reads `claimed` with its lease in
the past. The row still names the run the sweep ended, so that run is told what happened and
not only the state: its heartbeat, release or submit gets `BAD_TRANSITION` with `This run's
lease ran out on the item's last attempt, so the item went back to the operator.` and a hint
to stop and leave it to a person, never to claim it. That answer holds only while the item is
still at the cap: once the operator withdraws it and approves it again, neither step touches
`work_run`, but the fresh count makes the item claimable, so the swept run hears the state
refusal instead. A run another claim replaced, or whose item was withdrawn and not approved
again, hears `This run no longer holds that item.`; a run that released its own item hears
the state refusal.

## 3. The safety rules, and why each one exists

Two of them turn on `trust`, which every work item carries: `stranger` when the row's `kind`
is not `open` or its `filed_by` is `ai`, and `fleet` otherwise (`trustOf` in
`worker/src/work.js`). `approvalRule` holds any trust value but `fleet` to a stranger's rules,
so a wrong value fails closed.

1. **A stranger's item needs the operator's instruction.** `approve` on a `stranger` item
   requires an `instruction` of 10 characters or more once trimmed, or `BAD_FIELD`. A reader's
   report is a stranger's text, and so, as far as anyone can tell, is an item automation
   filed: a runner that read a correction may have written its follow-up in that reader's
   words. A runner has repository write access, so that text reaches it as quoted data with
   `trust: "stranger"`, never as what it was told to do. This is the same boundary the public
   note already is, applied in the other direction.
2. **A stranger's item never ships.** `mode = ship` on one is `BAD_FIELD`. A change a
   stranger's text influenced lands only after a person has read the diff.
3. **Automation cannot approve.** `POST /work/items` with an `approve` block and the
   automation token is refused before anything is written. A follow-up a runner files is a
   private draft like any import, recorded as `filed_by = 'ai'`, so rules 1 and 2 hold for it.
4. **The runner never sees what it does not need.** No `/work` response carries `contact`,
   `ip_hash` or `fingerprint`. That is a property of these routes and not of the credential:
   `GET /reports` answers either token, and its correction rows do carry `contact`.
5. **A drafted sentence is still only a draft.** A runner may send `suggested_note`, the
   resolution sentence it would write. It is kept only for `kind = 'open'`, held to the
   clauses that clear the redaction floor by `src/suggestion.js`, stored empty when that
   leaves less than a direction, and it only ever prefills the desk field. A correction's
   `suggested_note` is dropped: an AI paraphrase of a stranger's report never prefills a
   public note (A6's reasoning, unchanged). The `suggested` sentence of `POST /work/items`
   goes through the same rule, and so does the import route's, so a draft cannot depend on
   which of the four wrote it (queue `#81`; `docs/DESIGN-OPEN-ITEMS.md` section 4 states the
   rule and what it replaced).
6. **Nothing here publishes.** No work action writes `status`, `public_note` or `public`.
   Publishing stays `PATCH /reports/:id`, a person, and the redaction floor. On that route, a
   patch from the automation token that carries `public`, `public_note` or `fixed_ref` is
   refused with `BAD_FIELD` after the transition check, on every edge, so what a reader sees
   stays with a person whatever is steering the token.
7. **Closing waits for the work queue.** Section 1: while an agent holds an item, neither
   credential can resolve, reject or close it, and a closed item is never handed to an agent.

## 4. D1: `migrations/0003_work.sql`

Columns on `reports`, all NULL (or 0) for every existing row:

| column | meaning |
|---|---|
| `work_state` | section 2, NULL when not in the queue |
| `work_mode` | `investigate`, `fix`, `ship` |
| `work_instruction` | the operator's words; optional on a `fleet` item, required on a `stranger` item |
| `work_run` | the id of the current or latest run |
| `work_attempts` | `INTEGER NOT NULL DEFAULT 0` |
| `work_lease_until` | ms, NULL unless claimed |
| `work_approved_at` | ms, queue order |
| `work_updated_at` | ms, list order and, with the id, the cursor |
| `filed_by` | `human` or `ai` for an item filed through `POST /work/items`, from the credential that filed it; NULL for an import or a reader's report |

Table `work_runs`, append-only in spirit, one row per claim: `id`, `report_id`, `attempt`,
`runner`, `mode`, `instruction` (a snapshot of what the runner was told), `claimed_at`,
`heartbeat_at`, `lease_until`, `ended_at`, `end_reason` (`submitted`, `released`, `expired`,
`withdrawn`), `outcome`, `summary`, `evidence`, `refs` (JSON), `needs_landing` (0 or 1),
`suggested_note`, `review` (`accepted`, `returned`, `dismissed`), `review_note`,
`reviewed_at`, `landed_at`, `land_note`.

Indexes, every one partial or narrow so the corrections and board queries are untouched:
`reports_work_updated (work_state, work_updated_at DESC) WHERE work_state IS NOT NULL`, which
serves the Work list, the claim's pick and its sweep, and the count per state;
`reports_work_run (work_run) WHERE work_run IS NOT NULL`, for the lease check and the claim's
read-back; `work_runs_report (report_id, claimed_at DESC)`, for an item's run history and its
`last_review_note`. There is no index on the queue order (`work_state, work_approved_at`): no
query used one, since SQLite answers the claim's two-state pick from two seeks on
`reports_work_updated` and a sort.

Applied by `make d1-migrate`, which spells out `--local`, like 0002. 0003 was edited in place
before its first release to add `filed_by` and drop the unused index. Wrangler records an
applied migration by file name and never runs it twice, so a local database that applied the
earlier 0003 has no `filed_by` column: `make d1-reset` rebuilds it.

**A migration is frozen once the remote records it, not once anything has applied it.** While
production has not applied a file, editing it in place is the right move: there is one
statement of the shape, and a numbered patch on top of an unreleased file makes the store's
history a puzzle for no benefit. The cost is local, and it falls on the one machine that
already applied the older text, so the local database is what gets rebuilt. Once
`scripts/release-work-queue.sh` has applied a file to `--remote`, that file is closed and any
further change is a new numbered migration. So: no `0004` for `filed_by`, and `0004` for
whatever comes after the release.

**What made this expensive was not the edit, it was the silence.** `make d1-migrate` answered
"No migrations to apply!" about a database with no `filed_by` column, and the operator met
the difference days later as a 502 `STORE_ERROR` from every `GET /reports` (queue #82). So
`d1-migrate` now ends with `make d1-check`, which compares the local database's tables and
columns against the migrations applied to an in-memory SQLite, and names `make d1-reset` when
they disagree. `tools/d1-drift.mjs` owns both halves and `worker/tests/d1-drift.test.mjs`
trips it, including on exactly the `reports.filed_by` case. Tables and columns only: D1's
authorizer refuses `pragma_index_list`, and every index here is `CREATE INDEX IF NOT EXISTS`,
so re-applying a migration restores a missing index while a column added by an `ALTER` never
comes back on its own.

## 5. Routes

Every `/work` route: `Authorization: Bearer`, provider `desk`, `Cache-Control: no-store`, the
same lockout as the desk. SQL lives in `worker/src/store-work.js` (the reads, filing, and
every action a person takes) and `worker/src/store-work-runner.js` (every action a runner
takes), split by who acts when one file passed the line cap; shape checks in
`worker/src/validate-work.js`; the routes in `worker/src/routes-work.js`. Authentication moves
from `index.js` to `worker/src/auth.js` so `index.js` stays under the line cap.

A `POST /work` route reads its body up to 64 KB (`WORK_REQUEST_MAX_BYTES` in
`worker/src/validate-work.js`), and only after authentication. Every other route keeps
8 KB. The field caps below do not fit in 8 KB: a summary and evidence at their limits are
8 KB before JSON escapes a single newline. A larger body is `413 TOO_LARGE`, and its message
names the cap in force.

| Route | Actor | Body or query | Answer |
|---|---|---|---|
| `GET /work` | either | `?state=` one state or `active` (default: approved, claimed, review, accepted), `limit` 1 to 50 (25), `before` the previous page's `next` | `{ items, next, counts, rows_read }` |
| `GET /work/:id` | either | none | `{ item }`, the detail shape |
| `POST /work/items` | either; the `approve` block operator only | `{ text, suggested?, approve?: { mode?, instruction? } }` | `{ item }` |
| `POST /work/claim` | either | `{ runner, id?, lease_seconds? }` | `{ item }` (detail, with the new run) or `{ item: null }` |
| `POST /work/:id/approve` | operator | `{ mode?, instruction? }` | `{ item }` |
| `POST /work/:id/withdraw` | operator | `{}` | `{ item }` |
| `POST /work/:id/heartbeat` | either | `{ run, lease_seconds? }` | `{ item }` |
| `POST /work/:id/release` | either | `{ run, note? }` | `{ item }` |
| `POST /work/:id/submit` | either | `{ run, outcome, summary, evidence?, refs?, needs_landing?, suggested_note? }` | `{ item }` |
| `POST /work/:id/review` | operator | `{ decision: accept, return or dismiss, note? }` | `{ item }` |
| `POST /work/:id/land` | either | `{ run, landed, refs?, note? }` | `{ item }` |

POST, not PATCH, because each is an action with rules rather than a field update, and every
action answers with the item as it now stands so a client never needs a second read.

### Shapes

**Item** (lists, and every action's answer):

```jsonc
{
  "id": "…", "kind": "open", "status": "new", "site": "queue",
  "source": "queue", "source_ref": "#58",
  "title": "…",            // public_note, else suggested, else the instruction's first non-empty line,
                           // else the body's first non-empty line; over 140 characters, cut to 139 and an ellipsis
  "public_note": "",
  "trust": "fleet",        // "stranger" when kind is not open, or filed_by is ai
  "last_review_note": "",  // the newest non-empty review_note among all of the item's runs
  "work": {
    "state": "review", "mode": "fix", "instruction": "…", "attempts": 1, "max_attempts": 3,
    "approved_at": 0, "updated_at": 0, "lease_until": null,
    "run": null | {
      "id": "…", "attempt": 1, "runner": "mac", "mode": "fix",
      "claimed_at": 0, "heartbeat_at": 0, "lease_until": 0, "ended_at": 0, "end_reason": "submitted",
      "outcome": "fixed", "summary": "…", "evidence": "…",
      "refs": [{ "repo": "balise-site", "branch": "balise/1a2b3c4d-a1", "commit": "abc1234" }],
      "needs_landing": true, "suggested_note": "…",
      "review": null, "review_note": "", "reviewed_at": null, "landed_at": null, "land_note": ""
    }
  }
}
```

`last_review_note` is read by a correlated subquery inside the item's own SELECT, so a list is
still one query, and a card still says why the last attempt went back while the next one runs
and the current run's own `review_note` is empty.

**Detail** (`GET /work/:id` and `claim`) is the item plus `body`, `url`, `target`, `suggested`,
`opened_at`, `source_closed_at` and `runs` (up to 10, newest first, each with the
`instruction` it was claimed under).

`counts` is `{ approved, claimed, review, accepted, done }` over the whole queue, from one
aggregate query, so the desk can label its filters without a request per filter.

`next` is the string `"<work_updated_at>:<id>"` of the page's last item, or `null`. The list is
ordered `work_updated_at DESC, id DESC`, and a later page adds
`work_updated_at < ? OR (work_updated_at = ? AND id < ?)`. The id is there because two
requests in one millisecond stamp the same `work_updated_at`, and a page break between them
lost one. `before` accepts only that form (up to 16 digits, a colon, and an id of at most 64
characters); anything else is `BAD_FIELD`. A client passes `next` back verbatim and
URL-encoded. The query also carries `work_updated_at <= ?` in front of that OR, which changes
no result and lets SQLite seek the index instead of walking every newer row of the state.

`GET /reports` rows gain `work: null | { state, mode, attempts, updated_at }`, so a desk card
knows it is already in the queue, and `filed_by: null | "human" | "ai"`.

### Validation

`runner` is `^[a-z0-9][a-z0-9-]{0,39}$`. `text` 10 to 4000 characters. `instruction` up to
2000. `summary` 1 to 4000, `evidence` up to 4000, `note` up to 2000, `suggested` and
`suggested_note` up to 500. `refs` at most 20, each `{ repo, branch?, commit? }` with
`repo` `^[A-Za-z0-9._-]{1,100}$`, `branch` `^[A-Za-z0-9._/-]{1,120}$`, `commit`
`^[0-9a-f]{7,40}$`, and at least one of branch or commit. Every text limit is counted after
trimming, in UTF-16 units as JavaScript counts a string, so an emoji counts as two.

Submit rules by mode: `investigate` accepts only `investigated`, `blocked`, `failed` and never
`needs_landing`; `ship` never sends `needs_landing`, because it lands before it submits or
submits `blocked` (section 2); `fix` may, and `needs_landing: true` requires at least one ref.
`return` requires a note of 3 characters or more, because a returned attempt with nothing new
to go on repeats itself. `land` with `landed: false` requires a note of 3 characters or more
saying why.

A direct item gets `kind = 'open'`, `source = 'direct'`, `site = 'direct'`,
`source_ref = 'd-' + 8 hex`, `status = 'new'`, `opened_at = now`, `filed_by` from the
credential (`human` for the operator's, `ai` for anything else), and the fingerprint
`sha256('open', 'direct', normalised text)`, so a runner filing the same follow-up twice gets
`DUPLICATE`. Its `created_at` is one past the newest open item's, or `now` if that is later,
computed inside the INSERT itself: the desk pages open items by keyset on `created_at`, and
two filings that each read the newest value first could take the same one. An import batch's
INSERTs take theirs the same way, so a filing that lands in the middle of an import cannot share
one with an imported row either. `direct` is not in the importer's source list, so the import
and sync routes refuse it and a sync can never close a direct item by its absence.

### The claim, atomically

One `db.batch()`, which D1 runs as a single transaction and rolls back whole if any statement
fails (cited, D1 Worker API reference):

1. end, as `expired`, the open run of every row that is `claimed` past its lease, at the
   attempt cap, and not in ship mode;
2. move those rows back to `approved`, lease cleared;
3. `UPDATE reports SET work_state = 'claimed', work_run = ?, work_lease_until = ?,
   work_attempts = work_attempts + 1, work_updated_at = ? WHERE id = (SELECT id … claimable …
   ORDER BY work_approved_at LIMIT 1) AND <claimable>`, with the new run id generated first;
4. end any other still-open run of the row just claimed as `expired`;
5. `INSERT INTO work_runs … SELECT … FROM reports WHERE work_run = ? AND work_state = 'claimed'`.

The guard repeated outside the subquery is what makes two runners safe: the second one's
UPDATE matches nothing. `changes = 0` on the third statement means nothing was claimable, and
a claim that named an item then says why: another run holds it, its ship lease lapsed, its
attempts are used up, or its state takes no claim. It uses no `RETURNING`, because D1's
documentation does not describe it and the row is read back by `work_run` instead.

### Every other two-row action

`withdraw`, `review`, `heartbeat`, `release`, `submit` and `land` each write the report and
its run in one batch. The second statement runs only where the row holds the state the first
produced AND the `work_updated_at` the first stamped, the same `now` bound again. The state
alone let a request refused on its first statement still write its second whenever another
request had produced that state, a return racing a withdraw and a fresh approval being one.
Land's second statement also requires `needs_landing = 1` and `review = 'accepted'`, so an
item finished by any other road takes no landing. `approve` is a single statement.

## 6. Public surfaces

**The board.** `GET /board` entries keep exactly three fields. An open entry's `state`
becomes `in_progress` when its row is `work_state` claimed, review or accepted. An older
client falls back to "Open", which `board.js` already does for an unknown state. The SELECT
adds `work_state`, which says whether something is moving and nothing about what or where.

**The counts.** `GET /board/summary`, public, `max-age=300`:

```jsonc
{ "ok": true, "provider": "log", "window_days": 30,
  "open": 3, "in_progress": 1, "resolved": 5,
  "latest": { "text": "…", "date": "2026-09-14" } | null, "rows_read": 0 }
```

`open` counts published open entries including the ones in progress; `resolved` counts
resolutions in the last 30 days; `latest` is the newest resolution, a sentence already on
the board. Drafts are never counted: a number that moved when a private draft moved would
be a side channel into the desk. Neither is a resolution kept private (`fixed` with
`public = 0`, which only a raw `PATCH` with `public: false` makes): it is not counted, never
`latest`, and not on `GET /board`.

**Amendment A8, C2.2.** `GET /board` and `GET /board/summary` answer any origin with
`Access-Control-Allow-Origin: *` and skip the origin gate, on every answer the two routes
build, a refusal or a store error (`502 STORE_ERROR`) included. Two Worker-wide answers on
those paths keep the allowlist's headers: `501 NOT_CONFIGURED` when no D1 is bound, and the
last-resort `502` for an exception nothing else caught. The allowlist holds three
origins, so no other section of the fleet could read them otherwise, and both routes never
read `Authorization` and serve only published sentences. Every other route keeps the
allowlist exactly as it is.

## 7. The desk

`desk.html` gains a third feed button, `Work`. In that view the status filters are replaced
by work filters with counts: `Needs review`, `Waiting`, `Running`, `To land`, `Done`,
`All active`. Above the list, a `New item` form: the text, and an optional `Hand to an agent
now` block with the mode and the instruction. The operator files it, so it is a `fleet` item
and all three modes are offered.

A work card (`js/desk-work.js`, with the run's half in `js/desk-run.js`) shows the state, mode,
attempt count, source and ref, the title, the instruction, and for a run its outcome, summary,
evidence, refs, `land_note` and review note; when the current run has none, it shows the item's
`last_review_note`. A result whose commits are still only on their branch, with nothing in
Balise left to land them, says so in the warning colour: `Not landed: these commits are still
only on their branch, and nothing in Balise lands them.` That is a run with refs, no
`needs_landing` and no `landed_at`, in fix mode (a repository with no origin, or an attempt that
stopped short) or with the outcome `blocked` (a ship run that could not land). A ship run's
`partial` does not get the line, because it may already have landed what passed its checks. A
stranger's card says the agent reads its text as data and follows only the operator's
instruction, worded for a reader's report or for an item an agent filed.

Its moves follow section 2. `Withdraw` while waiting, running or waiting to land. `Accept`,
`Dismiss` and `Send it back with a note` in review. `Reopen` when done, which approves again
with the same mode and instruction and a fresh count. A waiting item offers `Change the mode
or instruction`, which keeps its place and its count; at the attempt cap that would change
nothing a runner can act on, so `Try again` opens it with the button `Hand over again`, which
withdraws and approves, the one way the count starts over. A running item whose lease has
passed says what that means for it: in ship mode, that no runner takes it again and the
repository needs checking before a withdraw; at the cap, that the next claim puts it back in
Waiting; otherwise, that another run can take it. An open item at `new` or `accepted` also
offers the sentence field, prefilled with `suggested_note`, under the same live redaction
verdict as the open card: `Accept and publish as resolved` in review, only when the outcome is
`fixed`, the run needs no landing and it is not unlanded, and `Publish as resolved` when done.
A `blocked`, `partial` or unlanded result is accepted on its own first; once done, its card
still offers `Publish as resolved`, under the not-landed line when that applies.

An item whose status is closed (`fixed`, `rejected`, `spam` or `duplicate`) is offered no move
that approves, since the Worker refuses the approval (section 1). A Done card has no `Reopen`,
and a Waiting card has no `Try again` and no `Change the mode or instruction`, and keeps
`Withdraw`. In their place the card says `Resolved, so no agent takes it again: file follow-up
work as a new item.` for `fixed`, and `Closed, so no agent takes it: reopen it first.` for the
other three.

`Hand over again` (withdraw, then approve) and `Accept and publish as resolved` (accept, then
the `PATCH`) are two calls. When the second is refused with anything but `UNAUTHORIZED`, the
desk reloads the list and says which half happened, `Withdrawn, but not handed over again.` or
`The result was accepted, but the sentence was not published.`, then the refusal and where the
item is now: its card under Open items or Corrections after a withdrawal, under Done, with the
typed sentence kept, after an accept. Focus, which the rebuild drops, goes to the item's
rebuilt card when it is on screen and to the error otherwise. When the second call answers
`UNAUTHORIZED`, the desk goes to the sign-in gate as it does for any refused token, keeps that
sentence in memory only, and shows it once, after the next sign-in loads a list; `Sign out`
forgets it.

Every existing card, corrections and open items alike, gains a collapsed `Hand to an agent`
panel: mode, instruction, `Approve`. On a stranger's item (a correction, or one an agent
filed) the instruction is required, `Approve` waits for 10 characters, `ship` is not offered,
and the panel says why. A card already in the queue shows its work state instead, with a
button that opens the Work view; a done card shows both, and its panel reads `Hand to an agent
again`. A closed card, with no work state or at done, shows the closed line in place of the
panel. While a card's item is approved, claimed, in review or waiting to land, its status
buttons leave out `fixed`, `rejected`, `spam` and `duplicate` and say that resolving or closing
waits: withdraw it in Work first, or let the result finish.

C5 holds throughout: `elem()` and `setText()` only, no `innerHTML`, and the token stays in
`desk.js`'s module scope.

## 8. The runner

**The CLI**, `tools/work.mjs`, Node 18, no dependencies:

```
list      [--state active|approved|claimed|review|accepted|done] [--json]
backlog   [--all] [--json]    every open item, one sanitized line each: never body, never ref;
                              drafts past the newest ten only with --all
show      <id>
claim     --runner NAME [--id ID] [--lease SECONDS]
heartbeat <id> --run RUN [--lease SECONDS]
release   <id> --run RUN [--note TEXT | --note-file F]
submit    <id> --run RUN --outcome O --summary-file F [--evidence-file F]
          [--ref R]... [--needs-landing] [--suggest TEXT | --suggest-file F]
land      <id> --run RUN (--landed | --failed) [--note TEXT | --note-file F] [--ref R]...
file      (--text TEXT | --text-file F) [--suggest TEXT | --suggest-file F]
```

`--ref` is `repo@commit`, `repo#branch` or `repo#branch@commit`. The API is `--api`, else
`$BALISE_API`, else `http://127.0.0.1:8877`. The token is `$BALISE_WORK_TOKEN`, else the
macOS Keychain item `balise-automation`, and never an argument. Every command but `list` and
`backlog` prints exactly one JSON envelope; exit 0 success, 1 an envelope error or no
network, 2 a usage error.

**Text from an item travels in files.** Inside double quotes the shell runs a backtick or
`$( )` before the CLI ever sees the argument, so `--note`, `--suggest` and `--text` each have
a `-file` form, and the runner uses only those. A file argument of `-` reads stdin, and only
one argument per call may be `-`. These are usage errors, and like every usage error they are
raised before the token is looked up, so none costs a Keychain prompt or a request: a value
flag whose value is another known flag (`--suggest --needs-landing` would otherwise send the
flag as the sentence), a word left over after the command's own arguments, `--id` with an
empty value (which the Worker would read as no id, and claim the oldest approval), a flag
given together with its `-file` form, and `land --failed` without a non-blank note. The CLI sets `process.exitCode` instead of
calling `process.exit()`, so an envelope written to a pipe is flushed before it exits. `list`
and `backlog` pass each page's `next` back URL-encoded.

**The protocol**, `.claude/commands/work.md` in the monorepo: land what the operator
accepted, close the queue lines of finished work, claim one item, work it by mode in a
worktree, verify, submit with evidence, file follow-ups as drafts. One item per run bounds
both cost and blast radius. What it holds to:

- Text derived from an item (titles, instructions, notes, summaries, sentences, commit
  messages) never goes inside a shell argument. It is written to a file, with the Write tool
  or a quoted heredoc, and reaches a command through `--summary-file`, `--evidence-file`,
  `--note-file`, `--suggest-file`, `--text-file` or `git commit -F`. The harness `--task` is
  built from the claim JSON with `jq` inside the same block. No shell variable survives
  between tool calls, so every block sets everything it uses.
- Each attempt works on a fresh branch, `balise/<id8>-a<attempt>`, cut from
  `origin/<default>` right after a fetch, in a fresh worktree. An earlier attempt's worktree
  is removed first; its branch stays. A repository with no origin is cut from its local
  default branch, and nothing in it can land: a fix there is submitted without
  `needs_landing`, and ship there is `blocked`. So is a ship run whose `origin/<default>` moved
  past its branch's base: it pushes nothing to that repository, and never rebases or merges to
  land (section 2).
- Landing is serialized by `mkdir ~/.balise/land.lock`, released by a trap. It re-reads the
  item and goes on only while the item is still accepted with the same run. It checks that the
  branch head is the accepted commit and that `origin/<default>` is its ancestor, pushes,
  fetches, confirms `origin/<default>` holds the commit, and only then removes the worktree
  and deletes the branch. A commit already on `origin/<default>` counts as landed. A landing
  that stops part way is reported with `land --failed`, naming exactly which repositories
  landed. Whether the queue line closes is decided before the land call, and only for a queue
  item whose accepted result is `fixed`. The close is committed with
  `git commit --only -- docs/prompt-queue.md`, on `main`, only when that file has no other
  changes, and on top of `origin/main`: the block fetches the monorepo's origin and
  fast-forwards a `main` that is only behind it. A `main` that has diverged or will not
  fast-forward (the merge refuses to overwrite any local file, an ignored one included), an
  origin it cannot fetch, and a `prompt.sh` failure other than its own word
  that no line is open (`No item #N` or `already done`) each leave the line open, and the land
  note says which, quoting the last three lines of a `prompt.sh` failure. The ledger
  `~/.balise/queue-closed` records a run only once its line is closed or has no open line, so a
  line left open for any other reason is tried again on a later run.
- A ship run heartbeats immediately before each push and pushes only if the heartbeat
  succeeds. A refused heartbeat, submit or land call, and a `NETWORK` answer to a submit, send
  the runner to re-read the item before anything else. When this run still holds it (`HELD`),
  it carries on. When the refused call only repeated one that already went through, so the
  item is in review or done under this run, it says so (`SUBMITTED`, `LANDED` or `REPORTED`),
  files nothing, and finishes the run as usual. Only otherwise is the lease lost: when a push
  happened, the runner files a draft with `--text-file` naming the item, the run, and each
  repository and commit it pushed, and says so in its report.
- The runner never runs the importer and never calls `/open-items` (section 10 says why that
  is a mitigation and not a boundary).
- On `UNAUTHORIZED` it writes `~/.balise/runner-stopped` with the time and the reason, and
  stops. Every block that talks to the Worker refuses to while that file exists, and only a
  person removes it: the lockout counts per address, so a runner retrying a stale token on the
  operator's own connection would lock the operator out of the desk.
- A submit stays under the 64 KB cap: the block refuses a summary or evidence over 4000
  characters, a sentence over 500, or a body that would come near 64 KB anyway. It counts as
  the Worker does, after trimming and in UTF-16 units, so the two never disagree about a file.

**The schedule** is a desktop scheduled task on this Mac that runs the protocol against
production. It is created at release, not before, because it has nothing to talk to until
the Worker is deployed.

**The importer** skips harness runs whose task has the exact shape `balise-work `, eight
lowercase hex characters, a colon and a space (`RUNNER_TASK_RE` in
`tools/import-open-items.mjs`), so a runner's own harness record never comes back as a new
draft, while a person's own `balise-worker ...` task is still imported. The runner builds that
task from the claim: `balise-work <id8>: <title>`.

## 9. Out of scope, and ideas not taken yet

Per-site tags on board entries and a markdown snapshot (offered, declined 2026-09-14);
docket reading `/work`; a notification when a result reaches review beyond the scheduled
task's own completion notice; Antenne drafts from resolutions; any automated publish, ever.

## 10. Open, stated rather than hidden

**The automation credential still authorises the import routes.** The importer and the
runner hold one token, and `POST /open-items` and `POST /open-items/sync` take either
credential. Anything steering the runner could use it to:

- **plant a draft under a tracker ref the operator has not written yet.** An import keys a
  row on its source and ref, and reports an existing ref `unchanged` without comparing its
  text, so when the real line arrives the planted body stays. The planted row has no
  `filed_by`, so its trust is `fleet`: it can be handed over in ship mode with no instruction,
  its `suggested` prefills the desk's sentence field, and a landing of it closes the real
  queue line.
- **mark items closed at their source, and clear the mark again,** one ref at a time with
  `closed_at` on an import, or every row of a source a sync leaves out. A sync with an empty
  `refs` list is refused with `MISSING_PARAM`, and that is all it stops: a sync naming one ref
  still closes every other row of its source, and nothing bounds how many one sync closes. The
  next honest import heals that, because a batch that sends a ref with no `closed_at` clears
  its mark and counts it `reopened`; a sync never clears one (`DESIGN-OPEN-ITEMS.md` section 4
  says why). The same route lets the token clear a mark a tracker set, by importing a closed
  ref with no `closed_at`. `source_closed_at` shows only at the desk; the board does not read it.

The protocol no longer calls the importer, which removes the runner's reason to touch those
routes and not its ability to. The fix is a separate import credential, or a record of which
credential created every row, imports included, for trust to read; that is the owner's
decision.

**A ship result that landed part way reads as unlanded.** A ship run across two repositories
that lands one and then cannot land the other submits `blocked` with both refs, and the desk's
not-landed line (section 7) covers both. Only the summary can say which one landed, and the
protocol does not yet require it to.

**One tie the guards do not break.** Section 5's stamp compares milliseconds, so if the
competing request stamped exactly the `now` of the refused one, the refused request's second
statement still matches.
