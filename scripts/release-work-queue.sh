#!/usr/bin/env bash
# A wizard: walks a human through the steps only they can take.
#
# Everything above the STAGES marker is the shared library and is identical in
# every wizard the `wizard` skill generates. Do not hand-edit it: a reviewer
# reads the stages and trusts the machinery, which only works while the
# machinery is the same everywhere.
#
# Author your stages below the marker, set TOTAL_STAGES, and delete the example.
set -uo pipefail

TOTAL_STAGES=9          # one per numbered block below the marker
CURRENT_STAGE=0
ENV_FILE="${ENV_FILE:-.env}"
CAPTURED=()             # "KEY=where it went", for the closing summary

# ── Presentation ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
  BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'
else
  BOLD=''; DIM=''; RESET=''; BLUE=''; GREEN=''; YELLOW=''; RED=''
fi

_clear() { [ -t 1 ] && printf '\033[2J\033[H' || true; }

banner() {
  printf '%s%s%s\n' "$BOLD" "$1" "$RESET"
  printf '%s%s%s\n\n' "$DIM" "$(printf '%0.s─' $(seq 1 ${#1}))" "$RESET"
}

# One screen per stage. Anything the human needs must fit on it.
stage() {
  CURRENT_STAGE=$((CURRENT_STAGE + 1))
  _clear
  printf '%s[%d/%d]%s %s%s%s\n\n' \
    "$DIM" "$CURRENT_STAGE" "$TOTAL_STAGES" "$RESET" "$BOLD" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s>%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s! %s%s\n' "$YELLOW" "$1" "$RESET"; }
ok()   { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$1"; }
fail() { printf '  %sx %s%s\n' "$RED" "$1" "$RESET"; }

# ── Browser ─────────────────────────────────────────────────────────────────
# Always open the URL before asking for the value it produces.
open_url() {
  local url="$1"
  step "Opening: $url"
  if   command -v open        >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 &
  elif command -v wslview     >/dev/null 2>&1; then wslview "$url" >/dev/null 2>&1 &
  elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile Start-Process "$url" >/dev/null 2>&1 &
  else
    note "could not open a browser here, visit it by hand"
  fi
  sleep 1
}

# ── Gates ───────────────────────────────────────────────────────────────────
pause() { printf '\n  %sPress enter when done.%s ' "$DIM" "$RESET"; read -r _; }

# Use before anything irreversible. Name what is about to happen: a bare
# "Continue?" gets a reflexive yes.
confirm() {
  local ans
  printf '\n  %s%s%s [y/N] ' "$YELLOW" "$1" "$RESET"
  read -r ans
  case "$ans" in [yY]|[yY][eE][sS]) return 0 ;; *) fail "stopped"; exit 1 ;; esac
}

# ── Capture ─────────────────────────────────────────────────────────────────
# A value already in .env is offered as the default, so re-running the wizard
# to fix one stage does not mean retyping every earlier one.
_existing() {
  [ -f "$ENV_FILE" ] || return 1
  local line; line=$(grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null) || return 1
  printf '%s' "${line#*=}" | sed 's/^"//; s/"$//'
}

ask() {
  local key="$1" prompt="$2" cur val
  cur=$(_existing "$key") || cur=''
  if [ -n "$cur" ]; then
    printf '\n  %s [%s]: ' "$prompt" "$cur"
  else
    printf '\n  %s: ' "$prompt"
  fi
  read -r val
  [ -z "$val" ] && val="$cur"
  [ -z "$val" ] && { fail "$key is required"; exit 1; }
  printf -v "$key" '%s' "$val"
  export "${key?}"
}

# Never echoes. Use for anything that must not survive in scrollback.
ask_secret() {
  local key="$1" prompt="$2" cur val
  cur=$(_existing "$key") || cur=''
  if [ -n "$cur" ]; then
    printf '\n  %s [keep existing]: ' "$prompt"
  else
    printf '\n  %s: ' "$prompt"
  fi
  read -rs val; printf '\n'
  [ -z "$val" ] && val="$cur"
  [ -z "$val" ] && { fail "$key is required"; exit 1; }
  printf -v "$key" '%s' "$val"
  export "${key?}"
}

# ── Persistence ─────────────────────────────────────────────────────────────
# Idempotent: re-running replaces the line rather than appending a second one,
# which is the bug that makes a half-finished wizard run unrecoverable.
write_env() {
  local key="$1" val="$2"
  touch "$ENV_FILE"
  if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
    local tmp; tmp=$(mktemp)
    grep -v "^$key=" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  CAPTURED+=("$key -> $ENV_FILE")
  ok "$key written to $ENV_FILE"
}

# The name must match a secrets.* reference in CI exactly. CI reports a
# mismatched name as an empty string, never as an error.
set_secret() {
  local key="$1" val="$2"
  command -v gh >/dev/null 2>&1 || { warn "gh not installed, skipping secret $key"; return 0; }
  if printf '%s' "$val" | gh secret set "$key" --body-file - 2>/dev/null; then
    CAPTURED+=("$key -> GitHub secret")
    ok "$key set as a GitHub secret"
  else
    fail "could not set GitHub secret $key (is gh authenticated for this repo?)"
  fi
}

set_var() {
  local key="$1" val="$2"
  command -v gh >/dev/null 2>&1 || { warn "gh not installed, skipping variable $key"; return 0; }
  if gh variable set "$key" --body "$val" >/dev/null 2>&1; then
    CAPTURED+=("$key -> GitHub variable")
    ok "$key set as a GitHub variable"
  else
    fail "could not set GitHub variable $key"
  fi
}

