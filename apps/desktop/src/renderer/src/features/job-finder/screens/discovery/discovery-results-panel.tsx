import { JOB_LIST_PAGE_SIZE } from "../../components/collection-pagination";
import { useListMoveMotion } from "@renderer/lib/motion";
import { PageNavigation } from "../../components/page-navigation";
import {
  DiscoveryResultFilters,
  type DiscoveryFilterGroup,
} from "./discovery-result-filters";
import {
  getDiscoverySourceRunCountLabel,
  formatDiscoveryRunReportLabel,
  getDiscoveryRunReportCounts,
} from "../../lib/discovery-run-count-label";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type {
  BrowserSessionState,
  DiscoveryRunRecord,
  FitJudgmentProgress,
  FitRecommendation,
  JobDiscoveryTarget,
  ListingActivity,
  WorkMode,
  WorkspaceJobListRow,
} from "@nestor/contracts";
import {
  describeInterruptedDiscoveryRun,
  fitRecommendationValues,
  getDiscoveryRunPhase,
  workModeValues,
} from "@nestor/contracts";
import { DiscoveryAssessmentContinuation } from "./discovery-assessment-continuation";
import { jobSourceLabel } from "../../lib/job-source-display-name";
import {
  applySelectionRange,
  isSelectionClick,
  ListPageCheckbox,
  ListRowSelectionCell,
} from "../../components/list-selection";
import { discoverySourceFailureCopy } from "./discovery-source-failure-copy";
import { ChevronDown, LoaderCircle, X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { SelectableRow } from "@renderer/components/ui";
import { EmptyState } from "@renderer/features/job-finder/components/empty-state";
import {
  jobFinderListRegionClassName,
  jobFinderListRowBadgeSlotClassName,
  jobFinderListRowClassName,
  jobFinderListRowLinesClassName,
  jobFinderListRowMetaClassName,
  jobFinderListRowStatusClassName,
  jobFinderListRowTitleClassName,
  jobFinderListRowTitleLineClassName,
} from "@renderer/features/job-finder/components/list-row";
import {
  CollectionNoMatches,
  CollectionSearchToolbar,
  normalizeCollectionSearch,
} from "@renderer/features/job-finder/components/collection-search-toolbar";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import { usePersistedCollectionView } from "@renderer/features/job-finder/hooks/use-persisted-collection-view";
import {
  focusCollectionItem,
  getAdjacentCollectionItemId,
} from "@renderer/features/job-finder/lib/collection-keyboard-navigation";
import { Link } from "react-router-dom";
import { JOB_FINDER_ROUTE_PATHS } from "@renderer/features/job-finder/lib/job-finder-route-hrefs";
import { formatJobEmployerLocationLine } from "@renderer/features/job-finder/lib/job-employer-location-display";
import { cn } from "@renderer/lib/cn";
import {
  formatTimestamp,
  formatStatusLabel,
  formatWorkModeLabel,
  getPostedDateLabel,
} from "@renderer/features/job-finder/lib/job-finder-utils";
import { fitRecommendationCopy } from "@renderer/features/job-finder/lib/match-assessment-presentation";
import {
  listingActivityStatuses,
  presentListingActivity,
} from "@renderer/features/job-finder/lib/listing-activity-presentation";
import {
  DISCOVERY_DETAIL_REGION_ID,
  focusDiscoveryDetailAfterKeyboardSelection,
  revealDiscoveryDetailAfterPointerSelection,
} from "./discovery-accessibility";
import {
  buildRunHeadedGroups,
  buildRunHeadings,
} from "./discovery-result-groups";
import {
  getDiscoveryRowView,
  isDiscoveryRowInPipeline,
} from "./discovery-row-view";
import {
  stabilizeFindJobsPage,
  type PageStability,
} from "./find-jobs-page-stability";
import {
  useFindJobsList,
  type FindJobsListRequest,
  type FindJobsPoolBands,
} from "./use-find-jobs-list";
// One name for that window, from the one module that owns it.
import { JOB_FINDER_BROWSER_NAME } from "@renderer/features/job-finder/lib/job-finder-browser-handoff-copy";
import {
  type DiscoveryResultsSortField,
  useDiscoveryResultsSort,
} from "./discovery-results-sort";
import { WORK_MODE_UNSPECIFIED_FILTER } from "./discovery-filter-values";
import { getDiscoveryListingRecencyKey } from "@nestor/job-finder/discovery-ordering";
import type { DiscoveryLatestRunVerdict } from "./discovery-run-feedback";
import { useAssistantContextSource } from "../../assistant/assistant-provider";
import { buildListContext } from "../../assistant/assistant-context-capture";
import {
  listingRowMenuEntries,
  openRowContextMenu,
  type RowMenuEntry,
} from "../../lib/row-context-menu";
import {
  isNewSinceVisit,
  useSinceLastVisit,
} from "../../hooks/use-since-last-visit";
import {
  DISCOVERY_OFFLINE_RUNTIME_LABEL,
  DISCOVERY_OFFLINE_SETUP_NOTICE,
  getDiscoveryRuntimeProjection,
} from "./discovery-search-readiness";

interface DiscoveryResultsPanelProps {
  hiddenJobsControl?: React.ReactNode;
  planName?: string | null;
  onJudgeUnjudgedJobs?: () => Promise<void>;
  fitJudgmentProgress?: FitJudgmentProgress | null;
  areAlsoFoundShown?: boolean;
  browserSession: BrowserSessionState;
  discoveryTargets?: readonly JobDiscoveryTarget[];
  emptyClassName?: string;
  // Active search plan/campaign identity from the discovery screen. Facet
  // snapshots are scoped by it so switching plans restores each plan's own
  // filters instead of leaking them across plans.
  facetScopeId?: string | null;
  hasCompletedSearch?: boolean;
  /** The open job the person just decided, kept in its place (ADR 0075). */
  heldJobId?: string | null;
  isSearchInProgress?: boolean;
  /** The plan whose jobs are listed; omitted means the active plan. */
  planId?: string | null;
  /** The selected job was opened by a link: it stays open when unlisted. */
  preserveSelectedJob?: boolean;
  /** The search in progress: its page keeps rows where they appeared. */
  searchRunId?: string | null;
  /**
   * What the running search is doing right now, in the agent's words: the
   * source it is on, its latest note and how long ago it said it. A search
   * takes minutes per source, so the page must never look idle meanwhile.
   */
  liveStatusLine?: string | null;
  preferredLocations?: readonly string[];
  remoteIncluded?: boolean;
  editPlanHref?: string | null;
  /**
   * The newest run record, read for its own phase. A run the app close cut
   * short kept everything it had already scored, and the screen used to
   * answer that with "Nothing was deleted" — technically true of the hidden
   * band it was written for, and read as a denial that 35 results had
   * vanished.
   */
  latestRun?:
    | (Pick<DiscoveryRunRecord, "runPhase" | "state" | "summary"> &
        Partial<
          Pick<
            DiscoveryRunRecord,
            "targetExecutions" | "activity" | "startedAt"
          >
        >)
    | null;
  latestRunVerdict?: DiscoveryLatestRunVerdict | null;
  /**
   * The run-failure callout above the results names the cause and the next
   * step (for example, a source address that leads to a missing page). The
   * empty state then defers to it instead of saying "Search now" beside it.
   */
  failureCalloutShown?: boolean;
  /** Starts a fresh search from where the interrupted one stopped. */
  onSearchAgain?: (() => void) | null;
  onRetrySource?: (sourceId: string) => void;
  onDisplayedSelectedJobIdChange?: (selectedJobId: string | null) => void;
  /**
   * The page on screen and the whole list's order (search, filters and sort
   * applied), for the inspector and a triage pass that moves to the next job.
   */
  onListChange?: (list: DiscoveryListSnapshot) => void;
  onRecoveryAction?: (() => void) | null;
  onShowAlsoFound?: (() => void) | null;
  onToggleAlsoFound?: (() => void) | null;
  onSelectJob: (jobId: string) => void;
  onShortlistJobs?: (jobIds: readonly string[]) => void | Promise<void>;
  /** Hides the selected jobs as Not interested. */
  onDismissJobs?: (jobIds: readonly string[]) => Promise<void>;
  recoveryActionLabel?: string | null;
  recoveryActionNextStep?: string | null;
  recoveryActionPending?: boolean;
  searchSetupBlocker?: {
    title: string;
    description: string;
    actionLabel?: string | null;
    actionHref?: string | null;
    nextStep?: string | null;
  } | null;
  /** Only its id is read: the job may be on another page or unlisted. */
  selectedJob: { id: string } | null;
}

/** A Find jobs row: list columns from the database, never a whole job. */
type DiscoveryResultJob = WorkspaceJobListRow;

export const DISCOVERY_RESULTS_PAGE_SIZE = JOB_LIST_PAGE_SIZE;
const NO_ROWS: readonly WorkspaceJobListRow[] = [];
const NO_IDS: readonly string[] = [];

export interface DiscoveryListSnapshot {
  /** The first reply has arrived. */
  ready: boolean;
  rows: readonly WorkspaceJobListRow[];
  orderedJobIds: readonly string[];
  /** The band of a listed job, in any order the list is sorted by. */
  groupOf: (jobId: string) => WorkspaceJobListRow["resultGroup"] | undefined;
  /** Every job in the plan, decided or not. */
  planJobCount: number;
  pool: FindJobsPoolBands | null;
  detailRevision: (jobId: string) => string;
}
export const DISCOVERY_OFFLINE_CATALOG_NOTICE_ID =
  "discovery-offline-catalog-notice";
export const DISCOVERY_SEARCH_SETUP_BLOCKER_ID =
  "discovery-search-setup-blocker";

// Each option carries its own direction ("Newest first", "A–Z"), so the
// separate flip control that used to sit beside the select is gone: "Best
// match, lowest first" was never a view anyone wanted.
const DISCOVERY_RESULTS_SORT_OPTIONS = [
  { field: "fit", label: "Best match" },
  { field: "recent", label: "Newest first" },
  { field: "company", label: "Company A–Z" },
] as const satisfies readonly {
  readonly field: DiscoveryResultsSortField;
  readonly label: string;
}[];

/**
 * One box metric for every control on the results toolbar row (Filters
 * disclosure, sort field). They used to disagree on height, radius and
 * weight, so a row of sibling controls read as unrelated boxes. Border colour
 * is deliberately not folded in here: the sort field keeps the editable-field
 * trio it shares with the search input above, while the Filters disclosure
 * carries the interactive `--control-border`. Pinned by
 * `discovery-results-panel.toolbar-metrics.test.tsx`.
 */
export const DISCOVERY_RESULTS_TOOLBAR_CONTROL_CLASS =
  "h-8 rounded-(--radius-button) text-xs font-medium";

// Facet selections survive route remounts per active search plan in one
// bounded, versioned local snapshot following the results-sort persistence
// convention. The storage key stays constant; each plan's last-used facets
// live in a capped most-recently-used scope list inside the payload, so
// storage can never grow with plan count and plans never see each other's
// filters.
const FACET_FILTERS_STORAGE_KEY =
  "nestor.job-finder.discovery.result-filters.v2";
// Legacy unscoped snapshot from before plan scoping existed. Read once as
// the migrating value for whichever plan is active, then removed after the
// first successful scoped write.
const LEGACY_FACET_FILTERS_STORAGE_KEY =
  "nestor.job-finder.discovery.result-filters.v1";
const FACET_SCOPE_FALLBACK = "default";
const MAX_FACET_SCOPES = 8;
const MAX_PERSISTED_FACET_VALUES = 24;
const MAX_PERSISTED_FACET_VALUE_LENGTH = 200;

interface PersistedDiscoveryFacetFilters {
  readonly activity: readonly string[];
  readonly recommendation: readonly string[];
  readonly source: readonly string[];
  readonly workMode: readonly string[];
}

interface PersistedFacetScope extends PersistedDiscoveryFacetFilters {
  readonly id: string;
}

const EMPTY_PERSISTED_FACET_FILTERS: PersistedDiscoveryFacetFilters = {
  activity: [],
  recommendation: [],
  source: [],
  workMode: [],
};

// Static validity domains: a stored value outside its facet's known value
// space is discarded at read time instead of silently hiding every result.
const ACTIVITY_FILTER_DOMAIN = new Set<string>(listingActivityStatuses);
const RECOMMENDATION_FILTER_DOMAIN = new Set<string>(fitRecommendationValues);
const WORK_MODE_FILTER_DOMAIN = new Set<string>([
  WORK_MODE_UNSPECIFIED_FILTER,
  ...workModeValues,
]);

function normalizeFacetScopeKey(
  facetScopeId: string | null | undefined,
): string {
  const trimmed = (facetScopeId ?? "").trim().slice(0, 120);
  return trimmed.length > 0 ? trimmed : FACET_SCOPE_FALLBACK;
}

function readBoundedFacetValues(
  value: unknown,
  validDomain?: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.slice(0, MAX_PERSISTED_FACET_VALUE_LENGTH))
    .filter((entry) => !validDomain || validDomain.has(entry))
    .slice(0, MAX_PERSISTED_FACET_VALUES);
}

