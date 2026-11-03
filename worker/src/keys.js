// The keys this Worker derives or mints, and the digest under all of them:
//
//   fingerprintInput + sha256Hex   the duplicate guard, scoped per tenant (A11)
//   ipHash                         a reporter's address, salted, truncated, never stored raw
//   actorKey                       the bucket the rate limit and the C3 lockout count against
//   mintAppKey, appKeyKind         an app's bpk_ and bsk_ keys, prefix and checksum (C6.2)
//
// No SQL, no D1, no request, no env. It imports only src/scope.js, which imports nothing.

import { FLEET } from './scope.js';

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256(site, target id, normalised body). The UNIQUE index on this column IS the
 * duplicate guard: the insert in src/store.js conflicts and writes nothing, which costs one
 * no-op insert rather than a read plus a write.
 *
 * Normalising case and runs of whitespace means "the same complaint typed twice" is one
 * report. It does not catch a reworded duplicate, and it is not meant to: that is the
 * `duplicate` status and a human.
 */
export function normaliseForFingerprint(body) {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A11: the tenant is scoped INSIDE the hash, so `reports_fp` stays UNIQUE on `fingerprint` alone
 * and no ON CONFLICT clause changes. `appId` COMES FIRST, so a stale three-argument call site
 * fails loudly instead of hashing as the fleet (DESIGN.md section 9 item 13). The fleet's input
 * is byte-identical to what it was before, so every stored fingerprint stays correct.
 */
export function fingerprintInput(appId, site, targetId, body) {
  const base = `${site}\x00${targetId || ''}\x00${normaliseForFingerprint(body)}`;
  return appId === FLEET ? base : `${appId}\x00${base}`;
}

/**
 * SHA-256(salt, address), truncated to 32 hex characters. Returns null with no salt,
 * because an unsalted hash of an IPv4 address is reversible by brute force in seconds and
 * storing that would be worse than storing nothing.
 */
export async function ipHash(salt, address) {
  if (!salt || !address) return null;
  return (await sha256Hex(`${salt}\x00${address}`)).slice(0, 32);
}

/**
 * The key the rate limit bindings and the C3 lockout count against: the salted hash, else the
 * raw address, else one shared bucket (local work and curl, stricter rather than looser). It is
 * here and not in src/auth.js so that the credential-free /report never imports that file.
 */
export function actorKey(hashed, ip) {
  if (hashed) return hashed;
  return ip ? `ip:${ip}` : 'anonymous';
}

// ── App keys (C6.2) ───────────────────────────────────────────────────────────

const APP_KEY_PREFIX = { public: 'bpk_', secret: 'bsk_' };
// 32 random bytes and a 4-byte checksum, both base64url without padding.
const KEY_BODY = 43;
const KEY_SUM = 6;
const APP_KEY_LENGTH = 4 + KEY_BODY + KEY_SUM;

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function crc32(text) {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i);
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const checksum = (head) => {
  const c = crc32(head);
  return base64url([c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]);
};

/** A new key of one kind. Shown to a person once and stored only as its SHA-256. */
export function mintAppKey(kind) {
  const prefix = APP_KEY_PREFIX[kind];
  if (!prefix) throw new Error(`mintAppKey: no key kind ${JSON.stringify(kind)}`);
  const head = prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
  return head + checksum(head);
}

/**
 * 'public', 'secret' or null: the kind a presented text is shaped as. The checksum lets a typo or
 * a truncated paste be refused without a D1 read. It proves the shape and nothing else: which app
 * a key belongs to, and whether it is still live, is the app_keys lookup.
 */
export function appKeyKind(text) {
  if (typeof text !== 'string' || text.length !== APP_KEY_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const kind = Object.keys(APP_KEY_PREFIX).find((k) => text.startsWith(APP_KEY_PREFIX[k]));
  if (!kind) return null;
  return checksum(text.slice(0, -KEY_SUM)) === text.slice(-KEY_SUM) ? kind : null;
}
