/**
 * Page-owned reads during unauthorized preparation.
 *
 * The prepare-only guard blocks every mutating request. A page still has to
 * load itself: a form definition, a language file, a module manifest, or the
 * GraphQL queries a single-page application uses for all of its reads. Those
 * are allowed by shape, and refused the moment they would carry a value that
 * is currently in a form field, which is the only way a read could send a
 * prepared answer. The in-page guard mirrors this logic verbatim because it
 * is serialized into the page and cannot import.
 */
const SAFE_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const TELEMETRY_HOST_SUFFIXES = [
  "google-analytics.com",
  "doubleclick.net",
  "segment.io",
  "mixpanel.com",
  "hotjar.com",
] as const;

const TELEMETRY_PATH_SEGMENT =
  /(?:^|\/)\/?(?:analytics|beacon|ping|rum)(?:\/|$)/iu;

const APPLICATION_FORM_FIELD_PATTERN =
  /(?:address|answer|city|country|email|firstname|fullname|lastname|name|phone|postal|question|resume|telephone|zipcode)/u;

export function normalizeRequestMethod(value: string | null | undefined) {
  return (value || "GET").trim().toUpperCase() || "GET";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True when the text contains any prepared value (3+ characters, trimmed). */
export function carriesPreparedValue(
  text: string | null | undefined,
  preparedValues: readonly string[],
): boolean {
  if (!text) return false;
  const haystacks = [text, safeDecode(text)];
  return preparedValues.some((value) => {
    const needle = value.trim();
    return (
      needle.length >= 3 &&
      haystacks.some((haystack) => haystack.includes(needle))
    );
  });
}

/** True only when a URL query value carries prepared data. */
export function requestUrlCarriesPreparedValue(
  value: string | null | undefined,
  preparedValues: readonly string[],
): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value, "https://invalid.local");
    return (
      carriesPreparedValue(parsed.pathname, preparedValues) ||
      [...parsed.searchParams.values()].some((queryValue) =>
        carriesPreparedValue(queryValue, preparedValues),
      )
    );
  } catch {
    return false;
  }
}

/** Generic telemetry/monitoring request shapes that never represent a form submission. */
export function isTelemetryRequestUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value, "https://invalid.local");
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const telemetrySubdomain = /^(?:analytics|beacon|metrics|rum|sa|telemetry)\./u.test(
    hostname,
  );
  const trackingPixel = /(?:^|\/)(?:pixel|simple)(?:\.gif)?$/u.test(pathname);
  const pageViewSignal =
    parsed.searchParams.has("page_id") ||
    parsed.searchParams.get("type")?.toLowerCase() === "pageview";
  if (
    TELEMETRY_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
  ) {
    return true;
  }
  if (
    (hostname === "sentry.io" || hostname.endsWith(".sentry.io")) &&
    /(?:^|\/)(?:api\/\d+\/)?(?:envelope|store|minidump|security)(?:\/|$)/u.test(
      pathname,
    )
  ) {
    return true;
  }
  return (
    pathname === "/cdn-cgi/rum" ||
    pathname === "/cdn-cgi/beacon" ||
    (telemetrySubdomain && (trackingPixel || pageViewSignal)) ||
    TELEMETRY_PATH_SEGMENT.test(pathname)
  );
}

/**
 * A GraphQL document whose every operation is a query. Mutations and
 * subscriptions, batched or not, are never reads.
 */
export function isGraphQlReadBody(
  bodyText: string | null | undefined,
): boolean {
  if (!bodyText || bodyText.length > 65_536) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  if (operations.length === 0) return false;
  return operations.every((operation) => {
    if (typeof operation !== "object" || operation === null) return false;
    const query = (operation as { query?: unknown }).query;
    if (typeof query !== "string") return false;
    const document = query.replace(/#[^\n]*/g, " ").trim();
    return (
      /^(?:query\b|\{)/u.test(document) &&
      !/\b(?:mutation|subscription)\b/u.test(document)
    );
  });
}

export interface PageOwnedReadRequest {
  method: string;
  url: string | null;
  bodyText?: string | null;
  bodyIsFormData?: boolean;
  preparedValues: readonly string[];
}

function carriesApplicationFormFields(
  bodyText: string | null | undefined,
): boolean {
  if (!bodyText) return false;
  const normalizedFieldName = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  const isApplicationFieldName = (value: string) =>
    APPLICATION_FORM_FIELD_PATTERN.test(normalizedFieldName(value));

  if (/content-disposition\s*:\s*form-data/iu.test(bodyText)) {
    return true;
  }
  try {
    const containsApplicationField = (value: unknown): boolean => {
      if (Array.isArray(value)) {
        return value.some(containsApplicationField);
      }
      if (typeof value !== "object" || value === null) {
        return false;
      }
      return Object.entries(value).some(
        ([key, nested]) =>
          isApplicationFieldName(key) || containsApplicationField(nested),
      );
    };
    if (containsApplicationField(JSON.parse(bodyText))) {
      return true;
    }
  } catch {
    // A non-JSON telemetry payload may still be safe by shape below.
  }
  if (!bodyText.includes("=")) return false;
  try {
    return [...new URLSearchParams(bodyText).keys()].some(
      isApplicationFieldName,
    );
  } catch {
    return false;
  }
}

/** Whether a fetch or XHR is a page-owned read that carries nothing prepared. */
export function isPageOwnedReadRequest(input: PageOwnedReadRequest): boolean {
  const method = normalizeRequestMethod(input.method);
  const carriesPrepared =
    requestUrlCarriesPreparedValue(input.url, input.preparedValues) ||
    carriesPreparedValue(input.bodyText, input.preparedValues);
  if (carriesPrepared) {
    return false;
  }
  if (SAFE_READ_METHODS.has(method)) {
    return true;
  }
  if (method === "POST" && isGraphQlReadBody(input.bodyText)) {
    return true;
  }
  if (
    method === "POST" &&
    isTelemetryRequestUrl(input.url) &&
    input.bodyIsFormData !== true &&
    !carriesApplicationFormFields(input.bodyText)
  ) {
    return true;
  }
  return false;
}
