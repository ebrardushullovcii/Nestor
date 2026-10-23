import { useSyncExternalStore } from "react";
import type {
  ApplicationPageReopenProgress,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import type { ApplyStatePresentation } from "./apply-state";
import { APPLICATION_SIGN_IN_CONTINUES_NOTE } from "../../lib/application-sign-in-handoff";
import {
  describeReopenPhase,
  formatJobFinderBrowserHandoffFailedStatus,
  JOB_FINDER_BROWSER_OPENED_STATUS,
  JOB_FINDER_BROWSER_OPENED_WITHOUT_PAGE_STATUS,
  REOPEN_FAILED_REASON,
} from "../../lib/job-finder-browser-handoff-copy";

/**
 * Exact lineage handed to the page route so it can open or focus the managed
 * Job Finder browser on the paused application (the same browser-owned
 * "open page" step Needs you exposes for this result's pending request).
 */
export type FinishInBrowserInput = {
  jobId: string;
  resultId: string;
  runId: string;
  applicationRecordId: string;
  destinationUrl: string | null;
};

/**
 * What the hand-off actually did. The status used to be set optimistically and
 * unconditionally, so a fall-back that opened nothing but a bare browser — and
 * an open that errored outright — both still claimed "Opened in the Job Finder
 * browser. Switch to that window to finish the step", sending the user to a
 * window that never showed the step.
 */
export type FinishInBrowserOutcome =
  | { kind: "opened_application_page" }
  | { kind: "opened_browser_only" }
  | { kind: "failed"; reason?: string | null };

/**
 * The hand-off itself. It is asynchronous in production — opening the window
 * or sending the "open browser step" command is an IPC round trip — so the
 * outcome is a promise, and the status beside the control is written only once
 * that promise has settled. A synchronous outcome (or none) is still accepted
 * so a handler that reports nothing gets no status at all rather than an
 * unearned success claim.
 */
export type FinishInBrowserHandler = (
  input: FinishInBrowserInput,
  /** Each step while a closed form is brought back, filled in and checked. */
  onReopenProgress?: (phase: ApplicationPageReopenProgress["phase"]) => void,
) => FinishInBrowserOutcome | void | Promise<FinishInBrowserOutcome | void>;

/** Said once a filled-in form is open for the person to send themselves. */
export const READY_PAGE_OPENED_STATUS =
  "Opened in the Job Finder browser. Read the form over and press the site's own send button there.";

/**
 * Where opening one result's form stands: a step while it opens, then what
 * the hand-off did. Kept per result outside any screen, so the Applications
 * row, the detail panel and its review card show the same progress and the
 * same outcome whichever one was pressed.
 */
export type ApplicationFormOpenState =
  | { phase: ApplicationPageReopenProgress["phase"] }
  | { outcome: FinishInBrowserOutcome };

let formOpenStates: ReadonlyMap<string, ApplicationFormOpenState> = new Map();
const formOpenListeners = new Set<() => void>();

function setFormOpenState(
  resultId: string,
  state: ApplicationFormOpenState | null,
): void {
  const next = new Map(formOpenStates);
  if (state) next.set(resultId, state);
  else next.delete(resultId);
  formOpenStates = next;
  for (const listener of formOpenListeners) listener();
}

function subscribeFormOpenStates(listener: () => void): () => void {
  formOpenListeners.add(listener);
  return () => {
    formOpenListeners.delete(listener);
  };
}

export function useApplicationFormOpenState(
  resultId: string | null | undefined,
): ApplicationFormOpenState | null {
  return useSyncExternalStore(subscribeFormOpenStates, () =>
    resultId ? (formOpenStates.get(resultId) ?? null) : null,
  );
}

/** Every result's open state, for a list that shows many at once. */
export function useApplicationFormOpenStates(): ReadonlyMap<
  string,
  ApplicationFormOpenState
> {
  return useSyncExternalStore(subscribeFormOpenStates, () => formOpenStates);
}

/**
 * Forgets what earlier opens reported, once the person leaves Applications:
 * "Opened in the browser" from an hour ago is not news. An open still running
 * keeps its step.
 */
export function clearSettledApplicationFormOpenStates(): void {
  const next = new Map(
    [...formOpenStates].filter(([, state]) => "phase" in state),
  );
  if (next.size === formOpenStates.size) return;
  formOpenStates = next;
  for (const listener of formOpenListeners) listener();
}

/** "Opening the page…" and the steps after it, or null once it settled. */
export function formOpenPhaseLabel(
  state: ApplicationFormOpenState | null,
): string | null {
  return state && "phase" in state ? describeReopenPhase(state.phase) : null;
}

/**
 * The cause carried into the failed status when the hand-off rejects. An
 * unreadable rejection reports no cause rather than inventing one; the status
 * sentence is truthful about the failure either way.
 */
function getFinishInBrowserFailureReason(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return null;
}

/** Forgets every open, finished or not. For tests. */
export function resetApplicationFormOpenStates(): void {
  formOpenStates = new Map();
  for (const listener of formOpenListeners) listener();
}

function isOutcomePromise(
  outcome: FinishInBrowserOutcome | void | Promise<FinishInBrowserOutcome | void>,
): outcome is Promise<FinishInBrowserOutcome | void> {
  // Structural, so a thenable from another realm (a test double, the preload
  // bridge) is awaited rather than written into the status as an outcome.
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    typeof (outcome as { then?: unknown }).then === "function"
  );
}

