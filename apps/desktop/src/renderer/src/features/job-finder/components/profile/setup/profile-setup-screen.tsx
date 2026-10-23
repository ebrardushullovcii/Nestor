import { canRetrySavedResumeImport } from "@nestor/contracts";
import { getRunningResumeImportProgress } from "@renderer/features/job-finder/lib/profile-resume-panel-utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  RESUME_IMPORT_INTERRUPTED_MESSAGE,
  evaluateProfileSetupReadiness,
  type CandidateProfile,
  type JobSearchPreferences,
  type ProfileSetupReviewActionOptions,
  type ProfileSetupState,
  type ProfileSetupStep,
  type ResumeApplicationMode,
  type ResumeImportFieldCandidateSummary,
  type ResumeImportRun,
  type ResumeImportProgressEvent,
  type SourceDebugRunRecord,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { LockedScreenLayout } from "../../locked-screen-layout";
import { PageHeader } from "../../page-header";
import { AskAssistantButton } from "../../../assistant/ask-assistant-button";
import { useAssistantContextSource } from "../../../assistant/assistant-provider";
import {
  flattenDirtyFields,
  profileFieldForEditorPath,
} from "../../../assistant/assistant-context-capture";
import { buildCopilotStarterQuestion } from "../profile-copilot-prompts";
import { ProfileSetupStepEditor } from "./profile-setup-step-editor";
import { ProfileSetupStepFooter } from "./profile-setup-step-footer";
import {
  buildProfileSetupReadinessPresentation,
  summarizeSavedSetupReviewValue,
  getProfileSetupReadinessBlockerLabel,
  getProfileSetupReadinessBlockerStep,
  getProfileSetupReviewItemCopy,
  isFinishBlockingReviewItem,
  isReadinessCoveredSetupReviewItem,
  isProfileSetupMissingFieldReviewItem,
} from "./profile-setup-screen-helpers";
import {
  ProfileSetupPathCard,
  ProfileSetupReviewQueueCard,
  ProfileSetupSummaryCards,
} from "./profile-setup-screen-sections";
import { useProfileSetupForms } from "./profile-setup-screen-hooks";
import {
  useProfileSetupScreenActions,
  type ProfileSetupResolvedReviewItem,
} from "./profile-setup-screen-actions";
import {
  PROFILE_SETUP_STEP_HEADING_ID,
  focusProfileSetupStepHeading,
} from "./profile-setup-step-focus";
import { markGuidedSetupAutoOpenSpent } from "./guided-setup-auto-open";
import {
  ProfileSetupImportNotice,
  isInterruptedResumeImport,
} from "./profile-setup-import-notice";
import { formatProfileSetupStepLabel } from "./profile-setup-steps";

// Guided setup is always one column: the step editor owns the full width and
// the review queue renders full-width beneath it. A second column used to
// leave thousands of pixels empty beside long steps and squeezed inputs.
const setupScreenSingleColumnClassName = "grid min-w-0 gap-6 xl:grid-cols-1";
const pristineSetupSummaryClassName = "grid min-w-0 w-full gap-6";
const setupScreenInlineReviewClassName = "grid min-w-0 gap-6 pb-4 xl:pb-6";
const pristineSetupTopClassName = "grid min-w-0 gap-4 overflow-visible pb-4";
const activeSetupTopClassName = "grid min-w-0 gap-3 overflow-visible pb-3";
// The sticky footer is a flex sibling of the route scroller and the collapsed
// Assistant is portalled into that footer. Neither overlays the editor, so an
// extra content tail only creates a blank scroll range after review cards
// collapse.
export const PROFILE_SETUP_FOOTER_CLEARANCE_CLASS_NAME = "";
const unsavedSetupReviewActionsMessage =
  "Save this step before confirming, dismissing, or clearing review items so your current setup draft stays intact.";
/**
 * The same situation while Save itself cannot be pressed.
 *
 * A person met four greyed buttons under an instruction to press a fifth
 * greyed button. Naming the thing that is actually happening — and that it
 * ends by itself — is the difference between a dead end and a wait.
 */
const savingSetupReviewActionsMessage =
  "This step is saving. Its review items open again as soon as that finishes.";
const defaultResumeApplicationMode: ResumeApplicationMode = "tailored_per_job";