# ── Close ───────────────────────────────────────────────────────────────────
finish() {
  _clear
  banner "Done"
  if [ ${#CAPTURED[@]} -gt 0 ]; then
    say "Captured:"
    for entry in "${CAPTURED[@]}"; do note "  $entry"; done
    printf '\n'
  fi
  [ $# -gt 0 ] && { say "$1"; printf '\n'; }
  if [ "$CURRENT_STAGE" -ne "$TOTAL_STAGES" ]; then
    warn "ran $CURRENT_STAGE of $TOTAL_STAGES stages: TOTAL_STAGES is wrong, or a stage was skipped"
  fi
}

# ---- STAGES ----------------------------------------------------------------

# Balise release: the work queue (docs/DESIGN-WORK-QUEUE.md) and the open-items board it
# builds on, from a clean committed tree to production. Every irreversible step waits for a
# yes, and the secret steps need a person at the keyboard. Nothing here echoes a token.

ROOT="/Users/lucianoadonisvillarroel/dev/Personal"
SITE="$ROOT/projects/balise-site"
API="https://balise-api.neorgon.workers.dev"
BRANCH="main"                   # the branch GitHub Pages serves
RELEASE_VERSION="1.1.0"         # VERSION in worker/src/index.js at the released commit
KEYCHAIN_SERVICE="balise-automation"
BOOKMARK_DIR="$HOME/.balise"
STAMP=$(date +%Y%m%d-%H%M%S)
# What stage 5 mints: 32 random bytes as base64url without padding, and a SHA-256 in hex.
TOKEN_RE='^[A-Za-z0-9_-]{43}$'
SUM_RE='^[0-9a-f]{64}$'

# Every wrangler command asks the npm registry for its latest version and does not exit
# until that request finishes, so a slow registry hangs a finished command indefinitely.
# This is the only switch that skips the check (wrangler-banner.ts in workers-sdk).
export WRANGLER_HIDE_BANNER=true

# The pinned wrangler in worker/node_modules, never a global one, and always from worker/.
W() { npx --prefix "$SITE/worker" wrangler --cwd "$SITE/worker" "$@"; }
# The same command as text for a person to type. Absolute, because their shell stays in
# whatever directory they started the script from.
WR="npx --prefix $SITE/worker wrangler --cwd $SITE/worker"

# Set by stages 1 and 2, declared here so the exit trap can read them on any path.
SHA=''; LIVE_VERSION=''; ACTIVE_ID=''; PREV_ID=''; PREV_VERSION=''; WORKER_FILE=''
BOOKMARK=''; RESTORE_FILE=''; PENDING=''; COLS=''; MINT_SUM=''
CLIP_ARMED=0; DEPLOY_STARTED=0; WAY_BACK_SCREEN=-1

# ── JSON ────────────────────────────────────────────────────────────────────
# Read with the node npx already needs. A line logged ahead of the JSON is skipped, and
# anything that does not parse, or is not the shape expected, exits non-zero.
NODE_JSON='let s = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { s += c; }).on("end", () => {
  const at = s.search(/^[\[{]/m);
  let v; try { v = JSON.parse(at < 0 ? "" : s.slice(at)); } catch { process.exit(2); }
  main(v);
});'
NODE_D1_NAMES='function main(v) {
  if (!Array.isArray(v) || !v.every((x) => x && x.success !== false && Array.isArray(x.results))) process.exit(3);
  for (const x of v) for (const r of x.results) if (typeof r.name === "string") console.log(r.name);
}'
# One version at 100% or nothing: a split deployment has no single version to go back to.
NODE_ACTIVE='function main(v) {
  const full = (v && Array.isArray(v.versions) ? v.versions : []).filter((x) => x && x.percentage === 100);
  if (full.length !== 1 || typeof full[0].version_id !== "string" || !full[0].version_id) process.exit(3);
  console.log(full[0].version_id);
}'
NODE_VERSION='function main(v) { if (!v || typeof v.version !== "string") process.exit(3); console.log(v.version); }'
NODE_AUTOMATION='function main(v) { process.exit(v && v.config && v.config.automation_token === true ? 0 : 3); }'

# `name` of every row a remote SELECT returns, one per line. SELECT only: this is the read
# path, and `d1 execute --json` never prompts.
d1_names() {
  local out
  out=$(W d1 execute balise --remote --json --command "$1" </dev/null 2>/dev/null) || return 1
  node -e "$NODE_JSON$NODE_D1_NAMES" <<<"$out"
}

active_version_id() {
  local out
  out=$(W deployments status --json </dev/null 2>/dev/null) || return 1
  node -e "$NODE_JSON$NODE_ACTIVE" <<<"$out"
}

live_version() {
  local out
  out=$(curl -sf -m 15 "$API/health") || return 1
  node -e "$NODE_JSON$NODE_VERSION" <<<"$out"
}

# Grepped from a here-string, never from a pipe: under pipefail a `| grep -q` that matches
# early kills the writer with SIGPIPE and reads as no match.
has_col() { grep -qxF -- "$1" <<<"$COLS"; }
is_pending() { grep -qxF -- "$1" <<<"$PENDING"; }
pending_after() { LC_ALL=C comm -23 <(printf '%s\n' "$MIGRATIONS") <(printf '%s\n' "$1" | LC_ALL=C sort); }

# The last of the files named, which for release-<stamp> names is the newest.
newest() { local f latest=''; for f in "$@"; do [ -f "$f" ] && latest=$f; done; printf '%s' "$latest"; }

# ── Guards ──────────────────────────────────────────────────────────────────
# The tree the suite ran is what migrates, deploys and is pushed. Checked in stage 1 and
# again after each confirm, because other sessions work in this repository and the runner
# fast-forwards main.
tree_ok() {
  local branch status untracked head
  branch=$(git -C "$SITE" symbolic-ref --short -q HEAD) || branch=''
  if [ "$branch" != "$BRANCH" ]; then
    fail "balise-site is on ${branch:-a detached HEAD}, not $BRANCH, the branch Pages serves."
    return 1
  fi
  if ! status=$(git -C "$SITE" status --porcelain --untracked-files=no); then
    fail "git status failed in $SITE"
    return 1
  fi
  if [ -n "$status" ]; then
    fail "balise-site has uncommitted changes. Commit them, so what deploys is what is in git."
    return 1
  fi
  if ! untracked=$(git -C "$SITE" ls-files --others --exclude-standard -- worker/src worker/migrations js tools); then
    fail "git ls-files failed in $SITE"
    return 1
  fi
  if [ -n "$untracked" ]; then
    fail "untracked source files would deploy without being committed:"
    printf '%s\n' "$untracked" | sed 's/^/      /'
    return 1
  fi
  if [ -n "$SHA" ]; then
    head=$(git -C "$SITE" rev-parse HEAD) || head=''
    if [ "$head" != "$SHA" ]; then
      fail "HEAD is ${head:0:12}, but the checks and the suite ran on ${SHA:0:12}. Run the script again."
      return 1
    fi
  fi
}

# The order matters. $RELEASE_VERSION reads columns a restored database does not have, so a
# restore while it runs breaks the desk, the board and /work while /health still reads
# store_ok. And a bare `wrangler rollback` takes the deployment before the newest, which
# after stage 5's secret put is this release again, so only the recorded id goes back.
way_back() {
  WAY_BACK_SCREEN=$CURRENT_STAGE
  printf '\n'
  say "${BOLD}If you back out of this release, in this order:${RESET}"
  step "1. Roll the Worker back to the version that ran before it, $PREV_VERSION:"
  say "     $WR rollback $PREV_ID"
  note "   Its prompt names the version it deploys, which must read $PREV_ID. If it lists"
  note "   secrets changed since then, go on. Then $API/health must report $PREV_VERSION."
  note "   0002 and 0003 only add columns, a table and indexes, and $PREV_VERSION runs on them,"
  note "   so this step alone is a complete way back."
  if [ -n "$BOOKMARK" ]; then
    step "2. Only if a migration itself damaged data, and only after step 1, restore the database:"
    say "     $WR d1 time-travel restore balise --bookmark=$BOOKMARK"
    note "   The bookmark is saved in $RESTORE_FILE."
  else
    note "   No database restore point is on file for this release."
  fi
  note "   The version id is saved in $WORKER_FILE."
}

clear_clipboard() {
  CLIP_ARMED=0
  pbcopy </dev/null || return 1
  [ -z "$MINT_SUM" ] || [ "$(pbpaste | shasum -a 256 | cut -d' ' -f1)" != "$MINT_SUM" ]
}

# One read of the Keychain item, in a subshell so the token never reaches this shell. It
# passes only with the minted shape and the SHA-256 in $1, and is then piped into the command
# that follows, if there is one: 93 unreadable, 94 not that shape, 95 some other value.
with_token() (
  local want=$1 t
  shift
  t=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w | tr -d '\n') || exit 93
  [[ $t =~ $TOKEN_RE ]] || exit 94
  [[ $want =~ $SUM_RE ]] || exit 95
  [ "$(printf '%s' "$t" | shasum -a 256 | cut -d' ' -f1)" = "$want" ] || exit 95
  [ $# -eq 0 ] || printf '%s' "$t" | "$@"
)

# Whatever ends the script, a failed check, a no or Ctrl-C, a token that may still be on the
# clipboard is cleared, and a stop after the deploy began repeats the way back.
on_exit() {
  local status=$?
  if [ "$CLIP_ARMED" = 1 ]; then
    if clear_clipboard; then
      note "the clipboard no longer holds the minted token"
    else
      warn "the clipboard may still hold the minted token: copy something else over it now"
    fi
  fi
  if [ "$status" -ne 0 ] && [ "$DEPLOY_STARTED" = 1 ]; then
    if [ "$WAY_BACK_SCREEN" = "$CURRENT_STAGE" ]; then
      note "The way back is printed above."
    else
      way_back
    fi
  fi
}
trap on_exit EXIT
# An interrupt becomes an ordinary exit so the EXIT trap runs. Without it, Ctrl-C at the
# Keychain prompt killed the script with the minted token still on the clipboard.
trap 'exit 130' INT
trap 'exit 143' TERM

_clear
banner "Balise release: the work queue"
say "Production ran Worker 1.0.0 before this release: no board, no work queue. This takes it"
say "to $RELEASE_VERSION, turns on the automation credential, and publishes the desk and board."
printf '\n'
say "It asks before each of these and does nothing without a yes:"
step "apply D1 migrations 0002 and 0003 to the production database"
step "deploy the Worker"
step "mint the automation token, keep it in the Keychain, set it on the Worker"
step "import the trackers into production as PRIVATE drafts"
step "push balise-site, which publishes the desk and board on GitHub Pages"
printf '\n'
note "Checks that only read run first, here and against production. A failed check stops the"
note "script with nothing changed, and the way back is recorded before anything is written."
pause

# ── 1 ───────────────────────────────────────────────────────────────────────
stage "Preflight: the tree, the blocker, the tests"
cd "$SITE" || { fail "no project at $SITE"; exit 1; }

tree_ok || exit 1
SHA=$(git -C "$SITE" rev-parse HEAD) || { fail "could not read HEAD in $SITE"; exit 1; }
for f in worker/migrations/0003_work.sql worker/src/store-work-runner.js js/desk-work.js js/desk-run.js tools/work.mjs; do
  git -C "$SITE" cat-file -e "$SHA:$f" 2>/dev/null || { fail "HEAD has no $f. Commit the work queue first."; exit 1; }
done
INDEX_JS=$(git -C "$SITE" show "$SHA:worker/src/index.js") || { fail "could not read worker/src/index.js at HEAD"; exit 1; }
case $INDEX_JS in
  *"const VERSION = '$RELEASE_VERSION';"*) ;;
  *) fail "worker/src/index.js at HEAD does not declare VERSION $RELEASE_VERSION, which every check below expects."; exit 1 ;;
