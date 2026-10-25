import {
  normalizeProfileSetupStep,
  type CandidateProfile,
  type JobSearchPreferences,
  type ProfileSetupStep,
  type ResumeApplicationMode,
  type ResumeImportFieldCandidateSummary,
  type ResumeImportRun,
  type ResumeImportProgressEvent,
  type SourceDebugRunRecord,
} from "@nestor/contracts";
import type { UseFieldArrayReturn, UseFormReturn } from "react-hook-form";
import { Button } from "@renderer/components/ui/button";
import {
  type ProfileEditorValues,
  type SearchPreferencesEditorValues,
} from "../../../lib/profile-editor";
import type {
  ProfileBackgroundArrays,
  ProfileFieldArrayKeyName,
} from "../profile-field-array-types";
import { ProfileBackgroundTab } from "../profile-background-tab";
import { ProfileExperienceTab } from "../profile-experience-tab";
import { getNextProfileSetupStep } from "./profile-setup-steps";
import {
  ProfileSetupEssentialsStep,
  ProfileSetupImportStep,
  ProfileSetupTargetingStep,
} from "./profile-setup-step-sections";
import { ProfileSetupExtrasStep } from "./profile-setup-step-sections-extra";
import {
  isBlockingPendingReviewItem,
  PROFILE_SETUP_VALIDATION_ALERT_ID,
  type ProfileSetupReviewItemDisplay,
} from "./profile-setup-screen-helpers";

