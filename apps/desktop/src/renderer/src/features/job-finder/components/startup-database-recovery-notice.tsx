import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@renderer/components/ui/button";
import { useBottomRightDock } from "./bounded-floating-surface";
import { BOTTOM_RIGHT_DOCK_ORDER } from "../lib/bounded-floating-surface";
import {
  JOB_FINDER_STARTUP_DATABASE_RECOVERY_RESTORED_DETAIL,
  JOB_FINDER_STARTUP_DATABASE_RECOVERY_RESTORED_MESSAGE,
  isJobFinderStartupDatabaseRecoveryFact,
  type JobFinderStartupDatabaseRecoveryRestoredFact,
} from "../../../../../shared/job-finder-startup-db-recovery";

/**
 * How far the dock may be lifted before it would reach the shell header. The
 * notice measures no header of its own; the launcher pill supplies the real
 * value and the dock takes the highest registered offset.
 */
const RECOVERY_NOTICE_MIN_TOP_OFFSET_PX = 112;

export function StartupDatabaseRecoveryNotice() {
  const [restoredFact, setRestoredFact] =
    useState<JobFinderStartupDatabaseRecoveryRestoredFact | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const [size, setSize] = useState({ height: 0, width: 0 });
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const isVisible = Boolean(restoredFact) && !isDismissed;

  const measure = useCallback(() => {
    const element = noticeRef.current;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    setSize((current) =>
      current.height === Math.ceil(rect.height) &&
      current.width === Math.ceil(rect.width)
        ? current
        : { height: Math.ceil(rect.height), width: Math.ceil(rect.width) },
    );
  }, []);

  useLayoutEffect(() => {
    if (!isVisible) {
      setSize({ height: 0, width: 0 });
      return undefined;
    }

    measure();
    const element = noticeRef.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [isVisible, measure]);

  // The notice used to be `fixed bottom-4 right-4`, which is exactly where the
  // Assistant/Copilot launcher parks — it simply painted on top of it. It now
  // takes a slot in the shared dock and stacks above the launcher instead.
  const dock = useBottomRightDock({
    active: isVisible,
    height: size.height,
    id: "startup-database-recovery-notice",
    minTopOffset: RECOVERY_NOTICE_MIN_TOP_OFFSET_PX,
    order: BOTTOM_RIGHT_DOCK_ORDER.notice,
    width: size.width,
  });

  useEffect(() => {
    let cancelled = false;

    try {
      const recoveryBridge =
        window.nestor?.jobFinder?.getStartupDatabaseRecovery;
      recoveryBridge?.()
        .then((recoveryFact) => {
          if (
            !cancelled &&
            isJobFinderStartupDatabaseRecoveryFact(recoveryFact) &&
            recoveryFact.status === "restored" &&
            recoveryFact.dismissedAtIso === null
          ) {
            setRestoredFact(recoveryFact);
          }
        })
        .catch(() => {
          // Stay hidden when the desktop bridge is unavailable.
        });
    } catch {
      // Stay hidden when the desktop bridge is unavailable.
    }

    return () => {
      cancelled = true;
    };
  }, []);

  if (!restoredFact || isDismissed) {
    return null;
  }

  function dismissNotice() {
    setIsDismissed(true);
    try {
      const dismissBridge =
        window.nestor?.jobFinder?.dismissStartupDatabaseRecoveryNotice;
      void dismissBridge?.().catch(() => undefined);
    } catch {
      // Keep the in-memory dismissal when the desktop bridge is unavailable.
    }
  }

  return (
    <div
      aria-live="polite"
      className="surface-card-tint fixed z-40 grid max-w-sm gap-2 rounded-(--radius-panel) border border-border/30 px-5 py-4 shadow-(--modal-shadow)"
      data-startup-database-recovery-notice
      ref={noticeRef}
      role="status"
      style={{
        // Before the first measurement the dock has no slot for this surface;
        // the shared inset is the same corner it would resolve to.
        bottom: `${dock.bottom ?? 16}px`,
        right: `${dock.right}px`,
      }}
    >
      <p className="text-(length:--text-tiny) uppercase tracking-[0.18em] text-muted-foreground">
        Workspace recovery
      </p>
      <p className="text-sm font-medium text-foreground">
        {JOB_FINDER_STARTUP_DATABASE_RECOVERY_RESTORED_MESSAGE}
      </p>
      <p className="text-sm text-foreground-soft">
        {JOB_FINDER_STARTUP_DATABASE_RECOVERY_RESTORED_DETAIL}
      </p>
      <div className="flex items-center justify-end">
        <Button
          aria-label="Dismiss workspace recovery message"
          className="text-xs font-medium normal-case tracking-normal"
          onClick={dismissNotice}
          size="sm"
          type="button"
          variant="ghost"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