esac
ok "on $BRANCH at ${SHA:0:12}, clean, with the work queue committed"

# Queue #76 must land first: this Worker's GET /log serves each fixed report's full page
# address, which would publish Vitrina shelf handles and working Sash claim links. Both
# halves fail closed: the ledger has to show #76 under Done, and the code at HEAD has to cut
# the address.
#
# awk reads the whole file itself. Piped into `grep -q`, grep exited at the first match, awk
# died of SIGPIPE, and pipefail read that as closed while #76 was open. The backticks are
# literal: the queue writes every id as `#76`.
QUEUE="$ROOT/docs/prompt-queue.md"
# shellcheck disable=SC2016
GATE_AWK='
  /^## Queue/ { sec = "q"; sq = 1; next }
  /^## Done/  { sec = "d"; sd = 1; next }
  /^## /      { sec = "" }
  sec == "q" && index($0, "`#76`")         { open++ }
  sec == "d" && index($0, "- `#76` ") == 1 { done++ }
  END { if (!sq || !sd) exit 3; printf "%d %d\n", open, done }'
if [ ! -r "$QUEUE" ] || ! COUNTS=$(awk "$GATE_AWK" "$QUEUE"); then
  fail "could not read the Queue and Done sections of $QUEUE, so #76 cannot be shown closed."
  exit 1
