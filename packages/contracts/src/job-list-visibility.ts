import {
  formatEmployerLabelFromSlug,
  isLikelyUtilitySiteChromeName,
  sanitizeEmployerLabel,
} from "./job-finder-intelligence";
import type { SavedJob } from "./discovery";

const utilityShortlistPathSegments = new Set([
  "about",
  "about-us",
  "blog",
  "blogs",
  "browse",
  "candidates",
  "contact",
  "contact-us",
  "create-cv",
  "create-resume",
  "faq",
  "help",
  "hire",
  "hiring-data",
  "kontakt",
  "krijo-cv",
  "legal",
  "llogaritja-e-pages",
  "location",
  "login",
  "log-in",
  "news",
  "press",
  "privacy",
  "privacy-policy",
  "cookie-policy",
  "politika-e-privatesise",
  "politike-e-privatesise",
  "politike-privatesise",
  "politika-privatesise",
  "mbrojtja-e-te-dhenave",
  "mbrojtja-e-te-dhenave-personale",
  "publiko",
  "register",
  "role",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "support",
  "terms",
  "terms-of-service",
]);

/**
 * Section words that a career site also uses to route real postings.
 *
 * `/role`, `/support` and `/location` name an index when the path stops there,
 * but the same words prefix concrete listings (`/role/1234-senior-engineer`).
 * Treating the word alone as decisive dropped genuine postings at intake, so
 * these become chrome only when the path carries no posting identifier. The
 * remaining entries above — credential, consent, legal, and browse routes —
 * never describe a posting and stay decisive whatever else the path holds.
 */
const sectionRouteShortlistPathSegments = new Set([
  "about",
  "about-us",
  "blog",
  "blogs",
  "candidates",
  "contact",
  "contact-us",
  "help",
  "hire",
  "legal",
  "location",
  "news",
  "press",
  "role",
  "support",
]);

const CALENDAR_YEAR_SEGMENT_PATTERN = /^(?:19|20)\d{2}$/;
const UUID_SEGMENT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_RUN_PATTERN = /\d{4,}/;
const OPAQUE_ID_TOKEN_PATTERN = /^(?=[^]*\d)(?=[^]*[a-z])[a-z0-9]{8,}$/i;
const PAGINATION_TITLE_PATTERN =
  /^(?:(?:go\s+to\s+)?page\s+\d+|next(?:\s+page)?|previous(?:\s+page)?)$/iu;
const ABSENT_EMPLOYER_PATTERN =
  /^(?:employer|company|organization|organisation)?\s*(?:not\s+(?:listed|stated|available)|unknown|unavailable|n\/?a)?$/iu;

/**
 * A path segment that names one concrete posting rather than a section.
 *
 * Source-generic: it reads shape only — a long numeric run, a UUID, or an
 * opaque alphanumeric token — never a board, host, or vendor. A bare
 * four-digit calendar year is excluded because `/news/2026/...` is an archive
 * index, not an identifier.
 */
function isLikelyPostingIdentifierSegment(segment: string): boolean {
  if (UUID_SEGMENT_PATTERN.test(segment)) {
    return true;
  }

  if (CALENDAR_YEAR_SEGMENT_PATTERN.test(segment)) {
    return false;
  }

  return (
    NUMERIC_ID_RUN_PATTERN.test(segment) ||
    OPAQUE_ID_TOKEN_PATTERN.test(segment)
  );
}

const ROLE_TITLE_NOUN_PATTERN =
  /\b(?:engineer|developer|manager|analyst|designer|specialist|coordinator|assistant|technician|consultant|administrator|scientist|officer|clerk|recruiter|nurse|driver|cashier|representative|director|lead|intern)\b/iu;

function hasLikelyDetailPageShape(rawUrl: string, title: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    for (const [key, value] of parsed.searchParams) {
      if (
        /^(?:id|job|jobid|job_id|posting|position|requisition|req)$/iu.test(
          key,
        ) &&
        value.trim().length > 0
      ) {
        return true;
      }
    }
    const segments = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim().toLowerCase())
      .filter(Boolean);
    return (
      segments.some(isLikelyPostingIdentifierSegment) ||
      (ROLE_TITLE_NOUN_PATTERN.test(title) &&
        (segments.length >= 2 || parsed.searchParams.size > 0))
    );
  } catch {
    return false;
  }
}

/**
 * Last-resort intake gate for a link that contains no job record at all.
 * Every predicate is content/URL shape based: no employer, no body, and no
 * identifier that makes the address look like one concrete detail page.
 */
export function isLikelyEmptyNonDetailPosting(
  job: Pick<SavedJob, "canonicalUrl" | "company" | "description" | "title">,
): boolean {
  const title = job.title.trim();
  if (PAGINATION_TITLE_PATTERN.test(title)) {
    return true;
  }

  const company = job.company.trim();
  const hasEmployer =
    company.length > 0 && !ABSENT_EMPLOYER_PATTERN.test(company);
  if (hasEmployer) return false;
  // Only now: lowercasing every listing's text took most of a first refresh.
  const body = job.description.trim();
  const hasBody =
    body.length > 0 && body.toLocaleLowerCase() !== title.toLocaleLowerCase();
  return !hasBody && !hasLikelyDetailPageShape(job.canonicalUrl, title);
}

const EMPLOYER_ABSENCE_LABEL_PATTERN = /^employer not stated$/i;
const LOCATION_ABSENCE_LABEL_PATTERN = /^location not stated$/i;

