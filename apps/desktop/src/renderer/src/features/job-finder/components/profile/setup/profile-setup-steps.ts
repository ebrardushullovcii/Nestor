import {
  normalizeProfileSetupStep,
  profileSetupVisibleStepValues,
  type ProfileSetupStep,
} from "@nestor/contracts";

/**
 * Guided setup is five steps. "Your story" and "Screener answers" merged into
 * one optional Extras step, and the old Ready check screen became the finish
 * action on Job targets instead of a step of its own.
 */
export const profileSetupSteps: readonly ProfileSetupStep[] =
  profileSetupVisibleStepValues;

export const profileSetupStepDefinitions: Array<{
  id: ProfileSetupStep;
  label: string;
  /** Nothing on this step blocks finishing setup; the stepper must say so. */
  optional?: boolean;
  summary: string;
}> = [
  {
    id: "import",
    label: "Import",
    summary:
      "Bring in a resume first, then focus only on the important follow-up questions.",
  },
  {
    id: "essentials",
    label: "Basics",
    summary:
      "Confirm your identity, contact path, headline, and location before discovery relies on them.",
  },
  {
    id: "background",
    label: "Work history",
    summary:
      "Review work history and supporting records so resumes and fit scoring stay grounded.",
  },
  {
    id: "targeting",
    label: "Job targets",
    summary:
      "Set roles, locations, work mode, and sources — then finish setup from here.",
  },
  {
    id: "extras",
    label: "Extras",
    optional: true,
    summary:
      "Optional: your story in your own words, and the screener answers you reuse.",
  },
];

export function formatProfileSetupStepLabel(step: ProfileSetupStep): string {
  const visibleStep = normalizeProfileSetupStep(step);

  return (
    profileSetupStepDefinitions.find((entry) => entry.id === visibleStep)
      ?.label ?? visibleStep
  );
}

export function getNextProfileSetupStep(
  currentStep: ProfileSetupStep,
): ProfileSetupStep | null {
  const currentIndex = profileSetupSteps.indexOf(
    normalizeProfileSetupStep(currentStep),
  );

  if (currentIndex < 0 || currentIndex >= profileSetupSteps.length - 1) {
    return null;
  }

  return profileSetupSteps[currentIndex + 1] ?? null;
}

export function getPreviousProfileSetupStep(
  currentStep: ProfileSetupStep,
): ProfileSetupStep | null {
  const currentIndex = profileSetupSteps.indexOf(
    normalizeProfileSetupStep(currentStep),
  );

  if (currentIndex <= 0) {
    return null;
  }

  return profileSetupSteps[currentIndex - 1] ?? null;
}
