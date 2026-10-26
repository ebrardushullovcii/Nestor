import type { ApplyAuthority, ApplyFormObservation } from "./types";

/**
 * The checks that stand between a filled form and one irreversible click.
 *
 * None of this asks the model anything. Sending an application is decided from
 * the saved authority document and from what the page itself shows: every
 * required answer present, every file attached, nothing flagged as wrong, and
 * this really being the last screen. Anything less stops (ADR 0012).
 */

export type ApplySubmitPreflightResult =
  | { ok: true }
  | { ok: false; reason: string };

/** The person's word on a field: "it's attached", for that field only. */
export type UploadEvidenceOptions = {
  confirmedByPerson?: (
    control: ApplyFormObservation["controls"][number],
  ) => boolean;
};

/** The one question a form's failed uploads become, whatever their number. */
export const UPLOAD_REPAIR_QUESTION_ID = "upload_repair";

type FileControl = ApplyFormObservation["controls"][number];
export type FileUploadProblem = {
  control: FileControl;
  state: "rejected" | "unconfirmed" | "uploading";
};

// Word edges that also hold for accented letters ("échec", "ungültig").
const word = (alternatives: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");
const uploadFailure = word(
  [
    "fail(?:ed|ure|s)?",
    "reject(?:ed|s)?",
    "unsupported",
    "invalid",
    "not (?:be )?(?:uploaded|accepted|supported|allowed)",
    "could ?n[o']t",
    "cannot",
    "can't",
    "unable to",
    "too (?:large|big|small)",
    "exceed(?:s|ed)",
    "errors?",
    "went wrong",
    "problems?",
    "fehlgeschlagen|ungültig\\p{L}*|abgelehnt|zu groß\\p{L}*|nicht unterstützt",
    "échec|échoué|invalide|refusé|trop volumineux",
    "falló|fallido|rechazado|no (?:es )?válido|demasiado grande",
    "falhou|inválido|rejeitado|muito grande",
  ].join("|"),
);
// Help and rules sit beside a file field before anything goes wrong:
// "Trouble uploading? Upload error help", "Unsupported files will be
// rejected", "Files over 5 MB are rejected". A rule speaks of files in
// general; a refusal speaks of this one.
const uploadGuidance = word(
  "help|trouble|tips?|learn more|faq|report|contact|support|if|will|must|should|accepted (?:file )?(?:types|formats)|(?:cannot|can't|may not) exceed|up to|(?:no|not) (?:larger|bigger|more) than|(?:less|smaller) than",
);
const generalRule = word("files|documents|uploads|attachments|resumes");
const thisFile = word(
  "(?:your|this|that|these|the) (?:files?|documents?|uploads?|attachments?|resumes?|cvs?)",
);
// A page-wide failure that names no field: "Something went wrong". It can
// only be about the file when the file is the one thing on the page that
// could have failed on its own.
const genericFailure = word(
  "something went wrong|an error (?:occurred|has occurred)|there was (?:a|an) (?:problem|error)",
);
const isGuidance = (clause: string) =>
  clause.endsWith("?") ||
  uploadGuidance.test(clause) ||
  (generalRule.test(clause) && !thisFile.test(clause));
const uploadSuccess = word("uploaded|attached|received|success(?:ful(?:ly)?)?");
const uploadInProgress = word("uploading|processing|scanning");
const fileWords = word(
  "files?|uploads?|attachments?|documents?|resume|cv|curriculum|lebenslauf|datei|fichier|archivo|arquivo",
);
const genericLabelWords = new Set([
  "a",
  "an",
  "and",
  "attach",
  "attachment",
  "choose",
  "document",
  "drop",
  "file",
  "here",
  "optional",
  "or",
  "required",
  "select",
  "the",
  "upload",
  "your",
]);

// Clauses, not sentences: "Upload rejected: your file must be a PDF" and
// "Your file was rejected because it must be a PDF" are a refusal followed
// by its remedy, and the remedy must not hide the refusal.
const clauses = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+|[:;,]\s+|\s[—–-]\s|\s(?:because|since)\s/iu)
    .map((line) => line.trim())
    .filter(Boolean);
