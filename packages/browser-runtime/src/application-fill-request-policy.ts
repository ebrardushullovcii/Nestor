import { FINAL_ACTION_SIGNAL } from "./application-intermediate-mutation-policy";
import {
  carriesPreparedValue,
  requestUrlCarriesPreparedValue,
  valuesCarryPreparedValue,
} from "./application-read-request-policy";
import { readGraphQlRequest, variableStrings } from "./graphql-request";

/**
 * What Fill in for me lets a page send without the person's own click.
 *
 * Nothing that writes. A plain read passes, and so does a GraphQL query
 * (never a mutation) that carries no answer and names no final action: forms
 * like Ashby's load themselves that way. A same-origin read that carries a
 * picker choice just made, and nothing else of the person's, may load the
 * list that depends on it. The exact selected resume and its
 * same-origin presign are judged separately by the attachment policy. Every
 * other request is refused, whatever it is called: autosaves, step saves and
 * analytics posts alike. That closes the class instead of guessing which
 * writes are saves.
 */
export type StrictFillReadDecision =
  | { allowed: true; reason: "plain_read" | "graphql_query" | "dependent_list" }
  | {
      allowed: false;
      reason:
        | "not_a_read"
        | "denied_resource_type"
        | "beacon_query"
        | "carries_answer"
        | "final_signal"
        | "unreadable_url";
    };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DENIED_RESOURCE_TYPES = new Set(["websocket", "eventsource", "ping"]);
// Subresources a page cannot read back are beacons when they carry a query.
const QUERY_GUARDED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "texttrack",
  "other",
]);
// The page's own data calls, where a read can still mean "submit".
const SCRIPTED_RESOURCE_TYPES = new Set(["fetch", "xhr"]);

