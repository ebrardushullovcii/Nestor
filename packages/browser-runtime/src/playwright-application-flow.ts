import { createHash } from "node:crypto";
import { installMutationResponseBodyObserver } from "./mutation-response-body";
import {
  classifyAttachmentUpload,
  classifyUploadBind,
  uploadHandlesIn,
  type AttachmentUploadWindow,
} from "./application-attachment-upload-policy";
import type { ApplyRequestPermit, ApplyUploadFile } from "@nestor/contracts";
import {
  classifyStrictFillRead,
  uploadHopStaysOnEndpoint,
} from "./application-fill-request-policy";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  APIResponse,
  BrowserContext,
  Frame,
  Locator,
  Page,
  Request,
  Route,
} from "playwright";
import {
  ApplyExecutionResultSchema,
  type ApplyExecutionModelUse,
  type ApplyExecutionResult,
  type ApplicationAttemptBlocker,
  type ApplicationAttemptCheckpoint,
  type ApplicationAttemptExternalWriteEvidence,
  type ApplicationAttemptQuestion,
  type ApplyBlockedAttempt,
} from "@nestor/contracts";
import {
  carriesPreparedValue,
  isPageOwnedReadRequest,
  isTelemetryRequestUrl,
  requestUrlCarriesPreparedValue,
} from "./application-read-request-policy";
import {
  classifyIntermediateMutationRequest,
  FINAL_ACTION_SIGNAL,
  INTERMEDIATE_MUTATION_WINDOW_DURATION_MS,
  INTERMEDIATE_MUTATION_WINDOW_MAX_REQUESTS,
  type IntermediateMutationResourceKind,
  type IntermediateMutationWindowSnapshot,
} from "./application-intermediate-mutation-policy";
import type { ExecuteApplicationFlowInput } from "./runtime-types";
import { isHttpUrlLike } from "./playwright-browser-runtime-utils";

/**
 * An attempt the prepare-only guard stopped. The shared shape lives in
 * contracts so the workflow layer can judge one without reaching in here.
 */
export type PrepareOnlyBlockedAttempt = ApplyBlockedAttempt;

type WebTransportPageConstructor = new (url: string | URL) => unknown;

const PREPARE_ONLY_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Channels and beacons are never opened while preparation is unauthorized.
const PREPARE_ONLY_DENIED_RESOURCE_TYPES = new Set([
  "websocket",
  "eventsource",
  "ping",
]);

// Resources the page guard cannot inspect are beacons when they carry a query
// string. Fetch and XHR are judged by the page guard, which sees the form's
// current values, and by the read policy below.
const PREPARE_ONLY_QUERY_GUARDED_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "texttrack",
  "other",
]);

const PREPARE_ONLY_READ_RESOURCE_TYPES = new Set(["fetch", "xhr"]);

/**
 * Network-layer view of a page-owned read: the page guard has already
 * refused anything carrying a form value, so this only re-checks the shape.
 */
function isNetworkLayerPageOwnedRead(
  request: Request,
  preparedValues: readonly string[],
): boolean {
  const telemetry = isTelemetryRequestUrl(request.url());
  if (
    !telemetry &&
    !PREPARE_ONLY_READ_RESOURCE_TYPES.has(request.resourceType())
  ) {
    return false;
  }
  return isPageOwnedReadRequest({
    method: request.method(),
    url: request.url(),
    bodyText: request.postData(),
    bodyIsFormData: /\bmultipart\/form-data\b/iu.test(
      request.headers()["content-type"] ?? "",
    ),
    preparedValues,
  });
}

/** Told of each upload permit the moment the fence issues it, per page. */
const prepareOnlyPermitListeners = new WeakMap<
  Page,
  (request: Request, permit: ApplyRequestPermit) => void
>();

/**
 * Hears every upload permit on this page as it is issued, before the request
 * goes out, so a carrier is known even if no answer ever comes.
 */
export function onPrepareOnlyUploadPermit(
  page: Page,
  listener: (request: Request, permit: ApplyRequestPermit) => void,
): void {
  prepareOnlyPermitListeners.set(page, listener);
}

/** Why the fence let each upload through; see `getPrepareOnlyRequestPermit`. */
const prepareOnlyRequestPermits = new WeakMap<Request, ApplyRequestPermit>();

/**
 * The permit the prepare-only fence issued for an upload request. No permit
 * means the fence never let the request out as an upload.
 */
export function getPrepareOnlyRequestPermit(
  request: Request,
): ApplyRequestPermit | null {
  return prepareOnlyRequestPermits.get(request) ?? null;
}

function exactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Marks the exact address the run itself is about to open, so the fence
 * knows that one navigation is the run's own (it may be the form at
 * `/apply`). The grant is used up by that navigation: anything opened later,
 * even the same address, was started by the page and is checked as such.
 */
export function allowPrepareOnlyRunNavigation(page: Page, url: string): void {
  prepareOnlyNetworkGuardStates.get(page)?.runNavigations.add(exactUrl(url));
}

function requestFrameOrigin(request: Request): string | null {
  try {
    return new URL(request.frame().url()).origin;
  } catch {
    return null;
  }
}

/**
 * Sends a request Fill allowed without letting the browser follow its
 * redirects on its own: Playwright never routes a redirect hop, so each hop
 * is fetched here and only when `hopAllowed` lets that exact address and
 * method through. A navigation that redirected is handed to the browser as
 * one redirect to the checked final address. Returns the final answer, or
 * null when a hop was refused; nothing was sent there.
 */
async function forwardCheckingHops(
  route: Route,
  request: Request,
  hopAllowed: (url: string, method: string, body: string | null) => boolean,
  /** Runs on the final answer before the page sees it. */
  beforeAnswer?: (response: APIResponse) => Promise<void>,
): Promise<APIResponse | null> {
  let url = request.url();
  let method = request.method();
  let postData: Buffer | undefined = request.postDataBuffer() ?? undefined;
  // A later hop may be another site: it never gets this request's cookies or
  // credentials; the context's own jar decides what it sends there.
  const hopHeaders = Object.fromEntries(
    Object.entries(request.headers()).filter(
      ([name]) => !/^(?:cookie|authorization)$/iu.test(name),
    ),
  );
  for (let hop = 0; hop < 6; hop++) {
    const response = await route.fetch({
      url,
      method,
      ...(hop > 0 ? { headers: hopHeaders } : {}),
      ...(postData ? { postData } : {}),
      maxRedirects: 0,
    });
    const status = response.status();
    if (status < 300 || status >= 400 || status === 304) {
      await beforeAnswer?.(response);
      if (hop > 0 && request.isNavigationRequest())
        await route.fulfill({ status: 302, headers: { location: url } });
      else await route.fulfill({ response });
      return response;
    }
    let next: string;
    try {
      next = new URL(response.headers()["location"] ?? "", url).href;
    } catch {
      return null;
    }
    if (
      status === 303 ||
      ((status === 301 || status === 302) && method !== "GET")
    ) {
      method = "GET";
      postData = undefined;
    }
    if (!hopAllowed(next, method, postData?.toString("utf8") ?? null))
      return null;
    url = next;
  }
  return null;
}

/**
 * What one allowed upload leg's answer means for the next. A presign's
 * answer names the handles a bind may carry back to the same endpoint; the
 * storage taking the file opens room for that one bind.
 */
async function noteUploadLeg(
  page: Page,
  grant: AttachmentUploadWindow,
  request: Request,
  answer: APIResponse,
): Promise<void> {
  const ok = answer.status() >= 200 && answer.status() < 300;
  const presign = getPrepareOnlyRequestPermit(request)?.uploadLeg === "presign";
  if (!presign) grant.fileAnsweredAtMs = Date.now();
  if (!ok) return;
  if (presign) {
    const text = await answer.text().catch(() => "");
    const url = new URL(request.url());
    grant.presignEndpoint = `${url.origin}${url.pathname}`;
    grant.handles = uploadHandlesIn(text.slice(0, 65_536), grant);
  } else {
    grant.bindsRemaining = 1;
    grant.expiresAtMs = Math.max(grant.expiresAtMs, Date.now() + 15_000);
  }
  await shareUploadGrant(page, grant);
}

/** Gives every frame's guard the network's view of the upload window. */
async function shareUploadGrant(
  page: Page,
  grant: AttachmentUploadWindow,
): Promise<void> {
  for (const frame of page.frames())
    await frame
      .evaluate((windowGrant) => {
        const state = (window as unknown as Record<string, unknown>)[
          "__nestorPrepareOnlyMutationGuardV1"
        ] as
          | { attachmentUploadWindow: AttachmentUploadWindow | null }
          | undefined;
        if (state?.attachmentUploadWindow)
          state.attachmentUploadWindow = {
            ...state.attachmentUploadWindow,
            handles: windowGrant.handles ?? [],
            bindsRemaining: windowGrant.bindsRemaining ?? 0,
            expiresAtMs: windowGrant.expiresAtMs,
          };
      }, grant)
      .catch(() => undefined);
}

export interface PrepareOnlyGuardSnapshot {
  installed: boolean;
  blockedAttempts: PrepareOnlyBlockedAttempt[];
}

const prepareOnlyNetworkGuardStates = new WeakMap<
  Page,
  {
    blockedAttempts: PrepareOnlyBlockedAttempt[];
    preparedValues: Set<string>;
    /** Exact addresses the run is about to open, each good for one navigation. */
    runNavigations: Set<string>;
    allowedIntermediateRequests: WeakSet<Request>;
    verifiedIntermediateWriteCount: number;
    pendingMutationResponses: Set<Promise<void>>;
    intermediateMutationsAuthorized: boolean;
    attachmentUploadsAuthorized: boolean;
    attachmentUploadWindow: AttachmentUploadWindow | null;
    intermediateMutationAllowedOrigins: string[];
    intermediateMutationWindow: IntermediateMutationWindowSnapshot | null;
    authorizedFormActionWindow: {
      method: string;
      url: string;
      expiresAtMs: number;
      remainingRequests: number;
      completion: Promise<void>;
      resolveCompletion: () => void;
    } | null;
    /** Epoch ms until which the one authorized send may go out. */
    finalActionAllowedUntilMs: number;
    initScriptInstalled: boolean;
    serviceWorkerInitScriptInstalled: boolean;
    webSocketListenerInstalled: boolean;
  }
>();
// Pins are captured from actual frames when a bounded field window opens.
// A request can save only to its initiating frame's own pinned origin.
const intermediateFrameOrigins = new WeakMap<Page, Map<Frame, string>>();

export function readPrepareOnlyIntermediateWriteCount(page: Page): number {
  return (
    prepareOnlyNetworkGuardStates.get(page)?.verifiedIntermediateWriteCount ?? 0
  );
}

export async function drainPrepareOnlyIntermediateWrites(
  page: Page,
): Promise<void> {
  const pending =
    prepareOnlyNetworkGuardStates.get(page)?.pendingMutationResponses;
  while (pending?.size) await Promise.all([...pending]);
}

interface AuthorizedFormActionWindow {
  method: string;
  url: string;
  token: string;
  expiresAtMs: number;
}

