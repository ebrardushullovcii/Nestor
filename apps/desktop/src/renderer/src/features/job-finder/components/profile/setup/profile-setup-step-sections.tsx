import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  filterProfileSetupSources,
  formatProfileSetupReviewValue,
  getProfileSetupSourceGuidance,
  getProfileSetupSourceHost,
  getProfileSetupStarterAccessNote,
  isValidProfileSetupSourceUrl,
  PROFILE_SETUP_SOURCE_PAGE_SIZE,
} from "./profile-setup-screen-helpers";
import { parseJobSourceUrls } from "../profile-job-sources-tab";
import { deriveJobSourceLabel } from "../../../lib/job-source-display-name";
import {
  type CandidateProfile,
  type JobDiscoveryTarget,
  type ProfileSetupStep,
  type ResumeApplicationMode,
  type ResumeImportFieldCandidateSummary,
  type ResumeImportProgressEvent,
  type ResumeImportRun,
  type SourceDebugRunRecord,
  workModeValues,
} from "@nestor/contracts";
import { getResumeImportStageFallbackNotes } from "../profile-resume-panel";
import { getResumeImportStageFallbackSummary } from "../resume-import-quality-note";
import type { UseFormReturn } from "react-hook-form";
import { Controller, useController } from "react-hook-form";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
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
  ProfileInput,
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
// Same wording as the employment type on a work-history card, so a saved
// preference and a listing's stated type compare as equal text.
const SETUP_EMPLOYMENT_TYPE_OPTIONS = [
  "Full-time",
  "Part-time",
  "Contract",
  "Internship",
  "Temporary",
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
  onPrimary?: (() => void) | null;
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
                      candidate.valuePreview ?? candidate.value,
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

/** "United States, Germany" and "United States; Germany" are two countries. */
export function parseWorkCountriesDraft(value: string): string[] {
  return value
    .split(/[,;\r\n]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

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
  const setCountries = (values: readonly string[]) =>
    props.profileForm.setValue(
      "eligibility.authorizedWorkCountries",
      joinListInput(values),
      { shouldDirty: true, shouldTouch: true, shouldValidate: true },
    );
  const suggestedCountry = props.suggestedCountry?.trim() || null;
  const answered = countries.length > 0 && sponsorship !== "";

  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 p-4"
      data-profile-setup-work-eligibility
      id="profile-setup-work-eligibility"
    >
      <div className="grid gap-1">
        <h3 className="text-sm font-semibold text-foreground" id={headingId}>
          Where you can work
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-foreground-soft">
          {answered
            ? "Application forms ask these two on almost every job. Every application reuses your answers."
            : "Application forms ask these two on almost every job. Answer once here and every application reuses them; setup finishes once both are answered."}
        </p>
      </div>
      <div className="grid gap-2">
        <ProfileListEditor
          draftParser={parseWorkCountriesDraft}
          emptyMessage="No countries yet."
          inputId="profile-setup-field-eligibility-authorized-work-countries"
          label={PROFILE_WORK_CONSTRAINT_COPY.authorizedWorkCountries.label}
          onChange={setCountries}
          placeholder="Add a country, e.g. Germany"
          values={countries}
        />
        {countries.length === 0 && suggestedCountry ? (
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
        <p className="px-1 text-(length:--text-body) leading-6 text-foreground">
          {PROFILE_WORK_CONSTRAINT_COPY.authorizedWorkCountries.description} A
          region such as European Union works too.
        </p>
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
        <p className="px-1 text-(length:--text-body) leading-6 text-foreground">
          {PROFILE_WORK_CONSTRAINT_COPY.requiresVisaSponsorship.description}
        </p>
      </div>
    </section>
  );
}

export function ProfileSetupTargetingStep(props: {
  isProfileSetupPending?: boolean;
  nextStep: ProfileSetupStep | null;
  onSaveAndGoToStep: (step: ProfileSetupStep) => void;
  onRunSourceDebug?: (
    targetId: string,
    options?: { readabilityTimeoutMs?: number },
  ) => void;
  onResumeApplicationModeChange?: (mode: ResumeApplicationMode) => void;
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
  profileForm: UseFormReturn<ProfileEditorValues>;
  resumeApplicationMode?: ResumeApplicationMode;
  recentSourceDebugRuns?: readonly SourceDebugRunRecord[];
  /**
   * Lets the screen add a complete address typed into the source form when
   * the person saves or finishes from the footer, instead of dropping it.
   */
  registerPendingSourceFlush?: (flush: (() => void) | null) => void;
  renderFooter: RenderFooter;
  savedDiscoveryTargets?: readonly JobDiscoveryTarget[];
  suggestedWorkCountry?: string | null;
}) {
  const locationPreferencesId = useId();
  const targetRolesId = "profile-setup-field-search-preferences-target-roles";
  const locationsId = "profile-setup-field-search-preferences-locations";
  const workModesGroupId = "profile-setup-field-search-preferences-work-modes";
  const workModesDescriptionId = `${workModesGroupId}-description`;
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
  const discoveryTargetsField = useController({
    control: props.preferencesForm.control,
    name: "discoveryTargets",
  });
  const discoveryTargets = discoveryTargetsField.field.value ?? [];
  const sourceSearchInputId = useId();
  const [sourceQuery, setSourceQuery] = useState("");
  const deferredSourceQuery = useDeferredValue(sourceQuery);
  const [sourcePage, setSourcePage] = useState(0);
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  // With no saved sources, adding one is the whole step, so the form is open.
  const [isManualSourceOpen, setIsManualSourceOpen] = useState(
    () => discoveryTargets.length === 0,
  );
  const [manualSourceLabel, setManualSourceLabel] = useState("");
  const [manualSourceUrl, setManualSourceUrl] = useState("");
  const [lastAddedSources, setLastAddedSources] = useState<{
    count: number;
    label: string;
  } | null>(null);
  const manualSourceLabelId = "profile-setup-field-manual-source-label";
  const manualSourceUrlId = "profile-setup-field-manual-source-url";
  const manualSourceUrlErrorId = "profile-setup-field-manual-source-url-error";

  const updateDiscoveryTargets = (
    nextTargets: SearchPreferencesEditorValues["discoveryTargets"],
  ) => {
    // Single write path: dual onChange + setValue re-entered watchers twice per
    // Enable click and could leave sibling fields undefined mid-render.
    props.preferencesForm.setValue(
      "discoveryTargets",
      nextTargets,
      listFieldOptions,
    );
  };

  const createDiscoveryTargetId = () =>
    `target_${typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`}`;
  const filteredSources = useMemo(
    () => filterProfileSetupSources(discoveryTargets, deferredSourceQuery),
    [deferredSourceQuery, discoveryTargets],
  );
  const sourcePageCount = Math.max(
    1,
    Math.ceil(filteredSources.length / PROFILE_SETUP_SOURCE_PAGE_SIZE),
  );
  const currentSourcePage = Math.min(sourcePage, sourcePageCount - 1);
  const visibleSources = filteredSources.slice(
    currentSourcePage * PROFILE_SETUP_SOURCE_PAGE_SIZE,
    (currentSourcePage + 1) * PROFILE_SETUP_SOURCE_PAGE_SIZE,
  );
  const firstVisibleSourceNumber =
    filteredSources.length === 0
      ? 0
      : currentSourcePage * PROFILE_SETUP_SOURCE_PAGE_SIZE + 1;
  const lastVisibleSourceNumber = Math.min(
    filteredSources.length,
    firstVisibleSourceNumber + visibleSources.length - 1,
  );
  const enabledSourceCount = discoveryTargets.filter(
    (target) => target.enabled,
  ).length;
  // The address is enough; a name is derived from the site when none is
  // typed, the same as the paste box on Profile › Job sources.
  const parsedManualSources = parseJobSourceUrls(manualSourceUrl);
  const isManualSourceComplete =
    parsedManualSources.urls.length > 0 &&
    parsedManualSources.invalid.length === 0 &&
    manualSourceUrl
      .split(/[\s,]+/u)
      .filter(Boolean)
      .every(isValidProfileSetupSourceUrl);
  const isManualSourceUrlInvalid =
    manualSourceUrl.trim().length > 0 && !isManualSourceComplete;

  const setSourceLibraryView = (nextQuery: string) => {
    setSourceQuery(nextQuery);
    setSourcePage(0);
  };

  const moveToSourcePage = (nextPage: number) => {
    const boundedPage = Math.min(Math.max(nextPage, 0), sourcePageCount - 1);
    setSourcePage(boundedPage);
    const revealSourceList = () => {
      const listHeading = document.getElementById(
        "profile-setup-job-sources-list-heading",
      );
      if (!listHeading) {
        return;
      }
      // Scroll with the full responsive header margins first (the heading
      // carries the shared scroll-margin trio), then claim focus with
      // preventScroll so the browser never lands it beneath the fixed shell
      // header or performs an uncontrolled ancestor jump.
      listHeading.scrollIntoView?.({ behavior: "auto", block: "start" });
      listHeading.focus({ preventScroll: true });
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(revealSourceList);
    } else {
      revealSourceList();
    }
  };

  // Every enablement is an explicit user action; searching or paging never
  // flips a source on.
  const setTargetEnabled = (targetId: string, enabled: boolean) => {
    updateDiscoveryTargets(
      discoveryTargets.map((entry) =>
        entry.id === targetId ? { ...entry, enabled } : entry,
      ),
    );
  };

  const addManualDiscoveryTarget = () => {
    if (!isManualSourceComplete) {
      return;
    }

    const addedUrls = parsedManualSources.urls.filter(
      (url) => !discoveryTargets.some((target) => target.startingUrl === url),
    );
    const nextTargets: SearchPreferencesEditorValues["discoveryTargets"] = [
      ...discoveryTargets,
      ...addedUrls.map((url) => ({
        id: createDiscoveryTargetId(),
        label:
          addedUrls.length === 1
            ? manualSourceLabel.trim() || deriveJobSourceLabel(url)
            : deriveJobSourceLabel(url),
        startingUrl: url,
        // Adding a site is already the act of choosing it: saving it switched
        // off left people with "All 1 saved sources are turned off" and no
        // way to search. The row keeps its Include toggle, so turning it back
        // off stays one click away.
        enabled: true,
        adapterKind: "auto" as const,
        customInstructions: "",
        instructionStatus: "missing" as const,
        validatedInstructionId: null,
        draftInstructionId: null,
        lastDebugRunId: null,
        lastVerifiedAt: null,
        staleReason: null,
      })),
    ];
    updateDiscoveryTargets(nextTargets);
    setManualSourceLabel("");
    setManualSourceUrl("");
    // The form stays open with the cursor in the address field: adding a
    // second site used to take a press on "Add a source URL manually" first.
    setIsManualSourceOpen(true);
    setLastAddedSources({
      count: addedUrls.length,
      label:
        addedUrls.length === 1
          ? manualSourceLabel.trim() || deriveJobSourceLabel(addedUrls[0] ?? "")
          : "",
    });
    setEditingTargetId(null);
    setSourceLibraryView("");
    setSourcePage(
      Math.floor(discoveryTargets.length / PROFILE_SETUP_SOURCE_PAGE_SIZE),
    );
    window.requestAnimationFrame(() => {
      document
        .getElementById(manualSourceUrlId)
        ?.focus({ preventScroll: true });
    });
  };
  const addManualDiscoveryTargetRef = useRef(addManualDiscoveryTarget);
  addManualDiscoveryTargetRef.current = addManualDiscoveryTarget;
  const registerPendingSourceFlush = props.registerPendingSourceFlush;
  useEffect(() => {
    if (!registerPendingSourceFlush) {
      return;
    }
    registerPendingSourceFlush(() => addManualDiscoveryTargetRef.current());
    return () => registerPendingSourceFlush(null);
  }, [registerPendingSourceFlush]);

  return (
    <Card className="rounded-(--radius-panel) border-border/40">
      <CardHeader className="gap-2 border-b border-border/30 pb-5">
        <CardTitle>What to search for</CardTitle>
        <CardDescription>
          Roles, places, and ways of working you want. Suggestions come from
          your resume; change anything that is off.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 pt-6">
        {discoveryTargets.length > 0 && enabledSourceCount === 0 ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) p-3 text-sm leading-6 text-(--warning-text)"
            role="status"
          >
            <p className="min-w-0 flex-1">
              Saved job sources are still off. Enable at least one before Search
              can run — jump to the source list below.
            </p>
            <Button
              aria-label="Show job sources to enable"
              data-profile-setup-jump-to-sources
              onClick={() => {
                const firstUsableSourceToggle =
                  document.querySelector<HTMLElement>(
                    "[data-profile-setup-source-enable]:not(:disabled)",
                  );
                const heading = document.getElementById(
                  "profile-setup-job-sources-heading",
                );
                const target = firstUsableSourceToggle ?? heading;

                // Land on the action the call-to-action promises, centered
                // clear of the shell header and pinned setup footer. Instant
                // scroll avoids racing a second click against an animation.
                target?.scrollIntoView({ behavior: "auto", block: "center" });
                target?.focus({ preventScroll: true });
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Show job sources
            </Button>
          </div>
        ) : null}
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
          <div className="grid gap-2">
            <ProfileListEditor
              label="Related role areas"
              onChange={(values) =>
                props.preferencesForm.setValue(
                  "jobFamilies",
                  joinListInput(values),
                  listFieldOptions,
                )
              }
              placeholder="Add a related role area"
              values={parseListInput(
                props.preferencesForm.watch("jobFamilies"),
              )}
            />
            <p className="px-1 text-(length:--text-body) leading-6 text-foreground">
              Related titles you&apos;d also consider, e.g. Teaching Assistant,
              Registered Nurse, or Visual Designer.
            </p>
          </div>
          <div className="grid gap-2">
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
            <p className="px-1 text-(length:--text-body) leading-6 text-foreground">
              Enter one place at a time, or separate places with semicolons.
              Keep a city, region, or country together with commas.
            </p>
          </div>
        </div>
        {/* Where to search is required, so it sits with roles and places
            instead of after the optional work details (N-001). */}
        <section
          aria-labelledby="profile-setup-job-sources-heading"
          className="grid gap-4 rounded-(--radius-field) border border-border/35 bg-background/45 p-4"
        >
          <div className="grid gap-1">
            <h3
              className="scroll-mt-4 text-sm font-semibold text-foreground outline-none sm:scroll-mt-[8.25rem] xl:scroll-mt-[4.5rem]"
              id="profile-setup-job-sources-heading"
              tabIndex={-1}
            >
              Job sources
            </h3>
            <p className="max-w-2xl text-sm leading-6 text-foreground-soft">
              Paste a careers page or job board you already browse. A site you
              add is turned on for search right away; turn one off in its row to
              leave it out.
            </p>
          </div>

          {discoveryTargets.length === 0 ? (
            <div
              className="rounded-(--radius-field) border border-dashed border-(--surface-panel-border) p-3 text-sm leading-6 text-foreground-soft"
              role="status"
            >
              Add an employer’s careers page or a job board you already use. Job
              Finder searches only the sites you add.
            </div>
          ) : (
            <>
              {/* "Saved job sources are still off" already heads this step
                  with a jump to this list; a second box here said it twice. */}
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="grid gap-(--gap-field)">
                  <FieldLabel htmlFor={sourceSearchInputId}>
                    Find a source
                  </FieldLabel>
                  <ProfileInput
                    autoComplete="off"
                    id={sourceSearchInputId}
                    onChange={(event) =>
                      setSourceLibraryView(event.target.value)
                    }
                    placeholder="Search by source name or URL"
                    type="search"
                    value={sourceQuery}
                  />
                </div>
                <p
                  aria-atomic="true"
                  aria-live="polite"
                  className="text-sm text-foreground-muted"
                  role="status"
                >
                  {filteredSources.length === discoveryTargets.length
                    ? `${discoveryTargets.length} sources`
                    : `${filteredSources.length} of ${discoveryTargets.length} sources`}
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/30 pt-3">
                <h4
                  className="scroll-mt-4 sm:scroll-mt-[8.25rem] xl:scroll-mt-[4.5rem] text-sm font-semibold text-foreground outline-none"
                  id="profile-setup-job-sources-list-heading"
                  tabIndex={-1}
                >
                  Source catalog
                </h4>
                {filteredSources.length > 0 ? (
                  <p className="text-xs text-foreground-muted">
                    {firstVisibleSourceNumber}–{lastVisibleSourceNumber} of{" "}
                    {filteredSources.length}
                  </p>
                ) : null}
              </div>
              <p
                aria-atomic="true"
                aria-live="polite"
                className="-mt-2 text-(length:--text-body) leading-6 text-foreground-soft"
                role="status"
              >
                {enabledSourceCount} of {discoveryTargets.length} sources
                enabled for search
              </p>

              {filteredSources.length === 0 ? (
                <div className="rounded-(--radius-field) border border-border/30 px-4 py-5 text-center">
                  <p className="font-medium text-foreground">
                    No sources match this search
                  </p>
                  {/* The sentence that used to sit here told the reader to
                      clear the search; the button below it is that action. */}
                  <Button
                    className="mt-3"
                    onClick={() => setSourceLibraryView("")}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Show all sources
                  </Button>
                </div>
              ) : (
                <>
                  <div className="grid gap-2" data-profile-setup-source-page>
                    {visibleSources.map(({ target, index }) => {
                      const validUrl = isValidProfileSetupSourceUrl(
                        target.startingUrl,
                      );
                      const sourceUrlInvalid =
                        target.startingUrl.trim().length > 0 && !validUrl;
                      const sourceUrlErrorId = `profile-setup-source-url-error-${target.id}`;
                      const isEditing = editingTargetId === target.id;
                      const guidance = getProfileSetupSourceGuidance(target);
                      const starterAccessNote =
                        getProfileSetupStarterAccessNote(target.startingUrl);
                      const sourceLabel =
                        target.label.trim() || `Source ${index + 1}`;

                      return (
                        <div className="grid gap-2" key={target.id}>
                          <article
                            className="grid gap-3 rounded-(--radius-field) border border-border/30 bg-background/65 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                            data-profile-setup-source-card={target.id}
                          >
                            <div className="min-w-0">
                              {/* No Enabled/Disabled badge: the "Include in
                                  search" checkbox beside this row already
                                  states the source's state. */}
                              <p
                                className="min-w-0 max-w-full truncate text-sm font-semibold text-foreground"
                                title={sourceLabel}
                              >
                                {sourceLabel}
                              </p>
                              <p
                                className="mt-1 truncate text-sm text-foreground-muted"
                                title={target.startingUrl}
                              >
                                {getProfileSetupSourceHost(target.startingUrl)}
                              </p>
                              {guidance.label ? (
                                <p className="mt-1 text-(length:--text-body) leading-6 text-foreground-soft">
                                  {guidance.label}
                                </p>
                              ) : null}
                              {guidance.detail ? (
                                <p className="text-(length:--text-body) leading-6 text-foreground-soft">
                                  {guidance.detail}
                                </p>
                              ) : null}
                              {starterAccessNote ? (
                                <p className="text-(length:--text-body) leading-6 text-foreground-soft">
                                  {starterAccessNote}
                                </p>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                              {/* Same control as Profile › Job sources: one
                                  checkbox for the identical action, instead of
                                  an Enable button here and a checkbox there. */}
                              <label className="flex min-h-9 items-center gap-2 rounded-(--radius-button) border border-(--surface-panel-border) px-3 text-sm text-foreground-soft">
                                <Checkbox
                                  aria-label={`Include ${sourceLabel} in searches`}
                                  checked={target.enabled}
                                  data-profile-setup-source-enable={target.id}
                                  disabled={!validUrl && !target.enabled}
                                  onCheckedChange={(checked) =>
                                    setTargetEnabled(
                                      target.id,
                                      checked === true,
                                    )
                                  }
                                />
                                Include in search
                              </label>
                              <Button
                                aria-expanded={isEditing}
                                aria-label={
                                  isEditing
                                    ? `Close editor for ${sourceLabel}`
                                    : `Edit ${sourceLabel}`
                                }
                                onClick={() =>
                                  setEditingTargetId(
                                    isEditing ? null : target.id,
                                  )
                                }
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                Edit source
                              </Button>
                            </div>
                          </article>
                          {sourceUrlInvalid && !isEditing ? (
                            <p
                              className="text-sm leading-6 text-(--warning-text)"
                              id={sourceUrlErrorId}
                              role="status"
                            >
                              This source needs a complete http or https URL.
                              Choose Edit to fix it before enabling it.
                            </p>
                          ) : null}
                          {isEditing ? (
                            <div className="grid gap-3 rounded-(--radius-field) border border-dashed border-border/40 bg-background/70 p-4">
                              <div className="grid gap-3 md:grid-cols-2">
                                <div className="grid gap-(--gap-field)">
                                  <FieldLabel
                                    htmlFor={`profile-setup-source-label-${target.id}`}
                                  >
                                    Source name
                                  </FieldLabel>
                                  <ProfileInput
                                    id={`profile-setup-source-label-${target.id}`}
                                    onChange={(event) =>
                                      updateDiscoveryTargets(
                                        discoveryTargets.map((entry) =>
                                          entry.id === target.id
                                            ? {
                                                ...entry,
                                                label: event.target.value,
                                              }
                                            : entry,
                                        ),
                                      )
                                    }
                                    placeholder="Example: City Hospital careers"
                                    value={target.label}
                                  />
                                </div>
                                <div className="grid gap-(--gap-field)">
                                  <FieldLabel
                                    htmlFor={`profile-setup-source-url-${target.id}`}
                                  >
                                    Careers or job-board URL
                                  </FieldLabel>
                                  <ProfileInput
                                    aria-describedby={
                                      sourceUrlInvalid
                                        ? sourceUrlErrorId
                                        : undefined
                                    }
                                    aria-invalid={sourceUrlInvalid}
                                    id={`profile-setup-source-url-${target.id}`}
                                    onChange={(event) =>
                                      updateDiscoveryTargets(
                                        discoveryTargets.map((entry) =>
                                          entry.id === target.id
                                            ? {
                                                ...entry,
                                                startingUrl: event.target.value,
                                                instructionStatus: "missing",
                                                validatedInstructionId: null,
                                                draftInstructionId: null,
                                                lastDebugRunId: null,
                                                lastVerifiedAt: null,
                                                staleReason: null,
                                              }
                                            : entry,
                                        ),
                                      )
                                    }
                                    placeholder="https://company.example/careers"
                                    type="url"
                                    value={target.startingUrl}
                                  />
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                {sourceUrlInvalid ? (
                                  <p
                                    className="text-sm leading-6 text-(--warning-text)"
                                    id={sourceUrlErrorId}
                                    role="status"
                                  >
                                    Enter a complete http or https URL before
                                    this source can be used.
                                  </p>
                                ) : (
                                  <span />
                                )}
                                <Button
                                  aria-label={`Remove ${sourceLabel}`}
                                  onClick={() => {
                                    updateDiscoveryTargets(
                                      discoveryTargets.filter(
                                        (entry) => entry.id !== target.id,
                                      ),
                                    );
                                    setEditingTargetId(null);
                                  }}
                                  size="sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  Remove
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>

                  {sourcePageCount > 1 ? (
                    <nav
                      aria-label="Profile setup job source pages"
                      className="flex items-center justify-between gap-3 border-t border-border/30 pt-3"
                    >
                      <Button
                        disabled={currentSourcePage === 0}
                        onClick={() => moveToSourcePage(currentSourcePage - 1)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Previous
                      </Button>
                      <span
                        aria-current="page"
                        className="text-center text-xs text-foreground-muted"
                      >
                        Page {currentSourcePage + 1} of {sourcePageCount}
                      </span>
                      <Button
                        disabled={currentSourcePage >= sourcePageCount - 1}
                        onClick={() => moveToSourcePage(currentSourcePage + 1)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Next
                      </Button>
                    </nav>
                  ) : null}
                </>
              )}
            </>
          )}

          <div className="grid gap-3 border-t border-border/30 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* The line under this heading restated the heading and the two
                  labelled fields it opens ("Source name", "Careers or
                  job-board URL"), so the heading stands on its own. */}
              <p className="text-sm font-semibold text-foreground">
                {discoveryTargets.length === 0
                  ? "Add a job site"
                  : isManualSourceOpen
                    ? "Add another job site"
                    : "Know the exact web address?"}
              </p>
              {isManualSourceOpen ? null : (
                <Button
                  aria-expanded={false}
                  onClick={() => setIsManualSourceOpen(true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Add a source URL manually
                </Button>
              )}
            </div>
            {lastAddedSources !== null &&
            isManualSourceOpen &&
            !isManualSourceUrlInvalid ? (
              <p
                aria-live="polite"
                className="text-sm leading-6 text-foreground-soft"
                data-profile-setup-source-added
                role="status"
              >
                {lastAddedSources.count === 0
                  ? "Those sites are already in your list."
                  : lastAddedSources.count === 1
                    ? `Added ${lastAddedSources.label} and turned it on.`
                    : `Added ${lastAddedSources.count} sources and turned them on.`}{" "}
                Paste another address to add one more.
              </p>
            ) : null}
            {isManualSourceOpen ? (
              <form
                className="grid gap-3 rounded-(--radius-field) border border-border/30 bg-background/65 p-4"
                data-profile-setup-manual-source-form
                onSubmit={(event) => {
                  event.preventDefault();
                  addManualDiscoveryTarget();
                }}
              >
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="grid gap-(--gap-field)">
                    <FieldLabel htmlFor={manualSourceLabelId}>
                      Source name (optional)
                    </FieldLabel>
                    <ProfileInput
                      id={manualSourceLabelId}
                      onChange={(event) =>
                        setManualSourceLabel(event.target.value)
                      }
                      placeholder="Example: City Hospital careers"
                      value={manualSourceLabel}
                    />
                  </div>
                  <div className="grid gap-(--gap-field)">
                    <FieldLabel htmlFor={manualSourceUrlId}>
                      Careers or job-board URL
                    </FieldLabel>
                    <ProfileInput
                      aria-describedby={
                        isManualSourceUrlInvalid
                          ? manualSourceUrlErrorId
                          : undefined
                      }
                      aria-invalid={isManualSourceUrlInvalid}
                      id={manualSourceUrlId}
                      onPaste={(event) => {
                        const pasted = event.clipboardData.getData("text");
                        if (pasted.includes("\n") || pasted.includes("\r")) {
                          // A one-line field drops line breaks; keep one
                          // address per entry by joining them with commas.
                          event.preventDefault();
                          setManualSourceUrl(
                            pasted
                              .split(/[\r\n]+/u)
                              .map((line) => line.trim())
                              .filter(Boolean)
                              .join(", "),
                          );
                        }
                      }}
                      onChange={(event) =>
                        setManualSourceUrl(event.target.value)
                      }
                      placeholder="https://company.example/careers"
                      type="text"
                      value={manualSourceUrl}
                    />
                  </div>
                </div>
                {isManualSourceUrlInvalid ? (
                  <p
                    className="text-sm leading-6 text-(--warning-text)"
                    id={manualSourceUrlErrorId}
                    role="status"
                  >
                    {parsedManualSources.invalid[0]
                      ? `“${parsedManualSources.invalid[0]}” is not a web address. Use complete http or https URLs, separated by spaces or new lines.`
                      : "Enter a complete http or https URL."}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={!isManualSourceComplete} type="submit">
                    Add and turn on
                  </Button>
                  <Button
                    onClick={() => {
                      setIsManualSourceOpen(false);
                      setManualSourceLabel("");
                      setManualSourceUrl("");
                      setLastAddedSources(null);
                    }}
                    type="button"
                    variant="ghost"
                  >
                    {lastAddedSources ? "Done adding" : "Cancel"}
                  </Button>
                  {!isManualSourceComplete && !isManualSourceUrlInvalid ? (
                    <p className="text-(length:--text-body) leading-6 text-foreground-soft">
                      Paste a complete http or https address; the name is
                      optional.
                    </p>
                  ) : null}
                </div>
              </form>
            ) : null}
          </div>
        </section>

        {/* The resume level is chosen per job on Shortlisted (Original, Light,
            Tailored, Aggressive), so setup no longer asks for a default. */}
        <SetupWorkEligibilityQuestions
          profileForm={props.profileForm}
          suggestedCountry={props.suggestedWorkCountry ?? null}
        />
        <div className="grid gap-(--gap-content) md:grid-cols-2">
          <p
            className="text-sm leading-6 text-foreground-soft md:col-span-2"
            data-profile-setup-work-details-intro
          >
            More work details, all optional. These are facts, not preferences —
            leave Not set if you don&apos;t know.
          </p>
          <div className="grid min-w-0 content-start gap-(--gap-field)">
            <FieldLabel htmlFor={locationPreferencesId}>
              {PROFILE_WORK_CONSTRAINT_COPY.preferredRelocationRegions.label}
            </FieldLabel>
            <ProfileTextarea
              aria-describedby={`${locationPreferencesId}-help`}
              id={locationPreferencesId}
              placeholder={
                PROFILE_WORK_CONSTRAINT_COPY.preferredRelocationRegions
                  .placeholder
              }
              rows={4}
              {...props.profileForm.register(
                "eligibility.preferredRelocationRegions",
              )}
            />
            <p
              className="text-(length:--text-body) leading-6 text-foreground"
              id={`${locationPreferencesId}-help`}
            >
              {
                PROFILE_WORK_CONSTRAINT_COPY.preferredRelocationRegions
                  .description
              }
            </p>
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
        <fieldset
          aria-describedby={`${workModesDescriptionId} ${workModesGuidanceId}`}
          className="grid gap-(--gap-field)"
          id={workModesGroupId}
        >
          <legend className="text-(length:--text-field-label) font-medium tracking-(--tracking-label) text-muted-foreground">
            {PROFILE_WORK_CONSTRAINT_COPY.workModes.label}
          </legend>
          <p
            className="text-sm leading-6 text-foreground-soft"
            id={workModesDescriptionId}
          >
            {PROFILE_WORK_CONSTRAINT_COPY.workModes.description}
          </p>
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
          {(props.preferencesForm.watch("workModes") ?? []).length === 0 ? (
            <p
              className="text-sm leading-6 text-(--warning-text)"
              id={workModesGuidanceId}
              role="status"
            >
              Choose at least one so searches know what to look for.
            </p>
          ) : (props.preferencesForm.watch("workModes") ?? []).includes(
              "remote",
            ) &&
            props.profileForm.watch("eligibility.remoteEligible") === "" ? (
            <p
              className="text-sm leading-6 text-foreground-muted"
              id={workModesGuidanceId}
            >
              Remote is your preference; whether you can work remotely is a
              separate answer you can leave Not set for now.
            </p>
          ) : (
            <p
              className="text-sm leading-6 text-foreground-muted"
              id={workModesGuidanceId}
            >
              Your preferred setup describes what you want; work details
              describe what you can accept.
            </p>
          )}
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="text-(length:--text-field-label) font-medium tracking-(--tracking-label) text-muted-foreground">
            Hours
          </legend>
          <p className="text-sm leading-6 text-foreground-soft">
            Tick the kinds of work you want. Leave every box empty to see all of
            them.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {SETUP_EMPLOYMENT_TYPE_OPTIONS.map((employmentType) => {
              const selectedTypes = parseListInput(
                props.preferencesForm.watch("employmentTypes"),
              );
              const checked = selectedTypes.some(
                (value) => value.toLowerCase() === employmentType.toLowerCase(),
              );
              return (
                <CheckboxField
                  checked={checked}
                  key={employmentType}
                  label={employmentType}
                  onCheckedChange={(nextChecked) =>
                    props.preferencesForm.setValue(
                      "employmentTypes",
                      joinListInput(
                        nextChecked
                          ? [...selectedTypes, employmentType]
                          : selectedTypes.filter(
                              (value) =>
                                value.toLowerCase() !==
                                employmentType.toLowerCase(),
                            ),
                      ),
                      { shouldDirty: true, shouldTouch: true },
                    )
                  }
                />
              );
            })}
          </div>
        </fieldset>

        {props.renderFooter({
          nextLabel: "Save and continue to Extras",
          onPrimary: () => {
            // A name and a complete URL typed into the add form are a source
            // the person meant to keep. Leaving the step used to drop them
            // without a word; a form that is not complete is still left
            // alone, so nothing is ever invented.
            addManualDiscoveryTarget();
            props.onSaveAndGoToStep(props.nextStep ?? "extras");
          },
        })}
      </CardContent>
    </Card>
  );
}