fi
if [ "${COUNTS% *}" != 0 ] || ! [ "${COUNTS#* }" -ge 1 ] 2>/dev/null; then
  fail "Queue #76 is not closed: GET /log would publish full page addresses."
  say "Land #76 first (its steps are written in $QUEUE), then run this again."
  exit 1
fi

# The fix, run rather than grepped: publicLog from worker/src at the recorded commit gets an
# address with userinfo, a query and a fragment, and passes only if the origin and path are
# all that survive. A queue closed while the fix sits on a branch fails here.
NODE_GATE76='import { pathToFileURL } from "node:url";
const { publicLog } = await import(pathToFileURL(process.argv[1]).href);
const row = { id: "r1", kind: "correction", status: "fixed", public: 1, site: "vitrina-site",
  url: "https://zzuser:zzpass@vitrina.neorgon.com/u/?zzhandle=1#zzfrag",
  target_label: null, public_note: "Fixed.", fixed_ref: null, fixed_at: 1 };
const res = { results: [row], success: true, meta: { rows_read: 1 } };
const stmt = { bind: () => stmt, run: async () => res, all: async () => res, first: async () => row, raw: async () => [Object.values(row)] };
const db = { prepare: () => stmt, batch: async (list) => list.map(() => res) };
const out = JSON.stringify(await publicLog(db, { before: null, limit: 10 }));
process.exit(!/zzuser|zzpass|zzhandle|zzfrag/.test(out) && out.includes("\"https://vitrina.neorgon.com/u/\"") ? 0 : 1);'
GATE_DIR=$(mktemp -d -t balise-release-76) || { fail "could not make a scratch directory"; exit 1; }
if ! git -C "$SITE" archive "$SHA" worker/src | tar -x -C "$GATE_DIR"; then
  rm -rf "$GATE_DIR"
  fail "could not copy worker/src at ${SHA:0:12} to check #76"
  exit 1
fi
if ! node --input-type=module -e "$NODE_GATE76" "$GATE_DIR/worker/src/store.js" </dev/null >/dev/null 2>&1; then
  rm -rf "$GATE_DIR"
  fail "publicLog at ${SHA:0:12} publishes more of an address than its origin and path: #76 is not in this tree."
  say "Commit the #76 fix to balise-site (its steps are in $QUEUE), then run this again."
  exit 1
fi
rm -rf "$GATE_DIR"
ok "queue #76 is closed, and publicLog at HEAD cuts an address to its origin and path"

WHO=$(W whoami </dev/null 2>/dev/null) || WHO=''
case $WHO in
  *"Account ID"*) ok "wrangler is logged in" ;;
  *) fail "wrangler is not logged in. Run: $WR login"; exit 1 ;;
esac

LOG=$(mktemp -t balise-release-tests) || { fail "could not make a log file"; exit 1; }
say "Running the worker suite, about a minute..."
if make -C "$SITE" worker-test </dev/null >"$LOG" 2>&1; then
  ok "worker suite: $(grep -E '^ℹ (pass|fail) ' "$LOG" | tr '\n' ' ')"