export async function openPrepareOnlyAuthorizedFormActionWindow(
  page: Page,
  locator: Locator,
  durationMs: number | null = 20_000,
): Promise<void> {
  const networkGuardState = prepareOnlyNetworkGuardStates.get(page);
  if (!networkGuardState) {
    throw new Error("Prepare-only network guard is not installed.");
  }
  const expiresAtMs =
    durationMs === null ? Number.MAX_SAFE_INTEGER : Date.now() + durationMs;
  const token = `authorized-form-action-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const action = await locator.evaluate(
    (element, input) => {
      const actionElement = element as HTMLButtonElement | HTMLInputElement;
      const form = actionElement.form;
      if (!form || actionElement.disabled) return null;
      const actionUrl = new URL(
        (actionElement.hasAttribute("formaction")
          ? actionElement.formAction
          : form.action) || window.location.href,
        window.location.href,
      ).toString();
      const method = (
        (actionElement.hasAttribute("formmethod")
          ? actionElement.formMethod
          : form.method) || "GET"
      ).toUpperCase();
      if (method !== "POST") return null;
      actionElement.dataset.nestorAuthorizedFormAction = input.token;
      const state = (window as unknown as Record<string, unknown>)[
        "__nestorPrepareOnlyMutationGuardV1"
      ] as
        | {
            authorizedFormActionWindow?: AuthorizedFormActionWindow | null;
          }
        | undefined;
      if (state) {
        state.authorizedFormActionWindow = {
          method,
          url: actionUrl,
          token: input.token,
          expiresAtMs: input.expiresAtMs,
        };
      }
      return { method, url: actionUrl };
    },
    { token, expiresAtMs },
  );
  if (!action) {
    throw new Error("The authorized control is not attached to a form.");
  }
  let resolveCompletion: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  networkGuardState.authorizedFormActionWindow = {
    method: action.method,
    url: action.url,
    expiresAtMs,
    remainingRequests: 1,
    completion,
    resolveCompletion,
  };
}

export async function waitForPrepareOnlyAuthorizedFormAction(
  page: Page,
  timeoutMs = 3_000,
): Promise<void> {
  const completion =
    prepareOnlyNetworkGuardStates.get(page)?.authorizedFormActionWindow
      ?.completion;
  if (!completion) return;
  await Promise.race([
    completion,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export async function closePrepareOnlyAuthorizedFormActionWindow(
  page: Page,
): Promise<void> {
  const networkGuardState = prepareOnlyNetworkGuardStates.get(page);
  if (!networkGuardState) return;
  networkGuardState.authorizedFormActionWindow = null;
  await page
    .evaluate(() => {
      const state = (window as unknown as Record<string, unknown>)[
        "__nestorPrepareOnlyMutationGuardV1"
      ] as
        | { authorizedFormActionWindow?: AuthorizedFormActionWindow | null }
        | undefined;
      if (state) state.authorizedFormActionWindow = null;
    })
    .catch(() => undefined);
}

/**
 * Lets the one authorized send through the prepare-only guard.
 *
 * Preparation installs a guard that aborts every non-read request and cancels
 * the form's own submit. That guard stayed on the page when the submission
 * path pressed the send control, so "Send for me" clicked a button whose
 * request was aborted and could only ever report an uncertain outcome. The
 * window is short and closed again by the caller; it is only ever opened
 * after preflight, on the exact control the authority covers.
 */
export async function openPrepareOnlyFinalActionWindow(
  page: Page,
  durationMs = 20_000,
): Promise<void> {
  const networkGuardState = prepareOnlyNetworkGuardStates.get(page);
  if (networkGuardState) {
    networkGuardState.finalActionAllowedUntilMs = Date.now() + durationMs;
  }
  await page
    .evaluate(() => {
      const state = (window as unknown as Record<string, unknown>)[
        "__nestorPrepareOnlyMutationGuardV1"
      ] as { finalActionAllowed?: boolean } | undefined;
      if (state) state.finalActionAllowed = true;
    })
    .catch(() => undefined);
}

export async function closePrepareOnlyFinalActionWindow(
  page: Page,
): Promise<void> {
  const networkGuardState = prepareOnlyNetworkGuardStates.get(page);
  if (networkGuardState) {
    networkGuardState.finalActionAllowedUntilMs = 0;
  }
  await page
    .evaluate(() => {
      const state = (window as unknown as Record<string, unknown>)[
        "__nestorPrepareOnlyMutationGuardV1"
      ] as { finalActionAllowed?: boolean } | undefined;
      if (state) state.finalActionAllowed = false;
    })
    .catch(() => undefined);
}

/**
 * Runs inside the application page. Keep this function self-contained because
 * Playwright serializes it before evaluation in the browser context.
 */
export function installPrepareOnlyMutationGuardInPage(guardInput: {
  intermediateMutationsAuthorized: boolean;
  finalActionSignal: string;
}): void {
  const { intermediateMutationsAuthorized } = guardInput;
  interface InternalGuardState extends PrepareOnlyGuardSnapshot {
    preparedValues: string[];
    intermediateMutationsAuthorized: boolean;
    intermediateMutationWindow: IntermediateMutationWindowSnapshot | null;
    attachmentUploadWindow: AttachmentUploadWindow | null;
    authorizedFormActionWindow: AuthorizedFormActionWindow | null;
    submitListenerInstalled: boolean;
    finalControlListenerInstalled: boolean;
    /**
     * True only while Job Finder presses the one authorized send control.
     * The guard then lets the form's own submit and requests through.
     */
    finalActionAllowed: boolean;
    formSubmitWrapper: typeof HTMLFormElement.prototype.submit | null;
    formRequestSubmitWrapper:
      | typeof HTMLFormElement.prototype.requestSubmit
      | null;
    sendBeaconWrapper: typeof navigator.sendBeacon | null;
    fetchWrapper: typeof window.fetch | null;
    xhrOpenWrapper: typeof XMLHttpRequest.prototype.open | null;
    xhrSendWrapper: typeof XMLHttpRequest.prototype.send | null;
    xhrMethods: WeakMap<XMLHttpRequest, { method: string; url: string | null }>;
    webSocketWrapper: typeof WebSocket | null;
    eventSourceWrapper: typeof EventSource | null;
    webTransportWrapper: WebTransportPageConstructor | null;
    windowOpenWrapper: typeof window.open | null;
  }

  const pageWindow = window as unknown as Record<string, unknown>;
  const existingState = pageWindow["__nestorPrepareOnlyMutationGuardV1"] as
    | InternalGuardState
    | undefined;
  const state: InternalGuardState = existingState ?? {
    installed: true,
    blockedAttempts: [],
    preparedValues: [],
    intermediateMutationsAuthorized,
    intermediateMutationWindow: null,
    attachmentUploadWindow: null,
    authorizedFormActionWindow: null,
    submitListenerInstalled: false,
    finalControlListenerInstalled: false,
    finalActionAllowed: false,
    formSubmitWrapper: null,
    formRequestSubmitWrapper: null,
    sendBeaconWrapper: null,
    fetchWrapper: null,
    xhrOpenWrapper: null,
    xhrSendWrapper: null,
    xhrMethods: new WeakMap(),
    webSocketWrapper: null,
    eventSourceWrapper: null,
    webTransportWrapper: null,
    windowOpenWrapper: null,
  };
  state.intermediateMutationsAuthorized = intermediateMutationsAuthorized;
  state.preparedValues ??= [];
  state.finalActionAllowed ??= false;
  state.authorizedFormActionWindow ??= null;
  pageWindow["__nestorPrepareOnlyMutationGuardV1"] = state;

  const normalizeMethod = (value: string | null | undefined): string =>
    (value || "GET").trim().toUpperCase() || "GET";
  const normalizeUrl = (value: unknown): string | null => {
    try {
      if (typeof value === "string" || value instanceof URL) {
        return new URL(String(value), window.location.href).toString();
      }
      if (typeof Request !== "undefined" && value instanceof Request) {
        return new URL(value.url, window.location.href).toString();
      }
    } catch {
      return null;
    }
    return null;
  };
  const recordBlockedAttempt = (
    kind: PrepareOnlyBlockedAttempt["kind"],
    method: string,
    url: string | null,
    carriedPreparedValue?: boolean,
  ): void => {
    state.blockedAttempts.push({
      kind,
      method: normalizeMethod(method),
      url,
      at: new Date().toISOString(),
      ...(carriedPreparedValue === undefined ? {} : { carriedPreparedValue }),
    });
    state.blockedAttempts = state.blockedAttempts.slice(-32);
  };
  const readFieldValues = (
    root: {
      querySelectorAll?: (selector: string) => ArrayLike<unknown>;
    } | null,
  ): string[] => {
    const values: string[] = [];
    if (!root || typeof root.querySelectorAll !== "function") return values;
    for (const element of Array.from(
      root.querySelectorAll(
        "input, textarea, select, [contenteditable='true']",
      ),
    ) as Array<{
      type?: string;
      value?: unknown;
      textContent?: string | null;
    }>) {
      const value =
        typeof element.value === "string"
          ? element.value
          : (element.textContent ?? "");
      const trimmed = value.trim();
      if (trimmed.length >= 3 && state.preparedValues.includes(trimmed)) {
        values.push(trimmed);
      }
    }
    return values;
  };
  /** A form submission always carries its own filled fields. */
  const formCarriesPreparedValue = (form: unknown): boolean | undefined =>
    form && typeof form === "object"
      ? readFieldValues(
          form as {
            querySelectorAll?: (selector: string) => ArrayLike<unknown>;
          },
        ).length > 0
      : undefined;
  // Mirrors application-read-request-policy.ts; this function is serialized
  // into the page and cannot import. A page-owned read (safe method, or a
  // GraphQL query) is allowed unless it carries a value that is currently in
  // a form field, which is the only way a read could send a prepared answer.
  const collectPreparedValues = (): string[] => [...state.preparedValues];
  const requestCarriesPreparedValue = (
    url: string | null,
    bodyText: string | null,
  ): boolean => {
    const preparedValues = collectPreparedValues();
    let urlCarriesValue = false;
    if (url) {
      try {
        const parsed = new URL(url, window.location.href);
        urlCarriesValue =
          carriesPreparedValue(parsed.pathname, preparedValues) ||
          [...parsed.searchParams.values()].some((queryValue) =>
            carriesPreparedValue(queryValue, preparedValues),
          );
      } catch {
        urlCarriesValue = false;
      }
    }
    return urlCarriesValue || carriesPreparedValue(bodyText, preparedValues);
  };
  const carriesPreparedValue = (
    text: string | null,
    preparedValues: readonly string[],
  ): boolean => {
    if (!text) return false;
    let decoded = text;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      /* keep the raw text */
    }
    return preparedValues.some(
      (value) => text.includes(value) || decoded.includes(value),
    );
  };
  const isGraphQlReadBody = (bodyText: string | null): boolean => {
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
      const graphDocument = query.replace(/#[^\n]*/g, " ").trim();
      return (
        /^(?:query\b|\{)/u.test(graphDocument) &&
        !/\b(?:mutation|subscription)\b/u.test(graphDocument)
      );
    });
  };
  const carriesApplicationFormFields = (bodyText: string | null): boolean => {
    if (!bodyText) return false;
    const isApplicationFieldName = (value: string): boolean =>
      /(?:address|answer|city|country|email|firstname|fullname|lastname|name|phone|postal|question|resume|telephone|zipcode)/u.test(
        value.toLowerCase().replace(/[^a-z0-9]+/gu, ""),
      );
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
  };
  const isTelemetryRequest = (value: string | null): boolean => {
    if (!value) return false;
    let parsed: URL;
    try {
      parsed = new URL(value, window.location.href);
    } catch {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const telemetrySubdomain =
      /^(?:analytics|beacon|metrics|rum|sa|telemetry)\./u.test(hostname);
    const trackingPixel = /(?:^|\/)(?:pixel|simple)(?:\.gif)?$/u.test(pathname);
    const pageViewSignal =
      parsed.searchParams.has("page_id") ||
      parsed.searchParams.get("type")?.toLowerCase() === "pageview";
    const hostSuffixes = [
      "google-analytics.com",
      "doubleclick.net",
      "segment.io",
      "mixpanel.com",
      "hotjar.com",
    ];
    if (
      hostSuffixes.some(
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
      /(?:^|\/)(?:analytics|beacon|ping|rum)(?:\/|$)/u.test(pathname)
    );
  };
  // The site's own lookups on what was typed, such as Greenhouse's email
  // check on email-address-validator.us.greenhouse.io: a GET to the page's
  // own site (the same registrable domain), naming no write and no final
  // action, while the person's authority lets the site save fields anyway.
  const checksOnSameSite = (
    method: string,
    url: string | null,
    bodyText: string | null,
  ): boolean => {
    if (!state.intermediateMutationsAuthorized || method !== "GET" || bodyText)
      return false;
    let parsed: URL;
    try {
      parsed = new URL(url ?? "", window.location.href);
    } catch {
      return false;
    }
    const site = (host: string): string => {
      const labels = host.toLowerCase().split(".");
      // example.co.uk keeps three labels; example.com keeps two.
      const keep =
        labels.length > 2 &&
        /^(?:co|com|org|net|ac|gov|edu)$/u.test(labels.at(-2) ?? "") &&
        (labels.at(-1)?.length ?? 0) === 2
          ? 3
          : 2;
      return labels.slice(-keep).join(".");
    };
    if (
      !/^https?:$/u.test(parsed.protocol) ||
      (parsed.hostname !== window.location.hostname &&
        (/^[\d.]+$|:/u.test(parsed.hostname) ||
          site(parsed.hostname) !== site(window.location.hostname)))
    )
      return false;
    let address = `${parsed.pathname} ${parsed.search}`;
    try {
      address = decodeURIComponent(address);
    } catch {
      /* keep the raw address */
    }
    return !(
      /save|submit|apply|update|create|complete|send|post/iu.test(address) ||
      new RegExp(guardInput.finalActionSignal, "iu").test(address)
    );
  };
  const isPageOwnedRead = (
    method: string,
    url: string | null,
    bodyText: string | null,
    bodyIsFormData = false,
  ): boolean => {
    const normalized = normalizeMethod(method);
    const carriesPrepared = requestCarriesPreparedValue(url, bodyText);
    if (carriesPrepared) {
      return checksOnSameSite(normalized, url, bodyText);
    }
    if (["GET", "HEAD", "OPTIONS"].includes(normalized)) {
      return true;
    }
    if (normalized === "POST" && isGraphQlReadBody(bodyText)) {
      return true;
    }
    if (
      normalized === "POST" &&
      isTelemetryRequest(url) &&
      !bodyIsFormData &&
      !carriesApplicationFormFields(bodyText)
    ) {
      return true;
    }
    return false;
  };
  const canAllowIntermediateRequest = (input: {
    bodyText?: string | null;
    kind: IntermediateMutationResourceKind;
    method: string;
    url: string | null;
  }): boolean => {
    if (state.finalActionAllowed) {
      return true;
    }
    const mutationWindow = state.intermediateMutationWindow;
    if (
      !state.intermediateMutationsAuthorized ||
      !mutationWindow ||
      Date.now() > mutationWindow.expiresAtMs ||
      mutationWindow.remainingRequests <= 0 ||
      !["fetch", "xhr"].includes(input.kind) ||
      !["POST", "PUT", "PATCH"].includes(normalizeMethod(input.method))
    ) {
      return false;
    }
    let parsedUrl: URL;
    try {
      if (!input.url) {
        return false;
      }
      parsedUrl = new URL(input.url);
    } catch {
      return false;
    }
    if (parsedUrl.origin !== mutationWindow.expectedOrigin) {
      return false;
    }
    if ((input.bodyText?.length ?? 0) > 65_536) return false;
    const decode = (value: string): string => {
      let text = value;
      for (let pass = 0; pass < 4; pass++) {
        const next = text
          .replace(/(?:%[\da-f]{2})+/giu, (part) => {
            try {
              return decodeURIComponent(part);
            } catch {
              return part;
            }
          })
          .replace(/\\u([\da-f]{4})/giu, (_match: string, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          )
          .replace(/\\(["'\\])/gu, "$1");
        if (next === text) break;
        text = next;
      }
      return text;
    };
    const signal =
      `${decode(parsedUrl.pathname)} ${decode(parsedUrl.search)} ${decode(input.bodyText ?? "")}`
        .replace(/\\(["'])/gu, "$1")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    const finalActionSignal = new RegExp(guardInput.finalActionSignal, "iu");
    const intermediateActionSignal =
      /(?:^|[^a-z0-9])(?:autosave|auto[-_\s]*save|draft|save[-_\s]*(?:field|answer|progress|draft)?|update[-_\s]*(?:field|answer|progress|draft|application|form)?|set[-_\s]*(?:form[-_\s]*)?value|field|answer|attachment|upload|progress)(?:[^a-z0-9]|$)/iu;
    if (
      /\\u[\da-f]{4}|%[\da-f]{2}/iu.test(signal) ||
      finalActionSignal.test(signal) ||
      !intermediateActionSignal.test(signal)
    ) {
      return false;
    }
    mutationWindow.remainingRequests -= 1;
    return true;
  };

  // This only forwards the selected file to the network fence. That fence
  // verifies its digest and refuses mixed file-and-answer/application payloads.
  const canForwardAttachment = (
    method: string,
    body: unknown,
    url: string | null,
  ): boolean => {
    const grant = state.attachmentUploadWindow;
    if (
      !grant ||
      Date.now() > grant.expiresAtMs ||
      !["POST", "PUT"].includes(normalizeMethod(method))
    )
      return false;
    // The one bind after the storage took the file: it names a handle the
    // presign handed out. The network fence checks it exactly.
    if (
      typeof body === "string" &&
      body.length <= 16_384 &&
      url &&
      new URL(url).origin === grant.sourceOrigin &&
      (grant.bindsRemaining ?? 0) > 0 &&
      grant.handles?.some((handle) => body.includes(handle)) &&
      !requestCarriesPreparedValue(url, body)
    ) {
      grant.bindsRemaining = 0;
      return true;
    }
    if (grant.remainingRequests < 1) return false;
    // A presign never takes the last allowance: that one is the file's.
    if (
      typeof body === "string" &&
      body.length <= 16_384 &&
      grant.remainingRequests >= 2 &&
      url &&
      new URL(url).origin === grant.sourceOrigin &&
      /upload|presign/iu.test(body)
    ) {
      grant.remainingRequests -= 1;
      return true;
    }
    const files =
      body instanceof FormData
        ? [...body.values()].filter((value) => typeof value !== "string")
        : body instanceof Blob
          ? [body]
          : [];
    if (
      files.length !== 1 ||
      files[0]!.size !== grant.byteLength ||
      (files[0] instanceof File && files[0].name !== grant.fileName)
    )
      return false;
    grant.remainingRequests -= 1;
    return true;
  };

  const authorizedSubmitter = (
    form: HTMLFormElement,
    submitter: HTMLElement | null,
  ): boolean => {
    const authorized = state.authorizedFormActionWindow;
    return Boolean(
      authorized &&
      submitter &&
      (submitter as HTMLButtonElement | HTMLInputElement).form === form &&
      submitter.dataset.nestorAuthorizedFormAction === authorized.token &&
      Date.now() <= authorized.expiresAtMs &&
      normalizeMethod(
        submitter.hasAttribute("formmethod")
          ? (submitter as HTMLButtonElement | HTMLInputElement).formMethod
          : form.method,
      ) === authorized.method &&
      normalizeUrl(
        (submitter.hasAttribute("formaction")
          ? (submitter as HTMLButtonElement | HTMLInputElement).formAction
          : form.action) || window.location.href,
      ) === authorized.url,
    );
  };

  if (!state.submitListenerInstalled) {
    document.addEventListener(
      "submit",
      (event) => {
        if (state.finalActionAllowed) {
          return;
        }
        const form =
          event.target instanceof HTMLFormElement ? event.target : null;
        const submitter =
          event instanceof SubmitEvent && event.submitter instanceof HTMLElement
            ? event.submitter
            : null;
        if (form && authorizedSubmitter(form, submitter)) {
          state.authorizedFormActionWindow = null;
          return;
        }
        if (formCarriesPreparedValue(form) === true) {
          recordBlockedAttempt(
            "dom_submit",
            form?.method ?? "FORM",
            normalizeUrl(form?.action ?? window.location.href),
            true,
          );
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    state.submitListenerInstalled = true;
  }
  if (!state.finalControlListenerInstalled) {
    document.addEventListener(
      "click",
      (event) => {
        if (state.finalActionAllowed || !state.preparedValues.length) return;
        const control =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>(
                'button, input[type="button"], [role="button"]',
              )
            : null;
        if (!control) return;
        const form = (control as HTMLButtonElement).form;
        if (form && authorizedSubmitter(form, control)) return;
        const label =
          control.getAttribute("aria-label") ||
          (control instanceof HTMLInputElement
            ? control.value
            : control.textContent) ||
          "";
        if (!new RegExp(guardInput.finalActionSignal, "iu").test(label)) return;
        recordBlockedAttempt(
          "dom_submit",
          "POST",
          normalizeUrl(form?.action || window.location.href),
        );
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    state.finalControlListenerInstalled = true;
  }

  if (HTMLFormElement.prototype.submit !== state.formSubmitWrapper) {
    // Called below with the exact form as `this`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalFormSubmit = HTMLFormElement.prototype.submit;
    const guardedFormSubmit: typeof HTMLFormElement.prototype.submit =
      function guardedFormSubmit(this: HTMLFormElement): void {
        // The authorized send (or the person finishing the form) often goes
        // through the site's own script calling submit().
        if (state.finalActionAllowed) {
          originalFormSubmit.call(this);
          return;
        }
        if (formCarriesPreparedValue(this) === true) {
          recordBlockedAttempt(
            "form_submit",
            this.method || "FORM",
            normalizeUrl(this.action || window.location.href),
            true,
          );
        }
      };
    HTMLFormElement.prototype.submit = guardedFormSubmit;
    state.formSubmitWrapper = guardedFormSubmit;
  }

  if (
    HTMLFormElement.prototype.requestSubmit !== state.formRequestSubmitWrapper
  ) {
    // Called below with the exact form as `this`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    const guardedRequestSubmit: typeof HTMLFormElement.prototype.requestSubmit =
      function guardedRequestSubmit(
        this: HTMLFormElement,
        submitter?: HTMLElement,
      ): void {
        if (state.finalActionAllowed) {
          originalRequestSubmit.call(this, submitter);
          return;
        }
        const selected =
          submitter ??
          this.querySelector<HTMLElement>(
            "[data-nestor-authorized-form-action]",
          );
        if (authorizedSubmitter(this, selected)) {
          originalRequestSubmit.call(this, selected);
          return;
        }
        if (formCarriesPreparedValue(this) === true) {
          recordBlockedAttempt(
            "form_request_submit",
            this.method || "FORM",
            normalizeUrl(this.action || window.location.href),
            true,
          );
        }
      };
    HTMLFormElement.prototype.requestSubmit = guardedRequestSubmit;
    state.formRequestSubmitWrapper = guardedRequestSubmit;
  }

  if (
    typeof navigator.sendBeacon === "function" &&
    navigator.sendBeacon !== state.sendBeaconWrapper
  ) {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    const guardedSendBeacon: typeof navigator.sendBeacon = (url, data) => {
      const beaconUrl = normalizeUrl(url);
      const beaconText =
        typeof data === "string"
          ? data
          : typeof URLSearchParams !== "undefined" &&
              data instanceof URLSearchParams
            ? data.toString()
            : null;
      const carriesPrepared =
        data != null && beaconText === null
          ? undefined
          : requestCarriesPreparedValue(beaconUrl, beaconText);
      const bodyIsFormData =
        (typeof FormData !== "undefined" && data instanceof FormData) ||
        (typeof File !== "undefined" && data instanceof File);
      if (isPageOwnedRead("POST", beaconUrl, beaconText, bodyIsFormData)) {
        return originalSendBeacon(url, data);
      }
      if (carriesPrepared === true) {
        recordBlockedAttempt("send_beacon", "POST", beaconUrl, true);
      }
      return false;
    };
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: guardedSendBeacon,
      writable: true,
    });
    state.sendBeaconWrapper = guardedSendBeacon;
  }

  if (
    typeof window.fetch === "function" &&
    window.fetch !== state.fetchWrapper
  ) {
    const originalFetch = window.fetch.bind(window);
    const guardedFetch: typeof window.fetch = (resource, init) => {
      const method = normalizeMethod(
        init?.method ??
          (typeof Request !== "undefined" && resource instanceof Request
            ? resource.method
            : "GET"),
      );
      const url = normalizeUrl(resource);
      const bodyText =
        typeof init?.body === "string"
          ? init.body
          : typeof URLSearchParams !== "undefined" &&
              init?.body instanceof URLSearchParams
            ? init.body.toString()
            : null;
      // A body the guard cannot read (FormData, Blob, a stream) may carry
      // anything, so its attempt is judged as unknown rather than clean.
      const bodyOpaque = init?.body != null && bodyText === null;
      const bodyIsFormData =
        (typeof FormData !== "undefined" && init?.body instanceof FormData) ||
        (typeof File !== "undefined" && init?.body instanceof File);
      if (
        !isPageOwnedRead(method, url, bodyText, bodyIsFormData) &&
        !canForwardAttachment(method, init?.body, url) &&
        !canAllowIntermediateRequest({
          bodyText,
          kind: "fetch",
          method,
          url,
        })
      ) {
        const carriesPrepared = bodyOpaque
          ? undefined
          : requestCarriesPreparedValue(url, bodyText);
        if (carriesPrepared === true) {
          recordBlockedAttempt("fetch", method, url, true);
        }
        return Promise.reject(
          new DOMException(
            "Prepare-only mode blocked a new network request while field mutations were unauthorized.",
            "AbortError",
          ),
        );
      }
      return originalFetch(resource, init);
    };
    window.fetch = guardedFetch;
    state.fetchWrapper = guardedFetch;
  }

  if (
    typeof XMLHttpRequest !== "undefined" &&
    (XMLHttpRequest.prototype.open !== state.xhrOpenWrapper ||
      XMLHttpRequest.prototype.send !== state.xhrSendWrapper)
  ) {
    const originalOpen = Reflect.get(XMLHttpRequest.prototype, "open");
    const originalSend = Reflect.get(XMLHttpRequest.prototype, "send");
    const guardedOpen: typeof XMLHttpRequest.prototype.open =
      function guardedOpen(
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        async = true,
        username?: string | null,
        password?: string | null,
      ): void {
        state.xhrMethods.set(this, {
          method: normalizeMethod(method),
          url: normalizeUrl(url),
        });
        Reflect.apply(originalOpen, this, [
          method,
          url,
          async,
          username ?? null,
          password ?? null,
        ]);
      };
    const guardedSend: typeof XMLHttpRequest.prototype.send =
      function guardedSend(
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ): void {
        const request = state.xhrMethods.get(this) ?? {
          method: "GET",
          url: null,
        };
        const bodyText =
          typeof body === "string"
            ? body
            : typeof URLSearchParams !== "undefined" &&
                body instanceof URLSearchParams
              ? body.toString()
              : null;
        const bodyOpaque = body != null && bodyText === null;
        const bodyIsFormData =
          (typeof FormData !== "undefined" && body instanceof FormData) ||
          (typeof File !== "undefined" && body instanceof File) ||
          (typeof Document !== "undefined" && body instanceof Document);
        if (
          !isPageOwnedRead(
            request.method,
            request.url,
            bodyText,
            bodyIsFormData,
          ) &&
          !canForwardAttachment(request.method, body, request.url) &&
          !canAllowIntermediateRequest({
            bodyText,
            kind: "xhr",
            method: request.method,
            url: request.url,
          })
        ) {
          const carriesPrepared = bodyOpaque
            ? undefined
            : requestCarriesPreparedValue(request.url, bodyText);
          if (carriesPrepared === true) {
            recordBlockedAttempt("xhr", request.method, request.url, true);
          }
          throw new DOMException(
            "Prepare-only mode blocked a new XMLHttpRequest while field mutations were unauthorized.",
            "AbortError",
          );
        }
        originalSend.call(this, body ?? null);
      };
    XMLHttpRequest.prototype.open = guardedOpen;
    XMLHttpRequest.prototype.send = guardedSend;
    state.xhrOpenWrapper = guardedOpen;
    state.xhrSendWrapper = guardedSend;
  }

  if (typeof WebSocket === "function" && WebSocket !== state.webSocketWrapper) {
    const OriginalWebSocket = WebSocket;
    const GuardedWebSocket = function GuardedWebSocket(
      url: string | URL,
      protocols?: string | string[],
    ): WebSocket {
      void protocols;
      recordBlockedAttempt(
        "websocket",
        "GET",
        normalizeUrl(url),
        requestCarriesPreparedValue(normalizeUrl(url), null),
      );
      throw new DOMException(
        "Prepare-only mode blocked a new WebSocket connection.",
        "AbortError",
      );
    } as unknown as typeof WebSocket;
    Object.defineProperty(GuardedWebSocket, "prototype", {
      value: OriginalWebSocket.prototype,
    });
    Object.assign(GuardedWebSocket, {
      CONNECTING: OriginalWebSocket.CONNECTING,
      OPEN: OriginalWebSocket.OPEN,
      CLOSING: OriginalWebSocket.CLOSING,
      CLOSED: OriginalWebSocket.CLOSED,
    });
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: GuardedWebSocket,
      writable: true,
    });
    state.webSocketWrapper = GuardedWebSocket;
  }

  if (
    typeof EventSource === "function" &&
    EventSource !== state.eventSourceWrapper
  ) {
    const OriginalEventSource = EventSource;
    const GuardedEventSource = function GuardedEventSource(
      url: string | URL,
      eventSourceInit?: EventSourceInit,
    ): EventSource {
      void eventSourceInit;
      recordBlockedAttempt(
        "eventsource",
        "GET",
        normalizeUrl(url),
        requestCarriesPreparedValue(normalizeUrl(url), null),
      );
      throw new DOMException(
        "Prepare-only mode blocked a new EventSource stream.",
        "AbortError",
      );
    } as unknown as typeof EventSource;
    Object.defineProperty(GuardedEventSource, "prototype", {
      value: OriginalEventSource.prototype,
    });
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: GuardedEventSource,
      writable: true,
    });
    state.eventSourceWrapper = GuardedEventSource;
  }

  const originalWebTransport = pageWindow["WebTransport"];
  if (
    typeof originalWebTransport === "function" &&
    originalWebTransport !== state.webTransportWrapper
  ) {
    const OriginalWebTransport =
      originalWebTransport as WebTransportPageConstructor;
    const GuardedWebTransport = function GuardedWebTransport(
      url: string | URL,
    ): unknown {
      recordBlockedAttempt(
        "webtransport",
        "GET",
        normalizeUrl(url),
        requestCarriesPreparedValue(normalizeUrl(url), null),
      );
      throw new DOMException(
        "Prepare-only mode blocked a new WebTransport session.",
        "AbortError",
      );
    } as unknown as WebTransportPageConstructor;
    Object.defineProperty(GuardedWebTransport, "prototype", {
      value: (OriginalWebTransport as unknown as { prototype: unknown })
        .prototype,
    });
    Object.defineProperty(window, "WebTransport", {
      configurable: true,
      value: GuardedWebTransport,
      writable: true,
    });
    state.webTransportWrapper = GuardedWebTransport;
  }

  if (
    typeof window.open === "function" &&
    window.open !== state.windowOpenWrapper
  ) {
    const guardedWindowOpen: typeof window.open = (
      url?,
      target?,
      features?,
    ) => {
      void target;
      void features;
      recordBlockedAttempt(
        "window_open",
        "GET",
        url === undefined || String(url).trim() === ""
          ? normalizeUrl(window.location.href)
          : normalizeUrl(url),
      );
      return null;
    };
    Object.defineProperty(window, "open", {
      configurable: true,
      value: guardedWindowOpen,
      writable: true,
    });
    state.windowOpenWrapper = guardedWindowOpen;
  }
}

/** Runs inside the application page to open or close one bounded field window. */
export function setPrepareOnlyIntermediateMutationWindowInPage(
  mutationWindow: IntermediateMutationWindowSnapshot | null,
): void {
  const pageWindow = window as unknown as Record<string, unknown>;
  const state = pageWindow["__nestorPrepareOnlyMutationGuardV1"] as
    | {
        intermediateMutationWindow: IntermediateMutationWindowSnapshot | null;
      }
    | undefined;
  if (!state) {
    throw new Error("Prepare-only mutation guard is not installed.");
  }
  state.intermediateMutationWindow = mutationWindow
    ? { ...mutationWindow }
    : null;
}

/** Runs inside an application page before Job Finder fills one grounded value. */
export function registerPrepareOnlyPreparedValueInPage(value: string): void {
  const pageWindow = window as unknown as Record<string, unknown>;
  const state = pageWindow["__nestorPrepareOnlyMutationGuardV1"] as
    | { preparedValues?: string[] }
    | undefined;
  const normalized = value.trim();
  if (!state || normalized.length < 3) return;
  state.preparedValues ??= [];
  if (!state.preparedValues.includes(normalized)) {
    state.preparedValues.push(normalized);
    state.preparedValues = state.preparedValues.slice(-64);
  }
}

/** Runs inside the application page and returns only serializable guard data. */
export function readPrepareOnlyMutationGuardInPage(): PrepareOnlyGuardSnapshot {
  const pageWindow = window as unknown as Record<string, unknown>;
  const state = pageWindow["__nestorPrepareOnlyMutationGuardV1"] as
    | PrepareOnlyGuardSnapshot
    | undefined;

  return {
    installed: state?.installed === true,
    blockedAttempts: [...(state?.blockedAttempts ?? [])],
  };
}

export interface ServiceWorkerRegisterGuardStatus {
  supported: boolean;
  prototypeGuardInstalled: boolean;
  instanceGuardInstalled: boolean;
  integrityVerified: boolean;
  guardStatePresent: boolean;
  blockedRegistrationAttempts: number;
}

/**
 * Runs inside every document of the managed context before site scripts. The
 * register replacement is installed non-configurable and non-writable on both
 * the ServiceWorkerContainer prototype and the container instance so site
 * scripts cannot delete, shadow, or restore it. Re-running the installer is
 * idempotent: an existing hardened descriptor is verified instead of replaced.
 */
export function installServiceWorkerRegisterGuardInPage(): void {
  const pageWindow = window as unknown as Record<string, unknown>;
  const stateKey = "__nestorServiceWorkerRegisterGuardV1";
  type InstallState = ServiceWorkerRegisterGuardStatus;

  const existingState = pageWindow[stateKey] as InstallState | undefined;
  const state: InstallState = existingState ?? {
    supported: false,
    prototypeGuardInstalled: false,
    instanceGuardInstalled: false,
    integrityVerified: false,
    guardStatePresent: true,
    blockedRegistrationAttempts: 0,
  };
  try {
    Object.defineProperty(pageWindow, stateKey, {
      value: state,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch {
    // The state anchor already exists from a prior installation pass.
  }

  if (!navigator.serviceWorker || !navigator.serviceWorker.register) {
    // Truthful feature absence: without a reachable registration API there is
    // nothing to guard and nothing to claim.
    state.supported = false;
    state.prototypeGuardInstalled = true;
    state.instanceGuardInstalled = true;
    state.integrityVerified = true;
    return;
  }

  const installOn = (target: object): boolean => {
    const existing = Object.getOwnPropertyDescriptor(target, "register");
    if (
      existing &&
      existing.configurable === false &&
      existing.writable === false &&
      typeof existing.value === "function"
    ) {
      return true;
    }
    const guard = function register(): Promise<never> {
      state.blockedRegistrationAttempts += 1;
      console.warn(
        "Service Worker registration blocked by Nestor managed browser.",
      );
      return Promise.reject(
        new DOMException(
          "Service Worker registration is disabled in the Nestor managed browser.",
          "NotAllowedError",
        ),
      );
    };
    try {
      Object.defineProperty(target, "register", {
        value: guard,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    } catch {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(target, "register");
    return Boolean(
      descriptor &&
      descriptor.configurable === false &&
      descriptor.writable === false &&
      descriptor.value === guard,
    );
  };

  state.supported = true;
  let prototype: object | null = null;
  try {
    prototype = Object.getPrototypeOf(navigator.serviceWorker) as object | null;
  } catch {
    prototype = null;
  }
  state.prototypeGuardInstalled = prototype ? installOn(prototype) : false;
  state.instanceGuardInstalled = installOn(navigator.serviceWorker);
  state.integrityVerified =
    state.prototypeGuardInstalled && state.instanceGuardInstalled;
}

/** Runs inside the application page and returns only serializable status. */
export function readServiceWorkerRegisterGuardInPage(): ServiceWorkerRegisterGuardStatus {
  const pageWindow = window as unknown as Record<string, unknown>;
  const state = pageWindow["__nestorServiceWorkerRegisterGuardV1"] as
    | ServiceWorkerRegisterGuardStatus
    | undefined;
  const container =
    typeof navigator !== "undefined" && navigator.serviceWorker
      ? navigator.serviceWorker
      : null;
  if (!container || !navigator.serviceWorker.register) {
    return {
      supported: false,
      prototypeGuardInstalled: true,
      instanceGuardInstalled: true,
      integrityVerified: true,
      guardStatePresent: state?.guardStatePresent === true,
      blockedRegistrationAttempts: state?.blockedRegistrationAttempts ?? 0,
    };
  }

  const describeOwn = (target: object): boolean => {
    const descriptor = Object.getOwnPropertyDescriptor(target, "register");
    return Boolean(
      descriptor &&
      descriptor.configurable === false &&
      descriptor.writable === false &&
      typeof descriptor.value === "function",
    );
  };
  let prototype: object | null = null;
  try {
    prototype = Object.getPrototypeOf(container) as object | null;
  } catch {
    prototype = null;
  }
  const prototypeGuardInstalled = prototype ? describeOwn(prototype) : false;
  const instanceGuardInstalled = describeOwn(container);

  return {
    supported: true,
    prototypeGuardInstalled,
    instanceGuardInstalled,
    integrityVerified:
      state !== undefined &&
      state.supported === true &&
      state.integrityVerified === true &&
      prototypeGuardInstalled &&
      instanceGuardInstalled,
    guardStatePresent: state !== undefined,
    blockedRegistrationAttempts:
      typeof state?.blockedRegistrationAttempts === "number"
        ? state.blockedRegistrationAttempts
        : 0,
  };
}

export interface PageServiceWorkerScanPayload {
  scanned: boolean;
  controllerUrl: string | null;
  registrations: Array<{
    scope: string;
    installingUrl: string | null;
    waitingUrl: string | null;
    activeUrl: string | null;
  }>;
}

/**
 * Runs inside the application page main frame; returns serializable state.
 * Self-contained on purpose: Playwright serializes only this function body,
 * so it must not reference other module functions.
 */
export function collectApplicationOriginServiceWorkerStateInPage(): Promise<PageServiceWorkerScanPayload> {
  const emptyPayload = (): PageServiceWorkerScanPayload => ({
    scanned: false,
    controllerUrl: null,
    registrations: [],
  });
  if (!window.navigator.serviceWorker) {
    return Promise.resolve(emptyPayload());
  }

  const serviceWorker = window.navigator.serviceWorker;
  return serviceWorker
    .getRegistrations()
    .then((registrations) => ({
      scanned: true,
      controllerUrl: serviceWorker.controller?.scriptURL ?? null,
      registrations: registrations.map((registration) => ({
        scope: registration.scope,
        installingUrl: registration.installing?.scriptURL ?? null,
        waitingUrl: registration.waiting?.scriptURL ?? null,
        activeUrl: registration.active?.scriptURL ?? null,
      })),
    }))
    .catch(() => emptyPayload());
}

async function ensureFramePrepareOnlyMutationGuard(
  frame: Frame,
  intermediateMutationsAuthorized: boolean,
  finalActionWindowOpen: boolean,
): Promise<PrepareOnlyGuardSnapshot> {
  await frame.evaluate(installMutationResponseBodyObserver);
  await frame.evaluate(installPrepareOnlyMutationGuardInPage, {
    intermediateMutationsAuthorized,
    finalActionSignal: FINAL_ACTION_SIGNAL.source,
  });
  // A page handed to the person had its guard opened for them; a run that
  // takes the page back shuts it again unless its own send window is open.
  await frame.evaluate((open) => {
    const state = (window as unknown as Record<string, unknown>)[
      "__nestorPrepareOnlyMutationGuardV1"
    ] as { finalActionAllowed?: boolean } | undefined;
    if (state) state.finalActionAllowed = open;
  }, finalActionWindowOpen);
  const snapshot = await frame.evaluate(readPrepareOnlyMutationGuardInPage);
  if (!snapshot.installed) {
    throw new Error(
      "The prepare-only browser guard could not be verified in the application frame.",
    );
  }
  return snapshot;
}

export async function ensurePrepareOnlyMutationGuard(
  page: Page,
  intermediateMutationsAuthorized: boolean,
  intermediateMutationAllowedOrigins: readonly string[] = [],
  attachmentUploadsAuthorized = false,
): Promise<PrepareOnlyGuardSnapshot> {
  let networkGuardState = prepareOnlyNetworkGuardStates.get(page);
  if (!networkGuardState) {
    networkGuardState = {
      blockedAttempts: [],
      preparedValues: new Set<string>(),
      runNavigations: new Set<string>(),
      allowedIntermediateRequests: new WeakSet<Request>(),
      verifiedIntermediateWriteCount: 0,
      pendingMutationResponses: new Set<Promise<void>>(),
      intermediateMutationsAuthorized,
      attachmentUploadsAuthorized,
      attachmentUploadWindow: null,
      intermediateMutationAllowedOrigins: [
        ...new Set(intermediateMutationAllowedOrigins),
      ],
      intermediateMutationWindow: null,
      authorizedFormActionWindow: null,
      finalActionAllowedUntilMs: 0,
      initScriptInstalled: false,
      serviceWorkerInitScriptInstalled: false,
      webSocketListenerInstalled: false,
    };
    prepareOnlyNetworkGuardStates.set(page, networkGuardState);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        networkGuardState!.authorizedFormActionWindow = null;
        networkGuardState!.attachmentUploadWindow = null;
      }
    });
    // A page handed to the person stays theirs across its own navigations
    // (a sign-in that leads to "create account", a form with several
    // steps): each new document starts with the in-page guard shut, so it
    // is opened again while the person's window lasts.
    page.on("domcontentloaded", () => {
      if (Date.now() >= networkGuardState!.finalActionAllowedUntilMs) return;
      void page
        .evaluate(() => {
          const state = (window as unknown as Record<string, unknown>)[
            "__nestorPrepareOnlyMutationGuardV1"
          ] as { finalActionAllowed?: boolean } | undefined;
          if (state) state.finalActionAllowed = true;
        })
        .catch(() => undefined);
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().trim().toUpperCase();
      const resourceType = request.resourceType();
      if (Date.now() < networkGuardState!.finalActionAllowedUntilMs) {
        await route.continue();
        return;
      }
      const authorizedFormAction =
        networkGuardState!.authorizedFormActionWindow;
      if (
        authorizedFormAction &&
        Date.now() <= authorizedFormAction.expiresAtMs &&
        authorizedFormAction.remainingRequests > 0 &&
        request.isNavigationRequest() &&
        resourceType === "document" &&
        method === authorizedFormAction.method &&
        request.url() === authorizedFormAction.url
      ) {
        authorizedFormAction.remainingRequests -= 1;
        await route.continue();
        authorizedFormAction.resolveCompletion();
        return;
      }

      const denyRequest = async (): Promise<void> => {
        networkGuardState!.blockedAttempts.push({
          kind: "network_request",
          method,
          url: request.url(),
          at: new Date().toISOString(),
        });
        networkGuardState!.blockedAttempts.splice(
          0,
          Math.max(0, networkGuardState!.blockedAttempts.length - 32),
        );
        await route.abort("blockedbyclient");
      };

      // Fill in for me: nothing that writes leaves without the person's own
      // click, except the selected resume below. Saves are allowed only
      // under Send for me's own authority.
      const strictFill = !networkGuardState!.intermediateMutationsAuthorized;
      if (
        !strictFill &&
        ((PREPARE_ONLY_SAFE_METHODS.has(method) &&
          !PREPARE_ONLY_DENIED_RESOURCE_TYPES.has(resourceType) &&
          !(
            PREPARE_ONLY_QUERY_GUARDED_RESOURCE_TYPES.has(resourceType) &&
            request.url().includes("?")
          )) ||
          isNetworkLayerPageOwnedRead(request, [
            ...networkGuardState!.preparedValues,
          ]))
      ) {
        await route.continue();
        return;
      }
      const navigation = request.isNavigationRequest()
        ? networkGuardState!.runNavigations.delete(exactUrl(request.url()))
          ? ("run" as const)
          : ("page" as const)
        : undefined;
      if (
        strictFill &&
        classifyStrictFillRead({
          method,
          resourceType,
          url: request.url(),
          bodyText: request.postData(),
          preparedValues: [...networkGuardState!.preparedValues],
          ...(navigation ? { navigation } : {}),
        }).allowed
      ) {
        let forwarded = false;
        try {
          forwarded =
            (await forwardCheckingHops(
              route,
              request,
              (url, hopMethod, body) =>
                classifyStrictFillRead({
                  method: hopMethod,
                  resourceType,
                  url,
                  bodyText: body,
                  preparedValues: [...networkGuardState!.preparedValues],
                  // A redirect of the run's own navigation is still the run's.
                  ...(navigation ? { navigation } : {}),
                }).allowed,
            )) !== null;
        } catch {
          await route.abort("failed").catch(() => undefined);
          return;
        }
        if (!forwarded) await denyRequest();
        return;
      }

      const resourceKind: IntermediateMutationResourceKind =
        resourceType === "fetch" || resourceType === "xhr"
          ? resourceType
          : "other";
      const uploadGrant = networkGuardState!.attachmentUploadWindow;
      if (
        resourceKind !== "other" &&
        networkGuardState!.attachmentUploadsAuthorized &&
        classifyUploadBind({
          window: uploadGrant,
          nowMs: Date.now(),
          method,
          url: request.url(),
          contentType: request.headers()["content-type"] ?? "",
          body: request.postData(),
          preparedValues: [...networkGuardState!.preparedValues],
        })
      ) {
        // The step that ties the file the storage just took to the form.
        uploadGrant!.bindsRemaining = 0;
        await shareUploadGrant(page, uploadGrant!);
        networkGuardState!.allowedIntermediateRequests.add(request);
        let bound = false;
        try {
          bound =
            (await forwardCheckingHops(
              route,
              request,
              (url) =>
                uploadHopStaysOnEndpoint(request.url(), url, [
                  ...networkGuardState!.preparedValues,
                ]) !== null,
            )) !== null;
        } catch {
          await route.abort("failed").catch(() => undefined);
          return;
        }
        if (!bound) await denyRequest();
        return;
      }
      const attachment = await classifyAttachmentUpload({
        window:
          networkGuardState!.attachmentUploadsAuthorized &&
          resourceKind !== "other"
            ? networkGuardState!.attachmentUploadWindow
            : null,
        nowMs: Date.now(),
        method,
        url: request.url(),
        contentType: request.headers()["content-type"] ?? "",
        body: request.postDataBuffer(),
        preparedValues: [...networkGuardState!.preparedValues],
      });
      if (attachment.allowed) {
        const grant = networkGuardState!.attachmentUploadWindow!;
        grant.remainingRequests -= 1;
        networkGuardState!.allowedIntermediateRequests.add(request);
        prepareOnlyRequestPermits.set(request, {
          actionKind: "upload",
          frameOrigin: requestFrameOrigin(request) ?? grant.sourceOrigin,
          method,
          endpoint: request.url(),
          authorizedCarrier: request,
          file: {
            field: grant.field ?? null,
            name: grant.fileName,
            size: grant.byteLength,
            sha256: grant.sha256,
          },
          uploadLeg: attachment.containsFile ? "file" : "presign",
        });
        try {
          prepareOnlyPermitListeners.get(page)?.(
            request,
            prepareOnlyRequestPermits.get(request)!,
          );
        } catch {
          // A listener's failure never changes what the fence lets out.
        }
        let answer: APIResponse | null = null;
        try {
          answer = await forwardCheckingHops(
            route,
            request,
            (url) =>
              uploadHopStaysOnEndpoint(request.url(), url, [
                ...networkGuardState!.preparedValues,
              ]) !== null,
            // The page may send the next leg the moment it hears this one.
            (response) => noteUploadLeg(page, grant, request, response),
          );
        } catch {
          await route.abort("failed").catch(() => undefined);
          return;
        }
        if (!answer) {
          // The upload reached its endpoint, which then pointed somewhere
          // else. That hop is never followed.
          prepareOnlyRequestPermits.delete(request);
          await denyRequest();
        }
        return;
      }
      if (strictFill) {
        const carries =
          requestUrlCarriesPreparedValue(request.url(), [
            ...networkGuardState!.preparedValues,
          ]) ||
          carriesPreparedValue(request.postData(), [
            ...networkGuardState!.preparedValues,
          ]);
        if (carries) await denyRequest();
        else await route.abort("blockedbyclient");
        return;
      }
      // A Send-authorized, same-origin draft save can include the form's file
      // input too. It still needs the separate intermediate-mutation grant;
      // refusing the attachment-only exemption must never grant that authority.
      let frameOrigin: string | undefined;
      try {
        const frame = request.frame();
        const pinned = intermediateFrameOrigins.get(page)?.get(frame);
        if (pinned === new URL(frame.url()).origin) frameOrigin = pinned;
      } catch {
        /* Worker and detached-frame writes have no field authority. */
      }
      // Inspect multipart fields, not PDF bytes. The text budget and final
      // signals still cover every string field, including late fields.
      let intermediateBody = request.postData();
      if (
        /\bmultipart\/form-data\b/iu.test(
          request.headers()["content-type"] ?? "",
        )
      ) {
        try {
          const body = request.postDataBuffer();
          if (!body || body.byteLength > 25 * 1024 * 1024)
            throw new Error("Oversize draft save");
          const form = await new Request("http://localhost/", {
            method: "POST",
            headers: { "content-type": request.headers()["content-type"]! },
            body: new Uint8Array(body),
          }).formData();
          intermediateBody = JSON.stringify(
            [...form].map(([key, value]) => [
              key,
              typeof value === "string"
                ? value
                : { name: value.name, size: value.size, type: value.type },
            ]),
          );
        } catch {
          await denyRequest();
          return;
        }
      }
      const decision = classifyIntermediateMutationRequest({
        authorized: networkGuardState!.intermediateMutationsAuthorized,
        bodyText: intermediateBody,
        method,
        nowMs: Date.now(),
        resourceKind,
        url: request.url(),
        window:
          networkGuardState!.intermediateMutationWindow && frameOrigin
            ? {
                ...networkGuardState!.intermediateMutationWindow,
                expectedOrigin: frameOrigin,
              }
            : null,
      });
      if (decision.allowed) {
        networkGuardState!.intermediateMutationWindow!.remainingRequests -= 1;
        networkGuardState!.allowedIntermediateRequests.add(request);
        await route.continue();
        return;
      }

      const requestCarriesPrepared =
        requestUrlCarriesPreparedValue(request.url(), [
          ...networkGuardState!.preparedValues,
        ]) ||
        carriesPreparedValue(request.postData(), [
          ...networkGuardState!.preparedValues,
        ]);
      if (!requestCarriesPrepared) {
        await route.abort("blockedbyclient");
        return;
      }
      await denyRequest();
    });
  }
  networkGuardState.intermediateMutationsAuthorized =
    intermediateMutationsAuthorized;
  networkGuardState.attachmentUploadsAuthorized = attachmentUploadsAuthorized;
  if (!attachmentUploadsAuthorized)
    networkGuardState.attachmentUploadWindow = null;
  networkGuardState.intermediateMutationAllowedOrigins = [
    ...new Set(intermediateMutationAllowedOrigins),
  ];

  if (!networkGuardState.initScriptInstalled) {
    await page.addInitScript(installMutationResponseBodyObserver);
    await page.addInitScript(installPrepareOnlyMutationGuardInPage, {
      intermediateMutationsAuthorized: false,
      finalActionSignal: FINAL_ACTION_SIGNAL.source,
    });
    networkGuardState.initScriptInstalled = true;
  }
  if (!networkGuardState.serviceWorkerInitScriptInstalled) {
    await page.addInitScript(installServiceWorkerRegisterGuardInPage);
    networkGuardState.serviceWorkerInitScriptInstalled = true;
  }
  // Fill permits uploads only. Upload receipts belong to the attachment
  // ledger and never count as step saves or authorize a saved-step disclosure.
  if (!networkGuardState.webSocketListenerInstalled) {
    page.on("websocket", (webSocket) => {
      networkGuardState.blockedAttempts.push({
        kind: "websocket",
        method: "GET",
        url: webSocket.url(),
        at: new Date().toISOString(),
      });
      networkGuardState.blockedAttempts.splice(
        0,
        Math.max(0, networkGuardState.blockedAttempts.length - 32),
      );
    });
    networkGuardState.webSocketListenerInstalled = true;
  }

  const blockedAttempts: PrepareOnlyBlockedAttempt[] = [
    ...networkGuardState.blockedAttempts,
  ];
  for (const frame of page.frames()) {
    let snapshot: PrepareOnlyGuardSnapshot;
    try {
      snapshot = await ensureFramePrepareOnlyMutationGuard(
        frame,
        intermediateMutationsAuthorized,
        Date.now() < networkGuardState.finalActionAllowedUntilMs,
      );
    } catch (error) {
      throw new Error(
        `The prepare-only browser guard could not be verified in application frame '${
          frame.url() || "(unknown)"
        }': ${describeUnknownError(error, "Unknown frame guard failure.")}`,
      );
    }
    blockedAttempts.push(...snapshot.blockedAttempts);
  }

  return {
    installed: true,
    blockedAttempts,
  };
}

