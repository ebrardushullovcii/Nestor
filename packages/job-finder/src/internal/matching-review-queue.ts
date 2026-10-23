import {
  formatEmployerLabelFromSlug,
  isLikelyUtilitySiteChromeName,
  sanitizeEmployerLabel,
  type ApplicationRecord,
  type ApplicationStatus,
  type AssetStatus,
  type CandidateProfile,
  type JobFinderSettings,
  type ResumeDraft,
  type ResumeExportArtifact,
  type ReviewQueueItem,
  type SavedJob,
  type TailoredAsset,
} from "@nestor/contracts";

import { compareDiscoveryJobs } from "../discovery-ordering";
import { resolveJobResumeApplicationMode } from "./job-resume-application-mode";
import { memoizeBySameElements } from "./same-elements-memo";

export { compareDiscoveryJobs };

const reviewableStatuses = new Set<ApplicationStatus>([
  "drafting",
  "ready_for_review",
  "approved",
]);

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

const discoveryVisibleStatuses = new Set<ApplicationStatus>([
  "discovered",
  "shortlisted",
  "drafting",
  "ready_for_review",
  "approved",
]);

/**
 * Utility-chrome filtering is discovery-intake triage only.
 *
 * The heuristic reads titles and URL segments, so it can misread a real
 * posting (`/support/1234`, `/role/1234-engineer`). That is an acceptable cost
 * for an untouched candidate the user has never seen, but not for a row the
 * user has acted on: silently removing a shortlisted job — possibly one with
 * an approved tailored PDF — gives no message and no undo. Once a job leaves
 * `discovered`, it is curated work and stays visible.
 */
function isDiscoveryIntakeCandidate(job: Pick<SavedJob, "status">): boolean {
  return job.status === "discovered";
}

/** How long a resume written without its listing waits before a retry. */
const LISTING_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const assetStatusPriority: Record<AssetStatus, number> = {
  ready: 0,
  generating: 1,
  queued: 2,
  failed: 3,
  not_started: 4,
};

type ApplyResumeExportReference = Pick<
  ResumeExportArtifact,
  "id" | "jobId" | "isApproved" | "filePath" | "exportedAt"
>;

function getLatestApprovedExport<TExport extends ApplyResumeExportReference>(
  current: TExport | null,
  candidate: TExport,
): TExport {
  if (!current) {
    return candidate;
  }

  return new Date(candidate.exportedAt).getTime() >
    new Date(current.exportedAt).getTime()
    ? candidate
    : current;
}

export function resolveLatestApprovedExportForJob<
  TExport extends ApplyResumeExportReference,
>(jobId: string, exports: readonly TExport[]): TExport | null {
  let latest: TExport | null = null;

  for (const artifact of exports) {
    if (artifact.jobId !== jobId || !artifact.isApproved) {
      continue;
    }

    latest = getLatestApprovedExport(latest, artifact);
  }

  return latest;
}

/** Align apply gates with Shortlisted readiness: prefer draft.approvedExportId when still valid, else latest isApproved export. */
export function resolveApprovedResumeExportForApply<
  TExport extends ApplyResumeExportReference,
>(input: {
  draft: Pick<
    ResumeDraft,
    "jobId" | "status" | "approvedAt" | "approvedExportId"
  > | null;
  exports: readonly TExport[];
  asset?: Pick<TailoredAsset, "storagePath"> | null;
}): TExport | null {
  if (
    !input.draft ||
    input.draft.status !== "approved" ||
    !input.draft.approvedAt
  ) {
    return null;
  }

  const latestApproved = resolveLatestApprovedExportForJob(
    input.draft.jobId,
    input.exports,
  );

  if (input.draft.approvedExportId) {
    const linkedExport = input.exports.find(
      (entry) => entry.id === input.draft!.approvedExportId,
    );
    if (linkedExport) {
      if (
        linkedExport.isApproved ||
        (input.asset?.storagePath &&
          input.asset.storagePath === linkedExport.filePath)
      ) {
        return linkedExport;
      }
    }
  }

  return latestApproved;
}

export function isApprovedTailoredResumeReadyForApply(input: {
  draft: ResumeDraft | null;
  exports: readonly ResumeExportArtifact[];
  asset: TailoredAsset | null;
}): { ready: boolean; approvedExport: ResumeExportArtifact | null } {
  const approvedExport = resolveApprovedResumeExportForApply({
    draft: input.draft,
    exports: input.exports,
    asset: input.asset,
  });
  const ready = Boolean(
    approvedExport &&
    input.asset &&
    input.asset.status === "ready" &&
    input.asset.storagePath &&
    input.asset.storagePath === approvedExport.filePath,
  );

  return { ready, approvedExport };
}

