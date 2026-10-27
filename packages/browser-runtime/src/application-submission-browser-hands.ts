import { createHash } from "node:crypto";
import {
  submissionConfirmationSummary,
  ApplicationAuthorityOriginSchema,
  SubmissionFinalControlIdentitySchema,
  SubmissionObservationIdentitySchema,
  type SubmissionFinalControlIdentity,
  type SubmissionObservationIdentity,
  type ApplyFinalActionTarget,
} from "@nestor/contracts";
import type { Page, Request, Response } from "playwright";
import { actionLocator } from "./apply-page-mechanics";
import {
  employerPageConfirmsSubmission,
  isFinalSubmissionRequest,
  type SubmissionPageState,
} from "./submission-confirmation-policy";

import { readPageMessages } from "./page-messages";
import {
  closePrepareOnlyFinalActionWindow,
  openPrepareOnlyFinalActionWindow,
} from "./playwright-application-flow";

/** Read the site's explicit field feedback; do not infer rejection from page prose. */
async function readApplicationValidationErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const errors = new Set<string>();
    for (const control of document.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("form input, form select, form textarea")) {
      if (
        control.disabled ||
        control.type === "hidden" ||
        control.getClientRects().length === 0
      )
        continue;
      if (
        control.willValidate &&
        !control.validity.valid &&
        control.validationMessage
      ) {
        const label = control.labels?.[0]?.textContent?.trim();
        errors.add(
          label
            ? `${label}: ${control.validationMessage}`
            : control.validationMessage,
        );
      }
      for (const id of (control.getAttribute("aria-describedby") ?? "").split(
        /\s+/u,
      )) {
        const feedback = document.getElementById(id);
        if (
          !feedback ||
          feedback.getAttribute("role") !== "alert" ||
          feedback.getClientRects().length === 0
        )
          continue;
        const message = feedback.textContent?.trim();
        if (message) errors.add(message);
      }
    }
    return [...errors];
  });
}

async function readSubmissionPageState(
  page: Page,
): Promise<SubmissionPageState> {
  return page.evaluate(() => ({
    url: location.href,
    text: document.body?.innerText ?? "",
    ready: document.readyState !== "loading",
    editableControls: [
      ...document.querySelectorAll<HTMLElement>(
        "input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select,[contenteditable=true]",
      ),
    ].filter(
      (element) =>
        !element.matches(":disabled") &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== "hidden",
    ).length,
  }));
}

/**
 * Generic final-control discovery deliberately knows nothing about a provider
 * or an application's answer policy. Product orchestration supplies the
 * authority, preflight, and last-instant veto around these browser hands.
 */
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

/** The most requests a receipt keeps; the count still says how many there were. */
const ACTION_REQUESTS_KEPT = 50;

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
  /** Optional cap against pathological pages; the default is intentionally bounded. */
  readonly maxControls?: number;
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
  readonly clickTimeoutMs?: number;
  readonly confirmationTimeoutMs?: number;
}

interface RawApplicationControl {
  ordinal: number;
  kind: ApplicationFinalControlKind;
  label: string;
  formIndex: number;
  actionOrigin: string | null;
  actionPath: string | null;
}

interface RawApplicationFormSnapshot {
  pageOrigin: string | null;
  pagePath: string | null;
  complete: boolean;
  controls: RawApplicationControl[];
}

const DEFAULT_MAX_CONTROLS = 500;
const DEFAULT_CLICK_TIMEOUT_MS = 5_000;

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

