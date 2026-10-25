import { z } from "zod";
import { ResumeBatchCheckpointSchema } from "./resume";

import {
  IsoDateTimeSchema,
  NonEmptyStringSchema } from "./base";

// ---------------------------------------------------------------------------
// (1) Grouped reusable manual-answer decisions
//
// A grouped decision may only ever target a `manual_answer` application
// blocker. The kind, blocker, and authority are all hard literals and the
// object is strict, so it is structurally impossible to represent credentials,
// login, CAPTCHA, MFA, legal consent, account creation, upload, redirect, or
// final-submit authority.
// ---------------------------------------------------------------------------

export const groupedAnswerDecisionKindValues = ["manual_answer"] as const;
export const GroupedAnswerDecisionKindSchema = z.enum(
  groupedAnswerDecisionKindValues,
);
export type GroupedAnswerDecisionKind = z.infer<
  typeof GroupedAnswerDecisionKindSchema
>;

export const groupedAnswerDecisionBlockerValues = ["manual_answer"] as const;
export const GroupedAnswerDecisionBlockerSchema = z.enum(
  groupedAnswerDecisionBlockerValues,
);
export type GroupedAnswerDecisionBlocker = z.infer<
  typeof GroupedAnswerDecisionBlockerSchema
>;

// Named denylist of authorities this contract must never represent. Used both
// as documentation and as a defensive key scan inside the strict schema.
export const groupedDecisionForbiddenAuthorityValues = [
  "credentials",
  "login",
  "captcha",
  "mfa",
  "legal_consent",
  "account_creation",
  "upload",
  "redirect",
  "final_submit",
] as const;
export const GroupedDecisionForbiddenAuthoritySchema = z.enum(
  groupedDecisionForbiddenAuthorityValues,
);
export type GroupedDecisionForbiddenAuthority = z.infer<
  typeof GroupedDecisionForbiddenAuthoritySchema
>;

const groupedDecisionForbiddenKeySet: ReadonlySet<string> = new Set([
  "credentials",
  "credential",
  "password",
  "username",
  "login",
  "loginUrl",
  "captcha",
  "captchaToken",
  "mfa",
  "mfaCode",
  "otp",
  "legalConsent",
  "consent",
  "accountCreation",
  "accountCreationAuthorized",
  "upload",
  "uploadAuthorized",
  "redirect",
  "redirectUrl",
  "finalSubmit",
  "submitAuthorized",
  "submitUrl",
]);

