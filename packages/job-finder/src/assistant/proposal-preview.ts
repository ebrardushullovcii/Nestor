import type { AssistantPersonalState } from "./store-reads";
import type {
  ProfileCopilotPatchOperation,
  ResumeDraft,
  ResumeDraftPatch,
} from "@nestor/contracts";
import { plainFieldName } from "./prompt";

const hiddenFields = new Set([
  "id",
  "origin",
  "sourceRefs",
  "createdAt",
  "updatedAt",
  "isDraft",
]);
const hidden = (key: string) => hiddenFields.has(key) || /Ids?$/u.test(key);
const recordGroups: Record<string, { field: string; label: string }> = {
  experience_record: { field: "experiences", label: "role" },
  education_record: { field: "education", label: "education" },
  certification_record: { field: "certifications", label: "certification" },
  project_record: { field: "projects", label: "project" },
  link_record: { field: "links", label: "link" },
  language_record: { field: "spokenLanguages", label: "language" },
  proof_point: { field: "proofBank", label: "achievement" },
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value))
    return value.length ? value.map(text).join("\n") : "None";
  return Object.entries(record(value))
    .filter(([key]) => !hidden(key))
    .map(([key, field]) => `${plainFieldName(key)}: ${text(field)}`)
    .join("\n");
}
function fieldsPreview(before: unknown, after: Record<string, unknown>) {
  const current = record(before);
  return Object.entries(after)
    .filter(([key]) => !hidden(key))
    .map(
      ([key, value]) =>
        `Current ${plainFieldName(key).toLowerCase()}: ${text(current[key])}\nProposed ${plainFieldName(key).toLowerCase()}: ${text(value)}`,
    )
    .join("\n\n");
}
function recordName(value: unknown, fallback: string) {
  const row = record(value);
  return text(
    row.title ??
      row.schoolName ??
      row.name ??
      row.label ??
      row.language ??
      row.companyName ??
      fallback,
  );
}

/** Exact replacements are derived from typed payloads, rather than model prose. */
export function profileProposalPreview(
  operation: ProfileCopilotPatchOperation,
  snapshot: Pick<
    AssistantPersonalState,
    "profile" | "searchPreferences" | "settings" | "profileSetupState"
  >,
) {
  const profile = record(snapshot.profile);
  const preferences = record(snapshot.searchPreferences);
  if ("record" in operation || "recordId" in operation) {
    const group =
      recordGroups[operation.operation.replace(/^(upsert|remove)_/u, "")]!;
    const rows = profile[group.field];
    const id = "record" in operation ? operation.record.id : operation.recordId;
    const before: unknown = Array.isArray(rows)
      ? rows.find((row: unknown) => record(row).id === id)
      : null;
    const removing = "recordId" in operation;
    const after = "record" in operation ? record(operation.record) : {};
    const name = recordName(before ?? after, group.label);
    const fields = Object.keys(after)
      .filter((key) => !hidden(key))
      .map((key) => plainFieldName(key).toLowerCase());
    return {
      label:
        `${removing ? "Remove" : before ? "Update" : "Add"} ${removing || !before ? group.label : fields.join(", ")} ${before ? "under" : "for"} ${name}`.slice(
          0,
          400,
        ),
      detail: removing
        ? `Current: ${text(before)}\nProposed: Remove this ${group.label}`
        : fieldsPreview(before, after),
    };
  }
  if (operation.operation === "remove_profile_list_entries") {
    const before = profile[operation.field] ?? preferences[operation.field];
    const after = Array.isArray(before)
      ? before.filter((item) => !operation.values.includes(String(item)))
      : [];
    return {
      label:
        `Remove ${operation.values.join(", ")} from ${plainFieldName(operation.field).toLowerCase()}`.slice(
          0,
          400,
        ),
      detail: fieldsPreview(
        { [operation.field]: before },
        { [operation.field]: after },
      ),
    };
  }
  if (operation.operation === "reorder_education_records") {
    return {
      label: "Reorder education",
      detail: `Current: ${snapshot.profile.education.map((row) => row.schoolName).join("\n")}\nProposed: ${operation.orderedRecordIds.map((id) => snapshot.profile.education.find((row) => row.id === id)?.schoolName ?? "Education").join("\n")}`,
    };
  }
  if (operation.operation === "resolve_review_items") {
    return {
      label: "Resolve profile review suggestions",
      detail: snapshot.profileSetupState.reviewItems
        .filter((item) => operation.reviewItemIds.includes(item.id))
        .map((item) => item.label)
        .join("\n"),
    };
  }
  if (operation.operation === "set_resume_approach") {
    const names: Record<string, string> = {
      original_resume: "Original",
      conservative: "Light",
      balanced: "Tailored",
      aggressive: "Aggressive",
    };
    const before =
      snapshot.settings.resumeApplicationMode === "original_resume"
        ? "original_resume"
        : snapshot.searchPreferences.tailoringMode;
    return {
      label: "Change the resume level for new jobs",
      detail: `Current: ${names[before]}\nProposed: ${names[operation.value]}`,
    };
  }
  const targets: Record<string, unknown> = {
    replace_identity_fields: snapshot.profile,
    replace_work_eligibility_fields: snapshot.profile.workEligibility,
    replace_professional_summary_fields: {
      ...snapshot.profile.professionalSummary,
      fullSummary:
        snapshot.profile.professionalSummary.fullSummary ??
        snapshot.profile.summary,
    },
    replace_narrative_fields: profile.narrative,
    replace_application_identity_fields: profile.applicationIdentity,
    replace_skill_group_fields: profile.skillGroups,
    replace_profile_list_fields: { ...preferences, ...profile },
    replace_search_preferences_fields: preferences,
    replace_compensation_preferences_fields: preferences.compensation,
  };
  const value = record(operation.value);
  return {
    label: `Update ${Object.keys(value)
      .map((key) => plainFieldName(key).toLowerCase())
      .join(", ")}`.slice(0, 400),
    detail: fieldsPreview(targets[operation.operation], value),
  };
}

