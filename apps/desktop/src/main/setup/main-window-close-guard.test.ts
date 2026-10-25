import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createMainWindowCloseGuard,
  DEFAULT_MAIN_WINDOW_CLOSE_WATCHDOG_MS,
  MAIN_WINDOW_CLOSE_REQUEST_CHANNEL,
  type MainWindowCloseTarget,
} from "./main-window-close-guard";

interface SentRequest {
  targetId: number;
  channel: string;
  request: { requestId: string };
}

function createTarget(id: number, sentLog: SentRequest[]) {
  const state = { destroyed: false, sendError: null as Error | null };
  const directSends: Array<{ channel: string; request: { requestId: string } }> =
    [];
  const target: MainWindowCloseTarget = {
    id,
    isDestroyed: () => state.destroyed,
    send: (channel, request) => {
      if (state.sendError) {
        throw state.sendError;
      }
      directSends.push({ channel, request });
      sentLog.push({ targetId: id, channel, request });
    },
  };

  return {
    id,
    target,
    directSends,
    destroy() {
      state.destroyed = true;
    },
    failSendWith(error: Error) {
      state.sendError = error;
    },
  };
}

function createHarness(options?: { watchdogTimeoutMs?: number }) {
  const watchdogTimeoutMs = options?.watchdogTimeoutMs;
  const guard = createMainWindowCloseGuard({
    sendCloseRequest: (target, request) => {
      target.send(MAIN_WINDOW_CLOSE_REQUEST_CHANNEL, request);
    },
    ...(watchdogTimeoutMs === undefined
      ? {}
      : { watchdogTimeoutMs }),
  });
  const sentRequests: SentRequest[] = [];
  let current: ReturnType<typeof createTarget> | null = null;

  return {
    guard,
    sentRequests,
    attach(id = 1) {
      const created = createTarget(id, sentRequests);
      guard.attachMainWindow(created.target);
      current = created;
      return created;
    },
    attached() {
      return current;
    },
    close() {
      const event = { preventDefault: vi.fn() };
      guard.handleWindowClose(event);
      return event.preventDefault;
    },
    resolve(requestId: string, decision: "proceed" | "cancel") {
      return guard.deliverResolution({ requestId, decision });
    },
    lastRequestId() {
      const entry = sentRequests[sentRequests.length - 1];
      if (!entry) {
        throw new Error("no close request was sent");
      }
      return entry.request.requestId;
    },
  };
}

