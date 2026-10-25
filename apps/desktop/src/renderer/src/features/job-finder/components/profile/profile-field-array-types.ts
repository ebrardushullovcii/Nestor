import type { UseFieldArrayReturn } from "react-hook-form";
import type { ProfileEditorValues } from "../../lib/profile-editor";

export type ProfileFieldArrayKeyName = "fieldKey";

export interface ProfileBackgroundArrays {
  certificationArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "records.certifications",
    ProfileFieldArrayKeyName
  >;
  educationArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "records.education",
    ProfileFieldArrayKeyName
  >;
  languageArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "languages",
    ProfileFieldArrayKeyName
  >;
  linkArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "links",
    ProfileFieldArrayKeyName
  >;
  proofBankArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "proofBank",
    ProfileFieldArrayKeyName
  >;
  projectArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "projects",
    ProfileFieldArrayKeyName
  >;
}