async function setPrepareOnlyIntermediateMutationWindow(
  page: Page,
  mutationWindow: IntermediateMutationWindowSnapshot | null,
): Promise<void> {
  const networkGuardState = prepareOnlyNetworkGuardStates.get(page);
  if (!networkGuardState) {
    throw new Error("Prepare-only network guard is not installed.");
  }
  networkGuardState.intermediateMutationWindow = mutationWindow
    ? { ...mutationWindow }
    : null;
  const frameOrigins = new Map<Frame, string>();
  intermediateFrameOrigins.set(page, frameOrigins);
  try {
    for (const frame of page.frames()) {
      let origin: string | null = null;
      try {
        const url = new URL(frame.url());
        if (
          ["http:", "https:"].includes(url.protocol) &&
          (!networkGuardState.intermediateMutationAllowedOrigins.length ||
            networkGuardState.intermediateMutationAllowedOrigins.includes(
              url.origin,
            ))
        )
          origin = url.origin;
      } catch {
        /* A blank or detached frame has no origin authority. */
      }
      if (mutationWindow && origin) frameOrigins.set(frame, origin);
      await frame.evaluate(
        setPrepareOnlyIntermediateMutationWindowInPage,
        mutationWindow && origin
          ? { ...mutationWindow, expectedOrigin: origin }
          : null,
      );
    }
  } catch (error) {
    networkGuardState.intermediateMutationWindow = null;
    frameOrigins.clear();
    throw error;
  }
}

