import type { NavigateFunction } from "react-router-dom";
import {
  evaluateProfileSetupReadiness,
  getProfileSetupReadinessBlockers,
  type CandidateProfile,
  type JobSearchPreferences,
  type ProfileEditBatch,
  type ProfileSetupState,
  type ProfileSetupStep,
} from "@nestor/contracts";
import { requestFirstSearch } from "@renderer/features/find-jobs/first-search";
import { isFinishBlockingReviewItem } from "@renderer/features/job-finder/components/profile/setup/profile-setup-screen-helpers";
import {
  clearProfileSetupJustFinished,
  markProfileSetupJustFinished,
} from "@renderer/pages/profile-setup-finished";
import type { ProfileWorkflow } from "./use-profile-workflow";

const SETUP_PATH = "/job-finder/profile/setup";

const NOT_STARTED: ProfileSetupState = {
  status: "not_started",
  currentStep: "import",
  completedAt: null,
  reviewItems: [],
  lastResumedAt: null,
};

/** Opens guided setup at `step`, or where the person left it. */
export async function resumeGuidedSetup(
  workflow: Pick<ProfileWorkflow, "state" | "saveSetupState">,
  navigate: NavigateFunction,
  pathname: string,
  step?: ProfileSetupStep,
): Promise<void> {
  const current = workflow.state?.profileSetupState ?? NOT_STARTED;
  const saved = await workflow.saveSetupState({
    ...current,
    status: current.status === "completed" ? "completed" : "in_progress",
    currentStep: step ?? current.currentStep,
    lastResumedAt: new Date().toISOString(),
  });
  // Navigating to the setup URL it is already on would remount the editor
  // and drop fields the setup forms keep between steps.
  if (saved && pathname !== SETUP_PATH) void navigate(SETUP_PATH);
}

/** Whether a batch changes anything; an empty commit is not sent. */
export function hasProfileEdits(batch: ProfileEditBatch): boolean {
  const changed = (value: object | undefined) =>
    value !== undefined && Object.keys(value).length > 0;
  return (
    changed(batch.profile?.fields) ||
    changed(batch.profile?.lists) ||
    changed(batch.goals?.fields) ||
    changed(batch.goals?.lists) ||
    batch.upsert.length > 0 ||
    batch.remove.length > 0 ||
    batch.workPermissions !== undefined
  );
}

export interface SetupStepOptions {
  finishSetup?: boolean;
  message?: string;
  openProfile?: boolean;
  /**
   * Pending review items the saved draft already edited or confirmed. They
   * are saved as resolved with the step, so an edited field never keeps its
   * own suggestion pending.
   */
  resolvedReviewItems?: readonly {
    id: string;
    status: "confirmed" | "edited";
  }[];
  stayOnCurrentStep?: boolean;
}

/**
 * The setup state after a step saved: review items the draft resolved, the
 * step reached, and completion only when nothing required still blocks it.
 */
export function nextSetupState(input: {
  current: ProfileSetupState;
  profile: CandidateProfile;
  goals: JobSearchPreferences;
  enabledSites: number;
  nextStep: ProfileSetupStep;
  options: SetupStepOptions;
  now: string;
}): ProfileSetupState {
  const { current, options, now } = input;
  const readiness = evaluateProfileSetupReadiness(
    input.profile,
    input.goals,
    input.enabledSites,
  );
  const resolvedById = new Map(
    (options.resolvedReviewItems ?? []).map((entry) => [
      entry.id,
      entry.status,
    ]),
  );
  const reviewItems = current.reviewItems.map((item) => {
    const status = resolvedById.get(item.id);
    return item.status === "pending" && status
      ? { ...item, status, resolvedAt: now }
      : item;
  });
  // Only required setup items and critical review items gate completion;
  // recommended suggestions stay optional. The same blockers the footer
  // reads, so Finish is never offered and then refused.
  const completed =
    options.finishSetup === true &&
    readiness.materiallyComplete &&
    getProfileSetupReadinessBlockers(readiness).length === 0 &&
    !reviewItems.some(isFinishBlockingReviewItem);
  return {
    ...current,
    reviewItems,
    reviewedSteps: [
      ...new Set([...(current.reviewedSteps ?? []), current.currentStep]),
    ],
    status: completed ? "completed" : "in_progress",
    currentStep: completed
      ? "targeting"
      : options.stayOnCurrentStep
        ? current.currentStep
        : input.nextStep,
    completedAt: completed ? (current.completedAt ?? now) : null,
    lastResumedAt: now,
  };
}

/**
 * After the step's state saved: a finished setup goes to Find jobs (starting
 * the first search when none ran yet), "open Profile" goes to Profile, and
 * anything else stays in setup.
 */
export async function handOffAfterSetupStep(input: {
  state: ProfileSetupState;
  options: SetupStepOptions;
  navigate: NavigateFunction;
  startedOnSetup: boolean;
}): Promise<void> {
  const { state, options, navigate } = input;
  if (state.status === "completed") {
    markProfileSetupJustFinished();
    const [sites, search] = await Promise.all([
      window.nestor.jobs.run("list_sites", { limit: 1 }),
      window.nestor.jobs.run("search_status", {}),
    ]);
    if (sites.enabledTotal > 0 && !search.search) requestFirstSearch();
    void navigate("/job-finder/discovery", { replace: true });
    // The completed render has already chosen its redirect target.
    setTimeout(clearProfileSetupJustFinished, 0);
    return;
  }
  if (options.openProfile && options.finishSetup !== true) {
    void navigate("/job-finder/profile");
    return;
  }
  if (!input.startedOnSetup) void navigate(SETUP_PATH);
}