export const GroupedDecisionFingerprintsSchema = z
  .object({
    // Normalized question-meaning fingerprint.
    questionMeaning: z.string().regex(/^[a-f0-9]{64}$/),
    // Normalized answer-policy fingerprint.
    answerPolicy: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type GroupedDecisionFingerprints = z.infer<
  typeof GroupedDecisionFingerprintsSchema
>;

export const groupedDecisionApprovalValues = [
  "pending",
  "approved",
  "declined",
] as const;
export const GroupedDecisionApprovalSchema = z.enum(
  groupedDecisionApprovalValues,
);
export type GroupedDecisionApproval = z.infer<
  typeof GroupedDecisionApprovalSchema
>;

export const groupedDecisionConflictStatusValues = [
  "none",
  "detected",
  "resolved",
] as const;
export const GroupedDecisionConflictStatusSchema = z.enum(
  groupedDecisionConflictStatusValues,
);
export type GroupedDecisionConflictStatus = z.infer<
  typeof GroupedDecisionConflictStatusSchema
>;

export const GroupedDecisionConflictStateSchema = z
  .object({
    status: GroupedDecisionConflictStatusSchema.default("none"),
    detectedAt: IsoDateTimeSchema.nullable().default(null),
    resolvedAt: IsoDateTimeSchema.nullable().default(null),
    conflictingDecisionId: NonEmptyStringSchema.nullable().default(null),
    summary: NonEmptyStringSchema.nullable().default(null),
  })
  .strict();
export type GroupedDecisionConflictState = z.infer<
  typeof GroupedDecisionConflictStateSchema
>;

export const GroupedDecisionSnoozeSchema = z
  .object({
    until: IsoDateTimeSchema,
    reason: NonEmptyStringSchema.nullable().default(null),
  })
  .strict();
export type GroupedDecisionSnooze = z.infer<typeof GroupedDecisionSnoozeSchema>;

export const GroupedDecisionJobLineageSchema = z
  .object({
    requestId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema.nullable().default(null),
    questionId: NonEmptyStringSchema,
    answerRecordId: NonEmptyStringSchema.nullable().default(null),
    expectedRequestRevision: z.number().int().positive(),
    expectedQuestionRevision: z.number().int().positive(),
    expectedAnswerRevision: z.number().int().nonnegative(),
    appliedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type GroupedDecisionJobLineage = z.infer<
  typeof GroupedDecisionJobLineageSchema
>;

export const GroupedManualAnswerValueSchema = z
  .object({
    type: z.literal("text"),
    value: z.string().trim().min(1).max(4_000),
  })
  .strict();
export type GroupedManualAnswerValue = z.infer<
  typeof GroupedManualAnswerValueSchema
>;

export const GroupedManualAnswerDecisionSchema = z
  .object({
    id: NonEmptyStringSchema,
    groupKey: NonEmptyStringSchema,
    kind: GroupedAnswerDecisionKindSchema.default("manual_answer"),
    blockerKind: GroupedAnswerDecisionBlockerSchema.default("manual_answer"),
    authority: z.literal("manual_answer").default("manual_answer"),
    reuseScope: z.literal("reusable").default("reusable"),
    requestId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema.nullable().default(null),
    questionId: NonEmptyStringSchema,
    expectedRevision: z.number().int().positive(),
    expectedQuestionRevision: z.number().int().positive(),
    expectedAnswerRevision: z.number().int().nonnegative(),
    fingerprints: GroupedDecisionFingerprintsSchema,
    answer: GroupedManualAnswerValueSchema,
    approval: GroupedDecisionApprovalSchema.default("pending"),
    approvedAt: IsoDateTimeSchema.nullable().default(null),
    conflict: GroupedDecisionConflictStateSchema.default({}),
    snooze: GroupedDecisionSnoozeSchema.nullable().default(null),
    lineage: z.array(GroupedDecisionJobLineageSchema).default([]),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    for (const key of Object.keys(decision)) {
      if (groupedDecisionForbiddenKeySet.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Grouped manual-answer decisions cannot carry ${key} authority.`,
        });
      }
    }

    if (decision.approval === "approved" && decision.approvedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedAt"],
        message:
          "An approved decision must record when the user explicitly approved it.",
      });
    }

    if (decision.approval !== "approved" && decision.approvedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedAt"],
        message: "Approval timestamps require an approved decision.",
      });
    }

    if (
      decision.conflict.status === "detected" &&
      decision.conflict.detectedAt === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conflict", "detectedAt"],
        message: "A detected conflict must record when it was detected.",
      });
    }

    if (
      decision.conflict.status === "resolved" &&
      decision.conflict.resolvedAt === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conflict", "resolvedAt"],
        message: "A resolved conflict must record when it was resolved.",
      });
    }

    if (
      decision.conflict.status === "none" &&
      (decision.conflict.detectedAt !== null ||
        decision.conflict.resolvedAt !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conflict"],
        message: "A conflict-free decision cannot carry conflict timestamps.",
      });
    }

    if (decision.snooze !== null && decision.approval === "approved") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snooze"],
        message: "An approved decision cannot remain snoozed.",
      });
    }
  });
export type GroupedManualAnswerDecision = z.infer<
  typeof GroupedManualAnswerDecisionSchema
>;

// ---------------------------------------------------------------------------
// (4) Conservative company entities
// ---------------------------------------------------------------------------

/** Canonical exact-comparison key for company names across service and UI. */
export function normalizeCompanyName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/(^|[^a-z0-9])c\s*\+\s*\+(?=$|[^a-z0-9])/gi, "$1cplusplus")
    .replace(/(^|[^a-z0-9])c\s*#(?=$|[^a-z0-9])/gi, "$1csharp")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const genericCompanyNameValues = [
  "agency",
  "anonymous",
  "anonymous company",
  "anonymous employer",
  "client",
  "client confidential",
  "company confidential",
  "confidential",
  "confidential client",
  "confidential company",
  "confidential employer",
  "employer confidential",
  "employer not stated",
  "hiring agency",
  "location not stated",
  "multiple companies",
  "n a",
  "na",
  "not applicable",
  "not available",
  "not disclosed",
  "not stated",
  "our client",
  "private company",
  "recruiting agency",
  "recruitment agency",
  "staffing agency",
  "stealth",
  "stealth company",
  "the client",
  "undisclosed",
  "undisclosed client",
  "undisclosed company",
  "undisclosed employer",
  "unnamed client",
  "unknown",
  "unknown client",
  "unknown company",
  "various",
] as const;

const genericCompanyNameSet: ReadonlySet<string> = new Set(
  genericCompanyNameValues,
);

/**
 * Site utility / chrome titles that must not become jobs or company shells.
 * Keep in sync with shortlist/extraction utility filters (exact, Albanian
 * privacy prefix without diacritic `\b`, marketing prefixes, open-positions).
 */
const utilitySiteChromeExactNamePattern =
  /^(blog|blogs|news|about|about us|contact|contact us|kontakt|faq|help|support|privacy|privacy policy|cookie policy|politik[eë]\s+e\s+privat[eë]sis[eë]|politika\s+e\s+privat[eë]sis[eë]|terms|sign in|log in|login|register|sign up|create cv|krijo cv|create resume|home|homepage|view all jobs|view all .+ jobs|overview|locations|pricing|jobs|remote jobs|remote|trust|curated|wellfound|wellfound:ai|why wellfound|previous|next|platform status|privacy & cookies|terms & risks|salaries|for companies|get discovered|hire developers|create profile|recruit pro|try errgo|web3 jobs|tech startups|sign up with google|produktet|publiko konkurs|llogarite pag[eë]n|llogaritja e pages|www\.fb\.com\/kosovajob|fb\.com\/kosovajob)$/i;

// Albanian privacy titles often continue after "Privatësisë". Avoid `\b` after
// diacritics — JS word boundaries treat `ë` as non-word, so `\b` fails before
// the following space.
const utilitySiteChromeAlbanianPrivacyNamePattern =
  /^politik[aeë]\s+e\s+privat[eë]sis[eë]/i;

const utilitySiteChromePrefixNamePattern =
  /^(sign up with|view all|create profile|get discovered|for companies|hire developers|platform status|privacy|privacy policy|cookie policy|terms|remote jobs|web3 jobs|tech startups|recruit pro|try errgo|why wellfound|publiko|llogarite|llogaritja|www\.fb\.com\/|fb\.com\/)\b/i;

const utilitySiteChromeOpenPositionsNamePattern = /^\d+\s+open positions$/i;

/**
 * True when a label matches site utility / chrome titles (privacy policy,
 * nav, marketing) that should not appear as jobs or company entities.
 */
export function isLikelyUtilitySiteChromeName(value: string): boolean {
  const title = value.trim();
  if (title.length === 0) {
    return false;
  }

  return (
    utilitySiteChromeExactNamePattern.test(title) ||
    utilitySiteChromeAlbanianPrivacyNamePattern.test(title) ||
    utilitySiteChromePrefixNamePattern.test(title) ||
    utilitySiteChromeOpenPositionsNamePattern.test(title)
  );
}

/** Rejects only the bounded source-generic placeholder corpus. */
export function isGenericCompanyName(value: string): boolean {
  return genericCompanyNameSet.has(normalizeCompanyName(value));
}

/**
 * True when a company display name is specific enough to list in Companies
 * intelligence (non-empty, outside the generic/absence placeholder corpus,
 * and not site utility chrome such as privacy-policy shells).
 */
// Job titles mis-read as employers ("Senior DevOps Engineer", "Customer
// Service Representative") filled a Companies list with 41 entries after one
// search. A name that ends in a role noun is a title, not a company; a
// seniority prefix alone is not enough ("Lead Bank" is a company).
const ROLE_TITLE_AS_COMPANY_PATTERN =
  /\b(?:engineer|engineers|developer|developers|programmer|manager|managers|analyst|analysts|designer|designers|specialist|specialists|coordinator|coordinators|assistant|assistants|nurse|nurses|technician|technicians|intern|interns|director|directors|representative|representatives|consultant|consultants|administrator|administrators|accountant|accountants|architect|architects|scientist|scientists|officer|officers|clerk|clerks|supervisor|supervisors|recruiter|recruiters|bookkeeper|bookkeepers|driver|drivers|cashier|cashiers|receptionist|receptionists|therapist|therapists|attendant|attendants|associate|associates)(?:\s*\(.*\))?\s*$/iu;

export function isRoleTitleMisreadAsCompany(value: string): boolean {
  return ROLE_TITLE_AS_COMPANY_PATTERN.test(value.trim());
}

// A card's posted-age token ("12d", "3h", "2w ago") or a bare number that
// landed in the employer slot; a Companies entry called "12d" followed.
const AGE_TOKEN_AS_COMPANY_PATTERN =
  /^(?:\d+\s*(?:[dhwmy]|days?|hours?|weeks?|months?|years?)(?:\s+ago)?|\d+|today|yesterday|new)$/iu;

export function isAgeTokenMisreadAsCompany(value: string): boolean {
  return AGE_TOKEN_AS_COMPANY_PATTERN.test(value.trim());
}

export function isListableCompanyName(value: string): boolean {
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    isLikelyUtilitySiteChromeName(trimmed) ||
    isUrlDerivedEmployerLabel(trimmed) ||
    isRoleTitleMisreadAsCompany(trimmed) ||
    isAgeTokenMisreadAsCompany(trimmed)
  ) {
    return false;
  }
  const normalized = normalizeCompanyName(trimmed);
  return normalized !== "" && !genericCompanyNameSet.has(normalized);
}

const URL_SCHEME_EMPLOYER_LABEL_PATTERN = /^(?:https?|ftp):\/\//i;
const WWW_EMPLOYER_LABEL_PREFIX_PATTERN = /^www\./i;
const TITLECASE_URL_HOST_PREFIX_PATTERN = /^(?:Https?|Http|Www|Ftp)\s+/;
const INLINE_DOMAIN_EMPLOYER_LABEL_PATTERN =
  /\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev|ai|us|uk|de|fr)\b/i;
/** Case-insensitive TLD tail so `… IO` / `… COM` match title-cased host fragments. */
const DOMAIN_TLD_TAIL_EMPLOYER_LABEL_PATTERN =
  /\s+(?:Com|Net|Org|Io|Co|App|Dev|Ai|Us|Uk|De|Fr)\s*$/i;
/**
 * Strong hostname TLDs almost never appear as a real display-name second word
 * (`Scan Com`, `Dearhiringmanager IO`). Ambiguous tails (`Co`, `AI`, …) need
 * longer single-token heads so brands like `Acme Co` / `Scale AI` survive.
 */
const STRONG_HOSTNAME_TLD_WORDS: ReadonlySet<string> = new Set([
  "com",
  "net",
  "org",
  "io",
  "app",
  "dev",
]);
const AMBIGUOUS_HOSTNAME_TLD_WORDS: ReadonlySet<string> = new Set([
  "co",
  "ai",
  "us",
  "uk",
  "de",
  "fr",
]);
const EMPLOYER_SLUG_SUFFIX_REJECT_PATTERN =
  /-(?:usd|eur|gbp|cad|aud|chf|jpy|cny|inr)$/i;
/** Hyphenated strong-TLD slug tails (`scan-com`, `dearhiringmanager-io`). */
const EMPLOYER_SLUG_HOSTNAME_TLD_REJECT_PATTERN =
  /-(?:com|net|org|io|app|dev)$/i;
const EMPLOYER_SLUG_ACRONYM_WORDS = new Set([
  "ai",
  "ml",
  "api",
  "sdk",
  "io",
  "it",
  "hr",
  "qa",
  "ui",
  "ux",
  "vr",
  "ar",
  "ip",
  "tv",
  "usa",
  "uk",
  "eu",
  "llc",
  "inc",
]);

/**
 * True when a single head token looks like a hostname label (TitleCase or
 * lowercase slug) rather than a multi-capital brand (`McKinsey`).
 */
function isHostnameLikeEmployerHead(token: string): boolean {
  return (
    token.length >= 3 &&
    (/^[A-Z][a-z0-9-]+$/.test(token) || /^[a-z0-9-]+$/.test(token))
  );
}

/**
 * True when a label looks like a URL, hostname, or title-cased domain fragment
 * rather than an observed employer name.
 */
export function isUrlDerivedEmployerLabel(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (
    URL_SCHEME_EMPLOYER_LABEL_PATTERN.test(trimmed) ||
    WWW_EMPLOYER_LABEL_PREFIX_PATTERN.test(trimmed) ||
    TITLECASE_URL_HOST_PREFIX_PATTERN.test(trimmed) ||
    INLINE_DOMAIN_EMPLOYER_LABEL_PATTERN.test(trimmed)
  ) {
    return true;
  }

  if (DOMAIN_TLD_TAIL_EMPLOYER_LABEL_PATTERN.test(trimmed)) {
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const tld = (words[words.length - 1] ?? "").toLowerCase();
      const head = words.slice(0, -1);
      if (head.some((word) => /^(?:Https?|Http|Www|Ftp)$/i.test(word))) {
        return true;
      }
      const body = head.join("");
      if (head.length === 1 && isHostnameLikeEmployerHead(body)) {
        if (STRONG_HOSTNAME_TLD_WORDS.has(tld)) {
          return true;
        }
        if (
          AMBIGUOUS_HOSTNAME_TLD_WORDS.has(tld) &&
          body.length >= 12 &&
          /^[A-Z][a-z]+$/.test(body)
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

/** True when a `/company/{slug}` segment should not become an employer label. */
export function shouldRejectEmployerSlugInference(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (EMPLOYER_SLUG_SUFFIX_REJECT_PATTERN.test(normalized)) {
    return true;
  }

  if (EMPLOYER_SLUG_HOSTNAME_TLD_REJECT_PATTERN.test(normalized)) {
    return true;
  }

  if (
    /^(?:www\.)?[a-z0-9-]+\.(?:com|net|org|io|co|app|dev)$/.test(normalized)
  ) {
    return true;
  }

  return false;
}

function titleCaseEmployerSlugWord(word: string): string {
  const lower = word.toLowerCase();
  if (EMPLOYER_SLUG_ACRONYM_WORDS.has(lower)) {
    return lower.toUpperCase();
  }

  if (!word) {
    return "";
  }

  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Formats a company-profile slug into a display label, returning null when the
 * result would look URL-derived or otherwise unreliable.
 */
export function formatEmployerLabelFromSlug(slug: string): string | null {
  const raw = slug.trim();
  if (!raw || shouldRejectEmployerSlugInference(raw)) {
    return null;
  }

  const displaySlug = raw.replace(/-\d+$/u, "");
  const hadSeparators = /[-_]/.test(displaySlug);
  const words = displaySlug.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) {
    return null;
  }

  if (!hadSeparators && displaySlug.length >= 10) {
    return null;
  }

  const formatted = words.map(titleCaseEmployerSlugWord).join(" ");
  return sanitizeEmployerLabel(formatted);
}

/**
 * Drops absence placeholders, URL-like labels, generic placeholders, and site
 * utility chrome so downstream UI can fall back to neutral listing copy.
 */
export function sanitizeEmployerLabel(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  if (
    isGenericCompanyName(trimmed) ||
    isLikelyUtilitySiteChromeName(trimmed) ||
    isUrlDerivedEmployerLabel(trimmed) ||
    isAgeTokenMisreadAsCompany(trimmed) ||
    /^[A-Z][a-z]{12,}$/.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

/**
 * Sanitizes observed card/listing employer text without rejecting generic
 * placeholders such as "Confidential" that boards expose intentionally.
 */
export function sanitizeObservedEmployerLabel(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  if (
    isLikelyUtilitySiteChromeName(trimmed) ||
    isUrlDerivedEmployerLabel(trimmed) ||
    // "12d" beside a card says when it was posted, not who posted it.
    isAgeTokenMisreadAsCompany(trimmed) ||
    /^[A-Z][a-z]{12,}$/.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

export const companyPreferenceValues = [
  "neutral",
  "follow",
  "prefer",
  "review",
  "exclude",
] as const;
export const CompanyPreferenceSchema = z.enum(companyPreferenceValues);
export type CompanyPreference = z.infer<typeof CompanyPreferenceSchema>;

export const companyAliasIdentityAuthorityValues = [
  "unknown",
  "user_approved_merge",
] as const;
export const CompanyAliasIdentityAuthoritySchema = z.enum(
  companyAliasIdentityAuthorityValues,
);
export type CompanyAliasIdentityAuthority = z.infer<
  typeof CompanyAliasIdentityAuthoritySchema
>;

export const CompanyAliasSchema = z
  .object({
    alias: NonEmptyStringSchema,
    normalized: NonEmptyStringSchema,
    confidence: z.number().min(0).max(1).default(1),
    identityAuthority: CompanyAliasIdentityAuthoritySchema.default("unknown"),
  })
  .strict()
  .superRefine((companyAlias, context) => {
    if (companyAlias.normalized !== normalizeCompanyName(companyAlias.alias)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["normalized"],
        message:
          "Alias normalized value must equal canonical company-name normalization.",
      });
    }
  });
export type CompanyAlias = z.infer<typeof CompanyAliasSchema>;

export const CompanyDomainSchema = z
  .object({
    domain: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
        "Domain must be a hostname with at least one dot.",
      ),
    primary: z.boolean().default(false),
    verifiedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type CompanyDomain = z.infer<typeof CompanyDomainSchema>;

export const CompanyMergeReviewCandidateSchema = z
  .object({
    candidateCompanyId: NonEmptyStringSchema,
    reason: NonEmptyStringSchema,
    decision: z
      .enum(["pending", "approved_merge", "rejected"])
      .default("pending"),
    decidedAt: IsoDateTimeSchema.nullable().default(null),
    requiresUserDecision: z.literal(true).default(true),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.decision === "pending" && review.decidedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decidedAt"],
        message: "A pending merge review cannot have a decision time.",
      });
    }
    if (review.decision !== "pending" && review.decidedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decidedAt"],
        message: "A completed merge review requires a decision time.",
      });
    }
  });
export type CompanyMergeReviewCandidate = z.infer<
  typeof CompanyMergeReviewCandidateSchema
>;

export const CompanyContactSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    role: NonEmptyStringSchema.nullable().default(null),
    email: z.string().trim().email().nullable().default(null),
    phone: NonEmptyStringSchema.nullable().default(null),
    notes: NonEmptyStringSchema.nullable().default(null),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type CompanyContact = z.infer<typeof CompanyContactSchema>;

export const CompanyNoteSchema = z
  .object({
    id: NonEmptyStringSchema,
    body: NonEmptyStringSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type CompanyNote = z.infer<typeof CompanyNoteSchema>;

export const companySalaryOfferEvidenceKindValues = [
  "listed_salary",
  "offer",
  "benefits",
  "note",
] as const;
export const CompanySalaryOfferEvidenceKindSchema = z.enum(
  companySalaryOfferEvidenceKindValues,
);
export type CompanySalaryOfferEvidenceKind = z.infer<
  typeof CompanySalaryOfferEvidenceKindSchema
>;

/**
 * Local salary/offer evidence a user records against a company. It is a plain
 * local tracking fact: it never implies an offer exists, never changes
 * application readiness, and never authorizes a submission. Money fields are
 * nullable and only comparable when the same explicit currency is present;
 * the schema never infers exchange rates.
 */
export const CompanySalaryOfferEvidenceSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: CompanySalaryOfferEvidenceKindSchema.default("note"),
    summary: NonEmptyStringSchema,
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/u)
      .nullable()
      .default(null),
    minimum: z.number().finite().nonnegative().nullable().default(null),
    maximum: z.number().finite().nonnegative().nullable().default(null),
    period: z.enum(["hour", "month", "year"]).nullable().default(null),
    offerStatus: z
      .enum(["none", "active", "accepted", "declined", "expired"])
      .nullable()
      .default(null),
    jobId: NonEmptyStringSchema.nullable().default(null),
    applicationRecordId: NonEmptyStringSchema.nullable().default(null),
    source: NonEmptyStringSchema.default("manual"),
    recordedAt: IsoDateTimeSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.minimum !== null &&
      evidence.maximum !== null &&
      evidence.minimum > evidence.maximum
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maximum"],
        message: "The maximum cannot be below the minimum.",
      });
    }
    if (
      (evidence.minimum !== null ||
        evidence.maximum !== null ||
        evidence.period !== null) &&
      evidence.currency === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message:
          "Money amounts require an explicit currency; unknown currency stays neutral.",
      });
    }
    if (
      evidence.period !== null &&
      evidence.minimum === null &&
      evidence.maximum === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["period"],
        message: "A period requires at least one amount.",
      });
    }
  });
export type CompanySalaryOfferEvidence = z.infer<
  typeof CompanySalaryOfferEvidenceSchema
>;

export const CompanySourceHistoryRefSchema = z
  .object({
    id: NonEmptyStringSchema,
    sourceId: NonEmptyStringSchema,
    firstSeenAt: IsoDateTimeSchema,
    lastSeenAt: IsoDateTimeSchema,
    applicationRecordIds: z.array(NonEmptyStringSchema).default([]),
  })
  .strict();
export type CompanySourceHistoryRef = z.infer<
  typeof CompanySourceHistoryRefSchema
>;

export const CompanyEntitySchema = z
  .object({
    id: NonEmptyStringSchema,
    canonicalName: NonEmptyStringSchema,
    aliases: z.array(CompanyAliasSchema).default([]),
    domains: z.array(CompanyDomainSchema).default([]),
    preference: CompanyPreferenceSchema.default("neutral"),
    preferenceReason: NonEmptyStringSchema.nullable().default(null),
    mergeReviewCandidates: z
      .array(CompanyMergeReviewCandidateSchema)
      .default([]),
    contacts: z.array(CompanyContactSchema).default([]),
    notes: z.array(CompanyNoteSchema).default([]),
    salaryOfferEvidence: z.array(CompanySalaryOfferEvidenceSchema).default([]),
    sourceHistory: z.array(CompanySourceHistoryRefSchema).default([]),
    jobIds: z.array(NonEmptyStringSchema).default([]),
    applicationRecordIds: z.array(NonEmptyStringSchema).default([]),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((company, context) => {
    const primaryDomainCount = company.domains.filter(
      (domain) => domain.primary,
    ).length;
    if (primaryDomainCount > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["domains"],
        message: "At most one domain can be primary.",
      });
    }
  });
export type CompanyEntity = z.infer<typeof CompanyEntitySchema>;

// ---------------------------------------------------------------------------
// (5) High-volume safeguards
// ---------------------------------------------------------------------------

export const CompanyApplicationCapSchema = z
  .object({
    id: NonEmptyStringSchema,
    companyId: NonEmptyStringSchema,
    maxApplicationsPerWindow: z.number().int().min(1).max(200),
    windowDays: z.number().int().min(1).max(365),
    currentWindowCount: z.number().int().nonnegative().default(0),
    limitReached: z.boolean().default(false),
    windowStartedAt: IsoDateTimeSchema,
    explanation: NonEmptyStringSchema,
    recoveryGuidance: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((cap, context) => {
    if (
      cap.limitReached !==
      cap.currentWindowCount >= cap.maxApplicationsPerWindow
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limitReached"],
        message: "The cap state must match the measured application count.",
      });
    }
  });
export type CompanyApplicationCap = z.infer<typeof CompanyApplicationCapSchema>;

export const simultaneousApplicationConflictStatusValues = [
  "detected",
  "resolved",
] as const;
export const SimultaneousApplicationConflictStatusSchema = z.enum(
  simultaneousApplicationConflictStatusValues,
);
export type SimultaneousApplicationConflictStatus = z.infer<
  typeof SimultaneousApplicationConflictStatusSchema
>;

export const SimultaneousApplicationConflictSchema = z
  .object({
    id: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    conflictingApplicationRecordId: NonEmptyStringSchema,
    companyKey: NonEmptyStringSchema.optional(),
    companyName: NonEmptyStringSchema.optional(),
    jobIds: z.array(NonEmptyStringSchema).min(2).optional(),
    allowedPairs: z
      .array(
        z
          .object({
            jobIds: z
              .tuple([NonEmptyStringSchema, NonEmptyStringSchema])
              .refine((ids) => ids[0] !== ids[1]),
            decidedAt: IsoDateTimeSchema,
            revokedAt: IsoDateTimeSchema.nullable(),
          })
          .strict(),
      )
      .optional(),
    status: SimultaneousApplicationConflictStatusSchema.default("detected"),
    explanation: NonEmptyStringSchema,
    recoveryGuidance: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((conflict, context) => {
    if (
      conflict.applicationRecordId === conflict.conflictingApplicationRecordId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conflictingApplicationRecordId"],
        message:
          "A simultaneous application conflict needs two distinct applications.",
      });
    }
  });
export type SimultaneousApplicationConflict = z.infer<
  typeof SimultaneousApplicationConflictSchema
>;

export const listingSignalValues = ["stale", "closed", "suspicious"] as const;
export const ListingSignalSchema = z.enum(listingSignalValues);
export type ListingSignal = z.infer<typeof ListingSignalSchema>;

export const ListingSignalRecordSchema = z
  .object({
    id: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    signal: ListingSignalSchema,
    detail: NonEmptyStringSchema.nullable().default(null),
    detectedAt: IsoDateTimeSchema,
    confidence: z.number().min(0).max(1),
    provenance: z.enum(["provider", "browser", "user", "system"]),
    explanation: NonEmptyStringSchema,
    recoveryGuidance: NonEmptyStringSchema,
  })
  .strict();
export type ListingSignalRecord = z.infer<typeof ListingSignalRecordSchema>;

/**
 * Explicit provider/browser evidence that a particular listing is stale,
 * closed, or suspicious. This is deliberately separate from free-form
 * summaries: automatic safeguards may persist only this typed evidence and
 * never infer a signal from a title, missing field, or generic failure.
 */
export const ApplicationListingSignalEvidenceSchema = z
  .object({
    jobId: NonEmptyStringSchema,
    evidenceId: NonEmptyStringSchema,
    signal: ListingSignalSchema,
    detail: NonEmptyStringSchema.nullable().default(null),
    detectedAt: IsoDateTimeSchema,
    confidence: z.number().min(0).max(1),
    provenance: z.enum(["provider", "browser"]),
    explanation: NonEmptyStringSchema,
    recoveryGuidance: NonEmptyStringSchema,
  })
  .strict();
export type ApplicationListingSignalEvidence = z.infer<
  typeof ApplicationListingSignalEvidenceSchema
>;

export const AbnormalFailurePauseSchema = z
  .object({
    id: NonEmptyStringSchema,
    windowStartedAt: IsoDateTimeSchema,
    failuresInWindow: z.number().int().nonnegative().default(0),
    sampleSize: z.number().int().nonnegative().default(0),
    failureRatePercent: z.number().min(0).max(100),
    failureRateThresholdPercent: z.number().int().min(1).max(100).default(40),
    minimumSample: z.number().int().min(1).max(1_000).default(5),
    paused: z.boolean().default(false),
    explanation: NonEmptyStringSchema,
    recoveryGuidance: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((pause, context) => {
    if (pause.failuresInWindow > pause.sampleSize) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failuresInWindow"],
        message: "Failures cannot exceed the measured sample.",
      });
    }
    const measuredRate =
      pause.sampleSize === 0
        ? 0
        : (pause.failuresInWindow / pause.sampleSize) * 100;
    if (Math.abs(measuredRate - pause.failureRatePercent) > 0.001) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureRatePercent"],
        message: "Failure rate must match the persisted counts.",
      });
    }
    if (
      pause.paused &&
      (pause.sampleSize < pause.minimumSample ||
        pause.failureRatePercent < pause.failureRateThresholdPercent)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paused"],
        message:
          "A pause requires the minimum sample and configured failure rate.",
      });
    }
  });
export type AbnormalFailurePause = z.infer<typeof AbnormalFailurePauseSchema>;

export const PreparedBatchSampleReviewSchema = z
  .object({
    id: NonEmptyStringSchema,
    batchId: NonEmptyStringSchema,
    preparedCount: z.number().int().positive(),
    sampleCount: z.number().int().positive(),
    /** Stable result ids selected for this review, persisted for restart-safe UI. */
    sampledItemIds: z.array(NonEmptyStringSchema).default([]),
    reviewedCount: z.number().int().nonnegative().default(0),
    requiredSampleRatio: z.number().min(0).max(1).default(0.2),
    reviewCompleted: z.boolean().default(false),
    explanation: NonEmptyStringSchema,
    recoveryGuidance: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((review, context) => {
    const requiredSample = Math.ceil(
      review.preparedCount * review.requiredSampleRatio,
    );
    if (review.sampleCount < requiredSample) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sampleCount"],
        message:
          "Sample count must be at least the required sample ratio of the batch.",
      });
    }
    if (review.sampleCount > review.preparedCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sampleCount"],
        message: "Sample count cannot exceed the prepared batch size.",
      });
    }
    if (review.reviewedCount > review.sampleCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewedCount"],
        message: "Reviewed count cannot exceed the sample count.",
      });
    }
    if (review.sampledItemIds.length > 0) {
      if (review.sampledItemIds.length !== review.sampleCount) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sampledItemIds"],
          message: "Persisted sample ids must match the sample count.",
        });
      }
      if (
        new Set(review.sampledItemIds).size !== review.sampledItemIds.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sampledItemIds"],
          message: "Persisted sample ids must be unique.",
        });
      }
    }
    if (review.reviewCompleted && review.reviewedCount !== review.sampleCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewCompleted"],
        message: "A completed review must have reviewed the full sample.",
      });
    }
  });
export type PreparedBatchSampleReview = z.infer<
  typeof PreparedBatchSampleReviewSchema
>;

export const contradictoryAnswerStatusValues = [
  "detected",
  "resolved",
  "dismissed",
] as const;
export const ContradictoryAnswerStatusSchema = z.enum(
  contradictoryAnswerStatusValues,
);
export type ContradictoryAnswerStatus = z.infer<
  typeof ContradictoryAnswerStatusSchema
>;

export const ContradictoryAnswerDetectionSchema = z
  .object({
    id: NonEmptyStringSchema,
    questionA: NonEmptyStringSchema,
    questionB: NonEmptyStringSchema,
    answerA: NonEmptyStringSchema,
    answerB: NonEmptyStringSchema,
    contradictionScore: z.number().min(0).max(1),
    status: ContradictoryAnswerStatusSchema.default("detected"),
    detectedAt: IsoDateTimeSchema,
    resolvedAt: IsoDateTimeSchema.nullable().default(null),
    explanation: NonEmptyStringSchema,
    recoveryGuidance: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((detection, context) => {
    if (detection.questionA === detection.questionB) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questionB"],
        message: "A contradiction requires two distinct questions.",
      });
    }
    if (detection.status === "resolved" && detection.resolvedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedAt"],
        message: "A resolved contradiction must record when it was resolved.",
      });
    }
  });
export type ContradictoryAnswerDetection = z.infer<
  typeof ContradictoryAnswerDetectionSchema
>;

// ---------------------------------------------------------------------------
// Safeguard entry kinds, dismissals, mutation commands, and the gate overview
// ---------------------------------------------------------------------------

// The exact kind vocabulary the deterministic gate uses. Dismissals reference
// these kinds plus the entry id the gate would otherwise report.
export const safeguardEntryKindValues = [
  "company_cap_limit",
  "simultaneous_application_conflict",
  "listing_signal",
  "abnormal_failure_pause",
  "batch_sample_review_pending",
  "contradictory_answer",
] as const;
export const SafeguardEntryKindSchema = z.enum(safeguardEntryKindValues);
export type SafeguardEntryKind = z.infer<typeof SafeguardEntryKindSchema>;

export const safeguardDismissalReasonValues = [
  "user_resolved",
  "rechecked",
  "not_applicable",
] as const;
export const SafeguardDismissalReasonSchema = z.enum(
  safeguardDismissalReasonValues,
);
export type SafeguardDismissalReason = z.infer<
  typeof SafeguardDismissalReasonSchema
>;

/**
 * A reversible, user-authored dismissal of one safeguard entry. It is a plain
 * local fact carrying only the entry reference, a reason, and a timestamp; the
 * strict schema makes it structurally incapable of granting credentials,
 * login, CAPTCHA, MFA, legal consent, account creation, upload, redirect, or
 * final-submit authority.
 */
export const SafeguardDismissalSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: SafeguardEntryKindSchema,
    referenceId: NonEmptyStringSchema,
    reason: SafeguardDismissalReasonSchema,
    note: NonEmptyStringSchema.max(1_000).nullable().default(null),
    dismissedAt: IsoDateTimeSchema,
  })
  .strict();
export type SafeguardDismissal = z.infer<typeof SafeguardDismissalSchema>;

export const CompanyCapConfigSchema = z
  .object({
    companyId: NonEmptyStringSchema,
    maxApplicationsPerWindow: z.number().int().min(1).max(200),
    windowDays: z.number().int().min(1).max(365),
    windowStartedAt: IsoDateTimeSchema,
    explanation: NonEmptyStringSchema,
    recoveryGuidance: NonEmptyStringSchema,
  })
  .strict();
export type CompanyCapConfig = z.infer<typeof CompanyCapConfigSchema>;

export const AbnormalFailureEvidenceSchema = z
  .object({
    attemptId: NonEmptyStringSchema,
    failed: z.boolean(),
    occurredAt: IsoDateTimeSchema,
  })
  .strict();

export const AbnormalFailureConfigSchema = z
  .object({
    windowDays: z.number().int().min(1).max(365),
    failureRateThresholdPercent: z.number().int().min(1).max(100),
    minimumSample: z.number().int().min(1).max(1_000),
    explanation: NonEmptyStringSchema,
    recoveryGuidance: NonEmptyStringSchema,
  })
  .strict();

export const safeguardBlockerScopeValues = [
  "discovery",
  "apply",
  "all",
] as const;
export const SafeguardBlockerScopeSchema = z.enum(safeguardBlockerScopeValues);
export type SafeguardBlockerScope = z.infer<typeof SafeguardBlockerScopeSchema>;

export const JobFinderIntelligenceSafeguardsSchema = z
  .object({
    companyApplicationCaps: z.array(CompanyApplicationCapSchema).default([]),
    simultaneousApplicationConflicts: z
      .array(SimultaneousApplicationConflictSchema)
      .default([]),
    listingSignals: z.array(ListingSignalRecordSchema).default([]),
    abnormalFailurePauses: z.array(AbnormalFailurePauseSchema).default([]),
    preparedBatchSampleReviews: z
      .array(PreparedBatchSampleReviewSchema)
      .default([]),
    contradictoryAnswerDetections: z
      .array(ContradictoryAnswerDetectionSchema)
      .default([]),
    // Explicit, reversible dismissals that suppress a specific safeguard entry
    // (by kind + reference id) in the deterministic gate. Dismissals are plain
    // local facts: they never grant credentials, login, CAPTCHA, MFA, legal
    // consent, account creation, upload, redirect, or final-submit authority.
    safeguardDismissals: z.array(SafeguardDismissalSchema).default([]),
    updatedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type JobFinderIntelligenceSafeguards = z.infer<
  typeof JobFinderIntelligenceSafeguardsSchema
>;

export type PlanSafeguardPause = {
  id: string;
  campaignId: string;
  planName: string;
  title: string;
  explanation: string;
  route: "/job-finder/safeguards";
};

export const JobFinderIntelligenceStateSchema = z
  .object({
    groupedDecisions: z
      .array(GroupedManualAnswerDecisionSchema)
      .max(5_000)
      .default([]),
    resumeBatchCheckpoint: ResumeBatchCheckpointSchema.nullable().optional(),
    resumeBatchCheckpoints: z.array(ResumeBatchCheckpointSchema).optional(),
    /**
     * Shortlisted jobs whose resume is waiting to be written or being
     * written because they were shortlisted (ADR 0076).
     */
    resumeOnShortlistJobIds: z
      .array(NonEmptyStringSchema)
      .max(10_000)
      .optional(),
    companies: z.array(CompanyEntitySchema).max(20_000).default([]),
    safeguards: JobFinderIntelligenceSafeguardsSchema.default({}),
    updatedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type JobFinderIntelligenceState = z.infer<
  typeof JobFinderIntelligenceStateSchema
>;

export const ApplyGroupedManualAnswerInputSchema = z
  .object({
    decisionId: NonEmptyStringSchema,
    requestIds: z.array(NonEmptyStringSchema).min(2).max(500),
    expectedRequestRevisions: z.record(
      NonEmptyStringSchema,
      z.number().int().nonnegative(),
    ),
    answer: GroupedManualAnswerValueSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const requestIds = new Set(input.requestIds);
    if (requestIds.size !== input.requestIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestIds"],
        message: "Grouped answer request ids must be unique.",
      });
    }
    const revisionIds = Object.keys(input.expectedRequestRevisions);
    if (
      revisionIds.length !== requestIds.size ||
      revisionIds.some((requestId) => !requestIds.has(requestId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedRequestRevisions"],
        message:
          "Expected revisions must cover exactly the grouped request ids.",
      });
    }
  });
export type ApplyGroupedManualAnswerInput = z.infer<
  typeof ApplyGroupedManualAnswerInputSchema
>;

export const SnoozeGroupedDecisionInputSchema = z
  .object({
    decisionId: NonEmptyStringSchema,
    expectedRevision: z.number().int().nonnegative(),
    until: IsoDateTimeSchema,
    reason: NonEmptyStringSchema.max(1_000).nullable().default(null),
  })
  .strict();
export type SnoozeGroupedDecisionInput = z.infer<
  typeof SnoozeGroupedDecisionInputSchema
>;

/**
 * Typed create/project command for grouped reusable manual answers. It is
 * rooted in exactly one pending application-scoped manual-answer request plus
 * the user-entered text answer. `expectedRequestRevision` compare-and-swaps
 * that root request so the create flow never projects from a stale snapshot;
 * the service may only project proven-compatible pending requests and must
 * never silently overwrite an existing pending/approved decision.
 */
export const ProjectGroupedManualAnswerCommandSchema = z
  .object({
    groupKey: NonEmptyStringSchema,
    requestId: NonEmptyStringSchema,
    expectedRequestRevision: z.number().int().positive(),
    answer: GroupedManualAnswerValueSchema,
    // Grouped decisions are structurally reusable, so the project command can
    // only ever root a reusable-profile answer.
    saveScope: z.literal("reusable_profile").default("reusable_profile"),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.answer.type !== "text") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: "Grouped manual-answer reuse requires a text answer.",
      });
    }
  });
export type ProjectGroupedManualAnswerCommand = z.infer<
  typeof ProjectGroupedManualAnswerCommandSchema
>;
