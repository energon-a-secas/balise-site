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

**Live:** [balise.neorgon.com](https://balise.neorgon.com/)

---

## Features

- **Public correction log** -- what got reported and what got fixed, each entry
  written by whoever shipped the change
- **Report page** -- opened by the beacon with the page and item already filled
  in, so nobody retypes what they were looking at
- **Operator desk** -- the private queue, filtered by status, with only the
  status changes that are legal from where a report currently sits
- **Hardened ingest** -- Turnstile, per-address rate limiting, an origin
  allowlist, and an error envelope written to be read by a person
- **Never HTTP 500** -- every failure is JSON with the same five keys

---

## Architecture

Full document: [`docs/architecture/balise.md`](../../docs/architecture/balise.md)
in the monorepo. Frozen contracts: `docs/delivery/CONTRACTS.md`.

```
projects/balise-site/
├── index.html          the public log
├── report/index.html   where a visitor types
├── desk.html           the operator queue
├── js/
│   ├── api.js          the only file that talks to the Worker; exports HANDLED_CODES
│   ├── log.js          public log rendering
│   ├── report.js       fragment parsing, C1 validation, payload assembly
│   ├── desk.js         queue, transitions, in-memory token
│   └── utils.js        setText/elem: the only ways text reaches the DOM
└── worker/
    ├── src/index.js    the router
    ├── src/store.js    the only file containing SQL
    ├── src/validate.js C1 validation
    ├── src/envelope.js ERROR_CODES and the five-key envelope
    └── schema.sql
```

**The widget is not in this repo.** It is a shared kit at
`packages/neorgon-ui/beacon/`, vendored into consuming sites by
`sync-beacon.sh`, exactly like the Header and Footer kits.

### Two decisions worth knowing before you change anything

**The beacon opens a tab, it does not post.** 17 of 65 live fleet sites would
silently block an inline `fetch` under their own CSP, and 18 more would block an
inline Turnstile. No CSP directive governs `window.open`. This buys zero CSP
edits fleet-wide, an origin allowlist of 3 instead of 65, and a failure the
visitor can actually see.

**The widget carries context only.** It sends `{v, site, url, target}`. The
visitor types `kind`, `body` and `contact` on this site, same origin, so their
words and their contact address never enter a URL or a browser history.

---

## Development

```bash
make serve         # the site        -> http://localhost:8876
make worker-dev    # wrangler dev    -> http://127.0.0.1:8877
make d1-schema     # apply worker/schema.sql to the LOCAL D1
make worker-test   # node --test
```

`make worker-dev` mints a random operator token per run and prints it. Export
`BALISE_OPERATOR_TOKEN` to pin one across restarts; that `--var` overrides
`worker/.dev.vars`, which is surprising the first time.

Every D1 command lives behind a Makefile target with `--local` spelled out,
because Wrangler marks neither `--local` nor `--remote` as the default.

---

## Deploying

Not deployed yet. The Worker needs `BALISE_OPERATOR_TOKEN`,
`BALISE_TURNSTILE_SECRET` and `BALISE_IP_SALT` set with `wrangler secret put`,
and a real D1 `database_id` in `wrangler.toml`. See
[`docs/operations/publishing.md`](../../docs/operations/publishing.md).

Note that WAF is **not** available: it is zone-level and `neorgon.com` is on
Namecheap. Ingest rate limiting is the Workers `ratelimit` binding (20 per 60
seconds, keyed on the hashed address); the operator lockout is separate and
lives in D1, because the binding's period can only be 10 or 60 seconds and
cannot express fifteen minutes.

---

## License

MIT. See [LICENSE](LICENSE).
