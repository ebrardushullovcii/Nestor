import type {
  DesktopWindowCloseRequest,
  DesktopWindowCloseResolution,
} from "@nestor/contracts";

/**
 * How long a paused close waits for the renderer's dialog resolution before
 * the bounded watchdog ends the wait. The expiry outcome is chosen by the
 * entry path: a plain window close stays open (fail-closed for data), while
 * an app-level quit proceeds (fail-open so a hung renderer can never wedge
 * shutdown; forced process termination remains uninterceptable by design).
 */
export const DEFAULT_MAIN_WINDOW_CLOSE_WATCHDOG_MS = 60_000;

/** IPC channel for outbound close requests aimed at the guarded renderer. */
export const MAIN_WINDOW_CLOSE_REQUEST_CHANNEL = "window:close-requested";

/**
 * Narrow structural slice of Electron's WebContents used for close-request
 * delivery. The exact guarded instance is captured by `attachMainWindow`, so
 * outbound requests are always addressed to that renderer and never resolved
 * by window enumeration order (overlay/popup windows can never receive them).
 */
export interface MainWindowCloseTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: DesktopWindowCloseRequest): void;
}

type CloseDecisionOutcome = "proceed" | "cancel";
type CloseDecisionPath = "window-close" | "app-quit";

/**
 * Policy for ending a decision without its renderer's answer, shared by the
 * watchdog and by forced settlements (dispose, re-attach, protection cleared
 * mid-decision): a plain close fails closed, an app-level quit fails open so
 * shutdown can never be wedged by a decision whose owner is gone.
 */
const PATH_SETTLEMENT_OUTCOME: Record<CloseDecisionPath, CloseDecisionOutcome> =
  {
    "window-close": "cancel",
    "app-quit": "proceed",
  };

/**
 * A discard approval is a single-use token, not a loose boolean: it
 * authorizes exactly the next native close attempt inside the same
 * attached-window/document generation, and it is invalidated by renderer
 * crash, document reload/navigation, re-attach, or a fresh dirty mirror so
 * stale consent can never bypass new unsaved work.
 */
interface CloseApprovalToken {
  generation: number;
  requestId: string | null;
}

interface PendingCloseDecision {
  request: DesktopWindowCloseRequest;
  path: CloseDecisionPath;
  resolve: (outcome: CloseDecisionOutcome) => void;
  watchdogId: ReturnType<typeof setTimeout>;
}

export interface MainWindowCloseGuardOptions {
  /**
   * Transport for one close request aimed at exactly one renderer. The guard
   * resolves the attached guarded target itself and skips destroyed or
   * replaced targets, so implementations only perform the channel send.
   */
  sendCloseRequest: (
    target: MainWindowCloseTarget,
    request: DesktopWindowCloseRequest,
  ) => void;
  watchdogTimeoutMs?: number;
}

export interface MainWindowCloseGuard {
  /**
   * Register the single guarded main window and reset any state left by a
   * previous window (macOS activate recreates the window after close). The
   * captured webContents becomes the only outbound close-request destination.
   * Any decision still pending from the previous window settles first with
   * its path policy (plain close cancels; quit proceeds) so no awaiting
   * caller is ever orphaned, and any unconsumed close approval is dropped.
   */
  attachMainWindow(target: MainWindowCloseTarget): void;

  /**
   * Fail-closed sender check for close-guard IPC: only the guarded main
   * window may mirror guard state or resolve close requests, so an overlay
   * or popup renderer can never forge or clear protection.
   */
  isOwnedBy(webContentsId: number): boolean;

  /**
   * Evaluate a native window close event. Atomically consumes a pending
   * discard approval (authorizing exactly this attempt) or prevents default
   * while protection is active.
   */
  handleWindowClose(event: { preventDefault(): void }): void;

  /** Route a typed renderer resolution to the pending decision. Returns false when stale. */
  deliverResolution(resolution: DesktopWindowCloseResolution): boolean;

  /** Mirror of the renderer-owned dirty flag pushed via `window:set-close-guard-state`. */
  setRendererGuardBlocked(blocked: boolean): void;

  /** The renderer can no longer answer (crashed or destroyed); drop protection. */
  markRendererUnavailable(): void;

  /**
   * Invalidate a not-yet-consumed discard approval. Must be called whenever
   * the guarded document starts (re)loading — recovery reloads included —
   * because the document that granted the consent is going away and fresh
   * dirty state must prompt anew.
   */
  invalidateCloseApproval(): void;

