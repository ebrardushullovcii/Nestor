import {
  normalizeProfileSetupStep,
  type ProfileSetupStep,
} from "@nestor/contracts";
import { useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { PROFILE_SETUP_VALIDATION_ALERT_ID } from "./profile-setup-screen-helpers";
import { getNextProfileSetupStep } from "./profile-setup-steps";

const CONTINUE_LABEL_BY_STEP: Record<string, string> = {
  import: "Save and go to Basics",
  essentials: "Save and continue to Work history",
  background: "Save and continue to Job targets",
  targeting: "Save and continue to Extras",
};

export const PROFILE_SETUP_FINISH_LABEL = "Finish setup and find jobs";

/**
 * One filled primary per step, and never more than two buttons:
 *
 * - Every step with a next step moves forward with "Save and continue to
 *   …". The button never changes meaning mid-step.
 * - Finishing is offered on any step once nothing required is missing (a
 *   good import fills everything, and walking three more steps to reach
 *   Finish was three saves for nothing). Once it can run it is the filled
 *   action, last in the row, and Continue steps down to outline: the
 *   forward action is finishing, not the optional next step. While
 *   something is missing it is outlined and disabled on Job targets, the
 *   last required step, with the reason beside it.
 * - Extras, the last step, has nowhere to continue to, so Finish is its
 *   primary.
 */
export function getProfileSetupStepFooterPrimary(input: {
  canFinishSetup: boolean;
  currentStep: ProfileSetupStep;
  onSaveAndFinish: () => void;
  onSaveAndGoToStep: (step: ProfileSetupStep) => void;
}): {
  disabled: boolean;
  label: string;
  onPrimary: (() => void) | null;
} {
  const currentStep = normalizeProfileSetupStep(input.currentStep);
  const nextStep = getNextProfileSetupStep(currentStep);

  if (currentStep === "extras" || !nextStep) {
    return input.canFinishSetup
      ? {
          disabled: false,
          label: PROFILE_SETUP_FINISH_LABEL,
          onPrimary: input.onSaveAndFinish,
        }
      : { disabled: true, label: PROFILE_SETUP_FINISH_LABEL, onPrimary: null };
  }

  return {
    disabled: false,
    label: CONTINUE_LABEL_BY_STEP[currentStep] ?? "Save and continue",
    onPrimary: () => input.onSaveAndGoToStep(nextStep),
  };
}

/** The outlined Finish beside the primary, or null where there is none. */
export function getProfileSetupStepFooterFinish(input: {
  canFinishSetup: boolean;
  currentStep: ProfileSetupStep;
  onSaveAndFinish: () => void;
}): { disabled: boolean; label: string; onFinish: (() => void) | null } | null {
  const currentStep = normalizeProfileSetupStep(input.currentStep);
  if (currentStep === "extras" || !getNextProfileSetupStep(currentStep))
    return null;
  if (input.canFinishSetup)
    return {
      disabled: false,
      label: PROFILE_SETUP_FINISH_LABEL,
      onFinish: input.onSaveAndFinish,
    };
  return currentStep === "targeting"
    ? { disabled: true, label: PROFILE_SETUP_FINISH_LABEL, onFinish: null }
    : null;
}

/**
 * One readiness sentence for the whole of setup, in one place. The stepper
 * chips own per-step review counts; this line owns whether setup can finish
 * and what is still required, naming the items instead of counting them a
 * second time.
 */
export function formatProfileSetupFinishReadiness(input: {
  canFinishSetup: boolean;
  remainingBlockerLabels: readonly string[];
}): string {
  if (input.canFinishSetup) {
    return "Everything required is in. You can finish setup.";
  }

  if (input.remainingBlockerLabels.length === 0) {
    return "Setup cannot finish yet.";
  }

  return `Still needed to finish: ${summarizeRemainingBlockerLabels(
    input.remainingBlockerLabels,
  ).join(" · ")}.`;
}

const NAMED_BLOCKER_LIMIT = 3;
const REVIEW_LABEL_PATTERN = /^Confirm /u;
const STEP_SUFFIX_PATTERN = /\s\((.+) step\)$/u;

/**
 * A short list is named in full. A long one is mostly imported details
 * waiting for a "Confirm", and naming twenty-three of them turned
 * the footer into a paragraph that pushed the form off screen. Real blockers
 * (a missing source, a missing name) stay named; the review items collapse
 * into one count per step, since the step itself lists them.
 */
function summarizeRemainingBlockerLabels(labels: readonly string[]): string[] {
  if (labels.length <= NAMED_BLOCKER_LIMIT) {
    return [...labels];
  }
  const named: string[] = [];
  const reviewCountByStep = new Map<string, number>();
  for (const label of labels) {
    if (!REVIEW_LABEL_PATTERN.test(label)) {
      named.push(label);
      continue;
    }
    const step = STEP_SUFFIX_PATTERN.exec(label)?.[1] ?? "";
    reviewCountByStep.set(step, (reviewCountByStep.get(step) ?? 0) + 1);
  }
  if (reviewCountByStep.size === 0) {
    return [...labels];
  }
  for (const [step, count] of reviewCountByStep) {
    const noun = count === 1 ? "detail" : "details";
    named.push(
      step === ""
        ? `Review ${count} imported ${noun} on this step`
        : `Review ${count} imported ${noun} (${step} step)`,
    );
  }
  return named;
}

export function ProfileSetupStepFooter(props: {
  canFinishSetup: boolean;
  currentStep: ProfileSetupStep;
  hasUnsavedChanges: boolean;
  /**
   * True only once the user has edited something. Right after an import the
   * step is dirty because Job Finder filled it in, which is not "changes you
   * left behind" and must not be reported as such.
   */
  hasUserEdits?: boolean;
  isProfileSetupPending: boolean;
  onSaveAndFinish: () => void;
  onSaveAndGoToStep: (step: ProfileSetupStep) => void;
  onSaveCurrentStep: () => void;
  /** Named canonical blockers still standing between here and Finish. */
  remainingBlockerLabels?: readonly string[];
  validationMessage: string | null;
}) {
  // Only the button that was pressed shows the spinner; the other waits.
  const [pressed, setPressed] = useState<"primary" | "finish" | "save" | null>(
    null,
  );
  const primary = getProfileSetupStepFooterPrimary({
    canFinishSetup: props.canFinishSetup,
    currentStep: props.currentStep,
    onSaveAndFinish: props.onSaveAndFinish,
    onSaveAndGoToStep: props.onSaveAndGoToStep,
  });
  const finish = getProfileSetupStepFooterFinish({
    canFinishSetup: props.canFinishSetup,
    currentStep: props.currentStep,
    onSaveAndFinish: props.onSaveAndFinish,
  });
  const readinessMessage = formatProfileSetupFinishReadiness({
    canFinishSetup: props.canFinishSetup,
    remainingBlockerLabels: props.remainingBlockerLabels ?? [],
  });
  // Only what the person typed is "unsaved": details filled in from their
  // resume save with the step's own button, so they get no warning.
  const showsUnsavedEdits =
    props.hasUnsavedChanges && props.hasUserEdits !== false;
  // Continue and Finish both save first. A separate Save button appears only
  // where neither can run (Extras while Finish is blocked), so the footer
  // never offers three ways to save at once.
  const showsSaveOnly = showsUnsavedEdits && primary.disabled;
  const saving = props.isProfileSetupPending;
  // Finishing, once it can run, is the forward action.
  const finishLeads = Boolean(finish && !finish.disabled && finish.onFinish);
  const finishButton = (variant: "primary" | "outline") =>
    finish ? (
      <Button
        aria-describedby={
          finish.disabled ? "profile-setup-finish-blocker-summary" : undefined
        }
        data-profile-setup-finish
        disabled={saving || finish.disabled || !finish.onFinish}
        onClick={() => {
          setPressed("finish");
          finish.onFinish?.();
        }}
        pending={saving && pressed === "finish"}
        title={finish.disabled ? readinessMessage : undefined}
        type="button"
        variant={variant}
      >
        {finish.label}
      </Button>
    ) : null;
  const continueButton = (variant: "primary" | "outline") => (
    <Button
      aria-describedby={
        primary.disabled ? "profile-setup-finish-blocker-summary" : undefined
      }
      data-profile-setup-primary
      disabled={saving || primary.disabled || !primary.onPrimary}
      onClick={() => {
        setPressed("primary");
        primary.onPrimary?.();
      }}
      pending={saving && pressed === "primary"}
      title={primary.disabled ? readinessMessage : undefined}
      type="button"
      variant={variant}
    >
      {primary.label}
    </Button>
  );

  return (
    // F82: the action cluster is always the rightmost item on the footer's
    // first row, and the status text wraps inside its own column, so the
    // primary never jumps between consecutive steps.
    <div
      className="flex flex-col gap-2 px-4 py-2 sm:flex-row sm:flex-nowrap sm:items-center sm:justify-between sm:px-5"
      data-profile-workspace-actions
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-1">
          {/* A dot and a colour carry the save state as well as the words. */}
          <p
            className={
              showsUnsavedEdits && !saving
                ? "flex items-center gap-2 text-sm font-medium leading-5 text-(--warning-text)"
                : "flex items-center gap-2 text-sm leading-5 text-foreground-soft"
            }
            data-profile-save-state={
              saving ? "saving" : props.hasUnsavedChanges ? "dirty" : "clean"
            }
          >
            <span
              aria-hidden="true"
              className={
                showsUnsavedEdits && !saving
                  ? "size-2 shrink-0 rounded-full bg-(--warning-text)"
                  : "size-2 shrink-0 rounded-full bg-(--disabled-foreground)"
              }
            />
            {saving
              ? "Saving…"
              : props.hasUnsavedChanges
                ? props.hasUserEdits === false
                  ? // Right after an import the step is dirty because Job
                    // Finder filled it in; that is not work left behind.
                    "Filled in from your resume. Saved when you continue."
                  : "Unsaved setup changes."
                : "No unsaved changes."}
          </p>
          <p
            className="min-w-0 max-w-prose break-words text-sm leading-5 text-foreground-soft"
            data-profile-setup-finish-readiness
            id="profile-setup-finish-blocker-summary"
          >
            {readinessMessage}
          </p>
          {props.validationMessage ? (
            <p
              className="text-sm leading-5 text-destructive"
              id={PROFILE_SETUP_VALIDATION_ALERT_ID}
              role="alert"
            >
              {props.validationMessage}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">
        {showsSaveOnly ? (
          <Button
            disabled={saving}
            onClick={() => {
              setPressed("save");
              props.onSaveCurrentStep();
            }}
            pending={saving && pressed === "save"}
            type="button"
            variant="outline"
          >
            Save changes
          </Button>
        ) : null}
        {finish && finishLeads ? (
          <>
            {continueButton("outline")}
            {finishButton("primary")}
          </>
        ) : (
          <>
            {finish ? finishButton("outline") : null}
            {continueButton("primary")}
          </>
        )}
      </div>
    </div>
  );
}
