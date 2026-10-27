/**
 * The CAPTCHA check a site runs as part of its own Submit: reCAPTCHA
 * (google.com or recaptcha.net, its files on gstatic), hCaptcha and
 * Cloudflare Turnstile. These are the provider's script, its frames and the
 * token requests they make. A reusable provider adapter, never a solver: a
 * challenge the person must answer still goes to them.
 *
 * The fence lets the provider's reads through at any time (the script has to
 * be on the page before Submit can use it) and its token requests only while
 * the final click or the person's own window is open.
 */
export const CAPTCHA_VERIFICATION_REQUEST =
  /^https:\/\/(?:(?:www\.)?(?:google\.com|recaptcha\.net)\/recaptcha\/|www\.gstatic\.com\/recaptcha\/|(?:[a-z\d-]+\.)?hcaptcha\.com\/|challenges\.cloudflare\.com\/(?:turnstile\/|cdn-cgi\/challenge-platform\/))/iu;

/**
 * Cloudflare's passive bot check, served from the site's own origin under
 * `/cdn-cgi/challenge-platform/` (its JavaScript detection beacon). Every
 * browser on a Cloudflare-protected site runs it, from page load; a page
 * whose check was refused can leave Turnstile, and the site's Submit with it,
 * waiting for good (Workable). Nothing else under `/cdn-cgi/`.
 */
export const SITE_BOT_CHECK_PATH = /^\/cdn-cgi\/challenge-platform\//u;

/** The site's own bot check: same origin as the page asking, that path only. */
export function isSiteBotCheckRequest(
  url: string | null | undefined,
  pageOrigin: string | null | undefined,
): boolean {
  if (!url || !pageOrigin) return false;
  try {
    const parsed = new URL(url, pageOrigin);
    return (
      parsed.origin === pageOrigin && SITE_BOT_CHECK_PATH.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

export function isCaptchaVerificationRequest(
  url: string | null | undefined,
): boolean {
  return Boolean(url && CAPTCHA_VERIFICATION_REQUEST.test(url));
}
