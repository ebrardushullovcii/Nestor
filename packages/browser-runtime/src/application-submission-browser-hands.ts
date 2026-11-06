import { withBrowserReadLiveness } from "./browser-read-liveness";
import { createHash } from "node:crypto";
import {
  SubmissionFinalControlIdentitySchema,
  SubmissionObservationIdentitySchema,
  type SubmissionFinalControlIdentity,
  type SubmissionObservationIdentity,
  type ApplyFinalActionTarget,
} from "@nestor/contracts";
import type { Page, Request, Response } from "playwright";
import { readVisibleText } from "./visible-page-text";
import {
  actionLocator,
  readRawApplyPage,
  createPlaywrightApplyPageMechanics,
} from "./apply-page-mechanics";
import { watchPageSelfLimits } from "./self-limit-page";

export const APPLICATION_FINAL_CONTROL_SELECTOR =
  "button, input[type='submit'], input[type='image']";

export const applicationFinalControlKindValues = [
  "button",
  "input_submit",
  "input_image",
] as const;
export type ApplicationFinalControlKind =
  (typeof applicationFinalControlKindValues)[number];

export interface ApplicationSafePageUrl {
  readonly origin: string | null;
  readonly safePath: string | null;
}

export interface ApplicationFinalControl {
  readonly identity: SubmissionFinalControlIdentity;
  /** DOM ordinal in the broad selector, never a retained DOM handle. */
  readonly ordinal: number;
  readonly kind: ApplicationFinalControlKind;
  readonly label: string;
  readonly formIndex: number;
  readonly action: ApplicationSafePageUrl;
}

export interface ApplicationFormObservation {
  readonly identity: SubmissionObservationIdentity;
  readonly page: ApplicationSafePageUrl;
  /** False when the bounded browser enumeration could not prove completeness. */
  readonly complete: boolean;
  readonly controls: readonly ApplicationFinalControl[];
}

export type ApplicationFinalActionBlockReason =
  | "aborted"
  | "action_error"
  | "account_window_open"
  | "ambiguous_final_controls"
  | "no_final_control"
  | "origin_drift"
  | "stale_control"
  | "stale_observation"
  | "vetoed"
  /**
   * The click went out, but the site refused the connection (or could not be
   * found) and no response of any kind came back: nothing reached it.
   */
  | "site_unreachable"
  | "form_validation_failed";

export interface ApplicationExternalActionFacts {
  /** True once the one-shot action boundary was attempted, even if Playwright
   * failed before dispatching a click. This is separate from actionIssued so
   * uncertainty can suppress retries without claiming an external action. */
  readonly actionAttempted: boolean;
  readonly actionIssued: boolean;
  readonly actionCompleted: boolean;
  readonly pageBefore: ApplicationSafePageUrl;
  readonly pageAfter: ApplicationSafePageUrl;
  readonly urlChanged: boolean;
  /** Network observation is descriptive only and never proves submission. */
  readonly requestsObservedDuringAction: number;
  /**
   * Each request the page made from the click on, as it ended: the evidence
   * an uncertain outcome comes with. Never proof of submission either.
   */
  readonly requestsAfterClick: readonly ApplicationActionRequest[];
}

/** One request after the final click. No query string: it can carry answers. */
export interface ApplicationActionRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  /** The site's HTTP status; null when no answer came. */
  readonly status: number | null;
  /** The browser's reason when it ended without an answer. */
  readonly failure: string | null;
  /** True for the request the final control sends the application with. */
  readonly finalSubmit: boolean;
}