/**
 * Opens one result's form through the page's hand-off and records each step
 * and the outcome for every screen showing that result. The press is answered
 * at once with "Opening the page…"; nothing is claimed until the hand-off
 * settles, and a second press while it runs does nothing.
 */
export function openApplicationForm(
  handler: FinishInBrowserHandler,
  input: FinishInBrowserInput,
  onReopenProgress?: (phase: ApplicationPageReopenProgress["phase"]) => void,
): Promise<FinishInBrowserOutcome | null> {
  const { resultId } = input;
  const current = formOpenStates.get(resultId);
  if (current && "phase" in current) return Promise.resolve(null);
  setFormOpenState(resultId, { phase: "opening" });
  const settle = (outcome: FinishInBrowserOutcome | null) => {
    // A handler that reports nothing gets no status rather than a claim.
    setFormOpenState(resultId, outcome ? { outcome } : null);
    if (outcome?.kind === "opened_application_page") {
      // The page is focused, but the browser may be minimized: show it.
      void window.nestor?.browser?.command({ type: "open" });
    }
    return outcome;
  };
  const fail = (error: unknown) =>
    settle({ kind: "failed", reason: getFinishInBrowserFailureReason(error) });
  let returned: ReturnType<FinishInBrowserHandler>;
  try {
    returned = handler(input, (phase) => {
      setFormOpenState(resultId, { phase });
      onReopenProgress?.(phase);
    });
  } catch (error) {
    return Promise.resolve(fail(error));
  }
  if (isOutcomePromise(returned)) {
    return returned.then((outcome) => settle(outcome ?? null), fail);
  }
  // A synchronous outcome is written at once.
  return Promise.resolve(settle(returned ?? null));
}

/** The one sentence each outcome earns, wherever the form was opened from. */
export function describeFormOpenOutcome(
  outcome: FinishInBrowserOutcome,
  options: { readyToSend: boolean; continuesOnItsOwn?: boolean },
): string {
  if (outcome.kind === "failed" && outcome.reason === REOPEN_FAILED_REASON) {
    return `${REOPEN_FAILED_REASON}. Nothing was sent.`;
  }
  if (outcome.kind === "opened_application_page") {
    if (options.continuesOnItsOwn) return APPLICATION_SIGN_IN_CONTINUES_NOTE;
    return options.readyToSend
      ? READY_PAGE_OPENED_STATUS
      : JOB_FINDER_BROWSER_OPENED_STATUS;
  }
  if (outcome.kind === "opened_browser_only") {
    return JOB_FINDER_BROWSER_OPENED_WITHOUT_PAGE_STATUS;
  }
  return formatJobFinderBrowserHandoffFailedStatus(outcome.reason);
}

/** The one form control an Applications row offers, if any. */
export type RowFormAction =
  | { kind: "open"; label: string }
  | { kind: "prepare"; label: string };

export const OPEN_FORM_ROW_ACTION = "Open form";

/**
 * A row offers the form itself: Open form while a filled-in form waits on the
 * person, or the state's own run-again label (Prepare again or Try again;
 * Apply again in Send for me) once that form is gone or the run failed in a
 * way a fresh run can change. A run the person stopped keeps its action in
 * the detail panel, like every other state.
 */
export function resolveRowFormAction(input: {
  result: Pick<
    JobFinderRendererWorkspaceSnapshot["applyJobResults"][number],
    "state"
  >;
  applyState: Pick<
    ApplyStatePresentation,
    "kind" | "action" | "actionLabel" | "formClosed" | "cancelledByPerson"
  >;
  canOpen: boolean;
  canPrepare: boolean;
}): RowFormAction | null {
  const { applyState } = input;
  if (
    applyState.action === "try_again" &&
    (applyState.formClosed ||
      (applyState.kind === "could_not_apply" && !applyState.cancelledByPerson))
  ) {
    return input.canPrepare && applyState.actionLabel
      ? { kind: "prepare", label: applyState.actionLabel }
      : null;
  }
  if (
    input.result.state === "awaiting_review" &&
    applyState.action === "open_browser" &&
    input.canOpen
  ) {
    return { kind: "open", label: OPEN_FORM_ROW_ACTION };
  }
  return null;
}
