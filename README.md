<div align="center">

# Balise

Fleet-wide correction reporting: a beacon on every page, one private queue, one public log

[![Live][badge-site]][url-site]
[![HTML5][badge-html]][url-html]
[![CSS3][badge-css]][url-css]
[![JavaScript][badge-js]][url-js]
[![Cloudflare][badge-cf]][url-cf]
[![Claude Code][badge-claude]][url-claude]
[![License][badge-license]](LICENSE)

[badge-site]:    https://img.shields.io/badge/live_site-0063e5?style=for-the-badge&logo=googlechrome&logoColor=white
[badge-html]:    https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white
[badge-css]:     https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white
[badge-js]:      https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black
[badge-cf]:      https://img.shields.io/badge/Cloudflare-F38020?style=for-the-badge&logo=cloudflare&logoColor=white
[badge-claude]:  https://img.shields.io/badge/Claude_Code-CC785C?style=for-the-badge&logo=anthropic&logoColor=white
[badge-license]: https://img.shields.io/badge/license-MIT-404040?style=for-the-badge

[url-site]:   https://balise.neorgon.com/
[url-html]:   #
[url-css]:    #
[url-js]:     #
[url-cf]:     https://workers.cloudflare.com/
[url-claude]: https://claude.ai/code

</div>

---

## Overview

A reader spots something wrong on a Neorgon site. Today their only recourse is a
pull request, and effectively nobody opens one. Balise gives them a beacon in
the corner of the page instead: one click, one sentence, no account.

Reports land in a private queue, because they arrive as raw text from strangers.
An operator triages them. Only what the operator decides to publish reaches the
public log, written in the operator's own words.

The same desk carries a second feed. An importer reads the fleet's own internal
trackers and files a PRIVATE draft per open item; the operator writes the public
sentence. The board that comes out of it is one line each: a direction, a state,
a date. No paths, no line numbers, no ids.

And a third view turns that backlog into work. The operator hands an item to an
agent and chooses how far it may go. A runner on the operator's Mac claims it,
does the work where the code is, and hands the result back to be accepted,
returned with a note, or dropped. The runner can never approve, judge or publish
anything.