function buildResumeReviewState(
  draft: ResumeDraft | null,
  approvedExport: ResumeExportArtifact | null,
): ReviewQueueItem["resumeReview"] {
  if (!draft) {
    return { status: "not_started" };
  }

  if (draft.status === "approved" && draft.approvedAt && approvedExport) {
    return {
      status: "approved",
      approvedAt: draft.approvedAt,
      approvedExportId: approvedExport.id,
      approvedFormat: approvedExport.format,
      approvedFilePath: approvedExport.filePath,
    };
  }

  if (draft.status === "stale") {
    return {
      status: "stale",
      staleReason: draft.staleReason ?? null,
    };
  }

  if (draft.status === "approved") {
    return {
      status: "needs_review",
    };
  }

  return {
    status: draft.status,
  };
}

export function buildReviewQueue(
  savedJobs: readonly SavedJob[],
  tailoredAssets: readonly TailoredAsset[],
  resumeDrafts: readonly ResumeDraft[],
  resumeExportArtifacts: readonly ResumeExportArtifact[],
  profile?: CandidateProfile,
  settings?: JobFinderSettings,
  /**
   * Per draft id, the lines its latest validation says still wait for the
   * person (the export gate's own rule). Drafts not listed have none.
   */
  linesToDecideByDraftId?: ReadonlyMap<string, number>,
): ReviewQueueItem[] {
  const originalResume = profile?.baseResume ?? null;
  const originalResumePath = originalResume?.storagePath?.trim() ?? "";
  const assetsByJobId = new Map(
    tailoredAssets.map((asset) => [asset.jobId, asset]),
  );
  const draftsByJobId = new Map(
    resumeDrafts.map((draft) => [draft.jobId, draft]),
  );
  const approvedExportsByJobId = new Map<string, ResumeExportArtifact>();

  for (const artifact of resumeExportArtifacts) {
    if (!artifact.isApproved) {
      continue;
    }

    approvedExportsByJobId.set(
      artifact.jobId,
      getLatestApprovedExport(
        approvedExportsByJobId.get(artifact.jobId) ?? null,
        artifact,
      ),
    );
  }

  // Every reviewable status is user-curated, so the intake chrome heuristic
  // never applies here (see `isDiscoveryIntakeCandidate`).
  return savedJobs
    .filter((job) => reviewableStatuses.has(job.status))
    .map<ReviewQueueItem>((job) => {
      const displayCompany = resolveSavedJobCompany(job);
      const resumeApplicationMode = resolveJobResumeApplicationMode(
        job,
        settings ?? {},
      );
      const usesOriginalResume = resumeApplicationMode === "original_resume";

      if (usesOriginalResume) {
        const hasOriginalResume = Boolean(
          originalResume && originalResumePath && originalResume.sha256,
        );
        return {
          jobId: job.id,
          title: job.title,
          company: displayCompany,
          location: job.location,
          matchScore: job.matchAssessment.score,
          applicationStatus: job.status,
          resumeApplicationMode,
          resumeTailoringMode: job.resumeTailoringMode ?? null,
          assetStatus: hasOriginalResume ? "ready" : "not_started",
          progressPercent: hasOriginalResume ? 100 : null,
          resumeAssetId: hasOriginalResume ? originalResume!.id : null,
          resumeReview: hasOriginalResume
            ? {
                status: "original_resume",
                sourceDocumentId: originalResume!.id,
                fileName: originalResume!.fileName,
                filePath: originalResumePath,
              }
            : { status: "not_started" },
          updatedAt:
            [originalResume?.textUpdatedAt, originalResume?.uploadedAt]
              .filter((value): value is string => Boolean(value))
              .sort()
              .at(-1) ?? job.discoveredAt,
        };
      }

      const asset = assetsByJobId.get(job.id) ?? null;
      const draft = draftsByJobId.get(job.id) ?? null;
      const approvedExport = approvedExportsByJobId.get(job.id) ?? null;
      const resumeReview = buildResumeReviewState(draft, approvedExport);
      const updatedAtCandidates = [
        asset?.updatedAt,
        draft?.updatedAt,
        approvedExport?.exportedAt,
        job.discoveredAt,
      ].filter((value): value is string => Boolean(value));

      return {
        jobId: job.id,
        title: job.title,
        company: displayCompany,
        location: job.location,
        matchScore: job.matchAssessment.score,
        applicationStatus: job.status,
        resumeApplicationMode,
        resumeTailoringMode: job.resumeTailoringMode ?? null,
        assetStatus: asset?.status ?? "not_started",
        progressPercent: asset?.progressPercent ?? null,
        resumeAssetId: asset?.id ?? null,
        resumeReview,
        ...(draft && (linesToDecideByDraftId?.get(draft.id) ?? 0) > 0
          ? { resumeLinesToDecide: linesToDecideByDraftId!.get(draft.id)! }
          : {}),
        // Written without the listing counts as still needing a resume, so a
        // batch tries the listing again; not within a day of the last try,
        // when the page would only fail the same way and take a batch slot.
        ...(asset?.status === "ready" &&
        asset.generationMethod === "deterministic" &&
        (asset.generationReason === "listing_text_missing" ||
          asset.generationReason === "listing_text_not_distinguishing") &&
        !(Date.now() - Date.parse(asset.updatedAt) < LISTING_RETRY_AFTER_MS)
          ? { resumeWrittenWithoutListing: true }
          : {}),
        updatedAt: updatedAtCandidates.sort().at(-1) ?? job.discoveredAt,
      };
    })
    .sort((left, right) => {
      const assetDelta =
        assetStatusPriority[left.assetStatus] -
        assetStatusPriority[right.assetStatus];

      if (assetDelta !== 0) {
        return assetDelta;
      }

      return right.matchScore - left.matchScore;
    });
}

