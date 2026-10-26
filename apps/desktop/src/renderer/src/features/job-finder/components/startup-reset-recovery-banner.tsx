import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { afterFirstScreen } from "../lib/after-first-screen";
import { JOB_FINDER_ROUTE_PATHS } from "../lib/job-finder-route-hrefs";
import { Button } from "@renderer/components/ui/button";
import {
  JOB_FINDER_STARTUP_RESET_RECOVERY_COMPLETED_DETAIL,
  JOB_FINDER_STARTUP_RESET_RECOVERY_COMPLETED_MESSAGE,
  buildJobFinderStartupResetRecoveryDegradedDetail,
  canRetryJobFinderReset,
  isJobFinderStartupResetRecoveryFact,
  type JobFinderStartupResetRecoveryFact,
} from "../../../../../shared/job-finder-startup-reset-recovery";

const BANNER_DISMISSED_STORAGE_KEY_PREFIX =
  "nestor.startup-reset-recovery-banner-dismissed-v1:";

type DismissalStorage = "localStorage" | "sessionStorage";

function readBannerDismissed(
  storage: DismissalStorage,
  dismissalKey: string,
): boolean {
  try {
    return (
      window[storage].getItem(
        `${BANNER_DISMISSED_STORAGE_KEY_PREFIX}${dismissalKey}`,
      ) === "1"
    );
  } catch {
    return false;
  }
}

function persistBannerDismissed(
  storage: DismissalStorage,
  dismissalKey: string,
) {
  try {
    window[storage].setItem(
      `${BANNER_DISMISSED_STORAGE_KEY_PREFIX}${dismissalKey}`,
      "1",
    );
  } catch {
    // Keep the in-memory dismissal when persistent storage is unavailable.
  }
}

export function StartupResetRecoveryBanner() {
  const navigate = useNavigate();
  const [fact, setFact] = useState<JobFinderStartupResetRecoveryFact | null>(
    null,
  );
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    let cancelled = false;

    // A recovery notice can wait for the first screen; reading it makes
    // main load the old route modules.
    afterFirstScreen(() => {
      if (cancelled) return;
      try {
        const recoveryBridge =
          window.nestor?.jobFinder?.getStartupResetRecovery;
        recoveryBridge?.()
          .then((recoveryFact) => {
            if (
              !cancelled &&
              isJobFinderStartupResetRecoveryFact(recoveryFact)
            ) {
              setFact(recoveryFact);
            }
          })
          .catch(() => {
            // Stay hidden when the desktop bridge is unavailable.
          });
      } catch {
        // Stay hidden when the desktop bridge is unavailable.
      }
    });

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

  // An unreadable marker is one incident, reported first when the store opens
  // and again once the old workspace quarantines it. Dismissing either covers
  // both for this session, across screens; a failure on a later launch shows
  // again. Other notices stay dismissed for good.
  const unreadableMarker =
    fact.status === "degraded" && canRetryJobFinderReset(fact.reason);
  const [storage, storedKey]: [DismissalStorage, string] = unreadableMarker
    ? ["sessionStorage", "unreadable-marker"]
    : ["localStorage", dismissalKey];
  if (dismissedKeys.has(storedKey) || readBannerDismissed(storage, storedKey)) {
    return null;
  }

  function dismissBanner() {
    persistBannerDismissed(storage, storedKey);
    setDismissedKeys((current) => new Set(current).add(storedKey));
  }

  const canRetry =
    fact.status === "degraded" && canRetryJobFinderReset(fact.reason);
  const heading =
    fact.status === "completed"
      ? JOB_FINDER_STARTUP_RESET_RECOVERY_COMPLETED_MESSAGE
      : canRetry
        ? "A reset didn't finish"
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
      <div className="flex items-center justify-end gap-2">
        {canRetry ? (
          <Button
            className="text-xs font-medium normal-case tracking-normal"
            onClick={() => {
              void navigate(
                `${JOB_FINDER_ROUTE_PATHS.settings}#settings-danger-zone`,
              );
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            Reset again
          </Button>
        ) : null}
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
