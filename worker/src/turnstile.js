// Turnstile verification, lifted out of the router when the open-items routes arrived
// and src/index.js reached its 500 line cap. Nothing about the check changed in the move.
//
// Server side validation is mandatory: the widget alone protects nothing, because anyone
// can POST any string to the ingest endpoint. Tokens are single use and expire after five
// minutes (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

export const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Returns null when the caller is a person, or a ready made { code, message, hint }.
 *
 * Gate on the secret BEFORE the fetch, the same rule as the fleet's reference worker: a
 * missing secret is a configuration fact and must not be reported to a visitor as a
 * challenge failure, because nothing they do can get past it.
 */
export async function verifyTurnstile(env, token, ip) {
  if (!env.BALISE_TURNSTILE_SECRET) {
    return {
      code: 'NOT_CONFIGURED',
      message: 'This service has no Turnstile secret set, so it cannot check that you are a person.',
      hint: 'The site owner needs to set BALISE_TURNSTILE_SECRET. Nothing you can type will get past this one, so tell them what you found instead.',
    };
  }
  if (!token || typeof token !== 'string' || token.length > 2048) {
    return {
      code: 'CHALLENGE_FAILED',
      message: 'The report arrived without a completed challenge.',
      hint: 'Wait for the checkbox on the report page to finish, then send it again.',
    };
  }
  const form = new URLSearchParams({ secret: env.BALISE_TURNSTILE_SECRET, response: token });
  if (ip) form.set('remoteip', ip);
  let body;
  try {
    const res = await fetch(TURNSTILE_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    body = await res.json();
  } catch (err) {
    console.error('turnstile siteverify threw:', err);
    return {
      code: 'CHALLENGE_FAILED',
      message: 'The challenge check could not be completed.',
      hint: 'Try again in a minute. Your text is still in this page, so nothing is lost.',
    };
  }
  if (body && body.success === true) return null;
  console.warn('turnstile refused:', body && body['error-codes']);
  return {
    code: 'CHALLENGE_FAILED',
    message: 'The challenge on the report page was not accepted.',
    hint: 'Reload the report page to get a fresh challenge, then send it again.',
  };
}