export type ApplicationFinalActionResult =
  | {
      readonly outcome: "not_submitted";
      readonly reason: ApplicationFinalActionBlockReason;
      readonly validationErrors?: readonly string[];
      readonly observation: ApplicationFormObservation | null;
      readonly control: ApplicationFinalControl | null;
      readonly facts: ApplicationExternalActionFacts;
    }
  | {
      /**
       * A click was issued, but browser-local facts cannot establish the
       * employer-site outcome. The caller must persist this as uncertain and
       * obtain independent external evidence before any terminal resolution.
       */
      readonly outcome: "outcome_uncertain";
      readonly reason:
        | "action_issued"
        | "action_error"
        | "confirmation_timeout";
      readonly observation: ApplicationFormObservation;
      readonly control: ApplicationFinalControl;
      readonly facts: ApplicationExternalActionFacts;
      /** The last thing the page said through its own alert after the click. */
      readonly siteMessage?: string;
    }
  | {
      /** The employer page visibly confirmed receipt after the one action. */
      readonly outcome: "submitted";
      readonly reason: "employer_confirmation";
      readonly observation: ApplicationFormObservation;
      readonly control: ApplicationFinalControl;
      readonly confirmation: {
        readonly observedAt: string;
        readonly destination: ApplicationSafePageUrl;
        readonly summary: string;
      };
      readonly facts: ApplicationExternalActionFacts;
    };

export interface ObserveApplicationFormOptions {
  /** Policy-selected page actions, required for JavaScript forms without a form owner. */
  readonly finalActionTargets?: readonly ApplyFinalActionTarget[];
  /** Exact opaque preparation identity retained by the owning browser runtime. */
  readonly pageBindingKey?: string;
}

export interface ExecuteExactlyOneFinalActionInput {
  /** Exact opaque preparation identity retained by the owning browser runtime. */
  readonly pageBindingKey?: string;
  readonly expectedObservation: SubmissionObservationIdentity;
  readonly expectedControl: SubmissionFinalControlIdentity;
  /** Current page origin captured by the preflight; origin scope is separate. */
  readonly expectedPageOrigin: string;
  readonly allowedOrigins: readonly string[];
  /** Last-instant deterministic veto; omission is a fail-closed type error. */
  readonly veto: (input: {
    readonly observation: ApplicationFormObservation;
    readonly control: ApplicationFinalControl;
  }) => boolean | Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly callId?: string;
  readonly clickTimeoutMs?: number;
}

interface RawApplicationControl {
  ref?: string;
  ordinal: number;
  kind: ApplicationFinalControlKind;
  label: string;
  formIndex: number;
  actionOrigin: string | null;
  actionPath: string | null;
  /** Transient only: participates in the digest, never in receipts or diagnostics. */
  actionUrl: string;
  actionMethod: string;
  actionTarget: string;
}

interface RawApplicationFormSnapshot {
  pageOrigin: string | null;
  pagePath: string | null;
  complete: boolean;
  controls: RawApplicationControl[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readSafePageUrl(value: string): ApplicationSafePageUrl {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { origin: null, safePath: null };
    }
    return {
      origin: url.origin,
      safePath: url.pathname.startsWith("/") ? url.pathname : "/",
    };
  } catch {
    return { origin: null, safePath: null };
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function isApplicationFinalControlKind(
  value: unknown,
): value is ApplicationFinalControlKind {
  return (
    typeof value === "string" &&
    (applicationFinalControlKindValues as readonly string[]).includes(value)
  );
}

function isRawApplicationControl(
  value: unknown,
): value is RawApplicationControl {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.ordinal) &&
    (record.ordinal as number) >= 0 &&
    isApplicationFinalControlKind(record.kind) &&
    typeof record.label === "string" &&
    Number.isInteger(record.formIndex) &&
    (record.formIndex as number) >= -1 &&
    (typeof record.actionOrigin === "string" || record.actionOrigin === null) &&
    (typeof record.actionPath === "string" || record.actionPath === null) &&
    typeof record.actionUrl === "string" &&
    typeof record.actionMethod === "string" &&
    typeof record.actionTarget === "string"
  );
}

function isRawApplicationFormSnapshot(
  value: unknown,
): value is RawApplicationFormSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (typeof record.pageOrigin === "string" || record.pageOrigin === null) &&
    (typeof record.pagePath === "string" || record.pagePath === null) &&
    typeof record.complete === "boolean" &&
    Array.isArray(record.controls) &&
    record.controls.every(isRawApplicationControl)
  );
}

