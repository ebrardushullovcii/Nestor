import { ProfileHoursField } from "../profile-hours-field";
import { SetupSites } from "@renderer/features/job-lists/setup-sites";
import { useId, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@renderer/lib/cn";
import { formatProfileSetupReviewValue } from "./profile-setup-screen-helpers";
import {
  type CandidateProfile,
  type ProfileSetupStep,
  type ResumeApplicationMode,
  type ResumeImportFieldCandidateSummary,
  type ResumeImportProgressEvent,
  type ResumeImportRun,
  workModeValues,
} from "@nestor/contracts";
import { getResumeImportStageFallbackNotes } from "../profile-resume-panel";
import { getResumeImportStageFallbackSummary } from "../resume-import-quality-note";
import type { UseFormReturn } from "react-hook-form";
import { Controller } from "react-hook-form";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@renderer/components/ui/card";
import { FieldLabel } from "@renderer/components/ui/field";
import { CheckboxField } from "../../checkbox-field";
import { FormSelect } from "../../form-select";
import {
  formatStatusLabel,
  joinListInput,
  parseListInput,
} from "../../../lib/job-finder-utils";
import type { BooleanSelectValue } from "../../../lib/job-finder-types";
import type {
  ProfileEditorValues,
  SearchPreferencesEditorValues,
} from "../../../lib/profile-editor";
import {
  ProfileTextarea,
  profileSelectTriggerClassName,
} from "../profile-form-primitives";
import { ProfileBasicsFields } from "../profile-basics-fields";
import {
  parseProfileLocationDraft,
  ProfileListEditor,
} from "../profile-list-editor";
import { PROFILE_WORK_CONSTRAINT_COPY } from "../profile-work-constraints-copy";
import { ResumeImportProgress } from "../resume-import-progress";

const booleanSelectOptions = [
  { label: "Not set", value: "" },
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
] as const;

function getImportConflictSummary(
  candidate: ResumeImportFieldCandidateSummary,
): string | null {
  if ((candidate.conflictChoices?.length ?? 0) < 2) {
    return null;
  }

  const sourceLabels = Array.from(
    new Set(
      (candidate.conflictChoices ?? []).map((choice) => choice.sourceLabel),
    ),
  );
  return sourceLabels.length > 0
    ? `Compare ${sourceLabels.join(" and ")} before confirming.`
    : "Compare imported alternatives before confirming.";
}

function SetupBooleanField(props: {
  control: UseFormReturn<ProfileEditorValues>["control"];
  description?: string;
  id?: string;
  label: string;
  name:
    | "eligibility.remoteEligible"
    | "eligibility.requiresVisaSponsorship"
    | "eligibility.willingToRelocate"
    | "eligibility.willingToTravel";
}) {
  const generatedId = useId();
  const fieldId = props.id ?? generatedId;
  const descriptionId = `${fieldId}-help`;

  return (
    <Controller
      control={props.control}
      name={props.name}
      render={({ field }) => (
        <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
          <FieldLabel htmlFor={fieldId}>{props.label}</FieldLabel>
          <FormSelect
            onValueChange={(value) =>
              field.onChange(value as BooleanSelectValue)
            }
            options={booleanSelectOptions.map((option) => ({ ...option }))}
            placeholder="Not set"
            {...(props.description
              ? { triggerAriaDescribedBy: descriptionId }
              : {})}
            triggerClassName={profileSelectTriggerClassName}
            triggerId={fieldId}
            value={field.value}
          />
          {props.description ? (
            <p
              className="text-(length:--text-body) leading-6 text-foreground"
              id={descriptionId}
            >
              {props.description}
            </p>
          ) : null}
        </div>
      )}
    />
  );
}

interface FooterOptions {
  nextLabel?: string;
  onPrimary?: (() => void | Promise<void>) | null;
  primaryDisabled?: boolean;
  primaryLabel?: string;
}

export type RenderFooter = (options?: FooterOptions) => ReactNode;

function describeImportedProfile(profile: CandidateProfile): string[] {
  const parts: string[] = [];
  const hasName = Boolean(
    profile.fullName?.trim() || profile.firstName?.trim(),
  );
  const hasContact = Boolean(profile.email?.trim() || profile.phone?.trim());
  if (hasName && hasContact) {
    parts.push("Name and contact");
  } else if (hasName) {
    parts.push("Name");
  } else if (hasContact) {
    parts.push("Contact");
  }
  if (profile.headline?.trim()) {
    parts.push("Headline");
  }
  if (profile.summary?.trim()) {
    parts.push("Summary");
  }
  const roles = profile.experiences.length;
  if (roles > 0) {
    parts.push(`${roles} ${roles === 1 ? "role" : "roles"}`);
  }
  const schools = profile.education.length;
  if (schools > 0) {
    parts.push(`${schools} ${schools === 1 ? "school" : "schools"}`);
  }
  const skills = profile.skills.length;
  if (skills > 0) {
    parts.push(`${skills} ${skills === 1 ? "skill" : "skills"}`);
  }
  const links = profile.links.length;
  if (links > 0) {
    parts.push(`${links} ${links === 1 ? "link" : "links"}`);
  }
  return parts;
}

export function ProfileSetupImportStep(props: {
  importDisabledReason?: string | null;
  interruptedImportMessage?: string | null;
  interruptedImportFileName?: string | null;
  /** Imports that file again from the copy the stopped import saved. */
  onRetryInterruptedImport?: () => void;
  isImportResumePending: boolean;
  isProfileSetupPending: boolean;
  latestResumeImportReviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  latestResumeImportRun: ResumeImportRun | null;
  resumeImportProgress: ResumeImportProgressEvent | null;
  onContinueToProfile: () => void;
  onImportResume: () => void;
  onSaveAndGoToStep: (step: ProfileSetupStep) => void;
  profile: CandidateProfile;
  renderFooter: RenderFooter;
  /** Still passed by the shared step editor; the footer below already reports this count for every step. */
  reviewItemCount: number;
}) {
  // The visible import guard reason is associated with the import control so
  // assistive tech reads why the control cannot be used right now.
  const importDisabledReasonId = useId();
  const needsReadableText =
    props.profile.baseResume.extractionStatus === "needs_text";
  // Truthful detail straight from the persisted extraction warnings: deduped
  // and capped so recovery stays compact instead of turning into a log.
  const importRecoveryWarnings = needsReadableText
    ? Array.from(
        new Set(
          props.profile.baseResume.analysisWarnings
            .map((warning) => warning.trim())
            .filter(Boolean),
        ),
      ).slice(0, 2)
    : [];
  // The quality note used to live only near the bottom of the full Profile
  // screen in 11px uppercase mono, while this step said nothing but
  // "Ready" — so a degraded import read as a clean one. The note belongs
  // with the status it qualifies, in ordinary sentences.
  const importQualityNotes = getResumeImportStageFallbackNotes(
    props.profile.baseResume.analysisWarnings,
  );
  const importQualitySummary = getResumeImportStageFallbackSummary(
    props.latestResumeImportRun,
  );
  // One line that says what the import actually filled, so a person can see
  // at a glance whether their resume was read before they walk the steps.
  const importedProfileSummary =
    props.profile.baseResume.extractionStatus === "ready"
      ? describeImportedProfile(props.profile)
      : [];
  return (
    <Card className="rounded-(--radius-panel) border-border/40">
      <CardHeader className="gap-2 border-b border-border/30 pb-5">
        <CardTitle>Start with your resume</CardTitle>
        <CardDescription>
          Your resume fills in the profile. Anything unclear or missing shows up
          as a short list to confirm, so you never start from a blank form.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 pt-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-(--radius-field) border border-border/30 bg-background/60 p-4">
            <p className="text-(length:--text-tiny) uppercase tracking-[0.2em] text-muted-foreground">
              Imported file
            </p>
            <p className="mt-2 text-sm font-medium text-foreground">
              {props.profile.baseResume.fileName}
            </p>
          </div>
          <div className="rounded-(--radius-field) border border-border/30 bg-background/60 p-4">
            <p className="text-(length:--text-tiny) uppercase tracking-[0.2em] text-muted-foreground">
              Import status
            </p>
            <p className="mt-2 text-sm font-medium text-foreground">
              {formatStatusLabel(props.profile.baseResume.extractionStatus)}
            </p>
            {importQualitySummary ? (
              <p
                className="mt-1 text-sm leading-6 text-foreground-soft"
                data-profile-setup-import-quality-hint
              >
                {importQualitySummary.hint}.
              </p>
            ) : null}
          </div>
        </div>

        {importedProfileSummary.length > 0 ? (
          <div
            className="rounded-(--radius-field) border border-border/30 bg-background/60 p-4"
            data-profile-setup-import-summary
          >
            <p className="text-(length:--text-tiny) uppercase tracking-[0.2em] text-muted-foreground">
              What came from your resume
            </p>
            <p className="mt-2 text-sm leading-6 text-foreground">
              {importedProfileSummary.join(" · ")}
            </p>
          </div>
        ) : null}

        {importQualityNotes.length > 0 ? (
          <div
            className="grid gap-2 rounded-(--radius-field) border border-border/30 bg-background/60 p-4 text-sm leading-6 text-foreground-soft"
            data-profile-setup-import-quality-note
          >
            {importQualityNotes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        ) : null}

        {props.interruptedImportMessage ? (
          <div
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) p-3 text-sm leading-6 text-(--warning-text)"
            data-profile-setup-import-interrupted
            role="status"
          >
            <p className="min-w-0 flex-1 basis-80">
              {props.interruptedImportMessage}
            </p>
            {props.onRetryInterruptedImport &&
            props.interruptedImportFileName ? (
              <Button
                disabled={Boolean(props.importDisabledReason)}
                onClick={props.onRetryInterruptedImport}
                pending={props.isImportResumePending}
                size="compact"
                type="button"
                variant="outline"
              >
                Import {props.interruptedImportFileName} again
              </Button>
            ) : null}
          </div>
        ) : null}

        {needsReadableText ? (
          <div
            className="rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) p-3 text-sm leading-6 text-(--warning-text)"
            role="status"
          >
            <p className="font-semibold">
              The file was saved, but Job Finder could not read text from it, so
              nothing was extracted into your profile yet.
            </p>
            <p className="mt-1">
              Choose Import resume to try again — text-based PDFs, TXT, or
              Markdown files read most reliably — or continue by entering your
              details manually. You can also paste plain text into the resume
              from the full Profile screen.
            </p>
            {importRecoveryWarnings.length > 0 ? (
              <ul className="mt-2 grid list-none gap-1 border-t border-(--warning-border) pt-2 text-(length:--text-body) leading-6">
                {importRecoveryWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* Only the branch that carries a number says anything this card has
            not said: the other branch repeated the card description above it
            ("Import a resume first when you have one."). */}
        {props.latestResumeImportReviewCandidates.length > 0 ? (
          <div className="rounded-(--radius-field) border border-dashed border-border/40 bg-background/50 p-4 text-(length:--text-body) leading-6 text-foreground">
            {`Latest import kept ${props.latestResumeImportReviewCandidates.length} reviewable suggestion${props.latestResumeImportReviewCandidates.length === 1 ? "" : "s"} visible in setup.`}
          </div>
        ) : null}

        {props.latestResumeImportReviewCandidates.length > 0 ? (
          <div className="grid gap-2">
            {props.latestResumeImportReviewCandidates
              .slice(0, 4)
              .map((candidate) => (
                <div
                  className="rounded-(--radius-field) border border-border/25 bg-background/70 px-4 py-3"
                  key={candidate.id}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">
                      {candidate.label}
                    </p>
                    <Badge variant="outline">
                      {formatStatusLabel(candidate.resolution)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-foreground-soft">
                    {formatProfileSetupReviewValue(
                      candidate.value ?? candidate.valuePreview,
                    ) ??
                      candidate.evidenceText ??
                      "Review this imported suggestion."}
                  </p>
                  {(() => {
                    const conflictSummary = getImportConflictSummary(candidate);
                    return conflictSummary ? (
                      <p className="mt-1 text-(length:--text-body) leading-6 text-foreground-soft">
                        {conflictSummary}
                      </p>
                    ) : null;
                  })()}
                </div>
              ))}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button
            disabled={Boolean(props.importDisabledReason)}
            pending={props.isImportResumePending}
            onClick={props.onImportResume}
            type="button"
            aria-describedby={
              props.importDisabledReason ? importDisabledReasonId : undefined
            }
            variant={
              props.profile.baseResume.extractionStatus === "ready"
                ? "secondary"
                : "primary"
            }
          >
            {props.profile.baseResume.extractionStatus === "ready"
              ? "Replace resume"
              : "Import resume"}
          </Button>
          <Button
            className="border-(--border-strong)"
            onClick={props.onContinueToProfile}
            type="button"
            variant="ghost"
          >
            Open full Profile instead
          </Button>
        </div>
        {props.importDisabledReason ? (
          <p
            className="text-sm leading-6 text-foreground-soft"
            id={importDisabledReasonId}
          >
            {props.importDisabledReason}
          </p>
        ) : null}
        <ResumeImportProgress
          isPending={props.isImportResumePending}
          progress={props.resumeImportProgress}
        />

        {props.renderFooter({
          nextLabel: "Save and go to Basics",
          onPrimary: () => props.onSaveAndGoToStep("essentials"),
        })}
      </CardContent>
    </Card>
  );
}

export function ProfileSetupEssentialsStep(props: {
  nextStep: ProfileSetupStep | null;
  onSaveAndGoToStep: (step: ProfileSetupStep) => void;
  profileForm: UseFormReturn<ProfileEditorValues>;
  renderFooter: RenderFooter;
}) {
  return (
    <Card className="rounded-(--radius-panel) border-border/40">
      <CardHeader className="gap-2 border-b border-border/30 pb-5">
        <CardTitle>Basics</CardTitle>
        <CardDescription>
          Name, contact details, location, links, and summary. These go on every
          resume and application, and they are the same fields you will find
          later under Profile › Basics.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 pt-6">
        {/* One shared field list with Profile › Basics: same fields, same
            order, same labels. */}
        <ProfileBasicsFields
          idPrefix="profile-setup-field-identity"
          profileForm={props.profileForm}
        />

        {props.renderFooter({
          nextLabel: "Save and continue to Work history",
          onPrimary: () =>
            props.onSaveAndGoToStep(props.nextStep ?? "background"),
        })}
      </CardContent>
    </Card>
  );
}

/** One block of the Job targets step: a bordered group with its own heading. */
const SETUP_BLOCK_CLASS =
  "grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 p-4";

function SetupBlockHeading(props: { id: string; title: string; help: string }) {
  return (
    <div className="grid gap-1">
      <h3 className="text-sm font-semibold text-foreground" id={props.id}>
        {props.title}
      </h3>
      <p className="max-w-2xl text-sm leading-6 text-foreground-soft">
        {props.help}
      </p>
    </div>
  );
}

/** "United States, Germany" and "United States; Germany" are two countries. */
export function parseWorkCountriesDraft(value: string): string[] {
  return value
    .split(/[,;\r\n]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Past this many sites the setup list gets its finder and count. */

const SPONSORSHIP_OPTIONS = [
  { value: "no", label: "No" },
  { value: "yes", label: "Yes" },
] as const;

/**
 * The two answers almost every application form asks. They used to sit among
 * six optional "facts" below the fold, so setup finished without them and the
 * first application stopped on "Are you authorized to work here?", sending
 * the person to Profile › Preferences to answer what setup never asked.
 * Setup now asks them plainly and cannot finish without them; each takes one
 * press when the resume did not already say.
 */
export function SetupWorkEligibilityQuestions(props: {
  profileForm: UseFormReturn<ProfileEditorValues>;
  /** The country the person lives in, offered as a one-press answer. */
  suggestedCountry: string | null;
}) {
  const headingId = useId();
  const sponsorshipLabelId = useId();
  const countries = parseListInput(
    props.profileForm.watch("eligibility.authorizedWorkCountries"),
  );
  const sponsorship =
    props.profileForm.watch("eligibility.requiresVisaSponsorship") ?? "";
  const limitedPermissions =
    props.profileForm.watch("eligibility.limitedWorkPermissions") ?? [];
  const setCountries = (values: readonly string[]) =>
    props.profileForm.setValue(
      "eligibility.authorizedWorkCountries",
      joinListInput(values),
      { shouldDirty: true, shouldTouch: true, shouldValidate: true },
    );
  const suggestedCountry = props.suggestedCountry?.trim() || null;
  const answered =
    (countries.length > 0 ||
      limitedPermissions.some(
        (permission) =>
          permission.country.trim() && permission.conditions.trim(),
      )) &&
    sponsorship !== "";

  return (
    <section
      aria-labelledby={headingId}
      className={SETUP_BLOCK_CLASS}
      data-profile-setup-work-eligibility
      id="profile-setup-work-eligibility"
    >
      <div className="grid gap-1">
        <h3
          className="flex items-center gap-2 text-sm font-semibold text-foreground"
          id={headingId}
        >
          Two answers every application asks
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-(length:--text-small) font-medium",
              answered
                ? "border-(--surface-panel-border) text-foreground-soft"
                : "border-(--warning-text)/40 text-(--warning-text)",
            )}
          >
            Required
          </span>
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-foreground-soft">
          Job Finder checks each job against these countries and any limited
          permissions.
        </p>
      </div>
      <div className="grid gap-2">
        <ProfileListEditor
          draftParser={parseWorkCountriesDraft}
          emptyMessage="No countries yet."
          inputId="profile-setup-field-eligibility-authorized-work-countries"
          label={PROFILE_WORK_CONSTRAINT_COPY.authorizedWorkCountries.label}
          onChange={setCountries}
          placeholder="Add a country or region, e.g. Germany"
          values={countries}
        />
        {countries.length === 0 &&
        limitedPermissions.length === 0 &&
        suggestedCountry ? (
          <div className="flex flex-wrap items-center gap-2 px-1">
            <span className="text-sm text-foreground-soft">
              Where you live:
            </span>
            <Button
              data-profile-setup-work-country-suggestion
              onClick={() => setCountries([suggestedCountry])}
              size="sm"
              type="button"
              variant="outline"
            >
              I can work in {suggestedCountry}
            </Button>
          </div>
        ) : null}
        {limitedPermissions.length ? (
          <div className="grid gap-2 text-sm text-foreground-soft">
            <p className="font-medium">Limited work permission</p>
            {limitedPermissions.map((permission, index) => (
              <p key={index}>
                {permission.country}: {permission.conditions}
              </p>
            ))}
            <p>
              These conditions count as your answer. Each job is checked against
              them; this does not grant unrestricted permission.
            </p>
          </div>
        ) : null}
      </div>
      <div className="grid gap-2">
        <p
          className="text-(length:--text-field-label) font-medium tracking-(--tracking-label) text-muted-foreground"
          id={sponsorshipLabelId}
        >
          {PROFILE_WORK_CONSTRAINT_COPY.requiresVisaSponsorship.label}
        </p>
        <SegmentedControl
          aria-labelledby={sponsorshipLabelId}
          data-profile-setup-sponsorship
          // A review item about sponsorship scrolls here.
          id="profile-setup-field-eligibility-requires-visa-sponsorship"
          label={PROFILE_WORK_CONSTRAINT_COPY.requiresVisaSponsorship.label}
          onValueChange={(value) =>
            props.profileForm.setValue(
              "eligibility.requiresVisaSponsorship",
              value as BooleanSelectValue,
              { shouldDirty: true, shouldTouch: true, shouldValidate: true },
            )
          }
          options={SPONSORSHIP_OPTIONS}
          size="field"
          value={sponsorship as "" | "yes" | "no"}
        />
      </div>
    </section>
  );
}

export function ProfileSetupTargetingStep(props: {
  isProfileSetupPending?: boolean;
  nextStep: ProfileSetupStep | null;
  onSaveAndGoToStep: (step: ProfileSetupStep) => void;
  onResumeApplicationModeChange?: (mode: ResumeApplicationMode) => void;
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
  profileForm: UseFormReturn<ProfileEditorValues>;
  resumeApplicationMode?: ResumeApplicationMode;
  /**
   * Lets the screen add a complete address typed into the source form when
   * the person saves or finishes from the footer, instead of dropping it.
   */
  registerPendingSourceFlush?: (flush: (() => Promise<void>) | null) => void;
  renderFooter: RenderFooter;
  suggestedWorkCountry?: string | null;
}) {
  const locationPreferencesId = useId();
  const targetRolesId = "profile-setup-field-search-preferences-target-roles";
  const locationsId = "profile-setup-field-search-preferences-locations";
  const workModesGroupId = "profile-setup-field-search-preferences-work-modes";
  const workModesGuidanceId = `${workModesGroupId}-guidance`;
  const remoteEligibleId = "profile-setup-field-eligibility-remote-eligible";
  const willingToRelocateId =
    "profile-setup-field-eligibility-willing-to-relocate";
  const willingToTravelId = "profile-setup-field-eligibility-willing-to-travel";
  const listFieldOptions = {
    shouldDirty: true,
    shouldTouch: true,
    shouldValidate: true,
  } as const;
  const pendingSiteFlush = useRef<(() => Promise<void>) | null>(null);
  const registerSiteFlush = (flush: (() => Promise<void>) | null) => {
    pendingSiteFlush.current = flush;
    props.registerPendingSourceFlush?.(flush);
  };

  const workModes = props.preferencesForm.watch("workModes") ?? [];
  return (
    <Card className="rounded-(--radius-panel) border-border/40">
      <CardHeader className="gap-2 border-b border-border/30 pb-5">
        <CardTitle>Job targets</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 pt-6">
        <section
          aria-labelledby="profile-setup-look-for-heading"
          className={SETUP_BLOCK_CLASS}
          data-profile-setup-block="look-for"
        >
          <SetupBlockHeading
            help="Suggestions come from your resume. Change anything that is off."
            id="profile-setup-look-for-heading"
            title="What to look for"
          />
          <ProfileListEditor
            inputId={targetRolesId}
            label="Target roles"
            draftParser={parseProfileLocationDraft}
            onChange={(values) =>
              props.preferencesForm.setValue(
                "targetRoles",
                joinListInput(values),
                listFieldOptions,
              )
            }
            placeholder="Add a target role"
            values={parseListInput(props.preferencesForm.watch("targetRoles"))}
          />
          <div className="grid gap-(--gap-content) md:grid-cols-2">
            <ProfileListEditor
              label="Related role areas"
              onChange={(values) =>
                props.preferencesForm.setValue(
                  "jobFamilies",
                  joinListInput(values),
                  listFieldOptions,
                )
              }
              placeholder="e.g. Teaching Assistant"
              values={parseListInput(
                props.preferencesForm.watch("jobFamilies"),
              )}
            />
            <ProfileListEditor
              draftParser={parseProfileLocationDraft}
              inputId={locationsId}
              label="Preferred job locations"
              onChange={(values) =>
                props.preferencesForm.setValue(
                  "locations",
                  joinListInput(values),
                  listFieldOptions,
                )
              }
              placeholder="Example: Hamburg; Remote"
              values={parseListInput(props.preferencesForm.watch("locations"))}
            />
          </div>
          <fieldset
            aria-describedby={workModesGuidanceId}
            className="grid gap-(--gap-field)"
            id={workModesGroupId}
          >
            <legend className="text-(length:--text-field-label) font-medium tracking-(--tracking-label) text-muted-foreground">
              {PROFILE_WORK_CONSTRAINT_COPY.workModes.label}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {workModeValues.map((workMode) => (
                <Controller
                  control={props.preferencesForm.control}
                  key={workMode}
                  name="workModes"
                  render={({ field }) => {
                    const selectedWorkModes = field.value ?? [];
                    return (
                      <CheckboxField
                        checked={selectedWorkModes.includes(workMode)}
                        label={formatStatusLabel(workMode)}
                        onCheckedChange={(checked) =>
                          field.onChange(
                            checked
                              ? [...selectedWorkModes, workMode]
                              : selectedWorkModes.filter(
                                  (value) => value !== workMode,
                                ),
                          )
                        }
                      />
                    );
                  }}
                />
              ))}
            </div>
            {workModes.length === 0 ? (
              <p
                className="text-sm leading-6 text-(--warning-text)"
                id={workModesGuidanceId}
                role="status"
              >
                Choose at least one so searches know what to look for.
              </p>
            ) : workModes.includes("remote") &&
              props.profileForm.watch("eligibility.remoteEligible") === "" ? (
              <p
                className="text-sm leading-6 text-foreground-muted"
                id={workModesGuidanceId}
              >
                Remote is what you want; whether you can work remotely is under
                More about you.
              </p>
            ) : null}
          </fieldset>
          <ProfileHoursField
            values={parseListInput(
              props.preferencesForm.watch("employmentTypes"),
            )}
            onChange={(values) =>
              props.preferencesForm.setValue(
                "employmentTypes",
                joinListInput(values),
                { shouldDirty: true, shouldTouch: true, shouldValidate: true },
              )
            }
          />
        </section>

        <SetupSites registerFlush={registerSiteFlush} />

        {/* The resume level is chosen per job on Shortlisted (Original, Light,
            Tailored, Aggressive), so setup no longer asks for a default. */}
        <SetupWorkEligibilityQuestions
          profileForm={props.profileForm}
          suggestedCountry={props.suggestedWorkCountry ?? null}
        />

        <details
          className={cn(SETUP_BLOCK_CLASS, "group")}
          data-profile-setup-block="more-about-you"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden
              className="size-4 shrink-0 text-foreground-soft transition-transform group-open:rotate-90"
            />
            <span className="grid gap-1">
              <span className="text-sm font-semibold text-foreground">
                More about you{" "}
                <span className="font-normal text-foreground-soft">
                  (optional)
                </span>
              </span>
              <span
                className="text-sm leading-6 text-foreground-soft"
                data-profile-setup-work-details-intro
              >
                Relocation, remote work and travel. Leave Not set if you
                don&apos;t know.
              </span>
            </span>
          </summary>
          <div className="grid gap-(--gap-content) pt-4 md:grid-cols-2">
            <div className="grid min-w-0 content-start gap-(--gap-field)">
              <FieldLabel htmlFor={locationPreferencesId}>
                {PROFILE_WORK_CONSTRAINT_COPY.preferredRelocationRegions.label}
              </FieldLabel>
              <ProfileTextarea
                id={locationPreferencesId}
                placeholder={
                  PROFILE_WORK_CONSTRAINT_COPY.preferredRelocationRegions
                    .placeholder
                }
                rows={3}
                {...props.profileForm.register(
                  "eligibility.preferredRelocationRegions",
                )}
              />
            </div>
            <SetupBooleanField
              control={props.profileForm.control}
              description={
                PROFILE_WORK_CONSTRAINT_COPY.remoteEligible.description
              }
              id={remoteEligibleId}
              label={PROFILE_WORK_CONSTRAINT_COPY.remoteEligible.label}
              name="eligibility.remoteEligible"
            />
            <SetupBooleanField
              control={props.profileForm.control}
              description={
                PROFILE_WORK_CONSTRAINT_COPY.willingToRelocate.description
              }
              id={willingToRelocateId}
              label={PROFILE_WORK_CONSTRAINT_COPY.willingToRelocate.label}
              name="eligibility.willingToRelocate"
            />
            <SetupBooleanField
              control={props.profileForm.control}
              description={
                PROFILE_WORK_CONSTRAINT_COPY.willingToTravel.description
              }
              id={willingToTravelId}
              label={PROFILE_WORK_CONSTRAINT_COPY.willingToTravel.label}
              name="eligibility.willingToTravel"
            />
          </div>
        </details>

        {props.renderFooter({
          nextLabel: "Save and continue to Extras",
          onPrimary: async () => {
            try {
              await pendingSiteFlush.current?.();
              props.onSaveAndGoToStep(props.nextStep ?? "extras");
            } catch {
              /* The add-source form keeps the correction visible. */
            }
          },
        })}
      </CardContent>
    </Card>
  );
}
