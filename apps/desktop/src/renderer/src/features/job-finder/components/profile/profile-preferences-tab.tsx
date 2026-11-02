import type { UseFormReturn } from "react-hook-form";
import type { ResumeApplicationMode, ResumeApproach } from "@nestor/contracts";
import type {
  ProfileEditorValues,
  SearchPreferencesEditorValues,
} from "../../lib/profile-editor";
import { ProfilePreferencesEligibilitySection } from "./profile-preferences-eligibility-section";
import { ProfilePreferencesTargetingSection } from "./profile-preferences-sections";
import { ProfileResumeLevelSection } from "./profile-resume-level-section";
import type { ProfileBackgroundArrays } from "./profile-field-array-types";

interface ProfilePreferencesTabProps {
  busy: boolean;
  limitedPermissionArray: ProfileBackgroundArrays["limitedPermissionArray"];
  onResumeApproachChange?: (
    approach: ResumeApproach,
  ) => Promise<boolean | void> | void;
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
  profileForm: UseFormReturn<ProfileEditorValues>;
  resumeApplicationMode?: ResumeApplicationMode | null | undefined;
}

export function ProfilePreferencesTab({
  busy,
  limitedPermissionArray,
  onResumeApproachChange,
  preferencesForm,
  profileForm,
  resumeApplicationMode,
}: ProfilePreferencesTabProps) {
  return (
    // One column no wider than the pane: an auto column grew to the
    // sections' own width at larger text, running the fields past the edge.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <ProfilePreferencesEligibilitySection
        busy={busy}
        limitedPermissionArray={limitedPermissionArray}
        profileForm={profileForm}
      />
      <ProfilePreferencesTargetingSection preferencesForm={preferencesForm} />
      {onResumeApproachChange ? (
        <ProfileResumeLevelSection
          onResumeApproachChange={onResumeApproachChange}
          preferencesForm={preferencesForm}
          resumeApplicationMode={resumeApplicationMode}
        />
      ) : null}
    </div>
  );
}