export async function openPrepareOnlyIntermediateMutationWindow(
  page: Page,
): Promise<void> {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(page.url()).origin;
  } catch {
    throw new Error(
      "Application origin is unavailable for a field-save window.",
    );
  }
  const networkGuardState = prepareOnlyNetworkGuardStates.get(page);
  // Without an envelope list, pins come from the live form frames, never '*'.
  if (
    !networkGuardState?.intermediateMutationsAuthorized ||
    (networkGuardState.intermediateMutationAllowedOrigins.length > 0 &&
      !networkGuardState.intermediateMutationAllowedOrigins.includes(
        expectedOrigin,
      ))
  ) {
    throw new Error(
      "The current application origin is outside the explicit intermediate-mutation authority.",
    );
  }
  // The page has usually navigated since the guard was installed (listing
  // page to apply page), and a document created by the init script starts
  // from whatever the script was first registered with. Re-assert the
  // authorization on every frame before the window opens, so the frame the
  // field lives in agrees that saves are allowed.
  for (const frame of page.frames()) {
    try {
      await ensureFramePrepareOnlyMutationGuard(
        frame,
        networkGuardState.intermediateMutationsAuthorized,
        Date.now() < networkGuardState.finalActionAllowedUntilMs,
      );
    } catch {
      // A frame mid-navigation gets the window on the next write.
    }
  }
  await setPrepareOnlyIntermediateMutationWindow(page, {
    expectedOrigin,
    expiresAtMs: Date.now() + INTERMEDIATE_MUTATION_WINDOW_DURATION_MS,
    remainingRequests: INTERMEDIATE_MUTATION_WINDOW_MAX_REQUESTS,
  });
}

