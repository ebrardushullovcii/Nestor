import { discoverySourceFailureCopy } from "../discovery/discovery-source-failure-copy";
import { describeFailure } from "../../lib/describe-failure";
import {
  DISCOVERY_RUN_ALREADY_ACTIVE_MESSAGE,
  describeDiscoveryRunFailureReason,
  getDefaultCampaignConfiguration,
  type CampaignDigest,
  type CampaignPauseWindow,
  type CampaignRuleFunnelProjection,
  type CandidateProfile,
  type DiscoveryRunRecord,
  type JobSearchCampaign,
  type PlanSafeguardPause,
  type JobSearchCampaignMode,
  type JobSearchCampaignSchedule,
  type JobSearchPreferences,
  type SaveCampaignRuleInput,
  type SaveJobSearchCampaignInput,
} from "@nordri/contracts";
import { trackerTimeToIso } from "../applications/applications-tracker-time";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CollectionNoMatches,
  CollectionSearchToolbar,
  matchesCollectionSearch,
} from "../../components/collection-search-toolbar";
import { EmptyState } from "../../components/empty-state";
import {
  CollectionPagination,
  COLLECTION_PAGE_SIZE,
} from "../../components/collection-pagination";
import { PageHeaderStack } from "../../components/page-header";
import { usePersistedCollectionView } from "../../hooks/use-persisted-collection-view";
import { CampaignConfirmDialog } from "./campaign-confirm-dialog";
import { CampaignRuleBuilder } from "./campaign-rule-builder";
import { getJobFinderDateInputLocale } from "../../lib/job-finder-date-input-locale";
import {
  deviceTimeZone,
  formatPlanTimestamp,
  inferProfileTimeZone,
  isSupportedTimeZone,
  resolvePlanTimeZone,
} from "../../lib/job-finder-timestamp-format";
import {
  jobSourceLabel,
  deriveJobSourceLabel,
} from "../../lib/job-source-display-name";
import {
  formatDiscoveryRunReportLabel,
  getDiscoveryRunReportCounts,
  hasDiscoveryRunReportCounts,
  readDiscoveryRunReportCounts,
  type DiscoveryRunReportCounts,
} from "../../lib/discovery-run-count-label";

function isHostOnlySourceLabel(label: string, startingUrl: string): boolean {
  try {
    return label === new URL(startingUrl).hostname;
  } catch {
    return false;
  }
}

function resolvePlanSourceIds(
  campaign: Pick<
    JobSearchCampaign,
    "searchPreferences" | "sourceTargetIds" | "sourceSelectionMode"
  >,
): string[] {
  const selectedIds = new Set(campaign.sourceTargetIds ?? []);
  const followsProfile =
    campaign.sourceSelectionMode === "profile" ||
    (campaign.sourceSelectionMode === undefined && selectedIds.size === 0);
  return campaign.searchPreferences.discovery.targets
    .filter((target) =>
      followsProfile ? target.enabled : selectedIds.has(target.id),
    )
    .map((target) => target.id);
}

const jobFinderDateInputLocale = getJobFinderDateInputLocale();

