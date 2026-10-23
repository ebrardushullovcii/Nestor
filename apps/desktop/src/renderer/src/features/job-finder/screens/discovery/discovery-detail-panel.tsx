import { describeListingReadFailure } from "../../lib/describe-failure";
import { joinUniqueSentences } from "../../lib/sentence-copy";
import {
  discoveryFeedbackOptions,
  formatDiscoveryHideReason,
} from "./discovery-hide-reason-options";
import type {
  DiscoveryFeedbackReason,
  ApplicationRecord,
  DiscoveryJobView,
  EmployerExclusionPreview,
  JobDiscoveryTarget,
  JobKeywordSignal,
  MatchAssessmentChangeAudit,
  ReviewQueueItem,
  SavedJob,
} from "@nestor/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES } from "../../lib/job-finder-scroll-reveal";
// The shell owns these two numbers. Importing them is the point: a second
// local copy is what let the header mask and the inspector chrome drift apart.
import {
  SHELL_HEADER_MASK_HEIGHT_CLASS,
  SHELL_HEADER_MASK_OPAQUE_STOP_CLASS,
} from "../../lib/job-finder-shell-gutters";
import { EmptyState } from "../../components/empty-state";
import { ExternalUrlLink } from "../../components/open-outside-links";
import { PreferenceList } from "../../components/preference-list";
import { Chip } from "@renderer/components/ui/chip";
import { StatusBadge } from "../../components/status-badge";
import { MatchEvidenceMatrix } from "../../components/match-evidence-matrix";
import { jobDescriptionToText } from "../../lib/job-description-text";
import { Link } from "react-router-dom";
import { buildJobFinderContextRoute } from "../../lib/job-finder-context-navigation";
import { buildIntelligenceSummaries } from "../../lib/source-intelligence-utils";
import type { LearnedInstructionIntelligenceSummary } from "../../lib/source-intelligence-utils";
import {
  formatOptionalDateOnly,
  formatStatusLabel,
  getApplicationTone,
  getPostedDateLabel,
} from "../../lib/job-finder-utils";
import {
  fitRecommendationCopy,
  getMatchAssessmentPresentation,
} from "../../lib/match-assessment-presentation";
import { presentListingActivity } from "../../lib/listing-activity-presentation";
import { formatStatedNormalizedCompensation } from "../../lib/normalized-compensation";
import {
  collapseRepeatedListingParts,
  countListingLocations,
  formatEmploymentTypeLabel,
  formatWorkModeLabel,
  splitListingLocationValues,
} from "../../lib/listing-fact-presentation";
import {
  formatJobEmployerLocationLine,
  resolveJobEmployerDisplay,
  scrubJobAbsencePlaceholders,
} from "../../lib/job-employer-location-display";
import type { JobFinderQueuedJobOutcome } from "../../lib/job-finder-types";
import {
  DISCOVERY_DETAIL_HEADING_ID,
  DISCOVERY_DETAIL_REGION_ID,
} from "./discovery-accessibility";
import { getDiscoverySourceLabels } from "./discovery-source-attribution";
import {
  RATE_LIMITED_LISTING_TEXT,
  describeMissingListingText,
  isRateLimitedListingRead,
} from "@renderer/features/job-finder/lib/listing-detail-fetch-copy";

function describeDiscoveryMissingListingText(
  job: Pick<SavedJob, "listingDetailCapture" | "listingDetailFetch">,
): string {
  if (
    (!job.listingDetailFetch &&
      job.listingDetailCapture?.state === "blocked") ||
    job.listingDetailFetch?.outcome === "blocked"
  ) {
    return isRateLimitedListingRead(job.listingDetailFetch)
      ? RATE_LIMITED_LISTING_TEXT
      : "This site did not let Job Finder read the listing";
  }
  return describeMissingListingText(
    job.listingDetailFetch,
    job.listingDetailCapture,
  );
}

function wasDiscoveryListingReadBlocked(
  job: Pick<SavedJob, "listingDetailCapture" | "listingDetailFetch">,
): boolean {
  return (
    job.listingDetailCapture?.state === "blocked" ||
    job.listingDetailFetch?.outcome === "blocked"
  );
}
import { getApplicationStagePresentation } from "../applications/applications-status";
import {
  collectInProgressApplicationJobIds,
  collectPreparedApplicationJobIds,
  getReviewQueueWorkflowStatus,
} from "../review-queue/review-queue-status";
import type { DiscoveryTriage } from "./discovery-triage";

/**
 * The bare workflow value reads as a verdict on the job itself ("APPROVED"),
 * not on the artifact the state is actually about.
 */
const TERM_KEYWORD_KINDS: ReadonlySet<JobKeywordSignal["kind"]> = new Set([
  "skill",
  "tool",
  "domain",
  "industry",
]);

/**
 * The keyword chips worth showing: short terms only. Responsibility,
 * qualification and benefit signals are whole sentences from the listing
 * text, which the pane already shows, and a skill already listed under
 * "Skills mentioned" is not repeated.
 */
