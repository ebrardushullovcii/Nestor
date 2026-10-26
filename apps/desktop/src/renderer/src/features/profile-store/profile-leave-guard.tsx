import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, type Location } from "react-router-dom";
import type { JobFinderLeaveConfirmation } from "@renderer/pages/use-job-finder-page-controller";
import { JobFinderUnsavedChangesDialog } from "@renderer/pages/job-finder-unsaved-changes-dialog";
import { applyJobFinderWindowCloseGuard } from "@renderer/pages/job-finder-window-close-guard";

const PROFILE_PATH = "/job-finder/profile";

/** Profile tab and focus changes keep the same form mounted, with its draft. */
function keepsForm(current: Location, next: Location): boolean {
  if (current.pathname !== next.pathname) return false;
  if (current.search === next.search) return true;
  if (current.pathname !== PROFILE_PATH) return false;
  const rest = (search: string) => {
    const params = new URLSearchParams(search);
    params.delete("section");
    params.delete("focus");
    params.sort();
    return params.toString();
  };
  return rest(current.search) === rest(next.search);
}

/**
 * Asks before a route change or a window close would drop unsaved Profile or
 * setup edits, or interrupt a save. Renders the dialog; mount it once per
 * screen.
 */
export function ProfileLeaveGuard(props: {
  dirty: boolean;
  /** What is saving now, named for the dialog; null when nothing is. */
  saving: string | null;
}) {
  const confirmation = useMemo<JobFinderLeaveConfirmation | null>(() => {
    const reasons = [
      ...(props.dirty ? ["Unsaved profile or setup changes"] : []),
      ...(props.saving ? [`${props.saving} is still saving`] : []),
    ];
    return reasons.length
      ? {
          title: "Leave this page?",
          description: "Your unsaved changes will be lost.",
          reasons,
        }
      : null;
  }, [props.dirty, props.saving]);
  const current = useRef(confirmation);
  current.current = confirmation;

  useEffect(() => {
    applyJobFinderWindowCloseGuard(confirmation);
  }, [confirmation]);
  useEffect(() => () => applyJobFinderWindowCloseGuard(null), []);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      current.current !== null && !keepsForm(currentLocation, nextLocation),
  );
  const [asking, setAsking] = useState<JobFinderLeaveConfirmation | null>(null);
  useEffect(() => {
    if (blocker.state !== "blocked") {
      setAsking(null);
      return;
    }
    // A save that finished while the navigation was parked, or while the
    // dialog was up, leaves nothing to protect; let the navigation through.
    if (!confirmation) {
      blocker.proceed();
      return;
    }
    setAsking(confirmation);
  }, [blocker, confirmation]);

  return (
    <JobFinderUnsavedChangesDialog
      confirmation={asking}
      onStay={() => {
        if (blocker.state === "blocked") blocker.reset();
      }}
      onLeaveWithoutSaving={() => {
        if (blocker.state === "blocked") blocker.proceed();
      }}
    />
  );
}