/**
 * Boards that nest multiple jobs under one company card often expose `/company/{slug}`
 * hub pages without a concrete job id path. Those rows are marketing chrome, not listings.
 */
export function isLikelyCompanyHubUrl(canonicalUrl: string): boolean {
  const raw = canonicalUrl.trim();
  if (!raw) {
    return false;
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "fb.com" ||
      host === "www.fb.com" ||
      host === "facebook.com" ||
      host === "www.facebook.com" ||
      host.endsWith(".facebook.com")
    ) {
      return true;
    }

    const segments = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim().toLowerCase())
      .filter(Boolean);
    const companyIndex = segments.indexOf("company");
    if (companyIndex < 0) {
      return false;
    }

    const slug = segments[companyIndex + 1];
    if (!slug) {
      return false;
    }

    const rest = segments.slice(companyIndex + 2);
    if (rest.length === 0) {
      return true;
    }

    // `/company/{slug}/jobs` is a company jobs index, not a posting.
    return rest.length === 1 && rest[0] === "jobs";
  } catch {
    return false;
  }
}

/**
 * Infers an employer label from `/company/{slug}/…` listing URLs so stored
 * absence placeholders can improve when the URL still carries the slug.
 */
export function inferEmployerFromCanonicalUrl(
  canonicalUrl: string,
): string | null {
  const raw = canonicalUrl.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);
    const companyIndex = segments.findIndex(
      (segment) => segment.toLowerCase() === "company",
    );
    if (companyIndex < 0) {
      return null;
    }

    const slug = segments[companyIndex + 1];
    if (!slug || !/[a-z\p{L}]/iu.test(slug)) {
      return null;
    }

    const rest = segments.slice(companyIndex + 2);
    // Company hubs themselves are not employers-of-record for a posting row.
    if (
      rest.length === 0 ||
      (rest.length === 1 && rest[0]?.toLowerCase() === "jobs")
    ) {
      return null;
    }

    return formatEmployerLabelFromSlug(slug);
  } catch {
    return null;
  }
}

export function isEmployerAbsenceLabel(
  value: string | null | undefined,
): boolean {
  return EMPLOYER_ABSENCE_LABEL_PATTERN.test((value ?? "").trim());
}

export function isLocationAbsenceLabel(
  value: string | null | undefined,
): boolean {
  return LOCATION_ABSENCE_LABEL_PATTERN.test((value ?? "").trim());
}

export function resolveSavedJobCompany(
  job: Pick<SavedJob, "company" | "canonicalUrl">,
): string {
  const sanitized = sanitizeEmployerLabel(job.company);
  if (sanitized) {
    return sanitized;
  }

  return inferEmployerFromCanonicalUrl(job.canonicalUrl) ?? job.company.trim();
}

export function resolveSavedJobLocation(
  job: Pick<SavedJob, "location">,
): string | null {
  const location = job.location.trim();
  if (!location || isLocationAbsenceLabel(location)) {
    return null;
  }

  return location;
}

function isLikelyJobListingHubUrl(canonicalUrl: string): boolean {
  const raw = canonicalUrl.trim();
  if (!raw) {
    return false;
  }

  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim().toLowerCase())
      .filter(Boolean);
    return segments.length === 1 && segments[0] === "jobs";
  } catch {
    return false;
  }
}

function hasUtilityPathOrHost(canonicalUrl: string): boolean {
  const raw = canonicalUrl.trim();
  if (!raw) {
    return false;
  }

  if (isLikelyJobListingHubUrl(raw)) {
    return true;
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "fb.com" ||
      host === "www.fb.com" ||
      host === "facebook.com" ||
      host === "www.facebook.com" ||
      host.endsWith(".facebook.com") ||
      host.startsWith("help.")
    ) {
      return true;
    }

    const segments = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim().toLowerCase())
      .filter(Boolean);
    const utilitySegments = segments.filter((segment) =>
      utilityShortlistPathSegments.has(segment),
    );
    if (utilitySegments.length === 0) {
      return false;
    }

    // A credential, consent, legal, or browse route is chrome no matter what
    // else the path holds; only the section words route real postings.
    if (
      utilitySegments.some(
        (segment) => !sectionRouteShortlistPathSegments.has(segment),
      )
    ) {
      return true;
    }

    // The section word is decisive only when nothing beside it identifies one
    // concrete posting. `/role` is an index; `/role/1234-senior-engineer` is a
    // listing.
    return !segments.some(
      (segment) =>
        !utilityShortlistPathSegments.has(segment) &&
        isLikelyPostingIdentifierSegment(segment),
    );
  } catch {
    return false;
  }
}

export function isLikelyUtilityShortlistJob(
  job: Pick<SavedJob, "title"> &
    Partial<Pick<SavedJob, "canonicalUrl" | "company" | "description">>,
): boolean {
  const title = job.title.trim();
  if (title.length === 0) {
    return false;
  }

  if (isLikelyUtilitySiteChromeName(title)) {
    return true;
  }

  const canonicalUrl = job.canonicalUrl?.trim() ?? "";
  if (!canonicalUrl) {
    return false;
  }

  if (
    job.company !== undefined &&
    (job.company.trim().length === 0 ||
      ABSENT_EMPLOYER_PATTERN.test(job.company.trim())) &&
    job.description !== undefined &&
    isLikelyEmptyNonDetailPosting({
      canonicalUrl,
      company: job.company,
      description: job.description,
      title,
    })
  ) {
    return true;
  }

  return (
    isLikelyCompanyHubUrl(canonicalUrl) || hasUtilityPathOrHost(canonicalUrl)
  );
}