function normalizeAllowedOrigin(value: string): string | null {
  try {
    return ApplicationAuthorityOriginSchema.parse(value).replace(/\/$/u, "");
  } catch {
    return null;
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
    (typeof record.actionPath === "string" || record.actionPath === null)
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
  const ref = `final-control-${raw.ordinal}`;
  const signature = sha256(
    canonicalJson({
      action,
      formIndex: raw.formIndex,
      kind: raw.kind,
      label: raw.label,
      ordinal: raw.ordinal,
      ref,
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
  maxControls: number,
): Promise<RawApplicationFormSnapshot> {
  const binding = finalActionTargets.get(page);
  const targets: { ordinal: number; label: string }[] = [];
  let targetsComplete = !binding || binding.url === page.url();
  for (const target of binding?.targets ?? []) {
    if (!target.label.trim()) {
      targetsComplete = false;
      continue;
    }
    if (targets.length >= DEFAULT_MAX_CONTROLS) {
      targetsComplete = false;
      break;
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
        { timeout: 250 },
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
    ({ selector, limit, targets, targetsComplete }) => {
      const normalize = (value: string): string =>
        value.replace(/\s+/gu, " ").trim().slice(0, 200);
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
        if (controls.length >= limit) {
          complete = false;
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
      limit: maxControls,
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

function sameIdentity(
  left: SubmissionObservationIdentity,
  right: SubmissionObservationIdentity,
): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    left.digest === right.digest
  );
}

function sameControlIdentity(
  left: SubmissionFinalControlIdentity,
  right: SubmissionFinalControlIdentity,
): boolean {
  return left.ref === right.ref && left.signature === right.signature;
}

/**
 * True only when Playwright's click timed out during its actionability
 * waits: its call log never reached "performing click action", the point at
 * which it dispatches input to the page. Any other failure may have clicked.
 */
function clickWasNeverDispatched(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const isTimeout =
    error.name === "TimeoutError" ||
    /Timeout \d+ms exceeded/.test(error.message);
  return (
    isTimeout &&
    !/performing click action|click action done/i.test(error.message)
  );
}

/**
 * Network errors raised before a connection to the site existed. A request
 * that failed this way never delivered a byte, so the site cannot have
 * received the application. A reset, a timeout or an empty response are not
 * here: the site may have read the form before they happened.
 */
const SITE_UNREACHABLE_ERROR =
  /ERR_(?:CONNECTION_REFUSED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_CHANGED)\b/;

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

/**
 * A click Playwright never dispatched reached nothing, so the tuple is free
 * again: the person's Send after "the send button could not be pressed" must
 * press it, not come back "stale observation" for ever.
 */
function forgetIssuedAction(page: Page, key: string): void {
  pageActionKeys.get(page)?.delete(key);
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
  const requestedMaxControls = options?.maxControls;
  const maxControls =
    requestedMaxControls === undefined
      ? DEFAULT_MAX_CONTROLS
      : Number.isFinite(requestedMaxControls) &&
          Number.isInteger(requestedMaxControls)
        ? Math.max(1, Math.min(requestedMaxControls, DEFAULT_MAX_CONTROLS))
        : DEFAULT_MAX_CONTROLS;
  return buildObservation(
    await readRawApplicationFormSnapshot(page, maxControls),
  );
}

/**
 * Re-observe, validate exact identity/origin, run the immediate veto, and
 * issue at most one final-control click. A click is uncertain unless the
 * employer page then visibly confirms that it received the application.
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
    if (typeof input.veto !== "function") {
      return blockedResult({
        reason: "vetoed",
        observation: null,
        facts: initialFacts,
      });
    }

    let observation: ApplicationFormObservation;
    try {
      observation = await observeApplicationForm(page);
    } catch {
      return blockedResult({
        reason: "stale_observation",
        observation: null,
        facts: initialFacts,
      });
    }

    const currentPageOrigin = observation.page.origin;
    const expectedOrigin = normalizeAllowedOrigin(input.expectedPageOrigin);
    const allowedOrigins = new Set(
      input.allowedOrigins
        .map(normalizeAllowedOrigin)
        .filter((origin): origin is string => origin !== null),
    );
    if (
      expectedOrigin === null ||
      currentPageOrigin === null ||
      currentPageOrigin !== expectedOrigin ||
      !allowedOrigins.has(currentPageOrigin)
    ) {
      return blockedResult({
        reason: "origin_drift",
        observation,
        facts: emptyFacts(initialPage),
      });
    }

    if (!sameIdentity(observation.identity, expectedObservation)) {
      return blockedResult({
        reason: "stale_observation",
        observation,
        facts: emptyFacts(initialPage),
      });
    }
    if (observation.controls.length === 0) {
      return blockedResult({
        reason: "no_final_control",
        observation,
        facts: emptyFacts(initialPage),
      });
    }
    if (observation.controls.length !== 1) {
      return blockedResult({
        reason: "ambiguous_final_controls",
        observation,
        facts: emptyFacts(initialPage),
      });
    }
    if (!observation.complete) {
      return blockedResult({
        reason: "ambiguous_final_controls",
        observation,
        facts: emptyFacts(initialPage),
      });
    }

    const control = observation.controls[0];
    if (!control || !sameControlIdentity(control.identity, expectedControl)) {
      return blockedResult({
        reason: "stale_control",
        observation,
        control: control ?? null,
        facts: emptyFacts(initialPage),
      });
    }
    const key = actionKey(expectedObservation, expectedControl);
    if (hasIssuedAction(page, key)) {
      return blockedResult({
        reason: "stale_observation",
        observation,
        control,
        facts: emptyFacts(initialPage),
      });
    }
    if (
      control.action.origin === null ||
      !allowedOrigins.has(control.action.origin)
    ) {
      return blockedResult({
        reason: "origin_drift",
        observation,
        control,
        facts: emptyFacts(initialPage),
      });
    }

    try {
      if (!(await input.veto({ observation, control }))) {
        return blockedResult({
          reason: "vetoed",
          observation,
          control,
          facts: emptyFacts(initialPage),
        });
      }
    } catch {
      return blockedResult({
        reason: "vetoed",
        observation,
        control,
        facts: emptyFacts(initialPage),
      });
    }

    if (input.signal?.aborted) {
      return blockedResult({
        reason: "aborted",
        observation,
        control,
        facts: emptyFacts(initialPage),
      });
    }

    // The veto may itself trigger a rerender. Re-observe after it and before
    // obtaining a locator so a stale control can never be clicked.
    let finalObservation: ApplicationFormObservation;
    try {
      finalObservation = await observeApplicationForm(page);
    } catch {
      return blockedResult({
        reason: "stale_observation",
        observation,
        control,
        facts: emptyFacts(initialPage),
      });
    }
    const finalPage = readSafePageUrl(page.url());
    if (
      finalPage.origin !== expectedOrigin ||
      finalPage.origin === null ||
      !allowedOrigins.has(finalPage.origin)
    ) {
      return blockedResult({
        reason: "origin_drift",
        observation: finalObservation,
        control: finalObservation.controls[0] ?? null,
        facts: emptyFacts(initialPage),
      });
    }
    if (!sameIdentity(finalObservation.identity, expectedObservation)) {
      return blockedResult({
        reason: "stale_observation",
        observation: finalObservation,
        control: finalObservation.controls[0] ?? null,
        facts: emptyFacts(initialPage),
      });
    }
    if (finalObservation.controls.length === 0) {
      return blockedResult({
        reason: "no_final_control",
        observation: finalObservation,
        facts: emptyFacts(initialPage),
      });
    }
    if (finalObservation.controls.length !== 1) {
      return blockedResult({
        reason: "ambiguous_final_controls",
        observation: finalObservation,
        facts: emptyFacts(initialPage),
      });
    }
    if (!finalObservation.complete) {
      return blockedResult({
        reason: "ambiguous_final_controls",
        observation: finalObservation,
        facts: emptyFacts(initialPage),
      });
    }
    const finalControl = finalObservation.controls[0];
    if (
      !finalControl ||
      !sameControlIdentity(finalControl.identity, expectedControl)
    ) {
      return blockedResult({
        reason: "stale_control",
        observation: finalObservation,
        control: finalControl ?? null,
        facts: emptyFacts(initialPage),
      });
    }

    let liveControlMatches = false;
    try {
      const live = await readRawApplicationFormSnapshot(
        page,
        DEFAULT_MAX_CONTROLS,
      );
      const liveControl =
        live.complete && live.controls.length === 1
          ? (live.controls[0] ?? null)
          : null;
      liveControlMatches =
        liveControl !== null &&
        liveControl.ordinal === finalControl.ordinal &&
        liveControl.kind === finalControl.kind &&
        liveControl.label === finalControl.label &&
        liveControl.formIndex === finalControl.formIndex &&
        liveControl.actionOrigin === finalControl.action.origin &&
        liveControl.actionPath === finalControl.action.safePath;
    } catch {
      liveControlMatches = false;
    }
    if (!liveControlMatches) {
      return blockedResult({
        reason: "stale_control",
        observation: finalObservation,
        control: finalControl,
        facts: emptyFacts(initialPage),
      });
    }

    const pageBefore = readSafePageUrl(page.url());
    if (
      pageBefore.origin !== expectedOrigin ||
      pageBefore.origin === null ||
      !allowedOrigins.has(pageBefore.origin)
    ) {
      return blockedResult({
        reason: "origin_drift",
        observation: finalObservation,
        control: finalControl,
        facts: emptyFacts(initialPage),
      });
    }

    const beforeConfirmation = await readSubmissionPageState(page).catch(
      () => null,
    );
    // Run the veto again after every awaited observation and live-control
    // check. The first veto above is allowed to trigger a rerender; this one
    // is the final positive authorization immediately before the click.
    try {
      if (
        !(await input.veto({
          observation: finalObservation,
          control: finalControl,
        }))
      ) {
        return blockedResult({
          reason: "vetoed",
          observation: finalObservation,
          control: finalControl,
          facts: emptyFacts(initialPage),
        });
      }
    } catch {
      return blockedResult({
        reason: "vetoed",
        observation: finalObservation,
        control: finalControl,
        facts: emptyFacts(initialPage),
      });
    }

    // A veto may have changed the top-level location. Re-check this
    // synchronous fact after the final veto before crossing the action
    // boundary; the effective submitter destination was already re-observed
    // above using formaction/form action precedence.
    const pageAfterVeto = readSafePageUrl(page.url());
    if (
      pageAfterVeto.origin !== expectedOrigin ||
      pageAfterVeto.origin === null ||
      !allowedOrigins.has(pageAfterVeto.origin)
    ) {
      return blockedResult({
        reason: "origin_drift",
        observation: finalObservation,
        control: finalControl,
        facts: emptyFacts(initialPage),
      });
    }

    // Re-observe after the final veto as well. This closes the specific case
    // where the veto callback changes the submitter's effective formaction;
    // the destination must still be the exact, allowed control we approved.
    let postVetoObservation: ApplicationFormObservation;
    try {
      postVetoObservation = await observeApplicationForm(page);
    } catch {
      return blockedResult({
        reason: "stale_observation",
        observation: finalObservation,
        control: finalControl,
        facts: emptyFacts(initialPage),
      });
    }
    if (
      !sameIdentity(postVetoObservation.identity, expectedObservation) ||
      postVetoObservation.controls.length !== 1 ||
      !postVetoObservation.complete
    ) {
      return blockedResult({
        reason: "stale_observation",
        observation: postVetoObservation,
        control: postVetoObservation.controls[0] ?? null,
        facts: emptyFacts(initialPage),
      });
    }
    const postVetoControl = postVetoObservation.controls[0];
    if (
      !postVetoControl ||
      !sameControlIdentity(postVetoControl.identity, expectedControl)
    ) {
      return blockedResult({
        reason: "stale_control",
        observation: postVetoObservation,
        control: postVetoControl ?? null,
        facts: emptyFacts(initialPage),
      });
    }
    if (
      postVetoControl.action.origin === null ||
      !allowedOrigins.has(postVetoControl.action.origin)
    ) {
      return blockedResult({
        reason: "origin_drift",
        observation: postVetoObservation,
        control: postVetoControl,
        facts: emptyFacts(initialPage),
      });
    }
    const postVetoLocator = page
      .locator(APPLICATION_FINAL_CONTROL_SELECTOR)
      .nth(postVetoControl.ordinal);

    // Consume this page/observation/control tuple before entering Playwright.
    // A timeout or a black-holed request is therefore not retried by a second
    // caller that happens to hold the same preflight.
    rememberIssuedAction(page, key);
    let requestsObservedDuringAction = 0;
    const requestLog = new Map<
      Request,
      {
        method: string;
        host: string;
        path: string;
        status: number | null;
        failure: string | null;
      }
    >();
    const finalRequests = new Set<Request>();
    const answeredFinalRequests = new Set<Request>();
    const unreachableFinalRequests = new Set<Request>();
    const successfulFinalRequests = new Set<Request>();
    const originalRequest = (request: Request): Request => {
      let original = request;
      for (
        let previous = original.redirectedFrom();
        previous;
        previous = original.redirectedFrom()
      )
        original = previous;
      return original;
    };
    const requestListener = (request: Request): void => {
      requestsObservedDuringAction += 1;
      if (!request.redirectedFrom() && requestLog.size < ACTION_REQUESTS_KEPT)
        try {
          const url = new URL(request.url());
          if (url.protocol === "http:" || url.protocol === "https:")
            requestLog.set(request, {
              method: request.method(),
              host: url.host,
              path: url.pathname.slice(0, 500),
              status: null,
              failure: null,
            });
        } catch {
          /* An unreadable address is left out of the record. */
        }
      try {
        if (
          !request.redirectedFrom() &&
          isFinalSubmissionRequest({
            url: request.url(),
            method: request.method(),
            body: request.postData(),
            mainFrame: request.frame() === page.mainFrame(),
            navigation: request.isNavigationRequest(),
            allowedOrigins,
            nativeAction:
              postVetoControl.formIndex >= 0 ? postVetoControl.action : null,
          })
        )
          finalRequests.add(request);
      } catch {
        /* A worker or unreadable request supplies no final evidence. */
      }
    };
    page.on("request", requestListener);
    // Keep the exact final request through the confirmation wait: a site's
    // submit may start after the click returns. Other requests and browser
    // alerts are neither successful sends nor proof that the site was unreachable.
    const responseListener = (response: Response): void => {
      const request = originalRequest(response.request());
      const logged = requestLog.get(request);
      if (logged) logged.status = response.status();
      if (finalRequests.has(request)) answeredFinalRequests.add(request);
      if (
        finalRequests.has(request) &&
        response.status() >= 200 &&
        response.status() < 300
      )
        successfulFinalRequests.add(request);
    };
    const requestFailedListener = (request: Request): void => {
      const errorText = request.failure()?.errorText;
      const logged = requestLog.get(originalRequest(request));
      if (logged && logged.status === null)
        logged.failure = (errorText ?? "failed").slice(0, 120);
      if (
        isSiteUnreachableError(errorText) &&
        finalRequests.has(originalRequest(request))
      )
        unreachableFinalRequests.add(originalRequest(request));
    };
    page.on("response", responseListener);
    page.on("requestfailed", requestFailedListener);
    const requestsAfterClick = (): ApplicationActionRequest[] =>
      [...requestLog].map(([request, logged]) => ({
        ...logged,
        finalSubmit: finalRequests.has(request),
      }));
    const stopWatchingNetwork = (): void => {
      page.off("request", requestListener);
      page.off("response", responseListener);
      page.off("requestfailed", requestFailedListener);
    };
    const siteNeverReached = (): boolean =>
      finalRequests.size === 1 &&
      unreachableFinalRequests.size === 1 &&
      answeredFinalRequests.size === 0;
    let actionCompleted = false;
    // The prepare-only guard stays on the page from preparation; this is the
    // one press it is opened for.
    await openPrepareOnlyFinalActionWindow(page);
    const clickedAt = Date.now();
    try {
      await postVetoLocator.click({
        noWaitAfter: true,
        timeout: input.clickTimeoutMs ?? DEFAULT_CLICK_TIMEOUT_MS,
      });
      actionCompleted = true;
    } catch (clickError) {
      const pageAfterError = readSafePageUrl(page.url());
      page.off("request", requestListener);
      stopWatchingNetwork();
      if (
        clickWasNeverDispatched(clickError) &&
        requestsObservedDuringAction === 0 &&
        pageAfterError.origin === pageBefore.origin &&
        pageAfterError.safePath === pageBefore.safePath
      ) {
        // Playwright gave up while waiting for the control to be clickable
        // (for example a cookie banner over it), so no click reached the
        // page. Nothing was sent; the prepared form stays for another try
        // instead of an "uncertain" outcome that blocks every retry.
        forgetIssuedAction(page, key);
        await closePrepareOnlyFinalActionWindow(page).catch(() => undefined);
        return blockedResult({
          reason: "action_error",
          observation: finalObservation,
          control: finalControl,
          facts: {
            actionAttempted: true,
            actionIssued: false,
            actionCompleted: false,
            pageBefore,
            pageAfter: pageAfterError,
            urlChanged: false,
            requestsObservedDuringAction,
            requestsAfterClick: requestsAfterClick(),
          },
        });
      }
      return {
        outcome: "outcome_uncertain",
        reason: "action_error",
        observation: finalObservation,
        control: finalControl,
        facts: {
          actionAttempted: true,
          actionIssued: false,
          actionCompleted: false,
          pageBefore,
          pageAfter: pageAfterError,
          urlChanged:
            pageBefore.origin !== pageAfterError.origin ||
            pageBefore.safePath !== pageAfterError.safePath,
          requestsObservedDuringAction,
          requestsAfterClick: requestsAfterClick(),
        },
      };
    }
    const pageAfter = readSafePageUrl(page.url());
    const facts: ApplicationExternalActionFacts = {
      actionAttempted: true,
      actionIssued: true,
      actionCompleted,
      pageBefore,
      pageAfter,
      urlChanged:
        pageBefore.origin !== pageAfter.origin ||
        pageBefore.safePath !== pageAfter.safePath,
      requestsObservedDuringAction,
      requestsAfterClick: [],
    };
    const confirmationDeadline =
      Date.now() + (input.confirmationTimeoutMs ?? 15_000);
    do {
      if (input.signal?.aborted) break;
      if (siteNeverReached()) break;
      try {
        const currentPage = await readSubmissionPageState(page);
        if (
          finalRequests.size === 1 &&
          successfulFinalRequests.size === 1 &&
          employerPageConfirmsSubmission(
            beforeConfirmation,
            currentPage,
            allowedOrigins,
          )
        ) {
          stopWatchingNetwork();
          await closePrepareOnlyFinalActionWindow(page);
          return {
            outcome: "submitted",
            reason: "employer_confirmation",
            observation: finalObservation,
            control: finalControl,
            confirmation: {
              observedAt: new Date().toISOString(),
              destination: readSafePageUrl(page.url()),
              summary: submissionConfirmationSummary(currentPage.text),
            },
            facts: {
              ...facts,
              requestsObservedDuringAction,
              requestsAfterClick: requestsAfterClick(),
              pageAfter: readSafePageUrl(page.url()),
              urlChanged:
                pageBefore.origin !== readSafePageUrl(page.url()).origin ||
                pageBefore.safePath !== readSafePageUrl(page.url()).safePath,
            },
          };
        }
        const validationErrors = await readApplicationValidationErrors(page);
        // Client validation can be corrected only before a final request
        // leaves. Once one was issued, missing receipt evidence is uncertain.
        if (validationErrors.length > 0 && finalRequests.size === 0) {
          stopWatchingNetwork();
          await closePrepareOnlyFinalActionWindow(page);
          forgetIssuedAction(page, key);
          return {
            outcome: "not_submitted",
            reason: "form_validation_failed",
            observation: finalObservation,
            control: finalControl,
            validationErrors,
            facts: {
              ...facts,
              requestsObservedDuringAction,
              requestsAfterClick: requestsAfterClick(),
              pageAfter: readSafePageUrl(page.url()),
            },
          };
        }
      } catch {
        // Navigation can briefly replace the body. Keep the bounded check.
      }
      await page.waitForTimeout(100);
    } while (Date.now() < confirmationDeadline);
    stopWatchingNetwork();
    await closePrepareOnlyFinalActionWindow(page);
    if (siteNeverReached()) {
      return blockedResult({
        reason: "site_unreachable",
        observation: finalObservation,
        control: finalControl,
        facts: {
          ...facts,
          requestsObservedDuringAction,
          requestsAfterClick: requestsAfterClick(),
          pageAfter: readSafePageUrl(page.url()),
        },
      });
    }
    // What the page said through its own alert after the click (dismissed,
    // never a window). It is never a sign the application arrived, nor proof
    // it did not: a site can show one and still take the application.
    const said = (await readPageMessages(page, clickedAt)).at(-1)?.text;
    return {
      outcome: "outcome_uncertain",
      reason: "confirmation_timeout",
      observation: finalObservation,
      control: finalControl,
      facts: {
        ...facts,
        requestsObservedDuringAction,
        requestsAfterClick: requestsAfterClick(),
        pageAfter: readSafePageUrl(page.url()),
      },
      ...(said ? { siteMessage: said } : {}),
    };
  });
}