// The utility-page check parses every job's address. Rows are immutable and
// reused between refreshes, so the verdict is worked out once per row.
const utilityVerdictByJob = new WeakMap<SavedJob, boolean>();
function isCachedUtilityShortlistJob(job: SavedJob): boolean {
  let verdict = utilityVerdictByJob.get(job);
  if (verdict === undefined) {
    verdict = isLikelyUtilityShortlistJob(job);
    utilityVerdictByJob.set(job, verdict);
  }
  return verdict;
}

/**
 * Works out the utility-page verdict of saved jobs not checked yet, a slice
 * at a time with a turn of the event loop between slices, so the list that
 * follows finds every verdict ready. At start all 20,000 rows of a large
 * workspace are new, and checking them inside one refresh held main 0.35 s.
 */
export async function warmDiscoveryJobChecks(
  jobs: readonly SavedJob[],
  view: { key: string | null; of: (job: SavedJob) => SavedJob } = {
    key: null,
    of: (job) => job,
  },
): Promise<void> {
  let checked = 0;
  for (const raw of jobs) {
    if (!isDiscoveryIntakeCandidate(raw) || !Object.isFrozen(raw)) continue;
    // A refresh after one hide sees 6,000 rows it already warmed.
    if (warmedRows.get(raw) === view.key) continue;
    isCachedUtilityShortlistJob(view.of(raw));
    warmedRows.set(raw, view.key);
    checked += 1;
    if (checked % UTILITY_CHECKS_PER_TURN === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const UTILITY_CHECKS_PER_TURN = 100;
/** Which view (plan) each frozen row was last warmed for. */
const warmedRows = new WeakMap<SavedJob, string | null>();

// Frozen jobs never change, so an unchanged refresh reuses the last
// filtered, ordered list instead of re-sorting every saved job.
const orderFrozenDiscoveryJobs = memoizeBySameElements(
  (savedJobs: readonly SavedJob[]) =>
    Object.freeze(orderDiscoveryJobs(savedJobs)) as SavedJob[],
);

export function buildDiscoveryJobs(savedJobs: readonly SavedJob[]): SavedJob[] {
  return savedJobs.every((job) => Object.isFrozen(job))
    ? orderFrozenDiscoveryJobs(savedJobs)
    : orderDiscoveryJobs(savedJobs);
}

function isVisibleDiscoveryJob(job: SavedJob): boolean {
  return (
    discoveryVisibleStatuses.has(job.status) &&
    (!isDiscoveryIntakeCandidate(job) || !isCachedUtilityShortlistJob(job))
  );
}

/**
 * The saved jobs Find jobs lists, unordered and unchanged. For a caller that
 * ranks its own views of them (the workspace read does).
 */
export function selectVisibleDiscoveryJobs(
  savedJobs: readonly SavedJob[],
): SavedJob[] {
  return savedJobs.filter(isVisibleDiscoveryJob);
}

function orderDiscoveryJobs(savedJobs: readonly SavedJob[]): SavedJob[] {
  return savedJobs
    .filter(isVisibleDiscoveryJob)
    .map((job) => {
      const company = resolveSavedJobCompany(job);
      const location = resolveSavedJobLocation(job);
      if (
        company === job.company &&
        (location === null
          ? isLocationAbsenceLabel(job.location)
          : location === job.location)
      ) {
        // When location is an absence label, keep the stored string for schema
        // compatibility but discovery UI formatters hide it.
        return job;
      }

      return {
        ...job,
        company,
        ...(location ? { location } : {}),
      };
    })
    .sort(compareDiscoveryJobs);
}

export function buildApplicationRecords(
  savedApplicationRecords: readonly ApplicationRecord[],
): ApplicationRecord[] {
  return [...savedApplicationRecords].sort(
    (left, right) =>
      new Date(right.lastUpdatedAt).getTime() -
      new Date(left.lastUpdatedAt).getTime(),
  );
}
