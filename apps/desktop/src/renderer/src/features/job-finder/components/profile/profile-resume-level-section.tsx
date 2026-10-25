import { useEffect, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useWatch } from "react-hook-form";
import type { ResumeApplicationMode, ResumeApproach } from "@nestor/contracts";
import {
  ChoiceCards,
  type ChoiceCardOption,
} from "../choice-cards";
import type { SearchPreferencesEditorValues } from "../../lib/profile-editor";
import { ProfileSectionHeader } from "./profile-section-header";
import {
  RESUME_APPROACH_OPTIONS,
  STRONG_REWRITE_WARNING,
} from "./profile-tailoring-copy";

const resumeApproachOptions: readonly ChoiceCardOption<ResumeApproach>[] = [
  {
    id: "original_resume",
    label: "Original",
    detail: "Your file, unchanged.",
  },
  {
    id: "conservative",
    label: "Light",
    detail: "Small edits. Every fact kept.",
  },
  {
    id: "balanced",
    label: "Tailored",
    detail: "Fuller rewrite. Every fact kept.",
  },
  {
    id: "aggressive",
    label: "Aggressive",
    detail: "May stretch, with your say-so.",
  },
];

function describeResumeApproach(approach: ResumeApproach): string {
  return (
    RESUME_APPROACH_OPTIONS.find((option) => option.value === approach)
      ?.description ?? ""
  );
}

interface ProfileResumeLevelSectionProps {
  onResumeApproachChange: (
    approach: ResumeApproach,
  ) => Promise<boolean | void> | void;
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
  resumeApplicationMode?: ResumeApplicationMode | null | undefined;
}

/**
 * The resume level preference: Original, Light, Tailored or Aggressive.
 * It lives in Profile and saves the moment it is picked. Picking a strength
 * also updates the preferences form's copy, so saving the form afterwards
 * can never write the older strength back over this choice.
 */
export function ProfileResumeLevelSection({
  onResumeApproachChange,
  preferencesForm,
  resumeApplicationMode,
}: ProfileResumeLevelSectionProps) {
  const tailoringMode = useWatch({
    control: preferencesForm.control,
    name: "tailoringMode",
  });
  const savedApproach: ResumeApproach =
    resumeApplicationMode === "original_resume"
      ? "original_resume"
      : tailoringMode;
  const [approach, setApproach] = useState<ResumeApproach>(savedApproach);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    setApproach(savedApproach);
  }, [savedApproach]);

  const pickApproach = (next: ResumeApproach) => {
    const previous = approach;
    setApproach(next);
    setSaveFailed(false);
    if (next !== "original_resume") {
      preferencesForm.setValue("tailoringMode", next, {
        shouldDirty: false,
        shouldTouch: false,
        shouldValidate: false,
      });
    }
    const revert = () => {
      setApproach(previous);
      if (previous !== "original_resume") {
        preferencesForm.setValue("tailoringMode", previous, {
          shouldDirty: false,
          shouldTouch: false,
          shouldValidate: false,
        });
      }
      setSaveFailed(true);
    };
    try {
      void Promise.resolve(onResumeApproachChange(next)).then((saved) => {
        if (saved === false) revert();
      }, revert);
    } catch {
      revert();
    }
  };

  return (
    <section className="grid min-w-0 gap-3" data-testid="profile-resume-level">
      <ProfileSectionHeader
        title="Resume level"
        description="How far a resume for a job may go from the one you imported. This is the level new shortlisted jobs use."
      />
      <ChoiceCards
        aria-label="Resume level"
        columns={4}
        onChange={pickApproach}
        options={resumeApproachOptions}
        value={approach}
      />
      {approach === "aggressive" ? (
        <p className="text-sm leading-6 text-(--warning-text)" role="status">
          {STRONG_REWRITE_WARNING}
        </p>
      ) : (
        <p className="text-(length:--text-small) leading-5 text-foreground-soft">
          {describeResumeApproach(approach)}
        </p>
      )}
      {saveFailed ? (
        <p className="text-(length:--text-small) leading-5 text-foreground-soft">
          This was not saved. Pick the level again.
        </p>
      ) : null}
    </section>
  );
}
