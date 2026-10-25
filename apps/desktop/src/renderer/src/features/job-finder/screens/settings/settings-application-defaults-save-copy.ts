import type {
  ApplicationAutomationMode,
  UpdateApplicationDefaultsInput,
} from "@nestor/contracts";

const APPLY_MODE_SAVED: Record<ApplicationAutomationMode, string> = {
  prepare_only:
    "Applying saved. Apply fills in each form and attaches the resume; you press Send.",
  confirm_before_submit:
    "Applying saved. Apply fills in each form, then waits for your go-ahead before sending.",
  autonomous_submit:
    "Applying saved. Apply fills in and sends each application, and pauses only when it needs you.",
};

/**
 * What the save toast says for one application-defaults save, named after
 * what the person actually changed.
 *
 * Settings sections share this save: the Applying mode, the resume look,
 * and (before ADR 0025) the resume level. The toast
 * only knew the last one, so picking Send for me announced "Newly shortlisted
 * jobs will start with a tailored resume", which was about something else and
 * false for a person on Original.
 */
export function describeApplicationDefaultsSave(
  input: UpdateApplicationDefaultsInput,
): { label: string; savedMessage: string; failedFallback: string } {
  if (
    input.applicationAutomationMode !== undefined)
    return {
      label: "Applying",
      savedMessage: APPLY_MODE_SAVED[input.applicationAutomationMode],
      failedFallback: "Applying settings were not saved. Try again.",
    };

  if (input.resumeApplicationMode !== undefined) {
    return {
      label: "Resume defaults",
      savedMessage:
        input.resumeApplicationMode === "original_resume"
          ? "Settings saved. Newly shortlisted jobs will start with your original resume unchanged."
          : "Settings saved. Newly shortlisted jobs will start with a tailored resume.",
      failedFallback:
        "Resume defaults were not saved. Retry before leaving this page.",
    };
  }

  if (input.resumeTemplateId !== undefined || input.fontPreset !== undefined) {
    return {
      label: "Resume look",
      savedMessage: "Resume look saved.",
      failedFallback:
        "Resume look was not saved. Retry before leaving this page.",
    };
  }

  return {
    label: "Settings",
    savedMessage: "Settings saved.",
    failedFallback: "Settings were not saved. Retry before leaving this page.",
  };
}