const splitList = (value: string) =>
  value
    .split(/[,;\r\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean);

// A comma-separated list field that keeps the person's raw text while they
// type, so the space between two words and a trailing comma survive until the
// next entry is typed. The parsed list is what the plan stores.
function ListTextInput(props: {
  onChange: (values: string[]) => void;
  placeholder: string;
  values: readonly string[];
  preserveCommas?: boolean;
  title?: string;
}) {
  const parse = useCallback(
    (value: string) =>
      props.preserveCommas
        ? value
            .split(/[;\r\n]+/u)
            .map((item) => item.trim())
            .filter(Boolean)
        : splitList(value),
    [props.preserveCommas],
  );
  const joined = props.values.join(props.preserveCommas ? "; " : ", ");
  const [text, setText] = useState(joined);
  useEffect(() => {
    setText((current) =>
      parse(current).join(props.preserveCommas ? "; " : ", ") === joined
        ? current
        : joined,
    );
  }, [joined, parse, props.preserveCommas]);
  return (
    <Input
      title={props.title}
      onBlur={() => setText(joined)}
      onChange={(event) => {
        setText(event.target.value);
        props.onChange(parse(event.target.value));
      }}
      placeholder={props.placeholder}
      value={text}
    />
  );
}

const runOutcomeLabels: Record<
  NonNullable<JobSearchCampaignSchedule["runFacts"]["lastRunOutcome"]>,
  string
> = {
  success: "Finished",
  partial: "Finished with some sources incomplete",
  failed: "Failed",
  skipped: "Skipped",
};

function describePlanHistory(
  entry: JobSearchCampaign["history"][number],
): string {
  if (entry.kind === "activated") return "Made current.";
  if (entry.kind === "created") {
    if (entry.summary.endsWith("created in precision mode."))
      return "Created with the Focused search setting.";
    if (entry.summary.endsWith("created in scale mode."))
      return "Created with the Wider search setting.";
  }
  return entry.summary;
}

function localTimeZone(): string {
  return deviceTimeZone();
}

function supportedTimeZones(): readonly string[] {
  const withValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  return withValues.supportedValuesOf?.("timeZone") ?? [localTimeZone()];
}

function isValidTimeZone(timeZone: string): boolean {
  return isSupportedTimeZone(timeZone);
}

/** Why an automatic schedule cannot run yet, in the user's words. */
function describeTimeZoneProblem(timeZone: string | null): string | null {
  if (!timeZone?.trim()) {
    return "Pick your time zone so the daily search knows when the start time is.";
  }
  return isValidTimeZone(timeZone)
    ? null
    : "That is not a time zone Job Finder recognises. Pick one from the list, like Europe/Belgrade.";
}

/**
 * Schedule times are printed on the plan's own clock, never the device's, and
 * the zone is always named.
 *
 * A plan whose start time was typed as 08:00 in America/Chicago rendered as
 * "3:00 PM" on a device in Europe, beside a last run of "8:01 AM" — two
 * clocks side by side on one card. Naming the zone only when it differed from
 * the device then produced the opposite complaint: "Sep 12, 5:41 AM CDT" on
 * one card and "Sep 12, 12:42 PM" on the next, one kind of fact in two
 * shapes. Every plan timestamp now goes through the one shared formatter.
 */
function formatDateTime(
  iso: string | null,
  timeZone?: string | null,
): string | null {
  return formatPlanTimestamp(iso, timeZone);
}

function formatPlanCardDateTime(iso: string | null): string | null {
  return formatPlanTimestamp(iso, deviceTimeZone(), { includeZoneName: false });
}

function describeScheduleStart(
  schedule: JobSearchCampaignSchedule,
): string | null {
  if (
    !schedule.enabled ||
    schedule.mode === "manual" ||
    !schedule.localStartTime
  ) {
    return null;
  }
  const [hourText, minuteText] = schedule.localStartTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const hour12 = hour % 12 || 12;
  const suffix = hour < 12 ? "AM" : "PM";
  const time = `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
  const zone = schedule.timeZone?.trim();
  const days =
    schedule.mode === "selected_days"
      ? [...new Set(schedule.daysOfWeek)]
          .sort((a, b) => a - b)
          .map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day])
          .join(", ")
      : null;
  const start = days ? `Runs ${days} at ${time}` : `Runs at ${time}`;
  return zone && zone !== deviceTimeZone() ? `${start} ${zone}` : start;
}

function describeNextRun(schedule: JobSearchCampaignSchedule): string {
  const nextRunAt = schedule.runFacts.nextRunAt;
  if (nextRunAt === null) {
    if (!schedule.enabled || schedule.mode === "manual") {
      return "No scheduled run";
    }
    return "Next run not scheduled yet";
  }
  return `${formatPlanTimestamp(nextRunAt, schedule.timeZone)} (${resolvePlanTimeZone(schedule.timeZone)})`;
}

/**
 * Why Run now cannot start, in the service's own words.
 *
 * Only one search runs at a time, and the service refuses the second one. The
 * button used to stay enabled and swallow the click, so the person clicked it
 * again and again with nothing on screen to explain it.
 */
function describeActiveRunBlock(
  campaignId: string,
  activeRun: { campaignId: string | null } | null,
): string | null {
  if (!activeRun) {
    return null;
  }
  return activeRun.campaignId === campaignId
    ? DISCOVERY_RUN_ALREADY_ACTIVE_MESSAGE
    : "A search is already running for another plan. Wait for it to finish, then run this one.";
}

/**
 * The one record this card describes a finished run from: the digest's own
 * frozen report, with the run record only as a fallback for digests written
 * before the report existed.
 *
 * This screen lists every plan but is only given the ACTIVE plan's run
 * records, so looking the run up by id found nothing for every other card and
 * a search that had just finished reported no counts at all.
 */
function readPlanRunReport(
  runs: readonly DiscoveryRunRecord[] | undefined,
  digest: CampaignDigest | null,
): DiscoveryRunReportCounts {
  const run = (runs ?? []).find(
    (candidate) => candidate.id === digest?.discoveryRunId,
  );
  const fromRun = getDiscoveryRunReportCounts(run ?? null);
  if (hasDiscoveryRunReportCounts(fromRun)) return fromRun;
  return readDiscoveryRunReportCounts(digest?.report ?? null);
}

/**
 * Why the run behind this digest failed, or null when it did not fail.
 *
 * The breakdown used to end on "No source problems in this run." for a run
 * that never reached a source at all, which reads as a clean run over an
 * empty result. A failed run names its reason here instead.
 */
export function describePlanRunFailure(
  runs: readonly DiscoveryRunRecord[] | undefined,
  digest: CampaignDigest | null,
): string | null {
  const run = (runs ?? []).find(
    (candidate) => candidate.id === digest?.discoveryRunId,
  );
  if (digest?.outcome === "interrupted")
    return "This search was interrupted when the app closed.";
  if (digest?.outcome === "stopped" || run?.state === "cancelled")
    return "This search was stopped before all sources finished.";
  const reason = describeDiscoveryRunFailureReason(run ?? null);
  return reason
    ? describeFailure(reason, {
        unknownSentence:
          reason.includes("page.") || reason.includes("\u001b")
            ? "The source could not be read. Try again."
            : reason,
      }).sentence
    : null;
}

/**
 * The opening words of the run-level notice written by the discovery run when
 * every job its sources returned was a remote listing while the plan asked for
 * a place. Matching on the opening words, not the whole sentence, keeps the
 * card readable when the plan's places have been edited since that run.
 */
const REMOTE_ONLY_SOURCE_WARNING_OPENING =
  "This search returned only remote jobs";

/**
 * Remote-only results for this plan's own last finished run.
 *
 * A plan that asks for a place with Remote unticked can be fed nothing but
 * remote listings by its sources, and every one of them then scores as out of
 * area. The run records that as a warning; without it on the card, the plan
 * looked correctly set up and the results looked inexplicable. The card names
 * the plan's current places, so the fix it asks for is the one that helps.
 */
function describeRemoteOnlySourceWarning(
  runs: readonly DiscoveryRunRecord[] | undefined,
  campaign: JobSearchCampaign,
): string | null {
  const { locations, workModes } = campaign.searchPreferences;

  if (locations.length === 0 || workModes.includes("remote")) {
    return null;
  }

  const lastFinishedRun = (runs ?? [])
    .filter((run) => run.campaignId === campaign.id && run.completedAt !== null)
    .reduce<DiscoveryRunRecord | null>(
      (latest, run) =>
        latest === null || (run.completedAt ?? "") > (latest.completedAt ?? "")
          ? run
          : latest,
      null,
    );

  const recorded = lastFinishedRun?.summary.warnings.some(
    (warning) =>
      warning.startsWith(REMOTE_ONLY_SOURCE_WARNING_OPENING) ||
      warning.startsWith("Your sources only list remote jobs"),
  );

  return recorded === true
    ? `${REMOTE_ONLY_SOURCE_WARNING_OPENING}; try another search for jobs in ${locations.join(" or ")}.`
    : null;
}

/**
 * The frozen "N looked at · M new · K kept · D already here" line for the run this digest
 * describes. A run recorded before the report existed says so rather than
 * printing a number this card recomputed from the plan's current membership.
 */
export function describePlanRunCounts(
  report: DiscoveryRunReportCounts,
): string {
  return hasDiscoveryRunReportCounts(report)
    ? formatDiscoveryRunReportLabel(report)
    : "Counts were not recorded for this run.";
}

function describePlanRunPopulations(
  report: DiscoveryRunReportCounts,
  digest: CampaignDigest,
): string {
  if (!hasDiscoveryRunReportCounts(report)) {
    return describePlanRunCounts(report);
  }
  const kept = report.retained ?? 0;
  const cap = digest.report?.retentionLimitApplied;
  const capSentence =
    cap !== null && cap !== undefined && kept >= cap
      ? ` · ${cap}-job plan limit reached`
      : "";
  return `${describePlanRunCounts(report)}${capSentence}`;
}

/**
 * "Last run" never denies a run this same card is counting.
 *
 * The schedule's run facts are written when a plan's run reaches its terminal
 * commit. A plan whose results were counted some other way — recovered on
 * startup, or written before those facts existed — kept "No run yet" on a card
 * that said "Jobs in this plan 50" two lines above. When the plan's own
 * progress or its latest digest witnesses a run, that timestamp is printed
 * with the outcome left unstated rather than contradicted.
 */
function describeLastRun(
  schedule: JobSearchCampaignSchedule,
  witnessedRunAt?: string | null,
  /**
   * The frozen report for the run this card is describing, when the card has
   * one. R8: "Last run skipped" sat directly above that same run's own
   * "97 found · 97 new · 15 kept", and "(outcome not recorded)" was printed
   * for a run whose counts were on screen. A run with a report ran.
   */
  report?: DiscoveryRunReportCounts | null,
  run?: DiscoveryRunRecord | null,
  digest?: CampaignDigest | null,
): string {
  const stopped = digest?.outcome === "stopped" || run?.state === "cancelled";
  const interrupted =
    digest?.outcome === "interrupted" || run?.runPhase === "interrupted";
  if (stopped || interrupted) {
    return `${interrupted ? "Interrupted" : "Stopped"} · ${formatPlanCardDateTime(run?.completedAt ?? run?.startedAt ?? digest?.generatedAt ?? null) ?? "unknown time"}`;
  }
  const facts = schedule.runFacts;
  const runIsWitnessedByItsReport = report
    ? hasDiscoveryRunReportCounts(report)
    : false;
  if (facts.lastRunAt !== null && facts.lastRunOutcome !== null) {
    const at = formatPlanCardDateTime(facts.lastRunAt) ?? "unknown time";
    // "Skipped" belongs to a scheduled run that never started. A run that
    // reported what it found is not one of those, whatever the stored
    // outcome says.
    if (facts.lastRunOutcome === "skipped" && runIsWitnessedByItsReport) {
      return `Ran · ${at}`;
    }
    const outcome =
      runOutcomeLabels[facts.lastRunOutcome] ?? facts.lastRunOutcome;
    return `${outcome} · ${at}`;
  }
  const witnessed = formatPlanCardDateTime(
    facts.lastRunAt ?? witnessedRunAt ?? null,
  );
  if (witnessed === null) {
    return "No run yet";
  }
  return runIsWitnessedByItsReport
    ? `Ran · ${witnessed}`
    : `Ran · ${witnessed} (outcome not recorded)`;
}

function campaignToInput(
  campaign: JobSearchCampaign,
): SaveJobSearchCampaignInput {
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    mode: campaign.mode,
    status: campaign.status,
    searchPreferences: campaign.searchPreferences,
    sourceTargetIds: campaign.sourceTargetIds,
    sourceSelectionMode: campaign.sourceSelectionMode,
    minimumFitScore: campaign.minimumFitScore,
    limits: campaign.limits,
    stopRules: campaign.stopRules,
    applicationPolicy: campaign.applicationPolicy,
    schedule: campaign.schedule,
    rules: campaign.rules,
    latestDigest: campaign.latestDigest,
  };
}

function newCampaignFrom(
  campaign: JobSearchCampaign | null,
): SaveJobSearchCampaignInput {
  const defaults = getDefaultCampaignConfiguration("precision");
  const searchPreferences: JobSearchPreferences =
    campaign?.searchPreferences ?? {
      targetRoles: [],
      jobFamilies: [],
      locations: [],
      excludedLocations: [],
      workModes: ["remote"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: null,
        currencyStatus: "needs_clarification",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: {
        targets: [],
        historyLimit: 5,
      },
    };
  return {
    id: null,
    name: "New search plan",
    description: "",
    mode: "precision",
    status: "active",
    searchPreferences,
    sourceTargetIds: campaign?.sourceTargetIds ?? [],
    sourceSelectionMode:
      campaign?.sourceSelectionMode ??
      (campaign?.sourceTargetIds.length ? "selected" : "profile"),
    minimumFitScore: campaign?.minimumFitScore ?? null,
    limits: defaults.limits,
    stopRules: defaults.stopRules,
    applicationPolicy: defaults.applicationPolicy,
    rules: [],
    latestDigest: null,
    schedule: {
      mode: "manual",
      enabled: false,
      daysOfWeek: [],
      localStartTime: null,
      timeZone: null,
      pauseWindows: [],
      runFacts: {
        nextRunAt: null,
        lastRunAt: null,
        lastRunOutcome: null,
        lastRunSummary: null,
        consecutiveFailures: 0,
      },
    },
  };
}

function CampaignEditor(props: {
  campaign: SaveJobSearchCampaignInput;
  defaultScheduleTimeZone: { timeZone: string; source: "profile" | "device" };
  isCurrentPlan: boolean;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Makes this saved plan the one Find jobs searches with. */
  onMakeCurrent?: () => void;
  /** Starts a search with this saved plan right away. */
  onRunNow?: () => void;
  onSave: (campaign: SaveJobSearchCampaignInput) => Promise<boolean>;
  /**
   * Called once a save actually lands, so the screen can close this form and
   * own the confirmation. R6: the form used to stay open holding its pre-save
   * draft, so its own "Run status" block read "Next run not scheduled yet"
   * while the card directly below already read the saved next run time — and
   * Cancel then claimed unsaved edits for a plan that had just been saved.
   */
  onSaved?: (campaign: SaveJobSearchCampaignInput) => void;
  pending: boolean;
  runPending?: boolean;
}) {
  const [draft, setDraft] = useState(props.campaign);
  const [sourcePage, setSourcePage] = useState(1);
  // The same rule the run uses: the plan's own selection, or Profile's
  // Include in search when the plan has not chosen any.
  const includedSourceIds = useMemo(
    () => resolvePlanSourceIds(draft),
    [
      draft.sourceTargetIds,
      draft.sourceSelectionMode,
      draft.searchPreferences.discovery.targets,
    ],
  );
  const includedSourceIdSet = useMemo(
    () => new Set(includedSourceIds),
    [includedSourceIds],
  );
  const sources = draft.searchPreferences.discovery.targets;
  const sourcePageCount = Math.max(
    1,
    Math.ceil(sources.length / COLLECTION_PAGE_SIZE),
  );
  const currentSourcePage = Math.min(sourcePage, sourcePageCount);
  const pagedSources = sources.slice(
    (currentSourcePage - 1) * COLLECTION_PAGE_SIZE,
    currentSourcePage * COLLECTION_PAGE_SIZE,
  );
  useEffect(() => {
    setSourcePage((current) => Math.min(current, sourcePageCount));
  }, [sourcePageCount]);
  const plannedSourceCount = includedSourceIds.length;
  const followsProfileSources =
    draft.sourceSelectionMode === "profile" ||
    (draft.sourceSelectionMode === undefined &&
      draft.sourceTargetIds.length === 0);
  // The baseline a dirty check compares against moves forward on every
  // successful save, so a saved plan is never treated as an unsaved draft.
  const [baselineCampaign, setBaselineCampaign] = useState(props.campaign);
  const [pauseWindowStartsAt, setPauseWindowStartsAt] = useState("");
  const [pauseWindowEndsAt, setPauseWindowEndsAt] = useState("");
  const [pauseWindowReason, setPauseWindowReason] = useState("");
  const [saveOutcome, setSaveOutcome] = useState<"saved" | null>(null);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  // By content, not identity: typing a change and then undoing it is not an
  // unsaved edit, so leaving should not ask to discard it.
  const dirty = useMemo(
    () =>
      draft !== baselineCampaign &&
      JSON.stringify(draft) !== JSON.stringify(baselineCampaign),
    [draft, baselineCampaign],
  );
  const cannotArchiveCurrentPlan =
    props.isCurrentPlan && draft.status === "archived";
  useEffect(() => {
    props.onDirtyChange?.(dirty);
  }, [dirty, props.onDirtyChange]);

  const requestCancel = () => {
    if (!dirty) {
      props.onCancel();
      return;
    }
    // Dirty editors meet an app-owned confirmation instead of a native
    // window.confirm; staying is the safe default.
    setDiscardConfirmationOpen(true);
  };
  const pauseWindowStart = trackerTimeToIso(
    pauseWindowStartsAt,
    resolvePlanTimeZone(draft.schedule.timeZone),
  );
  const pauseWindowEnd = trackerTimeToIso(
    pauseWindowEndsAt,
    resolvePlanTimeZone(draft.schedule.timeZone),
  );
  const pauseWindowValidationMessage =
    pauseWindowStartsAt.trim() && pauseWindowStart === null
      ? "Enter a valid start date and time."
      : pauseWindowEndsAt.trim() && pauseWindowEnd === null
        ? "Enter a valid end date and time."
        : pauseWindowStart !== null &&
            pauseWindowEnd !== null &&
            Date.parse(pauseWindowEnd) <= Date.parse(pauseWindowStart)
          ? "The end has to be later than the start."
          : null;
  const updateMode = (mode: JobSearchCampaignMode) => {
    const defaults = getDefaultCampaignConfiguration(mode);
    setDraft((current) => ({
      ...current,
      mode,
      limits: {
        ...current.limits,
        retainedJobTarget: defaults.limits.retainedJobTarget,
        analysisConcurrency: defaults.limits.analysisConcurrency,
        discoveryRunJobBudget: defaults.limits.discoveryRunJobBudget,
      },
    }));
  };

  const timeZoneProblem =
    draft.schedule.enabled && draft.schedule.mode !== "manual"
      ? describeTimeZoneProblem(draft.schedule.timeZone)
      : null;
  const updateSchedule = (patch: Partial<JobSearchCampaignSchedule>) => {
    setDraft((current) => ({
      ...current,
      schedule: { ...current.schedule, ...patch },
    }));
  };

  const addPauseWindow = () => {
    if (
      pauseWindowStart === null ||
      pauseWindowEnd === null ||
      pauseWindowValidationMessage !== null
    ) {
      return;
    }
    const window: CampaignPauseWindow = {
      id: `pause_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      startsAt: pauseWindowStart,
      endsAt: pauseWindowEnd,
      reason: pauseWindowReason.trim() || null,
      enabled: true,
    };
    updateSchedule({ pauseWindows: [...draft.schedule.pauseWindows, window] });
    setPauseWindowStartsAt("");
    setPauseWindowEndsAt("");
    setPauseWindowReason("");
  };

  const updatePauseWindow = (
    windowId: string,
    patch: Partial<CampaignPauseWindow>,
  ) => {
    updateSchedule({
      pauseWindows: draft.schedule.pauseWindows.map((window) =>
        window.id === windowId ? { ...window, ...patch } : window,
      ),
    });
  };

  const removePauseWindow = (windowId: string) => {
    updateSchedule({
      pauseWindows: draft.schedule.pauseWindows.filter(
        (window) => window.id !== windowId,
      ),
    });
  };

  const saveDraft = () => {
    if (cannotArchiveCurrentPlan) return;
    setSaveOutcome(null);
    void props.onSave(draft).then((saved) => {
      if (!saved) return;
      setBaselineCampaign(draft);
      if (props.campaign.id !== null) {
        setSaveOutcome("saved");
      }
      props.onSaved?.(draft);
    });
  };

  return (
    <>
      <form
        className="surface-panel-shell grid gap-5 rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            requestCancel();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          saveDraft();
        }}
      >
        <div>
          <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
            Search plan setup
          </p>
          <h2 className="mt-1 font-semibold text-(--text-headline)">
            {draft.id ? "Edit search plan" : "Create search plan"}
          </h2>
        </div>

        <label className="grid gap-1 text-sm">
          Search pickiness
          <select
            aria-label="Search pickiness"
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            value={draft.searchPreferences.searchSelectivity ?? ""}
            onChange={(event) => {
              const searchPreferences = { ...draft.searchPreferences };
              if (event.target.value === "") {
                delete searchPreferences.searchSelectivity;
              } else {
                searchPreferences.searchSelectivity = event.target.value as
                  | "best_matches"
                  | "balanced"
                  | "wide_net";
              }
              setDraft({ ...draft, searchPreferences });
            }}
          >
            <option value="">Use Settings</option>
            <option value="best_matches">Best matches only</option>
            <option value="balanced">Balanced</option>
            <option value="wide_net">Cast a wide net</option>
          </select>
          <span className="text-xs text-foreground-muted">
            {draft.searchPreferences.searchSelectivity
              ? "This choice applies to every run of this plan, including scheduled searches."
              : "This plan uses the search pickiness saved in Settings."}
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Name</span>
            <Input
              maxLength={120}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
              required
              value={draft.name}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">How many jobs each search keeps</span>
            <select
              aria-label="How many jobs each search keeps"
              className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
              onChange={(event) =>
                updateMode(event.target.value as JobSearchCampaignMode)
              }
              value={draft.mode}
            >
              <option value="precision">
                Focused — fewer jobs, closest matches
              </option>
              <option value="scale">Wide — more jobs, more to review</option>
            </select>
            <span className="text-xs text-foreground-muted">
              {draft.mode === "scale"
                ? "More jobs each run, keeping more of them for review."
                : "Fewer jobs each run, chosen for a closer match."}
            </span>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Status</span>
            <select
              className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  status: event.target
                    .value as SaveJobSearchCampaignInput["status"],
                })
              }
              value={draft.status}
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
              <option disabled={props.isCurrentPlan} value="archived">
                Archived
              </option>
            </select>
          </label>
        </div>
        {props.isCurrentPlan ? (
          <p className="text-sm text-foreground-muted">
            To archive this plan, make another plan current first. Create a new
            plan if you need one.
          </p>
        ) : null}
        {saveOutcome === "saved" ? (
          // A save is not the end of the job: the plan only matters once a
          // search runs with it, so the confirmation says when that happens
          // and offers the one step that makes it happen.
          <div
            className="flex flex-wrap items-center gap-3 rounded-(--radius-field) border border-border-subtle px-4 py-3 text-sm text-foreground"
            role="status"
          >
            <span>
              {props.isCurrentPlan
                ? "Search plan saved. Your next search uses it."
                : "Search plan saved. Find jobs keeps searching with your current plan until you switch to this one."}
            </span>
            {props.isCurrentPlan &&
            props.onRunNow &&
            draft.status === "active" ? (
              <Button
                onClick={props.onRunNow}
                pending={props.runPending ?? false}
                size="xs"
                type="button"
                variant="outline"
              >
                Search now with this plan
              </Button>
            ) : null}
            {!props.isCurrentPlan &&
            props.onMakeCurrent &&
            draft.status !== "archived" ? (
              <Button
                onClick={props.onMakeCurrent}
                pending={props.pending}
                size="xs"
                type="button"
                variant="outline"
              >
                Use it in Find jobs
              </Button>
            ) : null}
          </div>
        ) : null}
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Plan purpose</span>
          <textarea
            className="min-h-20 rounded-(--radius-field) border border-(--field-border) bg-(--field) p-3 outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            maxLength={2_000}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value })
            }
            placeholder="Example: Remote TypeScript roles with strong product ownership"
            value={draft.description}
          />
        </label>

        <details
          className="rounded-(--radius-field) border border-border-subtle p-4"
          open
        >
          <summary className="cursor-pointer font-semibold text-(--text-headline)">
            Roles, locations, and work style
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span>Target roles</span>
              <ListTextInput
                onChange={(values) =>
                  setDraft({
                    ...draft,
                    searchPreferences: {
                      ...draft.searchPreferences,
                      targetRoles: values,
                    },
                  })
                }
                placeholder="Software engineer, Frontend engineer"
                values={draft.searchPreferences.targetRoles}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span>Preferred locations</span>
              <ListTextInput
                onChange={(values) =>
                  setDraft({
                    ...draft,
                    searchPreferences: {
                      ...draft.searchPreferences,
                      locations: values,
                    },
                  })
                }
                preserveCommas
                placeholder="Seattle, WA; Portland, OR"
                title="Separate places with semicolons. Commas stay within a place."
                values={draft.searchPreferences.locations}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span>Excluded locations</span>
              <ListTextInput
                onChange={(values) =>
                  setDraft({
                    ...draft,
                    searchPreferences: {
                      ...draft.searchPreferences,
                      excludedLocations: values,
                    },
                  })
                }
                preserveCommas
                placeholder="Paris; Berlin"
                values={draft.searchPreferences.excludedLocations}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span>Excluded companies</span>
              <ListTextInput
                onChange={(values) =>
                  setDraft({
                    ...draft,
                    searchPreferences: {
                      ...draft.searchPreferences,
                      companyBlacklist: values,
                    },
                  })
                }
                placeholder="Companies to skip"
                values={draft.searchPreferences.companyBlacklist}
              />
            </label>
            <fieldset className="grid gap-2 sm:col-span-2">
              <legend className="text-sm">Work modes</legend>
              <div className="flex flex-wrap gap-4">
                {(["remote", "hybrid", "onsite", "flexible"] as const).map(
                  (mode) => (
                    <label
                      className="flex items-center gap-2 text-sm capitalize"
                      key={mode}
                    >
                      <input
                        checked={draft.searchPreferences.workModes.includes(
                          mode,
                        )}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            searchPreferences: {
                              ...draft.searchPreferences,
                              workModes: event.target.checked
                                ? [...draft.searchPreferences.workModes, mode]
                                : draft.searchPreferences.workModes.filter(
                                    (item) => item !== mode,
                                  ),
                            },
                          })
                        }
                        type="checkbox"
                      />
                      {mode}
                    </label>
                  ),
                )}
              </div>
            </fieldset>
          </div>
        </details>

        <details
          className="rounded-(--radius-field) border border-border-subtle p-4"
          open
        >
          <summary className="cursor-pointer font-semibold text-(--text-headline)">
            Sources and compensation
          </summary>
          <div className="mt-4 grid gap-4">
            <fieldset className="grid gap-2">
              <legend className="text-sm">Included sources</legend>
              <p className="text-xs leading-5 text-foreground-muted">
                These sources control new searches. Saved jobs may be shared
                with other plans when they match this plan’s roles and places.
                When using Profile, newly enabled sources are included
                automatically. Choosing individual sources keeps that list.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={followsProfileSources}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      sourceSelectionMode: event.target.checked
                        ? "profile"
                        : "selected",
                      sourceTargetIds: includedSourceIds,
                    })
                  }
                />
                Use enabled sources from Profile
              </label>
              <div className="grid max-h-44 gap-2 overflow-y-auto rounded-(--radius-field) border border-border-subtle p-3 sm:grid-cols-2">
                {pagedSources.map((target) => (
                  <label
                    className="flex items-center gap-2 text-sm"
                    key={target.id}
                  >
                    <input
                      aria-label={
                        isHostOnlySourceLabel(target.label, target.startingUrl)
                          ? deriveJobSourceLabel(target.startingUrl)
                          : target.label
                      }
                      checked={includedSourceIdSet.has(target.id)}
                      onChange={(event) => {
                        setDraft({
                          ...draft,
                          // A plan owns only its selected ids. The source's
                          // Profile-level Include flag is a separate choice
                          // and must not be rewritten by this checkbox.
                          sourceSelectionMode: "selected",
                          sourceTargetIds: event.target.checked
                            ? [...new Set([...includedSourceIds, target.id])]
                            : includedSourceIds.filter(
                                (candidateId) => candidateId !== target.id,
                              ),
                        });
                      }}
                      type="checkbox"
                    />
                    <span className="min-w-0">
                      <span className="block">
                        {isHostOnlySourceLabel(target.label, target.startingUrl)
                          ? deriveJobSourceLabel(target.startingUrl)
                          : target.label}
                      </span>
                      {!target.enabled && includedSourceIdSet.has(target.id) ? (
                        <span className="block text-xs text-foreground-muted">
                          Off in Profile; this plan still searches it
                        </span>
                      ) : null}
                      <span className="block break-all text-xs text-foreground-muted">
                        {target.startingUrl}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <CollectionPagination
                itemLabel="sources"
                onPageChange={setSourcePage}
                page={currentSourcePage}
                pageSize={COLLECTION_PAGE_SIZE}
                totalCount={sources.length}
              />
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="grid gap-1 text-sm">
                <span>Minimum compensation</span>
                <Input
                  min={0}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      searchPreferences: {
                        ...draft.searchPreferences,
                        compensation: {
                          ...draft.searchPreferences.compensation,
                          minimum: event.target.value
                            ? Number(event.target.value)
                            : null,
                        },
                      },
                    })
                  }
                  type="number"
                  value={draft.searchPreferences.compensation.minimum ?? ""}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span>Currency</span>
                <Input
                  maxLength={3}
                  onChange={(event) => {
                    const currency = event.target.value.trim().toUpperCase();
                    setDraft({
                      ...draft,
                      searchPreferences: {
                        ...draft.searchPreferences,
                        compensation: {
                          ...draft.searchPreferences.compensation,
                          currency: currency || null,
                          currencyStatus: currency
                            ? "explicit"
                            : "needs_clarification",
                        },
                      },
                    });
                  }}
                  placeholder="USD"
                  value={draft.searchPreferences.compensation.currency ?? ""}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span>Target compensation</span>
                <Input
                  min={0}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      searchPreferences: {
                        ...draft.searchPreferences,
                        compensation: {
                          ...draft.searchPreferences.compensation,
                          maximum: event.target.value
                            ? Number(event.target.value)
                            : null,
                        },
                      },
                    })
                  }
                  type="number"
                  value={draft.searchPreferences.compensation.maximum ?? ""}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span>Pay interval</span>
                <select
                  className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      searchPreferences: {
                        ...draft.searchPreferences,
                        compensation: {
                          ...draft.searchPreferences.compensation,
                          interval: event.target
                            .value as typeof draft.searchPreferences.compensation.interval,
                        },
                      },
                    })
                  }
                  value={draft.searchPreferences.compensation.interval}
                >
                  <option value="hour">Hourly</option>
                  <option value="day">Daily</option>
                  <option value="week">Weekly</option>
                  <option value="month">Monthly</option>
                  <option value="year">Yearly</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Minimum pay counts as
                <select
                  aria-label="Minimum pay counts as"
                  className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
                  value={draft.searchPreferences.compensation.basis ?? "base"}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      searchPreferences: {
                        ...draft.searchPreferences,
                        compensation: {
                          ...draft.searchPreferences.compensation,
                          basis: event.target.value as "base" | "total_ote",
                        },
                      },
                    })
                  }
                >
                  <option value="base">Base salary</option>
                  <option value="total_ote">
                    Total pay including commission (OTE)
                  </option>
                </select>
                <span className="text-xs text-foreground-muted">
                  Job assessments compare pay on this basis. Unclear pay needs
                  review.
                </span>
              </label>
            </div>
          </div>
        </details>

        <section className="grid gap-3 rounded-(--radius-field) border border-border-subtle p-4">
          <div>
            <h3 className="font-semibold text-(--text-headline)">
              Which jobs this plan keeps
            </h3>
            <p className="text-xs text-foreground-muted">
              These two settings decide how many of each search&apos;s results
              stay in this plan and how good a match they have to be.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {/* "86% of what?" — the number was shown with nothing saying
                what it measures or what it does. */}
            <label className="grid gap-1 text-sm">
              <span>Only show jobs scored at least this % fit</span>
              <Input
                max={100}
                min={0}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    minimumFitScore: Number(event.target.value),
                  })
                }
                type="number"
                value={draft.minimumFitScore ?? 0}
              />
              <span className="text-xs text-foreground-muted">
                The fit score is how closely a job matches what you saved about
                yourself — your roles, experience, location and the rest.
                Anything scored lower is kept on this device but not shown.
              </span>
            </label>
            <label className="grid gap-1 text-sm">
              <span>Jobs to retain</span>
              <Input
                max={10_000}
                min={1}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    limits: {
                      ...draft.limits,
                      retainedJobTarget: Number(event.target.value),
                    },
                  })
                }
                type="number"
                value={draft.limits.retainedJobTarget}
              />
              <span className="text-xs text-foreground-muted">
                How many of each search&apos;s results this plan keeps. Anything
                past this number is saved on this device but not shown in Find
                jobs.
              </span>
            </label>
          </div>
        </section>

        {/* A daily run time is not a safety setting. "I would never click
            'Saved safety and automation policy' looking for a daily run
            time" — so when this plan runs is its own section, named for
            what it does, and the safety limits keep theirs. */}
        <section className="rounded-(--radius-field) border border-border-subtle p-4">
          <h3 className="font-semibold text-(--text-headline)">
            Run automatically
          </h3>
          <div className="mt-4 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  checked={draft.schedule.enabled}
                  onChange={(event) =>
                    updateSchedule({
                      enabled: event.target.checked,
                      // A blank zone silently produced no next run; start
                      // from the machine's own zone so "8:00 AM" means
                      // something the moment the schedule is switched on.
                      ...(event.target.checked && !draft.schedule.timeZone
                        ? { timeZone: props.defaultScheduleTimeZone.timeZone }
                        : {}),
                    })
                  }
                  type="checkbox"
                />
                Run this search on a schedule
              </label>
              <label className="grid gap-1 text-sm">
                <span>How often</span>
                <select
                  className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
                  disabled={!draft.schedule.enabled}
                  onChange={(event) =>
                    updateSchedule({
                      mode: event.target
                        .value as JobSearchCampaignSchedule["mode"],
                    })
                  }
                  value={draft.schedule.mode}
                >
                  <option value="manual">Only when I press Run now</option>
                  <option value="daily">Every day</option>
                  <option value="selected_days">On days I choose</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                <span>Start time</span>
                <Input
                  disabled={!draft.schedule.enabled}
                  onChange={(event) =>
                    updateSchedule({
                      localStartTime: event.target.value || null,
                    })
                  }
                  type="time"
                  value={draft.schedule.localStartTime ?? ""}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span>Time zone</span>
                <Input
                  aria-label="Time zone"
                  aria-invalid={timeZoneProblem ? true : undefined}
                  disabled={!draft.schedule.enabled}
                  list="campaign-schedule-time-zones"
                  onChange={(event) =>
                    updateSchedule({ timeZone: event.target.value || null })
                  }
                  placeholder={localTimeZone()}
                  value={draft.schedule.timeZone ?? ""}
                />
                {!timeZoneProblem ? (
                  <span className="text-xs text-foreground-muted">
                    {props.defaultScheduleTimeZone.source === "profile"
                      ? "Defaulted from your profile location."
                      : "Defaulted from this device because your profile location did not identify a time zone."}
                  </span>
                ) : null}
                {timeZoneProblem ? (
                  <span className="text-xs text-destructive" role="alert">
                    {timeZoneProblem}
                  </span>
                ) : null}
              </label>
              <datalist id="campaign-schedule-time-zones">
                {supportedTimeZones().map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </div>
            {draft.schedule.enabled &&
            draft.schedule.mode === "selected_days" ? (
              <fieldset className="grid gap-2">
                <legend className="text-sm">Days to run</legend>
                <div className="flex flex-wrap gap-3">
                  {[
                    [1, "Mon"],
                    [2, "Tue"],
                    [3, "Wed"],
                    [4, "Thu"],
                    [5, "Fri"],
                    [6, "Sat"],
                    [0, "Sun"],
                  ].map(([day, label]) => (
                    <label
                      className="flex items-center gap-1.5 text-sm"
                      key={day}
                    >
                      <input
                        checked={draft.schedule.daysOfWeek.includes(
                          day as number,
                        )}
                        onChange={(event) =>
                          updateSchedule({
                            daysOfWeek: event.target.checked
                              ? [...draft.schedule.daysOfWeek, day as number]
                              : draft.schedule.daysOfWeek.filter(
                                  (savedDay) => savedDay !== day,
                                ),
                          })
                        }
                        type="checkbox"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
            {draft.schedule.enabled && draft.schedule.mode !== "manual" ? (
              <p className="text-xs text-foreground-muted">
                Job Finder starts this search for you at that time, and works
                out the next one. A time you told it not to run, or background
                work being paused, holds the search until that ends.
              </p>
            ) : null}
            <fieldset className="grid gap-2">
              <legend className="text-sm">Times not to run</legend>
              <p className="text-xs text-foreground-muted">
                During one of these times, a search that was due waits and
                starts once the time is over. Run now always works.
              </p>
              {draft.schedule.pauseWindows.length === 0 ? (
                <p className="text-xs text-foreground-muted">
                  No times added yet.
                </p>
              ) : (
                <ul className="grid gap-2">
                  {draft.schedule.pauseWindows.map((window) => (
                    <li
                      className="grid gap-2 rounded-(--radius-field) border border-border-subtle p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                      key={window.id}
                    >
                      <label className="flex items-center gap-1.5 text-sm">
                        <input
                          checked={window.enabled}
                          onChange={(event) =>
                            updatePauseWindow(window.id, {
                              enabled: event.target.checked,
                            })
                          }
                          type="checkbox"
                        />
                        {window.enabled ? "Active" : "Disabled"}
                      </label>
                      <div className="text-sm text-foreground-soft">
                        {formatDateTime(
                          window.startsAt,
                          draft.schedule.timeZone,
                        ) ?? window.startsAt}{" "}
                        →{" "}
                        {formatDateTime(
                          window.endsAt,
                          draft.schedule.timeZone,
                        ) ?? window.endsAt}
                        {window.reason ? ` · ${window.reason}` : ""}
                      </div>
                      <Button
                        onClick={() => removePauseWindow(window.id)}
                        size="xs"
                        type="button"
                        variant="ghost"
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid gap-3 sm:grid-cols-4">
                <label className="grid gap-1 text-sm">
                  <span>
                    Starts ({resolvePlanTimeZone(draft.schedule.timeZone)})
                  </span>
                  <Input
                    aria-label="Do not run from"
                    aria-describedby={
                      pauseWindowValidationMessage
                        ? "pause-window-validation"
                        : undefined
                    }
                    aria-invalid={
                      pauseWindowValidationMessage !== null &&
                      (pauseWindowStart === null || pauseWindowEnd !== null)
                    }
                    onChange={(event) =>
                      setPauseWindowStartsAt(event.target.value)
                    }
                    lang={jobFinderDateInputLocale}
                    type="datetime-local"
                    value={pauseWindowStartsAt}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span>
                    Ends ({resolvePlanTimeZone(draft.schedule.timeZone)})
                  </span>
                  <Input
                    aria-label="Do not run until"
                    aria-describedby={
                      pauseWindowValidationMessage
                        ? "pause-window-validation"
                        : undefined
                    }
                    aria-invalid={
                      pauseWindowValidationMessage !== null &&
                      (pauseWindowEnd === null || pauseWindowStart !== null)
                    }
                    onChange={(event) =>
                      setPauseWindowEndsAt(event.target.value)
                    }
                    lang={jobFinderDateInputLocale}
                    type="datetime-local"
                    value={pauseWindowEndsAt}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span>Reason</span>
                  <Input
                    aria-label="Why not to run then"
                    onChange={(event) =>
                      setPauseWindowReason(event.target.value)
                    }
                    placeholder="Vacation, meetings…"
                    value={pauseWindowReason}
                  />
                </label>
                <Button
                  className="self-end"
                  disabled={
                    pauseWindowStartsAt.trim().length === 0 ||
                    pauseWindowEndsAt.trim().length === 0 ||
                    pauseWindowValidationMessage !== null
                  }
                  onClick={addPauseWindow}
                  type="button"
                  variant="outline"
                >
                  Add a time not to run
                </Button>
              </div>
              {pauseWindowValidationMessage ? (
                <p
                  className="text-sm text-destructive"
                  id="pause-window-validation"
                  role="alert"
                >
                  {pauseWindowValidationMessage}
                </p>
              ) : null}
            </fieldset>
            <div className="grid gap-2 rounded-(--radius-field) border border-border-subtle p-3">
              <h4 className="text-sm font-semibold text-(--text-headline)">
                Run status
              </h4>
              <dl className="grid gap-1 text-sm text-foreground-soft sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-foreground-muted">Next run</dt>
                  <dd>{describeNextRun(draft.schedule)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-foreground-muted">Last run</dt>
                  <dd>{describeLastRun(draft.schedule)}</dd>
                </div>
              </dl>
              {draft.schedule.runFacts.lastRunSummary ? (
                <p className="text-xs text-foreground-muted">
                  {draft.schedule.runFacts.lastRunSummary.includes("page.") ||
                  draft.schedule.runFacts.lastRunSummary.includes("\u001b")
                    ? describeFailure(draft.schedule.runFacts.lastRunSummary)
                        .sentence
                    : draft.schedule.runFacts.lastRunSummary}
                </p>
              ) : null}
              {draft.schedule.runFacts.consecutiveFailures > 0 ? (
                <p className="text-xs text-foreground-muted">
                  {draft.schedule.runFacts.consecutiveFailures} consecutive
                  failed run
                  {draft.schedule.runFacts.consecutiveFailures === 1
                    ? ""
                    : "s"}{" "}
                  recorded.
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <details className="rounded-(--radius-field) border border-border-subtle p-4">
          <summary className="cursor-pointer font-semibold text-(--text-headline)">
            Safety limits
          </summary>
          <div className="mt-4 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span>Pause above failure rate (%)</span>
                <Input
                  max={100}
                  min={1}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      stopRules: {
                        ...draft.stopRules,
                        pauseOnFailureRatePercent: Number(event.target.value),
                      },
                    })
                  }
                  type="number"
                  value={draft.stopRules.pauseOnFailureRatePercent}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span>After at least this many attempts</span>
                <Input
                  min={1}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      stopRules: {
                        ...draft.stopRules,
                        failureRateMinimumSample: Number(event.target.value),
                      },
                    })
                  }
                  type="number"
                  value={draft.stopRules.failureRateMinimumSample}
                />
              </label>
            </div>
            <p className="text-xs text-foreground-muted">
              Failure-rate and page-change stop rules are enforced by the
              preparation runner: it pauses on configured login blockers,
              changed or unexpected forms, unresolved eligibility, and a
              configured cumulative blocked/failed rate after its minimum
              sample.
            </p>
            {(
              [
                ["pauseOnChangedForm", "Pause if an application form changes"],
                [
                  "pauseOnUncertainEligibility",
                  "Pause when eligibility is uncertain",
                ],
                ["pauseOnLoginRequired", "Pause when a source needs sign-in"],
              ] as const
            ).map(([key, label]) => (
              <label className="flex items-center gap-2 text-sm" key={key}>
                <input
                  checked={draft.stopRules[key]}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      stopRules: {
                        ...draft.stopRules,
                        [key]: event.target.checked,
                      },
                    })
                  }
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </div>
        </details>

        <p className="text-xs text-foreground-muted">
          Searches {plannedSourceCount} job{" "}
          {plannedSourceCount === 1 ? "site" : "sites"} for{" "}
          {draft.searchPreferences.targetRoles.length}{" "}
          {draft.searchPreferences.targetRoles.length === 1 ? "role" : "roles"}{" "}
          you saved in this plan.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={requestCancel} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={
              draft.name.trim().length === 0 || cannotArchiveCurrentPlan
            }
            pending={props.pending}
            type="submit"
          >
            Save search plan
          </Button>
        </div>
      </form>
      <CampaignConfirmDialog
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        detail={`${draft.name} still has edits that were not saved. Discarding loses them; saving keeps them. This cannot be undone.`}
        eyebrow="Unsaved search-plan draft"
        onCancel={() => setDiscardConfirmationOpen(false)}
        onConfirm={() => {
          // Close first, then cancel once: the dialog's own guard plus this
          // ordering make a double activation impossible to repeat.
          setDiscardConfirmationOpen(false);
          props.onCancel();
        }}
        open={discardConfirmationOpen}
        title="Discard unsaved search-plan changes?"
      />
    </>
  );
}

export function CampaignsScreen(props: {
  safeguardPauses?: readonly PlanSafeguardPause[];
  /**
   * Finished runs, so the plan card can quote the run's own frozen counts
   * instead of describing the same search with plan-side totals.
   */
  discoveryRuns?: readonly DiscoveryRunRecord[];
  /**
   * The search that is running right now, if any. One runs at a time, so this
   * is what tells every plan card whether Run now can start.
   */
  activeDiscoveryRun?: Pick<DiscoveryRunRecord, "campaignId"> | null;
  activeCampaignId: string;
  campaigns: readonly JobSearchCampaign[];
  /**
   * Open this plan's editor on arrival. Find jobs' "Edit this plan's places"
   * links name the plan they are about, so the person lands on the editor
   * rather than on the list of plan cards.
   */
  editCampaignId?: string | null;
  profile?: CandidateProfile;
  onSaveCampaign: (campaign: SaveJobSearchCampaignInput) => Promise<boolean>;
  onDeleteCampaign?: (campaignId: string) => Promise<boolean>;
  onSelectCampaign: (campaignId: string) => void;
  onRunCampaignNow?: (campaignId: string) => void;
  runCampaignPending?: (campaignId: string) => boolean;
  pending: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  campaignRuleFunnel?: CampaignRuleFunnelProjection | null;
  campaignRulePending?: boolean;
  onDeleteCampaignRule?: (campaignId: string, ruleId: string) => void;
  onSaveCampaignRule?: (
    campaignId: string,
    rule: SaveCampaignRuleInput,
  ) => void;
  onToggleCampaignRule?: (
    campaignId: string,
    ruleId: string,
    enabled: boolean,
  ) => void;
  onRefreshCampaignRuleFunnel?: (campaignId: string) => void;
}) {
  const view = usePersistedCollectionView("campaigns", "comfortable");
  const [editing, setEditing] = useState<SaveJobSearchCampaignInput | null>(
    null,
  );
  const [editorSession, setEditorSession] = useState(0);
  const [editorDirty, setEditorDirty] = useState(false);
  useEffect(() => {
    props.onDirtyChange?.(editorDirty);
  }, [editorDirty, props.onDirtyChange]);
  useEffect(() => () => props.onDirtyChange?.(false), [props.onDirtyChange]);
  const handleEditorDirtyChange = useCallback(
    (dirty: boolean) => setEditorDirty(dirty),
    [],
  );
  const [savedPlanName, setSavedPlanName] = useState<string | null>(null);
  /** The plan whose Run now was pressed while another search was running. */
  const [blockedRunPlanId, setBlockedRunPlanId] = useState<string | null>(null);
  const runningCampaignId = props.activeDiscoveryRun?.campaignId ?? null;
  const hasActiveRun = Boolean(props.activeDiscoveryRun);
  useEffect(() => {
    if (!hasActiveRun) setBlockedRunPlanId(null);
  }, [hasActiveRun, runningCampaignId]);
  const [createdPlanNotice, setCreatedPlanNotice] = useState<{
    name: string;
    knownIds: readonly string[];
    resolvedId: string | null;
  } | null>(null);
  useEffect(() => {
    if (createdPlanNotice?.resolvedId === props.activeCampaignId)
      setCreatedPlanNotice(null);
  }, [createdPlanNotice, props.activeCampaignId]);
  const campaignIdsRef = useRef<readonly string[]>([]);
  useEffect(() => {
    campaignIdsRef.current = props.campaigns.map((campaign) => campaign.id);
  }, [props.campaigns]);
  useEffect(() => {
    if (createdPlanNotice === null || createdPlanNotice.resolvedId !== null) {
      return;
    }
    const created = props.campaigns.find(
      (candidate) =>
        candidate.name === createdPlanNotice.name &&
        !createdPlanNotice.knownIds.includes(candidate.id),
    );
    if (created) {
      setCreatedPlanNotice({
        ...createdPlanNotice,
        resolvedId: created.id,
      });
    }
  }, [createdPlanNotice, props.campaigns]);
  const handleEditorSave = useCallback(
    (campaign: SaveJobSearchCampaignInput): Promise<boolean> =>
      Promise.resolve(props.onSaveCampaign(campaign)).then((saved) => {
        if (saved && campaign.id === null) {
          setCreatedPlanNotice({
            name: campaign.name,
            knownIds: campaignIdsRef.current,
            resolvedId: null,
          });
        }
        return saved;
      }),
    [props.onSaveCampaign],
  );

  const startEditing = useCallback((next: SaveJobSearchCampaignInput) => {
    setEditing(next);
    setEditorSession((session) => session + 1);
    setEditorDirty(false);
    setCreatedPlanNotice(null);
    setSavedPlanName(null);
  }, []);

  // Opens the requested plan's editor once. Closing it must not reopen it, so
  // the id is remembered rather than the open/closed state being derived.
  const requestedEditCampaignId = props.editCampaignId ?? null;
  const openedEditorForCampaignId = useRef<string | null>(null);
  const campaignsForEditor = props.campaigns;
  useEffect(() => {
    if (
      requestedEditCampaignId === null ||
      openedEditorForCampaignId.current === requestedEditCampaignId
    ) {
      return;
    }
    const requested = campaignsForEditor.find(
      (campaign) => campaign.id === requestedEditCampaignId,
    );
    if (!requested) {
      return;
    }
    openedEditorForCampaignId.current = requestedEditCampaignId;
    startEditing(campaignToInput(requested));
  }, [campaignsForEditor, requestedEditCampaignId, startEditing]);

  const [pendingEditorSwitch, setPendingEditorSwitch] =
    useState<SaveJobSearchCampaignInput | null>(null);
  const beginEditing = (next: SaveJobSearchCampaignInput) => {
    if (editing !== null && editorDirty) {
      // Switching away from a dirty editor asks through the app-owned
      // confirmation dialog instead of window.confirm.
      setPendingEditorSwitch(next);
      return;
    }
    startEditing(next);
  };
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(
    null,
  );
  const [deletePending, setDeletePending] = useState(false);
  const [deleteFailedId, setDeleteFailedId] = useState<string | null>(null);
  const confirmDeleteCampaign = (campaignId: string) => {
    if (!props.onDeleteCampaign) {
      return;
    }
    setDeletePending(true);
    void props
      .onDeleteCampaign(campaignId)
      .then((deleted) => {
        if (deleted) {
          setDeleteCandidateId(null);
          setDeleteFailedId(null);
        } else {
          setDeleteFailedId(campaignId);
        }
      })
      .finally(() => {
        setDeletePending(false);
      });
  };
  const [rulesCampaignId, setRulesCampaignId] = useState<string | null>(null);
  const rulesOpenerRef = useRef<HTMLButtonElement | null>(null);
  const wasRulesOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasRulesOpenRef.current;
    const isOpen = rulesCampaignId !== null;
    wasRulesOpenRef.current = isOpen;

    if (!isOpen && wasOpen) {
      rulesOpenerRef.current?.focus();
      rulesOpenerRef.current = null;
    }
  }, [rulesCampaignId]);
  const filteredCampaigns = useMemo(
    () =>
      props.campaigns.filter((campaign) =>
        matchesCollectionSearch(view.query, [
          campaign.name,
          campaign.description,
          campaign.mode,
          campaign.status,
        ]),
      ),
    [props.campaigns, view.query],
  );
  // Search plans do not own separate job pools: nothing on a saved job or in
  // the discovery ledger records which plan found it, so the same job can be
  // retained by two plans at once. The cards say so rather than letting each
  // card's "Jobs in this plan" read as a pool of its own; no plan's number is
  // ever inflated with another plan's jobs, because each still counts only
  // the ids it retained.
  const sharedJobCountByCampaignId = useMemo(() => {
    const campaignIdsByJobId = new Map<string, Set<string>>();
    for (const campaign of props.campaigns) {
      if (campaign.status === "archived") continue;
      for (const jobId of campaign.jobIds) {
        const owners = campaignIdsByJobId.get(jobId);
        if (owners) {
          owners.add(campaign.id);
        } else {
          campaignIdsByJobId.set(jobId, new Set([campaign.id]));
        }
      }
    }

    const sharedCounts = new Map<string, number>();
    for (const owners of campaignIdsByJobId.values()) {
      if (owners.size < 2) continue;
      for (const campaignId of owners) {
        sharedCounts.set(campaignId, (sharedCounts.get(campaignId) ?? 0) + 1);
      }
    }
    return sharedCounts;
  }, [props.campaigns]);
  const activeCampaign =
    props.campaigns.find(
      (campaign) => campaign.id === props.activeCampaignId,
    ) ?? props.campaigns[0];
  const rulesCampaign =
    props.campaigns.find((campaign) => campaign.id === rulesCampaignId) ?? null;

  return (
    // The header stack owns its 12px seam; the -mb-2 cancels the part of
    // the 20px grid gap that would double it.
    <section className="grid gap-5 pb-8 [&>[data-page-header-stack]]:-mb-2">
      <PageHeaderStack
        actions={
          // Most people stay on the default plan, so creating one is a
          // secondary action, not the only filled button on the page.
          <Button
            onClick={() =>
              beginEditing(newCampaignFrom(activeCampaign ?? null))
            }
            size="sm"
            type="button"
            variant="secondary"
          >
            New search plan
          </Button>
        }
        description="Optional reusable searches. Find jobs always searches with the current plan."
        title="Search plans"
      />

      {editing ? (
        <CampaignEditor
          campaign={editing}
          defaultScheduleTimeZone={inferProfileTimeZone(props.profile ?? {})}
          isCurrentPlan={
            editing.id !== null && editing.id === props.activeCampaignId
          }
          key={`search-plan-editor-${editorSession}`}
          onCancel={() => {
            setEditing(null);
            setEditorDirty(false);
          }}
          onDirtyChange={handleEditorDirtyChange}
          {...(editing.id !== null
            ? {
                onMakeCurrent: () => props.onSelectCampaign(editing.id!),
                ...(props.onRunCampaignNow
                  ? { onRunNow: () => props.onRunCampaignNow?.(editing.id!) }
                  : {}),
                runPending: props.runCampaignPending?.(editing.id) ?? false,
              }
            : {})}
          onSave={handleEditorSave}
          onSaved={(campaign) => {
            // A saved plan is a saved plan: the form closes, so its pre-save
            // run status can never contradict the card below it and Cancel
            // can never claim unsaved edits a moment after a save.
            setEditing(null);
            setEditorDirty(false);
            if (campaign.id !== null) {
              setSavedPlanName(campaign.name);
            }
          }}
          pending={props.pending}
        />
      ) : null}

      {savedPlanName ? (
        <p
          className="rounded-(--radius-field) border border-border-subtle px-4 py-3 text-sm text-foreground"
          role="status"
        >
          {`Search plan "${savedPlanName}" saved.`}
        </p>
      ) : null}

      {createdPlanNotice ? (
        <p
          className="flex flex-wrap items-center gap-3 rounded-(--radius-field) border border-border-subtle px-4 py-3 text-sm text-foreground"
          role="status"
        >
          {`Search plan "${createdPlanNotice.name}" created.`}
          {createdPlanNotice.resolvedId !== null ? (
            <Button
              onClick={() =>
                props.onSelectCampaign(createdPlanNotice.resolvedId!)
              }
              pending={props.pending}
              size="sm"
              type="button"
              variant="outline"
            >
              Make current
            </Button>
          ) : null}
        </p>
      ) : null}

      {rulesCampaign ? (
        <CampaignRuleBuilder
          campaign={rulesCampaign}
          onClose={() => setRulesCampaignId(null)}
          onDeleteRule={(ruleId) =>
            props.onDeleteCampaignRule?.(rulesCampaign.id, ruleId)
          }
          onSaveRule={(rule) =>
            props.onSaveCampaignRule?.(rulesCampaign.id, rule)
          }
          onToggleRule={(ruleId, enabled) =>
            props.onToggleCampaignRule?.(rulesCampaign.id, ruleId, enabled)
          }
          pending={props.campaignRulePending ?? false}
          projection={
            props.campaignRuleFunnel?.campaignId === rulesCampaign.id
              ? props.campaignRuleFunnel
              : null
          }
        />
      ) : null}

      {/* Two rows of list chrome for a single plan is chrome, not a list.
          The search field returns once there is something to search. */}
      {props.campaigns.length > 1 ? (
        <CollectionSearchToolbar
          className="border-y-0 px-0"
          label="Search plans"
          onQueryChange={view.setQuery}
          placeholder="Search a plan by name or status"
          query={view.query}
          totalCount={props.campaigns.length}
          visibleCount={filteredCampaigns.length}
        />
      ) : null}

      {props.campaigns.length === 0 && view.query.trim() === "" ? (
        <EmptyState
          description="Create a search plan to save a reusable setup for roles, sources, how many jobs each search keeps, and progress."
          title="No search plans yet"
        >
          <div className="flex justify-center">
            <Button
              onClick={() =>
                beginEditing(newCampaignFrom(activeCampaign ?? null))
              }
              type="button"
            >
              Create your first search plan
            </Button>
          </div>
        </EmptyState>
      ) : filteredCampaigns.length === 0 ? (
        <CollectionNoMatches
          noun="search plans"
          onClear={() => view.setQuery("")}
          query={view.query}
        />
      ) : (
        <div className="grid gap-3">
          <p className="text-xs text-foreground-muted">
            Past activity is shown in {deviceTimeZone()}. Schedule times and
            pauses use each plan’s saved time zone.
          </p>
          <div
            className={
              filteredCampaigns.length === 1
                ? "grid gap-3"
                : "grid gap-3 xl:grid-cols-2"
            }
          >
            {filteredCampaigns.map((campaign) => {
              const active = campaign.id === props.activeCampaignId;
              const archived = campaign.status === "archived";
              const cannotDeletePlan =
                props.campaigns.length === 1 ||
                (active &&
                  !props.campaigns.some(
                    (candidate) =>
                      candidate.id !== campaign.id &&
                      candidate.status !== "archived",
                  ));
              const sharedJobCount =
                sharedJobCountByCampaignId.get(campaign.id) ?? 0;
              const remoteOnlySourceWarning = describeRemoteOnlySourceWarning(
                props.discoveryRuns,
                campaign,
              );
              // R7: one plan running greyed out every plan's Run now. Only the
              // plan that is actually running says "Search running"; the others
              // keep an enabled Run now and explain themselves if pressed.
              const activeRun = props.activeDiscoveryRun ?? null;
              const thisPlanIsRunning = activeRun?.campaignId === campaign.id;
              const activeRunBlockMessage = thisPlanIsRunning
                ? DISCOVERY_RUN_ALREADY_ACTIVE_MESSAGE
                : blockedRunPlanId === campaign.id
                  ? describeActiveRunBlock(campaign.id, activeRun)
                  : null;
              return (
                <article
                  className={`surface-panel-shell grid min-w-0 gap-4 rounded-(--radius-panel) border p-5 ${active ? "border-accent/60" : "border-(--surface-panel-border)"} ${archived ? "opacity-60" : ""}`}
                  key={campaign.id}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2
                          className="min-w-0 break-words font-semibold text-(--text-headline)"
                          title={campaign.name}
                        >
                          {campaign.name}
                        </h2>
                        {active ? (
                          <span className="rounded-full bg-primary-fill px-2 py-0.5 text-xs font-medium text-primary-fill-foreground">
                            Current
                          </span>
                        ) : null}
                        {archived ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            Archived
                          </span>
                        ) : null}
                      </div>
                      {/* "Precision volume" is internal vocabulary; the card
                        says what the setting actually does. */}
                      <p className="mt-1 text-sm capitalize text-foreground-soft">
                        {campaign.mode === "scale"
                          ? "Wider search"
                          : "Focused search"}{" "}
                        · {campaign.status}
                      </p>
                    </div>
                    <div className="grid shrink-0 justify-items-end">
                      <strong className="text-sm text-(--text-headline)">
                        {campaign.progress.jobsRetained}
                      </strong>
                      <span className="text-xs text-foreground-muted">
                        {/* "Kept" means the plan's retained results on Home
                          and Find jobs; this number is the shortlist. */}
                        shortlisted
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-foreground-soft">
                    {campaign.description || "No description yet."}
                  </p>
                  <p className="text-sm text-foreground-soft">
                    Uses {resolvePlanSourceIds(campaign).length} of your{" "}
                    {campaign.searchPreferences.discovery.targets.length} job
                    sites.
                  </p>
                  {describeScheduleStart(campaign.schedule) ? (
                    <p className="text-sm text-foreground-soft">
                      {describeScheduleStart(campaign.schedule)}
                    </p>
                  ) : null}
                  {remoteOnlySourceWarning ? (
                    <p
                      className="text-sm leading-6 text-(--warning-text)"
                      data-testid="campaign-remote-only-sources-note"
                    >
                      {remoteOnlySourceWarning}
                    </p>
                  ) : null}
                  {sharedJobCount > 0 ? (
                    <p
                      className="text-sm leading-6 text-foreground-soft"
                      data-testid="campaign-shared-jobs-note"
                    >
                      {sharedJobCount === 1
                        ? "1 of these jobs is also kept by another search plan."
                        : `${sharedJobCount} of these jobs are also kept by another search plan.`}{" "}
                      Job Finder saves jobs once for the whole app, so a job
                      that fits two plans appears in both.
                    </p>
                  ) : null}
                  {thisPlanIsRunning ? (
                    <p
                      className="rounded-(--radius-small) border border-primary/25 bg-primary/5 px-3 py-2 text-sm text-foreground"
                      role="status"
                    >
                      Search running for this plan.
                    </p>
                  ) : (
                    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      {/* Each number says what it counts; bare "Blocked 1" beside
                      "Remaining 1" explained neither. */}
                      <div>
                        <dt className="text-xs text-foreground-muted">
                          Jobs in this plan
                        </dt>
                        <dd>{campaign.progress.jobsFound}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-foreground-muted">
                          Applications
                        </dt>
                        <dd>{campaign.progress.applicationsPrepared}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-foreground-muted">
                          Waiting for you
                        </dt>
                        <dd>{campaign.progress.blockedCount}</dd>
                      </div>
                      {/* This counts jobs left in a running application batch,
                      not a review backlog; an idle plan printing "0" read as
                      "nothing left to review" beside a shortlist of one. */}
                      {campaign.progress.remainingQueueSize > 0 ? (
                        <div>
                          <dt className="text-xs text-foreground-muted">
                            Jobs left in this batch
                          </dt>
                          <dd>{campaign.progress.remainingQueueSize}</dd>
                        </div>
                      ) : null}
                      <div className="col-span-2">
                        <dt className="text-xs text-foreground-muted">
                          Next run
                        </dt>
                        <dd>
                          {props.safeguardPauses?.some(
                            (pause) => pause.campaignId === campaign.id,
                          )
                            ? "Paused by a safeguard"
                            : describeNextRun(campaign.schedule)}
                        </dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-xs text-foreground-muted">
                          Last run
                        </dt>
                        <dd>
                          {describeLastRun(
                            campaign.schedule,
                            campaign.progress.lastRunAt ??
                              campaign.latestDigest?.generatedAt ??
                              null,
                            readPlanRunReport(
                              props.discoveryRuns,
                              campaign.latestDigest,
                            ),
                            props.discoveryRuns?.find(
                              (run) =>
                                run.id ===
                                campaign.latestDigest?.discoveryRunId,
                            ) ??
                              props.discoveryRuns?.find(
                                (run) => run.campaignId === campaign.id,
                              ),
                            campaign.latestDigest,
                          )}
                        </dd>
                      </div>
                    </dl>
                  )}
                  {campaign.schedule.runFacts.consecutiveFailures > 0 ? (
                    <p className="text-xs text-foreground-muted">
                      {campaign.schedule.runFacts.consecutiveFailures}{" "}
                      consecutive failed run
                      {campaign.schedule.runFacts.consecutiveFailures === 1
                        ? ""
                        : "s"}{" "}
                      recorded.
                    </p>
                  ) : null}
                  {!thisPlanIsRunning && campaign.latestDigest ? (
                    <details className="rounded-(--radius-field) border border-(--surface-panel-border) px-3 py-2">
                      <summary className="cursor-pointer text-sm font-medium text-foreground">
                        What the last run found
                      </summary>
                      {/* The run's own frozen line, identical to the one Home,
                        Find jobs, Search history and Tasks print for it. */}
                      <p className="mt-2 text-sm text-foreground-soft">
                        {describePlanRunPopulations(
                          readPlanRunReport(
                            props.discoveryRuns,
                            campaign.latestDigest,
                          ),
                          campaign.latestDigest,
                        )}
                      </p>
                      {campaign.latestDigest.sourceOutcome ? (
                        <p className="mt-2 text-sm text-foreground-soft">
                          {campaign.latestDigest.sourceOutcome.completed} of{" "}
                          {campaign.latestDigest.sourceOutcome.planned} sources
                          completed
                          {campaign.latestDigest.failedSources.map(
                            (source) =>
                              ` · ${jobSourceLabel(source.sourceTargetId, campaign.searchPreferences.discovery.targets)} failed (${discoverySourceFailureCopy(source.reason)})`,
                          )}
                        </p>
                      ) : null}
                      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm text-foreground-soft sm:grid-cols-6">
                        <div>
                          <dt className="text-xs text-foreground-muted">New</dt>
                          {/* The same record the sentence above prints, so the
                            tile can never give a second number for the same
                            run. The change-digest count is a sighting tally,
                            not a result count. */}
                          <dd>
                            {readPlanRunReport(
                              props.discoveryRuns,
                              campaign.latestDigest,
                            ).new ?? campaign.latestDigest.counts.new}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-foreground-muted">
                            Changed
                          </dt>
                          <dd>{campaign.latestDigest.counts.changed}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-foreground-muted">
                            Open again
                          </dt>
                          <dd>{campaign.latestDigest.counts.reactivated}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-foreground-muted">
                            Closed
                          </dt>
                          <dd>{campaign.latestDigest.counts.inactive}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-foreground-muted">
                            Skipped
                          </dt>
                          <dd>{campaign.latestDigest.counts.skipped}</dd>
                        </div>
                      </dl>
                      {campaign.latestDigest.failedSources.length > 0 ? (
                        <ul className="mt-3 grid gap-2 text-sm text-foreground-soft">
                          {campaign.latestDigest.failedSources.map((source) => (
                            <li key={source.sourceTargetId}>
                              <span className="font-medium text-foreground">
                                {jobSourceLabel(
                                  source.sourceTargetId,
                                  campaign.searchPreferences.discovery.targets,
                                )}
                              </span>{" "}
                              — {discoverySourceFailureCopy(source.reason)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-3 text-xs text-foreground-muted">
                          {describePlanRunFailure(
                            props.discoveryRuns,
                            campaign.latestDigest,
                          ) ?? "No source problems in this run."}
                        </p>
                      )}
                    </details>
                  ) : null}
                  {campaign.history.length > 0 ? (
                    <details className="rounded-(--radius-field) border border-(--surface-panel-border) px-3 py-2">
                      <summary className="cursor-pointer text-sm font-medium text-foreground">
                        Recent search-plan history
                      </summary>
                      <ol className="mt-3 grid gap-2 text-sm text-foreground-soft">
                        {campaign.history
                          .filter(
                            (entry, index, history) =>
                              entry.kind !== "activated" ||
                              history[index - 1]?.kind !== "activated",
                          )
                          .slice(0, 5)
                          .map((entry) => (
                            <li key={entry.id}>
                              <span className="font-medium text-foreground">
                                {formatPlanCardDateTime(entry.occurredAt) ??
                                  "Unknown time"}
                              </span>{" "}
                              — {describePlanHistory(entry)}
                            </li>
                          ))}
                      </ol>
                    </details>
                  ) : null}
                  {deleteCandidateId === campaign.id ? (
                    <div
                      data-toast-avoid
                      aria-label={`Confirm deleting ${campaign.name}`}
                      className="grid gap-2 rounded-(--radius-field) border border-destructive/40 bg-destructive/10 p-3"
                      role="group"
                    >
                      <p className="text-sm text-foreground">
                        {cannotDeletePlan
                          ? "This plan cannot be deleted yet."
                          : `Permanently delete “${campaign.name}”? This cannot be undone.`}
                      </p>
                      {cannotDeletePlan ? (
                        <p className="text-sm text-foreground-muted">
                          Keep at least one non-archived plan. Create another
                          plan, or restore an archived plan by editing its
                          status, before deleting this one.
                        </p>
                      ) : active ? (
                        <p className="text-sm text-foreground-muted">
                          This is your current plan. Your current plan switches
                          automatically to another non-archived plan.
                        </p>
                      ) : null}
                      {deleteFailedId === campaign.id ? (
                        <p className="text-sm text-destructive" role="alert">
                          Deleting this search plan failed. It was not removed.
                        </p>
                      ) : null}
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          disabled={deletePending}
                          onClick={() => {
                            setDeleteCandidateId(null);
                            setDeleteFailedId(null);
                          }}
                          size="compact"
                          type="button"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                        <Button
                          disabled={cannotDeletePlan}
                          onClick={() => confirmDeleteCampaign(campaign.id)}
                          pending={deletePending}
                          size="compact"
                          type="button"
                          variant="destructive"
                        >
                          Delete plan
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  <div
                    data-toast-avoid
                    className="flex flex-wrap items-center justify-end gap-2"
                  >
                    {/* One search runs at a time. The service refuses a second
                      one with this exact sentence, so the button says it here
                      instead of looking like a click that did nothing. */}
                    {props.onRunCampaignNow && activeRunBlockMessage ? (
                      <p className="mr-auto text-sm text-foreground-soft">
                        {activeRunBlockMessage}
                      </p>
                    ) : null}
                    {props.onRunCampaignNow ? (
                      <Button
                        disabled={thisPlanIsRunning}
                        onClick={() => {
                          if (props.activeDiscoveryRun) {
                            setBlockedRunPlanId(campaign.id);
                            return;
                          }
                          setBlockedRunPlanId(null);
                          props.onRunCampaignNow?.(campaign.id);
                        }}
                        pending={
                          props.runCampaignPending?.(campaign.id) ?? false
                        }
                        type="button"
                        variant="outline"
                      >
                        {thisPlanIsRunning ? "Search running" : "Run now"}
                      </Button>
                    ) : null}
                    <Button
                      onClick={(event) => {
                        rulesOpenerRef.current = event.currentTarget;
                        setRulesCampaignId(campaign.id);
                        props.onRefreshCampaignRuleFunnel?.(campaign.id);
                      }}
                      type="button"
                      variant="ghost"
                    >
                      Rules
                    </Button>
                    <Button
                      onClick={() => beginEditing(campaignToInput(campaign))}
                      type="button"
                      variant="ghost"
                    >
                      Edit
                    </Button>
                    {!active && !archived ? (
                      <Button
                        onClick={() => props.onSelectCampaign(campaign.id)}
                        pending={props.pending}
                        type="button"
                        variant="outline"
                      >
                        Make current
                      </Button>
                    ) : null}
                  </div>
                  {/* Delete is not one of the safe actions. It sits on its own
                    row, at the opposite end, one deliberate reach away from
                    Edit. */}
                  {props.onDeleteCampaign ? (
                    <div
                      data-toast-avoid
                      className="flex flex-wrap justify-start gap-2 border-t border-(--surface-panel-border) pt-2"
                    >
                      <Button
                        className="border-destructive/45 text-destructive hover:border-destructive hover:text-destructive"
                        onClick={() => {
                          setDeleteCandidateId(campaign.id);
                          setDeleteFailedId(null);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Delete plan
                      </Button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      )}

      <CampaignConfirmDialog
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        detail={`The open search-plan editor still has unsaved edits. Switching to "${
          pendingEditorSwitch?.name ?? "another plan"
        }" now discards them. This cannot be undone.`}
        eyebrow="Unsaved search-plan draft"
        onCancel={() => setPendingEditorSwitch(null)}
        onConfirm={() => {
          const next = pendingEditorSwitch;
          // Close first so the switch runs exactly once per explicit confirm.
          setPendingEditorSwitch(null);
          if (next !== null) {
            startEditing(next);
          }
        }}
        open={pendingEditorSwitch !== null}
        title="Discard unsaved search-plan changes?"
      />
    </section>
  );
}
