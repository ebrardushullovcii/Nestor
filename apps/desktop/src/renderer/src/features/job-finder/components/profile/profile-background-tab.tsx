import type { UseFormReturn } from "react-hook-form";
import { Button } from "@renderer/components/ui/button";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { EmptyState } from "../empty-state";
import type { ProfileEditorValues } from "../../lib/profile-editor";
import type { ProfileBackgroundArrays } from "./profile-field-array-types";
import {
  joinProfileSummaryParts,
  ProfileBackgroundProofBankSection,
  ProfileBackgroundSupportingDetailSection,
} from "./profile-background-sections";
import { ProfileInput, ProfileTextarea } from "./profile-form-primitives";
import { ProfileRecordCard } from "./profile-record-card";
import { ProfileSectionHeader } from "./profile-section-header";
import { useProfileAppendedRecordOpenSignal } from "./use-profile-appended-record-open-signal";

interface ProfileBackgroundTabProps {
  backgroundArrays: ProfileBackgroundArrays;
  isProfileSetupPending?: boolean;
  profileForm: UseFormReturn<ProfileEditorValues>;
}

export function ProfileBackgroundTab({
  backgroundArrays,
  isProfileSetupPending = false,
  profileForm,
}: ProfileBackgroundTabProps) {
  const { certificationArray, educationArray } = backgroundArrays;
  const { register, watch } = profileForm;
  const {
    forgetAppendedRecord,
    getAppendedRecordOpenSignal,
    markAppendedRecord,
  } = useProfileAppendedRecordOpenSignal();

  function buildEducationFieldId(recordId: string, field: string) {
    return `education-record-${recordId}-${field}`;
  }

  function buildCertificationFieldId(recordId: string, field: string) {
    return `certification-record-${recordId}-${field}`;
  }

  function handleAddEducation() {
    const recordId = `education_${crypto.randomUUID().slice(0, 8)}`;
    educationArray.append({
      id: recordId,
      schoolName: "",
      degree: "",
      fieldOfStudy: "",
      location: "",
      startDate: "",
      endDate: "",
      summary: "",
    });
    markAppendedRecord(recordId);
  }

  function handleAddCertification() {
    const recordId = `certification_${crypto.randomUUID().slice(0, 8)}`;
    certificationArray.append({
      id: recordId,
      name: "",
      issuer: "",
      issueDate: "",
      expiryDate: "",
      credentialUrl: "",
    });
    markAppendedRecord(recordId);
  }

  function handleRemoveEducation(index: number) {
    forgetAppendedRecord(educationArray.fields[index]?.id ?? "");
    educationArray.remove(index);
  }

  function handleRemoveCertification(index: number) {
    forgetAppendedRecord(certificationArray.fields[index]?.id ?? "");
    certificationArray.remove(index);
  }

  return (
    <div className="grid gap-6">
      <section className="grid content-start gap-(--gap-card)">
        <ProfileSectionHeader
          eyebrow="Background"
          title="Education and credentials"
          description="Schools, certifications, and other credentials."
          action={
            <div className="flex flex-wrap items-stretch gap-2.5">
              <Button
                disabled={isProfileSetupPending}
                pending={isProfileSetupPending}
                onClick={handleAddEducation}
                type="button"
                variant="secondary"
                className="h-11 px-4"
              >
                Add education
              </Button>
              <Button
                disabled={isProfileSetupPending}
                pending={isProfileSetupPending}
                onClick={handleAddCertification}
                type="button"
                variant="secondary"
                className="h-11 px-4"
              >
                Add certification
              </Button>
            </div>
          }
        />

        <div className="grid gap-4">
          {educationArray.fields.length > 0 ? (
            educationArray.fields.map((entry, index) => (
              <ProfileRecordCard
                id={`education-record-${entry.id}`}
                key={entry.fieldKey}
                defaultOpen={index === 0}
                forceOpenSignal={getAppendedRecordOpenSignal(entry.id)}
                summary={joinProfileSummaryParts([
                  // The card title already shows the degree (or the school
                  // when there is no degree); repeating it here printed the
                  // degree twice.
                  watch(`records.education.${index}.degree`)?.trim()
                    ? watch(`records.education.${index}.schoolName`)
                    : null,
                  joinProfileSummaryParts([
                    watch(`records.education.${index}.startDate`),
                    watch(`records.education.${index}.endDate`),
                  ]),
                ])}
                title={
                  watch(`records.education.${index}.degree`)?.trim() ||
                  watch(`records.education.${index}.schoolName`)?.trim() ||
                  `Education ${index + 1}`
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="text-(length:--text-field-label) font-medium uppercase tracking-[0.16em] text-foreground-muted">
                    Education details
                  </p>
                  <Button
                    disabled={isProfileSetupPending}
                    pending={isProfileSetupPending}
                    onClick={() => handleRemoveEducation(index)}
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
                      htmlFor={buildEducationFieldId(entry.id, "school-name")}
                    >
                      School
                    </FieldLabel>
                    <ProfileInput
                      id={buildEducationFieldId(entry.id, "school-name")}
                      {...register(`records.education.${index}.schoolName`)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={buildEducationFieldId(entry.id, "degree")}
                    >
                      Degree
                    </FieldLabel>
                    <ProfileInput
                      id={buildEducationFieldId(entry.id, "degree")}
                      {...register(`records.education.${index}.degree`)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={buildEducationFieldId(
                        entry.id,
                        "field-of-study",
                      )}
                    >
                      Field of study
                    </FieldLabel>
                    <ProfileInput
                      id={buildEducationFieldId(entry.id, "field-of-study")}
                      {...register(`records.education.${index}.fieldOfStudy`)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={buildEducationFieldId(entry.id, "location")}
                    >
                      Location
                    </FieldLabel>
                    <ProfileInput
                      id={buildEducationFieldId(entry.id, "location")}
                      {...register(`records.education.${index}.location`)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={buildEducationFieldId(entry.id, "start-date")}
                    >
                      Start date
                    </FieldLabel>
                    <ProfileInput
                      id={buildEducationFieldId(entry.id, "start-date")}
                      placeholder="YYYY-MM"
                      {...register(`records.education.${index}.startDate`)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={buildEducationFieldId(entry.id, "end-date")}
                    >
                      End date
                    </FieldLabel>
                    <ProfileInput
                      id={buildEducationFieldId(entry.id, "end-date")}
                      placeholder="YYYY-MM"
                      {...register(`records.education.${index}.endDate`)}
                    />
                  </Field>
                  <Field className="md:col-span-2">
                    <FieldLabel
                      htmlFor={buildEducationFieldId(entry.id, "summary")}
                    >
                      Highlights
                    </FieldLabel>
                    <ProfileTextarea
                      id={buildEducationFieldId(entry.id, "summary")}
                      className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                      rows={4}
                      {...register(`records.education.${index}.summary`)}
                    />
                  </Field>
                </div>
              </ProfileRecordCard>
            ))
          ) : (
            <EmptyState
              description="Add schools and qualifications here so they are easy to review later."
              title="No education records yet"
            />
          )}

          {certificationArray.fields.map((entry, index) => (
            <ProfileRecordCard
              id={`certification-record-${entry.id}`}
              key={entry.fieldKey}
              defaultOpen={index === 0 && educationArray.fields.length === 0}
              forceOpenSignal={getAppendedRecordOpenSignal(entry.id)}
              summary={joinProfileSummaryParts([
                watch(`records.certifications.${index}.name`),
                watch(`records.certifications.${index}.issuer`),
              ])}
              title={
                watch(`records.certifications.${index}.name`)?.trim() ||
                `Certification ${index + 1}`
              }
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="text-(length:--text-field-label) font-medium uppercase tracking-[0.16em] text-foreground-muted">
                  Certification details
                </p>
                <Button
                  disabled={isProfileSetupPending}
                  pending={isProfileSetupPending}
                  onClick={() => handleRemoveCertification(index)}
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
                    htmlFor={buildCertificationFieldId(entry.id, "name")}
                  >
                    Name
                  </FieldLabel>
                  <ProfileInput
                    id={buildCertificationFieldId(entry.id, "name")}
                    {...register(`records.certifications.${index}.name`)}
                  />
                </Field>
                <Field>
                  <FieldLabel
                    htmlFor={buildCertificationFieldId(entry.id, "issuer")}
                  >
                    Issuer
                  </FieldLabel>
                  <ProfileInput
                    id={buildCertificationFieldId(entry.id, "issuer")}
                    {...register(`records.certifications.${index}.issuer`)}
                  />
                </Field>
                <Field>
                  <FieldLabel
                    htmlFor={buildCertificationFieldId(entry.id, "issue-date")}
                  >
                    Issue date
                  </FieldLabel>
                  <ProfileInput
                    id={buildCertificationFieldId(entry.id, "issue-date")}
                    placeholder="YYYY-MM"
                    {...register(`records.certifications.${index}.issueDate`)}
                  />
                </Field>
                <Field>
                  <FieldLabel
                    htmlFor={buildCertificationFieldId(entry.id, "expiry-date")}
                  >
                    Expiry date
                  </FieldLabel>
                  <ProfileInput
                    id={buildCertificationFieldId(entry.id, "expiry-date")}
                    placeholder="YYYY-MM"
                    {...register(`records.certifications.${index}.expiryDate`)}
                  />
                </Field>
                <Field className="md:col-span-2">
                  <FieldLabel
                    htmlFor={buildCertificationFieldId(
                      entry.id,
                      "credential-url",
                    )}
                  >
                    Credential URL
                  </FieldLabel>
                  <ProfileInput
                    id={buildCertificationFieldId(entry.id, "credential-url")}
                    {...register(
                      `records.certifications.${index}.credentialUrl`,
                    )}
                  />
                </Field>
              </div>
            </ProfileRecordCard>
          ))}
        </div>
      </section>

      <ProfileBackgroundSupportingDetailSection
        backgroundArrays={backgroundArrays}
        isProfileSetupPending={isProfileSetupPending}
        profileForm={profileForm}
      />
      <ProfileBackgroundProofBankSection
        backgroundArrays={backgroundArrays}
        isProfileSetupPending={isProfileSetupPending}
        profileForm={profileForm}
      />
    </div>
  );
}
