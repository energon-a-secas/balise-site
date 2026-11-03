# CLAUDE.md: Balise

Collect and triage correction reports raised from any Neorgon site, with a private review desk and a public record of what got fixed.

**Live:** balise.neorgon.com · **Port:** 8876

## Run

```bash
make serve
```

Then open http://localhost:8876. It must be served over HTTP: the app is ES modules, and `file://` blocks them.

## Architecture

| Module | Lines | Owns |
|---|---:|---|
| `js/desk.js` | 499 | `initDesk` |
| `js/desk-work.js` | 439 | `forgetSentences`, `verdictFor`, `actionButton`, `movesWhileWorked`, `heldNode` |
| `js/report.js` | 251 | `parseContext`, `initReport` |
| `js/board.js` | 241 | `initBoard` |
| `js/api.js` | 232 | `HANDLED_CODES`, `apiBase`, `postReport`, `fetchLog`, `fetchQueue` |
| `js/redact.js` | 203 | `REDACTION_RULES`, `redactionFindings`, `isRedactionClear`, `stripRedactions` |
| `js/desk-open.js` | 194 | `openReportNode` |
| `js/desk-run.js` | 109 | `noteLine`, `unlanded`, `runNode` |
| `js/log.js` | 102 | `initLog` |
| `js/utils.js` | 61 | `setText`, `show`, `hide`, `announce`, `formatDate` |
| `js/app.js` | 8 | none |
| `js/desk-page.js` | 5 | none |
| `js/report-page.js` | 5 | none |

Vendored from `packages/neorgon-ui/`, never edit in place; run the sync script instead: `js/neorgon-header.js`, `js/neorgon-footer.js`.

## Data

- `worker/`: Cloudflare Worker proxy; secrets are `wrangler secret` bindings, never literals

## Conventions

- Zero build step. Plain ES modules loaded by `js/app.js`.
- Header and footer come from the shared kits. Do not add site-local `.neo-footer` or `.header-bar` CSS.
- No single JS file over ~500 lines. It currently holds.

## Gotchas

- **A new migration needs two lines in the release script.** `scripts/release-work-queue.sh` applies whatever `worker/migrations` holds at the release commit, and names and reads back each file from its `migration_note` and `migration_objects` tables. Stage 2 refuses a file missing from them, and `worker/tests/release-script.test.mjs` fails first, printing what the file creates. Before those tables existed the script narrated "0002 and 0003" while it would also have applied 0004 and 0005 (queue `#138`).
- **Never add to a migration that may have been applied; add a new numbered file.** `d1_migrations` records a file by name with no hash, so a re-run skips it, and `make d1-check` compares tables and columns only, so an index added to an old file reaches no database and nothing reports it. The measurement is in the header of `worker/migrations/0005_indexes.sql`.
- **Production's planner statistics are taken once, at release, and never again.** 0004 and 0005 end with `PRAGMA optimize`, which on production's populated table records how many rows it holds then, and nothing in the Worker analyses it later. The planner keeps believing `reports` is that small: with under about 100 rows at release the import's dedupe read, and under about 200 the sync's close, plan as a full `SCAN reports`, every tenant included. The workerd suites can pin only plans with no statistics; `worker/tests/analysed-plans.test.mjs`, part of `make worker-test`, pins every plan with none, with the rows' own and with release statistics (over node:sqlite, not D1), and says what the moved ones read (queue `#139`).
- **The release script's `#76` gate imports `publicLog` by file path** (`GATE76_MODULE`). It kept importing `store.js` after `248e104` moved `publicLog` to `store-public.js`, and reported the missing export as "#76 is not in this tree". The test now runs the gate against the tree.
- **`POST /apps/:app/items` is the one route outside `BALISE_ALLOWED_ORIGINS`.** The router hands it and its preflight to `worker/src/routes-apps.js` before its own origin gate, and the app's own origin list decides instead; the two lists never merge (C6.3). Every credential goes through `identify()` in `worker/src/identity.js`, which a route calls with the principal kinds it accepts; `tests/tenant-scope.test.mjs` fails on any other file that reads `Authorization` or imports `auth.js`. The person kind answers `501 NOT_CONFIGURED` until phase 3 of queue `#83` adds the Clerk check.
- **A tenant row is written with `public = 0`, and that is what keeps it off the board's bill.** `insertReport()` in `worker/src/store.js` picks the value from the scope: 1 for the fleet, 0 for an app. The `app_id = 'fleet'` literal stops a tenant row being shown, but only `public = 0` stops it being read: the board's resolved list and its summary's latest seek `(status, public)` on `reports_public_log`, which does not lead on `app_id`, so a tenant row at `fixed` and `public = 1` is read and thrown away by every unauthenticated `/board` request (CONTRACTS A46; `tests/apps-d1.test.mjs` measures it both ways). Do not default a new tenant write to 1.
- **An app's `owner` is a Clerk user id (`user_...`), and `POST /apps` refuses anything else.** Phase 3 shows a person an app only when `apps.owner` equals the verified token's `sub`, byte for byte, so an app registered under a name or an address could never be opened by its owner.
- **"You installed workerd on another platform" is a misleading error.** It means `worker/node_modules/@cloudflare/workerd-darwin-arm64/bin/` lost its binary, and every local-D1 test in `make worker-test` fails with it. The fix is `npm ci` inside `worker/`, which is not a root workspace member, so it does not prune the root's `node_modules`.

## Do not touch

- `js/neorgon-*.js` and `css/neorgon-*.css`: vendored kits, regenerated by `packages/neorgon-ui/sync-*.sh`.