function assertRawApplicationFormSnapshot(
  value: unknown,
): asserts value is RawApplicationFormSnapshot {
  if (!isRawApplicationFormSnapshot(value)) {
    throw new Error(
      "Browser returned an invalid application form observation.",
    );
  }
}

function buildControl(raw: RawApplicationControl): ApplicationFinalControl {
  const action: ApplicationSafePageUrl = {
    origin: raw.actionOrigin,
    safePath: raw.actionPath,
  };
  const ref = raw.ref ?? `final-control-${raw.ordinal}`;
  const signature = sha256(
    canonicalJson({
      action,
      formIndex: raw.formIndex,
      kind: raw.kind,
      label: raw.label,
      ordinal: raw.ordinal,
      ref,
      actionBinding: {
        url: raw.actionUrl,
        method: raw.actionMethod,
        target: raw.actionTarget,
      },
    }),
  );
  return {
    identity: SubmissionFinalControlIdentitySchema.parse({
      ref,
      signature,
    }),
    ordinal: raw.ordinal,
    kind: raw.kind,
    label: raw.label,
    formIndex: raw.formIndex,
    action,
  };
}

function buildObservation(
  raw: RawApplicationFormSnapshot,
): ApplicationFormObservation {
  const page: ApplicationSafePageUrl = {
    origin: raw.pageOrigin,
    safePath: raw.pagePath,
  };
  const controls = raw.controls.map(buildControl);
  const digest = sha256(
    canonicalJson({
      controls: controls.map((control) => ({
        action: control.action,
        formIndex: control.formIndex,
        identity: control.identity,
        kind: control.kind,
        label: control.label,
        ordinal: control.ordinal,
      })),
      complete: raw.complete,
      page,
    }),
  );
  return {
    identity: SubmissionObservationIdentitySchema.parse({
      digest,
      id: `application-observation-${digest}`,
      revision: 1,
    }),
    page,
    complete: raw.complete,
    controls,
  };
}

