import type {
  DiscoveryRunRecord,
  EditableSourceInstructionArtifact,
  SourceAccessPrompt,
  SourceDebugRunDetails,
  SourceDebugRunRecord,
  SourceInstructionArtifact,
} from "@nestor/contracts";
import type { ReactNode } from "react";
import type { UseFieldArrayReturn, UseFormReturn } from "react-hook-form";
import { ProfileBackgroundTab } from "./profile-background-tab";
import { ProfileCoreTab } from "./profile-core-tab";
import { ProfileExperienceTab } from "./profile-experience-tab";
import { ProfileFilesTab } from "./profile-files-tab";
import { ProfileJobSourcesTab } from "./profile-job-sources-tab";
import { ProfilePreferencesTab } from "./profile-preferences-tab";
import type {
  ProfileEditorValues,
  SearchPreferencesEditorValues,
} from "../../lib/profile-editor";
import type {
  ProfileBackgroundArrays,
  ProfileFieldArrayKeyName,
} from "./profile-field-array-types";
import type { ProfileSection } from "../../lib/profile-screen-progress";

interface ProfileActiveSectionContentProps {
  activeSection: ProfileSection;
  /** Profile › Files preselects this kind (`?kind=` from a file card). */
  requestedFileKind?: string | null;
  /** The Job sources filter a link asked for (`show=` in the route). */
  requestedSourceFilter?: string | null;
  backgroundArrays: ProfileBackgroundArrays;
  /** Discovery runs used to classify source health exactly like Home does. */
  activeDiscoveryRun?: DiscoveryRunRecord | null;
  discoveryRuns?: readonly DiscoveryRunRecord[];
  experienceArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "records.experiences",
    ProfileFieldArrayKeyName
  >;
  isBrowserSessionPending: (targetId: string) => boolean;
  isProfileMutationPending: boolean;
  isSourceDebugPending: (targetId: string) => boolean;
  isSourceInstructionPending: (targetId: string) => boolean;
  isSourceInstructionVerifyPending: (instructionId: string) => boolean;
  isTargetDiscoveryPending: (targetId: string) => boolean;
  onGetSourceDebugRunDetails: (runId: string) => Promise<SourceDebugRunDetails>;
  onOpenBrowserSessionForTarget: (targetId: string) => void;
  onRunDiscoveryForTarget?: (targetId: string) => void;
  onSaveNow?: () => void;
  onRunSourceDebug: (
    targetId: string,
    options?: { readabilityTimeoutMs?: number },
  ) => void;
  onSaveSourceInstructionArtifact: (
    targetId: string,
    artifact: EditableSourceInstructionArtifact,
  ) => void;
  onVerifySourceInstructions: (targetId: string, instructionId: string) => void;
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
  profileForm: UseFormReturn<ProfileEditorValues>;
  recentSourceDebugRuns: readonly SourceDebugRunRecord[];
  sourceAccessPrompts: readonly SourceAccessPrompt[];
  sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
}

export function ProfileActiveSectionContent({
  activeSection,
  backgroundArrays,
  activeDiscoveryRun = null,
  discoveryRuns = [],
  experienceArray,
  isBrowserSessionPending,
  isProfileMutationPending,
  isSourceDebugPending,
  isSourceInstructionPending,
  isSourceInstructionVerifyPending,
  isTargetDiscoveryPending,
  onGetSourceDebugRunDetails,
  onOpenBrowserSessionForTarget,
  onRunDiscoveryForTarget,
  onSaveNow,
  onRunSourceDebug,
  onSaveSourceInstructionArtifact,
  onVerifySourceInstructions,
  preferencesForm,
  profileForm,
  recentSourceDebugRuns,
  requestedFileKind = null,
  requestedSourceFilter = null,
  sourceAccessPrompts,
  sourceInstructionArtifacts,
}: ProfileActiveSectionContentProps) {
  const content: Record<ProfileSection, ReactNode> = {
    basics: <ProfileCoreTab profileForm={profileForm} />,
    experience: (
      <ProfileExperienceTab
        experienceArray={experienceArray}
        profileForm={profileForm}
      />
    ),
    background: (
      <ProfileBackgroundTab
        backgroundArrays={backgroundArrays}
        profileForm={profileForm}
      />
    ),
    preferences: (
      <ProfilePreferencesTab
        busy={isProfileMutationPending}
        preferencesForm={preferencesForm}
        profileForm={profileForm}
        customAnswerArray={backgroundArrays.customAnswerArray}
      />
    ),
    files: <ProfileFilesTab requestedKind={requestedFileKind ?? null} />,
    sources: (
      <ProfileJobSourcesTab
        requestedFilter={requestedSourceFilter}
        activeDiscoveryRun={activeDiscoveryRun}
        discoveryRuns={discoveryRuns}
        isBrowserSessionPending={isBrowserSessionPending}
        isSourceDebugPending={isSourceDebugPending}
        isSourceInstructionPending={isSourceInstructionPending}
        isSourceInstructionVerifyPending={isSourceInstructionVerifyPending}
        isTargetDiscoveryPending={isTargetDiscoveryPending}
        onGetSourceDebugRunDetails={onGetSourceDebugRunDetails}
        onOpenBrowserSessionForTarget={onOpenBrowserSessionForTarget}
        {...(onRunDiscoveryForTarget ? { onRunDiscoveryForTarget } : {})}
        {...(onSaveNow ? { onSaveNow } : {})}
        onRunSourceDebug={onRunSourceDebug}
        onSaveSourceInstructionArtifact={onSaveSourceInstructionArtifact}
        onVerifySourceInstructions={onVerifySourceInstructions}
        preferencesForm={preferencesForm}
        recentSourceDebugRuns={recentSourceDebugRuns}
        sourceAccessPrompts={sourceAccessPrompts}
        sourceInstructionArtifacts={sourceInstructionArtifacts}
      />
    ),
  };

  return content[activeSection];
}
