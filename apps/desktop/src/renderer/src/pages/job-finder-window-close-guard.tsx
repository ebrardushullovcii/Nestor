import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { JobFinderLeaveConfirmation } from "./use-job-finder-page-controller";
import { JobFinderUnsavedChangesDialog } from "./job-finder-unsaved-changes-dialog";
import {
  hasOpenJobFinderOverlays,
  subscribeToJobFinderOverlays,
} from "../features/job-finder/lib/job-finder-overlay-ownership";

/**
 * Renderer side of the app-owned window-close handshake.
 *
 * Ownership stays renderer-owned: the Job Finder page controller mirrors its
 * composed leave confirmation here whenever dirty Profile/setup/Resume Studio
 * state or a save-in-flight/failed state changes. Main caches only the
 * boolean so a native close can be paused; this component answers each typed
 * close request by either proceeding immediately (nothing unsaved) or showing
 * the same branded unsaved-changes dialog used for route navigation. It never
 * touches Electron primitives beyond the typed preload bridge.
 */

let mirroredConfirmation: JobFinderLeaveConfirmation | null = null;

export function getJobFinderWindowCloseConfirmation(): JobFinderLeaveConfirmation | null {
  return mirroredConfirmation;
}

/**
 * Mirror the latest composed leave confirmation to the main process. Only a
 * blocked/not-blocked transition crosses IPC; main never receives draft or
 * editor content, just the boolean it needs to pause a native close.
 */
export function applyJobFinderWindowCloseGuard(
  confirmation: JobFinderLeaveConfirmation | null,
): void {
  const wasBlocked = mirroredConfirmation !== null;
  mirroredConfirmation = confirmation;

  if (wasBlocked === (confirmation !== null)) {
    return;
  }

  try {
    void window.nestor.window.setCloseGuardState({
      blocked: confirmation !== null,
    });
  } catch {
    // Renderer tests run without the preload bridge; protection state is
    // meaningless there because no native window can close.
  }
}

/**
 * At most one close decision is outstanding at a time. While another owned
 * overlay (route blocker, resume-studio action dialog, shell menus) holds the
 * LIFO stack, a blocked close request waits as `deferred` instead of stacking
 * a second branded dialog over an active one; the promotion effect re-runs
 * once the stack settles.
 */
type HeldCloseRequest =
  | { kind: "idle" }
  | { kind: "deferred"; requestId: string }
  | {
      kind: "parked";
      requestId: string;
      confirmation: JobFinderLeaveConfirmation;
    };

type CloseDecision = "proceed" | "cancel";

function sendCloseResolution(
  requestId: string,
  decision: CloseDecision,
): void {
  try {
    void window.nestor.window
      .resolveCloseRequest({ requestId, decision })
      .catch(() => {
        // The native window may already be gone; the main-process watchdog
        // owns the outcome of an undeliverable resolution.
      });
  } catch {
    // Bridge unavailable (tests) — nothing to resolve against.
  }
}

export function JobFinderWindowCloseGuard() {
  const [held, setHeld] = useState<HeldCloseRequest>({ kind: "idle" });
  // Synchronous mirror of `held`: handlers fire before React commits, so
  // double clicks and racing requests must read the freshest state.
  const heldRef = useRef<HeldCloseRequest>(held);
  const transitionHeld = useCallback((next: HeldCloseRequest) => {
    heldRef.current = next;
    setHeld(next);
  }, []);

  // Reactive signal from the shared LIFO overlay ownership stack.
  const overlaysOpen = useSyncExternalStore(
    subscribeToJobFinderOverlays,
    hasOpenJobFinderOverlays,
    hasOpenJobFinderOverlays,
  );

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    try {
      unsubscribe = window.nestor.window.onCloseRequest((request) => {
        if (heldRef.current.kind !== "idle") {
          // Main keeps one close request outstanding; a duplicate must never
          // overwrite the held decision or resolve twice.
          return;
        }

        // Answer from the latest mirrored guard state: clean sessions close
        // immediately; dirty ones wait for the dialog below.
        const confirmation = getJobFinderWindowCloseConfirmation();

        if (!confirmation) {
          sendCloseResolution(request.requestId, "proceed");
          return;
        }

        transitionHeld(
          hasOpenJobFinderOverlays()
            ? { kind: "deferred", requestId: request.requestId }
            : {
                kind: "parked",
                requestId: request.requestId,
                confirmation,
              },
        );
      });
    } catch {
      // Bridge unavailable (tests) — no native window can request a close.
    }

    return () => {
      unsubscribe?.();
    };
  }, [transitionHeld]);

  useEffect(() => {
    if (held.kind !== "deferred" || overlaysOpen) {
      return;
    }

    // Re-evaluate after the active overlay settles: the racing decision may
    // have been saved while this request waited.
    const confirmation = getJobFinderWindowCloseConfirmation();

    if (!confirmation) {
      transitionHeld({ kind: "idle" });
      sendCloseResolution(held.requestId, "proceed");
      return;
    }

    transitionHeld({
      kind: "parked",
      requestId: held.requestId,
      confirmation,
    });
  }, [held, overlaysOpen, transitionHeld]);

  // Leaving this page releases any unanswered handshake so main never waits
  // on a responder that no longer exists.
  useEffect(() => {
    return () => {
      const outstanding = heldRef.current;
      if (outstanding.kind !== "idle") {
        sendCloseResolution(outstanding.requestId, "cancel");
      }
    };
  }, []);

  const resolveParked = useCallback(
    (decision: CloseDecision) => {
      const outstanding = heldRef.current;

      if (outstanding.kind !== "parked") {
        return;
      }

      // Clearing before resolving keeps a second click, a late Escape, or a
      // duplicated request from resolving the same id twice.
      transitionHeld({ kind: "idle" });
      sendCloseResolution(outstanding.requestId, decision);
    },
    [transitionHeld],
  );

  if (held.kind !== "parked") {
    return null;
  }

  return (
    <JobFinderUnsavedChangesDialog
      confirmation={{
        title: "Close Nestor?",
        description: "Your unsaved changes will be lost.",
        reasons: held.confirmation.reasons,
      }}
      onLeaveWithoutSaving={() => resolveParked("proceed")}
      onStay={() => resolveParked("cancel")}
    />
  );
}