export async function closePrepareOnlyIntermediateMutationWindow(
  page: Page,
): Promise<void> {
  await setPrepareOnlyIntermediateMutationWindow(page, null);
}

export async function openPrepareOnlyAttachmentUploadWindow(
  page: Page,
  file: ApplyUploadFile,
  field: string | null = null,
): Promise<void> {
  const guard = prepareOnlyNetworkGuardStates.get(page);
  const origin = new URL(page.url()).origin;
  if (!guard?.attachmentUploadsAuthorized) return; // Local selection stays local.
  if (
    guard.intermediateMutationAllowedOrigins.length &&
    !guard.intermediateMutationAllowedOrigins.includes(origin)
  )
    throw new Error(
      "This application is not authorized to upload an attachment here.",
    );
  const grant: AttachmentUploadWindow = {
    sourceOrigin: origin,
    fileName: file.name,
    mimeType: file.mimeType,
    byteLength: file.bytes.byteLength,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    expiresAtMs: Date.now() + 15_000,
    remainingRequests: 2,
    field,
  };
  guard.attachmentUploadWindow = grant;
  for (const frame of page.frames()) {
    await ensureFramePrepareOnlyMutationGuard(
      frame,
      guard.intermediateMutationsAuthorized,
      false,
    );
    await frame.evaluate((windowGrant) => {
      const state = (window as unknown as Record<string, unknown>)[
        "__nestorPrepareOnlyMutationGuardV1"
      ] as { attachmentUploadWindow: AttachmentUploadWindow | null };
      state.attachmentUploadWindow = { ...windowGrant };
    }, grant);
  }
}