  /**
   * Whether an app-level quit still needs renderer confirmation first.
   * False when nothing is dirty, the renderer is gone, or the user already
   * approved discarding drafts.
   */
  needsQuitConfirmation(): boolean;

  /**
   * Ask once whether dirty work may be discarded before quit. Resolves true
   * to continue quitting and false to abort while services are still intact.
   * A watchdog expiry proceeds so shutdown can never deadlock; cancelling
   * aborts the quit before any service shutdown has started. Forced
   * settlement (dispose or re-attach mid-decision) also proceeds fail-open
   * so the quit chain always resolves.
   */
  confirmQuit(): Promise<boolean>;

  /**
   * Tear down the guard. Any pending decision settles first with its path
   * policy (never orphaning an awaiting caller), then timers and cached
   * protection are dropped. The guard stays disposed permanently.
   */
  dispose(): void;
}

export function createMainWindowCloseGuard(
  options: MainWindowCloseGuardOptions,
): MainWindowCloseGuard {
  const watchdogTimeoutMs =
    options.watchdogTimeoutMs ?? DEFAULT_MAIN_WINDOW_CLOSE_WATCHDOG_MS;

  let ownerWebContentsId: number | null = null;
  let ownerTarget: MainWindowCloseTarget | null = null;
  let rendererBlocked = false;
  let disposed = false;
  let pending: PendingCloseDecision | null = null;
  let closeApproval: CloseApprovalToken | null = null;
  // Bumped whenever the guarded window/document context is replaced (attach,
  // dispose) so an approval minted for one context can never authorize a
  // close belonging to another.
  let attachGeneration = 0;

  const clearPending = () => {
    if (!pending) {
      return;
    }
    clearTimeout(pending.watchdogId);
    pending = null;
  };

  /**
   * Settle an in-flight decision with its entry-path policy BEFORE state is
   * torn down, then drop the watchdog. Resolving (never rejecting or leaking
   * a forever-pending promise) keeps confirmQuit callers alive across dispose
   * and re-attach.
   */
  const settlePendingByPathPolicy = (): boolean => {
    if (!pending) {
      return false;
    }
    const settled = pending;
    clearTimeout(settled.watchdogId);
    pending = null;
    settled.resolve(PATH_SETTLEMENT_OUTCOME[settled.path]);
    return true;
  };

  const deliverCloseRequest = (request: DesktopWindowCloseRequest) => {
    const target = ownerTarget;
    if (!target || disposed || target.id !== ownerWebContentsId) {
      return;
    }
    // A destroyed or replaced renderer cannot answer; the decision stays
    // armed and its path policy decides the outcome instead.
    if (target.isDestroyed()) {
      return;
    }
    try {
      options.sendCloseRequest(target, request);
    } catch {
      // Losing a destruction race between the check above and the send must
      // never throw into the native close path.
    }
  };

  const beginDecision = (
    path: CloseDecisionPath,
  ): { outcome: Promise<CloseDecisionOutcome>; requestId: string } => {
    const request: DesktopWindowCloseRequest = {
      requestId: `window_close_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    };
    let resolveOutcome: PendingCloseDecision["resolve"] = () => {};
    const outcomePromise = new Promise<CloseDecisionOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const watchdogId = setTimeout(() => {
      if (pending?.request.requestId === request.requestId) {
        pending = null;
      }
      resolveOutcome(PATH_SETTLEMENT_OUTCOME[path]);
    }, watchdogTimeoutMs);
    pending = { request, path, resolve: resolveOutcome, watchdogId };
    deliverCloseRequest(request);
    return { outcome: outcomePromise, requestId: request.requestId };
  };

  /**
   * Arm the single-use close approval for the CURRENT window/document
   * generation. It is consumed atomically by the immediately following
   * native close attempt; every context switch invalidates it.
   */
  const confirmProceed = (requestId: string | null) => {
    closeApproval = { generation: attachGeneration, requestId };
    rendererBlocked = false;
  };

  return {
    attachMainWindow(target) {
      // Settle any decision owned by the previous window first: replacing
      // the window mid-close cancels the stale question, replacing it
      // mid-quit resolves the quit chain fail-open instead of orphaning it.
      settlePendingByPathPolicy();
      attachGeneration += 1;
      ownerTarget = target;
      ownerWebContentsId = target.id;
      rendererBlocked = false;
      closeApproval = null;
    },

    isOwnedBy(webContentsId: number) {
      return !disposed && ownerWebContentsId === webContentsId;
    },

    handleWindowClose(event) {
      // Atomic single-use consumption: the approval, if any, authorizes
      // exactly this native close attempt and nothing else. Stale or
      // foreign-generation tokens are dropped without granting passage.
      const approval = closeApproval;
      closeApproval = null;
      if (approval && !disposed && approval.generation === attachGeneration) {
        return;
      }

      if (!rendererBlocked || disposed) {
        return;
      }

      // A plain window close is always cancellable: pause it and keep the
      // window open unless the renderer explicitly confirms discarding.
      event.preventDefault();

      if (pending) {
        return;
      }

      void beginDecision("window-close").outcome;
    },

    deliverResolution(resolution) {
      if (disposed) {
        return false;
      }

      if (pending && pending.request.requestId === resolution.requestId) {
        const { resolve } = pending;
        clearPending();
        resolve(resolution.decision);

        if (resolution.decision === "proceed") {
          confirmProceed(resolution.requestId);
        }

        return true;
      }

      // A racing save may have cleared protection between the dialog opening
      // and the user confirming; an unmatched proceed is still an explicit
      // approval to close, so honor it instead of stranding the window. A
      // mismatched id while another decision is pending stays ignored.
      if (!pending && resolution.decision === "proceed") {
        confirmProceed(resolution.requestId);
      }

      return false;
    },

    setRendererGuardBlocked(blocked) {
      if (disposed) {
        return;
      }
      if (blocked) {
        // Fresh dirty mirror state outranks any lingering approval: consent
        // minted before these edits must never bypass them.
        closeApproval = null;
      }
      rendererBlocked = blocked;
      if (!blocked) {
        // A racing save disarmed protection mid-decision. Settle with the
        // path policy instead of orphaning the promise: saved work makes
        // proceeding safe on the quit path, and the plain-close path simply
        // cancels its stale question.
        settlePendingByPathPolicy();
      }
    },

    markRendererUnavailable() {
      rendererBlocked = false;
      // The deciding document is gone: an unconsumed approval must die with
      // it so recovery and a fresh dirty mirror prompt anew. The pending
      // decision still settles confirmed (no wedge; lifecycle owns restart).
      closeApproval = null;
      if (pending) {
        const { resolve } = pending;
        clearPending();
        resolve("proceed");
      }
    },

    invalidateCloseApproval() {
      closeApproval = null;
    },

    needsQuitConfirmation() {
      return !disposed && rendererBlocked;
    },

    confirmQuit() {
      if (!rendererBlocked || disposed) {
        return Promise.resolve(true);
      }

      // A plain-close dialog is already open; let its outcome govern instead
      // of racing a second question into the same renderer.
      if (pending) {
        return Promise.resolve(false);
      }

      const askGeneration = attachGeneration;
      const begun = beginDecision("app-quit");
      return begun.outcome.then((outcome) => {
        if (outcome === "proceed") {
          if (askGeneration === attachGeneration) {
            confirmProceed(begun.requestId);
          }
          return true;
        }
        return false;
      });
    },

    dispose() {
      // Mirror the watchdog policies so an awaited confirmQuit always
      // resolves before teardown clears state: plain close cancels, quit
      // proceeds fail-open.
      settlePendingByPathPolicy();
      attachGeneration += 1;
      closeApproval = null;
      disposed = true;
      rendererBlocked = false;
      ownerTarget = null;
    },
  };
}

let singletonGuard: MainWindowCloseGuard | null = null;

/**
 * Process-wide guard for the single guarded main window. A scoped singleton
 * keeps `routes/window.ts` and `index.ts` wiring signature-stable while the
 * window instance is recreated across macOS activate cycles. Outbound close
 * requests are delivered to the webContents captured by `attachMainWindow`,
 * never to window-enumeration order.
 */
export function getMainWindowCloseGuard(): MainWindowCloseGuard {
  singletonGuard ??= createMainWindowCloseGuard({
    sendCloseRequest: (target, request) => {
      target.send(MAIN_WINDOW_CLOSE_REQUEST_CHANNEL, request);
    },
  });
  return singletonGuard;
}