**Live:** [balise.neorgon.com](https://balise.neorgon.com/)

---

## Features

- **Public correction log** -- what got reported and what got fixed, each entry
  written by whoever shipped the change
- **Report page** -- opened by the beacon with the page and item already filled
  in, so nobody retypes what they were looking at
- **Operator desk** -- the private queue, filtered by status, with only the
  status changes that are legal from where a report currently sits
- **Open-items board** -- what the fleet is working on and what it has closed,
  imported as drafts from the trackers and published one sentence at a time
- **Work queue** -- hand any item to an agent in one of three modes, watch it run,
  then accept, return with a note, or dismiss the result; a fix lands only after
  you accept it
- **Runner** -- `tools/work.mjs` plus the `/work` command: land what you accepted,
  claim under a lease, heartbeat, submit with evidence, file what it found as a new
  private draft, and pass anything an item said only through a file
- **Sanitized backlog** -- `node tools/work.mjs backlog` prints every open item as
  one publishable line, never a body, a path, a ref or an instruction
- **Board counts** -- `GET /board/summary`, published entries only, readable from
  any origin so other sections of the fleet can show the same line
- **Redaction floor** -- the same rules in the desk and the Worker, refusing a
  path, a line number, a tracker id or a credential-shaped string before it can
  reach a public page
- **Hardened ingest** -- Turnstile, per-address rate limiting, an origin
  allowlist, and an error envelope written to be read by a person
- **Never HTTP 500** -- every failure is JSON with the same five keys

---

## Architecture

Full document: [`docs/architecture/balise.md`](../../docs/architecture/balise.md)
in the monorepo. Frozen contracts: `docs/delivery/archive/2026-08-29-balise/CONTRACTS.md`.

```
projects/balise-site/
├── index.html          the public log and the open-items board
├── report/index.html   where a visitor types
├── desk.html           the operator queue: corrections, open items, work
├── js/
│   ├── api.js          the only file that talks to the Worker; exports HANDLED_CODES
│   ├── log.js          public log rendering
│   ├── board.js        open-items board rendering, and its count line
│   ├── report.js       fragment parsing, C1 validation, payload assembly
│   ├── desk.js         views, transitions, in-memory token
│   ├── desk-open.js    the open-item card and its publish moves
│   ├── desk-work.js    the work card, the hand-over panel, the new-item form
│   ├── desk-run.js     a work card's run: outcome, evidence, refs, the landing lines
│   ├── redact.js       a byte-identical copy of worker/src/redact.js
│   └── utils.js        setText/elem: the only ways text reaches the DOM
├── tools/
│   ├── import-open-items.mjs   reads the trackers, writes PRIVATE drafts
│   └── work.mjs                the runner's client and the sanitized backlog
├── scripts/
│   └── release-work-queue.sh   the production release, one confirmed step at a time
└── worker/
    ├── src/index.js            the router
    ├── src/auth.js             C3: which credential matched decides the role
    ├── src/store.js            SQL, the corrections feed
    ├── src/store-open.js       SQL, the open-items feed and the board
    ├── src/store-work.js       SQL, the work queue: reads, filing, the operator's actions
    ├── src/store-work-runner.js SQL, the work queue: the runner's actions
    ├── src/routes-open.js      the import routes and the board
    ├── src/routes-work.js      the work routes
    ├── src/work.js             the work queue's action table, pure
    ├── src/redact.js           the redaction floor, shared with the site verbatim
    ├── src/transitions.js      C4's tables, pure
    ├── src/turnstile.js        server-side challenge verification
    ├── src/validate.js         C1 validation
    ├── src/validate-work.js    work route shapes
    ├── src/envelope.js         ERROR_CODES and the five-key envelope
    ├── migrations/             the store's real shape: 0001 baseline, 0002 open items, 0003 work queue
    └── schema.sql              the baseline alone, byte for byte 0001; nothing from 0002 or 0003
```

**The widget is not in this repo.** It is a shared kit at
`packages/neorgon-ui/beacon/`, vendored into consuming sites by
`sync-beacon.sh`, exactly like the Header and Footer kits.

### Decisions worth knowing before you change anything

**The beacon opens a tab, it does not post.** 17 of 65 live fleet sites would
silently block an inline `fetch` under their own CSP, and 18 more would block an
inline Turnstile. No CSP directive governs `window.open`. This buys zero CSP
edits fleet-wide, an origin allowlist of 3 instead of 65, and a failure the
visitor can actually see.

**The widget carries context only.** It sends `{v, site, url, target}`. The
visitor types `kind`, `body` and `contact` on this site, same origin, so their
words and their contact address never enter a URL or a browser history.

**Nothing on any feed publishes itself.** The importer writes rows at status
`new`, which is private. The automation credential is refused every transition
on an open item, and any patch that sets `public`, `public_note` or `fixed_ref`.
The board's own query returns three fields, so it cannot serve a source, a ref or
a tracker's own words. That does not make the automation token harmless: it reads
every report, a reader's contact included, and it can plant a private draft under
a tracker ref, or mark items closed at their source and clear that mark again.
There is no separate import credential yet; the architecture document states what
that leaves open.

**Execution is a second axis, not a status.** Whether an agent has an item is
`work_state`, and it never shares a column with what a reader can see. Most work
happens on drafts nobody has published, and no work action writes `status`,
`public_note` or `public`: a test reads the SQL to prove it. The axes meet in one
place: while an item is approved, running, in review or waiting to land, nobody can
resolve, reject or close it until it is withdrawn or its result finishes, and an
item already resolved or closed is never handed to an agent.

**The operator's words are the instruction.** Handing a reader's correction, or an
item automation filed, to an agent needs an instruction the operator wrote, and
neither ever ships. That text reaches the runner as quoted data, because an agent
with push rights reading a stranger's sentence is the prompt-injection case, and a
runner that read a correction may have filed its follow-up in the reader's words.

**The redaction floor has no lookbehind.** The desk imports `js/redact.js`
statically and Safari before 16.4 cannot parse a lookbehind, so one would stop the
desk loading with no message. A rule that has to see the character in front of a
match takes it into the match and reports a capture group instead. Cutting a path
can leave a slash-led remnant such as `/beacon`, so a slash-led word in prose,
such as `/board`, is a path finding too.

---

## The work queue

Design: [`docs/DESIGN-WORK-QUEUE.md`](docs/DESIGN-WORK-QUEUE.md). The runner's
protocol is `.claude/commands/work.md` in the monorepo.

| Mode | The agent may | Lands |
|---|---|---|
| `investigate` | read only: is it still true, what would it take, should it close | nothing |
| `fix` (default) | commit on a branch in a git worktree | only after you accept |
| `ship` | commit and land once its own checks pass (open items you or an import filed) | before you review, or not at all (below) |

The loop: approve at the desk, a runner claims the oldest approval under a lease,
works it on a fresh branch for that attempt, and submits a summary with its
evidence. You accept, return it with a note the next attempt receives, or
dismiss it. An accepted fix is landed by the next run, and then you publish the
resolution sentence, which the runner may have drafted but never writes.

A ship run lands only by fast-forward. When a repository's default branch has moved
on, or it has no origin, the run pushes nothing to that repository and hands back a
`blocked` result with its branch; anything it already landed in another repository
stays landed. Accept it to record that (nothing more lands and nothing is published),
return it with a note for another attempt, or dismiss it. The desk offers
`Accept and publish as resolved` only for a `fixed` result that already landed or
has nothing to land, and a result whose commits are still only on their branch says
`Not landed`.

Three attempts and an item stops being claimable until you decide again; a lease
that runs out on the third is put back in Waiting by the next claim. A ship run's
lapsed lease is never taken over by another run, because its push may already
have happened: check the repository, then withdraw it.

---

## Development

```bash
make serve         # the site        -> http://localhost:8876
make worker-dev    # wrangler dev    -> http://127.0.0.1:8877
make d1-migrate    # apply worker/migrations/*.sql to the LOCAL D1
make d1-schema     # the same thing, under the name the runbook uses
make worker-test   # node --test
```

Import the trackers into a local desk, from the monorepo root:

```bash
export BALISE_IMPORT_TOKEN=...        # the automation token make worker-dev prints
node projects/balise-site/tools/import-open-items.mjs --dry-run
node projects/balise-site/tools/import-open-items.mjs
```

Work the queue from a terminal, with the same automation token:

```bash
export BALISE_WORK_TOKEN=...          # or keep it in the Keychain as balise-automation
node projects/balise-site/tools/work.mjs backlog
node projects/balise-site/tools/work.mjs list --state review
node projects/balise-site/tools/work.mjs claim --runner mac
```

Tokens are read from the environment or the Keychain and never from an argument,
because argv is visible to `ps`. Free text goes in a file for the same kind of
reason: inside double quotes the shell runs a backtick or `$( )` first, so
`--note`, `--suggest` and `--text` each have a `-file` form, and `-` reads stdin.
`--dry-run` prints every batch and sends nothing. A source that fails to parse is
never synced, because sync closes whatever it does not see and a half-read tracker
would read as "everything else is finished"; the Worker also refuses a sync that
carries no refs at all. A close made in error heals on the next import: an item
marked closed that its tracker lists as open again has the mark cleared, and the
importer counts it as `reopened`.

`make worker-dev` mints a random operator token per run and prints it. Export
`BALISE_OPERATOR_TOKEN` to pin one across restarts; that `--var` overrides
`worker/.dev.vars`, which is surprising the first time.

Every D1 command lives behind a Makefile target with `--local` spelled out,
because Wrangler marks neither `--local` nor `--remote` as the default.

---

## Deploying

Production runs Worker 1.0.0, which predates the board and the work queue.
`scripts/release-work-queue.sh` walks the release: read-only checks, a record of
the Worker version production runs, a D1 Time Travel restore point, the remote
migrations, the deploy, the automation token into the Keychain and the Worker, the
first import, and the site push, each behind a confirmation. A token already in the
Keychain is reused only when its SHA-256 matches `~/.balise/automation-token.sha256`,
which the script writes after a mint it read back and set on the Worker; a Keychain
item that does not read back as the token just minted is deleted. It refuses to
start while queue `#76` is open, because this Worker's public log would otherwise
serve full page addresses. See
[`docs/operations/publishing.md`](../../docs/operations/publishing.md).

To back out, in this order: roll the Worker back to the version id the script
recorded, then confirm `/health` reports that version. Restore the database only if
a migration itself damaged data, and only after the rollback: on a restored
database the new Worker's desk, board and work routes all fail. The script prints
both commands, and the architecture document says why the order matters.

Note that WAF is **not** available: it is zone-level and `neorgon.com` is on
Namecheap. Ingest rate limiting is the Workers `ratelimit` binding (20 per 60
seconds, keyed on the hashed address); the operator lockout is separate and
lives in D1, because the binding's period can only be 10 or 60 seconds and
cannot express fifteen minutes. A failure after a lock has run out starts the
count again at one.

---

## License

MIT. See [LICENSE](LICENSE).
