import { getRunningResumeImportProgress } from "@renderer/features/job-finder/lib/profile-resume-panel-utils";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import type {
  CandidateProfile,
  DiscoveryRunRecord,
  EditableSourceInstructionArtifact,
  JobFinderRendererWorkspaceSnapshot,
  JobSearchPreferences,
  ProfileSetupState,
  ProfileSetupReviewActionOptions,
  ProfileSetupStep,
  ResumeImportFieldCandidateSummary,
  ResumeImportProgressEvent,
  ResumeApplicationMode,
  ResumeApproach,
  ResumeImportRun,
  ProfileOverview,
  ResumeTimelineRepairAction,
  SourceDebugRunDetails,
  SourceDebugRunRecord,
  SourceInstructionArtifact,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import {
  describeResumeIdentityOwnershipChoice,
  useResumeSourceNameForProfile,
} from "@nestor/job-finder/resume-identity";
import { buildComparableValueFingerprint } from "../lib/profile-editor-review-candidates";
import { LockedScreenLayout } from "../components/locked-screen-layout";
import { ProfileActiveSectionContent } from "../components/profile/profile-active-section-content";
import { DiscoveryRunFeedbackCallout } from "./discovery/discovery-run-feedback-callout";
import type { DiscoveryRunFeedback } from "./discovery/discovery-run-feedback";
import {
  PROFILE_SECTION_SCROLL_AREA_ID,
  focusProfileDeepLink,
  resetProfileSectionScroll,
  type ProfileDeepLinkFocus,
} from "../components/profile/profile-deep-link-focus";
import { buildProfileSectionStarterQuestion } from "../components/profile/profile-copilot-prompts";
import { ProfileResumePanel } from "../components/profile/profile-resume-panel";
import { ProfileReadyBanner } from "../components/profile/profile-ready-banner";
import {
  focusProfileImportSuggestion,
  getProfileImportSuggestionDestination,
} from "../components/profile/profile-import-suggestion-navigation";
import { ProfileSaveFooter } from "../components/profile/profile-save-footer";
import { ProfileSetupReviewQueueCard } from "../components/profile/setup/profile-setup-screen-sections";
import { formatProfileSetupReviewValue } from "../components/profile/setup/profile-setup-screen-helpers";
import {
  areEquivalentExperienceRecords,
  areEquivalentEducationRecords,
} from "@nestor/job-finder/resume-record-identity";
import { getJobFinderScrollBehavior } from "../lib/job-finder-scroll-behavior";

import { ResumeIdentityChoiceNotice } from "../components/profile/resume-identity-choice-notice";
import { ProfileSectionTabs } from "../components/profile/profile-section-tabs";
import { useProfileSetupStatusItem } from "../components/profile/profile-setup-reminder";
import {
  PageHeaderStack,
  type PageStatusItem,
} from "../components/page-header";
import {
  buildProfilePayload,
  buildSearchPreferencesPayload,
} from "../lib/profile-editor";
import type { ProfileSection } from "../lib/profile-screen-progress";
import {
  buildCanonicalAwareProfilePayload,
  useProfileScreenForms,
} from "./profile-screen-hooks";
import { AskAssistantButton } from "../assistant/ask-assistant-button";
import { useAssistantContextSource } from "../assistant/assistant-provider";
import {
  flattenDirtyFields,
  profileFieldForEditorPath,
} from "../assistant/assistant-context-capture";

const unsavedProfileSourceActionMessage =
  "Save your current profile and source setup before running source checks or searches so those actions use the latest saved configuration.";
const unsavedProfileSourceSignInMessage =
  "Save this source before opening a sign-in session so the browser uses the latest saved source entry.";

function parseProfileSection(value: string | null): ProfileSection | null {
  switch (value) {
    case "basics":
    case "experience":
    case "background":
    case "preferences":
    case "sources":
    case "files":
      return value;
    default:
      return null;
  }
}

type ProfileScreenPendingActions = {
  analyzeProfile: boolean;
  browserSession: (targetId: string) => boolean;
  importResume: boolean;
  profileCopilotBusy: boolean;
  profileMutation: boolean;
  profileSetup: boolean;
  profileReviewItem: (reviewItemId: string) => boolean;
  sourceDebug: (targetId: string) => boolean;
  sourceInstruction: (targetId: string) => boolean;
  sourceInstructionVerify: (instructionId: string) => boolean;
  targetDiscovery: (targetId: string) => boolean;
};

export function ProfileScreen(props: {
  recordPaging?: ReactNode;
  recordStatus?: ReactNode;
  recordSummary?: Pick<ProfileOverview, "counts" | "experienceRequired">;
  sourceInfo?: { hasResumeText: boolean; hasSavedResumeFile: boolean };
  actionState: { message: string | null };
  discoveryRunFeedback?: DiscoveryRunFeedback | null;
  importResumeGuardMessage: string | null;
  pendingActions: ProfileScreenPendingActions;
  onApplyProfileSetupReviewAction: (
    reviewItemId: string,
    action: "confirm" | "dismiss" | "clear_value",
    options?: ProfileSetupReviewActionOptions,
  ) => void;
  onAnalyzeProfileFromResume: () => void;
  onGetSourceDebugRunDetails: (runId: string) => Promise<SourceDebugRunDetails>;
  onImportResume: () => void;
  /** Imports again the file a stopped import saved; no file picker. */
  onRetryInterruptedImport?: () => void;
  onApplyResumeTimelineRepairAction: (
    runId: string,
    proposalId: string,
    action: ResumeTimelineRepairAction,
  ) => Promise<void>;
  onOpenBrowserSessionForTarget: (targetId: string) => void;
  onProfileSurfaceDirtyChange: (dirty: boolean) => void;
  /**
   * Reports each user-authored draft edit so the shell can retire an
   * exact-request save retry captured before the edit.
   */
  onProfileSurfaceDraftEdited?: () => void;
  onResumeProfileSetup: (step?: ProfileSetupStep) => void;
  onRunDiscoveryForTarget?: (targetId: string) => void;
  onRunSourceDebug: (
    targetId: string,
    options?: { readabilityTimeoutMs?: number },
  ) => void;
  onSaveSourceInstructionArtifact: (
    targetId: string,
    artifact: EditableSourceInstructionArtifact,
  ) => void;
  onSaveAll: (
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
    savedSection?: "sources",
  ) => void;
  onVerifySourceInstructions: (targetId: string, instructionId: string) => void;
  latestResumeImportReviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  latestResumeImportRun: ResumeImportRun | null;
  resumeImportProgress: ResumeImportProgressEvent | null;
  profile: CandidateProfile;
  profileSetupState: ProfileSetupState;
  /**
   * Discovery runs behind source health. The Job sources tab classifies from
   * the same evidence as the Home badge, so both screens agree.
   */
  activeDiscoveryRun?: DiscoveryRunRecord | null;
  discoveryRuns?: readonly DiscoveryRunRecord[];
  recentSourceDebugRuns: readonly SourceDebugRunRecord[];
  /** The resume level preference lives in Profile (Preferences tab). */
  resumeApplicationMode?: ResumeApplicationMode | null | undefined;
  onUpdateResumeApproach?: (
    approach: ResumeApproach,
  ) => Promise<boolean | void> | void;
  searchPreferences: JobSearchPreferences;
  sourceAccessPrompts: JobFinderRendererWorkspaceSnapshot["sourceAccessPrompts"];
  sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
}) {
  const {
    importResumeGuardMessage,
    pendingActions,
    discoveryRunFeedback = null,
    onAnalyzeProfileFromResume,
    onGetSourceDebugRunDetails,
    onImportResume,
    onApplyResumeTimelineRepairAction,
    onOpenBrowserSessionForTarget,
    onProfileSurfaceDirtyChange,
    onProfileSurfaceDraftEdited,
    onResumeProfileSetup,
    onRunDiscoveryForTarget,
    onRunSourceDebug,
    onSaveSourceInstructionArtifact,
    onSaveAll,
    onVerifySourceInstructions,
    latestResumeImportReviewCandidates,
    latestResumeImportRun,
    resumeImportProgress,
    profile,
    profileSetupState,
    activeDiscoveryRun = null,
    discoveryRuns = [],
    recentSourceDebugRuns,
    resumeApplicationMode,
    onUpdateResumeApproach,
    searchPreferences,
    sourceAccessPrompts,
    sourceInstructionArtifacts,
  } = props;

  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const requestedSection = searchParams.get("section");
  const requestedFocus = searchParams.get("focus");
  const [activeSection, setActiveSection] = useState<ProfileSection>(
    parseProfileSection(requestedSection) ?? "basics",
  );
  const pendingImportSuggestionRef =
    useRef<ResumeImportFieldCandidateSummary | null>(null);
  const [importSuggestionFocusRequest, setImportSuggestionFocusRequest] =
    useState(0);
  const {
    backgroundArrays,
    backgroundMergeNotice,
    discardEditsAndReloadCanonical,
    draftSearchPreferencesResult,
    experienceArray,
    hasBackgroundConflict,
    hasUnsavedChanges,
    hasUserDraftChanges,
    overviewProfile,
    preferencesForm,
    profileForm,
    sections: pageSections,
    setValidationMessage,
    validationMessage,
  } = useProfileScreenForms({
    latestResumeImportReviewCandidates,
    ...(onProfileSurfaceDraftEdited
      ? { onDraftEdited: onProfileSurfaceDraftEdited }
      : {}),
    profile,
    searchPreferences,
  });
  const sections = pageSections.map((section) => {
    const summary = props.recordSummary;
    if (!summary) return section;
    if (section.id === "experience") {
      const current = profileForm.getValues().records.experiences;
      const filled = (
        rows: readonly {
          title?: string | null;
          companyName?: string | null;
          startDate?: string | null;
        }[],
      ) =>
        rows.reduce(
          (sum, row) =>
            sum +
            [row.title, row.companyName, row.startDate].filter((value) =>
              value?.trim(),
            ).length,
          0,
        );
      const required = {
        filled:
          summary.experienceRequired.filled +
          filled(current) -
          filled(profile.experiences),
        total: Math.max(
          1,
          (summary.counts.experiences +
            current.length -
            profile.experiences.length) *
            3,
        ),
      };
      return { ...section, progress: { ...section.progress, required } };
    }
    if (
      section.id === "background" &&
      Object.entries(summary.counts).some(
        ([kind, count]) => kind !== "experiences" && count > 0,
      )
    )
      return { ...section, progress: { filled: 1, total: 1, percent: 100 } };
    return section;
  });

  useEffect(() => {
    onProfileSurfaceDirtyChange(hasUserDraftChanges);
    return () => onProfileSurfaceDirtyChange(false);
  }, [hasUserDraftChanges, onProfileSurfaceDirtyChange]);

  // A freshly mounted section already starts at the top; resetting it on
  // mount only forced a layout of the whole new screen.
  const scrolledSectionRef = useRef(activeSection);
  useEffect(() => {
    if (scrolledSectionRef.current === activeSection) return;
    scrolledSectionRef.current = activeSection;
    resetProfileSectionScroll();
  }, [activeSection]);

  useEffect(() => {
    const candidate = pendingImportSuggestionRef.current;
    if (!candidate) {
      return;
    }

    let focusFrame = 0;
    let attemptsRemaining = 12;
    const focusWhenReady = () => {
      const review = document.getElementById(
        `profile-import-review-${candidate.id}`,
      );
      if (review) {
        review.scrollIntoView?.({
          behavior: getJobFinderScrollBehavior(window),
          block: "center",
        });
        review.focus({ preventScroll: true });
        pendingImportSuggestionRef.current = null;
        return;
      }
      if (focusProfileImportSuggestion(candidate)) {
        pendingImportSuggestionRef.current = null;
        return;
      }

      if (attemptsRemaining <= 0) {
        return;
      }

      attemptsRemaining -= 1;
      focusFrame = window.requestAnimationFrame(focusWhenReady);
    };

    focusFrame = window.requestAnimationFrame(focusWhenReady);
    return () => window.cancelAnimationFrame(focusFrame);
  }, [activeSection, importSuggestionFocusRequest]);

  useEffect(() => {
    const parsedSection = parseProfileSection(requestedSection);
    if (!parsedSection) {
      return;
    }

    const requestedDeepLink =
      requestedFocus === "job-sources" ||
      requestedFocus === "target-roles" ||
      requestedFocus === "work-modes"
        ? (requestedFocus as ProfileDeepLinkFocus)
        : null;
    const destinationSection =
      requestedDeepLink === "job-sources"
        ? "sources"
        : requestedDeepLink === "target-roles" ||
            requestedDeepLink === "work-modes"
          ? "preferences"
          : parsedSection;

    if (activeSection !== destinationSection) {
      setActiveSection(destinationSection);
      return;
    }

    if (!requestedDeepLink) {
      return;
    }

    let focusFrame = 0;
    let attemptsRemaining = 12;
    const focusWhenReady = () => {
      if (focusProfileDeepLink(requestedDeepLink) || attemptsRemaining <= 0) {
        return;
      }

      attemptsRemaining -= 1;
      focusFrame = window.requestAnimationFrame(focusWhenReady);
    };
    const renderFrame = window.requestAnimationFrame(focusWhenReady);

    return () => {
      window.cancelAnimationFrame(renderFrame);
      window.cancelAnimationFrame(focusFrame);
    };
  }, [activeSection, requestedFocus, requestedSection]);

  const activeSectionPanelId = "profile-section-panel";
  const pendingSetupItems = profileSetupState.reviewItems.filter(
    (item) => item.status === "pending",
  );
  const importCandidateById = new Map(
    latestResumeImportReviewCandidates.map((candidate) => [
      candidate.id,
      candidate,
    ]),
  );
  const sectionReviewItems = pendingSetupItems
    .filter((item) => {
      const candidate = item.sourceCandidateId
        ? importCandidateById.get(item.sourceCandidateId)
        : null;
      return (
        candidate &&
        getProfileImportSuggestionDestination(candidate).section ===
          activeSection
      );
    })
    .map((item) => ({
      ...item,
      savedStatus: item.status,
      statusSource: "saved" as const,
    }));
  // The renderer receives no progress event until a native picker has
  // returned a file. Treat that picker-only phase as recoverable rather than
  // freezing every profile field behind an unresolved local pending flag.
  const runningImportProgress = getRunningResumeImportProgress(
    latestResumeImportRun,
  );
  const importProgress = resumeImportProgress ?? runningImportProgress;
  const importPending =
    pendingActions.importResume || runningImportProgress !== null;
  const isResumeImportProcessing = importPending && importProgress !== null;
  const resumeAnalysisPending =
    isResumeImportProcessing || pendingActions.analyzeProfile;
  // Unfinished setup and a running resume update are conditions shown on
  // the header status line, not cards above the tabs (ADR 0044).
  const setupStatusItem = useProfileSetupStatusItem({
    currentStep: profileSetupState.currentStep,
    enabled: profileSetupState.status !== "completed",
    isResumePending: pendingActions.profileSetup,
    onResume: onResumeProfileSetup,
    pendingItemCount: pendingSetupItems.length,
  });
  const profileStatusItems: PageStatusItem[] = [
    ...(setupStatusItem ? [setupStatusItem] : []),
    ...(resumeAnalysisPending
      ? [
          {
            id: "resume-update",
            tone: "info" as const,
            text: "Editing is paused while your resume update finishes, so the import cannot overwrite a draft made at the same time.",
          },
        ]
      : []),
  ];
  // Job sources and Files hold no profile facts, so the assistant talks about
  // preferences while either tab is open.
  const copilotSection =
    activeSection === "sources" || activeSection === "files"
      ? "preferences"
      : activeSection;
  // The profile editor as the person sees it, for the assistant (ADR 0037):
  // the section, and the fields with unsaved edits and their values.
  useAssistantContextSource("profile-editor", () => {
    const dirtyPaths = [
      ...flattenDirtyFields(profileForm.formState.dirtyFields),
      ...flattenDirtyFields(preferencesForm.formState.dirtyFields),
    ];
    const dirtyFields = [...new Set(dirtyPaths.map(profileFieldForEditorPath))];
    const values = {
      ...profileForm.getValues(),
      ...preferencesForm.getValues(),
    } as Record<string, unknown>;
    const unsavedValues: Record<string, unknown> = {};
    for (const root of new Set(
      dirtyPaths.map((path) => path.split(".")[0] ?? path),
    )) {
      if (Object.keys(unsavedValues).length >= 20) break;
      const value: unknown = values[root];
      if (JSON.stringify(value ?? "").length < 4_000)
        unsavedValues[root] = value;
    }
    return {
      sectionLabel: activeSection,
      editor: {
        editor: "profile",
        savedRevision: null,
        draftVersion: dirtyPaths.length,
        dirtyFields: dirtyFields.slice(0, 80),
        unsavedValues,
        section: copilotSection,
        selection: null,
      },
    };
  });
  const starterQuestion = buildProfileSectionStarterQuestion(
    profileSetupState.reviewItems,
    copilotSection,
  );

  const savedTargetsById = new Map(
    searchPreferences.discovery.targets.map((target) => [target.id, target]),
  );
  const draftTargets = preferencesForm.watch("discoveryTargets");
  // Asked only when a source action is pressed: fingerprinting the saved and
  // draft preferences (every source included) on each render cost about 20 ms
  // per Profile render.
  const hasUnsavedSearchPreferenceChanges = () =>
    preferencesForm.formState.isDirty ||
    buildComparableValueFingerprint(searchPreferences) !==
      buildComparableValueFingerprint(
        draftSearchPreferencesResult.payload ?? searchPreferences,
      );
  const identityChoiceProfile =
    buildProfilePayload(profile, profileForm.getValues()).payload ??
    overviewProfile;

  function hasUnsavedSourceRowChanges(targetId: string) {
    const savedTarget = savedTargetsById.get(targetId);
    const draftTarget = draftTargets.find((target) => target.id === targetId);

    if (!savedTarget || !draftTarget) {
      return false;
    }

    return (
      buildComparableValueFingerprint(savedTarget) !==
      buildComparableValueFingerprint({ ...draftTarget })
    );
  }

  function handleSignInForTarget(targetId: string) {
    if (hasUnsavedSourceRowChanges(targetId)) {
      setValidationMessage(unsavedProfileSourceSignInMessage);
      return;
    }

    setValidationMessage(null);
    onOpenBrowserSessionForTarget(targetId);
  }

  function handleRunDiscoveryForTarget(targetId: string) {
    if (hasUnsavedSearchPreferenceChanges()) {
      setValidationMessage(unsavedProfileSourceActionMessage);
      return;
    }

    setValidationMessage(null);
    onRunDiscoveryForTarget?.(targetId);
  }

  function handleRunSourceDebug(
    targetId: string,
    options?: { readabilityTimeoutMs?: number },
  ) {
    if (hasUnsavedSearchPreferenceChanges()) {
      setValidationMessage(unsavedProfileSourceActionMessage);
      return;
    }

    setValidationMessage(null);
    onRunSourceDebug(targetId, options);
  }

  // Per-source Search now outcomes are shown next to the source rows that
  // started them; all-source outcomes stay on the Find jobs screen.
  const sourceRowFeedbackTargetId =
    activeSection === "sources" && discoveryRunFeedback?.targetLabel
      ? (searchPreferences.discovery.targets.find(
          (target) => target.label === discoveryRunFeedback.targetLabel,
        )?.id ?? null)
      : null;
  const [dismissedSourceFeedbackKey, setDismissedSourceFeedbackKey] = useState<
    string | null
  >(null);
  const sourceFeedbackKey =
    discoveryRunFeedback && sourceRowFeedbackTargetId
      ? `${discoveryRunFeedback.status}|${discoveryRunFeedback.headline}|${sourceRowFeedbackTargetId}`
      : null;
  const visibleSourceRowFeedback =
    activeSection === "sources" &&
    discoveryRunFeedback !== null &&
    discoveryRunFeedback.targetLabel !== null &&
    sourceRowFeedbackTargetId !== null &&
    sourceFeedbackKey !== dismissedSourceFeedbackKey
      ? discoveryRunFeedback
      : null;

  function handleSaveAll() {
    const profileResult = buildCanonicalAwareProfilePayload({
      draftValues: profileForm.getValues(),
      dirtyFields: profileForm.formState.dirtyFields,
      latestResumeImportReviewCandidates,
      profile,
    });

    if (!profileResult.payload) {
      setValidationMessage(
        profileResult.validationMessage ?? "Profile data is invalid.",
      );
      return;
    }

    const preferencesResult = buildSearchPreferencesPayload(
      searchPreferences,
      preferencesForm.getValues(),
    );

    if (!preferencesResult.payload) {
      setValidationMessage(
        preferencesResult.validationMessage ??
          "Search preferences are invalid.",
      );
      return;
    }

    setValidationMessage(null);
    onSaveAll(
      profileResult.payload,
      preferencesResult.payload,
      activeSection === "sources" ? "sources" : undefined,
    );
  }

  function handleResumeIdentityChoice(choice: "profile_name" | "resume_name") {
    const profileResult = buildCanonicalAwareProfilePayload({
      draftValues: profileForm.getValues(),
      dirtyFields: profileForm.formState.dirtyFields,
      latestResumeImportReviewCandidates,
      profile,
    });
    const preferencesResult = buildSearchPreferencesPayload(
      searchPreferences,
      preferencesForm.getValues(),
    );
    if (!profileResult.payload || !preferencesResult.payload) {
      setValidationMessage(
        profileResult.validationMessage ??
          preferencesResult.validationMessage ??
          "Save the valid profile fields before choosing a resume name.",
      );
      return;
    }

    const nextProfile =
      choice === "profile_name"
        ? {
            ...profileResult.payload,
            resumeIdentityOwnership: describeResumeIdentityOwnershipChoice(
              profileResult.payload,
            ).acknowledgement,
          }
        : useResumeSourceNameForProfile(profileResult.payload);
    setValidationMessage(null);
    onSaveAll(nextProfile, preferencesResult.payload);
  }

  function handleReviewImportSuggestion(
    candidate: ResumeImportFieldCandidateSummary,
  ) {
    pendingImportSuggestionRef.current = candidate;
    setActiveSection(getProfileImportSuggestionDestination(candidate).section);
    setImportSuggestionFocusRequest((current) => current + 1);
  }

  function handleSectionChange(section: ProfileSection) {
    setActiveSection(section);
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("section", section);
    nextSearchParams.delete("focus");
    setSearchParams(nextSearchParams, {
      replace: true,
      state: location.state as unknown,
    });
  }

  // A merge that kept the person's edits needs nothing from them, so it is
  // a toast; a conflict needs a choice and stays as the box below (ADR 0042).
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
      // F01: Profile's Save lived at the end of a ~5,400px page and was never
      // painted at any supported height, even with a dirty field. `bottomContent`
      // is the same always-pinned footer ownership guided setup already uses:
      // it sits outside the scroll area as a flex sibling, so the primary
      // action is inside the viewport at 1024x720 and every larger size.
      bottomContent={
        <>
          {backgroundMergeNotice && hasBackgroundConflict ? (
            <div
              className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-(--warning-border) bg-(--warning-surface) px-4 py-2 text-sm leading-6 text-(--warning-text) sm:px-5"
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
          <ProfileSaveFooter
            // A prior successful save is stale once this save attempt is
            // rejected locally; keep the inline validation as the only
            // outcome so invalid input cannot look successfully saved.
            actionMessage={validationMessage ? null : props.actionState.message}
            hasUnsavedChanges={hasUnsavedChanges}
            hasUserEdits={hasUserDraftChanges}
            isSavePending={
              pendingActions.profileMutation || resumeAnalysisPending
            }
            onSave={handleSaveAll}
            validationMessage={validationMessage}
          />
        </>
      }
      contentClassName="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-2 pb-1 xl:overflow-clip"
      topClassName="grid gap-2 pb-1"
      topContent={
        <>
          <PageHeaderStack
            title="Profile"
            description="Everything Job Finder knows about you. Edit any field or ask the assistant."
            statusItems={profileStatusItems}
            actions={
              <AskAssistantButton
                prompt={starterQuestion ?? undefined}
                mention={{
                  kind: "profile_section",
                  id: copilotSection,
                  label: `Profile: ${copilotSection}`,
                }}
              />
            }
          />

          {profileSetupState.status === "completed" ? (
            <ProfileReadyBanner
              completedAt={profileSetupState.completedAt}
              completionIdentity={`${profile.id}:${profileSetupState.completedAt ?? "completed"}`}
            />
          ) : null}
        </>
      }
    >
      <section className="grid min-h-124 min-w-0 gap-(--gap-content) xl:h-full xl:min-h-0">
        <div className="grid min-h-0 min-w-0 gap-2 xl:grid-rows-[auto_minmax(0,1fr)]">
          {/* Clip without creating a scroll owner between the tabs and the
              route scroller, so the tabs stay pinned as the profile moves. */}
          <div className="sticky top-0 z-30 bg-(--background) shadow-[0_6px_16px_rgba(0,0,0,0.12)]">
            <ProfileSectionTabs
              activeSection={activeSection}
              onSectionChange={handleSectionChange}
              panelId={activeSectionPanelId}
              sections={sections}
            />
          </div>

          <div className="surface-panel-shell relative flex min-h-0 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border-active-soft)">
            <div
              className="min-h-0 flex-1 overflow-y-auto"
              data-locked-pane-scroll-region
              id={PROFILE_SECTION_SCROLL_AREA_ID}
            >
              {/* The collapsed Assistant is portalled into the pinned save
                  footer, so the compact resume strip needs no launcher
                  clearance. Keeping that old 4.5rem reservation here pushed
                  the selected editor out of Profile's first compact viewport. */}
              <div className="p-3 sm:px-4 sm:py-3">
                {/* F80/F17: the strip repeated on all five tabs, including
                    Job sources where the resume is irrelevant, and cost ~100px
                    of the first viewport on every one of them. It belongs to
                    the tabs whose content the resume actually fills. */}
                {activeSection === "sources" ? null : (
                  <ProfileResumePanel
                    {...(props.sourceInfo
                      ? { sourceInfo: props.sourceInfo }
                      : {})}
                    // Keep the resume source/status useful without allowing the
                    // imported-review surface to push the selected profile
                    // editor below the first viewport. The full review surface
                    // stays available below Basics when that tab is active.
                    compact
                    importDisabledReason={importResumeGuardMessage}
                    isProfileReady={profileSetupState.status === "completed"}
                    isAnalyzeProfilePending={pendingActions.analyzeProfile}
                    isImportResumePending={importPending}
                    latestResumeImportReviewCandidates={
                      latestResumeImportReviewCandidates
                    }
                    latestResumeImportRun={latestResumeImportRun}
                    resumeImportProgress={importProgress}
                    onAnalyzeProfileFromResume={onAnalyzeProfileFromResume}
                    onApplyTimelineRepairAction={(proposalId, action) => {
                      if (!latestResumeImportRun) {
                        return Promise.reject(
                          new Error(
                            "The resume import run is no longer available.",
                          ),
                        );
                      }
                      return onApplyResumeTimelineRepairAction(
                        latestResumeImportRun.id,
                        proposalId,
                        action,
                      );
                    }}
                    onImportResume={onImportResume}
                    {...(props.onRetryInterruptedImport
                      ? {
                          onRetryInterruptedImport:
                            props.onRetryInterruptedImport,
                        }
                      : {})}
                    onReviewImportSuggestion={handleReviewImportSuggestion}
                    profileForm={profileForm}
                    profile={overviewProfile}
                  />
                )}
              </div>
              <div
                aria-labelledby={`${activeSection}-tab`}
                className="relative z-0 p-3 sm:px-4 sm:py-3"
                id={activeSectionPanelId}
                role="tabpanel"
              >
                {sectionReviewItems.length > 0 ? (
                  <div className="mb-4">
                    <ProfileSetupReviewQueueCard
                      compact
                      title="Review imported suggestions"
                      description="Compare the resume details with your saved profile, then confirm or dismiss each suggestion."
                      actionsDisabledReason={
                        hasUserDraftChanges
                          ? "Save your profile changes before reviewing imported suggestions."
                          : pendingActions.profileMutation ||
                              pendingActions.profileSetup ||
                              resumeAnalysisPending
                            ? "Wait for the current profile update to finish."
                            : null
                      }
                      isReviewItemPending={pendingActions.profileReviewItem}
                      items={sectionReviewItems}
                      latestResumeImportReviewCandidates={
                        latestResumeImportReviewCandidates
                      }
                      onApplyReviewAction={
                        props.onApplyProfileSetupReviewAction
                      }
                      getSavedValue={(item) => {
                        const candidate = item.sourceCandidateId
                          ? importCandidateById.get(item.sourceCandidateId)
                          : null;
                        if (candidate?.target.section === "experience") {
                          const saved = profile.experiences.find(
                            (record) =>
                              record.id === candidate.target.recordId ||
                              areEquivalentExperienceRecords(
                                record,
                                candidate.value,
                              ),
                          );
                          return saved
                            ? formatProfileSetupReviewValue({
                                ...saved,
                                isDraft: null,
                              })
                            : "No saved role matches this suggestion.";
                        }
                        if (candidate?.target.section === "education") {
                          const saved = profile.education.find(
                            (record) =>
                              record.id === candidate.target.recordId ||
                              areEquivalentEducationRecords(
                                record,
                                candidate.value,
                              ),
                          );
                          return saved
                            ? formatProfileSetupReviewValue({
                                ...saved,
                                isDraft: null,
                              })
                            : "No saved education matches this suggestion.";
                        }
                        return null;
                      }}
                      onEditReviewItem={(item) => {
                        const candidate = item.sourceCandidateId
                          ? importCandidateById.get(item.sourceCandidateId)
                          : null;
                        if (candidate) focusProfileImportSuggestion(candidate);
                      }}
                    />
                  </div>
                ) : null}
                {visibleSourceRowFeedback && sourceRowFeedbackTargetId ? (
                  <div className="mb-3">
                    <DiscoveryRunFeedbackCallout
                      feedback={visibleSourceRowFeedback}
                      isRecoveryPending={pendingActions.browserSession(
                        sourceRowFeedbackTargetId,
                      )}
                      onDismiss={() =>
                        setDismissedSourceFeedbackKey(sourceFeedbackKey)
                      }
                      onOpenBrowserSession={() => {
                        handleSignInForTarget(sourceRowFeedbackTargetId);
                      }}
                    />
                  </div>
                ) : null}
                {activeSection === "basics" ? (
                  <div className="mb-3">
                    <ResumeIdentityChoiceNotice
                      onKeepResumeName={() =>
                        handleResumeIdentityChoice("resume_name")
                      }
                      onUseProfileName={() =>
                        handleResumeIdentityChoice("profile_name")
                      }
                      profile={identityChoiceProfile}
                    />
                  </div>
                ) : null}
                <fieldset
                  className="m-0 min-w-0 border-0 p-0 disabled:opacity-80"
                  disabled={resumeAnalysisPending}
                >
                  {props.recordPaging}
                  {props.recordStatus ?? (
                    <ProfileActiveSectionContent
                      activeSection={activeSection}
                      requestedFileKind={searchParams.get("kind")}
                      requestedSourceFilter={searchParams.get("show")}
                      activeDiscoveryRun={activeDiscoveryRun}
                      onSaveNow={handleSaveAll}
                      backgroundArrays={backgroundArrays}
                      discoveryRuns={discoveryRuns}
                      experienceArray={experienceArray}
                      isBrowserSessionPending={pendingActions.browserSession}
                      isProfileMutationPending={
                        pendingActions.profileMutation || resumeAnalysisPending
                      }
                      isSourceDebugPending={pendingActions.sourceDebug}
                      isSourceInstructionPending={
                        pendingActions.sourceInstruction
                      }
                      isSourceInstructionVerifyPending={
                        pendingActions.sourceInstructionVerify
                      }
                      isTargetDiscoveryPending={pendingActions.targetDiscovery}
                      onGetSourceDebugRunDetails={onGetSourceDebugRunDetails}
                      onOpenBrowserSessionForTarget={handleSignInForTarget}
                      {...(onRunDiscoveryForTarget
                        ? {
                            onRunDiscoveryForTarget:
                              handleRunDiscoveryForTarget,
                          }
                        : {})}
                      onRunSourceDebug={handleRunSourceDebug}
                      onSaveSourceInstructionArtifact={
                        onSaveSourceInstructionArtifact
                      }
                      onVerifySourceInstructions={onVerifySourceInstructions}
                      preferencesForm={preferencesForm}
                      profileForm={profileForm}
                      {...(onUpdateResumeApproach
                        ? {
                            onResumeApproachChange: onUpdateResumeApproach,
                            resumeApplicationMode,
                          }
                        : {})}
                      recentSourceDebugRuns={recentSourceDebugRuns}
                      sourceAccessPrompts={sourceAccessPrompts}
                      sourceInstructionArtifacts={sourceInstructionArtifacts}
                    />
                  )}
                </fieldset>
                {activeSection === "basics" ? (
                  <div
                    className="mt-6 [content-visibility:auto] [contain-intrinsic-size:auto_480px]"
                    data-profile-resume-review
                  >
                    <ProfileResumePanel
                      {...(props.sourceInfo
                        ? { sourceInfo: props.sourceInfo }
                        : {})}
                      importDisabledReason={importResumeGuardMessage}
                      isProfileReady={profileSetupState.status === "completed"}
                      isAnalyzeProfilePending={pendingActions.analyzeProfile}
                      isImportResumePending={importPending}
                      latestResumeImportReviewCandidates={
                        latestResumeImportReviewCandidates
                      }
                      latestResumeImportRun={latestResumeImportRun}
                      resumeImportProgress={importProgress}
                      onAnalyzeProfileFromResume={onAnalyzeProfileFromResume}
                      onApplyTimelineRepairAction={(proposalId, action) => {
                        if (!latestResumeImportRun) {
                          return Promise.reject(
                            new Error(
                              "The resume import run is no longer available.",
                            ),
                          );
                        }
                        return onApplyResumeTimelineRepairAction(
                          latestResumeImportRun.id,
                          proposalId,
                          action,
                        );
                      }}
                      onImportResume={onImportResume}
                      onReviewImportSuggestion={handleReviewImportSuggestion}
                      profileForm={profileForm}
                      profile={overviewProfile}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>
    </LockedScreenLayout>
  );
}
