import type { CandidateProfile } from "@nestor/contracts";
import {
  describeResumeIdentityOwnershipChoice,
  resolveResumeIdentity,
} from "@nestor/job-finder/resume-identity";
import { Button } from "@renderer/components/ui/button";

// A quiet note, never a warning (N-020): resumes always print the profile's
// name and contact details, so nothing waits on the person. One click
// dismisses it for good.
export function ResumeIdentityChoiceNotice(props: {
  profile: CandidateProfile;
  onKeepResumeName: () => void;
  onUseProfileName: () => void;
}) {
  const resolution = resolveResumeIdentity(props.profile);
  if (resolution.mismatchReasons.length === 0) {
    return null;
  }

  const choice = describeResumeIdentityOwnershipChoice(props.profile);
  const sourceName = choice.sourceFullName ?? "the imported resume";
  const profileName = choice.profileFullName ?? "your profile";
  const comparable = (value: string | null) =>
    (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const profileEmail = resolution.identity.email;
  // Only the email differs (the person changed it after importing): the
  // name-choice sentence read "the resume says Morgan Lee while your profile
  // says Morgan Lee", and neither name button was the question.
  const emailOnly =
    comparable(choice.sourceFullName) === comparable(choice.profileFullName) &&
    Boolean(choice.sourceEmail && profileEmail) &&
    comparable(choice.sourceEmail) !== comparable(profileEmail);

  if (emailOnly) {
    return (
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-(length:--text-small) leading-5 text-foreground-soft"
        data-testid="resume-identity-choice"
        role="status"
      >
        <p className="min-w-0">
          Your imported resume&apos;s email is “{choice.sourceEmail}” and your
          profile uses “{profileEmail}”. Resumes and applications use your
          profile&apos;s email.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={props.onUseProfileName}
            size="compact"
            type="button"
            variant="ghost"
          >
            Got it
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-(length:--text-small) leading-5 text-foreground-soft"
      data-testid="resume-identity-choice"
      role="status"
    >
      <p className="min-w-0">
        Your imported resume says “{sourceName}” and your profile says “
        {profileName}”. Resumes use your profile name.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={props.onUseProfileName}
          size="compact"
          type="button"
          variant="ghost"
        >
          Got it
        </Button>
        <Button
          onClick={props.onKeepResumeName}
          size="compact"
          type="button"
          variant="ghost"
        >
          Use “{sourceName}” instead
        </Button>
      </div>
    </div>
  );
}
