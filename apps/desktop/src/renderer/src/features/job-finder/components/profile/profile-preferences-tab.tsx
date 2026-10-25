import type { UseFormReturn } from "react-hook-form";
import type { ResumeApplicationMode, ResumeApproach } from "@nestor/contracts";
import type {
  ProfileEditorValues,
  SearchPreferencesEditorValues,
} from "../../lib/profile-editor";
import { ProfilePreferencesEligibilitySection } from "./profile-preferences-eligibility-section";
import { ProfilePreferencesTargetingSection } from "./profile-preferences-sections";
import { ProfileResumeLevelSection } from "./profile-resume-level-section";

interface ProfilePreferencesTabProps {
  busy: boolean;
  onResumeApproachChange?: (
    approach: ResumeApproach,
  ) => Promise<boolean | void> | void;
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
  profileForm: UseFormReturn<ProfileEditorValues>;
  resumeApplicationMode?: ResumeApplicationMode | null | undefined;
}

export function ProfilePreferencesTab({
  busy,
  onResumeApproachChange,
  preferencesForm,
  profileForm,
  resumeApplicationMode,
}: ProfilePreferencesTabProps) {
  return (
    <div className="grid gap-6">
      <ProfilePreferencesEligibilitySection
        busy={busy}
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
