import type {
  ListingHtmlFetchResult,
  ListingHtmlFetcher,
} from "@nestor/job-finder";

/**
 * A listing page that answered with a sign-in instead of the listing: an
 * auth status, a redirect onto a sign-in address, or a password field.
 */
export function looksLikeSignInPage(result: ListingHtmlFetchResult): boolean {
  if (result.status === 401 || result.status === 403) return true;
  let path = "";
  try {
    path = new URL(result.finalUrl).pathname.toLowerCase();
  } catch {
    path = "";
  }
  if (/\/(?:sign-?in|log-?in|auth)(?:\/|$)/u.test(path)) return true;
  return /<input[^>]+type\s*=\s*["']?password/iu.test(result.html);
}

/**
 * Listing bodies are read over plain HTTP. A source the person signed in to
 * in the Job Finder browser shows its listings only with that sign-in, so
 * the search read them but the plain read got the sign-in page: the jobs
 * were saved with no listing text, and nothing could be tailored for them.
 * Only when the plain read meets a sign-in is the page read again with the
 * browser's own sign-in (a GET, no script, nothing sent but the cookie).
 */
export function withBrowserSignInRetry(
  plain: ListingHtmlFetcher,
  readWithBrowserSignIn: ListingHtmlFetcher | null,
): ListingHtmlFetcher {
  return async (url, options) => {
    const first = await plain(url, options);
    if (!readWithBrowserSignIn || !looksLikeSignInPage(first)) return first;
    const second = await readWithBrowserSignIn(url, options).catch(
      () => null,
    );
    return second && second.status < 400 && !looksLikeSignInPage(second)
      ? second
      : first;
  };
}

const MAX_RESPONSE_CHARACTERS = 1_500_000;

/** Reads a page with a browser session's cookies (Electron `session.fetch`). */
export function createSessionListingHtmlFetcher(
  getSession: () => {
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
  },
): ListingHtmlFetcher {
  return async (url, options) => {
    const response = await getSession().fetch(url, {
      credentials: "include",
      redirect: "follow",
      signal: options.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
    });
    const text = await response.text();
    return {
      status: response.status,
      html:
        text.length > MAX_RESPONSE_CHARACTERS
          ? text.slice(0, MAX_RESPONSE_CHARACTERS)
          : text,
      finalUrl: response.url || url,
    };
  };
}