async function readRawApplicationFormSnapshot(
  page: Page,
): Promise<RawApplicationFormSnapshot> {
  watchPageSelfLimits(page);
  const binding = finalActionTargets.get(page);
  if (binding?.targets.length) {
    const raw = await readRawApplyPage(page);
    const entries = [
      ...raw.actions,
      ...raw.links,
      ...raw.clickables,
      ...raw.controls,
    ];
    const controls: RawApplicationControl[] = [];
    for (const target of binding.targets) {
      const entry = entries.find((entry) => entry.ref === target.ref);
      if (!entry) continue;
      const destination = new URL(
        "formAction" in entry && entry.formAction ? entry.formAction : raw.url!,
      );
      controls.push({
        ref: target.ref,
        ordinal: controls.length,
        kind: "button",
        label: entry.label || target.label || target.ref,
        formIndex: "formIndex" in entry ? (entry.formIndex ?? -1) : -1,
        actionOrigin: destination.origin,
        actionPath: destination.pathname,
        actionUrl: destination.href,
        actionMethod:
          "formMethod" in entry ? (entry.formMethod ?? "GET") : "GET",
        actionTarget: "_self",
      });
    }
    const destination = new URL(raw.url!);
    return {
      pageOrigin: destination.origin,
      pagePath: destination.pathname,
      complete: controls.length === binding.targets.length,
      controls,
    };
  }
  const targets: { ordinal: number; label: string }[] = [];
  let targetsComplete = !binding || binding.url === page.url();
  for (const target of binding?.targets ?? []) {
    if (!target.label.trim()) {
      targetsComplete = false;
      continue;
    }
    const locator = actionLocator(page, target.ref);
    const ordinal = await locator
      ?.evaluate(
        (element, selector) => {
          if (window !== window.top) return -1;
          return Array.from(document.querySelectorAll(selector)).indexOf(
            element,
          );
        },
        APPLICATION_FINAL_CONTROL_SELECTOR,
        { timeout: 0 },
      )
      .catch(() => -1);
    if (
      ordinal === undefined ||
      ordinal < 0 ||
      targets.some((entry) => entry.ordinal === ordinal)
    ) {
      targetsComplete = false;
      continue;
    }
    targets.push({ ordinal, label: target.label });
  }
  const raw: unknown = await page.evaluate(
    ({ selector, targets, targetsComplete }) => {
      const normalize = (value: string): string =>
        value.replace(/\s+/gu, " ").trim();
      const isVisible = (element: Element): boolean => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const labelFor = (element: Element): string =>
        normalize(
          [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("value"),
            element.textContent,
            element.getAttribute("name"),
          ]
            .filter((value): value is string => typeof value === "string")
            .join(" "),
        );
      const pageUrl = new URL(window.location.href);
      const controls: RawApplicationControl[] = [];
      let complete = targetsComplete;
      const matchedTargets = new Set<number>();
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(selector),
      );
      candidates.forEach((element, ordinal) => {
        const form = (element as HTMLButtonElement | HTMLInputElement).form;
        const target = targets.find((entry) => entry.ordinal === ordinal);
        if (!isVisible(element) || element.matches(":disabled")) {
          return;
        }
        if (element.getAttribute("aria-disabled") === "true") {
          return;
        }
        const tagName = element.tagName.toLowerCase();
        const type = (element.getAttribute("type") ?? "").toLowerCase();
        const targetMatches =
          !!target &&
          [
            [
              element.getAttribute("aria-label"),
              element.getAttribute("title"),
              element.getAttribute("value"),
              element.textContent,
              element.getAttribute("name"),
            ]
              .filter((value) => typeof value === "string")
              .join(" "),
            element.getAttribute("aria-label") ?? "",
            element.textContent ?? "",
            element.getAttribute("value") ?? "",
          ].some(
            (label) =>
              label.replace(/\s+/gu, " ").trim() ===
              target.label.replace(/\s+/gu, " ").trim(),
          );
        if (targetMatches) matchedTargets.add(ordinal);
        if (!form && !targetMatches) return;
        const kind: ApplicationFinalControlKind | null =
          tagName === "button" &&
          (type === "" || type === "submit" || targetMatches)
            ? "button"
            : tagName === "input" && type === "submit"
              ? "input_submit"
              : tagName === "input" && type === "image"
                ? "input_image"
                : null;
        if (!kind) {
          return;
        }
        let actionUrl: URL;
        try {
          actionUrl = new URL(
            element.getAttribute("formaction") ??
              form?.getAttribute("action") ??
              pageUrl.href,
            document.baseURI,
          );
        } catch {
          actionUrl = new URL("about:blank");
        }
        const isHttpAction =
          actionUrl.protocol === "http:" || actionUrl.protocol === "https:";
        controls.push({
          ordinal,
          kind,
          label: labelFor(element),
          formIndex: form ? Array.from(document.forms).indexOf(form) : -1,
          actionOrigin: isHttpAction ? actionUrl.origin : null,
          actionPath: isHttpAction ? actionUrl.pathname : null,
          actionUrl: actionUrl.href,
          actionMethod: (
            element.getAttribute("formmethod") ??
            form?.getAttribute("method") ??
            "GET"
          ).toUpperCase(),
          actionTarget:
            element.getAttribute("formtarget") ??
            form?.getAttribute("target") ??
            "_self",
        });
      });
      if (matchedTargets.size !== targets.length) complete = false;
      return {
        pageOrigin:
          pageUrl.protocol === "http:" || pageUrl.protocol === "https:"
            ? pageUrl.origin
            : null,
        pagePath:
          pageUrl.protocol === "http:" || pageUrl.protocol === "https:"
            ? pageUrl.pathname
            : null,
        complete,
        controls,
      } satisfies RawApplicationFormSnapshot;
    },
    {
      selector: APPLICATION_FINAL_CONTROL_SELECTOR,
      targets,
      targetsComplete,
    },
  );
  assertRawApplicationFormSnapshot(raw);
  return raw;
}

