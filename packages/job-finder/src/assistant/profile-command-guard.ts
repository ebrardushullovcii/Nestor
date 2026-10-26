import {
  CommitProfileEditsInputSchema,
  PatchProfileInputSchema,
  PatchGoalsInputSchema,
  ProfileRecordSchema,
  RemoveProfileRecordInputSchema,
} from "@nestor/contracts";
import { AssistantToolError, type AssistantToolContext } from "./tool-kit";

function patchFields(patch: { fields?: object; lists?: object }) {
  return [
    ...Object.keys(patch.fields ?? {}),
    ...Object.keys(patch.lists ?? {}),
  ];
}

/** A chat command may update other fields while the person types, but never those drafts. */
export function guardProfileCommand(
  name: string,
  input: unknown,
  { session }: AssistantToolContext,
): void {
  const editor = session.context?.editor;
  if (editor?.editor !== "profile" || !editor.dirtyFields.length) return;
  let touched: string[];
  switch (name) {
    case "patch_profile":
      touched = patchFields(PatchProfileInputSchema.parse(input));
      break;
    case "patch_profile_goals":
      touched = patchFields(PatchGoalsInputSchema.parse(input));
      break;
    case "upsert_profile_record":
      touched = [ProfileRecordSchema.parse(input).collection];
      break;
    case "remove_profile_record":
      touched = [RemoveProfileRecordInputSchema.parse(input).collection];
      break;
    case "set_work_permissions":
      touched = ["workEligibility"];
      break;
    case "set_resume_approach":
      touched = ["tailoringMode"];
      break;
    case "commit_profile_edits": {
      const patch = CommitProfileEditsInputSchema.parse(input);
      touched = [
        ...patchFields(patch.profile ?? {}),
        ...patchFields(patch.goals ?? {}),
        ...patch.upsert.map((row) => row.collection),
        ...patch.remove.map((row) => row.collection),
        ...(patch.workPermissions ? ["workEligibility"] : []),
        ...(patch.resumeIdentityChoice
          ? [
              "firstName",
              "middleName",
              "lastName",
              "fullName",
              "preferredDisplayName",
            ]
          : []),
      ];
      break;
    }
    default:
      return;
  }
  const dirty = new Set(
    editor.dirtyFields.map((field) => field.split(/[.[]/u)[0]),
  );
  const clashes = [
    ...new Set(touched.map((field) => field.split(".")[0]!)),
  ].filter((field) => dirty.has(field));
  if (clashes.length)
    throw new AssistantToolError(
      "conflict",
      `The person has unsaved edits in ${clashes.join(", ")}. Leave those fields out or let them save their edits first.`,
      { unsavedFields: clashes, unsavedValues: editor.unsavedValues },
    );
}
