import type {
  ApplicationAttestationKind,
  ApplicationQuestionControlType,
  ApplicationQuestionKind,
} from "@nestor/contracts";

import type {
  ApplyActionKind,
  ApplyControlKind,
  ApplyFormControl,
  ApplyFormAction,
  ApplyBlocker,
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
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’“”]/gu, "'")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
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

/** Meaning supplied by the page-reading model, independent of the button's language. */
export const PAGE_READING_PARAMETERS = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          purpose: {
            type: "string",
            enum: ["next", "save", "submit", "back", "sign_in", "other"],
          },
        },
        required: ["ref", "purpose"],
        additionalProperties: false,
      },
    },
    securityControlRefs: { type: "array", items: { type: "string" } },
    blocker: {
      type: ["object", "null"],
      properties: {
        code: {
          type: "string",
          enum: [
            "browser_blocked",
            "site_login_required",
            "account_creation_required",
            "security_challenge",
            "multi_factor_required",
            "application_closed",
          ],
        },
        requiresPerson: { type: "boolean" },
        summary: { type: "string" },
        detail: { type: "string" },
        nextActionLabel: { type: "string" },
      },
      required: [
        "code",
        "requiresPerson",
        "summary",
        "detail",
        "nextActionLabel",
      ],
      additionalProperties: false,
    },
  },
  required: ["actions", "securityControlRefs", "blocker"],
  additionalProperties: false,
} as const;

export const PAGE_READING_INSTRUCTIONS = [
  "Read pageReading from the page's meaning and native form facts, in every language. Report every visible action ref once: next (advance/review), save (save and continue), submit (final application send), back, sign_in, or other. Native submitsForm alone does not tell an intermediate save from a final send. For example Weiter can advance and Absenden can send; use the whole page, not a word list. Tabs select a panel, not a form step.",
  "Report a blocker only when the page actually prevents progress: browser refusal, sign-in, required account creation, an active human security challenge, an automatic browser check, MFA, or a closed application. Routine security/privacy wording, footer sign-in links, completed checks, hidden CAPTCHA scripts and resume-upload status are not blockers. A puzzle or slider asking to prove a human is present is security_challenge regardless of wording. An automatic check has requiresPerson false: wait for it. A human challenge has requiresPerson true. MFA always needs the person. List the refs of fields belonging to a human security check in securityControlRefs, never ordinary consent fields. Do not treat these controls as applicant questions. These are meaning reads only: existing browser permissions, final-send authority and outcome checks still decide every action.",
].join(" ");

export interface ApplyPageReading {
  actions: {
    ref: string;
    purpose: "next" | "save" | "submit" | "back" | "sign_in" | "other";
  }[];
  securityControlRefs: string[];
  blocker: ApplyBlocker | null;
}

export function parseApplyPageReading(value: unknown): ApplyPageReading | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.actions) ||
    !Array.isArray(raw.securityControlRefs) ||
    !raw.securityControlRefs.every((ref) => typeof ref === "string")
  )
    return null;
  const actions: ApplyPageReading["actions"] = [];
  for (const item of raw.actions) {
    if (!item || typeof item !== "object") return null;
    const action = item as Record<string, unknown>;
    const purpose = action.purpose;
    if (
      typeof action.ref !== "string" ||
      (purpose !== "next" &&
        purpose !== "save" &&
        purpose !== "submit" &&
        purpose !== "back" &&
        purpose !== "sign_in" &&
        purpose !== "other") ||
      actions.some((entry) => entry.ref === action.ref)
    )
      return null;
    actions.push({ ref: action.ref, purpose });
  }
  let blocker: ApplyPageReading["blocker"] = null;
  if (raw.blocker !== null) {
    if (!raw.blocker || typeof raw.blocker !== "object") return null;
    const entry = raw.blocker as Record<string, unknown>;
    const code = entry.code;
    if (
      code !== "browser_blocked" &&
      code !== "site_login_required" &&
      code !== "account_creation_required" &&
      code !== "security_challenge" &&
      code !== "multi_factor_required" &&
      code !== "application_closed"
    )
      return null;
    if (
      typeof entry.requiresPerson !== "boolean" ||
      typeof entry.summary !== "string" ||
      typeof entry.detail !== "string" ||
      typeof entry.nextActionLabel !== "string"
    )
      return null;
    blocker = {
      code,
      requiresPerson: code === "multi_factor_required" || entry.requiresPerson,
      summary: entry.summary,
      detail: entry.detail,
      nextActionLabel: entry.nextActionLabel,
    };
  }
  return {
    actions,
    securityControlRefs: raw.securityControlRefs,
    blocker,
  };
}

export function applyActionReading(
  actions: ApplyFormAction[],
  reading: ApplyPageReading,
): void {
  for (const action of actions) {
    const purpose = reading.actions.find(
      (entry) => entry.ref === action.ref,
    )?.purpose;
    action.kind =
      action.role === "tab"
        ? "other"
        : purpose === "next" || purpose === "save"
          ? "advance"
          : purpose === "submit"
            ? "final"
            : purpose === "back"
              ? "back"
              : "other";
  }
}