else
  fail "the worker suite failed. The log is $LOG"
  exit 1
fi
pause

# ── 2 ───────────────────────────────────────────────────────────────────────
stage "Production: read before writing"
if ! { mkdir -p "$BOOKMARK_DIR" && chmod 700 "$BOOKMARK_DIR"; }; then
  fail "could not make $BOOKMARK_DIR, where the way back is recorded"
  exit 1
fi

# The Worker. Recorded before anything deploys, because stage 5's secret put adds a second
# deployment of this release and a bare rollback can no longer find the one before it.
LIVE_VERSION=$(live_version) || { fail "could not read the version from $API/health"; exit 1; }
if ! ACTIVE_ID=$(active_version_id); then
  fail "could not read the active Worker version, or its traffic is split across versions."
  say "Look with: $WR deployments status"
  exit 1
fi
if [ "$LIVE_VERSION" != "$RELEASE_VERSION" ]; then
  PREV_ID=$ACTIVE_ID
  PREV_VERSION=$LIVE_VERSION
  WORKER_FILE="$BOOKMARK_DIR/release-$STAMP.worker-version"
  if ! printf '%s\n%s\n' "$PREV_ID" "$PREV_VERSION" >"$WORKER_FILE"; then
    fail "could not write $WORKER_FILE. Not changing production without a way back."
    exit 1
  fi
  ok "production runs $PREV_VERSION as version $PREV_ID, saved to $WORKER_FILE"
else
  # A re-run after the deploy: the live id is this release, so the way back is the id an
  # earlier run saved before it deployed.
  WORKER_FILE=$(newest "$BOOKMARK_DIR"/release-*.worker-version)
  if [ -n "$WORKER_FILE" ]; then
    { read -r PREV_ID; read -r PREV_VERSION; } <"$WORKER_FILE"
  fi
  if [ -z "$PREV_ID" ] || [ -z "$PREV_VERSION" ]; then
    fail "production already runs $RELEASE_VERSION, and no earlier run saved the version it replaced."
    say "Find that version id with: $WR deployments list"
    say "Write the id and its version on two lines to $BOOKMARK_DIR/release-$STAMP.worker-version, then run this again."
    exit 1
  fi
  ok "production already runs $RELEASE_VERSION; the way back is $PREV_VERSION, version $PREV_ID"
fi
CAPTURED+=("the Worker version to roll back to -> $WORKER_FILE")

# The database. `wrangler d1 migrations list` is not a read: it creates d1_migrations when the
# table is missing. So the pending set is the migration files at the recorded commit minus
# the names d1_migrations holds, which is the comparison wrangler makes, from SELECTs alone.
if ! MIGRATIONS=$(git -C "$SITE" ls-tree --name-only "$SHA" worker/migrations/ | sed -n 's#^worker/migrations/\([^/]*\.sql\)$#\1#p' | LC_ALL=C sort) || [ -z "$MIGRATIONS" ]; then
  fail "could not list worker/migrations at ${SHA:0:12}"
  exit 1
fi
if ! TABLE=$(d1_names "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'"); then
  fail "could not read the production database. Nothing was changed."
  exit 1
fi
APPLIED=''
if [ "$TABLE" = d1_migrations ]; then
  if ! APPLIED=$(d1_names "SELECT name FROM d1_migrations ORDER BY id"); then
    fail "could not read production's d1_migrations. Nothing was changed."
    exit 1
  fi
fi
UNKNOWN=$(LC_ALL=C comm -13 <(printf '%s\n' "$MIGRATIONS") <(printf '%s\n' "$APPLIED" | sed '/^$/d' | LC_ALL=C sort))
if [ -n "$UNKNOWN" ]; then
  fail "production records migrations that ${SHA:0:12} does not have:"
  printf '%s\n' "$UNKNOWN" | sed 's/^/      /'
  exit 1
fi
PENDING=$(pending_after "$APPLIED")
say "Migrations production has not applied:"
if [ -n "$PENDING" ]; then printf '%s\n' "$PENDING" | sed 's/^/    /'; else note "  none"; fi

if ! COLS=$(d1_names "SELECT name FROM pragma_table_info('reports')") || ! has_col fingerprint; then
  fail "could not read the production reports table. Nothing was changed."
  exit 1
fi
# A column that exists while its migration is still pending means someone changed the
# database by hand. Applying on top of that fails on its first statement, so stop and say why.
if is_pending 0002_open_items.sql && has_col source; then
  fail "0002 is pending but its columns already exist. Reconcile d1_migrations by hand first."
  exit 1
fi
if is_pending 0003_work.sql && has_col work_state; then
  fail "0003 is pending but its columns already exist. Reconcile d1_migrations by hand first."
  exit 1
fi
ok "the schema matches the migrations production has recorded"

# A restore point only when something is about to be migrated. With nothing pending, a fresh
# bookmark is after the migrations, and naming it the release's restore point would promise
# a way back it does not give. The text form is the one the D1 docs show:
#   The current bookmark is '00000085-0000024c-...'
if [ -n "$PENDING" ]; then
  if ! TT=$(W d1 time-travel info balise </dev/null 2>&1); then
    fail "d1 time-travel info failed. Not migrating without a way back."
    exit 1
  fi
  BOOKMARK=$(sed -n "s/.*bookmark is '\([^']*\)'.*/\1/p" <<<"$TT")
  case $BOOKMARK in
    '' | *[[:space:]]*) fail "no single Time Travel bookmark came back. Not migrating without a way back."; exit 1 ;;
  esac
  RESTORE_FILE="$BOOKMARK_DIR/release-$STAMP.bookmark"
  if ! printf '%s\n' "$BOOKMARK" >"$RESTORE_FILE"; then
    fail "could not write $RESTORE_FILE. Not migrating without a way back."
    exit 1
  fi
  ok "restore point from before these migrations saved to $RESTORE_FILE"