describe("main window close guard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("allows a native close without asking when nothing is unsaved", () => {
    const harness = createHarness();
    harness.attach();

    const preventDefault = harness.close();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(harness.sentRequests).toHaveLength(0);
  });

  test("pauses a close once and asks the renderer when protection is mirrored", () => {
    const harness = createHarness();
    harness.attach();
    harness.guard.setRendererGuardBlocked(true);

    const firstPreventDefault = harness.close();
    const secondPreventDefault = harness.close();

    expect(firstPreventDefault).toHaveBeenCalled();
    expect(secondPreventDefault).toHaveBeenCalled();
    // A second close press must not race a second question into the dialog.
    expect(harness.sentRequests).toHaveLength(1);
  });

  test("closes on proceed, consumes the approval exactly once, and stops protecting", () => {
    const harness = createHarness();
    harness.attach();
    harness.guard.setRendererGuardBlocked(true);

    harness.close();
    expect(harness.resolve(harness.lastRequestId(), "proceed")).toBe(true);
    expect(harness.guard.needsQuitConfirmation()).toBe(false);

    const approvedClose = harness.close();
    expect(approvedClose).not.toHaveBeenCalled();

    // The approval is single-use: fresh protection blocks again.
    harness.guard.setRendererGuardBlocked(true);
    expect(harness.close()).toHaveBeenCalled();
  });

  test("keeps the window open on cancel and ignores stale resolutions", () => {
    const harness = createHarness();
    harness.attach();
    harness.guard.setRendererGuardBlocked(true);

    harness.close();
    expect(harness.resolve("stale-request-id", "proceed")).toBe(false);
    expect(harness.resolve(harness.lastRequestId(), "cancel")).toBe(true);
    expect(harness.guard.needsQuitConfirmation()).toBe(true);

    // Staying keeps protection armed: the next close asks again.
    expect(harness.close()).toHaveBeenCalled();
    expect(harness.sentRequests).toHaveLength(2);
  });

  test("honors a late proceed resolution whose protection was cleared by a racing save", () => {
    const harness = createHarness();
    harness.attach();
    harness.guard.setRendererGuardBlocked(true);

    harness.close();
    const requestId = harness.lastRequestId();
    // The save completes while the dialog is open and protection lapses.
    harness.guard.setRendererGuardBlocked(false);

    expect(harness.resolve(requestId, "proceed")).toBe(false);
    expect(harness.guard.needsQuitConfirmation()).toBe(false);

    // The explicit discard still owns the confirmed close.
    expect(harness.close()).not.toHaveBeenCalled();
  });

  test("settles an interrupted decision when the renderer dies without arming an approval", () => {
    const harness = createHarness();
    harness.attach();
    harness.guard.setRendererGuardBlocked(true);

    harness.close();
    const requestId = harness.lastRequestId();
    harness.guard.markRendererUnavailable();

    expect(harness.guard.needsQuitConfirmation()).toBe(false);
    // No wedge: with protection dropped, a native close passes untouched.
    expect(harness.close()).not.toHaveBeenCalled();
    // The interrupted decision must not leave consent behind: after recovery
    // mirrors fresh dirty state, the first close prompts again.
    harness.guard.setRendererGuardBlocked(true);
    expect(harness.close()).toHaveBeenCalled();
    expect(harness.lastRequestId()).not.toBe(requestId);
  });

  test("clears pending decisions when the mirror reports the work was saved", () => {
    const harness = createHarness();
    harness.attach();
    harness.guard.setRendererGuardBlocked(true);

    harness.close();
    harness.guard.setRendererGuardBlocked(false);
    harness.guard.setRendererGuardBlocked(true);

    expect(harness.sentRequests).toHaveLength(1);
  });

  describe("guarded close-request targeting", () => {
    test("delivers requests only to the attached guarded renderer", () => {
      const harness = createHarness();
      const other = createTarget(999, harness.sentRequests);
      harness.attach(101);
      harness.guard.setRendererGuardBlocked(true);

      harness.close();

      expect(harness.attached()?.directSends).toHaveLength(1);
      expect(harness.attached()?.directSends[0]?.channel).toBe(
        MAIN_WINDOW_CLOSE_REQUEST_CHANNEL,
      );
      // A second window (overlay/popup ordering) never receives the question.
      expect(other.directSends).toHaveLength(0);
    });

    test("rebinds delivery when the window is recreated and re-attached", () => {
      const harness = createHarness();
      const first = harness.attach(101);

      // macOS activate recreates the window; the singleton guard re-attaches.
      const replacement = harness.attach(303);
      harness.guard.setRendererGuardBlocked(true);
      harness.close();

      expect(first.directSends).toHaveLength(0);
      expect(replacement.directSends).toHaveLength(1);
      expect(harness.sentRequests[0]?.targetId).toBe(303);
    });

    test("skips delivery safely when the guarded renderer was destroyed", async () => {
      const harness = createHarness();
      const attached = harness.attach(1);
      attached.destroy();

      harness.guard.setRendererGuardBlocked(true);
      expect(() => harness.close()).not.toThrow();
      expect(attached.directSends).toHaveLength(0);

      // The question is still pending internally: an app-level quit defers
      // to it instead of racing a second dialog into a dead renderer, and
      // the watchdog ends it per the plain-close policy.
      await expect(harness.guard.confirmQuit()).resolves.toBe(false);
    });

    test("contains send failures from a lost destruction race", () => {
      const harness = createHarness();
      const attached = harness.attach(1);
      attached.failSendWith(new Error("Object has been destroyed"));

      harness.guard.setRendererGuardBlocked(true);
      const preventDefault = harness.close();

      expect(preventDefault).toHaveBeenCalled();
      expect(attached.directSends).toHaveLength(0);
      expect(harness.guard.needsQuitConfirmation()).toBe(true);
    });

    test("a quit confirmation still fails open when delivery is impossible", async () => {
      vi.useFakeTimers();
      const harness = createHarness();
      const attached = harness.attach(1);
      attached.destroy();

      harness.guard.setRendererGuardBlocked(true);
      const quitPromise = harness.guard.confirmQuit();
      await vi.advanceTimersByTimeAsync(DEFAULT_MAIN_WINDOW_CLOSE_WATCHDOG_MS);

      await expect(quitPromise).resolves.toBe(true);
    });
  });

  describe("close approval lifetime", () => {
    test("an immediate proceed approves exactly the next native close, once", () => {
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      harness.close();
      expect(harness.resolve(harness.lastRequestId(), "proceed")).toBe(true);

      // The immediately following native close attempt is authorized...
      const approvedClose = harness.close();
      expect(approvedClose).not.toHaveBeenCalled();

      // ...and exactly once: fresh protection prompts again.
      harness.guard.setRendererGuardBlocked(true);
      expect(harness.close()).toHaveBeenCalled();
    });

    test("a stale approval never bypasses dirty state after renderer recovery without window destruction", () => {
      const harness = createHarness();
      harness.attach(1);
      harness.guard.setRendererGuardBlocked(true);

      // Pending dirty close: question asked, user discards.
      harness.close();
      expect(harness.resolve(harness.lastRequestId(), "proceed")).toBe(true);

      // Renderer goes away and recovers (crash -> reload) WITHOUT destroying
      // the window or re-attaching a new one.
      harness.guard.markRendererUnavailable();

      // The recovered document mirrors brand-new unsaved work.
      harness.guard.setRendererGuardBlocked(true);

      // First close must prompt again; the pre-crash token must not close.
      const prevented = harness.close();
      expect(prevented).toHaveBeenCalled();
      expect(harness.sentRequests).toHaveLength(2);
    });

    test("document load invalidation stops an unconsumed approval", () => {
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      harness.close();
      expect(harness.resolve(harness.lastRequestId(), "proceed")).toBe(true);
      harness.guard.invalidateCloseApproval();

      harness.guard.setRendererGuardBlocked(true);
      expect(harness.close()).toHaveBeenCalled();
      expect(harness.sentRequests).toHaveLength(2);
    });

    test("fresh dirty mirror state invalidates an unconsumed approval", () => {
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      harness.close();
      expect(harness.resolve(harness.lastRequestId(), "proceed")).toBe(true);

      // New dirty state arrives before any close attempt consumed the token.
      harness.guard.setRendererGuardBlocked(true);
      const prevented = harness.close();
      expect(prevented).toHaveBeenCalled();
      expect(harness.sentRequests).toHaveLength(2);
    });

    test("re-attachment invalidates the previous window's approval", () => {
      const harness = createHarness();
      harness.attach(1);
      harness.guard.setRendererGuardBlocked(true);

      harness.close();
      expect(harness.resolve(harness.lastRequestId(), "proceed")).toBe(true);

      // macOS recreate attaches a new window generation before the old
      // approval was ever consumed.
      harness.attach(2);
      harness.guard.setRendererGuardBlocked(true);

      const prevented = harness.close();
      expect(prevented).toHaveBeenCalled();
      expect(harness.attached()?.directSends).toHaveLength(1);
    });
  });

  describe("forced settlement of pending decisions", () => {
    test("dispose resolves a pending quit as proceed so the quit chain never orphans", async () => {
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      const quitPromise = harness.guard.confirmQuit();
      harness.guard.dispose();

      await expect(quitPromise).resolves.toBe(true);
      expect(harness.guard.needsQuitConfirmation()).toBe(false);
    });

    test("dispose during a pending plain close leaves nothing dangling", () => {
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      harness.close();
      const requestId = harness.lastRequestId();
      harness.guard.dispose();

      // Disposed guards fail every ownership check, and the settled decision
      // can neither be resolved nor approve anything afterwards.
      expect(harness.guard.isOwnedBy(1)).toBe(false);
      expect(harness.resolve(requestId, "proceed")).toBe(false);
      expect(harness.guard.needsQuitConfirmation()).toBe(false);
    });

    test("re-attach during a pending quit settles it as proceed and starts clean", async () => {
      const harness = createHarness();
      const first = harness.attach(1);
      harness.guard.setRendererGuardBlocked(true);

      const quitPromise = harness.guard.confirmQuit();
      // macOS recreate while the quit question is outstanding: the previous
      // window's decision settles fail-open instead of orphaning the chain.
      const replacement = harness.attach(2);

      await expect(quitPromise).resolves.toBe(true);
      // The replacement window starts unprotected and asks anew when dirtied.
      expect(harness.guard.needsQuitConfirmation()).toBe(false);
      harness.guard.setRendererGuardBlocked(true);
      harness.close();
      // Window 1 only ever saw the original quit question; the fresh close
      // question goes to the replacement.
      expect(first.directSends).toHaveLength(1);
      expect(replacement.directSends).toHaveLength(1);
      expect(harness.sentRequests).toHaveLength(2);
      expect(harness.sentRequests[1]?.targetId).toBe(2);
    });

    test("re-attach during a pending plain close retires the stale question", () => {
      const harness = createHarness();
      const first = harness.attach(1);
      harness.guard.setRendererGuardBlocked(true);

      harness.close();
      const staleRequestId = harness.lastRequestId();

      harness.attach(2);
      // The stale question was settled by the re-attach: nothing matches it,
      // and its late cancel cannot disturb the fresh session either.
      expect(harness.resolve(staleRequestId, "cancel")).toBe(false);

      harness.guard.setRendererGuardBlocked(true);
      harness.close();

      const replacement = harness.attached();
      expect(first.directSends).toHaveLength(1);
      expect(replacement?.directSends).toHaveLength(1);
      expect(harness.lastRequestId()).not.toBe(staleRequestId);
    });

    test("a settled-away quit decision cannot arm the replacement window's close", async () => {
      const harness = createHarness();
      harness.attach(1);
      harness.guard.setRendererGuardBlocked(true);

      const quitPromise = harness.guard.confirmQuit();
      // Replacing the window settles the quit proceed (fail-open), but the
      // forced approval must not leak onto the recreated window: exactly-once
      // approval stays bound to the window that earned it.
      harness.attach(2);
      await expect(quitPromise).resolves.toBe(true);

      harness.guard.setRendererGuardBlocked(true);
      const preventDefault = harness.close();
      expect(preventDefault).toHaveBeenCalled();
    });

    test("a racing save settles the pending quit instead of leaving it dangling", async () => {
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      const quitPromise = harness.guard.confirmQuit();
      // The save completes while the quit question is open: nothing is dirty
      // anymore, so the path policy proceeds fail-open rather than wedging.
      harness.guard.setRendererGuardBlocked(false);

      await expect(quitPromise).resolves.toBe(true);
    });
  });

  describe("app-level quit confirmation", () => {
    test("proceeds immediately when nothing is unsaved", async () => {
      const harness = createHarness();
      harness.attach();

      await expect(harness.guard.confirmQuit()).resolves.toBe(true);
      expect(harness.sentRequests).toHaveLength(0);
    });

    test("aborts before service shutdown when the user cancels", async () => {
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      const quitPromise = harness.guard.confirmQuit();
      harness.resolve(harness.lastRequestId(), "cancel");

      await expect(quitPromise).resolves.toBe(false);
      // Cancelling keeps protecting this renderer session.
      expect(harness.guard.needsQuitConfirmation()).toBe(true);
    });

    test("approves the pending close when the user discards drafts", async () => {
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      const quitPromise = harness.guard.confirmQuit();
      harness.resolve(harness.lastRequestId(), "proceed");

      await expect(quitPromise).resolves.toBe(true);
      expect(harness.close()).not.toHaveBeenCalled();
    });

    test("fails open on watchdog expiry so shutdown cannot deadlock", async () => {
      vi.useFakeTimers();
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      const quitPromise = harness.guard.confirmQuit();
      vi.advanceTimersByTime(DEFAULT_MAIN_WINDOW_CLOSE_WATCHDOG_MS);

      await expect(quitPromise).resolves.toBe(true);
    });

    test("defers to an already open plain-close dialog instead of racing it", async () => {
      const harness = createHarness();
      harness.attach();
      harness.guard.setRendererGuardBlocked(true);

      harness.close();
      await expect(harness.guard.confirmQuit()).resolves.toBe(false);
      expect(harness.sentRequests).toHaveLength(1);
    });
  });
});