const words = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const labelWords = (control: FileControl) =>
  [...words(`${control.label} ${control.groupLabel}`)].filter(
    (entry) => !genericLabelWords.has(entry),
  );
const failures = (text: string) =>
  clauses(text).filter(
    (clause) => uploadFailure.test(clause) && !isGuidance(clause),
  );

/**
 * What the site says about one chosen file. The control's own validation
 * comes first, then the server's answer to the request that carried the
 * file, then the control's own field, then page lines about this file. A
 * name in the field is not proof: async widgets show it the moment a file is
 * picked. Forms that send the file with the final submission make no upload
 * request; there the file counts once nothing reports a problem with it.
 * `confirmedByPerson` is the person saying this field's file is attached on the page they
 * hold; it settles page and field text, never a server refusal.
 */
function fileUploadState(
  control: FileControl,
  observation: ApplyFormObservation,
  confirmedByPerson: boolean,
): FileUploadProblem["state"] | "accepted" {
  const upload = control.upload;
  // A stale aria-invalid gives way only to both a server 2xx and the
  // person's word that the file is attached.
  if (
    (control.invalid || uploadFailure.test(control.validationMessage)) &&
    !(upload?.network === "accepted" && confirmedByPerson)
  )
    return "rejected";
  if (upload?.network === "rejected") return "rejected";
  if (upload?.network === "pending") return "uploading";
  // Nothing tied the server's word to this field: the page alone cannot
  // settle it, only the person can.
  if (upload?.network === "unconfirmed")
    return confirmedByPerson ? "accepted" : "unconfirmed";
  const own = `${upload?.described ?? ""}\n${upload?.nearby ?? ""}`;
  if (failures(own).length && !confirmedByPerson) return "rejected";
  if (upload?.network === "accepted" || confirmedByPerson) return "accepted";
  const mine = labelWords(control);
  const others = observation.controls.filter(
    (other) => other.kind === "file" && other.ref !== control.ref,
  );
  const pageFailure = failures(
    [...observation.validationErrors, observation.bodyTextExcerpt].join("\n"),
  ).some((line) => {
    const said = words(line);
    if (mine.some((entry) => said.has(entry))) return true;
    if (genericFailure.test(line) && !others.some((other) => other.answered))
      return true;
    return (
      fileWords.test(line) &&
      !others.some(
        (other) =>
          labelWords(other).some((entry) => said.has(entry)) ||
          `${other.upload?.described ?? ""}\n${other.upload?.nearby ?? ""}`.includes(
            line,
          ),
      )
    );
  });
  if (pageFailure) return "rejected";
  const ownLines = clauses(own).filter((line) => !isGuidance(line));
  if (
    ownLines.some(
      (line) => uploadInProgress.test(line) && !uploadSuccess.test(line),
    )
  )
    return "uploading";
  return "accepted";
}

/** A selected local file is not evidence that the site accepted its upload. */
export function fileUploadProblems(
  observation: ApplyFormObservation,
  options: UploadEvidenceOptions = {},
): FileUploadProblem[] {
  return observation.controls.flatMap((control) => {
    // An input the widget emptied after taking the file is still judged
    // when the server has a word on the file Nestor gave it.
    const network = control.upload?.network;
    if (
      control.kind !== "file" ||
      control.disabled ||
      (!control.answered && (!network || network === "accepted"))
    )
      return [];
    const state = fileUploadState(
      control,
      observation,
      options.confirmedByPerson?.(control) ?? false,
    );
    return state === "accepted" ? [] : [{ control, state }];
  });
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
        !group.some((candidate) => candidate.checked) &&
        group[0] === control
      );
    }
    return control.required && (!control.answered || control.invalid);
  });
}