/**
 * Lets an upload already on its way finish, then shuts the attachment
 * window everywhere, so the next press (a "Done", a "Next") cannot carry the
 * selected file out with it.
 */
/** How long a press waits for an upload to start carrying the file. */
const UPLOAD_START_WAIT_MS = 4_000;
/** How long a press waits for the bind after the storage answered. */
const UPLOAD_BIND_WAIT_MS = 3_000;
/** The most a press waits on an upload, all legs together. */
const UPLOAD_LEGS_WAIT_MS = 15_000;

export async function closePrepareOnlyAttachmentUploadWindow(
  page: Page,
): Promise<void> {
  const guard = prepareOnlyNetworkGuardStates.get(page);
  if (!guard?.attachmentUploadWindow) return;
  // An upload on its way keeps its window until its own legs answer: the
  // storage after the presign, then a bind that names the presign's handle.
  // A press must not cut one off: on real Ashby the presign alone can take
  // longer than the page takes to go quiet. A form that sends the file with
  // the final submission never starts a leg, so that wait is short.
  const startedAt = Date.now();
  for (;;) {
    const grant = guard.attachmentUploadWindow;
    if (!grant) return;
    const now = Date.now();
    const answeredAt = grant.fileAnsweredAtMs;
    const bindPending =
      answeredAt !== undefined &&
      (grant.bindsRemaining ?? 0) > 0 &&
      (grant.handles?.length ?? 0) > 0 &&
      now - answeredAt < UPLOAD_BIND_WAIT_MS;
    // A leg has left (a presign, or the file itself) once the fence let
    // one through; the window opens with two.
    const legStarted = grant.remainingRequests < 2;
    if (
      answeredAt !== undefined
        ? !bindPending
        : !legStarted && now - startedAt >= UPLOAD_START_WAIT_MS
    )
      break;
    if (now - startedAt >= UPLOAD_LEGS_WAIT_MS) break;
    await page.waitForTimeout(200).catch(() => undefined);
  }
  await page
    .waitForLoadState("networkidle", { timeout: 1_500 })
    .catch(() => undefined);
  guard.attachmentUploadWindow = null;
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        const state = (window as unknown as Record<string, unknown>)[
          "__nestorPrepareOnlyMutationGuardV1"
        ] as { attachmentUploadWindow: unknown } | undefined;
        if (state) state.attachmentUploadWindow = null;
      })
      .catch(() => undefined);
  }
}

export async function registerPrepareOnlyPreparedValue(
  page: Page,
  value: string,
): Promise<void> {
  // Short values ("PT", a select's option value) are kept too; they are
  // matched only as a whole value, never as a substring.
  const normalized = value.trim();
  if (!normalized) return;
  const networkGuardState = prepareOnlyNetworkGuardStates.get(page);
  if (!networkGuardState) {
    throw new Error("Prepare-only network guard is not installed.");
  }
  networkGuardState.preparedValues.add(normalized);
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(registerPrepareOnlyPreparedValueInPage, normalized);
    } catch {
      // A frame may disappear between enumeration and evaluation. The
      // network guard still holds the exact value and remains authoritative.
    }
  }
}

export async function getLatestBlockedPrepareOnlyAttempt(
  page: Page,
): Promise<PrepareOnlyBlockedAttempt | null> {
  return (await getBlockedPrepareOnlyAttempts(page)).at(-1) ?? null;
}

