import type { ApplyFormObservation } from "./types";
export type UploadEvidenceOptions = {
  confirmedByPerson?: (
    control: ApplyFormObservation["controls"][number],
  ) => boolean;
};
export const UPLOAD_REPAIR_QUESTION_ID = "upload_repair";
export const STEP_HANDOVER_QUESTION_ID = "step_handover";
type FileControl = ApplyFormObservation["controls"][number];
export type FileUploadProblem = {
  control: FileControl;
  state: "rejected" | "unconfirmed" | "uploading";
  rule: string;
};
export function retainedForFormSubmission(control: FileControl): boolean {
  const upload = control.upload;
  return (
    control.kind === "file" &&
    upload?.formSubmits === true &&
    !!upload.fileName &&
    upload.fileName === upload.selectedFileName &&
    upload.fileSize !== undefined &&
    upload.fileSize === upload.selectedFileSize
  );
}

/** A selected local file is not evidence that the site accepted its upload. */
export function fileUploadProblems(
  observation: ApplyFormObservation,
  options: UploadEvidenceOptions = {},
): FileUploadProblem[] {
  void options;
  return observation.controls.flatMap<FileUploadProblem>((control) => {
    const state = control.upload?.network;
    if (state === "rejected" || state === "unconfirmed")
      return [{ control, state, rule: "upload request observation" }];
    if (state === "pending")
      return [
        {
          control,
          state: "uploading" as const,
          rule: "upload request in progress",
        },
      ];
    return [];
  });
}

/**
 * Whether a field holds its answer. Some widgets (Greenhouse) empty their
 * file input once they have the file; the storage's receipt for the file
 * Nestor gave it still makes the field attached.
 */
export function holdsAnswer(control: FileControl): boolean {
  return (
    (control.answered && !control.answerUnverified) ||
    (control.kind === "file" &&
      (control.upload?.network === "accepted" ||
        (!!control.upload?.selectedFileName &&
          `${control.upload.described}\n${control.upload.nearby}`
            .toLowerCase()
            .includes(control.upload.selectedFileName.toLowerCase()))))
  );
}

export function unresolvedRequiredControls(observation: ApplyFormObservation) {
  return observation.controls.filter((control, _index, controls) => {
    if (control.disabled || (!control.visible && control.kind !== "file"))
      return false;
    if (
      control.kind === "radio" ||
      (control.kind === "checkbox" && control.choiceGroupKey)
    ) {
      const group = controls.filter(
        (candidate) =>
          candidate.kind === control.kind &&
          !candidate.disabled &&
          candidate.visible &&
          (control.choiceGroupKey
            ? candidate.choiceGroupKey === control.choiceGroupKey
            : candidate.ref === control.ref),
      );
      return (
        group.some((candidate) => candidate.required) &&
        (!group.some((candidate) => candidate.checked) ||
          group.some((candidate) => candidate.answerUnverified)) &&
        group[0] === control
      );
    }
    return control.required && (!holdsAnswer(control) || control.invalid);
  });
}

export function hasRemainingApplicationStep(
  observation: ApplyFormObservation,
): boolean {
  const { index, total } = observation.step;
  return index !== null && total !== null
    ? index < total
    : observation.actions.some(
        (action) => action.kind === "advance" && action.visible,
      );
}