// The host supplies policy; these page-local refs grant no authority themselves.
const finalActionTargets = new WeakMap<
  Page,
  { url: string; targets: readonly ApplyFinalActionTarget[] }
>();

const nativeActionBindings = new WeakMap<
  Page,
  Map<string, { query: string; method: string }>
>();

function emptyFacts(
  page: ApplicationSafePageUrl,
): ApplicationExternalActionFacts {
  return {
    actionAttempted: false,
    actionIssued: false,
    actionCompleted: false,
    pageBefore: page,
    pageAfter: page,
    urlChanged: false,
    requestsObservedDuringAction: 0,
    requestsAfterClick: [],
  };
}

function sameControlIdentity(
  left: SubmissionFinalControlIdentity,
  right: SubmissionFinalControlIdentity,
): boolean {
  return left.ref === right.ref && left.signature === right.signature;
}

/**
 * Network errors raised before a connection to the site existed. A request
 * that failed this way never delivered a byte, so the site cannot have
 * received the application. A reset, a timeout or an empty response are not
 * here: the site may have read the form before they happened.
 */
const SITE_UNREACHABLE_ERROR =
  /ERR_(?:CONNECTION_REFUSED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE)\b/;

export function isSiteUnreachableError(errorText: string | undefined): boolean {
  return (
    typeof errorText === "string" && SITE_UNREACHABLE_ERROR.test(errorText)
  );
}

function blockedResult(input: {
  reason: ApplicationFinalActionBlockReason;
  observation: ApplicationFormObservation | null;
  control?: ApplicationFinalControl | null;
  facts: ApplicationExternalActionFacts;
}): ApplicationFinalActionResult {
  return {
    outcome: "not_submitted",
    reason: input.reason,
    observation: input.observation,
    control: input.control ?? null,
    facts: input.facts,
  };
}

const pageExecutionLocks = new WeakMap<object, Promise<void>>();
const pageActionKeys = new WeakMap<object, Set<string>>();

function actionKey(
  observation: SubmissionObservationIdentity,
  control: SubmissionFinalControlIdentity,
): string {
  return `${observation.id}:${observation.revision}:${observation.digest}:${control.ref}:${control.signature}`;
}

function hasIssuedAction(page: Page, key: string): boolean {
  return pageActionKeys.get(page)?.has(key) ?? false;
}

function rememberIssuedAction(page: Page, key: string): void {
  const keys = pageActionKeys.get(page) ?? new Set<string>();
  keys.add(key);
  pageActionKeys.set(page, keys);
}

async function withPageExecutionLock<TValue>(
  page: Page,
  operation: () => Promise<TValue>,
): Promise<TValue> {
  const previous = pageExecutionLocks.get(page) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pageExecutionLocks.set(page, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (pageExecutionLocks.get(page) === current) {
      pageExecutionLocks.delete(page);
    }
  }
}

/**
 * Observe all visible, enabled form final controls. The result is transient
 * and contains no DOM handles, selectors, credentials, or raw page markup.
 */
export async function observeApplicationForm(
  page: Page,
  options?: ObserveApplicationFormOptions,
): Promise<ApplicationFormObservation> {
  if (options?.finalActionTargets !== undefined)
    finalActionTargets.set(page, {
      url: page.url(),
      targets: options.finalActionTargets.map((target) => ({ ...target })),
    });
  const raw = await withBrowserReadLiveness(page, () =>
    readRawApplicationFormSnapshot(page),
  );
  const observation = buildObservation(raw);
  nativeActionBindings.set(
    page,
    new Map(
      raw.controls.map((control, index) => [
        observation.controls[index]!.identity.signature,
        {
          query: new URL(control.actionUrl).search,
          method: control.actionMethod,
        },
      ]),
    ),
  );
  return observation;
}

/**
 * Re-observe the exact target and issue one click per call ID. Return page
 * and request facts; the application model records the observed outcome.
 */
