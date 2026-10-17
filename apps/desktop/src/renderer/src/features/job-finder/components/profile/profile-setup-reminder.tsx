import { useState } from "react";
import type { ProfileSetupState } from "@nestor/contracts";

import type { PageStatusItem } from "../page-status-line";

const PROFILE_SETUP_REMINDER_DISMISSED_KEY =
  "nestor.profile-setup-reminder-dismissed-v1";

// Mirrors the friendly step language used on Home so the reminder never
// exposes raw setup step identifiers.
const PROFILE_SETUP_STEP_LABELS: Record<
  ProfileSetupState["currentStep"],
  string
> = {
  import: "resume import",
  essentials: "your basics",
  background: "your work history",
  targeting: "your job targets",
  extras: "the optional extras",
  // Retired step ids kept so a legacy stored value still reads as English.
  narrative: "the optional extras",
  answers: "the optional extras",
  ready_check: "your job targets",
};

function readReminderDismissed(): boolean {
  try {
    return (
      window.sessionStorage.getItem(PROFILE_SETUP_REMINDER_DISMISSED_KEY) ===
      "1"
    );
  } catch {
    return false;
  }
}

/**
 * Unfinished guided setup is a condition owned by another screen, so it is
 * an item on Profile's header status line with one Continue button, not a
 * card above the tabs (ADR 0044). Hiding it lasts for the rest of the
 * session, as "Not now" did.
 */
export function useProfileSetupStatusItem(props: {
  currentStep: ProfileSetupState["currentStep"];
  enabled: boolean;
  isResumePending: boolean;
  onResume: (step: ProfileSetupState["currentStep"]) => void;
  pendingItemCount: number;
}): PageStatusItem | null {
  const [isDismissed, setIsDismissed] = useState(readReminderDismissed);

  if (!props.enabled || isDismissed) {
    return null;
  }

  const count = props.pendingItemCount;
  const step = PROFILE_SETUP_STEP_LABELS[props.currentStep];
  return {
    id: "profile-setup",
    tone: "info",
    text:
      count > 0
        ? `Setup in progress: ${count} item${count === 1 ? "" : "s"} still need${count === 1 ? "s" : ""} review. Continue from ${step}.`
        : `Setup in progress. Continue from ${step}.`,
    action: {
      kind: "button",
      label: "Resume guided setup",
      onClick: () => props.onResume(props.currentStep),
      pending: props.isResumePending,
    },
    onHide: () => {
      setIsDismissed(true);
      try {
        window.sessionStorage.setItem(
          PROFILE_SETUP_REMINDER_DISMISSED_KEY,
          "1",
        );
      } catch {
        // The in-memory dismissal still applies when storage is unavailable.
      }
    },
  };
}
