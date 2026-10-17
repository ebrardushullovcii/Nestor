import { useEffect, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import {
  JOB_FINDER_STARTUP_RESET_RECOVERY_COMPLETED_DETAIL,
  JOB_FINDER_STARTUP_RESET_RECOVERY_COMPLETED_MESSAGE,
  buildJobFinderStartupResetRecoveryDegradedDetail,
  isJobFinderStartupResetRecoveryFact,
  type JobFinderStartupResetRecoveryFact,
} from "../../../../../shared/job-finder-startup-reset-recovery";

const BANNER_DISMISSED_STORAGE_KEY_PREFIX =
  "nestor.startup-reset-recovery-banner-dismissed-v1:";

function readBannerDismissed(dismissalKey: string): boolean {
  try {
    return (
      localStorage.getItem(
        `${BANNER_DISMISSED_STORAGE_KEY_PREFIX}${dismissalKey}`,
      ) === "1"
    );
  } catch {
    return false;
  }
}

function persistBannerDismissed(dismissalKey: string) {
  try {
    localStorage.setItem(
      `${BANNER_DISMISSED_STORAGE_KEY_PREFIX}${dismissalKey}`,
      "1",
    );
  } catch {
    // Keep the in-memory dismissal when persistent storage is unavailable.
  }
}

export function StartupResetRecoveryBanner() {
  const [fact, setFact] = useState<JobFinderStartupResetRecoveryFact | null>(
    null,
  );
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    let cancelled = false;

    try {
      const recoveryBridge =
        window.nestor?.jobFinder?.getStartupResetRecovery;
      recoveryBridge?.()
        .then((recoveryFact) => {
          if (!cancelled && isJobFinderStartupResetRecoveryFact(recoveryFact)) {
            setFact(recoveryFact);
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

  if (!fact || fact.status === "idle") {
    return null;
  }

  const dismissalKey =
    fact.status === "completed"
      ? `${fact.completedAt}:${fact.token}`
      : `${fact.reason}:${fact.quarantinedFileName ?? "none"}`;

  if (dismissedKeys.has(dismissalKey) || readBannerDismissed(dismissalKey)) {
    return null;
  }

  function dismissBanner() {
    persistBannerDismissed(dismissalKey);
    setDismissedKeys((current) => new Set(current).add(dismissalKey));
  }

  const heading =
    fact.status === "completed"
      ? JOB_FINDER_STARTUP_RESET_RECOVERY_COMPLETED_MESSAGE
      : "Workspace startup recovery needs attention";
  const detail =
    fact.status === "completed"
      ? JOB_FINDER_STARTUP_RESET_RECOVERY_COMPLETED_DETAIL
      : buildJobFinderStartupResetRecoveryDegradedDetail({
          reason: fact.reason,
          quarantinedFileName: fact.quarantinedFileName,
        });

  return (
    <div
      aria-live="polite"
      className="surface-card-tint mb-3 flex flex-col gap-3 rounded-(--radius-panel) border border-border/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
      data-startup-reset-recovery-banner
      role="status"
    >
      <div className="grid gap-1">
        <p className="text-(length:--text-tiny) uppercase tracking-[0.18em] text-muted-foreground">
          Workspace recovery
        </p>
        <p className="text-sm font-medium text-foreground">{heading}</p>
        <p className="text-sm text-foreground-soft">{detail}</p>
      </div>
      <div className="flex items-center justify-end">
        <Button
          aria-label="Dismiss workspace recovery message"
          className="text-xs font-medium normal-case tracking-normal"
          onClick={dismissBanner}
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