else
  RESTORE_FILE=$(newest "$BOOKMARK_DIR"/release-*.bookmark)
  if [ -n "$RESTORE_FILE" ]; then
    read -r BOOKMARK <"$RESTORE_FILE" || true
  fi
  if [ -n "$BOOKMARK" ]; then
    note "Nothing to migrate, so no new restore point. The newest on file is $RESTORE_FILE."
  else
    RESTORE_FILE=''
    note "Nothing to migrate, and no earlier run left a restore point."
  fi
fi
if [ -n "$RESTORE_FILE" ]; then CAPTURED+=("the database restore point -> $RESTORE_FILE"); fi
pause

# ── 3 ───────────────────────────────────────────────────────────────────────
stage "Apply the migrations to production"
if [ -z "$PENDING" ]; then
  ok "production already records every migration in ${SHA:0:12}. Nothing to apply."
else
  say "Applies, in order: $(tr '\n' ' ' <<<"$PENDING")"
  note "0001 is CREATE ... IF NOT EXISTS, so it changes nothing on a database built from schema.sql."
  note "0002 and 0003 add columns, one table and indexes. Worker $PREV_VERSION keeps working on them."
  confirm "Apply these migrations to the PRODUCTION database now?"
  # wrangler applies the files on disk, so they have to still be the commit the suite ran.
  tree_ok || exit 1
  if ! W d1 migrations apply balise --remote; then
    fail "the migration failed. This run did not touch the Worker, which still runs $LIVE_VERSION."
    if [ "$LIVE_VERSION" = "$RELEASE_VERSION" ]; then
      say "If you restore the database, first roll the Worker back: $WR rollback $PREV_ID"
    fi
    say "If a migration stopped partway and left data wrong, restore the point taken before it:"
    say "    $WR d1 time-travel restore balise --bookmark=$BOOKMARK"
    note "The bookmark is saved in $RESTORE_FILE."
    exit 1
  fi
fi
if ! APPLIED=$(d1_names "SELECT name FROM d1_migrations ORDER BY id") || [ -n "$(pending_after "$APPLIED")" ]; then
  fail "production does not record every migration in ${SHA:0:12} as applied"
  exit 1
fi
if ! COLS=$(d1_names "SELECT name FROM pragma_table_info('reports')") \
   || ! has_col source || ! has_col work_state || ! has_col filed_by; then
  fail "the open-item and work columns are not all in the production reports table"
  exit 1
fi
ok "production records every migration and has the open-item and work columns"
pause

# ── 4 ───────────────────────────────────────────────────────────────────────
stage "Deploy the Worker"
say "Deploys worker/ at commit ${SHA:0:12} as balise-api, in place of version $ACTIVE_ID."
confirm "Deploy the Worker to production now?"
tree_ok || exit 1
if ! NOW_ID=$(active_version_id) || [ "$NOW_ID" != "$ACTIVE_ID" ]; then
  fail "the active Worker version is no longer $ACTIVE_ID, the one stage 2 read. Run the script again."
  exit 1
fi
DEPLOY_STARTED=1
if ! W deploy --message "balise-site ${SHA:0:12}" </dev/null; then
  fail "the deploy failed. Read $API/health before rolling back: it may still run the version before."
  exit 1
fi
way_back
printf '\n'
[ "$(live_version 2>/dev/null)" = "$RELEASE_VERSION" ] || { fail "/health does not report $RELEASE_VERSION yet"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$API/work")" = "401" ] || { fail "/work should answer 401 without a token"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$API/board/summary")" = "200" ] || { fail "/board/summary should answer 200"; exit 1; }
ok "$RELEASE_VERSION is live: /work is behind the token and /board/summary answers"
pause

# ── 5 ───────────────────────────────────────────────────────────────────────
stage "The automation token"
say "The runner and the importer hold this credential. Whoever holds it can:"
step "read every report on both feeds and the work queue, a correction's contact included"
step "file private open-item drafts, and mark items closed at their source or clear that mark (only the desk shows it)"
note "    A draft is trusted like any import (fleet), so you can hand it to an agent"
note "    in ship mode with no written instruction. That is why a leaked token matters:"
note "    it can plant a draft under a tracker ref you have not written yet, a later import"
note "    keeps the planted text, and landing it closes the real queue line."
step "mark a new correction triaged, or close a new or triaged one as spam or duplicate,"
note "    but not while that correction is in the work queue"
step "file work items, which need your written instruction to approve and can never ship"
step "claim, heartbeat, release and submit work you approved, and record whether it landed"
say "It cannot approve, accept, return, dismiss or withdraw work, publish, resolve, reject or"
say "reopen a report, change an open item's status, or set public, public_note or fixed_ref."
printf '\n'

