import type {
  ApplicationAttemptListRow,
  ApplicationEvent,
  ApplicationRecord,
  ApplicationStatus,
  AssetStatus,
  CandidateProfile,
  ProfileSetupState,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import type {
  BadgeTone,
  BooleanSelectValue,
  CertificationFormEntry,
  EducationFormEntry,
  ExperienceFormEntry,
  LanguageFormEntry,
  LinkFormEntry,
  ProjectFormEntry,
} from "./job-finder-types";

// Building an Intl formatter costs far more than using one: a fresh one per
// call made every list row and every search keystroke pay for it thousands
// of times. Each is built once and rebuilt only when the device's time zone
// changes, which a formatter fixes when it is built.
function readTimeZoneKey(): string {
  return `${new Date(0).getTimezoneOffset()}|${new Date(962409600000).getTimezoneOffset()}`;
}

function createCachedDateTimeFormat(options: Intl.DateTimeFormatOptions) {
  let cached: { formatter: Intl.DateTimeFormat; timeZoneKey: string } | null =
    null;
  return (): Intl.DateTimeFormat => {
    const timeZoneKey = readTimeZoneKey();
    if (cached?.timeZoneKey !== timeZoneKey) {
      cached = {
        formatter: new Intl.DateTimeFormat("en-GB", options),
        timeZoneKey,
      };
    }
    return cached.formatter;
  };
}

const getTimestampFormatter = createCachedDateTimeFormat({
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const getDateOnlyFormatter = createCachedDateTimeFormat({
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function formatTimestamp(timestamp: string): string {
  return getTimestampFormatter().format(new Date(timestamp));
}

export function formatDateOnly(timestamp: string): string {
  return getDateOnlyFormatter().format(new Date(timestamp));
}

export function formatOptionalDateOnly(
  timestamp: string | null,
  fallback: string | null = null,
): string {
  if (!timestamp) {
    return fallback ?? "Unknown";
  }

  return formatDateOnly(timestamp);
}

/**
 * Text that can honestly be shown where a posting date belongs: it carries a
 * number, a month name, or a relative-time word.
 *
 * A board's posted slot is matched by position, so whatever sits there travels
 * with the listing — a card once arrived with `postedAtText: "NOPE"` and the
 * card printed "POSTED NOPE" beside siblings reading "POSTED 04 SEPT 2026".
 * A token that says nothing about time is not a date and is dropped.
 */
const POSTED_DATE_TEXT_PATTERN =
  /\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b(?:today|yesterday|now|ago|posted|recently)\b/iu;

export function isPostedDateText(value: string): boolean {
  return POSTED_DATE_TEXT_PATTERN.test(value);
}

const DAY_MS = 86_400_000;

/**
 * One shape for every posting age: "today", "yesterday", "5 days ago",
 * "3 weeks ago", then the date itself once it is about two months old.
 */
export function formatPostingAge(timestamp: string, now = Date.now()): string {
  const at = new Date(timestamp).getTime();
  if (!Number.isFinite(at)) return timestamp;
  const days = Math.floor((now - at) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return formatDateOnly(timestamp);
}

const RELATIVE_POSTED_TEXT_PATTERN =
  /^(\d+)\s*\+?\s*(h|hrs?|hours?|d|days?|day\(s\)|w|wks?|weeks?|week\(s\)|mo|mos|months?)\s*ago$/iu;

/**
 * A site's own relative wording ("38 day(s) ago", "3wks ago", "5h ago") in
 * the same shape as formatPostingAge, so cards from different boards read
 * alike.
 */
function normalizeRelativePostedText(text: string, now: number): string {
  const match = RELATIVE_POSTED_TEXT_PATTERN.exec(text.trim());
  if (!match) {
    // A written date with a year ("September 24, 2026") reads as an age too.
    const parsed = /\b\d{4}\b/u.test(text) ? Date.parse(text) : Number.NaN;
    return Number.isFinite(parsed)
      ? formatPostingAge(new Date(parsed).toISOString(), now)
      : text;
  }
  const count = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("h")) return "today";
  if (unit.startsWith("mo"))
    return `${count} ${count === 1 ? "month" : "months"} ago`;
  const days = unit.startsWith("w") ? count * 7 : count;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
}

/**
 * Truthful date labeling for job postings: a known posting date (or visible
 * posted label) is always "Posted", while a provider-only last-update time
 * (e.g. Greenhouse boards that never expose the original publish date) must be
 * labeled "Updated" rather than passed off as a posting date.
 *
 * A stored posting date wins over the site's own words: "2 days ago" was true
 * on the day the job was found and grows stale, while the date does not.
 *
 * Returns `null` when the listing carries no date worth printing, so a caller
 * renders nothing instead of a bare "Updated — Unknown" or a stray token.
 */
export function getPostedDateLabel(
  input: {
    postedAt: string | null;
    postedAtText: string | null;
    providerUpdatedAt: string | null;
  },
  now = Date.now(),
): { label: "Posted" | "Updated"; value: string } | null {
  if (input.postedAt && Number.isFinite(new Date(input.postedAt).getTime())) {
    return { label: "Posted", value: formatPostingAge(input.postedAt, now) };
  }
  // A site's own text often already says "Posted 3 days ago"; printing the
  // label in front of it read "POSTED POSTED 3 DAYS AGO".
  const visibleText =
    input.postedAtText
      ?.replace(/^\s*(posted|updated|published)\s*:?\s*/iu, "")
      .trim() || null;
  const datedVisibleText =
    visibleText && isPostedDateText(visibleText) ? visibleText : null;
  // A board's own text can be a machine timestamp ("2026-08-18T16:00:22+00:00");
  // show it as a date, never as the loudest thing on the card.
  const isMachineTimestamp =
    datedVisibleText !== null &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(datedVisibleText);
  const postedValue =
    isMachineTimestamp && datedVisibleText
      ? formatPostingAge(datedVisibleText, now)
      : datedVisibleText
        ? normalizeRelativePostedText(datedVisibleText, now)
        : null;

  if (postedValue) {
    return { label: "Posted", value: postedValue };
  }

  if (input.providerUpdatedAt) {
    return {
      label: "Updated",
      value: formatPostingAge(input.providerUpdatedAt, now),
    };
  }

  return null;
}

/**
 * Work modes are stored as enum values ("remote"), so any surface that prints
 * them raw shows a lowercase word beside sentence-case siblings.
 */
export function formatWorkModeLabel(workMode: string): string {
  return workMode === "onsite"
    ? "On-site"
    : `${workMode.charAt(0).toUpperCase()}${workMode.slice(1)}`;
}

/**
 * Title-case a stored identifier for the **one** context that is allowed to
 * show one: a `label-mono-xs` row inside a Technical details disclosure, where
 * the reader has deliberately opened a technical view and the exact stored
 * value is the point.
 *
 * It is not a copy function. It has no vocabulary behind it — it uppercases
 * whatever it is handed — so every use outside that context prints a stored
 * enum value as user copy. Round-nine review (RC-03) found it called 53 times
 * across 23 files, producing "Required human input", "Site login required",
 * "Awaiting Review" and, as the heading of every Assistant proposal card,
 * "Replace Section Bullets".
 *
 * The replacement is `lib/status-copy.ts`: an exhaustive
 * `Record<Enum, string>` table per enum, typed so a new variant fails
 * typecheck instead of reaching a screen.
 *
 * Its behaviour is deliberately unchanged, so every current caller still
 * compiles and renders exactly as before. The narrowing is enforced instead by
 * `lib/user-copy.test.ts`, which forbids `formatStatusLabel(` outside its
 * `PENDING_ADOPTION` allowlist; each zone package deletes its own entries as
 * it adopts a copy table, and the function is deleted when the list empties.
 *
 * @deprecated Outside a Technical details disclosure. Use a table from
 * `lib/status-copy.ts`.
 */
export function formatStatusLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function formatResumeAnalysisSummary(
  profile: CandidateProfile,
): string | null {
  const analyzedAt = profile.baseResume.lastAnalyzedAt;

  if (!analyzedAt) {
    return null;
  }

  return `Profile suggestions refreshed from your resume on ${formatTimestamp(analyzedAt)}.`;
}

export function formatCountLabel(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function formatRunStateLabel(
  state: SourceDebugRunRecord["state"],
): string {
  switch (state) {
    case "completed":
      return "Completed";
    case "paused_manual":
      return "Needs manual step";
    case "failed":
      return "Needs attention";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "running":
      return "Running";
    default:
      return "Not started";
  }
}

export function getAttemptLabel(
  value:
    | ApplicationAttemptListRow["state"]
    | ApplicationRecord["lastAttemptState"],
): string {
  if (!value) {
    return "No apply attempt";
  }

  switch (value) {
    case "paused":
      return "Needs follow-up";
    case "ready":
      return "Ready to send";
    case "unsupported":
      return "Needs you on the site";
    case "cancelled":
      return "Cancelled by you";
    case "failed":
      return "Attempt failed";
    case "submitted":
      return "Submitted";
    case "in_progress":
      return "In progress";
    case "not_started":
      return "Not started";
    default:
      return formatStatusLabel(value);
  }
}

export function getAttemptTone(
  value:
    | ApplicationAttemptListRow["state"]
    | ApplicationRecord["lastAttemptState"]
    | null,
): BadgeTone {
  switch (value) {
    case "submitted":
      return "positive";
    case "failed":
    case "unsupported":
      return "critical";
    case "paused":
    case "in_progress":
      return "active";
    default:
      return "muted";
  }
}

export function getApplicationTone(status: ApplicationStatus): BadgeTone {
  switch (status) {
    case "interview":
    case "offer":
      return "positive";
    case "ready_for_review":
    case "approved":
    case "drafting":
    case "shortlisted":
      return "active";
    case "submitted":
    case "assessment":
      return "neutral";
    case "rejected":
    case "withdrawn":
      return "critical";
    default:
      return "muted";
  }
}

export function getAssetTone(status: AssetStatus): BadgeTone {
  switch (status) {
    case "ready":
      return "positive";
    case "generating":
    case "queued":
      return "active";
    case "failed":
      return "critical";
    default:
      return "muted";
  }
}

export function getEventTone(event: ApplicationEvent): BadgeTone {
  switch (event.emphasis) {
    case "positive":
      return "positive";
    case "warning":
      return "active";
    case "critical":
      return "critical";
    default:
      return "muted";
  }
}

export function joinListInput(values: readonly string[]): string {
  return values.join("\n");
}

export function parseListInput(value: string | null | undefined): string[] {
  // RHF watch()/getValues() can briefly return undefined while a sibling field
  // updates; treating that as an empty list keeps setup renders crash-free.
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Role-family fields advertise comma-separated input in their placeholders, so
// they need one token parser that accepts both separators. Everything else in
// the profile editor stays line-based on purpose; do not reuse this parser for
// newline-only list fields.
export function parseTokenListInput(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function buildFullName(parts: {
  firstName: string;
  middleName: string;
  lastName: string;
}): string {
  return [parts.firstName, parts.middleName, parts.lastName]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
}

export function booleanToSelect(value: boolean | null): BooleanSelectValue {
  if (value === true) {
    return "yes";
  }

  if (value === false) {
    return "no";
  }

  return "";
}

export function selectToBoolean(value: BooleanSelectValue): boolean | null {
  if (value === "yes") {
    return true;
  }

  if (value === "no") {
    return false;
  }

  return null;
}

export function uniqueList(values: readonly string[]): string[] {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const trimmed = value.trim();

    if (!trimmed) {
      return [];
    }

    const key = trimmed.toLowerCase();

    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [trimmed];
  });
}

export function createProfileEntryId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }

  if (ms < 1000) {
    return "<1s";
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function parseRequiredNonNegativeInteger(value: string): number | null {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const parsedValue = Number(trimmedValue);

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return null;
  }

  return parsedValue;
}

export function toExperienceFormEntries(
  profile: CandidateProfile,
): ExperienceFormEntry[] {
  return profile.experiences.map((experience) => ({
    id: experience.id,
    companyName: experience.companyName ?? "",
    companyUrl: experience.companyUrl ?? "",
    title: experience.title ?? "",
    employmentType: experience.employmentType ?? "",
    location: experience.location ?? "",
    workMode: experience.workMode ?? [],
    startDate: experience.startDate ?? "",
    endDate: experience.endDate ?? "",
    isCurrent: experience.isCurrent,
    summary: experience.summary ?? "",
    achievements: joinListInput(experience.achievements),
    skills: joinListInput(experience.skills),
    domainTags: joinListInput(experience.domainTags),
    peopleManagementScope: experience.peopleManagementScope ?? "",
    ownershipScope: experience.ownershipScope ?? "",
    sourceCandidateId: null,
    sourceCandidateFingerprint: null,
  }));
}

export function getDefaultProfileRoute(
  profileSetupState: ProfileSetupState,
  options?: { forceFullProfile?: boolean },
): "/job-finder/profile" | "/job-finder/profile/setup" {
  if (
    profileSetupState.status === "not_started" &&
    !options?.forceFullProfile
  ) {
    return "/job-finder/profile/setup";
  }

  return "/job-finder/profile";
}

export function toEducationFormEntries(
  profile: CandidateProfile,
): EducationFormEntry[] {
  return profile.education.map((education) => ({
    id: education.id,
    schoolName: education.schoolName ?? "",
    degree: education.degree ?? "",
    fieldOfStudy: education.fieldOfStudy ?? "",
    location: education.location ?? "",
    startDate: education.startDate ?? "",
    endDate: education.endDate ?? "",
    summary: education.summary ?? "",
    sourceCandidateId: null,
    sourceCandidateFingerprint: null,
  }));
}

export function toCertificationFormEntries(
  profile: CandidateProfile,
): CertificationFormEntry[] {
  return profile.certifications.map((certification) => ({
    id: certification.id,
    name: certification.name ?? "",
    issuer: certification.issuer ?? "",
    issueDate: certification.issueDate ?? "",
    expiryDate: certification.expiryDate ?? "",
    credentialUrl: certification.credentialUrl ?? "",
  }));
}

export function toLinkFormEntries(profile: CandidateProfile): LinkFormEntry[] {
  return profile.links.map((link) => ({
    id: link.id,
    label: link.label ?? "",
    url: link.url ?? "",
    kind: link.kind ?? "",
  }));
}

export function toProjectFormEntries(
  profile: CandidateProfile,
): ProjectFormEntry[] {
  return profile.projects.map((project) => ({
    id: project.id,
    name: project.name,
    projectType: project.projectType ?? "",
    summary: project.summary ?? "",
    role: project.role ?? "",
    skills: joinListInput(project.skills),
    outcome: project.outcome ?? "",
    projectUrl: project.projectUrl ?? "",
    repositoryUrl: project.repositoryUrl ?? "",
    caseStudyUrl: project.caseStudyUrl ?? "",
  }));
}

export function toLanguageFormEntries(
  profile: CandidateProfile,
): LanguageFormEntry[] {
  return profile.spokenLanguages.map((language) => ({
    id: language.id,
    language: language.language,
    proficiency: language.proficiency ?? "",
    interviewPreference: language.interviewPreference,
    notes: language.notes ?? "",
  }));
}
