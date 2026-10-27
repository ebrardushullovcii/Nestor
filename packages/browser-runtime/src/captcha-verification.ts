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

export function isCaptchaVerificationRequest(
  url: string | null | undefined,
): boolean {
  return Boolean(url && CAPTCHA_VERIFICATION_REQUEST.test(url));
}