export function ProfileSetupStepEditor(props: {
  backgroundArrays: ProfileBackgroundArrays;
  currentStepReviewItems: readonly ProfileSetupReviewItemDisplay[];
  draftProfile: CandidateProfile;
  draftSearchPreferences: JobSearchPreferences;
  experienceArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "records.experiences",
    ProfileFieldArrayKeyName
  >;
  focusedReviewItemId?: string | null;
  focusedReviewRequestKey?: number;
  hasUnsavedChanges: boolean;
  importDisabledReason?: string | null;
  /** Set when the last import was cut off by the app closing. */
  interruptedImportMessage?: string | null;
  interruptedImportFileName?: string | null;
  onRetryInterruptedImport?: () => void;
  /** When false, Save/Continue lives in the locked sticky footer instead. */
  inlineFooter?: boolean;
  isImportResumePending: boolean;
  isProfileSetupPending: boolean;
  latestResumeImportReviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  latestResumeImportRun: ResumeImportRun | null;
  resumeImportProgress: ResumeImportProgressEvent | null;
  onContinueToProfile: () => void;
  onImportResume: () => void;
  onSaveCurrentStep: () => void;
  onSaveAndGoToStep: (step: ProfileSetupStep) => void;
  onResumeApplicationModeChange?: (mode: ResumeApplicationMode) => void;
  onRunSourceDebug?: (
    targetId: string,
    options?: { readabilityTimeoutMs?: number },
  ) => void;
  profile: CandidateProfile;
  profileForm: UseFormReturn<ProfileEditorValues>;
  profileSetupReviewItems: readonly ProfileSetupReviewItemDisplay[];
  currentStep: ProfileSetupStep;
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
  resumeApplicationMode?: ResumeApplicationMode;
  recentSourceDebugRuns?: readonly SourceDebugRunRecord[];
  registerPendingSourceFlush?: (flush: (() => Promise<void>) | null) => void;
  searchPreferences: JobSearchPreferences;
  validationMessage: string | null;
}) {
  const focusedReviewItem = props.profileSetupReviewItems.find(
    (item) => item.id === props.focusedReviewItemId,
  );
  const focusExperienceRecordId =
    focusedReviewItem?.target.domain === "experience"
      ? (focusedReviewItem.target.recordId ?? null)
      : null;
  const focusExperienceOpenSignal =
    focusExperienceRecordId && props.focusedReviewRequestKey
      ? `${focusExperienceRecordId}:${props.focusedReviewRequestKey}`
      : null;
  // Legacy workspaces can still carry a retired step id; the visible step is
  // always one of the five guided-setup steps.
  const currentStep = normalizeProfileSetupStep(props.currentStep);
  const nextStep = getNextProfileSetupStep(currentStep);
  const blockingCurrentStepReviewItems = props.currentStepReviewItems.filter(
    (item) => item.status === "pending" && isBlockingPendingReviewItem(item),
  );

  function renderFooter(options?: {
    nextLabel?: string;
    onPrimary?: (() => void | Promise<void>) | null;
    primaryDisabled?: boolean;
    primaryLabel?: string;
  }) {
    if (props.inlineFooter === false) {
      return null;
    }
    return (
      <div
        className="flex flex-col gap-3 border-t border-border/30 pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
        data-profile-workspace-actions
      >
        <div className="grid gap-2">
          <p className="text-sm leading-6 text-foreground-soft">
            {props.hasUnsavedChanges
              ? "You have unsaved setup changes."
              : "No unsaved changes."}
          </p>
          {props.validationMessage ? (
            <p
              className="text-sm leading-6 text-destructive"
              id={PROFILE_SETUP_VALIDATION_ALERT_ID}
              role="alert"
            >
              {props.validationMessage}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button
            disabled={props.isProfileSetupPending || !props.hasUnsavedChanges}
            pending={props.isProfileSetupPending}
            onClick={props.onSaveCurrentStep}
            type="button"
            variant="secondary"
          >
            Save changes
          </Button>
          {options?.onPrimary || options?.primaryLabel ? (
            <Button
              disabled={
                props.isProfileSetupPending ||
                options.primaryDisabled === true ||
                !options.onPrimary
              }
              pending={props.isProfileSetupPending}
              onClick={() => {
                void options.onPrimary?.();
              }}
              type="button"
            >
              {options.primaryLabel ?? options.nextLabel ?? "Save and continue"}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  switch (currentStep) {
    case "import":
      return (
        <ProfileSetupImportStep
          importDisabledReason={props.importDisabledReason ?? null}
          interruptedImportMessage={props.interruptedImportMessage ?? null}
          interruptedImportFileName={props.interruptedImportFileName ?? null}
          {...(props.onRetryInterruptedImport
            ? { onRetryInterruptedImport: props.onRetryInterruptedImport }
            : {})}
          isImportResumePending={props.isImportResumePending}
          isProfileSetupPending={props.isProfileSetupPending}
          latestResumeImportReviewCandidates={
            props.latestResumeImportReviewCandidates
          }
          latestResumeImportRun={props.latestResumeImportRun}
          resumeImportProgress={props.resumeImportProgress}
          onContinueToProfile={props.onContinueToProfile}
          onImportResume={props.onImportResume}
          onSaveAndGoToStep={props.onSaveAndGoToStep}
          profile={props.profile}
          renderFooter={renderFooter}
          reviewItemCount={blockingCurrentStepReviewItems.length}
        />
      );
    case "essentials":
      return (
        <ProfileSetupEssentialsStep
          nextStep={nextStep}
          onSaveAndGoToStep={props.onSaveAndGoToStep}
          profileForm={props.profileForm}
          renderFooter={renderFooter}
        />
      );
    case "background":
      return (
        <div className="grid gap-6">
          <ProfileExperienceTab
            isProfileSetupPending={props.isProfileSetupPending}
            experienceArray={props.experienceArray}
            focusRecordId={focusExperienceRecordId}
            focusRecordOpenSignal={focusExperienceOpenSignal}
            profileForm={props.profileForm}
            // Skipping only navigates after saving the draft; readiness and
            // review items keep reporting the missing work history honestly.
            onContinueWithoutWorkHistory={
              nextStep ? () => props.onSaveAndGoToStep(nextStep) : undefined
            }
          />
          <ProfileBackgroundTab
            backgroundArrays={props.backgroundArrays}
            isProfileSetupPending={props.isProfileSetupPending}
            profileForm={props.profileForm}
          />
          {renderFooter({
            nextLabel: "Save and continue to Job targets",
            onPrimary: () => props.onSaveAndGoToStep(nextStep ?? "targeting"),
          })}
        </div>
      );
    case "targeting":
      return (
        <ProfileSetupTargetingStep
          isProfileSetupPending={props.isProfileSetupPending}
          nextStep={nextStep}
          onSaveAndGoToStep={props.onSaveAndGoToStep}
          {...(props.onRunSourceDebug
            ? { onRunSourceDebug: props.onRunSourceDebug }
            : {})}
          {...(props.onResumeApplicationModeChange
            ? {
                onResumeApplicationModeChange:
                  props.onResumeApplicationModeChange,
              }
            : {})}
          preferencesForm={props.preferencesForm}
          profileForm={props.profileForm}
          {...(props.resumeApplicationMode
            ? { resumeApplicationMode: props.resumeApplicationMode }
            : {})}
          renderFooter={renderFooter}
          recentSourceDebugRuns={props.recentSourceDebugRuns ?? []}
          {...(props.registerPendingSourceFlush
            ? { registerPendingSourceFlush: props.registerPendingSourceFlush }
            : {})}
          suggestedWorkCountry={
            props.draftProfile.currentCountry?.trim() ||
            props.profile.currentCountry?.trim() ||
            null
          }
        />
      );
    case "extras":
      return (
        <ProfileSetupExtrasStep
          backgroundArrays={props.backgroundArrays}
          isProfileSetupPending={props.isProfileSetupPending}
          profileForm={props.profileForm}
          renderFooter={renderFooter}
        />
      );
  }
}
