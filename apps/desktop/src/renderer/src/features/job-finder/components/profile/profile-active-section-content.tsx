import type {
  EditableSourceInstructionArtifact,
  ResumeApplicationMode,
  ResumeApproach,
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
  experienceArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "records.experiences",
    ProfileFieldArrayKeyName
  >;
  isProfileMutationPending: boolean;
  isSourceDebugPending: (targetId: string) => boolean;
  isSourceInstructionPending: (targetId: string) => boolean;
  onSaveNow?: () => void;
  onRunSourceDebug: (
    targetId: string,
    options?: { readabilityTimeoutMs?: number },
  ) => void;
  onSaveSourceInstructionArtifact: (
    targetId: string,
    artifact: EditableSourceInstructionArtifact,
  ) => void;
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
  profileForm: UseFormReturn<ProfileEditorValues>;
  onResumeApproachChange?: (
    approach: ResumeApproach,
  ) => Promise<boolean | void> | void;
  resumeApplicationMode?: ResumeApplicationMode | null | undefined;
  sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
}

export function ProfileActiveSectionContent({
  activeSection,
  backgroundArrays,
  experienceArray,
  isProfileMutationPending,
  isSourceDebugPending,
  isSourceInstructionPending,
  onRunSourceDebug,
  onSaveSourceInstructionArtifact,
  onResumeApproachChange,
  preferencesForm,
  profileForm,
  requestedFileKind = null,
  resumeApplicationMode,
  requestedSourceFilter = null,
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
        {...(onResumeApproachChange
          ? { onResumeApproachChange, resumeApplicationMode }
          : {})}
      />
    ),
    files: <ProfileFilesTab requestedKind={requestedFileKind ?? null} />,
    sources: (
      <ProfileJobSourcesTab
        requestedFilter={requestedSourceFilter}
        isSourceDebugPending={isSourceDebugPending}
        isSourceInstructionPending={isSourceInstructionPending}
        onRunSourceDebug={onRunSourceDebug}
        onSaveSourceInstructionArtifact={onSaveSourceInstructionArtifact}
        sourceInstructionArtifacts={sourceInstructionArtifacts}
      />
    ),
  };

  return content[activeSection];
}
