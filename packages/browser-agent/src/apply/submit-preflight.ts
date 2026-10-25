import type { ApplyAuthority, ApplyFormObservation } from "./types";

/**
 * The checks that stand between a filled form and one irreversible click.
 *
 * None of this asks the model anything. Sending an application is decided from
 * the saved authority document and from what the page itself shows: every
 * required answer present, every file attached, nothing flagged as wrong, and
 * this really being the last screen. Anything less stops (ADR 0012).
 */

export type ApplySubmitPreflightResult =
  | { ok: true }
  | { ok: false; reason: string };

export function unresolvedRequiredControls(observation: ApplyFormObservation) {
  return observation.controls.filter((control, _index, controls) => {
    if (control.disabled || (!control.visible && control.kind !== "file"))
      return false;
    if (
      control.kind === "radio" ||
      (control.kind === "checkbox" && control.choiceGroupKey)
    ) {
      const group = controls.filter(
        (candidate) =>
          candidate.kind === control.kind &&
          !candidate.disabled &&
          candidate.visible &&
          (control.choiceGroupKey
            ? candidate.choiceGroupKey === control.choiceGroupKey
            : candidate.ref === control.ref),
      );
      return (
        group.some((candidate) => candidate.required) &&
        !group.some((candidate) => candidate.checked) &&
        group[0] === control
      );
    }
    return control.required && (!control.answered || control.invalid);
  });
}

/** Readiness is the same form check in every mode, including Prepare for me. */
export function checkFormReadiness(
  observation: ApplyFormObservation,
): ApplySubmitPreflightResult {
  if (observation.loading)
    return {
      ok: false,
      reason: "The form is still loading. Check it again once it finishes.",
    };
  if (observation.blocker)
    return { ok: false, reason: observation.blocker.summary };
  const missing = unresolvedRequiredControls(observation);
  const missingFile = missing.find((control) => control.kind === "file");
  if (missingFile)
    return {
      ok: false,
      reason: `${missingFile.label || "A required file"} is not attached or was rejected by the form.`,
    };
  if (missing.length) {
    const labels = missing.map(
      (control) =>
        control.groupLabel ||
        control.label ||
        control.placeholder ||
        "an unnamed field",
    );
    return {
      ok: false,
      reason: `Complete these required fields: ${labels.join(", ")}.`,
    };
  }
  const invalid = observation.controls.find(
    (control) =>
      !control.disabled &&
      control.invalid &&
      (control.visible || control.kind === "file"),
  );
  if (invalid || observation.validationErrors.length)
    return {
      ok: false,
      reason: `The page is still showing a problem: ${invalid?.validationMessage || observation.validationErrors[0] || invalid?.label}`,
    };
  if (hasRemainingApplicationStep(observation)) {
    return {
      ok: false,
      reason:
        "This form has another step. Continue to the final review before sending.",
    };
  }
  if (
    !observation.actions.some(
      (action) => action.kind === "final" && action.visible && !action.disabled,
    )
  ) {
    return {
      ok: false,
      reason:
        "The form's send button is not available yet. Open the form to complete the remaining step.",
    };
  }
  return { ok: true };
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function runSubmitPreflight(input: {
  observation: ApplyFormObservation;
  proposedActionRef: string;
  authority: ApplyAuthority;
}): ApplySubmitPreflightResult {
  const { observation, authority } = input;

  if (authority.mode === "prepare_only") {
    return {
      ok: false,
      reason:
        "This application is set to fill in only, so Job Finder stopped before sending it.",
    };
  }

  const pageOrigin = observation.origin;
  const allowedOrigins = authority.allowedOrigins
    .map(canonicalOrigin)
    .filter((value): value is string => value !== null);
  if (!pageOrigin || !allowedOrigins.includes(pageOrigin)) {
    return {
      ok: false,
      reason: pageOrigin
        ? `Job Finder is not authorized to send an application on ${pageOrigin}. The form is still available for review.`
        : "Job Finder could not verify which site would receive this application, so it stopped before sending.",
    };
  }

  const action = observation.actions.find(
    (candidate) => candidate.ref === input.proposedActionRef,
  );
  if (!action) {
    return { ok: false, reason: "That button is not on the page any more." };
  }
  if (action.kind !== "final") {
    return {
      ok: false,
      reason: `"${action.label}" does not send the application.`,
    };
  }
  if (!action.visible || action.disabled) {
    return { ok: false, reason: `"${action.label}" cannot be used right now.` };
  }

  return checkFormReadiness(observation);
}

/** An optional Save on an explicitly final review step does not mean another step. */
export function hasRemainingApplicationStep(
  observation: ApplyFormObservation,
): boolean {
  const { index, total } = observation.step;
  if (index !== null && total !== null) return index < total;
  return observation.actions.some(
    (action) => action.kind === "advance" && action.visible,
  );
}