export async function executeExactlyOneFinalAction(
  page: Page,
  input: ExecuteExactlyOneFinalActionInput,
): Promise<ApplicationFinalActionResult> {
  const expectedObservation = SubmissionObservationIdentitySchema.parse(
    input.expectedObservation,
  );
  const expectedControl = SubmissionFinalControlIdentitySchema.parse(
    input.expectedControl,
  );

  return withPageExecutionLock(page, async () => {
    const initialPage = readSafePageUrl(page.url());
    const initialFacts = emptyFacts(initialPage);
    if (input.signal?.aborted) {
      return blockedResult({
        reason: "aborted",
        observation: null,
        facts: initialFacts,
      });
    }
    let observation: ApplicationFormObservation;
    try {
      observation = await observeApplicationForm(page);
    } catch {
      return blockedResult({
        reason: "stale_control",
        observation: null,
        facts: initialFacts,
      });
    }
    const control = observation.controls.find((entry) =>
      sameControlIdentity(entry.identity, expectedControl),
    );
    if (!control)
      return blockedResult({
        reason: "stale_control",
        observation,
        facts: initialFacts,
      });
    if (input.signal?.aborted)
      return blockedResult({
        reason: "aborted",
        observation,
        control,
        facts: initialFacts,
      });
    const key = input.callId ?? actionKey(expectedObservation, expectedControl);
    if (hasIssuedAction(page, key))
      return blockedResult({
        reason: "stale_control",
        observation,
        control,
        facts: initialFacts,
      });
    const finalObservation = observation,
      finalControl = control;
    const pageBefore = initialPage;
    rememberIssuedAction(page, key);
    const requests: ApplicationActionRequest[] = [];
    const byRequest = new Map<Request, ApplicationActionRequest>();
    const onRequest = (request: Request) => {
      try {
        const url = new URL(request.url());
        const entry: ApplicationActionRequest = {
          method: request.method(),
          host: url.host,
          path: url.pathname,
          status: null,
          failure: null,
          finalSubmit: false,
        };
        requests.push(entry);
        byRequest.set(request, entry);
      } catch {
        /* Non-HTTP requests have no host/path. */
      }
    };
    const onResponse = (response: Response) => {
      const entry = byRequest.get(response.request());
      if (entry) Object.assign(entry, { status: response.status() });
    };
    const onFailure = (request: Request) => {
      const entry = byRequest.get(request);
      if (entry)
        Object.assign(entry, {
          failure: request.failure()?.errorText ?? "failed",
        });
    };
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfailed", onFailure);
    const stopAction = () => {
      void page.close().catch(() => undefined);
    };
    input.signal?.addEventListener("abort", stopAction, { once: true });
    let actionCompleted = false,
      actionError: unknown = null;
    try {
      if (finalActionTargets.get(page)?.targets.length) {
        const result = await createPlaywrightApplyPageMechanics(
          page,
        ).clickElement(control.identity.ref);
        if (!result.ok) throw new Error(result.error);
      } else {
        await page
          .locator(APPLICATION_FINAL_CONTROL_SELECTOR)
          .nth(control.ordinal)
          .click({ timeout: 0 });
      }
      actionCompleted = true;
    } catch (error) {
      actionError = error;
    }
    let siteMessage = "";
    try {
      siteMessage = await withBrowserReadLiveness(page, () =>
        readVisibleText(page.locator("body")),
      );
    } catch {
      /* Navigation/read failure is returned as uncertainty. */
    } finally {
      input.signal?.removeEventListener("abort", stopAction);
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailure);
    }
    const pageAfter = readSafePageUrl(page.url());
    return {
      outcome: "outcome_uncertain",
      reason: actionError === null ? "action_issued" : "action_error",
      observation: finalObservation,
      control: finalControl,
      facts: {
        actionAttempted: true,
        actionIssued: true,
        actionCompleted,
        pageBefore,
        pageAfter,
        urlChanged:
          pageBefore.origin !== pageAfter.origin ||
          pageBefore.safePath !== pageAfter.safePath,
        requestsObservedDuringAction: requests.length,
        requestsAfterClick: requests,
      },
      ...(siteMessage ? { siteMessage } : {}),
    };
  });
}