/**
 * Everything the guard has blocked on this page, oldest first.
 *
 * The network ledger and each frame's in-page ledger are kept separately, so
 * they are merged by time here: "the latest" has to mean the latest.
 */
export async function getBlockedPrepareOnlyAttempts(
  page: Page,
): Promise<PrepareOnlyBlockedAttempt[]> {
  const ledger: PrepareOnlyBlockedAttempt[] = [
    ...(prepareOnlyNetworkGuardStates.get(page)?.blockedAttempts ?? []),
  ];
  for (const frame of page.frames()) {
    try {
      const snapshot = await frame.evaluate(readPrepareOnlyMutationGuardInPage);
      ledger.push(...snapshot.blockedAttempts);
    } catch {
      // A frame that has navigated away has no ledger to read any more.
    }
  }
  return ledger.sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * Records an out-of-band prepare-only interruption (popup, download, or
 * context-level network denial) into the page-scoped guard ledger so the
 * existing verification gates escalate it into a manual-review stop.
 */
export function recordPrepareOnlyRunInterruption(
  page: Page,
  attempt: PrepareOnlyBlockedAttempt,
): void {
  let ledgerState = prepareOnlyNetworkGuardStates.get(page);
  if (!ledgerState) {
    const createdState = {
      blockedAttempts: [],
      preparedValues: new Set<string>(),
      runNavigations: new Set<string>(),
      allowedIntermediateRequests: new WeakSet<Request>(),
      verifiedIntermediateWriteCount: 0,
      pendingMutationResponses: new Set<Promise<void>>(),
      intermediateMutationsAuthorized: false,
      attachmentUploadsAuthorized: false,
      attachmentUploadWindow: null,
      intermediateMutationAllowedOrigins: [],
      intermediateMutationWindow: null,
      authorizedFormActionWindow: null,
      finalActionAllowedUntilMs: 0,
      initScriptInstalled: false,
      serviceWorkerInitScriptInstalled: false,
      webSocketListenerInstalled: false,
    };
    prepareOnlyNetworkGuardStates.set(page, createdState);
    ledgerState = createdState;
  }
  ledgerState.blockedAttempts.push(attempt);
  ledgerState.blockedAttempts.splice(
    0,
    Math.max(0, ledgerState.blockedAttempts.length - 32),
  );
}

export type ServiceWorkerSafetyStopReason =
  | "active_service_worker_controlling_application_origin"
  | "service_worker_origin_unresolved"
  | "application_origin_registration_detected"
  | "register_guard_compromised"
  | "service_worker_safety_channel_unavailable";

export type ServiceWorkerSafetyDetectionChannel =
  | "context_serviceworker_event"
  | "context_service_workers_enumeration"
  | "page_service_worker_scan"
  | "register_guard_integrity";

export interface ServiceWorkerSafetyFinding {
  reason: ServiceWorkerSafetyStopReason;
  channel: ServiceWorkerSafetyDetectionChannel;
  phase: string;
  workerUrls: string[];
  detail: string;
}

function parseHttpOriginOrNull(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function describeServiceWorkerFinding(input: {
  reason: ServiceWorkerSafetyStopReason;
  channel: ServiceWorkerSafetyDetectionChannel;
  phase: string;
  workerUrls: readonly string[];
}): string {
  const workerDescription =
    input.workerUrls.length > 0
      ? input.workerUrls.join(", ")
      : "an unnamed service worker";
  switch (input.reason) {
    case "active_service_worker_controlling_application_origin":
      return `An active service worker (${workerDescription}) can control the application origin during the '${input.phase}' phase (detected through ${input.channel}).`;
    case "service_worker_origin_unresolved":
      return `A service worker (${workerDescription}) with an origin that cannot be safely determined was detected during the '${input.phase}' phase (detected through ${input.channel}).`;
    case "application_origin_registration_detected":
      return `A registered service worker (${workerDescription}) exists for the application origin during the '${input.phase}' phase (detected through ${input.channel}), so the run stopped before it could activate and claim the application page.`;
    case "register_guard_compromised":
      return `The in-page service-worker registration guard failed verification during the '${input.phase}' phase (detected through ${input.channel}).`;
    case "service_worker_safety_channel_unavailable":
      return `Continuous service-worker safety verification was unavailable during the '${input.phase}' phase (detected through ${input.channel}).`;
  }
}

function classifyServiceWorkerUrlsAgainstOrigin(input: {
  workerUrls: readonly string[];
  targetOrigin: string | null;
}): { controllingUrls: string[]; unresolvedUrls: string[] } {
  const controllingUrls: string[] = [];
  const unresolvedUrls: string[] = [];
  for (const workerUrl of input.workerUrls) {
    const workerOrigin = parseHttpOriginOrNull(workerUrl);
    if (!workerOrigin || !input.targetOrigin) {
      unresolvedUrls.push(workerUrl);
    } else if (workerOrigin === input.targetOrigin) {
      controllingUrls.push(workerUrl);
    }
  }
  return { controllingUrls, unresolvedUrls };
}

function findingFromServiceWorkerUrls(input: {
  reason: ServiceWorkerSafetyStopReason;
  channel: ServiceWorkerSafetyDetectionChannel;
  phase: string;
  workerUrls: readonly string[];
}): ServiceWorkerSafetyFinding | null {
  if (input.workerUrls.length === 0) {
    return null;
  }
  const workerUrls = [...input.workerUrls];
  return {
    reason: input.reason,
    channel: input.channel,
    phase: input.phase,
    workerUrls,
    detail: describeServiceWorkerFinding({
      reason: input.reason,
      channel: input.channel,
      phase: input.phase,
      workerUrls,
    }),
  };
}

/**
 * Verifies that no active or registered same-origin (or unresolvable) service
 * worker can influence the application origin right now. Cross-origin workers
 * are intentionally ignored so unrelated origins keep working. Returns a
 * safety finding instead of throwing so every checkpoint can return a
 * truthful manual-review stop with zero further field or click actions.
 */
export async function findApplicationOriginServiceWorkerIssue(input: {
  context: BrowserContext;
  targetUrl: string;
  page?: Page | null;
  phase: string;
  pendingWorkerEventUrls?: readonly string[];
}): Promise<ServiceWorkerSafetyFinding | null> {
  const targetOrigin = parseHttpOriginOrNull(input.targetUrl);

  const relevantEventUrls = (input.pendingWorkerEventUrls ?? []).filter(
    (workerUrl) => {
      const { controllingUrls, unresolvedUrls } =
        classifyServiceWorkerUrlsAgainstOrigin({
          workerUrls: [workerUrl],
          targetOrigin,
        });
      return controllingUrls.length > 0 || unresolvedUrls.length > 0;
    },
  );
  const eventFinding = findingFromServiceWorkerUrls({
    reason: "active_service_worker_controlling_application_origin",
    channel: "context_serviceworker_event",
    phase: input.phase,
    workerUrls: relevantEventUrls,
  });
  if (eventFinding) {
    return eventFinding;
  }

  if (typeof input.context.serviceWorkers !== "function") {
    return {
      reason: "service_worker_safety_channel_unavailable",
      channel: "context_service_workers_enumeration",
      phase: input.phase,
      workerUrls: [],
      detail: `Active service workers could not be inspected on the managed browser context during the '${input.phase}' phase.`,
    };
  }
  let activeWorkers;
  try {
    activeWorkers = input.context.serviceWorkers();
  } catch (error) {
    return {
      reason: "service_worker_safety_channel_unavailable",
      channel: "context_service_workers_enumeration",
      phase: input.phase,
      workerUrls: [],
      detail: `Active service workers could not be inspected on the managed browser context during the '${input.phase}' phase: ${
        error instanceof Error ? error.message : "unknown inspection error"
      }.`,
    };
  }
  const { controllingUrls, unresolvedUrls } =
    classifyServiceWorkerUrlsAgainstOrigin({
      workerUrls: activeWorkers.map((worker) => worker.url()),
      targetOrigin,
    });
  const enumerationFinding =
    findingFromServiceWorkerUrls({
      reason: "active_service_worker_controlling_application_origin",
      channel: "context_service_workers_enumeration",
      phase: input.phase,
      workerUrls: controllingUrls,
    }) ??
    findingFromServiceWorkerUrls({
      reason: "service_worker_origin_unresolved",
      channel: "context_service_workers_enumeration",
      phase: input.phase,
      workerUrls: unresolvedUrls,
    });
  if (enumerationFinding) {
    return enumerationFinding;
  }

  if (!input.page || typeof input.page.evaluate !== "function") {
    return null;
  }
  let scanPayload: PageServiceWorkerScanPayload;
  try {
    scanPayload = await input.page.evaluate(
      collectApplicationOriginServiceWorkerStateInPage,
    );
  } catch (error) {
    return {
      reason: "service_worker_safety_channel_unavailable",
      channel: "page_service_worker_scan",
      phase: input.phase,
      workerUrls: [],
      detail: `The application page service-worker scan could not be completed during the '${input.phase}' phase: ${
        error instanceof Error ? error.message : "unknown scan error"
      }.`,
    };
  }
  let registerGuard: ServiceWorkerRegisterGuardStatus;
  try {
    registerGuard = await input.page.evaluate(
      readServiceWorkerRegisterGuardInPage,
    );
  } catch {
    registerGuard = {
      supported: true,
      prototypeGuardInstalled: false,
      instanceGuardInstalled: false,
      integrityVerified: false,
      guardStatePresent: false,
      blockedRegistrationAttempts: 0,
    };
  }

  const scannedUrls = [
    ...(scanPayload.controllerUrl ? [scanPayload.controllerUrl] : []),
    ...scanPayload.registrations.flatMap((registration) =>
      [
        registration.scope,
        registration.installingUrl,
        registration.waitingUrl,
        registration.activeUrl,
      ].filter((url): url is string => Boolean(url)),
    ),
  ];
  const registeredSameOriginUrls = scannedUrls.filter((url) => {
    const urlOrigin = parseHttpOriginOrNull(url);
    return Boolean(targetOrigin && urlOrigin && urlOrigin === targetOrigin);
  });
  const scannedUnresolvedUrls = scannedUrls.filter(
    (url) => !parseHttpOriginOrNull(url),
  );
  const scanFinding =
    findingFromServiceWorkerUrls({
      reason: "active_service_worker_controlling_application_origin",
      channel: "page_service_worker_scan",
      phase: input.phase,
      workerUrls: registeredSameOriginUrls,
    }) ??
    findingFromServiceWorkerUrls({
      reason: "service_worker_origin_unresolved",
      channel: "page_service_worker_scan",
      phase: input.phase,
      workerUrls: scannedUnresolvedUrls,
    });
  if (scanFinding) {
    return scanFinding;
  }

  if (
    registerGuard.supported &&
    registerGuard.guardStatePresent &&
    !registerGuard.integrityVerified
  ) {
    return {
      reason: "register_guard_compromised",
      channel: "register_guard_integrity",
      phase: input.phase,
      workerUrls: [],
      detail: describeServiceWorkerFinding({
        reason: "register_guard_compromised",
        channel: "register_guard_integrity",
        phase: input.phase,
        workerUrls: [],
      }),
    };
  }

  return null;
}

export interface ApplicationRunServiceWorkerSentinel {
  check(phase: string): Promise<ServiceWorkerSafetyFinding | null>;
  attachPage(page: Page): void;
  pendingWorkerEventCount(): number;
  detach(): void;
}

/**
 * Run-scoped service-worker sentinel plus popup/download/network containment
 * for one application-preparation run. A newly created same-origin (or
 * unresolvable) worker aborts the run before further actions; popups opened by
 * the application page are closed immediately; downloads are canceled; and
 * context-level non-safe requests are denied into the same ledger. All
 * listeners are removed by detach().
 */
export function createApplicationRunServiceWorkerSentinel(input: {
  context: BrowserContext;
  targetUrl: string;
  now?: () => Date;
}): ApplicationRunServiceWorkerSentinel {
  const now = input.now ?? (() => new Date());
  const pendingWorkerEvents: string[] = [];
  const pendingInterruptions: PrepareOnlyBlockedAttempt[] = [];
  const detachListeners: Array<() => void> = [];
  const ownedPopups = new Set<Page>();
  let ledgerPage: Page | null = null;
  let eventChannelBroken = false;
  let contextRouteInstalled = false;
  let detached = false;

  const recordInterruption = (attempt: PrepareOnlyBlockedAttempt): void => {
    if (detached) {
      return;
    }
    // Once an application page is attached, interruptions land in its guard
    // ledger immediately so any verification gate escalates them; before that
    // they queue until the first checkpoint or attachment.
    if (ledgerPage) {
      recordPrepareOnlyRunInterruption(ledgerPage, attempt);
      return;
    }
    pendingInterruptions.push(attempt);
  };

  const currentApplicationUrl = (): string => {
    const pageUrl = ledgerPage?.url();
    return pageUrl && isHttpUrlLike(pageUrl) ? pageUrl : input.targetUrl;
  };

  const isOwnedPage = async (page: Page): Promise<boolean> => {
    if (!ledgerPage || detached) return false;
    let current: Page | null = page;
    const seen = new Set<Page>();
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (current === ledgerPage || ownedPopups.has(current)) return true;
      if (seen.has(current) || typeof current.opener !== "function") break;
      seen.add(current);
      current = await current.opener().catch(() => null);
    }
    return false;
  };

  const passToOtherGuards = async (route: Route): Promise<void> => {
    if (typeof route.fallback === "function") await route.fallback();
    else await route.continue();
  };

  if (typeof input.context.on === "function") {
    try {
      const onServiceWorker = (worker: { url(): string }): void => {
        const workerUrl = worker.url();
        const workerOrigin = parseHttpOriginOrNull(workerUrl);
        const applicationOrigin = parseHttpOriginOrNull(
          currentApplicationUrl(),
        );
        if (!workerOrigin || workerOrigin === applicationOrigin)
          pendingWorkerEvents.push(workerUrl);
      };
      input.context.on("serviceworker" as never, onServiceWorker as never);
      detachListeners.push(() => {
        if (typeof input.context.off === "function") {
          input.context.off("serviceworker" as never, onServiceWorker as never);
        }
      });

      const onPage = (page: Page): void => {
        void (async () => {
          // A shared context also contains other applications, searches, and
          // the person's tabs. Only this run's opener chain is contained.
          if (!(await isOwnedPage(page))) return;
          ownedPopups.add(page);
          let popupUrl: string | null = null;
          try {
            const candidateUrl = page.url();
            if (isHttpUrlLike(candidateUrl)) {
              popupUrl = candidateUrl;
            } else {
              const openerUrl = ledgerPage?.url();
              if (openerUrl && isHttpUrlLike(openerUrl)) {
                popupUrl = openerUrl;
              }
            }
          } catch {
            popupUrl = null;
          }
          recordInterruption({
            kind: "popup_open",
            method: "GET",
            url: popupUrl,
            at: now().toISOString(),
          });
          await page.close().catch(() => undefined);
        })();
      };
      input.context.on("page" as never, onPage as never);
      detachListeners.push(() => {
        if (typeof input.context.off === "function") {
          input.context.off("page" as never, onPage as never);
        }
      });
    } catch {
      eventChannelBroken = true;
    }
  }

  const contextRouteHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    let requestPage: Page | null = null;
    try {
      requestPage = request.frame().page();
    } catch {
      // Service-worker requests have no frame. Their origin is handled by the
      // worker sentinel; a shared-context route cannot assign them to a tab.
    }
    if (!requestPage || !(await isOwnedPage(requestPage))) {
      await passToOtherGuards(route);
      return;
    }
    const method = request.method().trim().toUpperCase();
    const resourceType = request.resourceType();
    const allowed =
      (PREPARE_ONLY_SAFE_METHODS.has(method) &&
        !PREPARE_ONLY_DENIED_RESOURCE_TYPES.has(resourceType)) ||
      isNetworkLayerPageOwnedRead(request, []);
    if (!allowed) {
      recordInterruption({
        kind: "network_request",
        method,
        url: request.url(),
        at: now().toISOString(),
      });
      await route.abort("blockedbyclient");
      return;
    }
    await passToOtherGuards(route);
  };
  if (typeof input.context.route === "function") {
    try {
      void input.context
        .route("**/*", contextRouteHandler)
        .then(async () => {
          if (detached) {
            await input.context
              .unroute("**/*", contextRouteHandler)
              .catch(() => undefined);
            return;
          }
          contextRouteInstalled = true;
        })
        .catch(() => undefined);
    } catch {
      // Context routing is best-effort hardening; page routing remains active.
    }
  }

  const sentinel: ApplicationRunServiceWorkerSentinel = {
    async check(phase) {
      if (detached) {
        return null;
      }

      while (pendingInterruptions.length > 0) {
        const attempt = pendingInterruptions.shift();
        if (attempt && ledgerPage) {
          recordPrepareOnlyRunInterruption(ledgerPage, attempt);
        } else if (attempt) {
          pendingInterruptions.unshift(attempt);
          break;
        }
      }

      const drainedEvents = pendingWorkerEvents.splice(
        0,
        pendingWorkerEvents.length,
      );

      if (eventChannelBroken) {
        return {
          reason: "service_worker_safety_channel_unavailable",
          channel: "context_serviceworker_event",
          phase,
          workerUrls: [],
          detail: `The managed browser context failed to subscribe to service-worker creation events, so continuous service-worker verification is unavailable.`,
        };
      }

      return findApplicationOriginServiceWorkerIssue({
        context: input.context,
        targetUrl: currentApplicationUrl(),
        page: ledgerPage,
        phase,
        pendingWorkerEventUrls: drainedEvents,
      });
    },
    attachPage(page) {
      if (detached) {
        return;
      }
      ledgerPage = page;
      if (typeof page.on === "function" && typeof page.off === "function") {
        const onDownload = (download: {
          url(): string;
          cancel(): Promise<void>;
        }): void => {
          recordInterruption({
            kind: "download",
            method: "GET",
            url: download.url(),
            at: now().toISOString(),
          });
          void download.cancel().catch(() => undefined);
        };
        try {
          page.on("download" as never, onDownload as never);
          detachListeners.push(() => {
            page.off("download" as never, onDownload as never);
          });
        } catch {
          // Download containment stays best-effort on exotic hosts.
        }
      }
    },
    pendingWorkerEventCount() {
      return pendingWorkerEvents.length;
    },
    detach() {
      if (detached) {
        return;
      }
      detached = true;
      while (detachListeners.length > 0) {
        detachListeners.pop()?.();
      }
      if (
        contextRouteInstalled &&
        typeof input.context.unroute === "function"
      ) {
        void input.context
          .unroute("**/*", contextRouteHandler)
          .catch(() => undefined);
        contextRouteInstalled = false;
      }
      pendingWorkerEvents.length = 0;
      pendingInterruptions.length = 0;
      ledgerPage = null;
    },
  };

  return sentinel;
}