export function listFlaggedKeywordTerms(
  signals: readonly JobKeywordSignal[],
  keySkills: readonly string[],
): string[] {
  const seen = new Set(keySkills.map((skill) => skill.trim().toLowerCase()));
  const terms: string[] = [];
  for (const signal of signals) {
    const key = signal.label.trim().toLowerCase();
    if (!TERM_KEYWORD_KINDS.has(signal.kind) || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(signal.label.trim());
  }
  return terms;
}

export function presentDiscoveryJobStatusLabel(status: string): string {
  switch (status) {
    case "approved":
      return "Resume approved";
    case "ready_for_review":
      return "Resume needs review";
    // shortlistJob writes "drafting" the moment a job is shortlisted, before
    // any draft is requested, so this is the same state Shortlisted calls
    // "No resume yet". "Resume in progress" made people wait for nothing.
    case "drafting":
      return "No resume yet";
    default:
      return formatStatusLabel(status);
  }
}

interface DiscoveryDetailPanelProps {
  applicationRecords?: readonly ApplicationRecord[];
  /**
   * The Shortlisted rows. When this job is on that list its readiness is
   * computed there, once, and read back here: the inspector used to derive a
   * second verdict from the stored job status, so the same job could read
   * "Resume needs review" here and "Ready to apply" on Shortlisted seconds
   * apart.
   */
  reviewQueue?: readonly ReviewQueueItem[];
  discoveryTargets: readonly JobDiscoveryTarget[];
  isJobPending: (jobId: string) => boolean;
  onDismissJob: (
    jobId: string,
    reasons: readonly DiscoveryFeedbackReason[],
    action?: "hide_job" | "hide_and_exclude_employer",
    expectedNormalizedCompanyName?: string | null,
  ) => void | Promise<void>;
  onPreviewEmployerExclusion?: (
    jobId: string,
  ) => Promise<EmployerExclusionPreview>;
  onOpenCompany?: (companyId: string) => void;
  onOpenApplication?: (recordId: string) => void;
  /** Opens the original listing page in the Job Finder browser. */
  onOpenListing?: (url: string) => void;
  onAssessJobListing?: (jobId: string) => Promise<void>;
  onBackToResults?: () => void;
  onQueueJob: (jobId: string) => void;
  /**
   * Request-local outcome of this job's own Shortlist decision, correlated by
   * DiscoveryScreen; null while pending or when the inspected row has no
   * resolved request. Rendered as one accessible line so success and failure
   * are never silent in Results mode and never duplicate Search-setup
   * feedback.
   */
  queueFeedback?: JobFinderQueuedJobOutcome | null;
  selectedJob:
    | (SavedJob & Partial<Pick<DiscoveryJobView, "listingActivity">>)
    | null;
  selectedJobCompanyId?: string | null;
  /**
   * The triage pass (Find jobs): the verdict, the deciding facts and the
   * Shortlist / Not interested / Skip actions sit at the top, and a decision
   * opens the next job.
   */
  triage?: DiscoveryTriage | null;
}

/** The key that does this, beside the button's label. */
function TriageKey(props: { children: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="ml-1 rounded-sm border border-current/30 px-1 font-sans text-(length:--text-tiny) font-medium opacity-70"
    >
      {props.children}
    </kbd>
  );
}

export function SourceDiagnostics(props: {
  summaries: readonly LearnedInstructionIntelligenceSummary[];
}) {
  if (props.summaries.length === 0) {
    return null;
  }

  return (
    <details className="rounded-(--radius-field) border border-(--surface-panel-border) p-4">
      <summary className="cursor-pointer text-(length:--text-small) font-medium text-foreground-soft">
        Source diagnostics
      </summary>
      <p className="mt-2 text-(length:--text-small) leading-6 text-foreground-muted">
        Technical collection details for troubleshooting this saved source.
      </p>
      <div className="mt-3 grid gap-3">
        {props.summaries.map((summary, summaryIndex) => (
          <div
            key={`${summary.title}_${summaryIndex}`}
            className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-4"
          >
            <p className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
              {summary.title}
            </p>
            <dl className="grid gap-2 text-(length:--text-small) leading-6 text-foreground-soft">
              {summary.items.map((item, itemIndex) => (
                <div
                  className="grid gap-0.5"
                  key={`${summary.title}_${item.label}_${itemIndex}`}
                >
                  <dt className="font-medium text-foreground">{item.label}</dt>
                  <dd className="break-words">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </details>
  );
}

export function MatchAssessmentChangeDisclosure(props: {
  audit: MatchAssessmentChangeAudit | null | undefined;
}) {
  const { audit } = props;
  if (!audit) {
    return null;
  }

  const rankChanged = audit.outputChanges.some(
    (change) => change.code === "rank_position_changed",
  );
  const onlyRankChanged =
    rankChanged &&
    audit.outputChanges.every(
      (change) => change.code === "rank_position_changed",
    ) &&
    audit.inputChanges.every((change) => change.certainty === "unknown");
  const explanation = onlyRankChanged
    ? "This job moved because other visible results entered, left, or changed around it. Its own fit assessment stayed the same."
    : audit.summary;
  const reasons = [
    ...audit.outputChanges.map((change) => change.detail),
    ...audit.inputChanges
      .filter((change) => change.certainty === "known")
      .map((change) => change.detail),
  ].slice(0, 3);

  return (
    <details
      className="rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-subtle) p-4"
      data-testid="match-assessment-change-audit"
    >
      <summary className="cursor-pointer text-(length:--text-small) font-medium text-foreground">
        Why this result changed
        {audit.previousRank !== null && audit.currentRank !== null ? (
          <span className="ml-2 text-foreground-muted">
            #{audit.previousRank} → #{audit.currentRank}
          </span>
        ) : null}
      </summary>
      <div className="mt-3 grid gap-3 text-(length:--text-small) leading-6 text-foreground-soft">
        <p>{explanation}</p>
        {reasons.length > 0 ? (
          <ul className="grid list-disc gap-1 pl-5">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
        {audit.recordedAt ? (
          <p className="text-(length:--text-tiny) text-foreground-muted">
            Last recalculated {formatOptionalDateOnly(audit.recordedAt)}
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function SourceChronologyDisclosure(props: {
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastVerifiedActiveAt: string | null;
}) {
  if (!props.firstSeenAt && !props.lastSeenAt && !props.lastVerifiedActiveAt) {
    return null;
  }

  return (
    <details className="rounded-(--radius-field) border border-(--surface-panel-border) p-4">
      <summary className="cursor-pointer text-(length:--text-small) font-medium text-foreground-soft">
        Source timeline
      </summary>
      <dl className="mt-3 grid gap-2 text-(length:--text-small) leading-6 text-foreground-soft md:grid-cols-3">
        <div className="grid gap-0.5">
          <dt className="font-medium text-foreground">First seen</dt>
          <dd>{formatOptionalDateOnly(props.firstSeenAt, "Unknown")}</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="font-medium text-foreground">Last seen</dt>
          <dd>{formatOptionalDateOnly(props.lastSeenAt, "Unknown")}</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="font-medium text-foreground">Last verified active</dt>
          <dd>
            {formatOptionalDateOnly(props.lastVerifiedActiveAt, "Unknown")}
          </dd>
        </div>
      </dl>
    </details>
  );
}

/**
 * The inspector's two decision blocks — the Shortlist summary above and the
 * Not-interested footer below — are flex siblings of the scroller, never its
 * ancestors, so detail content can never render underneath either bar. What
 * the live walkthrough exposed is the other half of that contract: the
 * scroller needs its own breathing room and a visible boundary, or a
 * half-height fact card butted straight against the Shortlist block reads as
 * a collision instead of as "there is more above".
 *
 * `pt-6`/`pb-6` keep the first and last rows clear of both bars, and the
 * matching `scroll-pt-6`/`scroll-pb-6` keep programmatic reveals (focus moves,
 * `scrollIntoView` from the results list) from parking a row flush against an
 * edge.
 */
export const DISCOVERY_DETAIL_SCROLL_AREA_CLASS_NAME =
  "min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-pb-6 scroll-pt-6 px-6 pb-6 pt-6";

/**
 * The gutter each edge treatment has to cover: the inspector scroller's own
 * `pt-6`/`pb-6`. This is deliberately NOT the shell's 12px route gutter — the
 * inspector is a bounded pane with its own scroller and pads its edges twice
 * as far — which is exactly why the mask height below cannot be the shell's.
 */
export const DISCOVERY_DETAIL_SCROLL_GUTTER_PX = 24;

/**
 * Height of one edge treatment, in px, and the class that paints it.
 *
 * The relationship, stated once instead of left as folklore:
 *
 *     opaque band = height * SHELL_HEADER_MASK_OPAQUE_STOP_FRACTION
 *     40px * 0.6 = 24px = DISCOVERY_DETAIL_SCROLL_GUTTER_PX
 *
 * The opaque band must cover the whole gutter. Below that, a row sitting
 * between the end of the opaque band and the end of the gutter renders
 * semi-transparent and reads as a glyph cut through the middle — "MODE"
 * halved, "Not stated" orphaned from its label, "How this was scored" sliced.
 * The previous 24px height had no opaque head at all (the gradient faded from
 * its first pixel), and 24px with the shared stop would still have left the
 * band from 14.4px to 24px partly transparent.
 *
 * The ratio itself is never restated here: it lives in the shell's module and
 * this height is checked against it by `getMinimumMaskHeightPxForGutter` in
 * the test. The class is a literal because Tailwind only emits classes it can
 * find as literal text.
 */
export const DISCOVERY_DETAIL_SCROLL_EDGE_HEIGHT_PX = 40;
const DISCOVERY_DETAIL_SCROLL_EDGE_HEIGHT_CLASS = "h-10";

const DISCOVERY_DETAIL_SCROLL_EDGE_CLASS_NAME = cn(
  "pointer-events-none absolute inset-x-0 z-10",
  DISCOVERY_DETAIL_SCROLL_EDGE_HEIGHT_CLASS,
  SHELL_HEADER_MASK_OPAQUE_STOP_CLASS,
);

type DiscoveryDetailScrollEdges = { top: boolean; bottom: boolean };

/**
 * Reports which edges of a scroller currently clip content. Measured from the
 * element itself (not from a scroll delta) so it is correct on first paint,
 * after a resize, after a disclosure such as "How this was scored" opens, and
 * after the selected job resets the scroll position.
 */
function useDiscoveryDetailScrollEdges(
  scrollAreaRef: RefObject<HTMLDivElement | null>,
  measurementKey: string,
): DiscoveryDetailScrollEdges {
  const [edges, setEdges] = useState<DiscoveryDetailScrollEdges>({
    top: false,
    bottom: false,
  });

  const measure = useCallback(() => {
    const element = scrollAreaRef.current;
    if (!element) {
      setEdges({ top: false, bottom: false });
      return;
    }

    // Sub-pixel layout rounding must not flicker an edge on and off.
    const next = {
      top: element.scrollTop > 1,
      bottom:
        element.scrollHeight - element.clientHeight - element.scrollTop > 1,
    };
    setEdges((current) =>
      current.top === next.top && current.bottom === next.bottom
        ? current
        : next,
    );
  }, [scrollAreaRef]);

  useEffect(() => {
    const element = scrollAreaRef.current;
    measure();
    if (!element) {
      return;
    }

    element.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    observer?.observe(element);
    const firstChild = element.firstElementChild;
    if (firstChild) {
      observer?.observe(firstChild);
    }

    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [measure, measurementKey, scrollAreaRef]);

  return edges;
}

interface ListingTexts {
  listingText: string;
  fullListingText: string;
  hasFullListingText: boolean;
}

let lastListingTexts: {
  title: string;
  summary: string | null | undefined;
  description: string | undefined;
  texts: ListingTexts;
} | null = null;

/**
 * The listing as readable text. The panel re-renders on every list update,
 * and converting a long listing each time cost tens of milliseconds, so the
 * last job's texts are kept until a different listing is shown.
 */
function readListingTexts(
  job: Pick<SavedJob, "title" | "summary" | "description"> | null,
): ListingTexts {
  if (!job) {
    return { listingText: "", fullListingText: "", hasFullListingText: false };
  }
  if (
    lastListingTexts &&
    lastListingTexts.title === job.title &&
    lastListingTexts.summary === job.summary &&
    lastListingTexts.description === job.description
  ) {
    return lastListingTexts.texts;
  }
  // An echoed job title is not listing text; it reads as a bug under an
  // "About this job" heading.
  const title = job.title.trim().toLowerCase();
  const text = jobDescriptionToText(job.summary ?? job.description).trim();
  const listingText = text.toLowerCase() === title ? "" : text;
  const fullListingText = jobDescriptionToText(job.description, true).trim();
  const texts = {
    listingText,
    fullListingText,
    hasFullListingText:
      fullListingText.replace(/\s+/g, " ").length > listingText.length &&
      fullListingText.toLowerCase() !== title,
  };
  lastListingTexts = {
    title: job.title,
    summary: job.summary,
    description: job.description,
    texts,
  };
  return texts;
}

export function DiscoveryDetailPanel({
  applicationRecords = [],
  reviewQueue = [],
  discoveryTargets,
  isJobPending,
  onDismissJob,
  onPreviewEmployerExclusion,
  onOpenCompany,
  onOpenApplication = () => undefined,
  onOpenListing,
  onAssessJobListing,
  onBackToResults,
  onQueueJob,
  queueFeedback,
  selectedJob,
  selectedJobCompanyId,
  triage = null,
}: DiscoveryDetailPanelProps) {
  const detailScrollAreaRef = useRef<HTMLDivElement>(null);
  // Starts at the mounted job: a new panel has nothing to reset, and resetting
  // its scroll position forced a full page layout on every visit.
  const previousSelectedJobIdRef = useRef<string | null>(
    selectedJob?.id ?? null,
  );
  const selectedJobIdRef = useRef<string | null>(selectedJob?.id ?? null);
  const employerExclusionPreviewRequestRef = useRef(0);
  const dismissRequestRef = useRef(0);
  const isDismissPendingRef = useRef(false);
  const [copiedListingJobId, setCopiedListingJobId] = useState<string | null>(
    null,
  );
  const [assessmentErrorJobId, setAssessmentErrorJobId] = useState<
    string | null
  >(null);
  const [assessmentError, setAssessmentError] = useState<string | null>(null);
  const [assessingJobId, setAssessingJobId] = useState<string | null>(null);
  const [listingCopyFailedJobId, setListingCopyFailedJobId] = useState<
    string | null
  >(null);
  const [feedbackJobId, setFeedbackJobId] = useState<string | null>(null);
  const [feedbackReasons, setFeedbackReasons] = useState<
    DiscoveryFeedbackReason[]
  >([]);
  const [feedbackAction, setFeedbackAction] = useState<
    "hide_job" | "hide_and_exclude_employer"
  >("hide_job");
  const [employerExclusionPreview, setEmployerExclusionPreview] =
    useState<EmployerExclusionPreview | null>(null);
  const [
    isEmployerExclusionPreviewPending,
    setEmployerExclusionPreviewPending,
  ] = useState(false);
  const [employerExclusionPreviewError, setEmployerExclusionPreviewError] =
    useState<string | null>(null);
  const [isDismissPending, setDismissPending] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const detailScrollEdges = useDiscoveryDetailScrollEdges(
    detailScrollAreaRef,
    selectedJob?.id ?? "",
  );
  selectedJobIdRef.current = selectedJob?.id ?? null;
  const sourceLabels = getDiscoverySourceLabels(
    selectedJob?.provenance ?? [],
    discoveryTargets,
  );
  const normalizedCompensation =
    formatStatedNormalizedCompensation(selectedJob);
  const intelligenceSummaries = buildIntelligenceSummaries(
    selectedJob?.sourceIntelligence ?? null,
  );
  const flaggedKeywords = listFlaggedKeywordTerms(
    selectedJob?.keywordSignals ?? [],
    selectedJob?.keySkills ?? [],
  );
  const isSelectedJobPending = selectedJob
    ? isJobPending(selectedJob.id)
    : false;
  const isFeedbackPending = isSelectedJobPending || isDismissPending;
  const selectedJobEmployerExclusionPreview =
    employerExclusionPreview?.jobId === selectedJob?.id
      ? employerExclusionPreview
      : null;
  const isAlreadyShortlisted =
    selectedJob !== null &&
    !["discovered", "shortlisted"].includes(selectedJob.status);
  const existingNeedsYouApplication = selectedJob
    ? applicationRecords.find(
        (record) =>
          record.jobId === selectedJob.id &&
          getApplicationStagePresentation(record).label === "Needs you",
      )
    : null;
  // One readiness value for this job. Shortlisted already computes it from the
  // draft and its review, so when the job is on that list the inspector reads
  // that same value rather than deriving a second one from the stored status.
  const queueItem = selectedJob
    ? (reviewQueue.find((item) => item.jobId === selectedJob.id) ?? null)
    : null;
  const readinessStatus = selectedJob
    ? queueItem
      ? getReviewQueueWorkflowStatus(
          queueItem,
          null,
          isJobPending(selectedJob.id),
          collectPreparedApplicationJobIds(applicationRecords),
          collectInProgressApplicationJobIds(applicationRecords),
        )
      : {
          label: presentDiscoveryJobStatusLabel(selectedJob.status),
          tone: getApplicationTone(selectedJob.status),
        }
    : null;
  const recommendation = selectedJob
    ? fitRecommendationCopy[
        selectedJob.matchAssessment.recommendation ?? "review_before_applying"
      ]
    : null;
  const assessmentPresentation = selectedJob
    ? getMatchAssessmentPresentation(selectedJob)
    : null;
  // `null` when the listing has no date worth printing: a listing with no
  // posted or provider-updated date must not render a bare "Updated — Unknown"
  // fact, and a posted slot holding a non-date token must not render at all.
  const listingDate = selectedJob ? getPostedDateLabel(selectedJob) : null;
  const applicationMethodLabel =
    selectedJob?.applyPath === "easy_apply"
      ? "Easy Apply"
      : selectedJob?.applyPath === "external_redirect"
        ? "Apply on company site"
        : "Manual application";
  const listingActivity = presentListingActivity(
    selectedJob?.listingActivity ?? { status: "unknown" },
  );
  const needsSourceVerification =
    selectedJob?.listingActivity?.status === "inactive" ||
    selectedJob?.listingActivity?.status === "stale";
  const isReportedClosed = selectedJob?.listingActivity?.status === "closed";
  const employerLocationLine = selectedJob
    ? formatJobEmployerLocationLine({
        company: selectedJob.company,
        location: selectedJob.location,
        canonicalUrl: selectedJob.canonicalUrl,
        separator: " • ",
      })
    : "";
  // "Chicago, IL" is ONE place written the way people write places. Counting
  // the commas made the panel claim two, above a card that listed one, so the
  // count and the list are read off the same split here.
  const listingLocationCount = countListingLocations(selectedJob?.location);
  const listingLocationLabel =
    splitListingLocationValues(selectedJob?.location)
      .map((place) => collapseRepeatedListingParts(place))
      .filter((place): place is string => Boolean(place))
      .join(" · ") || null;
  const employerDisplay = selectedJob
    ? resolveJobEmployerDisplay({
        company: selectedJob.company,
        canonicalUrl: selectedJob.canonicalUrl,
      })
    : null;
  // A six-month contract read as a permanent role at an annual salary until
  // the user opened the page. The board's own spelling is machine text
  // ("FULL_TIME") and a flattened card repeats the same place and work mode
  // in every slot it had, so each fact is said once and in plain words. A
  // listing whose place is simply "Remote" already states its work mode, so
  // the mode is not printed a second time beside it.
  const workModeLabel = selectedJob
    ? (formatWorkModeLabel(selectedJob.workMode) ?? "Work mode not stated")
    : null;
  const locationAndWorkModeLine = selectedJob
    ? [
        formatEmploymentTypeLabel(selectedJob.employmentType),
        listingLocationLabel,
        // "Remote (UK) · Remote" and "Hybrid, London · Hybrid" say the mode
        // twice; the place already carries it whenever it names it.
        listingLocationLabel &&
        workModeLabel &&
        listingLocationLabel
          .toLowerCase()
          .includes(workModeLabel.trim().toLowerCase())
          ? null
          : workModeLabel,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const { listingText, fullListingText, hasFullListingText } =
    readListingTexts(selectedJob);
  // Sources hand over summaries cut mid-sentence ("...data science, A"). When
  // the full text is one click away, end the excerpt on a whole word with an
  // ellipsis instead of a dangling fragment.
  const listingExcerpt =
    listingText && hasFullListingText && !/[.!?…]["')\]]?$/.test(listingText)
      ? `${listingText.replace(/\s+\S*$/, "")}…`
      : listingText;
  // One honest sentence instead of a wall of cards: the hedge when nothing was
  // verified, otherwise the first saved reason.
  const whyItFitsLine = selectedJob
    ? selectedJob.matchAssessment.recommendation === "skip"
      ? scrubJobAbsencePlaceholders(
          joinUniqueSentences([
            selectedJob.matchAssessment.recommendationRationale ?? "",
          ]),
        ) || "This listing conflicts with your saved profile."
      : (assessmentPresentation?.withheldReason ??
        (scrubJobAbsencePlaceholders(
          selectedJob.matchAssessment.reasons.find(
            (reason) => reason.trim().length > 0,
          ) ?? "",
        ) ||
          "Estimated from the listing requirements and evidence in your approved profile."))
    : "";

  // The triage summary's deciding facts and the first gaps, one line each.
  const triageGaps = selectedJob
    ? selectedJob.matchAssessment.gaps
        .map((gap) => scrubJobAbsencePlaceholders(gap))
        .filter((gap) => gap.trim().length > 0)
        .slice(0, 2)
    : [];
  // The header already names the place, so only what it does not say: the
  // work mode only when known and not already in the place ("Remote (UK)").
  const triageWorkMode = selectedJob
    ? formatWorkModeLabel(selectedJob.workMode)
    : null;
  const triageFacts = selectedJob
    ? [
        selectedJob.salaryText ?? "Pay not stated",
        formatEmploymentTypeLabel(selectedJob.employmentType),
        triageWorkMode &&
        !(selectedJob.location ?? "")
          .toLowerCase()
          .includes(triageWorkMode.trim().toLowerCase())
          ? triageWorkMode
          : null,
        listingLocationCount > 1
          ? `open in ${listingLocationCount} places`
          : null,
        listingDate ? `${listingDate.label} ${listingDate.value}` : null,
        sourceLabels[0] ?? null,
      ].filter((fact): fact is string => Boolean(fact))
    : [];

  useLayoutEffect(() => {
    const selectedJobId = selectedJob?.id ?? null;
    if (previousSelectedJobIdRef.current !== selectedJobId) {
      employerExclusionPreviewRequestRef.current += 1;
      dismissRequestRef.current += 1;
      isDismissPendingRef.current = false;
      setFeedbackJobId(null);
      setFeedbackReasons([]);
      setFeedbackAction("hide_job");
      setEmployerExclusionPreview(null);
      setEmployerExclusionPreviewPending(false);
      setEmployerExclusionPreviewError(null);
      setDismissPending(false);
      setDismissError(null);
      if (detailScrollAreaRef.current) {
        detailScrollAreaRef.current.scrollTop = 0;
      }
    }
    previousSelectedJobIdRef.current = selectedJobId;

    return () => {
      employerExclusionPreviewRequestRef.current += 1;
      dismissRequestRef.current += 1;
      isDismissPendingRef.current = false;
    };
  }, [selectedJob?.id]);

  const closeFeedback = () => {
    employerExclusionPreviewRequestRef.current += 1;
    dismissRequestRef.current += 1;
    isDismissPendingRef.current = false;
    setFeedbackJobId(null);
    setFeedbackReasons([]);
    setFeedbackAction("hide_job");
    setEmployerExclusionPreview(null);
    setEmployerExclusionPreviewPending(false);
    setEmployerExclusionPreviewError(null);
    setDismissPending(false);
    setDismissError(null);
  };

  const previewEmployerExclusion = (jobId: string) => {
    const requestId = employerExclusionPreviewRequestRef.current + 1;
    employerExclusionPreviewRequestRef.current = requestId;
    setEmployerExclusionPreview(null);
    setEmployerExclusionPreviewPending(true);
    setEmployerExclusionPreviewError(null);
    if (!onPreviewEmployerExclusion) {
      setEmployerExclusionPreviewPending(false);
      setEmployerExclusionPreviewError(
        "Employer exclusion could not be checked. You can still hide only this job.",
      );
      return;
    }
    void onPreviewEmployerExclusion(jobId)
      .then((preview) => {
        if (
          employerExclusionPreviewRequestRef.current !== requestId ||
          selectedJobIdRef.current !== jobId
        ) {
          return;
        }
        if (preview.jobId !== jobId) {
          setEmployerExclusionPreviewError(
            "Employer exclusion could not be checked. You can still hide only this job.",
          );
          return;
        }
        setEmployerExclusionPreview(preview);
      })
      .catch(() => {
        if (
          employerExclusionPreviewRequestRef.current !== requestId ||
          selectedJobIdRef.current !== jobId
        ) {
          return;
        }
        setEmployerExclusionPreview(null);
        setEmployerExclusionPreviewError(
          "Employer exclusion could not be checked. You can still hide only this job.",
        );
      })
      .finally(() => {
        if (
          employerExclusionPreviewRequestRef.current === requestId &&
          selectedJobIdRef.current === jobId
        ) {
          setEmployerExclusionPreviewPending(false);
        }
      });
  };

  const dismissSelectedJob = async (jobId: string) => {
    if (isDismissPendingRef.current) {
      return;
    }
    const reasons = [...feedbackReasons];
    const action = feedbackAction;
    const expectedNormalizedCompanyName =
      action === "hide_and_exclude_employer" &&
      selectedJobEmployerExclusionPreview?.status === "available"
        ? selectedJobEmployerExclusionPreview.normalizedCompanyName
        : null;
    if (
      action === "hide_and_exclude_employer" &&
      expectedNormalizedCompanyName === null
    ) {
      setDismissError(
        "The employer identity is no longer current. Check it again before retrying.",
      );
      return;
    }
    const requestId = dismissRequestRef.current + 1;
    dismissRequestRef.current = requestId;
    isDismissPendingRef.current = true;
    setDismissPending(true);
    setDismissError(null);
    try {
      await onDismissJob(jobId, reasons, action, expectedNormalizedCompanyName);
      if (
        dismissRequestRef.current === requestId &&
        selectedJobIdRef.current === jobId
      ) {
        closeFeedback();
      }
    } catch {
      if (
        dismissRequestRef.current === requestId &&
        selectedJobIdRef.current === jobId
      ) {
        isDismissPendingRef.current = false;
        setDismissPending(false);
        setDismissError(
          "The job could not be hidden. Your choices were kept. Try again.",
        );
      }
    }
  };

  return (
    // The clip is only needed by the bounded two-pane scroller from `xl` up.
    // Below that breakpoint the inspector stacks under the whole result list
    // and has no height of its own, so nothing inside it ever scrolls and the
    // clip would only make the pane its own never-scrolling scroll container
    // — which is what `position: sticky` resolves against, leaving the pinned
    // summary row below inert. Its own background matches the panel, so the
    // rounded border still reads as a closed card without the clip.
    <section
      aria-label="Job details"
      className={`surface-panel-shell relative flex min-h-0 min-w-0 flex-col overflow-visible rounded-(--radius-panel) border border-(--surface-panel-border) ${JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.base} ${JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.fixedHeader} ${JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.wideFixedHeader} xl:h-full xl:min-h-0 xl:overflow-hidden`}
      id={DISCOVERY_DETAIL_REGION_ID}
    >
      {/* With a job open its own title heads the pane, the same header
          Shortlisted and Applications use; a "Job details" bar above it only
          repeated the pane's name and cost a row. The bar stays for the
          empty pane, where it is the only heading. */}
      {selectedJob ? null : (
        <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-(--surface-panel-border) px-4 py-3">
          <p className="text-(length:--text-heading-3) font-semibold text-(--text-headline)">
            Job details
          </p>
          {onBackToResults ? (
            <Button
              className="xl:hidden"
              onClick={onBackToResults}
              size="sm"
              variant="ghost"
            >
              Back to results
            </Button>
          ) : null}
        </div>
      )}

      {selectedJob ? (
        <>
          {/* At and above the two-pane breakpoint this row already sits above
              the pane's own bounded scroller, so it is always in view and the
              stacked pin must not apply. Below it the pane stacks under the
              full result list and grows to its natural height, which put
              "Shortlist job" thousands of pixels down the route with nothing
              holding it on screen; pinning it to the top of the route
              scroller keeps the job's action in the pane's first viewport
              however far the user reads. */}
          <div
            aria-label="Selected job summary"
            className="sticky top-0 z-20 grid shrink-0 gap-3 border-b border-(--surface-panel-border) bg-(--surface-panel) px-6 pb-4 pt-4 xl:static"
            data-testid="discovery-detail-primary-action"
            role="group"
          >
            {/* Below the two-pane breakpoint this row is pinned and the whole
                detail body scrolls under it, so its bottom border was cutting
                rows through the middle of a glyph — "How this was scored"
                sliced in half. The same mask the shell paints under its own
                fixed header ends the page cleanly here instead: opaque across
                the band a row can occupy, then fading, so nothing is left
                half-readable against the chrome. From `xl` up the row is
                static with the pane's own scroller below it, so there is
                nothing to mask and the mask is not painted. Its height and
                opaque stop come from the shell's shared values; a local copy
                would drift the next time the chrome changes. */}
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 top-full z-10 bg-gradient-to-b from-(--surface-panel) to-transparent xl:hidden",
                SHELL_HEADER_MASK_HEIGHT_CLASS,
                SHELL_HEADER_MASK_OPAQUE_STOP_CLASS,
              )}
              data-testid="discovery-detail-pinned-summary-mask"
            />
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="grid min-w-0 flex-1 gap-1">
                <h2
                  className={`min-w-0 break-words rounded-sm text-(length:--text-section-title) font-semibold tracking-[-0.03em] text-(--text-headline) outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 ${JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.base} ${JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.fixedHeader} ${JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.wideFixedHeader}`}
                  id={DISCOVERY_DETAIL_HEADING_ID}
                  tabIndex={-1}
                >
                  {selectedJob.title}
                </h2>
                {employerLocationLine ? (
                  <p className="text-(length:--text-description) text-foreground-soft">
                    {employerLocationLine}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {onBackToResults ? (
                  <Button
                    className="xl:hidden"
                    onClick={onBackToResults}
                    size="sm"
                    variant="ghost"
                  >
                    Back to results
                  </Button>
                ) : null}
                {/* "Discovered" is the state of every row on this page; the
                    badge only earns its place once the job has moved on to
                    Shortlisted. */}
                {readinessStatus &&
                [
                  "drafting",
                  "ready_for_review",
                  "approved",
                  "submitted",
                ].includes(selectedJob.status) ? (
                  <StatusBadge
                    className="shrink-0 whitespace-nowrap"
                    tone={readinessStatus.tone}
                  >
                    {readinessStatus.label}
                  </StatusBadge>
                ) : null}
              </div>
            </div>
            {triage ? (
              <>
                {/* The decision first: the verdict, the facts that decide, then
                    the actions. The listing text follows below. */}
                <div
                  className="grid min-w-0 gap-1"
                  data-testid="discovery-detail-verdict"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <strong
                      aria-label={assessmentPresentation?.headlineScoreAriaLabel}
                      className={
                        assessmentPresentation?.isScoreWithheld
                          ? "text-(length:--text-body) text-foreground-soft"
                          : "text-(length:--text-body) text-(--text-headline)"
                      }
                      data-testid="discovery-detail-fit-score"
                    >
                      {assessmentPresentation?.headlineScoreLabel}
                    </strong>
                    {recommendation ? (
                      <StatusBadge
                        tone={
                          assessmentPresentation?.isProvisional
                            ? "neutral"
                            : recommendation.tone
                        }
                      >
                        {recommendation.label}
                      </StatusBadge>
                    ) : null}
                  </div>
                  <p
                    className="max-w-[78ch] text-(length:--text-small) leading-5 text-foreground-soft"
                    data-testid="discovery-detail-why-it-fits"
                  >
                    {whyItFitsLine}
                  </p>
                  {triageGaps.length > 0 ? (
                    <p className="max-w-[78ch] text-(length:--text-small) leading-5 text-foreground-muted">
                      Gaps: {triageGaps.join(" · ")}
                    </p>
                  ) : null}
                  <p
                    className="text-(length:--text-small) leading-5 text-foreground-muted"
                    data-testid="discovery-detail-key-facts"
                    {...(selectedJob.salaryText && normalizedCompensation
                      ? { title: `About ${normalizedCompensation}` }
                      : {})}
                  >
                    {triageFacts.join(" · ")}
                  </p>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {existingNeedsYouApplication ? (
                    <Button
                      onClick={() =>
                        onOpenApplication(existingNeedsYouApplication.id)
                      }
                      type="button"
                      variant="primary"
                    >
                      Needs you · Open application
                    </Button>
                  ) : isAlreadyShortlisted ? (
                    <Button asChild variant="primary">
                      <Link
                        aria-describedby={DISCOVERY_DETAIL_HEADING_ID}
                        data-testid="discovery-detail-open-shortlisted"
                        to={buildJobFinderContextRoute(
                          "/job-finder/review-queue",
                          { jobId: selectedJob.id },
                        )}
                      >
                        Open in Shortlisted
                      </Link>
                    </Button>
                  ) : (
                    <>
                      <Button
                        aria-describedby={DISCOVERY_DETAIL_HEADING_ID}
                        aria-keyshortcuts="S"
                        disabled={
                          isSelectedJobPending ||
                          isReportedClosed ||
                          !triage.onShortlist
                        }
                        onClick={() => triage.onShortlist?.()}
                        title={
                          triage.nextTitle
                            ? `Shortlist, then open ${triage.nextTitle} (S)`
                            : "Shortlist (S)"
                        }
                        type="button"
                        variant="primary"
                      >
                        {isReportedClosed
                          ? "Reported closed"
                          : needsSourceVerification
                            ? "Shortlist anyway"
                            : "Shortlist job"}
                        <TriageKey>S</TriageKey>
                      </Button>
                      <Button
                        aria-keyshortcuts="X"
                        disabled={isSelectedJobPending || !triage.onNotInterested}
                        onClick={() => triage.onNotInterested?.()}
                        title="Hide this job and open the next one (X)"
                        type="button"
                        variant="outline"
                      >
                        Not interested
                        <TriageKey>X</TriageKey>
                      </Button>
                    </>
                  )}
                  {triage.onSkip ? (
                    <Button
                      aria-keyshortcuts="J"
                      onClick={triage.onSkip}
                      title={
                        triage.nextTitle
                          ? `Leave this one and open ${triage.nextTitle} (J; K goes back)`
                          : "Next job (J)"
                      }
                      type="button"
                      variant="ghost"
                    >
                      Skip
                      <TriageKey>J</TriageKey>
                    </Button>
                  ) : null}
                  <span className="ml-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-(length:--text-small) text-foreground-muted">
                    <span
                      className="tabular-nums"
                      data-testid="discovery-triage-progress"
                    >
                      {triage.goneThrough} of {triage.total}
                      {triage.weaker ? " weaker" : ""} gone through
                    </span>
                    {triage.undo ? (
                      <Button
                        aria-keyshortcuts="U"
                        className="h-auto px-0 text-(length:--text-small)"
                        onClick={triage.undo.onUndo}
                        size="compact"
                        title={`${triage.undo.label} (U)`}
                        type="button"
                        variant="link"
                      >
                        Undo
                      </Button>
                    ) : null}
                  </span>
                </div>
                {triage.failure ? (
                  <p
                    className="text-(length:--text-small) leading-5 text-(--warning-text)"
                    role="alert"
                  >
                    {triage.failure}
                  </p>
                ) : null}
              </>
            ) : existingNeedsYouApplication ? (
                <Button
                  className="h-11 w-full"
                  onClick={() =>
                    onOpenApplication(existingNeedsYouApplication.id)
                  }
                  type="button"
                  variant="primary"
                >
                  Needs you · Open application
                </Button>
              ) : isAlreadyShortlisted ? (
                <Button asChild className="h-11 w-full" variant="primary">
                  <Link
                    aria-describedby={DISCOVERY_DETAIL_HEADING_ID}
                    data-testid="discovery-detail-open-shortlisted"
                    to={buildJobFinderContextRoute("/job-finder/review-queue", {
                      jobId: selectedJob.id,
                    })}
                  >
                    Open in Shortlisted
                  </Link>
                </Button>
              ) : (
                <Button
                  aria-describedby={DISCOVERY_DETAIL_HEADING_ID}
                  className="h-11 w-full"
                  disabled={isSelectedJobPending || isReportedClosed}
                  onClick={() => onQueueJob(selectedJob.id)}
                  type="button"
                  variant="primary"
                >
                  {isReportedClosed
                    ? "Reported closed"
                    : needsSourceVerification
                      ? "Shortlist anyway"
                      : "Shortlist job"}
                </Button>
              )}
            {!isAlreadyShortlisted && needsSourceVerification ? (
              <p
                className="break-words text-(length:--text-tiny) leading-5 text-foreground-muted"
                role="note"
              >
                Verify availability on the original source before relying on
                this listing.
              </p>
            ) : null}
            {selectedJob.listingDetailFetch?.identityConflict ? (
              <p
                className="break-words text-(length:--text-tiny) leading-5 text-foreground-muted"
                data-testid="discovery-detail-role-conflict"
                role="note"
              >
                The listing page now names a different role:{" "}
                {selectedJob.listingDetailFetch.identityConflict.observedTitle}.
                Open the listing and check it before you apply.
              </p>
            ) : null}
            {!isAlreadyShortlisted && isReportedClosed ? (
              <p
                className="break-words text-(length:--text-tiny) leading-5 text-foreground-muted"
                role="note"
              >
                Shortlisting is unavailable because this listing was reported
                closed. The original listing link remains available below.
              </p>
            ) : null}
          </div>

          <div
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            data-testid="discovery-detail-scroll-frame"
          >
            <div
              aria-hidden="true"
              className={`${DISCOVERY_DETAIL_SCROLL_EDGE_CLASS_NAME} top-0 border-t border-(--surface-panel-border) bg-gradient-to-b from-(--surface-panel) to-transparent`}
              data-testid="discovery-detail-scroll-edge-top"
              hidden={!detailScrollEdges.top}
            />
            <div
              aria-hidden="true"
              className={`${DISCOVERY_DETAIL_SCROLL_EDGE_CLASS_NAME} bottom-0 border-b border-(--surface-panel-border) bg-gradient-to-t from-(--surface-panel) to-transparent`}
              data-testid="discovery-detail-scroll-edge-bottom"
              hidden={!detailScrollEdges.bottom}
            />
            <div
              aria-label="Job detail content"
              className={DISCOVERY_DETAIL_SCROLL_AREA_CLASS_NAME}
              data-locked-pane-scroll-region
              data-testid="discovery-detail-scroll-area"
              ref={detailScrollAreaRef}
              role="region"
              tabIndex={0}
            >
              <div className="grid min-h-full min-w-0 content-start gap-5 [overflow-wrap:anywhere]">
                {/* The job first, the app's reasoning after it. A job seeker
                  asks what the job is, what it pays, and why them — in that
                  order — so the listing text, pay and place lead, the score
                  is one line, and the full breakdown waits behind a
                  disclosure. */}
                <div
                  className="grid min-w-0 gap-2"
                  data-testid="discovery-detail-listing-text"
                >
                  <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-soft">
                    About this job
                  </span>
                  <p className="min-w-0 max-w-[78ch] text-(length:--text-body) leading-7 text-foreground-soft">
                    {wasDiscoveryListingReadBlocked(selectedJob)
                      ? describeDiscoveryMissingListingText(selectedJob)
                      : listingExcerpt ||
                        describeDiscoveryMissingListingText(selectedJob)}
                  </p>
                  {hasFullListingText ? (
                    <details key={selectedJob.id} className="min-w-0">
                      <summary className="cursor-pointer py-2 text-(length:--text-small) font-medium text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        Read full job description
                      </summary>
                      <p className="mt-2 max-w-[78ch] whitespace-pre-line break-words text-(length:--text-body) leading-7 text-foreground-soft">
                        {fullListingText}
                      </p>
                    </details>
                  ) : null}
                </div>

                {/* With the triage bar on top, pay, place and the verdict are
                    already there; the cards below would only repeat them. */}
                {triage ? null : (
                  <>
                  <div
                    className="grid min-w-0 gap-3 sm:grid-cols-2"
                    data-job-fact-grid
                  >
                    <div className="surface-card-tint min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) p-4">
                      <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-soft">
                        Salary
                      </span>
                      <strong className="mt-2 block text-(length:--text-body) text-(--text-headline)">
                        {selectedJob.salaryText ?? "Not stated"}
                      </strong>
                      {selectedJob.salaryText && normalizedCompensation ? (
                        <p className="mt-2 text-(length:--text-small) text-foreground-soft">
                          About {normalizedCompensation}
                        </p>
                      ) : null}
                    </div>
                    <div className="surface-card-tint min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) p-4">
                      <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-soft">
                        Location and work mode
                      </span>
                      <strong className="mt-2 block text-(length:--text-body) text-(--text-headline)">
                        {locationAndWorkModeLine}
                      </strong>
                      {listingLocationCount > 1 ? (
                        <p
                          className="mt-2 text-(length:--text-small) text-foreground-soft"
                          data-testid="discovery-detail-location-count"
                        >
                          This job is open in {listingLocationCount} places.
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div
                    className="grid min-w-0 gap-2"
                    data-testid="discovery-detail-why-it-fits"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <strong
                        aria-label={
                          assessmentPresentation?.headlineScoreAriaLabel
                        }
                        className={
                          assessmentPresentation?.isScoreWithheld
                            ? "text-(length:--text-body) text-foreground-soft"
                            : "text-(length:--text-body) text-(--text-headline)"
                        }
                        data-testid="discovery-detail-fit-score"
                      >
                        {/* A percentage is only printed when the evidence behind
                          it was actually checkable. Otherwise the number stays
                          inside "How this was scored" beside its evidence. */}
                        {assessmentPresentation?.headlineScoreLabel}
                      </strong>
                      {recommendation ? (
                        <StatusBadge
                          tone={
                            assessmentPresentation?.isProvisional
                              ? "neutral"
                              : recommendation.tone
                          }
                        >
                          {recommendation.label}
                        </StatusBadge>
                      ) : null}
                    </div>
                    <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                      {whyItFitsLine}
                    </p>
                  </div>
                  </>
                )}

                <details className="min-w-0 rounded-(--radius-field) border border-(--surface-panel-border)">
                  <summary className="cursor-pointer px-4 py-3 text-(length:--text-small) font-medium text-foreground-soft">
                    How this was scored
                  </summary>
                  <div className="grid gap-4 px-4 pb-4">
                    <MatchAssessmentChangeDisclosure
                      audit={selectedJob.latestMatchAssessmentAudit}
                    />
                    <MatchEvidenceMatrix
                      assessment={selectedJob.matchAssessment}
                      listingCapture={
                        selectedJob.listingDetailCapture?.state ?? null
                      }
                      scoreLabel={
                        assessmentPresentation?.breakdownScoreLabel ?? null
                      }
                      showRecommendation={false}
                    />
                  </div>
                </details>

                <div
                  className="grid gap-3 sm:grid-cols-2"
                  data-job-detail-fact-grid
                >
                  <div
                    className="surface-card-tint min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) p-4 sm:col-span-2"
                    data-testid="discovery-detail-listing-activity"
                  >
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
                      <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-soft">
                        Listing status
                      </span>
                      <StatusBadge
                        className="shrink-0 px-2.5 py-1 text-(length:--text-tiny) font-semibold tracking-[0.04em]"
                        tone={listingActivity.tone}
                      >
                        {listingActivity.label}
                      </StatusBadge>
                    </div>
                    <p className="mt-2 break-words text-(length:--text-small) leading-5 text-foreground-soft">
                      {listingActivity.description}
                    </p>
                  </div>
                  {listingDate ? (
                    <div className="surface-card-tint rounded-(--radius-field) border border-(--surface-panel-border) p-4 sm:col-span-2">
                      <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-soft">
                        {listingDate.label}
                      </span>
                      <strong className="mt-2 block text-(length:--text-body) text-(--text-headline)">
                        {listingDate.value}
                      </strong>
                    </div>
                  ) : null}
                  {/* A card like the two above it, and skills in their own
                      spelling ("Node.js", not "NODE.JS"). */}
                  {selectedJob.keySkills.length > 0 ? (
                    <div
                      className="surface-card-tint min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) p-4 sm:col-span-2"
                      data-testid="discovery-detail-skills"
                    >
                      <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-soft">
                        Skills mentioned
                      </span>
                      <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
                        {selectedJob.keySkills.map((skill) => (
                          <Chip
                            className="font-sans text-(length:--text-small) normal-case tracking-normal"
                            key={skill}
                          >
                            {skill}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                {selectedJob.screeningHints.remoteGeographies.length > 0 ? (
                  <PreferenceList
                    compact
                    label="Remote geography hints"
                    values={selectedJob.screeningHints.remoteGeographies}
                  />
                ) : null}
                {selectedJob.screeningHints.sponsorshipText ? (
                  <div className="grid gap-2">
                    <p className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
                      Screening hint
                    </p>
                    <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                      {selectedJob.screeningHints.sponsorshipText}
                    </p>
                  </div>
                ) : null}
                {selectedJob.screeningHints.relocationText ? (
                  <div className="grid gap-2">
                    <p className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
                      Relocation
                    </p>
                    <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                      {selectedJob.screeningHints.relocationText}
                    </p>
                  </div>
                ) : null}
                {selectedJob.screeningHints.travelText ? (
                  <div className="grid gap-2">
                    <p className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
                      Travel
                    </p>
                    <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                      {selectedJob.screeningHints.travelText}
                    </p>
                  </div>
                ) : null}
                {selectedJob.screeningHints.requiresSecurityClearance ===
                true ? (
                  <div className="grid gap-2">
                    <p className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
                      Security clearance
                    </p>
                    <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                      This listing mentions an active or required security
                      clearance.
                    </p>
                  </div>
                ) : null}
                {/* Company context is a detour, not the decision on this
                    screen, so it sits below the listing rather than above it. */}
                {selectedJobCompanyId && onOpenCompany && employerDisplay ? (
                  <Button
                    // A long employer name wraps inside the column instead of
                    // widening it and clipping the listing text beside it.
                    className="h-auto min-h-8 max-w-full justify-self-start whitespace-normal py-1.5 text-left"
                    onClick={() => onOpenCompany(selectedJobCompanyId)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    View {employerDisplay} in Companies
                  </Button>
                ) : null}

                {/* Where the job came from and how the app read it. None of
                    this decides whether to shortlist, so it folds behind one
                    line instead of trailing the pane as six loose cards. */}
                <details
                  className="min-w-0 rounded-(--radius-field) border border-(--surface-panel-border)"
                  data-testid="discovery-detail-source-details"
                >
                  <summary className="cursor-pointer px-4 py-3 text-(length:--text-small) font-medium text-foreground-soft">
                    Source details
                  </summary>
                  <div className="grid gap-4 px-4 pb-4">
                    <PreferenceList
                      compact
                      label="Found on"
                      values={sourceLabels}
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="surface-card-tint min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) p-4 sm:col-span-2">
                        <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-soft">
                          Original listing
                        </span>
                        <strong className="mt-2 block break-all text-(length:--text-small) text-(--text-headline)">
                          <ExternalUrlLink url={selectedJob.canonicalUrl} />
                        </strong>
                        <p
                          className="mt-2 text-(length:--text-small) leading-5 text-foreground-soft"
                          data-testid="discovery-detail-application-method"
                        >
                          Application method: {applicationMethodLabel}
                        </p>
                        {listingCopyFailedJobId === selectedJob.id ? (
                          <p className="mt-2 text-(length:--text-small) leading-5 text-destructive">
                            The link could not be copied. Select the URL above
                            and copy it manually.
                          </p>
                        ) : null}
                      </div>
                      {selectedJob.applicationUrl &&
                      selectedJob.applicationUrl !==
                        selectedJob.canonicalUrl ? (
                        <div className="surface-card-tint rounded-(--radius-field) border border-(--surface-panel-border) p-4 sm:col-span-2">
                          <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-soft">
                            Application route
                          </span>
                          <strong className="mt-2 block break-all text-(length:--text-small) text-(--text-headline)">
                            <ExternalUrlLink url={selectedJob.applicationUrl} />
                          </strong>
                        </div>
                      ) : null}
                      {selectedJob.atsProvider ? (
                        <div className="surface-card-tint rounded-(--radius-field) border border-(--surface-panel-border) p-4 sm:col-span-2">
                          <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-soft">
                            Applications handled by
                          </span>
                          <strong className="mt-2 block text-(length:--text-body) text-(--text-headline)">
                            {selectedJob.atsProvider}
                          </strong>
                        </div>
                      ) : null}
                    </div>
                    {flaggedKeywords.length > 0 ? (
                      <PreferenceList
                        compact
                        label="Keywords the source flagged"
                        values={flaggedKeywords}
                      />
                    ) : null}
                    <SourceDiagnostics summaries={intelligenceSummaries} />
                    <SourceChronologyDisclosure
                      firstSeenAt={selectedJob.firstSeenAt}
                      lastSeenAt={selectedJob.lastSeenAt}
                      lastVerifiedActiveAt={selectedJob.lastVerifiedActiveAt}
                    />
                    {selectedJob.employerWebsiteUrl ? (
                      <div className="grid gap-2">
                        <p className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
                          Company site
                        </p>
                        <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                          This job points to a company site that opens during
                          the application flow.
                        </p>
                      </div>
                    ) : null}
                  </div>
                </details>
              </div>
            </div>
          </div>

          <div
            // The actions (and the "Not interested because…" choices) scroll
            // within half the panel, and the job text above is clipped to its
            // own frame, so the two never paint over each other.
            className="grid max-h-[55%] min-w-0 shrink-0 gap-2 overflow-y-auto border-t border-(--surface-panel-border) bg-(--surface-panel) px-6 py-3"
            data-testid="discovery-detail-actions"
          >
            {queueFeedback ? (
              <>
                <p
                  className={
                    queueFeedback.status === "failure"
                      ? "break-words text-(length:--text-small) leading-5 text-destructive"
                      : "break-words text-(length:--text-small) leading-5 text-foreground-muted"
                  }
                  data-testid="discovery-detail-queue-feedback"
                  role={queueFeedback.status === "failure" ? "alert" : "status"}
                >
                  {queueFeedback.message}
                </p>
                {queueFeedback.status === "success" ? (
                  <p
                    className="break-words text-(length:--text-small) leading-5 text-foreground-muted"
                    data-testid="discovery-detail-queue-identity"
                  >
                    Selected for Shortlisted: {selectedJob.title} at{" "}
                    {employerDisplay ?? selectedJob.company}.
                  </p>
                ) : null}
              </>
            ) : null}
            {feedbackJobId === selectedJob.id ? (
              <fieldset className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-3">
                <legend className="px-1 text-(length:--text-small) font-medium text-foreground">
                  Not interested because…
                </legend>
                <p className="text-(length:--text-tiny) leading-5 text-foreground-muted">
                  Optional feedback stays local. It hides this result but never
                  changes job facts or fit scoring.
                </p>
                <div className="flex flex-wrap gap-2">
                  {discoveryFeedbackOptions.map((option) => {
                    const selected = feedbackReasons.includes(option.value);
                    return (
                      <Button
                        aria-pressed={selected}
                        disabled={isFeedbackPending}
                        key={option.value}
                        onClick={() => {
                          setFeedbackReasons((current) =>
                            selected
                              ? current.filter(
                                  (reason) => reason !== option.value,
                                )
                              : [...current, option.value],
                          );
                          if (option.value !== "company" || selected) {
                            if (option.value === "company") {
                              employerExclusionPreviewRequestRef.current += 1;
                              setFeedbackAction("hide_job");
                              setEmployerExclusionPreview(null);
                              setEmployerExclusionPreviewPending(false);
                              setEmployerExclusionPreviewError(null);
                            }
                            return;
                          }
                          previewEmployerExclusion(selectedJob.id);
                        }}
                        size="sm"
                        type="button"
                        variant={selected ? "secondary" : "ghost"}
                      >
                        {option.label}
                      </Button>
                    );
                  })}
                </div>
                {feedbackReasons.includes("company") ? (
                  <fieldset className="grid gap-2 border-t border-(--surface-panel-border) pt-3">
                    <legend className="text-(length:--text-small) font-medium text-foreground">
                      Company feedback scope
                    </legend>
                    <label className="flex items-start gap-2 text-(length:--text-small) text-foreground-soft">
                      <input
                        checked={feedbackAction === "hide_job"}
                        disabled={isFeedbackPending}
                        name={`company-feedback-scope-${selectedJob.id}`}
                        onChange={() => setFeedbackAction("hide_job")}
                        type="radio"
                        value="hide_job"
                      />
                      <span>Hide this job only</span>
                    </label>
                    <label className="flex items-start gap-2 text-(length:--text-small) text-foreground-soft">
                      <input
                        checked={feedbackAction === "hide_and_exclude_employer"}
                        disabled={
                          isFeedbackPending ||
                          isEmployerExclusionPreviewPending ||
                          selectedJobEmployerExclusionPreview?.status !==
                            "available"
                        }
                        name={`company-feedback-scope-${selectedJob.id}`}
                        onChange={() =>
                          setFeedbackAction("hide_and_exclude_employer")
                        }
                        type="radio"
                        value="hide_and_exclude_employer"
                      />
                      <span>Hide and exclude employer</span>
                    </label>
                    {isEmployerExclusionPreviewPending ? (
                      <p
                        className="text-(length:--text-tiny) text-foreground-muted"
                        role="status"
                      >
                        Checking the exact employer identity…
                      </p>
                    ) : selectedJobEmployerExclusionPreview?.status ===
                      "available" ? (
                      <div className="grid gap-1 text-(length:--text-tiny) leading-5 text-foreground-muted">
                        <p>
                          Future searches will exclude the exact normalized
                          company name “
                          {
                            selectedJobEmployerExclusionPreview.normalizedCompanyName
                          }
                          ”. This does not widen to aliases, parents, suffix
                          variants, or domains.
                        </p>
                        {selectedJobEmployerExclusionPreview.employerDomain ? (
                          <p>
                            Domain evidence only:{" "}
                            {selectedJobEmployerExclusionPreview.employerDomain}
                            . It is not an exclusion key.
                          </p>
                        ) : null}
                        <p>Fit scoring is unchanged.</p>
                      </div>
                    ) : selectedJobEmployerExclusionPreview?.status ===
                      "unavailable" ? (
                      <p className="text-(length:--text-tiny) leading-5 text-foreground-muted">
                        Reusable employer exclusion is unavailable because this
                        identity is not safe and exact. You can still hide only
                        this job.
                      </p>
                    ) : employerExclusionPreviewError ? (
                      <p
                        className="text-(length:--text-tiny) leading-5 text-foreground-muted"
                        role="status"
                      >
                        {employerExclusionPreviewError}
                      </p>
                    ) : null}
                  </fieldset>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={isFeedbackPending}
                    onClick={() => {
                      void dismissSelectedJob(selectedJob.id);
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {isDismissPending
                      ? "Hiding job…"
                      : feedbackAction === "hide_and_exclude_employer"
                        ? "Hide and exclude employer"
                        : "Hide this job only"}
                  </Button>
                  <Button
                    disabled={isFeedbackPending}
                    onClick={closeFeedback}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </div>
                {dismissError ? (
                  <p
                    className="text-(length:--text-tiny) leading-5 text-destructive"
                    role="alert"
                  >
                    {dismissError}
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            {/* Opening the listing, a dismissal and a link copy are secondary
                work: they keep their natural width on one left-aligned row
                instead of stacked full-width bars under the primary decision,
                all in the one secondary style (the row used to mix filled,
                ghost and outlined buttons). The open and copy actions stay
                available while the feedback form is open. */}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {onAssessJobListing ? (
                <Button
                  disabled={isSelectedJobPending}
                  pending={isSelectedJobPending}
                  onClick={() => {
                    const jobId = selectedJob.id;
                    setAssessmentErrorJobId(null);
                    setAssessingJobId(jobId);
                    void onAssessJobListing(jobId)
                      .catch((error: unknown) => {
                        setAssessmentErrorJobId(jobId);
                        setAssessmentError(
                          describeListingReadFailure(error, {
                            listingUrl: selectedJob.canonicalUrl,
                          }),
                        );
                      })
                      .finally(() =>
                        setAssessingJobId((current) =>
                          current === jobId ? null : current,
                        ),
                      );
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {assessingJobId === selectedJob.id
                    ? "Reading the listing… about a minute"
                    : "Judge fit"}
                </Button>
              ) : null}
              {assessmentErrorJobId === selectedJob.id ? (
                <p
                  role="alert"
                  className="text-(length:--text-small) text-foreground-soft"
                >
                  {assessmentError ??
                    "Could not assess this listing. Try again."}
                </p>
              ) : null}
              {onOpenListing ? (
                <Button
                  data-testid="discovery-detail-open-listing"
                  onClick={() => onOpenListing(selectedJob.canonicalUrl)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Open listing
                </Button>
              ) : null}
              {feedbackJobId === selectedJob.id ? null : (
                <Button
                  disabled={isSelectedJobPending}
                  onClick={() => {
                    employerExclusionPreviewRequestRef.current += 1;
                    setFeedbackJobId(selectedJob.id);
                    setFeedbackReasons(triage ? ["company"] : []);
                    setFeedbackAction("hide_job");
                    setEmployerExclusionPreview(null);
                    setEmployerExclusionPreviewPending(false);
                    setEmployerExclusionPreviewError(null);
                    setDismissError(null);
                    if (triage) previewEmployerExclusion(selectedJob.id);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {/* The triage bar above already offers Not interested; the
                      second "Not interested because…" here read as a
                      different action. What only this form adds is leaving
                      the employer out of future searches. */}
                  {triage ? "Hide this employer…" : "Not interested"}
                </Button>
              )}
              <Button
                onClick={() => {
                  void window.nestor.jobFinder
                    .writeClipboardText(selectedJob.canonicalUrl)
                    .then(() => {
                      setCopiedListingJobId(selectedJob.id);
                      setListingCopyFailedJobId(null);
                    })
                    .catch(() => {
                      setCopiedListingJobId(null);
                      setListingCopyFailedJobId(selectedJob.id);
                    });
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                {copiedListingJobId === selectedJob.id
                  ? "Link copied"
                  : "Copy link"}
              </Button>
            </div>
            <p aria-live="polite" className="sr-only" role="status">
              {copiedListingJobId === selectedJob.id
                ? "Original listing link copied."
                : listingCopyFailedJobId === selectedJob.id
                  ? "The original listing link could not be copied. Copy the visible URL manually."
                  : ""}
            </p>
          </div>
        </>
      ) : (
        <EmptyState
          className="min-h-80"
          description="Pick a job from the list to see what it asks for, how it fits you, and shortlist it."
          title="Choose a job"
        />
      )}
    </section>
  );
}

export { discoveryFeedbackOptions, formatDiscoveryHideReason };