/**
 * Validates any stored facet payload (legacy global snapshot or a scoped
 * entry) into the four bounded facet lists. Source labels depend on the
 * loaded result set, so they get no static domain here; they are validated
 * dynamically against the visible options after render instead.
 */
function parseFacetPayload(
  value: unknown,
): PersistedDiscoveryFacetFilters | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  return {
    activity: readBoundedFacetValues(
      candidate.activity,
      ACTIVITY_FILTER_DOMAIN,
    ),
    recommendation: readBoundedFacetValues(
      candidate.recommendation,
      RECOMMENDATION_FILTER_DOMAIN,
    ),
    source: readBoundedFacetValues(candidate.source),
    workMode: readBoundedFacetValues(
      candidate.workMode,
      WORK_MODE_FILTER_DOMAIN,
    ),
  };
}

function parsePersistedFacetScopes(
  raw: string,
): readonly PersistedFacetScope[] {
  const parsed = JSON.parse(raw) as { scopes?: unknown };
  if (!Array.isArray(parsed.scopes)) return [];
  return parsed.scopes
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.id !== "string") return [];
      const facets = parseFacetPayload(entry);
      if (!facets) return [];
      return [{ ...facets, id: candidate.id.slice(0, 120) } as const];
    })
    .slice(0, MAX_FACET_SCOPES);
}

function readScopedFacetFilters(
  scopeKey: string,
): PersistedDiscoveryFacetFilters {
  try {
    const raw = window.localStorage.getItem(FACET_FILTERS_STORAGE_KEY);
    if (raw) {
      const match = parsePersistedFacetScopes(raw).find(
        (scope) => scope.id === scopeKey,
      );
      return match
        ? {
            activity: match.activity,
            recommendation: match.recommendation,
            source: match.source,
            workMode: match.workMode,
          }
        : EMPTY_PERSISTED_FACET_FILTERS;
    }
    // One-time migration: the legacy global snapshot belonged to whatever
    // plan is active right now; every other plan starts clean instead of
    // inheriting cross-plan filters.
    const legacyRaw = window.localStorage.getItem(
      LEGACY_FACET_FILTERS_STORAGE_KEY,
    );
    if (legacyRaw) {
      return (
        parseFacetPayload(JSON.parse(legacyRaw)) ??
        EMPTY_PERSISTED_FACET_FILTERS
      );
    }
  } catch {
    // Unreadable snapshots fall back to unfiltered results.
  }
  return EMPTY_PERSISTED_FACET_FILTERS;
}

/** Whether Find jobs reopens filtered for this plan. */
export function hasPersistedDiscoveryFacetFilters(
  facetScopeId: string | null | undefined,
): boolean {
  const filters = readScopedFacetFilters(normalizeFacetScopeKey(facetScopeId));
  return (
    filters.activity.length +
      filters.recommendation.length +
      filters.source.length +
      filters.workMode.length >
    0
  );
}

function writeScopedFacetFilters(
  scopeKey: string,
  filters: PersistedDiscoveryFacetFilters,
): void {
  const bound = (values: readonly string[]) =>
    values
      .slice(0, MAX_PERSISTED_FACET_VALUES)
      .map((value) => value.slice(0, MAX_PERSISTED_FACET_VALUE_LENGTH));
  try {
    const raw = window.localStorage.getItem(FACET_FILTERS_STORAGE_KEY);
    const previous = raw ? parsePersistedFacetScopes(raw) : [];
    const entry: PersistedFacetScope = {
      activity: bound(filters.activity),
      id: scopeKey,
      recommendation: bound(filters.recommendation),
      source: bound(filters.source),
      workMode: bound(filters.workMode),
    };
    const scopes = [
      entry,
      ...previous.filter((scope) => scope.id !== scopeKey),
    ].slice(0, MAX_FACET_SCOPES);
    window.localStorage.setItem(
      FACET_FILTERS_STORAGE_KEY,
      JSON.stringify({ version: 2, scopes }),
    );
    // The scoped snapshot supersedes the legacy global one.
    window.localStorage.removeItem(LEGACY_FACET_FILTERS_STORAGE_KEY);
  } catch {
    // Filters still work when durable renderer preferences are unavailable.
  }
}

/**
 * Drops selected values that no longer appear among the visible options, so a
 * restored (or surviving) selection can never reference a value no current
 * result offers and silently blank the list. Returns the original reference
 * when nothing changed to avoid needless re-renders and storage churn. The
 * options come from the unfiltered scoped job collection, so another active
 * facet temporarily hiding every row that offers a value never erases it.
 */
function pruneFilterSelection(
  current: ReadonlySet<string>,
  presentOptions: ReadonlySet<string>,
): ReadonlySet<string> {
  if (current.size === 0) return current;
  const kept = [...current].filter((value) => presentOptions.has(value));
  // Same size means nothing was dropped: returning the original reference
  // keeps the pruning effect from re-rendering (Sets have no .length).
  return kept.length === current.size ? current : new Set(kept);
}