# Only a token this script minted, read back and set on the Worker is offered again. The item
# holds whatever was pasted at its prompt, and an operator token has the minted shape, so
# reuse needs the item to match the SHA-256 recorded then. The marker never holds the token.
TOKEN_MARKER="$BOOKMARK_DIR/automation-token.sha256"
MARK=''
if [ -f "$TOKEN_MARKER" ]; then read -r MARK <"$TOKEN_MARKER" || true; fi
HAVE_ITEM=no
if security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then HAVE_ITEM=yes; fi
choice=n
if [ "$HAVE_ITEM" = yes ]; then
  with_token "$MARK" 2>/dev/null
  case $? in
    0)
      say "A token is already in the Keychain as $KEYCHAIN_SERVICE."
      # Enter keeps the stored token: replacing it is the step that can strand a runner.
      while :; do
        printf '\n  Reuse it (r) or mint a new one (n)? [R/n] '
        read -r choice || { fail "stopped"; exit 1; }
        case $choice in
          '' | r | R) choice=r; break ;;
          n | N) choice=n; break ;;
          *) note "Answer r to reuse it, or n to mint a new one." ;;
        esac
      done ;;
    93)
      warn "The Keychain item $KEYCHAIN_SERVICE could not be read, so it cannot be checked or reused." ;;
    *)
      warn "The Keychain item $KEYCHAIN_SERVICE is not recorded as a token this script minted and set on production, so it is not reused."
      note "    It may be something pasted at an earlier prompt, the operator token included." ;;
  esac
fi

if [ "$choice" = r ]; then
  confirm "Set the Keychain's token as BALISE_AUTOMATION_TOKEN on production? This deploys the current version again with the secret."
else
  if [ "$HAVE_ITEM" = yes ]; then
    warn "Minting replaces the stored token. Anything still holding the old one is refused until it reads the new one."
  fi
  # The yes comes before the Keychain is touched, so a no leaves the stored token and the
  # Worker's secret as they were.
  confirm "Mint a new token, store it as $KEYCHAIN_SERVICE, and set it on production? Setting it deploys the current version again with the secret."
  # The token exists only inside the command substitution, which hands back its SHA-256.
  # That digest is compared with the clipboard before the paste and with the Keychain after
  # it, so a clipboard still holding older text (the operator token, say) is never stored
  # or sent. CLIP_ARMED is raised first, so an interrupt from here on clears the clipboard.
  CLIP_ARMED=1
  if ! MINT_SUM=$(t=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n') && [[ $t =~ $TOKEN_RE ]] \
       && printf '%s' "$t" | pbcopy && printf '%s' "$t" | shasum -a 256 | cut -d' ' -f1) || [ -z "$MINT_SUM" ]; then
    fail "could not mint a token onto the clipboard. Nothing was stored or sent."
    exit 1
  fi
  if [ "$(pbpaste | shasum -a 256 | cut -d' ' -f1)" != "$MINT_SUM" ]; then
    fail "the clipboard does not hold the new token. Nothing was stored or sent."
    exit 1
  fi
  say "A new token is on your clipboard. macOS now asks for the item's password twice."
  step "Paste with Cmd+V at both prompts."
  if ! security add-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" -l "Balise automation token" -T /usr/bin/security -U -w; then
    fail "the Keychain did not take it. Nothing was sent to the Worker."
    exit 1
  fi
  # Anything else pasted there is deleted, not left in the item for a later run or the runner
  # to read: an operator token pasted at that prompt has the minted shape.
  with_token "$MINT_SUM"
  READ_BACK=$?
  if [ "$READ_BACK" -ne 0 ]; then
    if [ "$READ_BACK" = 93 ]; then
      fail "the Keychain item could not be read back to check it, so nothing was sent to the Worker."
    else
      fail "the Keychain item now holds something other than the token just minted, so nothing was sent to the Worker."
    fi
    if security delete-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
      say "The Keychain item $KEYCHAIN_SERVICE is deleted, and the Worker's secret is unchanged. Run this again and mint a new one."
    else
      fail "could not delete the Keychain item $KEYCHAIN_SERVICE. Delete it by hand before anything reads it, the runner included:"
      say "    security delete-generic-password -a $USER -s $KEYCHAIN_SERVICE"
      say "The Worker's secret is unchanged. Then run this again and mint a new one."
    fi
    exit 1
  fi
  if clear_clipboard; then
    ok "stored in the Keychain, and the clipboard no longer holds it"
  else
    warn "stored in the Keychain, but the clipboard may still hold it: copy something else over it now"
  fi
fi

warn "If macOS asks to allow access, choose Always Allow: the scheduled runner meets the same dialog."
# One read, checked and sent from the same subshell, so what reaches the Worker is the token
# just read back, or on reuse the one the marker names. A second read for the upload let a
# Keychain that locked in between send an empty secret, and wrangler's secret put does not
# refuse one.
if [ "$choice" = r ]; then TOKEN_SUM=$MARK; else TOKEN_SUM=$MINT_SUM; fi
with_token "$TOKEN_SUM" W secret put BALISE_AUTOMATION_TOKEN
case $? in
  0) ;;
  93)
    fail "the token could not be read from the Keychain. Nothing was sent to the Worker."
    exit 1 ;;
  94 | 95)
    fail "the Keychain item changed after it was checked. Nothing was sent to the Worker."
    say "Run this again and mint a new one."
    exit 1 ;;
  *)
    fail "secret put failed, so the Worker may not hold the token the Keychain holds."
    say "Set it by hand, then read $API/health:"
    say "    security find-generic-password -s $KEYCHAIN_SERVICE -w | tr -d '\\n' | $WR secret put BALISE_AUTOMATION_TOKEN"
    if [ "$choice" != r ]; then
      note "A later run of this script will not reuse this token, since this run could not set it: it offers a fresh mint."
    fi
    exit 1 ;;
