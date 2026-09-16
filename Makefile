.DEFAULT_GOAL := help

PORT        = 8876
# js/api.js sends a localhost page to http://127.0.0.1:8877 and its comment defers to
# this variable by name. Keep the two in step: a different number here means the local
# site cannot reach the local worker, and the failure looks like a network fault.
WORKER_PORT = 8877
WORKER_DIR  = worker
WRANGLER    = npx --prefix $(WORKER_DIR) wrangler --cwd $(WORKER_DIR)
# node:sqlite is still flagged experimental and says so on every run. The drift check is
# read by an operator deciding whether the local database is sound, so the one line that
# matters is not worth burying under two of warning.
DRIFT       = node --disable-warning=ExperimentalWarning tools/d1-drift.mjs

# ── Help ──────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo ""
	@echo "  make serve        Start dev server → http://localhost:$(PORT)"
	@echo "  make kill         Kill this project's HTTP server"
	@echo ""
	@echo "  make worker-install   npm install inside worker/"
	@echo "  make worker-dev       wrangler dev → http://127.0.0.1:$(WORKER_PORT) (local D1)"
	@echo "  make worker-test      node --test worker/tests/*.test.mjs"
	@echo "  make worker-kill      Kill the worker dev server"
	@echo ""
	@echo "  make d1-migrate   Apply worker/migrations/*.sql to the LOCAL D1 database"
	@echo "  make d1-schema    Same thing: 0001 IS schema.sql, byte for byte"
	@echo "  make d1-query Q=  Run one read-only query against the LOCAL D1 database"
	@echo "  make d1-check     Fail if the LOCAL D1 disagrees with worker/migrations"
	@echo "  make d1-reset     Drop the local D1 tables and re-apply the schema"
	@echo ""

# ── D1, always local ──────────────────────────────────────────────────────────
# Every D1 command in this project lives behind a target here, and every one of them
# writes --local explicitly.
#
# The reason is not tidiness. The Wrangler D1 command reference documents --local and
# --remote and marks NEITHER as the default
# (https://developers.cloudflare.com/d1/wrangler-commands/), so a bare `wrangler d1
# execute` is one keystroke away from writing to production. Wrangler 4 also defaults
# --experimental-auto-create to true, which provisions real resources for unbound
# bindings. Do not type a bare `wrangler d1` command, and do not put one in a doc.
#
# Local state lands in worker/.wrangler/state/v3/d1/, which is gitignored: after any
# exercise it holds real report text.

# migrations/0001_baseline.sql IS schema.sql, byte for byte, and tests/open-items.test.mjs
# asserts it. So schema.sql is the baseline alone and none of what came after: the migrations
# are the store's shape, and they are what is applied, because ALTER TABLE cannot be expressed
# as a CREATE TABLE IF NOT EXISTS and a second run of the schema file would silently skip
# every later change.
.PHONY: d1-migrate
d1-migrate:
	@$(WRANGLER) d1 migrations apply balise --local
	@$(MAKE) --no-print-directory d1-check

# The name the README and the runbook already use. It runs the migrations, so an operator
# who types the command they know does not end up with a database missing half its columns.
.PHONY: d1-schema
d1-schema: d1-migrate

# The check `d1-migrate` cannot make for itself. Wrangler records an applied migration BY
# FILE NAME and never runs it again, so a migration edited after it was applied stays
# applied: the line above prints "No migrations to apply!" and the column the file gained is
# still missing. On 2026-09-16 that column was reports.filed_by and the operator met it as a
# 502 STORE_ERROR from every GET /reports (queue #82), which is why this runs after every
# apply rather than on request.
#
# tools/d1-drift.mjs owns both halves: it prints the statement, and it reads the answer. The
# D1 command stays here, with its explicit --local, because that is the rule this section
# opens with.
.PHONY: d1-check
d1-check:
	@Q="$$($(DRIFT) --query)" \
	  && $(WRANGLER) d1 execute balise --local --json --command="$$Q" | $(DRIFT)

.PHONY: d1-query
d1-query:
	@test -n "$(Q)" || { echo "usage: make d1-query Q=\"SELECT count(*) FROM reports\""; exit 2; }
	@$(WRANGLER) d1 execute balise --local --command="$(Q)"

.PHONY: d1-reset
d1-reset:
	@$(WRANGLER) d1 execute balise --local --command="DROP TABLE IF EXISTS work_runs; DROP TABLE IF EXISTS reports; DROP TABLE IF EXISTS auth_attempts; DROP TABLE IF EXISTS submit_counters; DROP TABLE IF EXISTS d1_migrations;"
	@$(MAKE) d1-migrate

# ── Worker ────────────────────────────────────────────────────────────────────
# The secrets are passed as --var and never written to a file. With no
# BALISE_OPERATOR_TOKEN in the environment one is generated for this run and printed,
# so a local desk session needs no file and leaves nothing behind. The AUTOMATION token
# is minted and printed the same way, for the importer and the runner to hold. Printing
# either is fine only because it is this local Worker's token, made for this run. The
# automation token is not harmless in itself (it reads every report and can plant drafts,
# as worker/src/routes-open.js lists), so never run this with a production token exported.
#
# BALISE_TURNSTILE_SECRET is deliberately left unset by default: with no secret, /report
# answers 501 NOT_CONFIGURED before it fetches anything, which is the path local work can
# actually exercise. The Turnstile success path cannot be exercised locally at all.

.PHONY: worker-install
worker-install:
	@cd $(WORKER_DIR) && npm install

.PHONY: worker-dev
worker-dev:
	@TOKEN=$${BALISE_OPERATOR_TOKEN:-$$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')}; \
	 AUTO=$${BALISE_AUTOMATION_TOKEN:-$$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')}; \
	 SALT=$${BALISE_IP_SALT:-$$(openssl rand -hex 16)}; \
	 echo "Worker  → http://127.0.0.1:$(WORKER_PORT)"; \
	 echo "Operator token for this run:   $$TOKEN"; \
	 echo "Automation token for this run: $$AUTO  (export BALISE_IMPORT_TOKEN to import)"; \
	 $(WRANGLER) dev --port $(WORKER_PORT) --var BALISE_OPERATOR_TOKEN:$$TOKEN --var BALISE_AUTOMATION_TOKEN:$$AUTO --var BALISE_IP_SALT:$$SALT

.PHONY: worker-test
worker-test:
	@cd $(WORKER_DIR) && node --test tests/*.test.mjs

.PHONY: worker-kill
worker-kill:
	@lsof -ti :$(WORKER_PORT) | xargs kill 2>/dev/null && echo "Stopped worker on port $(WORKER_PORT)" || echo "No worker running on port $(WORKER_PORT)"

# ── Dev server ────────────────────────────────────────────────────────────────
# scripts/serve.py is http.server plus Cache-Control: no-cache; a plain
# http.server sends only Last-Modified, so browsers keep stale ES modules after
# edits. Falls back to plain http.server outside the monorepo.
.PHONY: serve
serve:
	@echo "Serving → http://localhost:$(PORT)"
	@if [ -f ../../scripts/serve.py ]; then python3 ../../scripts/serve.py $(PORT); else python3 -m http.server $(PORT); fi

# ── Kill ──────────────────────────────────────────────────────────────────────
.PHONY: kill
kill:
	@lsof -ti :$(PORT) | xargs kill 2>/dev/null && echo "Stopped server on port $(PORT)" || echo "No server running on port $(PORT)"
