#!/usr/bin/env node
// C6.8's promise, kept: items belonging to a disabled app are purged 90 days after it is disabled.
//
//   make purge-disabled                       purge LOCAL D1, a page at a time, until none is left
//   node tools/purge-disabled.mjs --query     print the statement for one page
//
// The statement is printed rather than run, and wrangler's answer arrives on stdin, for the reason
// tools/d1-drift.mjs gives: every D1 command in this project lives behind a Makefile target that
// spells out --local. Running it against production on a schedule is the owner's, not this file's.
//
// Paged, so one run can never be an unbounded DELETE: each page removes at most PAGE rows, reached
// app by app on an app_id-leading index (CROSS JOIN fixes that order: a plain JOIN planned as a
// walk of every report), and RETURNs what it removed so the count is read back
// rather than assumed. A full page exits 3, which the Makefile reads as "run another page"; a short
// one exits 0. Run twice, it deletes nothing the second time. Only `reports` rows go: the apps row
// and its keys stay, so the owner's list still shows the app as disabled.

import { fileURLToPath } from 'node:url';

export const PURGE_DAYS = 90;
export const PAGE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MORE = 3;

/** The one statement, with the cutoff and the page as integers this file computed, never input. */
export function purgeStatement(now, page = PAGE) {
  const cutoff = Math.floor(now) - PURGE_DAYS * DAY_MS;
  if (!Number.isSafeInteger(cutoff) || !Number.isSafeInteger(page) || page < 1) throw new Error('purgeStatement: now and page must be integers');
  return 'DELETE FROM reports WHERE id IN ('
    + 'SELECT r.id FROM apps a CROSS JOIN reports r ON r.app_id = a.id '
    + `WHERE a.disabled_at IS NOT NULL AND a.disabled_at <= ${cutoff} LIMIT ${page}) RETURNING app_id`;
}

/** How many rows `wrangler d1 execute --json` says the page removed, or throws on an answer it cannot read. */
export function purgedCount(text) {
  const answer = JSON.parse(text);
  const parts = Array.isArray(answer) ? answer : [answer];
  let count = 0;
  for (const part of parts) {
    if (!part || part.success === false || !Array.isArray(part.results)) throw new Error('purge-disabled: wrangler did not answer with results');
    count += part.results.length;
  }
  return count;
}

async function main() {
  const nowArg = process.argv.find((a) => a.startsWith('--now='));
  const now = nowArg ? Number(nowArg.slice(6)) : Date.now();
  if (process.argv.includes('--query')) {
    process.stdout.write(`${purgeStatement(now)}\n`);
    return 0;
  }
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  let count;
  try {
    count = purgedCount(text);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  process.stdout.write(count === 0
    ? `no item of an app disabled over ${PURGE_DAYS} days ago is left\n`
    : `purged ${count} items of apps disabled over ${PURGE_DAYS} days ago${count >= PAGE ? ', and there may be more' : ''}\n`);
  return count >= PAGE ? MORE : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