esac
if [ "$choice" != r ]; then
  # Recorded only now, with the token read back and set on the Worker. A marker that cannot be
  # written costs a later run its reuse, never its check.
  if ( umask 077 && printf '%s\n' "$MINT_SUM" >"$TOKEN_MARKER" ) 2>/dev/null && chmod 600 "$TOKEN_MARKER" 2>/dev/null; then
    CAPTURED+=("the new token's SHA-256, which a later run checks before reusing it -> $TOKEN_MARKER")
  else
    warn "could not write $TOKEN_MARKER, so a later run will not reuse this token and offers a fresh mint"
  fi
fi
HEALTH=$(curl -sf -m 15 "$API/health") || HEALTH=''
if ! node -e "$NODE_JSON$NODE_AUTOMATION" <<<"$HEALTH" 2>/dev/null; then
  fail "/health does not show the automation token bound"
  exit 1
fi
CAPTURED+=("BALISE_AUTOMATION_TOKEN -> Keychain item $KEYCHAIN_SERVICE, and the Worker secret")
ok "production has the automation credential"
if [ -e "$BOOKMARK_DIR/runner-stopped" ]; then
  warn "$BOOKMARK_DIR/runner-stopped exists, so the runner stays stopped. Read why, then delete it:"
  say "    rm $BOOKMARK_DIR/runner-stopped"
fi
pause

# ── 6 ───────────────────────────────────────────────────────────────────────
stage "Import the trackers as private drafts"
IMPORTER="$SITE/tools/import-open-items.mjs"
DRY=$(mktemp -t balise-release-dryrun) || { fail "could not make a log file"; exit 1; }
say "A dry run first, which sends nothing:"
if ! node "$IMPORTER" --dry-run </dev/null >"$DRY" 2>&1; then
  tail -20 "$DRY"
  fail "the dry run failed. Its output is $DRY"
  exit 1
fi
tail -20 "$DRY"
confirm "Import them into production as PRIVATE drafts now?"
# The same checked read as stage 5, against the digest stage 5 set on the Worker, so neither a
# locked Keychain nor an item changed since then can run the importer. The token arrives on
# stdin and goes no further than the importer's environment.
import_drafts() {
  local t=''
  IFS= read -r t || [ -n "$t" ] || return 94
  BALISE_IMPORT_TOKEN=$t node "$IMPORTER" --api "$API" </dev/null
}
with_token "$TOKEN_SUM" import_drafts
case $? in
  0) ok "drafts imported. None of them is public until you write its sentence." ;;
  93 | 94 | 95) fail "no usable automation token came out of the Keychain, or it is not the one set on production, so nothing was imported."; exit 1 ;;
  *) fail "the import reported errors above. Nothing was published either way."; exit 1 ;;
esac
pause

# ── 7 ───────────────────────────────────────────────────────────────────────
stage "Publish the desk and the board"
say "Pushes commit ${SHA:0:12} to $BRANCH on origin. GitHub Pages serves it at balise.neorgon.com."
say "Commits to push: $(git -C "$SITE" rev-list --count "refs/remotes/origin/$BRANCH..$SHA" 2>/dev/null || echo unknown)"
confirm "Push commit ${SHA:0:12} of balise-site to origin $BRANCH now?"
tree_ok || exit 1
# The recorded commit by name, not whatever HEAD or the upstream happen to be by now.
git -C "$SITE" push origin "$SHA:refs/heads/$BRANCH" || { fail "the push failed"; exit 1; }
say "Waiting for Pages to serve the Work view, up to two minutes..."
live=no
for _ in $(seq 1 12); do
  PAGE=$(curl -s -m 10 "https://balise.neorgon.com/desk.html") || PAGE=''
  case $PAGE in *'data-kind="work"'*) live=yes; break ;; esac
  sleep 10
done
if [ "$live" = yes ]; then ok "the live desk has its Work view"; else warn "Pages has not served it yet. Check again in a few minutes."; fi
pause

# ── 8 ───────────────────────────────────────────────────────────────────────
stage "Hand the first item to an agent"
open_url "https://balise.neorgon.com/desk.html"
step "Paste the operator token, then Open the queue"
step "Open items, pick one that looks stale, Hand to an agent, Investigate, Approve"
step "Work, Waiting: it is there at attempt 0 of 3"
note "Investigate is read only, so it is the safe first run, and it grooms the backlog."
pause

# ── 9 ───────────────────────────────────────────────────────────────────────
stage "Schedule the runner"
say "The runner is a scheduled task in the Claude desktop app on this Mac."
say "The simplest way: tell Claude \"create the Balise work runner schedule\"."
printf '\n'
say "Or add it yourself, hourly on weekdays, with this prompt:"
printf '\n'
cat <<'PROMPT'
    Run the Balise work runner once, against production.
    Working directory: /Users/lucianoadonisvillarroel/dev/Personal
    Environment for every command: BALISE_API=https://balise-api.neorgon.workers.dev BALISE_RUNNER=mac
    Read /Users/lucianoadonisvillarroel/dev/Personal/.claude/commands/work.md and follow it
    exactly with no arguments: land accepted work, claim at most one approved item, work it
    by its mode, submit the result, and end with its one-line report. Never publish,
    approve or review anything.
PROMPT
printf '\n'
note "Scheduled tasks run while the app is open; a missed run starts at the next launch."
pause

finish "Production runs $RELEASE_VERSION with the work queue, from commit ${SHA:0:12}."
way_back