export function resumeProposalPreview(
  patch: Pick<ResumeDraftPatch, "operation" | "targetSectionId"> &
    Partial<ResumeDraftPatch>,
  draft: ResumeDraft,
) {
  const section = draft.sections.find(
    (row) => row.id === patch.targetSectionId,
  );
  const entry = section?.entries.find((row) => row.id === patch.targetEntryId);
  const bullet = (entry?.bullets ?? section?.bullets)?.find(
    (row) => row.id === patch.targetBulletId,
  );
  const place = entry?.title ?? section?.label ?? "resume";
  const labels: Record<ResumeDraftPatch["operation"], string> = {
    replace_section_text: "Rewrite",
    replace_section_bullets: "Replace achievements under",
    replace_entry_summary: "Rewrite the summary under",
    replace_entry_date_range: "Restore the date wording under",
    insert_bullet: "Add an achievement under",
    update_bullet: "Rewrite an achievement under",
    remove_bullet: "Remove an achievement under",
    move_bullet: "Reorder achievements under",
    move_entry: "Reorder",
    toggle_include: patch.newIncluded ? "Include" : "Exclude",
    set_lock: patch.newLocked ? "Lock" : "Unlock",
    reset_entry_order: "Reset the order under",
  };
  const before =
    patch.operation === "replace_section_text"
      ? section?.text
      : patch.operation === "replace_entry_summary"
        ? entry?.summary
        : patch.operation === "replace_entry_date_range"
          ? entry?.dateRange
          : bullet?.text;
  return {
    label: `${labels[patch.operation]} ${place}`.slice(0, 400),
    detail:
      patch.operation === "replace_section_bullets"
        ? `Current: ${text(section?.bullets.map((row) => row.text))}\nProposed: ${text(patch.newBullets?.map((row) => row.text))}`
        : patch.newText != null || patch.operation === "remove_bullet"
          ? `Current: ${text(before)}\nProposed: ${patch.operation === "remove_bullet" ? "Remove this achievement" : text(patch.newText)}`
          : null,
  };
}