function decoded(value: string): string {
  let text = value;
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(/(?:%[\da-f]{2})+/giu, (part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
    if (next === text) break;
    text = next;
  }
  return text.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
}

/**
 * The final words in a read's address. Reading a collection
 * (`/api/applications?status=open`) is not creating in it, so collection
 * names are not final words here.
 */
function readSignal(url: URL): string {
  return `${decoded(url.pathname)} ${decoded(url.search)}`.replace(
    /\/(?:applications?|applicants?|candidates?)(?=\/|\s|$)/giu,
    "/collection",
  );
}

/** The values an address carries: its query values and its path segments. */
function addressValues(url: URL): string[] {
  return [
    ...url.searchParams.values(),
    ...url.pathname.split("/").map((segment) => decoded(segment)),
  ].filter(Boolean);
}

function carriesAnswer(url: URL, preparedValues: readonly string[]): boolean {
  return (
    requestUrlCarriesPreparedValue(url.href, preparedValues) ||
    valuesCarryPreparedValue(addressValues(url), preparedValues)
  );
}

/** The final words in an address the run itself opened: the form may be at `/apply`. */
function runNavigationSignal(url: URL): string {
  return readSignal(url).replace(/\/apply(?=\/|\s|$)/giu, "/form");
}

/** Words that make an address a write, wherever they appear in it. */
/**
 * A write named as a whole word, camel case split first: "saveDraft" and
 * "/apply" name one, Ashby's "ApiAutocompleteGeoLocation" does not.
 */
const WRITE_WORD =
  /(?:^|[^a-z])(?:save|submit|apply|update|create|complete|send|post)(?:[^a-z]|$)/iu;
const namesWrite = (text: string) =>
  WRITE_WORD.test(text.replace(/([a-z\d])([A-Z])/gu, "$1 $2"));

/**
 * A read that loads the list depending on a picker choice the run just made
 * (the regions of the chosen country): a same-origin GET from the page's own
 * scripts whose address carries those choices and no other answer, and names
 * no write.
 */
function loadsDependentList(
  url: URL,
  input: {
    method: string;
    resourceType: string;
    preparedValues: readonly string[];
    pickerChoices?: readonly string[];
    frameOrigin?: string | null;
  },
): boolean {
  const chosen = input.pickerChoices ?? [];
  return (
    input.method === "GET" &&
    SCRIPTED_RESOURCE_TYPES.has(input.resourceType) &&
    url.origin === input.frameOrigin &&
    !namesWrite(`${decoded(url.pathname)} ${decoded(url.search)}`) &&
    chosen.length > 0 &&
    carriesAnswer(url, chosen) &&
    !carriesAnswer(
      url,
      input.preparedValues.filter((value) => !chosen.includes(value)),
    )
  );
}

/**
 * Default for anything unknown: refuse. The allow paths are a read that
 * carries no answer and, for the page's own data calls (fetch, XHR) and for
 * every navigation, no final signal in its address; and a GraphQL query on
 * the same terms. A navigation the run itself opened may be the form at
 * `/apply`; one the page started may not. Static files are not checked for
 * final words.
 */
export function classifyStrictFillRead(input: {
  method: string;
  resourceType: string;
  url: string;
  bodyText?: string | null;
  preparedValues: readonly string[];
  /** Picker choices the run made moments ago, label and submitted value. */
  pickerChoices?: readonly string[];
  /** The origin of the frame that sent the request. */
  frameOrigin?: string | null;
  /**
   * A navigation: one the run itself opened (or a redirect of it), or one
   * the page started (a script, a link it followed, or a redirect of that).
   */
  navigation?: "run" | "page";
}): StrictFillReadDecision {
  const method = input.method.trim().toUpperCase();
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { allowed: false, reason: "unreadable_url" };
  }
  const graphQl =
    method === "POST" && SCRIPTED_RESOURCE_TYPES.has(input.resourceType)
      ? readGraphQlRequest(input.bodyText)
      : null;
  if (graphQl?.every((operation) => operation.type === "query")) {
    const carries = (values: readonly string[]) =>
      carriesAnswer(url, values) ||
      carriesPreparedValue(input.bodyText, values) ||
      graphQl.some((operation) =>
        valuesCarryPreparedValue(
          [...operation.literals, ...variableStrings(operation.variables)],
          values,
        ),
      );
    // A picker's own search on the form's site (Ashby's location list)
    // carries what was typed into it, the choice the run is making now,
    // and nothing else of the person's.
    const chosen = input.pickerChoices ?? [];
    const pickerSearch =
      chosen.length > 0 &&
      url.origin === input.frameOrigin &&
      !namesWrite(`${decoded(url.pathname)} ${decoded(url.search)}`) &&
      carries(chosen) &&
      !carries(input.preparedValues.filter((value) => !chosen.includes(value)));
    if (!pickerSearch && carries(input.preparedValues))
      return { allowed: false, reason: "carries_answer" };
    if (
      FINAL_ACTION_SIGNAL.test(
        `${readSignal(url)} ${decoded(input.bodyText ?? "")}`,
      )
    )
      return { allowed: false, reason: "final_signal" };
    return {
      allowed: true,
      reason: pickerSearch ? "dependent_list" : "graphql_query",
    };
  }
  if (!READ_METHODS.has(method))
    return { allowed: false, reason: "not_a_read" };
  if (DENIED_RESOURCE_TYPES.has(input.resourceType))
    return { allowed: false, reason: "denied_resource_type" };
  if (QUERY_GUARDED_RESOURCE_TYPES.has(input.resourceType) && url.search)
    return { allowed: false, reason: "beacon_query" };
  const dependentList =
    carriesAnswer(url, input.preparedValues) &&
    loadsDependentList(url, { ...input, method });
  if (!dependentList && carriesAnswer(url, input.preparedValues))
    return { allowed: false, reason: "carries_answer" };
  const navigation =
    input.navigation ?? (input.resourceType === "document" ? "page" : null);
  if (
    SCRIPTED_RESOURCE_TYPES.has(input.resourceType) || navigation === "page"
      ? FINAL_ACTION_SIGNAL.test(readSignal(url))
      : navigation === "run" &&
        FINAL_ACTION_SIGNAL.test(runNavigationSignal(url))
  )
    return { allowed: false, reason: "final_signal" };
  return {
    allowed: true,
    reason: dependentList ? "dependent_list" : "plain_read",
  };
}

/**
 * Where an upload's redirect may go: the same origin and path it was allowed
 * for, with a query that names no final action and carries no answer.
 * Returns the hop's address, or null.
 */
export function uploadHopStaysOnEndpoint(
  allowedUrl: string,
  location: string,
  preparedValues: readonly string[] = [],
): string | null {
  try {
    const allowed = new URL(allowedUrl);
    const next = new URL(location, allowedUrl);
    return next.origin === allowed.origin &&
      next.pathname === allowed.pathname &&
      !FINAL_ACTION_SIGNAL.test(decoded(next.search)) &&
      !carriesAnswer(next, preparedValues)
      ? next.href
      : null;
  } catch {
    return null;
  }
}