export function normalizeFileSystemPath(value: string): string {
  const normalized = resolve(value.trim()).replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function describeUnknownError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : fallback;
}

export async function loadVerifiedResumeBytes(
  resumeArtifact: ExecuteApplicationFlowInput["resumeArtifact"],
): Promise<Uint8Array> {
  const expectedSha256 = resumeArtifact.sha256?.trim().toLowerCase() ?? "";
  if (!expectedSha256) {
    throw new Error(
      "The approved resume has no SHA-256 integrity record. Re-import or re-export it before application preparation.",
    );
  }

  const bytes = await readFile(resumeArtifact.filePath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      "The approved resume changed after verification. Re-import or re-export it before application preparation.",
    );
  }
  return bytes;
}

/** A short, stable, readable id segment made from a label. */
function toStableIdSegment(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replace(/[\u0300-\u036f]/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, " ")
      .trim()
      .replace(/\s+/gu, "_")
      .slice(0, 48) || "field"
  );
}

function createPreparationConsentDecisions(input: {
  jobId: string;
  now: string;
  questions: readonly ApplicationAttemptQuestion[];
  usesOriginalResume: boolean;
  manualDecisionLabel?: string;
  externalWrites?: readonly ApplicationAttemptExternalWriteEvidence[];
}) {
  const externalWrites = input.externalWrites ?? [];
  // The resume card records consent to USE a document, which the attempt's
  // own answered resume question settles.
  const resumeAttached = input.questions.some(
    (question) => question.kind === "resume" && question.status === "answered",
  );
  // The autofill card claims values reached the employer's form, and only the
  // write receipt can support that claim.
  const profileAutofilled = externalWrites.some(
    (write) =>
      write.category === "profile_field" ||
      write.category === "application_answer",
  );

  return [
    ...(resumeAttached
      ? [
          {
            id: `consent_${input.jobId}_resume_use`,
            kind: "resume_use" as const,
            label: input.usesOriginalResume
              ? "Use the selected original resume for this application"
              : "Use the approved tailored resume for this application",
            status: "approved" as const,
            decidedAt: input.now,
            detail: input.usesOriginalResume
              ? "The exact original resume selected by the user was attached during prepare-only automation."
              : "The approved tailored resume was attached during prepare-only automation.",
          },
        ]
      : []),
    ...(profileAutofilled
      ? [
          {
            id: `consent_${input.jobId}_autofill_profile`,
            kind: "autofill_profile" as const,
            label: "Use exact saved profile fields for this application",
            status: "approved" as const,
            decidedAt: input.now,
            detail:
              "Only exact identity, contact, location, and portfolio field matches were filled.",
          },
        ]
      : []),
    ...(input.manualDecisionLabel
      ? [
          {
            id: `consent_${input.jobId}_manual_follow_up`,
            kind: "manual_follow_up" as const,
            label: input.manualDecisionLabel,
            status: "requested" as const,
            decidedAt: null,
            detail:
              "The runtime paused without making this decision on the user's behalf.",
          },
        ]
      : []),
  ];
}

export function buildPreparationResult(input: {
  // Only the application facts are needed; the callback that fills the form is
  // not one of them.
  executionInput: Omit<ExecuteApplicationFlowInput, "prepareApplicationForm">;
  state?: "paused" | "failed" | "ready";
  summary: string;
  detail: string;
  questions: readonly ApplicationAttemptQuestion[];
  blocker: ApplicationAttemptBlocker | null;
  checkpoints: readonly ApplicationAttemptCheckpoint[];
  checkpointLabel: string;
  checkpointDetail: string;
  checkpointUrls: readonly string[];
  lastUrl: string | null;
  now: string;
  nextActionLabel: string;
  manualDecisionLabel?: string;
  externalWrites?: readonly ApplicationAttemptExternalWriteEvidence[];
  modelUse?: readonly ApplyExecutionModelUse[];
}): ApplyExecutionResult {
  const finalCheckpoint: ApplicationAttemptCheckpoint = {
    id: `checkpoint_${input.executionInput.job.id}_${toStableIdSegment(input.checkpointLabel)}_${input.checkpoints.length + 1}`,
    at: input.now,
    label: input.checkpointLabel,
    detail: input.checkpointDetail,
    state: input.state ?? "paused",
    visualEvidence: [],
  };
  const questions = [...input.questions];

  return ApplyExecutionResultSchema.parse({
    state: input.state ?? "paused",
    summary: input.summary,
    detail: input.detail,
    submittedAt: null,
    outcome: null,
    questions,
    blocker: input.blocker,
    consentDecisions: createPreparationConsentDecisions({
      jobId: input.executionInput.job.id,
      now: input.now,
      questions,
      usesOriginalResume:
        input.executionInput.resumeArtifact.source === "original_upload",
      ...(input.externalWrites ? { externalWrites: input.externalWrites } : {}),
      ...(input.manualDecisionLabel
        ? { manualDecisionLabel: input.manualDecisionLabel }
        : {}),
    }),
    replay: {
      sourceInstructionArtifactId: null,
      sourceDebugEvidenceRefIds: [],
      lastUrl: input.lastUrl,
      checkpointUrls: [...new Set(input.checkpointUrls)],
    },
    visualEvidence: [],
    visualObservationSets: [],
    visualCheckpoints: [],
    nextActionLabel: input.nextActionLabel,
    checkpoints: [...input.checkpoints, finalCheckpoint],
    modelUse: input.modelUse ? [...input.modelUse] : [],
    externalWrites: input.externalWrites
      ? [...input.externalWrites]
      : undefined,
  });
}
