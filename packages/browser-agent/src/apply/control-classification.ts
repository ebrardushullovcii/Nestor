import type {
  ApplicationAttestationKind,
  ApplicationQuestionControlType,
  ApplicationQuestionKind,
} from "@nestor/contracts";

import type {
  ApplyActionKind,
  ApplyControlKind,
  ApplyFormControl,
} from "./types";

/**
 * Reading a form control's meaning from what it says about itself.
 *
 * Everything here works from the words on the page and the control's own
 * markup. There is nothing per-site: the same rules read an in-page modal, a
 * multi-screen form, and a single long page.
 */

export function normalizeSignal(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’“”]/gu, "'")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function controlSignalText(
  control: Pick<ApplyFormControl, "label" | "groupLabel" | "placeholder"> & {
    name?: string;
    id?: string;
    autocomplete?: string;
  },
): string {
  return normalizeSignal(
    [
      control.label,
      control.groupLabel,
      control.placeholder,
      control.name ?? "",
      control.id ?? "",
      control.autocomplete ?? "",
    ].join(" "),
  );
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

const QUESTION_KIND_SIGNALS: ReadonlyArray<
  readonly [ApplicationQuestionKind, readonly string[]]
> = [
  ["resume", ["resume", "cv", "curriculum vitae", "upload your resume"]],
  [
    "cover_letter",
    [
      "cover letter",
      "covering letter",
      "motivation letter",
      "motivational letter",
      "letter of motivation",
    ],
  ],
  [
    "work_authorization",
    [
      "work authorization",
      "work authorisation",
      "authorized to work",
      "authorised to work",
      "legally authorized",
      "legally authorised",
      "right to work",
      "work permit",
      "eligible to work",
    ],
  ],
  [
    "visa_sponsorship",
    [
      "sponsorship",
      "sponsor",
      "visa",
      "require sponsorship",
      "immigration status",
    ],
  ],
  [
    "salary_expectation",
    [
      "salary",
      "compensation",
      "expected pay",
      "pay expectation",
      "desired salary",
      "rate expectation",
      "remuneration",
      "currency",
      "current pay",
      "past pay",
      "pay history",
      "hourly rate",
    ],
  ],
  ["notice_period", ["notice period", "how much notice", "resignation period"]],
  [
    "availability",
    [
      "start date",
      "available to start",
      "availability",
      "earliest start",
      "when can you start",
    ],
  ],
  [
    "relocation",
    ["relocate", "relocation", "willing to move", "willing to relocate"],
  ],
  ["travel", ["travel", "willing to travel", "travel requirement"]],
  [
    "clearance",
    ["security clearance", "clearance level", "government clearance"],
  ],
  [
    "portfolio",
    [
      "portfolio",
      "website",
      "personal site",
      "profile url",
      "profile link",
      "repository",
      "code sample",
    ],
  ],
  [
    "experience",
    [
      "years of experience",
      "years of professional experience",
      "how many years",
      "experience with",
      "level of experience",
      "describe your experience",
    ],
  ],
  [
    "location",
    [
      "city",
      "current location",
      "where are you based",
      "postal code",
      "zip code",
      "country",
      "state",
      "province",
      "address",
    ],
  ],
  [
    "personal_info",
    [
      "first name",
      "last name",
      "given name",
      "family name",
      "surname",
      "full name",
      "preferred name",
      "email",
      "phone",
      "mobile",
      "telephone",
      "pronouns",
    ],
  ],
];

export function inferQuestionKind(
  control: Pick<
    ApplyFormControl,
    "label" | "groupLabel" | "placeholder" | "kind"
  >,
): ApplicationQuestionKind {
  const signal = controlSignalText(control);
  if (inferAttestationKind(control) !== null) return "other";
  // Choice labels are sometimes observed together with every option. A
  // job-source question can therefore contain "Company website" even though
  // it is not asking for the candidate's portfolio URL. Keep that question
  // in the exact-answer lane so a saved "Job board" answer wins.
  if (
    containsAny(signal, [
      "how did you hear about",
      "where did you hear about",
      "how did you find this job",
      "how did you learn about",
    ])
  ) {
    return "other";
  }
  for (const [kind, needles] of QUESTION_KIND_SIGNALS) {
    if (containsAny(signal, needles)) {
      return kind;
    }
  }
  // A file control that names no resume, letter or portfolio is some other
  // document (a transcript, a certificate, a work sample, or one the page
  // does not name). Calling it a resume hid Profile › Files from the person
  // and kept a restored transcript from continuing the application.
  return "other";
}

const ATTESTATION_SIGNALS: ReadonlyArray<
  readonly [ApplicationAttestationKind, readonly string[]]
> = [
  [
    "equal_opportunity_self_identification",
    [
      "equal opportunity",
      "equal employment",
      "self identify",
      "self identification",
      "voluntary self",
      "race ethnicity",
      "gender identity",
      "veteran status",
      "disability status",
      "protected veteran",
      // The bare words a form actually prints above these lists. Without
      // them a self-identification question reads as an ordinary question and
      // is put to the person, which is exactly what it must never be.
      "gender",
      "race",
      "ethnicity",
      "hispanic",
      "latino",
      "veteran",
      "disability",
      "sexual orientation",
      "transgender",
    ],
  ],
  [
    "background_check_consent",
    [
      "background check",
      "background screening",
      "criminal record check",
      "consent to a background",
      "reference check consent",
    ],
  ],
  [
    "truthfulness_certification",
    [
      "i certify",
      "i confirm that the information",
      "i declare",
      "information is true",
      "accurate and complete",
      "to the best of my knowledge",
      "under penalty",
    ],
  ],
  [
    "terms_acceptance",
    [
      "terms and conditions",
      "terms of service",
      "terms of use",
      "agree to the terms",
      "applicant agreement",
    ],
  ],
  [
    "privacy_notice_acknowledgement",
    [
      "privacy policy",
      "privacy notice",
      "data protection",
      "processing of my personal data",
      "consent to the processing",
      "candidate privacy",
    ],
  ],
  [
    "marketing_contact_consent",
    [
      "marketing",
      "newsletter",
      "future opportunities",
      "keep me informed",
      "contact me about other",
      "talent community",
    ],
  ],
];

export function inferAttestationKind(
  control: Pick<
    ApplyFormControl,
    "label" | "groupLabel" | "placeholder" | "kind"
  >,
): ApplicationAttestationKind | null {
  const signal = controlSignalText(control);
  for (const [kind, needles] of ATTESTATION_SIGNALS) {
    if (containsAny(signal, needles)) {
      return kind;
    }
  }
  return null;
}

export function toAnswerControlType(
  kind: ApplyControlKind,
  multiple: boolean,
): ApplicationQuestionControlType {
  switch (kind) {
    case "file":
      return "file";
    case "date":
      return "date";
    case "checkbox":
      return "boolean";
    case "radio":
      return "single_choice";
    case "select":
    case "combobox":
      return multiple ? "multi_choice" : "single_choice";
    default:
      return "text";
  }
}

const FINAL_ACTION_SIGNALS = [
  "submit application",
  "submit my application",
  "send application",
  "submit",
  "apply now",
  "finish and submit",
  "send my application",
  "complete application",
];

const ADVANCE_ACTION_SIGNALS = [
  "next",
  "continue",
  "save and continue",
  "save and next",
  "proceed",
  "review",
  "go to next",
];

const BACK_ACTION_SIGNALS = ["back", "previous", "go back", "return to"];

export function inferActionKind(label: string): ApplyActionKind {
  const signal = normalizeSignal(label);
  if (!signal) {
    return "other";
  }
  if (containsAny(signal, FINAL_ACTION_SIGNALS)) {
    return "final";
  }
  if (containsAny(signal, BACK_ACTION_SIGNALS)) {
    return "back";
  }
  if (containsAny(signal, ADVANCE_ACTION_SIGNALS)) {
    return "advance";
  }
  return "other";
}

/** True when the control already holds an answer a person would call filled in. */
export function isControlAnswered(control: ApplyFormControl): boolean {
  switch (control.kind) {
    case "checkbox":
    case "radio":
      return control.checked;
    case "select":
      // A native select can display placeholder text while its submitted value
      // is still empty. The label is presentation; the value is the answer.
      return control.value.trim().length > 0 && !control.invalid;
    case "combobox":
      return (
        control.selectedOptionLabel.trim().length > 0 ||
        control.value.trim().length > 0
      );
    case "file":
      return control.value.trim().length > 0;
    default:
      return control.value.trim().length > 0;
  }
}