function toggleFilterValue(
  values: ReadonlySet<string>,
  value: string,
): Set<string> {
  const next = new Set(values);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

/**
 * Truthful streaming-progress count: reports what is actually visible after
 * the user's persisted search query and filters, never the raw saved total.
 */
export function getDiscoveryProgressCountLabel(
  visibleCount: number,
  totalCount: number,
): string {
  const noun = totalCount === 1 ? "listing" : "listings";
  return visibleCount === totalCount
    ? `${totalCount} ${noun} found.`
    : `${visibleCount} of ${totalCount} ${noun} shown.`;
}

/**
 * Truthful listing-date badge for a results row, kept consistent with the
 * shared recency key: when the only posting evidence is a relative source
 * label ("2 days ago"), the badge keeps the provider's wording and reports
 * `rankable: false` so the row can explain (in its tooltip) that Newest
 * cannot rank it by a posting date it cannot derive. The badge text itself
 * stays the plain label; "not date-ranked" on every such row was a sorting
 * footnote printed where a person reads what the job is.
 */
export function getDiscoveryListingDateBadge(input: {
  postedAt: string | null;
  postedAtText: string | null;
  providerUpdatedAt: string | null;
}): { rankable: boolean; shown: boolean; text: string } {
  const listingDate = getPostedDateLabel(input);

  // Nothing datable on the listing: the row shows no date badge at all rather
  // than "Updated Unknown" or whatever token sat in the board's posted slot.
  if (!listingDate) {
    return { rankable: false, shown: false, text: "" };
  }

  const recency = getDiscoveryListingRecencyKey(input);

  return {
    rankable: recency.basis !== null,
    shown: true,
    text: `${listingDate.label} ${listingDate.value}`,
  };
}

const DISMISSED_SESSION_NOTICES_KEY =
  "nestor.discovery.dismissed-session-notices";

function readDismissedSessionNotices(): string[] {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(DISMISSED_SESSION_NOTICES_KEY) ?? "[]",
    );
    return Array.isArray(stored)
      ? stored.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * A browser sign-in the next search needs, said in one quiet line above
 * results the person is reading (ADR 0051). It was a large amber alert in
 * the middle of the list; the results are fine, so it is a note with the
 * one action, and it stays hidden once dismissed.
 */
function SessionRecoveryLine(props: {
  description: string;
  onRecoveryAction?: (() => void) | null;
  recoveryActionLabel?: string | null;
  recoveryActionPending?: boolean;
}) {
  const dismissKey = props.recoveryActionLabel ?? props.description;
  const [dismissed, setDismissed] = useState(() =>
    readDismissedSessionNotices().includes(dismissKey),
  );
  if (dismissed) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-(length:--text-small) leading-6 text-foreground-soft"
      data-testid="discovery-session-recovery-line"
      role="status"
    >
      <span className="min-w-0">{props.description}</span>
      {props.recoveryActionLabel && props.onRecoveryAction ? (
        <Button
          className="h-auto px-0 py-0 underline underline-offset-2"
          onClick={props.onRecoveryAction}
          pending={props.recoveryActionPending === true}
          size="sm"
          type="button"
          variant="ghost"
        >
          {props.recoveryActionLabel}
        </Button>
      ) : null}
      <Button
        aria-label="Dismiss this note"
        className="ml-auto size-6 rounded-full p-0"
        onClick={() => {
          setDismissed(true);
          try {
            window.localStorage.setItem(
              DISMISSED_SESSION_NOTICES_KEY,
              JSON.stringify(
                [
                  ...readDismissedSessionNotices().filter(
                    (entry) => entry !== dismissKey,
                  ),
                  dismissKey,
                ].slice(-50),
              ),
            );
          } catch {
            /* Dismissal still holds for this visit. */
          }
        }}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <X aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}

export function ResultsEmptyState(props: {
  actionHref?: string | null;
  className?: string;
  description: string;
  onRecoveryAction?: (() => void) | null;
  recoveryActionLabel?: string | null;
  recoveryActionNextStep?: string | null;
  recoveryActionPending?: boolean;
  title: string;
}) {
  const emptyStateProps = props.className ? { className: props.className } : {};
  const recoveryActionProps = props.onRecoveryAction
    ? { onClick: props.onRecoveryAction }
    : {};
  const recoveryPendingProps = props.recoveryActionPending
    ? { pending: true }
    : {};
  const actionButton = props.recoveryActionLabel ? (
    props.actionHref ? (
      <Button asChild size="sm" type="button" variant="primary">
        <Link to={props.actionHref}>{props.recoveryActionLabel}</Link>
      </Button>
    ) : (
      <Button
        size="sm"
        type="button"
        variant="primary"
        {...recoveryActionProps}
        {...recoveryPendingProps}
      >
        {props.recoveryActionLabel}
      </Button>
    )
  ) : null;

  return (
    <div className="grid gap-4">
      <EmptyState
        description={props.description}
        title={props.title}
        {...emptyStateProps}
      />
      {props.recoveryActionLabel ? (
        <div className="grid gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-4 text-left text-(length:--text-description) text-foreground">
          <div className="grid gap-1">
            <p className="font-medium">Next step</p>
            <p className="leading-6">
              {props.recoveryActionNextStep ??
                `Open ${JOB_FINDER_BROWSER_NAME}, then search again.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">{actionButton}</div>
        </div>
      ) : null}
    </div>
  );
}

/** What a Find jobs row does, read through a ref so a row re-renders only
 * when what it shows changes, not on every render of the panel. */
interface DiscoveryResultRowActions {
  acknowledgeRescore: (jobId: string) => void;
  handleListKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    jobId: string,
  ) => void;
  openRowMenu: (event: MouseEvent, job: DiscoveryResultJob) => void;
  selectJob: (jobId: string) => void;
  toggleJobSelection: (jobId: string, shiftKey: boolean) => void;
}

/**
 * One Find jobs result. Its own component so a shortlist, a hide or the
 * next job's detail loading re-renders the rows that changed, not all 50:
 * built inline, every panel render rebuilt every row (about 600 components).
 */
const DiscoveryResultRow = memo(function DiscoveryResultRow(props: {
  actions: { readonly current: DiscoveryResultRowActions };
  buttonClassName: string;
  checked: boolean;
  headedGroup: string | undefined;
  isNew: boolean;
  job: DiscoveryResultJob;
  rescoreAcknowledged: boolean;
  selectable: boolean;
  selected: boolean;
  showSelection: boolean;
}) {
  const { job } = props;
  const isSelected = props.selected;
  const recommendation =
    fitRecommendationCopy[job.recommendation ?? "review_before_applying"];
  const rowView = getDiscoveryRowView(job);
  const assessment = rowView.fit;
  // A title-only row sitting under the rendered "Title matches ·
  // not yet checked" divider would otherwise repeat that exact
  // claim twice more — "Title match only" plus a two-line
  // caption — on every row of a band that can be the whole list.
  // The divider states it once for the run; the row drops the
  // visible restatement and keeps an assistive-technology line,
  // because a row button is reachable by keyboard without ever
  // reading the divider. Provisional rows share this band but
  // not its claim, so they keep their own verdict, and a
  // title-only row banded as a mismatch keeps it too: no divider
  // above it says the title was all that was read.
  const isCoveredByUncheckedBand =
    assessment.isNotJudged &&
    // An unbound assessment is title-only by evidence depth but
    // presents as "Fit not assessed", which is a different claim
    // from the one the divider makes; it keeps its own verdict.
    !assessment.isProvisional &&
    props.headedGroup === "unchecked";
  // One sentence on the row saying why: what is missing when the
  // score is withheld, otherwise the hard-conflict reason. Rows
  // whose score stands on its own evidence stay quiet.
  const rowReason = rowView.reason;
  // Rows that share a printed percentage keep the one fact
  // behind their place as the score's tooltip. Printed under
  // every row it said "Job title matches one of your target
  // roles." down most of a 6,000-job list.
  const tieBreakReason = rowView.tieBreakReason;
  const listingDateBadge = getDiscoveryListingDateBadge({
    postedAt: job.postedAt ?? null,
    postedAtText: job.postedAtText ?? null,
    providerUpdatedAt: job.providerUpdatedAt ?? null,
  });
  const listingDateExplanation = listingDateBadge.shown
    ? listingDateBadge.rankable
      ? undefined
      : "The source shows a posting label without a full date, so Newest cannot rank this listing by its posting date."
    : undefined;
  const sourceLabels = job.sourceLabels;
  const sourceText =
    sourceLabels.length > 0 ? sourceLabels.join(", ") : "Source unavailable";
  // A careers-site source repeats the employer's own name; the
  // meta line then read "Canonical • Remote · Canonical".
  const sourceRepeatsEmployer =
    sourceLabels.length === 1 &&
    Boolean(job.company) &&
    sourceLabels[0]?.trim().toLowerCase() === job.company?.trim().toLowerCase();
  const listingActivity = job.listingActivity;
  const activity = presentListingActivity(listingActivity);
  const activityDescription =
    listingActivity.status === "inactive"
      ? `Not found in a source inventory observation on ${activity.observedDate}. This does not prove the listing is closed. ${listingActivity.explanation}`
      : activity.description;

  const wasRescoredAfterRead =
    !props.rescoreAcknowledged && Boolean(job.rescoredAfterListingRead);

  return (
    <li className="relative min-w-0 pl-10">
      {props.showSelection ? (
        props.selectable ? (
          <ListRowSelectionCell
            checked={props.checked}
            label={`Select ${job.title}`}
            onToggle={({ shiftKey }) =>
              props.actions.current.toggleJobSelection(job.id, shiftKey)
            }
          />
        ) : (
          // Jobs already in Shortlisted keep the checkbox
          // column filled, so the list reads as one grid.
          <ListRowSelectionCell
            checked={false}
            disabled
            label={`${job.title} is already in Shortlisted`}
            onToggle={() => undefined}
          />
        )
      ) : null}
      <SelectableRow
        aria-controls={DISCOVERY_DETAIL_REGION_ID}
        data-job-result-id={job.id}
        className={props.buttonClassName}
        aria-keyshortcuts="ArrowUp ArrowDown Home End"
        data-collection-item-id={job.id}
        onContextMenu={(event) => props.actions.current.openRowMenu(event, job)}
        onClick={(event) => {
          if (
            props.showSelection &&
            isSelectionClick(event) &&
            props.selectable
          ) {
            event.preventDefault();
            props.actions.current.toggleJobSelection(job.id, event.shiftKey);
            return;
          }
          if (wasRescoredAfterRead) {
            props.actions.current.acknowledgeRescore(job.id);
          }
          props.actions.current.selectJob(job.id);
          if (event.detail === 0) {
            focusDiscoveryDetailAfterKeyboardSelection();
          } else {
            revealDiscoveryDetailAfterPointerSelection();
          }
        }}
        onKeyDown={(event) =>
          props.actions.current.handleListKeyDown(event, job.id)
        }
        selected={isSelected}
      >
        {/* One shared line rhythm for all three lists: title line (with
          the one trailing badge slot), then meta, then status. */}
        <div className={jobFinderListRowLinesClassName}>
          <div className={jobFinderListRowTitleLineClassName}>
            <strong
              className={jobFinderListRowTitleClassName}
              title={job.title}
            >
              {props.isNew ? (
                <span
                  className="mr-1.5 inline-block size-2 rounded-full bg-(--info-text) align-middle"
                  data-new-since-visit
                  title="New since your last visit"
                >
                  <span className="sr-only">New: </span>
                </span>
              ) : null}
              {job.title}
            </strong>
            {/* One slot, one verdict: the fit and, when it is
              not the default, its badge. Shortlisted, the
              posting date and a listing that went quiet are
              plain facts on the meta line below; three
              stacked badges used to squeeze the title into a
              narrow column three lines tall. */}
            <div className={jobFinderListRowBadgeSlotClassName}>
              {isCoveredByUncheckedBand ? null : (
                <span
                  aria-label={assessment.headlineScoreAriaLabel}
                  className={cn(
                    "text-(length:--text-small) font-semibold tabular-nums",
                    assessment.isScoreWithheld
                      ? "text-foreground-soft"
                      : "text-(--text-headline)",
                  )}
                  data-testid={`discovery-result-fit-${job.id}`}
                  {...(tieBreakReason ? { title: tieBreakReason } : {})}
                >
                  {assessment.headlineScoreLabel}
                </span>
              )}
              {/* The default "review before applying" verdict is the
                baseline for every row, so only a stronger or
                weaker verdict earns a badge in the list; the
                inspector keeps the full assessment. */}
              {!assessment.isScoreWithheld &&
              job.recommendation !== "review_before_applying" ? (
                <StatusBadge
                  tone={
                    assessment.isProvisional ? "neutral" : recommendation.tone
                  }
                >
                  {recommendation.label}
                </StatusBadge>
              ) : null}
            </div>
          </div>
          {(() => {
            const employerLocationLine = formatJobEmployerLocationLine({
              company: job.company,
              location: job.location,
              canonicalUrl: job.canonicalUrl,
              separator: " • ",
            });
            const pipelineLabel = [
              "drafting",
              "ready_for_review",
              "approved",
              "submitted",
            ].includes(job.status)
              ? job.status === "submitted"
                ? formatStatusLabel(job.status)
                : "Shortlisted"
              : null;
            // One meta line: employer and location, the
            // source it was found on, then the plain facts
            // (posting date, a listing that went quiet,
            // Shortlisted). A source on its own line read as
            // a second, unexplained company name. Exactly one
            // accessible source mention per row: the visible
            // separator is decorative and the sr-only prefix
            // completes the sentence.
            return (
              <span
                className={cn(
                  jobFinderListRowMetaClassName,
                  "flex min-w-0 flex-nowrap items-baseline gap-x-1.5",
                )}
                {...(employerLocationLine
                  ? {}
                  : {
                      "data-testid": `discovery-result-source-${job.id}`,
                      title: `Employer not listed · ${sourceText}`,
                    })}
              >
                <span
                  className={cn(
                    "min-w-0 truncate",
                    employerLocationLine ? "font-medium" : "shrink-0",
                  )}
                  data-testid={`discovery-result-employer-${job.id}`}
                  title={employerLocationLine || undefined}
                >
                  {employerLocationLine || "Employer not listed"}
                  {job.indistinguishable
                    ? ` · Reference ${job.sourceJobId}`
                    : ""}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "shrink-0",
                    sourceRepeatsEmployer && employerLocationLine && "sr-only",
                  )}
                >
                  {" · "}
                </span>
                <span
                  className={cn(
                    "flex min-w-0 max-w-[45%] shrink-0",
                    sourceRepeatsEmployer && employerLocationLine && "sr-only",
                  )}
                  {...(employerLocationLine
                    ? {
                        "data-testid": `discovery-result-source-${job.id}`,
                        title: `Found on ${sourceText}`,
                      }
                    : {})}
                >
                  <span className="sr-only">Found on </span>
                  <span className="min-w-0 truncate">{sourceText}</span>
                </span>
                {listingDateBadge.shown ? (
                  <span className="shrink-0 whitespace-nowrap text-foreground-muted">
                    <span aria-hidden="true">{"· "}</span>
                    <span
                      data-testid={`discovery-result-date-${job.id}`}
                      {...(listingDateExplanation
                        ? { title: listingDateExplanation }
                        : {})}
                    >
                      {listingDateBadge.text}
                    </span>
                  </span>
                ) : null}
                {listingActivity.status !== "active" ? (
                  <span
                    aria-label={`${activity.label} listing status${activity.observedDate ? ` observed ${activity.observedDate}` : ""}. ${activityDescription}`}
                    className="shrink-0 whitespace-nowrap text-(--warning-text)"
                    title={activityDescription}
                  >
                    <span aria-hidden="true">{"· "}</span>
                    <span aria-hidden="true">
                      {activity.label}
                      {activity.observedDate
                        ? ` · ${activity.observedDate}`
                        : ""}
                    </span>
                  </span>
                ) : (
                  <span className="sr-only">
                    {`${activity.label} listing status${activity.observedDate ? ` observed ${activity.observedDate}` : ""}. ${activityDescription}`}
                  </span>
                )}
                {pipelineLabel ? (
                  <span
                    className="shrink-0 whitespace-nowrap font-medium text-primary"
                    data-testid={`discovery-result-pipeline-${job.id}`}
                  >
                    <span aria-hidden="true">{"· "}</span>
                    {pipelineLabel}
                  </span>
                ) : null}
              </span>
            );
          })()}

          {/* The fit verdict sits on the title line beside its
          badge (see the badge slot above). The reason behind
          it is a comfortable-density line only; compact rows
          stay two lines. When the evidence behind the number
          is only the listing title the number is withheld and
          kept inside "How this was scored" with its evidence. */}
          {isCoveredByUncheckedBand ? (
            <span
              className="sr-only"
              data-testid={`discovery-result-fit-sr-${job.id}`}
            >
              {rowReason
                ? `${assessment.headlineScoreAriaLabel}. ${rowReason}`
                : assessment.headlineScoreAriaLabel}
            </span>
          ) : (
            // Every row keeps the reason line, empty or not,
            // so rows are one height down the list.
            <span
              className={cn(
                jobFinderListRowStatusClassName,
                "min-h-[1lh] text-foreground-soft",
              )}
              {...(rowReason
                ? {
                    "data-testid": `discovery-result-fit-reason-${job.id}`,
                  }
                : {})}
            >
              {rowReason}
            </span>
          )}
          {wasRescoredAfterRead ? (
            <span className="text-(length:--text-tiny) text-foreground-soft">
              Rescored after reading the listing
            </span>
          ) : null}
        </div>

        {/* Below xl the inspector stacks under this list, so a
          highlighted row is the only sign that anything more
          exists — and it sits past the fold. This names the
          pane by its own visible heading; it does not promise
          listing detail the app may not have read.

          Rendered on every row so the slot is reserved and
          selection can never reflow the list (see
          SelectableRow), and revealed on the selected row
          through this element's OWN `data-details-cue`.

          That attribute, rather than a `group-data-*` variant
          keyed on the row's selected state, is deliberate. The
          group form left both rows carrying byte-identical
          class strings, so whether the cue actually painted
          depended entirely on a stylesheet the renderer tests
          never load: a DOM query passed while every row showed
          the cue on screen. State that decides what is painted
          has to be observable in the DOM, so both the shown
          and the hidden case can be pinned.

          Decorative: the row already exposes the detail region
          through `aria-controls`, so this is not announced a
          second time. Nothing here scrolls — the default
          selection is not a user action, and only an explicit
          click reveals the detail region. */}
        <span
          aria-hidden="true"
          className="invisible flex items-center gap-1 text-(length:--text-tiny) font-medium text-foreground-soft data-[details-cue=visible]:visible xl:hidden"
          data-details-cue={isSelected ? "visible" : "hidden"}
          data-testid={`discovery-result-details-below-${job.id}`}
        >
          <ChevronDown aria-hidden="true" className="size-3.5" />
          Job details below
        </span>
      </SelectableRow>
    </li>
  );
});

export function DiscoveryResultsPanel({
  hiddenJobsControl,
  planName = null,
  onJudgeUnjudgedJobs,
  fitJudgmentProgress,
  areAlsoFoundShown = false,
  browserSession,
  discoveryTargets = [],
  emptyClassName,
  facetScopeId = null,
  hasCompletedSearch = false,
  heldJobId = null,
  isSearchInProgress = false,
  liveStatusLine = null,
  planId = null,
  preserveSelectedJob = false,
  searchRunId = null,
  preferredLocations = [],
  remoteIncluded = false,
  editPlanHref = null,
  latestRun = null,
  latestRunVerdict = null,
  failureCalloutShown = false,
  onSearchAgain = null,
  onRetrySource,
  onDisplayedSelectedJobIdChange,
  onListChange,
  onRecoveryAction,
  onShowAlsoFound,
  onToggleAlsoFound,
  onSelectJob,
  onShortlistJobs,
  onDismissJobs,
  recoveryActionLabel,
  recoveryActionNextStep,
  recoveryActionPending = false,
  searchSetupBlocker = null,
  selectedJob,
}: DiscoveryResultsPanelProps) {
  const resultsScrollRegionRef = useRef<HTMLDivElement | null>(null);
  const runtimeProjection = getDiscoveryRuntimeProjection(browserSession);
  const isOfflineRuntime = runtimeProjection.isOffline;
  // One row shape. The compact/comfortable switch was a second decision on a
  // page whose only real decision is which jobs to shortlist.
  const view = usePersistedCollectionView("discovery-results", "comfortable");
  const deferredQuery = useDeferredValue(view.query);
  // One bounded snapshot read per mount feeds every facet's initial value;
  // route remounts re-read it, which is what makes selections survive
  // navigation and restarts. The scope key keeps each search plan's filters
  // separate.
  const facetScopeKey = normalizeFacetScopeKey(facetScopeId);
  // The per-source list is built only while it is open: with hundreds of
  // sources it cost about 400 ms on every page change while folded away.
  const [sourceSummariesOpen, setSourceSummariesOpen] = useState(false);
  const [persistedFacetFilters] = useState(() =>
    readScopedFacetFilters(facetScopeKey),
  );
  const [recommendationFilters, setRecommendationFilters] = useState<
    ReadonlySet<string>
  >(() => new Set(persistedFacetFilters.recommendation));
  const [sourceFilters, setSourceFilters] = useState<ReadonlySet<string>>(
    () => new Set(persistedFacetFilters.source),
  );
  const [workModeFilters, setWorkModeFilters] = useState<ReadonlySet<string>>(
    () => new Set(persistedFacetFilters.workMode),
  );
  const [activityFilters, setActivityFilters] = useState<ReadonlySet<string>>(
    () => new Set(persistedFacetFilters.activity),
  );
  const resultsSort = useDiscoveryResultsSort();
  const sortDirection = resultsSort.sort.direction;
  const sortField = resultsSort.sort.field;
  const normalizedQuery = normalizeCollectionSearch(deferredQuery);
  // Jobs first seen since the person last left Find jobs: a dot on the row
  // and one press to see only them. The rows passed are last render's page.
  const visitRowsRef = useRef<readonly WorkspaceJobListRow[]>(NO_ROWS);
  const previousVisitEnd = useSinceLastVisit("discovery", visitRowsRef.current);
  const [newOnlyRequested, setNewOnly] = useState(false);
  const selectedJobId = selectedJob?.id ?? null;
  const [pagination, setPagination] = useState<{
    page: number;
    /** The selection whose page the list has already moved to. */
    selectedJobId: string | null | undefined;
  }>(() => ({ page: 0, selectedJobId: undefined }));
  const [isPagePending, startPageTransition] = useTransition();
  // What the list shows, asked of the database (ADR 0075): the filters,
  // search, order and page are the request; facets, counts and the rows on
  // this page come back with it.
  const listRequest = useMemo<FindJobsListRequest>(() => {
    const workModes = [...workModeFilters].filter(
      (mode) => mode !== WORK_MODE_UNSPECIFIED_FILTER,
    ) as WorkMode[];
    return {
      filters: {
        ...(planId ? { planId } : {}),
        ...(areAlsoFoundShown
          ? { discoveryBands: ["matches", "unchecked", "weaker", "mismatches"] }
          : {}),
        ...(recommendationFilters.size
          ? {
              recommendations: [
                ...recommendationFilters,
              ] as FitRecommendation[],
            }
          : {}),
        ...(sourceFilters.size ? { sourceLabels: [...sourceFilters] } : {}),
        ...(workModes.length ? { workModes } : {}),
        ...(workModeFilters.has(WORK_MODE_UNSPECIFIED_FILTER)
          ? { workModeUnspecified: true }
          : {}),
        ...(activityFilters.size
          ? {
              activities: [...activityFilters] as ListingActivity["status"][],
            }
          : {}),
        ...(previousVisitEnd ? { newSince: previousVisitEnd } : {}),
        ...(newOnlyRequested && previousVisitEnd ? { newOnly: true } : {}),
      },
      sort:
        sortField === "recent"
          ? "newest"
          : sortField === "company"
            ? "company"
            : "best_match",
      search: normalizedQuery.slice(0, 500),
      page: {
        offset: pagination.page * DISCOVERY_RESULTS_PAGE_SIZE,
        limit: DISCOVERY_RESULTS_PAGE_SIZE,
      },
    };
  }, [
    activityFilters,
    areAlsoFoundShown,
    newOnlyRequested,
    normalizedQuery,
    pagination.page,
    planId,
    previousVisitEnd,
    recommendationFilters,
    sortField,
    sourceFilters,
    workModeFilters,
  ]);
  const listRequestKey = JSON.stringify(listRequest);
  const list = useFindJobsList(listRequest, listRequestKey, {
    searchRunning: isSearchInProgress,
  });
  const listResult = list.result;
  const orderedJobIds = listResult?.ids ?? NO_IDS;
  const listIdSet = useMemo(() => new Set(orderedJobIds), [orderedJobIds]);
  const facets = listResult?.facets ?? null;
  // Like every other facet, the listing statuses are only the ones the
  // current results carry: five checkboxes for a list where every row is
  // "Unknown" filter nothing.
  const recommendationOptions = useMemo(
    () => (facets?.recommendations ?? []).map((option) => option.value),
    [facets],
  );
  const sourceOptions = useMemo(
    () => (facets?.sources ?? []).map((option) => option.value),
    [facets],
  );
  const workModeOptions = useMemo(
    () => (facets?.workModes ?? []).map((option) => option.value),
    [facets],
  );
  const activityOptions = useMemo(
    () => (facets?.activities ?? []).map((option) => option.value),
    [facets],
  );
  // The jobs on this list before the panel's own filters and search.
  const poolCount = (facets?.recommendations ?? []).reduce(
    (total, option) => total + option.count,
    0,
  );
  const poolBands = list.pool;
  const alsoFoundCount = poolBands
    ? poolBands.weaker + poolBands.mismatches
    : 0;
  const hiddenAlsoFoundCount = areAlsoFoundShown ? 0 : alsoFoundCount;
  // A facet with one value cannot narrow anything, so it is not offered.
  const filterGroups = {
    activity: activityOptions.length > 1,
    recommendation: recommendationOptions.length > 1,
    source: sourceOptions.length > 1,
    workMode: workModeOptions.length > 1,
  };
  const hasFilterGroups = Object.values(filterGroups).some(Boolean);
  // Restored selections stay active only while they name an option still
  // present in the current result set ("restore only what is still valid").
  // An empty result set defines no scope, so pruning waits until results
  // exist rather than wiping restored selections during transient loads.
  // Options derive from the unfiltered scoped collection, and re-running on
  // facet changes heals values restored by a plan switch or named view; the
  // same-reference no-op keeps this from looping.
  useEffect(() => {
    if (poolCount === 0) return;
    const recommendationScope = new Set(recommendationOptions);
    const sourceScope = new Set(sourceOptions);
    const workModeScope = new Set(workModeOptions);
    setRecommendationFilters((current) =>
      pruneFilterSelection(current, recommendationScope),
    );
    setSourceFilters((current) => pruneFilterSelection(current, sourceScope));
    setWorkModeFilters((current) =>
      pruneFilterSelection(current, workModeScope),
    );
    const activityScope = new Set<string>(activityOptions);
    setActivityFilters((current) =>
      pruneFilterSelection(current, activityScope),
    );
  }, [
    activityFilters,
    activityOptions,
    poolCount,
    recommendationFilters,
    recommendationOptions,
    sourceFilters,
    sourceOptions,
    workModeFilters,
    workModeOptions,
  ]);
  // The scoped snapshot mirrors state on every change, so Clear filters and
  // plan switches stay truthful: what is active is exactly what is stored
  // for the current scope. The ref guard skips the transient commit between
  // a scope change and its restore, so one plan's facets can never flash
  // into another plan's stored snapshot.
  useEffect(() => {
    if (lastFacetScopeRef.current !== facetScopeKey) return;
    writeScopedFacetFilters(facetScopeKey, {
      activity: [...activityFilters],
      recommendation: [...recommendationFilters],
      source: [...sourceFilters],
      workMode: [...workModeFilters],
    });
  }, [
    activityFilters,
    facetScopeKey,
    recommendationFilters,
    sourceFilters,
    workModeFilters,
  ]);
  const activeFilterCount =
    recommendationFilters.size +
    sourceFilters.size +
    workModeFilters.size +
    activityFilters.size;
  const newJobCount = previousVisitEnd ? (facets?.newSince ?? 0) : 0;
  const newOnly = newOnlyRequested && newJobCount > 0;
  const failedSourceCount =
    latestRun?.targetExecutions?.filter((source) => source.state === "failed")
      .length ?? 0;
  // The filtered list's size; the page holds at most one page of it.
  const jobCount = listResult?.total ?? 0;
  const assessedJobCount = facets?.assessed ?? 0;
  const inAreaJobCount =
    facets?.locationReach.find((entry) => entry.value === "in_area")?.count ??
    0;
  const pendingLocationJobCount = Math.max(0, jobCount - assessedJobCount);
  const locationCountLabel =
    preferredLocations.length > 0 && !remoteIncluded
      ? `${inAreaJobCount} of ${assessedJobCount} assessed jobs in or near ${preferredLocations.join(" or ")}${pendingLocationJobCount > 0 ? ` · ${pendingLocationJobCount} awaiting place checks` : ""}`
      : null;
  const pageCount = Math.max(
    1,
    Math.ceil(jobCount / DISCOVERY_RESULTS_PAGE_SIZE),
  );
  // The list can shrink under the page (jobs decided elsewhere, a search's
  // duplicates merged): ask for its last page instead of an empty one.
  useEffect(() => {
    if (listResult && pagination.page > pageCount - 1)
      setPagination((current) => ({ ...current, page: pageCount - 1 }));
  }, [listResult, pageCount, pagination.page]);
  // Tracks which plan scope the facet state currently mirrors so the restore
  // effect above only fires on real scope changes.
  const lastFacetScopeRef = useRef(facetScopeKey);
  const currentPage = Math.min(Math.max(0, pagination.page), pageCount - 1);
  const stabilityRef = useRef<PageStability | null>(null);
  // Keyed by the request the reply answers: while another page loads, the
  // rows on screen still belong to the last one.
  const resultRequestKey = JSON.stringify(list.request);
  const visibleJobs = useMemo(() => {
    const next = stabilizeFindJobsPage({
      previous: stabilityRef.current,
      rows: listResult?.rows ?? NO_ROWS,
      listIds: listIdSet,
      runId: isSearchInProgress ? searchRunId : null,
      requestKey: resultRequestKey,
      heldJobId,
      pageSize: DISCOVERY_RESULTS_PAGE_SIZE,
    });
    stabilityRef.current = next;
    return next.rows;
  }, [
    heldJobId,
    isSearchInProgress,
    listIdSet,
    listResult,
    resultRequestKey,
    searchRunId,
  ]);
  visitRowsRef.current = visibleJobs;
  // Every row this panel has shown, for bulk work on ticked rows that are on
  // another page now (a closed listing cannot be shortlisted).
  const seenRowsRef = useRef(new Map<string, WorkspaceJobListRow>());
  for (const row of visibleJobs) seenRowsRef.current.set(row.id, row);
  const resultsListRef = useRef<HTMLUListElement | null>(null);
  const visibleJobIds = useMemo(
    () => visibleJobs.map((job) => job.id),
    [visibleJobs],
  );
  // A decided job leaves and the rows under it slide up into its place.
  useListMoveMotion(resultsListRef, visibleJobIds);
  const [bulkSelectedJobIds, setBulkSelectedJobIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isShortlisting, setIsShortlisting] = useState(false);
  const shortlistInFlight = useRef(false);
  const [acknowledgedRescoreJobIds, setAcknowledgedRescoreJobIds] = useState<
    Set<string>
  >(() => new Set());
  // The list for the assistant (ADR 0037): ticked rows are the selection,
  // the page is what is displayed, and the filtered, sorted set is "all".
  useAssistantContextSource(
    "discovery-list",
    () => ({
      list: buildListContext({
        listKind: "jobs",
        checkedIds: bulkSelectedJobIds,
        displayedIds: visibleJobs.map((job) => job.id),
        filteredIds: orderedJobIds,
        filterSummary:
          [
            deferredQuery.trim() ? `matching "${deferredQuery.trim()}"` : null,
            activeFilterCount > 0 ? `${activeFilterCount} filters on` : null,
            areAlsoFoundShown ? "including also-found jobs" : null,
          ]
            .filter(Boolean)
            .join(", ") || null,
      }),
    }),
    { priority: 1 },
  );
  const shortlistSelected = async () => {
    if (shortlistInFlight.current) return;
    const jobIds = selectedShortlistableJobs.map((job) => job.id);
    if (jobIds.length === 0 || !onShortlistJobs) return;
    shortlistInFlight.current = true;
    setIsShortlisting(true);
    try {
      await onShortlistJobs(jobIds);
      setBulkSelectedJobIds(new Set());
    } finally {
      shortlistInFlight.current = false;
      setIsShortlisting(false);
    }
  };
  const isSelectingAny = bulkSelectedJobIds.size > 0;
  const dismissSelected = async () => {
    if (shortlistInFlight.current || !onDismissJobs) return;
    const jobIds = orderedJobIds.filter((jobId) =>
      bulkSelectedJobIds.has(jobId),
    );
    if (jobIds.length === 0) return;
    shortlistInFlight.current = true;
    setIsShortlisting(true);
    try {
      await onDismissJobs(jobIds);
      setBulkSelectedJobIds(new Set());
    } catch {
      // The route message names what failed; the selection stays for a retry.
    } finally {
      shortlistInFlight.current = false;
      setIsShortlisting(false);
    }
  };
  // Right-click: a ticked row acts for every ticked job, like a file list;
  // any other row acts for itself.
  const rowMenuFor = (job: WorkspaceJobListRow): RowMenuEntry[] => {
    const forTicked =
      bulkSelectedJobIds.has(job.id) && bulkSelectedJobIds.size > 1;
    const shortlistable = forTicked
      ? selectedShortlistableJobs.map((candidate) => candidate.id)
      : selectablePageJobIds.includes(job.id)
        ? [job.id]
        : [];
    const hideCount = forTicked ? bulkSelectedJobIds.size : 1;
    return [
      ...(onShortlistJobs
        ? [
            {
              id: "shortlist",
              label: forTicked
                ? `Shortlist ${shortlistable.length} ticked`
                : "Shortlist",
              enabled: shortlistable.length > 0 && !isShortlisting,
              run: () =>
                forTicked
                  ? shortlistSelected()
                  : onShortlistJobs(shortlistable),
            },
          ]
        : []),
      ...(onDismissJobs
        ? [
            {
              id: "hide",
              label: forTicked ? `Hide ${hideCount} ticked` : "Hide",
              enabled: !isShortlisting,
              run: () =>
                forTicked
                  ? dismissSelected()
                  : onDismissJobs([job.id]).catch(() => undefined),
            },
          ]
        : []),
      ...(forTicked ? [] : listingRowMenuEntries(job.canonicalUrl)),
    ];
  };
  // Every job the filters and search match, on every page, that a bulk
  // action can still act on.
  // Find jobs lists jobs still waiting on a decision, so every listed job can
  // be ticked except the decided one held open in its place.
  const selectableMatchingJobIds = isSelectingAny
    ? orderedJobIds.filter((jobId) => jobId !== heldJobId)
    : [];
  const selectAllMatching = () => {
    setBulkSelectedJobIds(new Set(selectableMatchingJobIds));
  };
  const isSelecting = Boolean(onShortlistJobs) && bulkSelectedJobIds.size > 0;
  const selectedShortlistableJobs =
    bulkSelectedJobIds.size === 0
      ? []
      : orderedJobIds
          .filter((jobId) => bulkSelectedJobIds.has(jobId))
          .flatMap((jobId) => {
            const row = seenRowsRef.current.get(jobId);
            return row &&
              (isDiscoveryRowInPipeline(row) ||
                row.listingActivity.status === "closed")
              ? []
              : [{ id: jobId }];
          });
  const selectedShortlistableCount = selectedShortlistableJobs.length;
  // Rows that carry a checkbox on this page, in the order shown.
  const selectablePageJobIds = visibleJobs
    .filter((job) => !isDiscoveryRowInPipeline(job))
    .map((job) => job.id);
  const selectionAnchorRef = useRef<string | null>(null);
  const toggleJobSelection = (jobId: string, shiftKey: boolean) => {
    const anchor = selectionAnchorRef.current;
    setBulkSelectedJobIds((current) => {
      const checked = !current.has(jobId);
      return applySelectionRange(
        current,
        selectablePageJobIds,
        shiftKey ? anchor : null,
        jobId,
        checked,
      );
    });
    selectionAnchorRef.current = jobId;
  };
  const selectPage = () =>
    setBulkSelectedJobIds(
      (current) => new Set([...current, ...selectablePageJobIds]),
    );
  const clearPage = () =>
    setBulkSelectedJobIds((current) => {
      const next = new Set(current);
      for (const jobId of selectablePageJobIds) next.delete(jobId);
      return next;
    });
  // Band dividers only make sense while the list is in its canonical
  // best-match order; any other sort re-interleaves the bands. Headings are
  // built from the rows actually on screen so every page keeps its dividers
  // and each count describes the rows under it rather than the whole set.
  const groupHeadingOptions = useMemo(
    () => ({
      ranked: sortDirection === "desc" && sortField === "fit",
      // The whole ranked list with a page window, never the page slice alone:
      // a divider counts the whole run it names, so a band split across pages
      // reports the same total as the also-found control beside it.
      window: {
        end: (currentPage + 1) * DISCOVERY_RESULTS_PAGE_SIZE,
        start: currentPage * DISCOVERY_RESULTS_PAGE_SIZE,
      },
    }),
    [currentPage, sortDirection, sortField],
  );
  const orderedGroups = useMemo(
    () =>
      (listResult?.outline ?? []).flatMap((run) =>
        Array.from({ length: run.count }, () => run.group),
      ),
    [listResult],
  );
  const groupHeadingsByJobId = useMemo(
    () =>
      buildRunHeadings(
        orderedJobIds,
        orderedGroups,
        groupHeadingOptions.ranked,
        { window: groupHeadingOptions.window },
      ),
    [groupHeadingOptions, orderedGroups, orderedJobIds],
  );
  // Which divider each row actually sits under, so a row can stay quiet about
  // a claim the divider above it already makes — and only then.
  const headedGroupByJobId = useMemo(
    () =>
      buildRunHeadedGroups(
        orderedJobIds,
        orderedGroups,
        groupHeadingOptions.ranked,
        { window: groupHeadingOptions.window },
      ),
    [groupHeadingOptions, orderedGroups, orderedJobIds],
  );
  // Arriving results, sorting and pagination must not change the action target.
  // Only filtering the selected job out requires a replacement selection.
  const displayedSelectedJobId =
    selectedJobId !== null &&
    (listIdSet.has(selectedJobId) ||
      preserveSelectedJob ||
      visibleJobs.some((job) => job.id === selectedJobId))
      ? selectedJobId
      : (visibleJobs[0]?.id ?? null);

  // A selection made elsewhere (a link, the next job in triage) opens the
  // page that holds it, once the list it is looked up in has arrived.
  useLayoutEffect(() => {
    if (!listResult || pagination.selectedJobId === selectedJobId) {
      return;
    }
    const index = selectedJobId ? orderedJobIds.indexOf(selectedJobId) : -1;
    const selectedJobPage =
      index < 0 ? currentPage : Math.floor(index / DISCOVERY_RESULTS_PAGE_SIZE);
    setPagination({
      page: selectedJobPage,
      selectedJobId,
    });
    if (selectedJobPage !== currentPage && resultsScrollRegionRef.current) {
      resultsScrollRegionRef.current.scrollTop = 0;
    }
  }, [
    currentPage,
    listResult,
    orderedJobIds,
    pagination.selectedJobId,
    selectedJobId,
  ]);

  // Report after the page-snap effect so a freshly opened deep-linked page is
  // reported in its final position.
  const reportedDisplayedSelectionRef = useRef<string | null | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    if (!onDisplayedSelectedJobIdChange) {
      return;
    }
    if (reportedDisplayedSelectionRef.current === displayedSelectedJobId) {
      return;
    }
    reportedDisplayedSelectionRef.current = displayedSelectedJobId;
    onDisplayedSelectedJobIdChange(displayedSelectedJobId);
  }, [displayedSelectedJobId, onDisplayedSelectedJobIdChange]);
  // The screen's inspector and triage read the page and the order from here.
  const detailRevision = list.detailRevision;
  const groupOf = useMemo(() => {
    const groups = new Map(
      orderedJobIds.map((jobId, index) => [jobId, orderedGroups[index]]),
    );
    return (jobId: string) => groups.get(jobId);
  }, [orderedGroups, orderedJobIds]);
  useEffect(() => {
    onListChange?.({
      ready: listResult !== null,
      rows: visibleJobs,
      orderedJobIds,
      groupOf,
      planJobCount: listResult?.counts.all ?? 0,
      pool: poolBands,
      detailRevision,
    });
  }, [
    detailRevision,
    groupOf,
    listResult,
    onListChange,
    orderedJobIds,
    poolBands,
    visibleJobs,
  ]);

  const firstVisibleJobNumber =
    jobCount === 0 ? 0 : currentPage * DISCOVERY_RESULTS_PAGE_SIZE + 1;
  const lastVisibleJobNumber = Math.min(
    jobCount,
    firstVisibleJobNumber + visibleJobs.length - 1,
  );

  const moveToPage = useCallback((page: number) => {
    startPageTransition(() => {
      setPagination((current) => ({
        ...current,
        page,
      }));
    });
    if (resultsScrollRegionRef.current) {
      resultsScrollRegionRef.current.scrollTop = 0;
    }
  }, []);
  const resultFilterGroups: DiscoveryFilterGroup[] = [];
  if (filterGroups.recommendation)
    resultFilterGroups.push({
      label: "Fit",
      options: recommendationOptions.map((recommendation) => ({
        label: fitRecommendationCopy[recommendation].label,
        selected: recommendationFilters.has(recommendation),
        onToggle: () => {
          setRecommendationFilters((current) =>
            toggleFilterValue(current, recommendation),
          );
          moveToPage(0);
        },
      })),
    });
  if (filterGroups.source)
    resultFilterGroups.push({
      label: "Source",
      searchable: true,
      options: sourceOptions.map((source) => ({
        label: source,
        selected: sourceFilters.has(source),
        onToggle: () => {
          setSourceFilters((current) => toggleFilterValue(current, source));
          moveToPage(0);
        },
      })),
    });
  if (filterGroups.workMode)
    resultFilterGroups.push({
      label: "Work mode",
      options: workModeOptions.map((workMode) => ({
        label:
          workMode === WORK_MODE_UNSPECIFIED_FILTER
            ? workMode
            : formatWorkModeLabel(workMode as WorkMode),
        selected: workModeFilters.has(workMode),
        onToggle: () => {
          setWorkModeFilters((current) => toggleFilterValue(current, workMode));
          moveToPage(0);
        },
      })),
    });
  if (filterGroups.activity)
    resultFilterGroups.push({
      label: "Listing status",
      options: activityOptions.map((status) => ({
        label: formatStatusLabel(status),
        selected: activityFilters.has(status),
        onToggle: () => {
          setActivityFilters((current) => toggleFilterValue(current, status));
          moveToPage(0);
        },
      })),
    });
  const clearFilters = useCallback(() => {
    setRecommendationFilters(new Set());
    setSourceFilters(new Set());
    setWorkModeFilters(new Set());
    setActivityFilters(new Set());
    moveToPage(0);
  }, [moveToPage]);

  // Revealing or hiding the also-found pool must visibly change the list. On
  // any page but the first, the revealed rows join the end of the ranking and
  // nothing on screen moves, so the control reads as a no-op. Returning to the
  // first page keeps the pressed state, the label, and the list in agreement.
  const lastAlsoFoundShownRef = useRef(areAlsoFoundShown);
  useEffect(() => {
    if (lastAlsoFoundShownRef.current === areAlsoFoundShown) return;
    lastAlsoFoundShownRef.current = areAlsoFoundShown;
    moveToPage(0);
  }, [areAlsoFoundShown, moveToPage]);

  // Switching the active search plan swaps in that plan's own facets; the
  // prune and snapshot effects then validate and persist them under the new
  // scope, so nothing leaks between plans.
  useEffect(() => {
    if (lastFacetScopeRef.current === facetScopeKey) return;
    lastFacetScopeRef.current = facetScopeKey;
    const scoped = readScopedFacetFilters(facetScopeKey);
    setRecommendationFilters(new Set(scoped.recommendation));
    setSourceFilters(new Set(scoped.source));
    setWorkModeFilters(new Set(scoped.workMode));
    setActivityFilters(new Set(scoped.activity));
    moveToPage(0);
  }, [facetScopeKey, moveToPage]);

  // Counted only while the no-matches note that prints it is on screen; it
  // used to run over every hidden job on every render.
  const showsTextNoMatches =
    poolCount > 0 && jobCount === 0 && activeFilterCount === 0;
  const [hiddenTextMatches, setHiddenTextMatches] = useState(0);
  useEffect(() => {
    if (!showsTextNoMatches || areAlsoFoundShown || !normalizedQuery) {
      setHiddenTextMatches(0);
      return undefined;
    }
    let current = true;
    void window.nestor.jobFinder.queries
      .queryJobList({
        list: "discovery",
        filters: {
          ...(planId ? { planId } : {}),
          discoveryBands: ["weaker", "mismatches"],
        },
        search: normalizedQuery.slice(0, 500),
        page: { offset: 0, limit: 1 },
      })
      .then((reply) => {
        if (current) setHiddenTextMatches(reply.total);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [areAlsoFoundShown, normalizedQuery, planId, showsTextNoMatches]);
  const sessionNeedsAttention =
    !isOfflineRuntime &&
    (browserSession.status === "login_required" ||
      browserSession.status === "blocked");
  const sessionWaitingOnRuntime =
    browserSession.status === "unknown" &&
    browserSession.driver !== "catalog_seed" &&
    recoveryActionPending;
  const resultsStatusLine: {
    busy: boolean;
    id?: string;
    text: string;
  } | null = isSearchInProgress
    ? {
        busy: true,
        text: [
          latestRun?.summary.report
            ? `${formatDiscoveryRunReportLabel(getDiscoveryRunReportCounts(latestRun))}.`
            : `${jobCount} ${jobCount === 1 ? "result" : "results"} shown.`,
          liveStatusLine ?? "Still checking the remaining sources.",
        ].join(" "),
      }
    : liveStatusLine
      ? { busy: true, text: liveStatusLine }
      : sessionWaitingOnRuntime
        ? {
            busy: true,
            text: "Showing results from the last search while the browser gets ready.",
          }
        : isOfflineRuntime
          ? {
              busy: false,
              id: DISCOVERY_OFFLINE_CATALOG_NOTICE_ID,
              text: `${DISCOVERY_OFFLINE_RUNTIME_LABEL}. ${DISCOVERY_OFFLINE_SETUP_NOTICE}`,
            }
          : null;
  // Until the first reply the list says nothing: no empty state flashes
  // before the rows it would contradict.
  const listReady = listResult !== null;
  const listEmpty = listReady && poolCount === 0;
  const allResultsHidden = listEmpty && hiddenAlsoFoundCount > 0;
  // One number: the jobs on this list. The band arithmetic ("6 worth opening
  // · 3 title matches · 2 also found · 11 kept in this search plan") now
  // lives where it is explained — the dividers in the list and the finished
  // search's own banner — instead of being repeated as a sentence of counts
  // above a list that already shows them.
  const isCountFiltered =
    deferredQuery.trim().length > 0 || activeFilterCount > 0;
  const jobNoun = poolCount === 1 ? "job" : "jobs";
  // With weaker matches shown the list holds both pools. The sidebar and
  // Home count only the matches, so the header names the two parts instead
  // of a third number ("Find jobs 678" beside "6284 jobs").
  const weakerShownCount = areAlsoFoundShown
    ? Math.min(alsoFoundCount, poolCount)
    : 0;
  const matchCount = poolCount - weakerShownCount;
  const resultCountLabel = isCountFiltered
    ? `${jobCount} of ${poolCount} ${jobNoun}`
    : weakerShownCount > 0
      ? `${matchCount} ${matchCount === 1 ? "match" : "matches"} + ${weakerShownCount} weaker`
      : `${poolCount} ${jobNoun}`;
  // Terminal empty-state truth: prefer the explicit newest-run verdict; when a
  // caller does not provide one, fall back to the legacy completed-search flag
  // so existing behavior is unchanged.
  const emptyRunVerdict: DiscoveryLatestRunVerdict =
    latestRunVerdict ??
    (hasCompletedSearch ? { kind: "completed" } : { kind: "none" });
  const showSearchingEmptyState =
    isSearchInProgress || emptyRunVerdict.kind === "running";
  // Box metrics for a continuous list row: the one treatment shared with
  // Shortlisted and Applications. The shared `SelectableRow` primitive owns
  // selection (tint plus an inset accent bar that consumes no layout space);
  // `jobFinderListRowClassName` only turns its default card shape into this
  // flush, bottom-ruled row. Nothing here varies with selection, which is what
  // the primitive's dev-time guard enforces.
  const baseButtonClasses = jobFinderListRowClassName;
  const handleListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, jobId: string) => {
      const nextId = getAdjacentCollectionItemId(
        orderedJobIds,
        jobId,
        event.key,
      );
      if (!nextId) return;

      const nextIndex = orderedJobIds.indexOf(nextId);
      const nextPage = Math.floor(nextIndex / DISCOVERY_RESULTS_PAGE_SIZE);
      event.preventDefault();
      if (nextPage !== currentPage) {
        moveToPage(nextPage);
      }
      onSelectJob(nextId);
      // Scoped to the results scroll region so the deferred frame can never
      // land focus in another surface's rows.
      focusCollectionItem(nextId, {
        region: resultsScrollRegionRef.current,
      });
    },
    [currentPage, moveToPage, onSelectJob, orderedJobIds],
  );
  // Rows read their handlers through this ref, so the panel can hand every
  // row the same object and a row re-renders only when what it shows changes.
  const rowActionsRef = useRef<DiscoveryResultRowActions>(null!);
  rowActionsRef.current = {
    acknowledgeRescore: (jobId) =>
      setAcknowledgedRescoreJobIds((current) => new Set(current).add(jobId)),
    handleListKeyDown,
    openRowMenu: (event, job) => openRowContextMenu(event, rowMenuFor(job)),
    selectJob: onSelectJob,
    toggleJobSelection,
  };

  const resultsTitle = (
    <div className="flex min-w-0 shrink-0 items-baseline gap-x-2 whitespace-nowrap">
      {/* In a narrow column the count already says what the list is, so the
          word gives its room to the search field and the row stays one line;
          screen readers keep the name. */}
      <h2
        className="text-(--text-headline) @max-[34rem]/results:sr-only"
        id="discovery-job-results-heading"
      >
        Results
      </h2>
      {planName ? (
        <span
          className="max-w-28 truncate text-xs text-foreground-muted"
          title={planName}
        >
          {planName}
        </span>
      ) : null}
      {/* An empty list explains itself below; "0 jobs" beside "Ready for
          your first search" only repeats the empty state as a number. */}
      {poolCount > 0 ? (
        <span
          aria-atomic="true"
          aria-live="polite"
          className="text-(length:--text-small) tabular-nums text-foreground-muted"
          data-testid="discovery-result-count"
        >
          {resultCountLabel}
          {locationCountLabel ? <span> · {locationCountLabel}</span> : null}
        </span>
      ) : null}
    </div>
  );
  // The page checkbox sits at the start of the header row, above the rows'
  // checkbox column, instead of on a row of its own with a hint line.
  const pageCheckbox =
    onShortlistJobs && selectablePageJobIds.length > 0 ? (
      <span className="flex w-6 shrink-0 justify-center">
        <ListPageCheckbox
          noun="jobs"
          onClearPage={clearPage}
          onSelectPage={selectPage}
          pageIds={selectablePageJobIds}
          selectedIds={bulkSelectedJobIds}
        />
      </span>
    ) : null;
  const runSummaryLabel = latestRun?.targetExecutions?.length
    ? latestRun.state === "cancelled" ||
      getDiscoveryRunPhase(latestRun) === "interrupted"
      ? "Search stopped"
      : failedSourceCount > 0
        ? // "Partial results" over an empty list when every source failed
          // promised results that were never there.
          !isSearchInProgress &&
          failedSourceCount >= latestRun.targetExecutions.length
          ? "No source could be searched"
          : `${isSearchInProgress ? "Searching" : "Partial results"} · ${failedSourceCount} ${failedSourceCount === 1 ? "source failed" : "sources failed"}${isSearchInProgress ? " so far" : ""}`
        : "What each source found"
    : null;
  const showsResultsStatusLine = Boolean(
    resultsStatusLine && (poolCount > 0 || liveStatusLine),
  );

  return (
    <section
      aria-labelledby="discovery-job-results-heading"
      className="surface-panel-shell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) xl:h-full xl:min-h-0"
    >
      {/* One header row: the panel title and count (this page has two panes
          that need names), then search, filters and sort. While rows are
          ticked the same row holds the bulk actions instead, so ticking a
          row never moves the list (ADR 0044). */}
      <header className="@container/results shrink-0 border-b border-(--surface-panel-border)">
        {isSelecting ? (
          <div
            aria-label="Bulk shortlist actions"
            className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
            data-discovery-selection-bar
            role="group"
          >
            {/* Kept to one row so ticking a row never moves the list: the
                title without the plan and count, and short visible labels
                whose full names are their accessible names. */}
            {pageCheckbox}
            <h2
              className="text-(--text-headline) @max-[34rem]/results:sr-only"
              id="discovery-job-results-heading"
            >
              Results
            </h2>
            <span className="text-(length:--text-small) font-medium text-foreground">
              {bulkSelectedJobIds.size} selected
            </span>
            <Button
              aria-label={`Shortlist ${selectedShortlistableCount} selected`}
              disabled={isShortlisting || selectedShortlistableCount === 0}
              onClick={() => void shortlistSelected()}
              size="toolbar"
              type="button"
              variant="secondary"
            >
              Shortlist {selectedShortlistableCount}
            </Button>
            {onDismissJobs ? (
              <Button
                aria-label={`Mark ${bulkSelectedJobIds.size} selected as not interested`}
                disabled={isShortlisting}
                onClick={() => void dismissSelected()}
                size="toolbar"
                type="button"
                variant="outline"
              >
                Not interested
              </Button>
            ) : null}
            {selectableMatchingJobIds.some(
              (jobId) => !bulkSelectedJobIds.has(jobId),
            ) ? (
              <Button
                disabled={isShortlisting}
                onClick={selectAllMatching}
                size="toolbar"
                type="button"
                variant="ghost"
              >
                Select all {selectableMatchingJobIds.length}
              </Button>
            ) : null}
            <Button
              aria-label="Clear selection"
              onClick={() => setBulkSelectedJobIds(new Set())}
              size="toolbar"
              type="button"
              variant="ghost"
            >
              Clear
            </Button>
          </div>
        ) : poolCount > 0 ? (
          <CollectionSearchToolbar
            className="border-b-0"
            compact
            hideCompactCount
            leading={
              <>
                {pageCheckbox}
                {resultsTitle}
              </>
            }
            label="Find a job"
            onQueryChange={(query) => {
              view.setQuery(query);
              moveToPage(0);
            }}
            placeholder="Search jobs"
            placement="panel"
            query={view.query}
            totalCount={poolCount}
            visibleCount={jobCount}
            viewActions={
              <div
                className="flex min-w-0 flex-wrap items-start justify-between gap-2"
                data-testid="discovery-results-toolbar"
              >
                {hasFilterGroups ? (
                  <DiscoveryResultFilters
                    groups={resultFilterGroups}
                    activeCount={activeFilterCount}
                    matchingCount={jobCount}
                    totalCount={poolCount}
                    onClear={clearFilters}
                  />
                ) : null}
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                  <select
                    aria-label="Sort results"
                    title="Best match shows assessed jobs first. Within each group, reachable places come first, then fit score."
                    className={cn(
                      DISCOVERY_RESULTS_TOOLBAR_CONTROL_CLASS,
                      "min-w-0 max-w-full border border-(--field-border) bg-(--field) px-2 text-foreground-soft outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]",
                    )}
                    onChange={(event) => {
                      const match = DISCOVERY_RESULTS_SORT_OPTIONS.find(
                        (option) => option.field === event.target.value,
                      );
                      if (!match) return;
                      resultsSort.setSortField(match.field);
                      moveToPage(0);
                    }}
                    value={sortField}
                  >
                    {DISCOVERY_RESULTS_SORT_OPTIONS.map((option) => (
                      <option key={option.field} value={option.field}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            }
          />
        ) : (
          <div className="flex min-h-12 items-center px-3 py-2">
            {resultsTitle}
          </div>
        )}
        {/* One status row under the toolbar: the search's progress or its
            per-source summary, jobs hidden by the person, and the fit
            actions. It disappears when it has nothing to say. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pb-2 empty:hidden">
          {showsResultsStatusLine && resultsStatusLine ? (
            <p
              aria-atomic="true"
              aria-live="polite"
              className="flex min-w-0 items-start gap-1.5 text-(length:--text-small) leading-5 text-foreground-muted"
              data-testid="discovery-results-status-line"
              {...(resultsStatusLine.id ? { id: resultsStatusLine.id } : {})}
              role="status"
            >
              {resultsStatusLine.busy ? (
                // Turns when the line changes, not every frame of a search.
                <LoaderCircle
                  key={resultsStatusLine.text}
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 motion-safe:animate-spin-brief"
                />
              ) : null}
              <span className="min-w-0 break-words">
                {resultsStatusLine.text}
              </span>
            </p>
          ) : null}
          {latestRun && runSummaryLabel ? (
            // Takes what room the row has left and shortens with an ellipsis,
            // so Hidden and the fit actions stay on this row at 1440 wide.
            <details
              className="min-w-0 flex-1 text-xs text-foreground-soft open:basis-full"
              data-testid="discovery-source-summaries"
              open={sourceSummariesOpen}
            >
              <summary
                className="cursor-pointer truncate"
                title={`${runSummaryLabel}${latestRun.startedAt ? ` · ${formatTimestamp(latestRun.startedAt)}` : ""}`}
                onClick={(event) => {
                  event.preventDefault();
                  setSourceSummariesOpen((open) => !open);
                }}
              >
                {runSummaryLabel}
                {latestRun.startedAt
                  ? ` · ${formatTimestamp(latestRun.startedAt)}`
                  : ""}
              </summary>
              {sourceSummariesOpen ? (
                <div className="max-h-80 overflow-y-auto">
                  <DiscoverySourceSummaryList
                    discoveryTargets={discoveryTargets}
                    isSearchInProgress={isSearchInProgress}
                    latestRun={latestRun}
                    onRetrySource={onRetrySource}
                  />
                </div>
              ) : null}
            </details>
          ) : null}
          {newJobCount > 0 ? (
            <button
              aria-pressed={newOnly}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-(--radius-small) px-1.5 text-(length:--text-small) tabular-nums outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
                newOnly
                  ? "bg-secondary font-medium text-foreground"
                  : "text-foreground-soft",
              )}
              data-testid="discovery-new-since-visit"
              onClick={() => {
                setNewOnly(!newOnly);
                moveToPage(0);
              }}
              title={
                newOnly
                  ? "Show every job again"
                  : "Show only the jobs found since you last looked"
              }
              type="button"
            >
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-(--info-text)"
              />
              {newJobCount} new
              {newOnly ? <X aria-hidden="true" className="size-3" /> : null}
            </button>
          ) : null}
          {hiddenJobsControl}
          {onJudgeUnjudgedJobs ? (
            <DiscoveryAssessmentContinuation
              className="ml-auto"
              uncheckedCount={poolBands?.unchecked ?? 0}
              isSearchRunning={isSearchInProgress}
              fitJudgmentProgress={fitJudgmentProgress ?? null}
              onJudgeAll={onJudgeUnjudgedJobs}
            />
          ) : null}
        </div>
      </header>
      <div
        aria-busy={isPagePending}
        className="overscroll-contain xl:min-h-[360px] xl:flex-1 xl:overflow-y-auto"
        data-locked-pane-scroll-region
        data-job-results-scroll-region
        ref={resultsScrollRegionRef}
        role="region"
        aria-label="Job results list"
        tabIndex={0}
        onKeyDown={(event) => {
          if (!onShortlistJobs) return;
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "a"
          ) {
            event.preventDefault();
            selectPage();
          } else if (event.key === "Escape" && bulkSelectedJobIds.size > 0) {
            event.preventDefault();
            setBulkSelectedJobIds(new Set());
          }
        }}
      >
        {/* What the close actually did to the run, in the run's own frozen
          numbers. It sits above the list because it explains the list. */}
        {!isSearchInProgress &&
        latestRun &&
        getDiscoveryRunPhase(latestRun) === "interrupted" ? (
          <div className="px-5 py-4">
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-4 py-3 text-(length:--text-small) leading-6 text-(--warning-text)"
              data-testid="discovery-interrupted-run-banner"
              role="status"
            >
              <p className="min-w-0">
                {describeInterruptedDiscoveryRun(latestRun)}
              </p>
              {onSearchAgain ? (
                <Button
                  // Called with nothing: handed straight to onClick, the
                  // click event became the search request and could not be
                  // sent to the app, so the button did nothing.
                  onClick={() => onSearchAgain()}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  Search again from here
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {preferredLocations.length > 0 &&
        !remoteIncluded &&
        poolCount > 0 &&
        !isSearchInProgress &&
        (hasCompletedSearch || latestRun?.state === "completed") &&
        inAreaJobCount === 0 &&
        poolBands?.unchecked === 0 ? (
          <p
            className="px-5 py-2 text-xs text-foreground-soft"
            data-testid="discovery-no-area-matches"
          >
            No assessed jobs are in your preferred places.{" "}
            {editPlanHref ? (
              <Link className="underline" to={editPlanHref}>
                Widen your places
              </Link>
            ) : (
              "Widen your places"
            )}
            {" or "}
            <Link
              className="underline"
              to={JOB_FINDER_ROUTE_PATHS.profileSources}
            >
              add a source for your area
            </Link>
            , then search again.
          </p>
        ) : null}
        {allResultsHidden ? (
          <div className="px-5 pt-4">
            <ResultsEmptyState
              className={emptyClassName ?? "min-h-56"}
              description={`${hiddenAlsoFoundCount === 1 ? "It scored" : "They scored"} well below your saved targets, or ${hiddenAlsoFoundCount === 1 ? "conflicts" : "conflict"} with them, so ${hiddenAlsoFoundCount === 1 ? "it is" : "they are"} under weaker matches. Nothing was deleted.`}
              {...(onShowAlsoFound !== undefined
                ? { onRecoveryAction: onShowAlsoFound }
                : {})}
              recoveryActionLabel={`Show weaker matches (${hiddenAlsoFoundCount})`}
              recoveryActionNextStep="Open a job to judge it yourself; a low score alone is not a reason to skip it."
              // The plan still holds these jobs; say so rather than "nothing".
              title={
                hiddenAlsoFoundCount === 1
                  ? "1 job kept, but it scored low"
                  : `${hiddenAlsoFoundCount} jobs kept, but they scored low`
              }
            />
          </div>
        ) : null}

        {!allResultsHidden && searchSetupBlocker && listEmpty ? (
          <div className="px-5 pt-4" id={DISCOVERY_SEARCH_SETUP_BLOCKER_ID}>
            <ResultsEmptyState
              actionHref={
                searchSetupBlocker.actionHref ?? JOB_FINDER_ROUTE_PATHS.profile
              }
              className={emptyClassName ?? "min-h-56"}
              description={searchSetupBlocker.description}
              recoveryActionLabel={
                searchSetupBlocker.actionLabel ?? "Edit search in Profile"
              }
              recoveryActionNextStep={
                searchSetupBlocker.nextStep ?? "Then search again."
              }
              title={searchSetupBlocker.title}
            />
          </div>
        ) : null}

        {!allResultsHidden &&
        !searchSetupBlocker &&
        showSearchingEmptyState &&
        listEmpty ? (
          <div className="px-5 pt-4">
            <ResultsEmptyState
              className={emptyClassName ?? "min-h-56"}
              description={
                liveStatusLine ??
                "Results will appear here as each source finishes."
              }
              title="Searching your sources"
            />
          </div>
        ) : null}

        {!allResultsHidden &&
        !searchSetupBlocker &&
        !showSearchingEmptyState &&
        isOfflineRuntime &&
        listEmpty ? (
          <div className="px-5 pt-4">
            <ResultsEmptyState
              actionHref={JOB_FINDER_ROUTE_PATHS.profileSources}
              className="min-h-0 py-4"
              description={DISCOVERY_OFFLINE_SETUP_NOTICE}
              recoveryActionLabel="Review job sources"
              recoveryActionNextStep="Check your saved job sites in Profile, then try searching again."
              title="Job Finder cannot search right now"
            />
          </div>
        ) : null}

        {!allResultsHidden &&
        !searchSetupBlocker &&
        !isSearchInProgress &&
        sessionNeedsAttention &&
        listEmpty ? (
          <div className="px-5 pt-4">
            <ResultsEmptyState
              className={emptyClassName ?? "min-h-56"}
              description={`Open ${JOB_FINDER_BROWSER_NAME}, sign in or fix the issue, then search again.`}
              title="Search blocked by browser"
              {...(onRecoveryAction !== undefined ? { onRecoveryAction } : {})}
              {...(recoveryActionLabel !== undefined
                ? { recoveryActionLabel }
                : {})}
              {...(recoveryActionNextStep !== undefined
                ? { recoveryActionNextStep }
                : {})}
              {...(recoveryActionPending
                ? { recoveryActionPending: true }
                : {})}
            />
          </div>
        ) : null}

        {!allResultsHidden &&
        !searchSetupBlocker &&
        !isSearchInProgress &&
        sessionWaitingOnRuntime &&
        listEmpty ? (
          <div className="px-5 pt-4">
            <ResultsEmptyState
              className={emptyClassName ?? "min-h-56"}
              description="New results will appear here after browser-based sources are ready."
              title="Browser is starting"
            />
          </div>
        ) : null}

        {sessionNeedsAttention && poolCount > 0 ? (
          <div className="px-5 py-2">
            <SessionRecoveryLine
              description="A job site needs you to sign in before the next search."
              {...(onRecoveryAction !== undefined ? { onRecoveryAction } : {})}
              {...(recoveryActionLabel !== undefined
                ? { recoveryActionLabel }
                : {})}
              {...(recoveryActionPending
                ? { recoveryActionPending: true }
                : {})}
            />
          </div>
        ) : null}

        {!allResultsHidden &&
        !searchSetupBlocker &&
        !showSearchingEmptyState &&
        !isOfflineRuntime &&
        !sessionNeedsAttention &&
        !sessionWaitingOnRuntime &&
        emptyRunVerdict.kind === "interrupted" &&
        listEmpty ? (
          <div className="px-5 pt-4">
            <ResultsEmptyState
              className={emptyClassName ?? "min-h-56"}
              description={`${
                emptyRunVerdict.interruptState === "cancelled"
                  ? "The newest search was cancelled before every enabled source was checked. An empty list here does not prove your sources have no matches."
                  : emptyRunVerdict.interruptState === "sources_failed"
                    ? "The newest search finished, but at least one enabled source failed, so an empty list here does not prove your sources have no matches."
                    : "The newest search stopped before every enabled source was checked. An empty list here does not prove your sources have no matches."
              } ${
                // The callout above already says what to do; a second, generic
                // "Search now" beside it pointed at the wrong fix when the cause
                // was an address to correct.
                failureCalloutShown
                  ? "The message above says what to do next."
                  : "Select Search now to try again."
              }`}
              title={
                emptyRunVerdict.interruptState === "cancelled"
                  ? "The last search was cancelled"
                  : emptyRunVerdict.interruptState === "sources_failed"
                    ? "The last search finished, but sources failed"
                    : "The last search stopped before finishing"
              }
            />
          </div>
        ) : null}

        {!allResultsHidden &&
        !searchSetupBlocker &&
        !showSearchingEmptyState &&
        !sessionNeedsAttention &&
        !sessionWaitingOnRuntime &&
        !isOfflineRuntime &&
        emptyRunVerdict.kind === "completed" &&
        alsoFoundCount === 0 &&
        listEmpty ? (
          <div className="px-5 pt-4">
            <ResultsEmptyState
              actionHref={
                editPlanHref ?? JOB_FINDER_ROUTE_PATHS.profileWorkModes
              }
              className={emptyClassName ?? "min-h-56"}
              description="No saved source returned a role that met this search. Broaden a role or location, enable another source, then run it again."
              recoveryActionLabel="Edit your places"
              recoveryActionNextStep="Review this plan’s places and work modes, then search again."
              title="No matches from this search"
            />
          </div>
        ) : null}

        {!allResultsHidden &&
        !searchSetupBlocker &&
        !showSearchingEmptyState &&
        !sessionNeedsAttention &&
        !sessionWaitingOnRuntime &&
        !isOfflineRuntime &&
        emptyRunVerdict.kind === "none" &&
        alsoFoundCount === 0 &&
        listEmpty ? (
          <div className="px-5 pt-4">
            <ResultsEmptyState
              className={emptyClassName ?? "min-h-56"}
              description="Press Search now. Job Finder searches the sources chosen for this plan using your profile, then lists what it found here. Shortlist the jobs you want to apply to."
              title="Ready for your first search"
            />
          </div>
        ) : null}

        {listEmpty && alsoFoundCount > 0 && onToggleAlsoFound ? (
          <div className="px-5 py-4">
            <p className="mb-2 text-sm text-foreground-soft">
              Assessed jobs are in weaker matches.
            </p>
            <Button size="sm" variant="secondary" onClick={onToggleAlsoFound}>
              Show weaker matches
            </Button>
          </div>
        ) : null}
        {poolCount > 0 && jobCount === 0 && activeFilterCount > 0 ? (
          <div className="px-5 pt-4">
            <ResultsEmptyState
              className={emptyClassName ?? "min-h-48"}
              description="No saved result meets every active filter. Nothing was removed."
              onRecoveryAction={clearFilters}
              recoveryActionLabel="Clear filters"
              recoveryActionNextStep="Review the complete result list, then apply a broader filter if needed."
              title="No jobs match these filters"
            />
          </div>
        ) : poolCount > 0 && jobCount === 0 ? (
          <div>
            <CollectionNoMatches
              description={`This search kept ${poolCount} ${poolCount === 1 ? "job" : "jobs"}. None of the shown jobs match this text. Clear the search to see ${poolCount === 1 ? "it" : "them"}.`}
              noun="jobs"
              onClear={() => view.setQuery("")}
              query={view.query}
            />
            {hiddenTextMatches > 0 && onToggleAlsoFound ? (
              <div className="px-5 pb-4">
                <p className="mb-2 text-sm text-foreground-soft">
                  {hiddenTextMatches} hidden weaker{" "}
                  {hiddenTextMatches === 1 ? "match fits" : "matches fit"} this
                  text.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onToggleAlsoFound}
                >
                  Show weaker matches
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {jobCount > 0 || visibleJobs.length > 0 ? (
          // Below the two-pane breakpoint the results panel and the inspector
          // share one page scroller, so the list must take its content height:
          // a short result set that stretches to the viewport leaves hundreds of
          // pixels of empty bordered area that reads as a loading failure and
          // pushes the inspector — and its primary action — off screen.
          <div className="flex min-h-0 flex-col" data-job-results-stack>
            <div
              // The scroll padding keeps the last card clear of the two-pane
              // scroller's bottom edge. Below that breakpoint the list has no
              // scroller of its own and takes its content height, so the same
              // padding is only an empty grey strip under the last result.
              className="xl:min-h-[320px] xl:pb-8"
            >
              <ul
                aria-label="Results"
                className={cn(jobFinderListRegionClassName, "xl:min-h-full")}
                ref={resultsListRef}
              >
                {visibleJobs.flatMap((job) => {
                  const groupHeading = groupHeadingsByJobId.get(job.id);
                  return [
                    groupHeading ? (
                      <li
                        key={`group-${facetScopeKey}-${groupHeading.id}`}
                        className="grid gap-1 border-y border-(--surface-panel-border) bg-(--surface-panel-raised) px-4 py-2.5"
                        data-testid={`discovery-results-group-${groupHeading.id}`}
                      >
                        <span className="text-(length:--text-small) font-semibold text-(--text-headline)">
                          {groupHeading.label} ({groupHeading.count})
                        </span>
                      </li>
                    ) : null,
                    <DiscoveryResultRow
                      actions={rowActionsRef}
                      buttonClassName={baseButtonClasses}
                      checked={bulkSelectedJobIds.has(job.id)}
                      headedGroup={headedGroupByJobId.get(job.id)}
                      isNew={isNewSinceVisit(job, previousVisitEnd)}
                      job={job}
                      key={job.id}
                      rescoreAcknowledged={acknowledgedRescoreJobIds.has(
                        job.id,
                      )}
                      selectable={selectablePageJobIds.includes(job.id)}
                      selected={displayedSelectedJobId === job.id}
                      showSelection={Boolean(onShortlistJobs)}
                    />,
                  ];
                })}
              </ul>
              {/* The weaker pool is offered where the strong list ends
                  instead of in the header (ADR 0044). */}
              {alsoFoundCount > 0 && onToggleAlsoFound ? (
                <div
                  className="flex flex-wrap items-center justify-center gap-2 border-t border-(--surface-panel-border) px-3 py-3 text-(length:--text-small) text-foreground-muted"
                  data-discovery-weaker-matches
                >
                  {!areAlsoFoundShown ? (
                    <span>
                      {alsoFoundCount} weaker{" "}
                      {alsoFoundCount === 1 ? "match" : "matches"} hidden
                    </span>
                  ) : null}
                  <Button
                    aria-pressed={areAlsoFoundShown}
                    className="shrink-0 whitespace-nowrap"
                    data-testid="discovery-toggle-also-found"
                    onClick={onToggleAlsoFound}
                    size="xs"
                    type="button"
                    variant={areAlsoFoundShown ? "secondary" : "outline"}
                  >
                    {areAlsoFoundShown
                      ? `Hide weaker matches (${alsoFoundCount})`
                      : `Show weaker matches (${alsoFoundCount})`}
                  </Button>
                </div>
              ) : null}
            </div>
            {pageCount > 1 ? (
              <nav
                aria-label="Job result pages"
                className="@container sticky bottom-0 z-10 flex h-11 shrink-0 items-center justify-between gap-3 border-t border-(--surface-panel-border) bg-(--surface-panel) px-3"
                data-job-results-pagination
              >
                <span
                  aria-live="polite"
                  className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-(length:--text-small) text-foreground-muted"
                >
                  {isPagePending ? (
                    <>
                      <LoaderCircle
                        aria-hidden="true"
                        className="size-3 motion-safe:animate-spin"
                      />
                      Loading results…
                    </>
                  ) : (
                    `${firstVisibleJobNumber}–${lastVisibleJobNumber} of ${jobCount}`
                  )}
                </span>
                <PageNavigation
                  page={currentPage + 1}
                  pageCount={pageCount}
                  pending={isPagePending}
                  previousLabel="Previous"
                  nextLabel="Next"
                  onPageChange={(nextPage) => moveToPage(nextPage - 1)}
                />
              </nav>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * What each source of the latest run did. Labels, counts and last notes are
 * looked up through maps built once, not by scanning every source and every
 * activity event for each row.
 */
function DiscoverySourceSummaryList({
  discoveryTargets,
  isSearchInProgress,
  latestRun,
  onRetrySource,
}: {
  discoveryTargets: Parameters<typeof jobSourceLabel>[1];
  isSearchInProgress: boolean;
  latestRun: NonNullable<DiscoveryResultsPanelProps["latestRun"]>;
  onRetrySource?: DiscoveryResultsPanelProps["onRetrySource"];
}) {
  const rows = useMemo(() => {
    const targetsById = new Map(
      discoveryTargets.map((target) => [target.id, target]),
    );
    const lastNoteByTargetId = new Map<string, string>();
    for (const event of latestRun.activity ?? []) {
      if (event.targetId && event.terminalState === "completed")
        lastNoteByTargetId.set(event.targetId, event.message);
    }
    const reportedSources = new Map(
      (latestRun.summary.report?.sources ?? []).map((source) => [
        source.targetId,
        source,
      ]),
    );
    return (latestRun.targetExecutions ?? []).map((source) => {
      const target = targetsById.get(source.targetId.trim());
      const reported = reportedSources.get(source.targetId);
      return {
        source,
        label: jobSourceLabel(source.targetId, target ? [target] : []),
        note: lastNoteByTargetId.get(source.targetId),
        countLabel: getDiscoverySourceRunCountLabel(
          {
            summary: {
              ...latestRun.summary,
              report: latestRun.summary.report
                ? {
                    ...latestRun.summary.report,
                    sources: reported ? [reported] : [],
                  }
                : latestRun.summary.report,
            },
            targetExecutions: [source],
          },
          source.targetId,
        ),
      };
    });
  }, [discoveryTargets, latestRun]);
  return (
    <ul className="mt-2 grid gap-2">
      {rows.map(({ source, label, note, countLabel }) => {
        return (
          <li key={source.targetId}>
            <p className="font-medium">
              {label}:{" "}
              {source.state === "failed"
                ? "Could not finish"
                : source.state === "cancelled"
                  ? "Stopped"
                  : source.state === "completed"
                    ? "Completed"
                    : latestRun.state === "cancelled" ||
                        getDiscoveryRunPhase(latestRun) === "interrupted"
                      ? "Not searched"
                      : "Waiting"}
            </p>
            <p>{countLabel}.</p>
            {note ? <p className="break-words">{note}</p> : null}
            {source.state === "failed" ? (
              <div className="flex items-center gap-2">
                <span>{discoverySourceFailureCopy(source.warning)}</span>
                {onRetrySource ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isSearchInProgress}
                    onClick={() => onRetrySource(source.targetId)}
                  >
                    Retry {label}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