export function getProfileSetupLayoutClassNames(input: {
  hasPendingReviewItems: boolean;
  isPristineSetup: boolean;
}) {
  void input.hasPendingReviewItems;

  return {
    content: setupScreenSingleColumnClassName,
    reviewRail: setupScreenInlineReviewClassName,
    summary: input.isPristineSetup
      ? pristineSetupSummaryClassName
      : setupScreenSingleColumnClassName,
  };
}

export function getProfileSetupTopClassName(isPristineSetup: boolean): string {
  return isPristineSetup ? pristineSetupTopClassName : activeSetupTopClassName;
}

/**
 * Footer clearance only belongs under a rendered sticky footer. The pristine
 * entry screen has no footer, so the reserved space only pushed a page that
 * otherwise fits past the viewport and produced a scrollbar.
 */
export function getProfileSetupContentClassName(
  isPristineSetup: boolean,
): string {
  return isPristineSetup ? "" : PROFILE_SETUP_FOOTER_CLEARANCE_CLASS_NAME;
}

export function ProfileSetupScreen(props: {
  actionState: { message: string | null };
  importResumeGuardMessage: string | null;
  isImportResumePending: boolean;
  isProfileSetupPending: boolean;
  isReviewItemPending: (reviewItemId: string) => boolean;
  latestResumeImportReviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  latestResumeImportRun: ResumeImportRun | null;
  resumeImportProgress: ResumeImportProgressEvent | null;
  onApplyProfileSetupReviewAction: (
    reviewItemId: string,
    action: "confirm" | "dismiss" | "clear_value",
    options?: ProfileSetupReviewActionOptions,
  ) => void;
  onContinueToProfile: () => void;
  onImportResume: () => void;
  /** Imports again the file a stopped import saved; no file picker. */
  onRetryInterruptedImport?: () => void;
  /** Reads the saved resume again, for an import the AI never read. */
  onAnalyzeProfileFromResume?: () => void;
  isAnalyzeProfilePending?: boolean;
  onCancelImportResume: () => void;
  onProfileSurfaceDirtyChange: (dirty: boolean) => void;
  /**
   * Reports each user-authored draft edit so the shell can retire an
   * exact-request save retry captured before the edit.
   */
  onProfileSurfaceDraftEdited?: () => void;
  onResumeSetup: (step: ProfileSetupStep) => void;
  onRunSourceDebug?: (
    targetId: string,
    options?: { readabilityTimeoutMs?: number },
  ) => void;
  onSaveSetupStep: (
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
    nextStep: ProfileSetupStep,
    options?: {
      finishSetup?: boolean;
      message?: string;
      openProfile?: boolean;
      resolvedReviewItems?: readonly ProfileSetupResolvedReviewItem[];
      stayOnCurrentStep?: boolean;
    },
  ) => void;
  profile: CandidateProfile;
  profileSetupState: ProfileSetupState;
  recentSourceDebugRuns?: readonly SourceDebugRunRecord[];
  resumeApplicationMode?: ResumeApplicationMode;
  searchPreferences: JobSearchPreferences;
}) {
  const {
    actionState,
    importResumeGuardMessage,
    isImportResumePending: localImportPending,
    isProfileSetupPending,
    isReviewItemPending,
    latestResumeImportReviewCandidates,
    latestResumeImportRun,
    resumeImportProgress: localImportProgress,
    onApplyProfileSetupReviewAction,
    onContinueToProfile,
    onImportResume,
    onRetryInterruptedImport,
    onAnalyzeProfileFromResume,
    isAnalyzeProfilePending = false,
    onCancelImportResume,
    onProfileSurfaceDirtyChange,
    onProfileSurfaceDraftEdited,
    onResumeSetup,
    onRunSourceDebug,
    onSaveSetupStep,
    profile,
    profileSetupState,
    recentSourceDebugRuns = [],
    resumeApplicationMode,
    searchPreferences,
  } = props;

  const navigate = useNavigate();
  const savedResumeApplicationMode =
    resumeApplicationMode ?? defaultResumeApplicationMode;
  const [selectedResumeApplicationMode, setSelectedResumeApplicationMode] =
    useState<ResumeApplicationMode>(savedResumeApplicationMode);

  useEffect(() => {
    setSelectedResumeApplicationMode(savedResumeApplicationMode);
  }, [savedResumeApplicationMode]);

  const {
    backgroundArrays,
    markOwnSave,
    backgroundMergeNotice,
    discardEditsAndReloadCanonical,
    draftAwareReviewItems,
    draftProfile,
    draftSearchPreferences,
    experienceArray,
    hasBackgroundConflict,
    hasUserDraftChanges,
    hasUnsavedChanges,
    preferencesForm,
    profileForm,
    setValidationMessage,
    validationMessage,
  } = useProfileSetupForms({
    latestResumeImportReviewCandidates,
    ...(onProfileSurfaceDraftEdited
      ? { onDraftEdited: onProfileSurfaceDraftEdited }
      : {}),
    profile,
    profileSetupState,
    searchPreferences,
  });

  const hasUnsavedSetupChanges =
    hasUnsavedChanges ||
    selectedResumeApplicationMode !== savedResumeApplicationMode;

  // The shell's dirty signal (import guard, leave confirmation) must follow
  // actual user edits only. `hasUnsavedChanges` also becomes true when the
  // editor is pre-filled from imported review candidates, which made the
  // "save before importing" guard appear right after a fresh import with no
  // edits at all.
  const hasUserAuthoredSetupChanges =
    hasUserDraftChanges ||
    selectedResumeApplicationMode !== savedResumeApplicationMode;

  useEffect(() => {
    onProfileSurfaceDirtyChange(hasUserAuthoredSetupChanges);
    return () => onProfileSurfaceDirtyChange(false);
  }, [hasUserAuthoredSetupChanges, onProfileSurfaceDirtyChange]);

  const previousStepRef = useRef(profileSetupState.currentStep);
  useEffect(() => {
    const advancing = previousStepRef.current !== profileSetupState.currentStep;
    previousStepRef.current = profileSetupState.currentStep;
    const frameId = window.requestAnimationFrame(() => {
      focusProfileSetupStepHeading(document, advancing);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [profileSetupState.currentStep]);

  const {
    currentStepReviewItems,
    focusedReviewItemId,
    focusedReviewRequestKey,
    goToStep,
    handleEditReviewItem,
    handleSaveCurrentStep,
    handleSaveStep,
  } = useProfileSetupScreenActions({
    draftAwareReviewItems,
    hasUnsavedChanges: hasUnsavedSetupChanges,
    onContinueToProfile,
    onResumeSetup,
    onSaveSetupStep: (nextProfile, nextPreferences, nextStep, options) => {
      markOwnSave(nextProfile, nextPreferences);
      onSaveSetupStep(nextProfile, nextPreferences, nextStep, options);
    },
    resumeApplicationMode: selectedResumeApplicationMode,
    preferencesFormValues: () => preferencesForm.getValues(),
    profile,
    profileFormValues: () => profileForm.getValues(),
    profileSetupCurrentStep: profileSetupState.currentStep,
    searchPreferences,
    setValidationMessage,
  });

  // A complete address typed into Job targets' add-source form counts as a
  // source the person meant to add; every save from the footer adds it first
  // instead of dropping it.
  const pendingSourceFlushRef = useRef<(() => void) | null>(null);
  const registerPendingSourceFlush = useCallback(
    (flush: (() => void) | null) => {
      pendingSourceFlushRef.current = flush;
    },
    [],
  );
  const flushPendingSource = () => {
    pendingSourceFlushRef.current?.();
  };
  const runningImportProgress = getRunningResumeImportProgress(
    latestResumeImportRun,
  );
  const isImportResumePending =
    localImportPending || runningImportProgress !== null;
  const resumeImportProgress = localImportProgress ?? runningImportProgress;
  const interruptedImportMessage =
    latestResumeImportRun?.status === "failed" && !isImportResumePending
      ? isInterruptedResumeImport(latestResumeImportRun)
        ? RESUME_IMPORT_INTERRUPTED_MESSAGE
        : latestResumeImportRun.errorMessage
      : null;
  const interruptedImportFileName = canRetrySavedResumeImport(
    latestResumeImportRun,
  )
    ? (latestResumeImportRun?.sourceResumeFileName ?? null)
    : null;
  const pendingCurrentStepReviewItems = currentStepReviewItems.filter(
    (item) => item.status === "pending",
  );
  const starterQuestion = buildCopilotStarterQuestion(
    pendingCurrentStepReviewItems,
  );
  const hasImportedResume = profile.baseResume.extractionStatus === "ready";
  const isPristineSetup =
    profileSetupState.status === "not_started" && !hasImportedResume;
  const profileSetupLayoutClassNames = getProfileSetupLayoutClassNames({
    hasPendingReviewItems: pendingCurrentStepReviewItems.length > 0,
    isPristineSetup,
  });
  // A null progress event means the native file browser is still open (or a
  // local pending lifecycle has gone stale). Keep editing/recovery available
  // in that phase; once the importer reports a real pipeline stage, protect
  // the draft from concurrent canonical writes.
  const isResumeImportProcessing =
    isImportResumePending && resumeImportProgress !== null;
  const setupMutationPending =
    isProfileSetupPending || isResumeImportProcessing;
  const setupActionsDisabledReason = isResumeImportProcessing
    ? "Resume import is updating this workspace. Wait for it to finish before editing or reviewing profile details."
    : null;
  // Guided setup as the person sees it, for the assistant (ADR 0037).
  useAssistantContextSource("profile-setup", () => {
    const dirtyPaths = [
      ...flattenDirtyFields(profileForm.formState.dirtyFields),
      ...flattenDirtyFields(preferencesForm.formState.dirtyFields),
    ];
    return {
      sectionLabel: formatProfileSetupStepLabel(profileSetupState.currentStep),
      editor: {
        editor: "profile",
        savedRevision: null,
        draftVersion: dirtyPaths.length,
        dirtyFields: [
          ...new Set(dirtyPaths.map(profileFieldForEditorPath)),
        ].slice(0, 80),
        unsavedValues: {},
        section: profileSetupState.currentStep,
        selection: null,
      },
    };
  });

  // Canonical readiness derivation: every visible setup count reads this one
  // presentation model, so the summary card and sticky footer cannot diverge
  // when a canonical blocker and a pending review item coexist.
  const pathReadiness = useMemo(
    () => evaluateProfileSetupReadiness(draftProfile, draftSearchPreferences),
    [draftProfile, draftSearchPreferences],
  );
  const readinessPresentation = useMemo(
    () =>
      buildProfileSetupReadinessPresentation({
        readiness: pathReadiness,
        reviewItems: draftAwareReviewItems,
      }),
    [draftAwareReviewItems, pathReadiness],
  );
  const canFinishSetup = readinessPresentation.remainingBlockerCount === 0;
  // Named, not counted: the stepper chips already carry the per-step review
  // counts, so the footer states what is missing in words, and says which
  // step to open when it is not the one on screen.
  const remainingBlockerLabels = useMemo(() => {
    const currentStep = profileSetupState.currentStep;
    const whereToGo = (step: ProfileSetupStep) =>
      step === currentStep
        ? ""
        : ` (${formatProfileSetupStepLabel(step)} step)`;
    return [
      ...readinessPresentation.blockers.map(
        (blocker) =>
          `${getProfileSetupReadinessBlockerLabel(blocker.id)}${whereToGo(
            getProfileSetupReadinessBlockerStep(blocker.id),
          )}`,
      ),
      ...draftAwareReviewItems
        .filter(
          (item) =>
            isFinishBlockingReviewItem(item) &&
            !isReadinessCoveredSetupReviewItem(item),
        )
        .map((item) => {
          const label = getProfileSetupReviewItemCopy(item).label;
          const verb = isProfileSetupMissingFieldReviewItem(item)
            ? "Fill in"
            : "Confirm";
          return `${verb} ${label.charAt(0).toLowerCase()}${label.slice(1)}${whereToGo(item.step)}`;
        }),
    ];
  }, [
    draftAwareReviewItems,
    profileSetupState.currentStep,
    readinessPresentation,
  ]);

  const reviewQueue = (
    <ProfileSetupReviewQueueCard
      compact={profileSetupState.currentStep === "targeting"}
      getSavedValue={(item) =>
        summarizeSavedSetupReviewValue(profile, searchPreferences, item)
      }
      actionsDisabledReason={
        setupActionsDisabledReason ??
        (hasUserDraftChanges
          ? setupMutationPending
            ? savingSetupReviewActionsMessage
            : unsavedSetupReviewActionsMessage
          : null)
      }
      isReviewItemPending={isReviewItemPending}
      items={currentStepReviewItems}
      latestResumeImportReviewCandidates={latestResumeImportReviewCandidates}
      onApplyReviewAction={onApplyProfileSetupReviewAction}
      onEditReviewItem={handleEditReviewItem}
    />
  );

  // A merge that kept the person's edits needs nothing from them, so it is
  // a toast; a conflict needs a choice and stays as a box (ADR 0042).
  const { showToast } = useToast();
  useEffect(() => {
    if (!backgroundMergeNotice || hasBackgroundConflict) return;
    showToast({
      id: "profile-background-merge",
      title: "Profile updated in the background",
      description:
        "Your unsaved edits were kept. Check the merged fields before saving.",
    });
  }, [backgroundMergeNotice, hasBackgroundConflict, showToast]);

  return (
    <LockedScreenLayout
      bottomContent={
        isPristineSetup ? null : (
          <ProfileSetupStepFooter
            canFinishSetup={canFinishSetup}
            currentStep={profileSetupState.currentStep}
            hasUnsavedChanges={hasUnsavedSetupChanges}
            hasUserEdits={hasUserDraftChanges}
            isProfileSetupPending={setupMutationPending}
            onSaveAndFinish={() => {
              flushPendingSource();
              handleSaveStep("targeting", { finishSetup: true });
            }}
            onSaveAndGoToStep={(step) => {
              flushPendingSource();
              handleSaveStep(step);
            }}
            onSaveCurrentStep={() => {
              flushPendingSource();
              handleSaveCurrentStep();
            }}
            remainingBlockerLabels={remainingBlockerLabels}
            validationMessage={validationMessage}
          />
        )
      }
      contentClassName={getProfileSetupContentClassName(isPristineSetup)}
      lockTopContent={!isPristineSetup}
      scrollResetKey={profileSetupState.currentStep}
      topClassName={getProfileSetupTopClassName(isPristineSetup)}
      topContent={
        <>
          <PageHeader
            actions={
              // First run opens guided setup directly, so setup owns the way
              // back out of it.
              <div className="flex flex-wrap items-center gap-2">
                <AskAssistantButton prompt={starterQuestion ?? undefined} />
                <Button
                  onClick={() => {
                    markGuidedSetupAutoOpenSpent();
                    void navigate("/job-finder");
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Back to Home
                </Button>
              </div>
            }
            title="Guided setup"
            description={
              // The import card under the title already says what setup
              // does with a resume; this line said it first, again.
              isPristineSetup
                ? "Your profile is what Job Finder searches and applies with."
                : "Work through each step; you can return to any step later."
            }
          />

          {isPristineSetup ? null : (
            <ProfileSetupPathCard
              currentStep={profileSetupState.currentStep}
              disabled={setupMutationPending}
              hasImportedResume={hasImportedResume}
              onGoToStep={(step) => {
                flushPendingSource();
                goToStep(step);
              }}
              profileSetupState={profileSetupState}
              unsavedSteps={[
                ...flattenDirtyFields(profileForm.formState.dirtyFields).map(
                  (path): ProfileSetupStep =>
                    path.startsWith("identity.") || path.startsWith("summary.")
                      ? "essentials"
                      : path.startsWith("records.")
                        ? "background"
                        : path.startsWith("eligibility.")
                          ? "targeting"
                          : "extras",
                ),
                ...(preferencesForm.formState.isDirty
                  ? ["targeting" as const]
                  : []),
              ]}
              readiness={pathReadiness}
              reviewItems={draftAwareReviewItems}
            />
          )}

          {/* Setup opens on the first step that needs the person, so what
              the last import left behind is said here, on every step, not
              only on the Import step it skips. */}
          {isPristineSetup ||
          profileSetupState.currentStep === "import" ? null : (
            <ProfileSetupImportNotice
              onImportResume={onImportResume}
              resumeImportProgress={resumeImportProgress}
              importDisabledReason={importResumeGuardMessage}
              isAnalyzeProfilePending={isAnalyzeProfilePending}
              isImportResumePending={isImportResumePending}
              latestResumeImportRun={latestResumeImportRun}
              {...(onAnalyzeProfileFromResume
                ? { onAnalyzeProfileFromResume }
                : {})}
              {...(onRetryInterruptedImport
                ? { onRetryInterruptedImport }
                : {})}
              profile={profile}
            />
          )}

          {backgroundMergeNotice && hasBackgroundConflict ? (
            <div
              className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-4 py-3 text-sm leading-6 text-(--warning-text)"
              role="status"
            >
              <span>{backgroundMergeNotice}</span>
              {hasBackgroundConflict ? (
                <Button
                  onClick={discardEditsAndReloadCanonical}
                  size="compact"
                  type="button"
                  variant="outline"
                >
                  Discard my edits and reload
                </Button>
              ) : null}
            </div>
          ) : null}

          {isPristineSetup ? (
            <div
              className={profileSetupLayoutClassNames.summary}
              data-profile-setup-summary-layout="pristine"
            >
              <ProfileSetupSummaryCards
                actionMessage={actionState.message}
                interruptedImportMessage={interruptedImportMessage}
                interruptedImportFileName={interruptedImportFileName}
                {...(onRetryInterruptedImport
                  ? { onRetryInterruptedImport }
                  : {})}
                importDisabledReason={importResumeGuardMessage}
                isImportResumePending={isImportResumePending}
                isProfileSetupPending={isProfileSetupPending}
                resumeImportProgress={resumeImportProgress}
                hasImportedResume={hasImportedResume}
                onImportResume={onImportResume}
                onStartManually={() => {
                  if (isImportResumePending) {
                    onCancelImportResume();
                  }
                  goToStep("essentials");
                }}
                profileSetupState={profileSetupState}
              />
            </div>
          ) : null}
        </>
      }
    >
      {isPristineSetup ? null : (
        <div
          className={`${profileSetupLayoutClassNames.content} min-h-0`}
          data-profile-setup-content-layout={
            pendingCurrentStepReviewItems.length > 0
              ? "review-rail"
              : "wide-editor"
          }
        >
          {profileSetupState.currentStep === "targeting" ? reviewQueue : null}
          <div
            className="grid gap-6 min-h-0 scroll-mt-4 sm:scroll-mt-[8.25rem] xl:scroll-mt-[4.5rem]"
            id="profile-setup-step-editor"
            tabIndex={-1}
          >
            <h2
              className="sr-only"
              id={PROFILE_SETUP_STEP_HEADING_ID}
              tabIndex={-1}
            >
              {formatProfileSetupStepLabel(profileSetupState.currentStep)} setup
              step
            </h2>
            {/* F31: the import used to freeze this whole editor for ~36s.
                Only a real setup save disables the fields now. During an
                import the user keeps typing into their own draft while the
                footer's Save stays disabled and says why, so no canonical
                write can race the import's revision-guarded finalization and
                no typed work is thrown away. */}
            <fieldset
              className="m-0 min-w-0 border-0 p-0 disabled:opacity-80"
              disabled={isProfileSetupPending}
            >
              <ProfileSetupStepEditor
                backgroundArrays={backgroundArrays}
                currentStepReviewItems={currentStepReviewItems}
                currentStep={profileSetupState.currentStep}
                experienceArray={experienceArray}
                draftProfile={draftProfile}
                draftSearchPreferences={draftSearchPreferences}
                focusedReviewItemId={focusedReviewItemId}
                focusedReviewRequestKey={focusedReviewRequestKey}
                hasUnsavedChanges={hasUnsavedSetupChanges}
                inlineFooter={false}
                importDisabledReason={importResumeGuardMessage ?? null}
                interruptedImportMessage={interruptedImportMessage}
                interruptedImportFileName={interruptedImportFileName}
                {...(onRetryInterruptedImport
                  ? { onRetryInterruptedImport }
                  : {})}
                isImportResumePending={isImportResumePending}
                isProfileSetupPending={setupMutationPending}
                latestResumeImportReviewCandidates={
                  latestResumeImportReviewCandidates
                }
                latestResumeImportRun={latestResumeImportRun}
                resumeImportProgress={resumeImportProgress}
                onContinueToProfile={onContinueToProfile}
                onImportResume={onImportResume}
                onSaveCurrentStep={handleSaveCurrentStep}
                onSaveAndGoToStep={(step) => handleSaveStep(step)}
                onResumeApplicationModeChange={setSelectedResumeApplicationMode}
                registerPendingSourceFlush={registerPendingSourceFlush}
                {...(onRunSourceDebug ? { onRunSourceDebug } : {})}
                profile={profile}
                profileForm={profileForm}
                profileSetupReviewItems={draftAwareReviewItems}
                preferencesForm={preferencesForm}
                resumeApplicationMode={selectedResumeApplicationMode}
                searchPreferences={searchPreferences}
                recentSourceDebugRuns={recentSourceDebugRuns}
                validationMessage={validationMessage}
              />
            </fieldset>
          </div>

          <div className={profileSetupLayoutClassNames.reviewRail}>
            {profileSetupState.currentStep !== "targeting" ? reviewQueue : null}
          </div>
        </div>
      )}
    </LockedScreenLayout>
  );
}