/** Readiness is the same form check in every mode, including Prepare for me. */
export function checkFormReadiness(
  observation: ApplyFormObservation,
  uploads: UploadEvidenceOptions = {},
): ApplySubmitPreflightResult {
  if (observation.loading)
    return {
      ok: false,
      reason: "The form is still loading. Check it again once it finishes.",
    };
  if (observation.blocker)
    return { ok: false, reason: observation.blocker.summary };
  const upload = fileUploadProblems(observation, uploads)[0];
  if (upload)
    return {
      ok: false,
      reason:
        upload.state === "uploading"
          ? `${upload.control.label || "A file"} is still uploading. Check it again once it finishes.`
          : upload.state === "rejected"
            ? "The site did not accept the file upload. Open the application to repair it before sending."
            : `The site has not shown ${upload.control.label || "the file"} as attached. Open the application to check the upload before sending.`,
    };
  const missing = unresolvedRequiredControls(observation);
  const missingFile = missing.find((control) => control.kind === "file");
  if (missingFile)
    return {
      ok: false,
      reason: `${missingFile.label || "A required file"} is not attached or was rejected by the form.`,
    };
  if (missing.length) {
    const labels = missing.map(
      (control) =>
        control.groupLabel ||
        control.label ||
        control.placeholder ||
        "an unnamed field",
    );
    return {
      ok: false,
      reason: `Complete these required fields: ${labels.join(", ")}.`,
    };
  }
  const invalid = observation.controls.find(
    (control) =>
      !control.disabled &&
      control.invalid &&
      (control.visible || control.kind === "file"),
  );
  if (invalid || observation.validationErrors.length)
    return {
      ok: false,
      reason: `The page is still showing a problem: ${invalid?.validationMessage || observation.validationErrors[0] || invalid?.label}`,
    };
  if (hasRemainingApplicationStep(observation)) {
    return {
      ok: false,
      reason:
        "This form has another step. Continue to the final review before sending.",
    };
  }
  if (
    !observation.actions.some(
      (action) => action.kind === "final" && action.visible && !action.disabled,
    )
  ) {
    return {
      ok: false,
      reason:
        "The form's send button is not available yet. Open the form to complete the remaining step.",
    };
  }
  return { ok: true };
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function runSubmitPreflight(input: {
  observation: ApplyFormObservation;
  proposedActionRef: string;
  authority: ApplyAuthority;
  uploads?: UploadEvidenceOptions;
}): ApplySubmitPreflightResult {
  const { observation, authority } = input;

  if (authority.mode === "prepare_only") {
    return {
      ok: false,
      reason:
        "This application is set to fill in only, so Job Finder stopped before sending it.",
    };
  }

  const pageOrigin = observation.origin;
  const allowedOrigins = authority.allowedOrigins
    .map(canonicalOrigin)
    .filter((value): value is string => value !== null);
  if (!pageOrigin || !allowedOrigins.includes(pageOrigin)) {
    return {
      ok: false,
      reason: pageOrigin
        ? `Job Finder is not authorized to send an application on ${pageOrigin}. The form is still available for review.`
        : "Job Finder could not verify which site would receive this application, so it stopped before sending.",
    };
  }

  const action = observation.actions.find(
    (candidate) => candidate.ref === input.proposedActionRef,
  );
  if (!action) {
    return { ok: false, reason: "That button is not on the page any more." };
  }
  if (action.kind !== "final") {
    return {
      ok: false,
      reason: `"${action.label}" does not send the application.`,
    };
  }
  if (!action.visible || action.disabled) {
    return { ok: false, reason: `"${action.label}" cannot be used right now.` };
  }

  return checkFormReadiness(observation, input.uploads);
}

/** An optional Save on an explicitly final review step does not mean another step. */
export function hasRemainingApplicationStep(
  observation: ApplyFormObservation,
): boolean {
  const { index, total } = observation.step;
  if (index !== null && total !== null) return index < total;
  return observation.actions.some(
    (action) => action.kind === "advance" && action.visible,
  );
}
