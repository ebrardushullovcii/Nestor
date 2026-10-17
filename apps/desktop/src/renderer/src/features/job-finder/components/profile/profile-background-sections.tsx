import type { UseFormReturn } from "react-hook-form";
import { Button } from "@renderer/components/ui/button";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import type { ProfileEditorValues } from "../../lib/profile-editor";
import type { ProfileBackgroundArrays } from "./profile-field-array-types";
import { EmptyState } from "../empty-state";
import {
  ProfileInput,
  ProfileTextarea,
  profileSelectTriggerClassName,
} from "./profile-form-primitives";
import { ProfileRecordCard } from "./profile-record-card";
import { ProfileSectionHeader } from "./profile-section-header";
import { Controller } from "react-hook-form";
import { candidateLinkKindValues } from "@nestor/contracts";
import { CheckboxField } from "../checkbox-field";
import { FormSelect } from "../form-select";
import { formatStatusLabel } from "../../lib/job-finder-utils";
import { useProfileAppendedRecordOpenSignal } from "./use-profile-appended-record-open-signal";

export function joinProfileSummaryParts(
  parts: Array<string | null | undefined>,
) {
  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" | ");
}

export function ProfileBackgroundSupportingDetailSection(props: {
  backgroundArrays: ProfileBackgroundArrays;
  isProfileSetupPending: boolean;
  profileForm: UseFormReturn<ProfileEditorValues>;
}) {
  const { languageArray, linkArray, projectArray } = props.backgroundArrays;
  const { control, register, watch } = props.profileForm;
  const {
    forgetAppendedRecord,
    getAppendedRecordOpenSignal,
    markAppendedRecord,
  } = useProfileAppendedRecordOpenSignal();

  function buildProjectFieldId(recordId: string, field: string) {
    return `project-record-${recordId}-${field}`;
  }

  function buildLinkFieldId(recordId: string, field: string) {
    return `link-record-${recordId}-${field}`;
  }

  function buildLanguageFieldId(recordId: string, field: string) {
    return `language-record-${recordId}-${field}`;
  }

  function handleAddProject() {
    const recordId = `project_${crypto.randomUUID().slice(0, 8)}`;
    projectArray.append({
      id: recordId,
      name: "",
      projectType: "",
      summary: "",
      role: "",
      skills: "",
      outcome: "",
      projectUrl: "",
      repositoryUrl: "",
      caseStudyUrl: "",
    });
    markAppendedRecord(recordId);
  }

  function handleAddLink() {
    const recordId = `link_${crypto.randomUUID().slice(0, 8)}`;
    linkArray.append({
      id: recordId,
      label: "",
      url: "",
      kind: "",
    });
    markAppendedRecord(recordId);
  }

  function handleAddLanguage() {
    const recordId = `language_${crypto.randomUUID().slice(0, 8)}`;
    languageArray.append({
      id: recordId,
      language: "",
      proficiency: "",
      interviewPreference: false,
      notes: "",
    });
    markAppendedRecord(recordId);
  }

  function handleRemoveProject(index: number) {
    forgetAppendedRecord(projectArray.fields[index]?.id ?? "");
    projectArray.remove(index);
  }

  function handleRemoveLink(index: number) {
    forgetAppendedRecord(linkArray.fields[index]?.id ?? "");
    linkArray.remove(index);
  }

  function handleRemoveLanguage(index: number) {
    forgetAppendedRecord(languageArray.fields[index]?.id ?? "");
    languageArray.remove(index);
  }

  return (
    <section className="grid content-start gap-(--gap-card)">
      <ProfileSectionHeader
        eyebrow="Supporting detail"
        title="Projects, links, and languages"
        description="Use these records to add proof, public links, and language details without turning the page into one long form."
        action={
          <div className="flex flex-wrap items-stretch gap-2.5">
            <Button
              disabled={props.isProfileSetupPending}
              pending={props.isProfileSetupPending}
              onClick={handleAddProject}
              type="button"
              variant="secondary"
              className="h-11 px-4"
            >
              Add project
            </Button>
            <Button
              disabled={props.isProfileSetupPending}
              pending={props.isProfileSetupPending}
              onClick={handleAddLink}
              type="button"
              variant="secondary"
              className="h-11 px-4"
            >
              Add link
            </Button>
            <Button
              disabled={props.isProfileSetupPending}
              pending={props.isProfileSetupPending}
              onClick={handleAddLanguage}
              type="button"
              variant="secondary"
              className="h-11 px-4"
            >
              Add language
            </Button>
          </div>
        }
      />

      <div className="grid gap-4">
        {projectArray.fields.map((entry, index) => (
          <ProfileRecordCard
            id={`project-record-${entry.id}`}
            key={entry.fieldKey}
            defaultOpen={index === 0}
            forceOpenSignal={getAppendedRecordOpenSignal(entry.id)}
            summary={joinProfileSummaryParts([
              watch(`projects.${index}.name`),
              watch(`projects.${index}.role`),
              watch(`projects.${index}.projectType`),
            ])}
            title={
              watch(`projects.${index}.name`)?.trim() || `Project ${index + 1}`
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="text-(length:--text-field-label) font-medium uppercase tracking-[0.16em] text-foreground-muted">
                Project details
              </p>
              <Button
                disabled={props.isProfileSetupPending}
                pending={props.isProfileSetupPending}
                onClick={() => handleRemoveProject(index)}
                size="compact"
                type="button"
                variant="ghost"
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
              <Field>
                <FieldLabel htmlFor={buildProjectFieldId(entry.id, "name")}>
                  Project name
                </FieldLabel>
                <ProfileInput
                  id={buildProjectFieldId(entry.id, "name")}
                  {...register(`projects.${index}.name`)}
                />
              </Field>
              <Field>
                <FieldLabel
                  htmlFor={buildProjectFieldId(entry.id, "project-type")}
                >
                  Project type
                </FieldLabel>
                <ProfileInput
                  id={buildProjectFieldId(entry.id, "project-type")}
                  {...register(`projects.${index}.projectType`)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={buildProjectFieldId(entry.id, "role")}>
                  Role
                </FieldLabel>
                <ProfileInput
                  id={buildProjectFieldId(entry.id, "role")}
                  {...register(`projects.${index}.role`)}
                />
              </Field>
              <Field>
                <FieldLabel
                  htmlFor={buildProjectFieldId(entry.id, "project-url")}
                >
                  Project URL
                </FieldLabel>
                <ProfileInput
                  id={buildProjectFieldId(entry.id, "project-url")}
                  {...register(`projects.${index}.projectUrl`)}
                />
              </Field>
              <Field>
                <FieldLabel
                  htmlFor={buildProjectFieldId(entry.id, "repository-url")}
                >
                  Repository URL (optional)
                </FieldLabel>
                <ProfileInput
                  id={buildProjectFieldId(entry.id, "repository-url")}
                  {...register(`projects.${index}.repositoryUrl`)}
                />
              </Field>
              <Field>
                <FieldLabel
                  htmlFor={buildProjectFieldId(entry.id, "case-study-url")}
                >
                  Case study URL (optional)
                </FieldLabel>
                <ProfileInput
                  id={buildProjectFieldId(entry.id, "case-study-url")}
                  {...register(`projects.${index}.caseStudyUrl`)}
                />
              </Field>
              <Field className="md:col-span-2">
                <FieldLabel htmlFor={buildProjectFieldId(entry.id, "skills")}>
                  Skills used
                </FieldLabel>
                <ProfileTextarea
                  id={buildProjectFieldId(entry.id, "skills")}
                  className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                  rows={4}
                  {...register(`projects.${index}.skills`)}
                />
              </Field>
              <Field className="md:col-span-2">
                <FieldLabel htmlFor={buildProjectFieldId(entry.id, "summary")}>
                  Summary
                </FieldLabel>
                <ProfileTextarea
                  id={buildProjectFieldId(entry.id, "summary")}
                  className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                  rows={4}
                  {...register(`projects.${index}.summary`)}
                />
              </Field>
              <Field className="md:col-span-2">
                <FieldLabel htmlFor={buildProjectFieldId(entry.id, "outcome")}>
                  Impact
                </FieldLabel>
                <ProfileTextarea
                  id={buildProjectFieldId(entry.id, "outcome")}
                  className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                  rows={4}
                  {...register(`projects.${index}.outcome`)}
                />
              </Field>
            </div>
          </ProfileRecordCard>
        ))}

        {linkArray.fields.map((entry, index) => (
          <ProfileRecordCard
            id={`link-record-${entry.id}`}
            key={entry.fieldKey}
            defaultOpen={index === 0 && projectArray.fields.length === 0}
            forceOpenSignal={getAppendedRecordOpenSignal(entry.id)}
            summary={joinProfileSummaryParts([
              watch(`links.${index}.label`),
              watch(`links.${index}.kind`)
                ? formatStatusLabel(watch(`links.${index}.kind`))
                : null,
            ])}
            title={watch(`links.${index}.label`)?.trim() || `Link ${index + 1}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="text-(length:--text-field-label) font-medium uppercase tracking-[0.16em] text-foreground-muted">
                Link details
              </p>
              <Button
                disabled={props.isProfileSetupPending}
                pending={props.isProfileSetupPending}
                onClick={() => handleRemoveLink(index)}
                size="compact"
                type="button"
                variant="ghost"
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
              <Field>
                <FieldLabel htmlFor={buildLinkFieldId(entry.id, "label")}>
                  Label
                </FieldLabel>
                <ProfileInput
                  id={buildLinkFieldId(entry.id, "label")}
                  {...register(`links.${index}.label`)}
                />
              </Field>
              <Controller
                control={control}
                name={`links.${index}.kind`}
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor={buildLinkFieldId(entry.id, "kind")}>
                      Type
                    </FieldLabel>
                    <FormSelect
                      onValueChange={field.onChange}
                      options={[
                        { label: "Select type", value: "" },
                        ...candidateLinkKindValues.map((kind) => ({
                          label: formatStatusLabel(kind),
                          value: kind,
                        })),
                      ]}
                      placeholder="Select type"
                      triggerClassName={profileSelectTriggerClassName}
                      triggerId={buildLinkFieldId(entry.id, "kind")}
                      value={field.value}
                    />
                  </Field>
                )}
              />
              <Field className="md:col-span-2">
                <FieldLabel htmlFor={buildLinkFieldId(entry.id, "url")}>
                  URL
                </FieldLabel>
                <ProfileInput
                  id={buildLinkFieldId(entry.id, "url")}
                  {...register(`links.${index}.url`)}
                />
              </Field>
            </div>
          </ProfileRecordCard>
        ))}

        {languageArray.fields.map((entry, index) => (
          <ProfileRecordCard
            id={`language-record-${entry.id}`}
            key={entry.fieldKey}
            defaultOpen={
              index === 0 &&
              projectArray.fields.length === 0 &&
              linkArray.fields.length === 0
            }
            forceOpenSignal={getAppendedRecordOpenSignal(entry.id)}
            summary={joinProfileSummaryParts([
              watch(`languages.${index}.language`),
              watch(`languages.${index}.proficiency`),
            ])}
            title={
              watch(`languages.${index}.language`)?.trim() ||
              `Language ${index + 1}`
            }
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="text-(length:--text-field-label) font-medium uppercase tracking-[0.16em] text-foreground-muted">
                Language details
              </p>
              <Button
                disabled={props.isProfileSetupPending}
                pending={props.isProfileSetupPending}
                onClick={() => handleRemoveLanguage(index)}
                size="compact"
                type="button"
                variant="ghost"
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
              <Field>
                <FieldLabel
                  htmlFor={buildLanguageFieldId(entry.id, "language")}
                >
                  Language
                </FieldLabel>
                <ProfileInput
                  id={buildLanguageFieldId(entry.id, "language")}
                  {...register(`languages.${index}.language`)}
                />
              </Field>
              <Field>
                <FieldLabel
                  htmlFor={buildLanguageFieldId(entry.id, "proficiency")}
                >
                  Proficiency
                </FieldLabel>
                <ProfileInput
                  id={buildLanguageFieldId(entry.id, "proficiency")}
                  {...register(`languages.${index}.proficiency`)}
                />
              </Field>
              <Controller
                control={control}
                name={`languages.${index}.interviewPreference`}
                render={({ field }) => (
                  <CheckboxField
                    checked={field.value}
                    inputId={buildLanguageFieldId(
                      entry.id,
                      "interview-preference",
                    )}
                    label="Can interview in this language"
                    onCheckedChange={field.onChange}
                  />
                )}
              />
              <Field className="md:col-span-2">
                <FieldLabel htmlFor={buildLanguageFieldId(entry.id, "notes")}>
                  Context (optional)
                </FieldLabel>
                <ProfileTextarea
                  id={buildLanguageFieldId(entry.id, "notes")}
                  className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                  rows={4}
                  {...register(`languages.${index}.notes`)}
                />
              </Field>
            </div>
          </ProfileRecordCard>
        ))}

        {projectArray.fields.length === 0 &&
        linkArray.fields.length === 0 &&
        languageArray.fields.length === 0 ? (
          <EmptyState
            description="Add projects, links, and languages here when they help support applications."
            title="Nothing added here yet"
          />
        ) : null}
      </div>
    </section>
  );
}

export function ProfileBackgroundProofBankSection(props: {
  backgroundArrays: ProfileBackgroundArrays;
  isProfileSetupPending: boolean;
  profileForm: UseFormReturn<ProfileEditorValues>;
}) {
  const { proofBankArray } = props.backgroundArrays;
  const { register, watch } = props.profileForm;
  const {
    forgetAppendedRecord,
    getAppendedRecordOpenSignal,
    markAppendedRecord,
  } = useProfileAppendedRecordOpenSignal();

  function buildProofFieldId(recordId: string, field: string) {
    return `proof-record-${recordId}-${field}`;
  }

  function handleAddProof() {
    const recordId = `proof_${crypto.randomUUID().slice(0, 8)}`;
    proofBankArray.append({
      id: recordId,
      title: "",
      claim: "",
      heroMetric: "",
      supportingContext: "",
      roleFamilies: "",
      projectIds: "",
      linkIds: "",
    });
    markAppendedRecord(recordId);
  }

  function handleRemoveProof(index: number) {
    forgetAppendedRecord(proofBankArray.fields[index]?.id ?? "");
    proofBankArray.remove(index);
  }

  return (
    <section className="grid content-start gap-(--gap-card)">
      <ProfileSectionHeader
        eyebrow="Saved evidence"
        title="Reusable proof and case studies"
        description="Capture the strongest claims, metrics, and supporting links once so resumes and future applications can reuse them safely."
        action={
          <Button
            disabled={props.isProfileSetupPending}
            pending={props.isProfileSetupPending}
            onClick={handleAddProof}
            type="button"
            variant="secondary"
            className="h-11 px-4"
          >
            Add evidence
          </Button>
        }
      />

      <div className="grid gap-4">
        {proofBankArray.fields.length > 0 ? (
          proofBankArray.fields.map((entry, index) => (
            <ProfileRecordCard
              id={`proof-record-${entry.id}`}
              key={entry.fieldKey}
              defaultOpen={index === 0}
              forceOpenSignal={getAppendedRecordOpenSignal(entry.id)}
              summary={joinProfileSummaryParts([
                watch(`proofBank.${index}.title`),
                watch(`proofBank.${index}.heroMetric`),
              ])}
              title={
                watch(`proofBank.${index}.title`)?.trim() ||
                `Proof ${index + 1}`
              }
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="text-(length:--text-field-label) font-medium uppercase tracking-[0.16em] text-foreground-muted">
                  Proof details
                </p>
                <Button
                  disabled={props.isProfileSetupPending}
                  pending={props.isProfileSetupPending}
                  onClick={() => handleRemoveProof(index)}
                  size="compact"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </Button>
              </div>
              <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
                <Field>
                  <FieldLabel htmlFor={buildProofFieldId(entry.id, "title")}>
                    Title
                  </FieldLabel>
                  <ProfileInput
                    id={buildProofFieldId(entry.id, "title")}
                    placeholder="Example: Led cross-functional redesign"
                    {...register(`proofBank.${index}.title`)}
                  />
                </Field>
                <Field>
                  <FieldLabel
                    htmlFor={buildProofFieldId(entry.id, "hero-metric")}
                  >
                    Hero metric
                  </FieldLabel>
                  <ProfileInput
                    id={buildProofFieldId(entry.id, "hero-metric")}
                    placeholder="Example: Increased activation by 18%"
                    {...register(`proofBank.${index}.heroMetric`)}
                  />
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor={buildProofFieldId(entry.id, "claim")}>
                    Claim
                  </FieldLabel>
                  <ProfileTextarea
                    id={buildProofFieldId(entry.id, "claim")}
                    className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                    rows={4}
                    {...register(`proofBank.${index}.claim`)}
                  />
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel
                    htmlFor={buildProofFieldId(entry.id, "supporting-context")}
                  >
                    Supporting context
                  </FieldLabel>
                  <ProfileTextarea
                    id={buildProofFieldId(entry.id, "supporting-context")}
                    className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                    rows={4}
                    {...register(`proofBank.${index}.supportingContext`)}
                  />
                </Field>
                <Field>
                  <FieldLabel
                    htmlFor={buildProofFieldId(entry.id, "role-families")}
                  >
                    Relevant role families
                  </FieldLabel>
                  <ProfileTextarea
                    id={buildProofFieldId(entry.id, "role-families")}
                    className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                    placeholder="Comma-separated role families, e.g. frontend, fullstack"
                    rows={4}
                    {...register(`proofBank.${index}.roleFamilies`)}
                  />
                </Field>
                <Field>
                  <FieldLabel
                    htmlFor={buildProofFieldId(entry.id, "project-ids")}
                  >
                    Related project IDs
                  </FieldLabel>
                  <ProfileTextarea
                    id={buildProofFieldId(entry.id, "project-ids")}
                    className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                    placeholder="Copy project IDs from the cards above, one per line"
                    rows={4}
                    {...register(`proofBank.${index}.projectIds`)}
                  />
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor={buildProofFieldId(entry.id, "link-ids")}>
                    Related public link IDs
                  </FieldLabel>
                  <ProfileTextarea
                    id={buildProofFieldId(entry.id, "link-ids")}
                    className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                    placeholder="Copy link IDs from the cards above, one per line"
                    rows={4}
                    {...register(`proofBank.${index}.linkIds`)}
                  />
                </Field>
              </div>
            </ProfileRecordCard>
          ))
        ) : (
          <EmptyState
            description="Add reusable proof points here when you want resumes and apply help to reuse verified wins instead of rewording the same story each time."
            title="No proof saved yet"
          />
        )}
      </div>
    </section>
  );
}
