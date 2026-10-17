import { Link } from "react-router-dom";
import type {
  BrowserSessionState,
  JobFinderSearchRequest,
  JobSearchCampaign,
  JobSearchPreferences,
} from "@nestor/contracts";
import { SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Popover } from "@renderer/components/ui/popover";
import { useBoundedFloatingSurface } from "@renderer/features/job-finder/components/bounded-floating-surface";
import { useJobFinderOverlayOwnership } from "@renderer/features/job-finder/lib/job-finder-overlay-ownership";
import { isImeComposingEvent } from "@renderer/features/job-finder/lib/job-finder-shortcuts";
import { formatCountLabel } from "@renderer/features/job-finder/lib/job-finder-utils";
import { cn } from "@renderer/lib/cn";
import {
  getDiscoveryRuntimeProjection,
  getDiscoverySearchReadiness,
} from "./discovery-search-readiness";

export const DISCOVERY_SEARCH_SETUP_PANEL_ID = "discovery-search-setup-panel";

const SOURCE_PICKER_DESIRED_HEIGHT_PX = 288;
const SOURCE_PICKER_PREFERRED_WIDTH_PX = 256;

export interface DiscoverySearchChip {
  id: string;
  label: string;
}

/**
 * The three settings a job seeker actually edits, as short chips. Results own
 * the page, so the setup that used to be a peer tab is summarized here and
 * opens in place instead of costing a whole navigation act.
 */
export function getDiscoverySearchChips(
  searchPreferences: JobSearchPreferences,
): readonly DiscoverySearchChip[] {
  const searchTargetCount =
    searchPreferences.targetRoles.length + searchPreferences.jobFamilies.length;
  const enabledSourceCount =
    getDiscoverySearchReadiness(searchPreferences).enabledSourceCount;
  const isRemoteOnlySearch =
    searchPreferences.locations.length === 0 &&
    searchPreferences.workModes.length > 0 &&
    searchPreferences.workModes.every((workMode) => workMode === "remote");

  return [
    {
      id: "roles",
      label:
        searchTargetCount > 0
          ? formatCountLabel(searchTargetCount, "search target")
          : "No search targets",
    },
    {
      id: "places",
      label: isRemoteOnlySearch
        ? "Remote only"
        : searchPreferences.locations.length > 0
          ? formatCountLabel(searchPreferences.locations.length, "location")
          : searchPreferences.workModes.length > 0
            ? formatCountLabel(searchPreferences.workModes.length, "work mode")
            : "Anywhere",
    },
    {
      id: "sources",
      label:
        enabledSourceCount > 0
          ? formatCountLabel(enabledSourceCount, "enabled source")
          : "No enabled sources",
    },
  ];
}

/**
 * Whole seconds since the running search started, or `null` when nothing is
 * running or the start time is unusable. Measured from the run's own recorded
 * start, so a re-render or a route return never restarts the count.
 */
function useSearchElapsedSeconds(startedAt: string | null): number | null {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const isMeasurable = Number.isFinite(startedAtMs);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!isMeasurable) {
      return;
    }

    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [isMeasurable, startedAtMs]);

  if (!isMeasurable) {
    return null;
  }

  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
}

/**
 * The browser only earns a mention here when it needs the person: a sign-in
 * or a block. A search opens the browser itself, the app's top bar already
 * offers it, and the offline catalog runtime has no live browser at all, so
 * "Browser not open" or "Browser ready" beside Search now was noise.
 */
function getBrowserChipLabel(
  browserSession: BrowserSessionState,
): string | null {
  if (getDiscoveryRuntimeProjection(browserSession).isOffline) {
    return null;
  }
  switch (browserSession.status) {
    case "login_required":
      return "Browser needs sign-in";
    case "blocked":
      return "Browser blocked";
    default:
      return null;
  }
}

/** The plans a job seeker can switch to: every non-archived plan, plus the current one. */
export function getDiscoveryPlanOptions(
  campaigns: readonly Pick<JobSearchCampaign, "id" | "name" | "status">[],
  activeCampaignId: string | null,
): readonly { id: string; name: string }[] {
  return campaigns
    .filter(
      (campaign) =>
        campaign.status !== "archived" || campaign.id === activeCampaignId,
    )
    .map((campaign) => ({ id: campaign.id, name: campaign.name }));
}

/**
 * One interactive strip above the results: the goal, freshness and sources
 * for this search, one search command, and the browser as a small link. How
 * picky a search is lives in Settings (AI behavior) with every other choice
 * about how the AI works. Plans, result scope and setup counts live elsewhere
 * (Search plans, the results panel, the setup panel) so this row stays one
 * line.
 */
export function DiscoverySearchBar(props: {
  /** Accepted for callers that still pass plans; the bar no longer shows them. */
  campaigns?: readonly Pick<JobSearchCampaign, "id" | "name" | "status">[];
  activeCampaignId?: string | null;
  isPlanSwitchPending?: boolean;
  onSelectCampaign?: (campaignId: string) => void;
  browserSession: BrowserSessionState;
  isBrowserSessionPending: boolean;
  isSearchPending: boolean;
  isSearchDisabled: boolean;
  isSetupOpen: boolean;
  /** Accepted for compatibility; the single setup chip reflects `isSetupOpen`. */
  openSetupChipId?: string | null;
  /**
   * ISO start time of the run in progress. A search takes several seconds, so
   * the wait is reported beside the control that started it rather than only
   * inside a separate activity panel.
   */
  searchStartedAt?: string | null;
  /** Live "n new jobs saved" style progress for the run in progress. */
  backgroundPlanName?: string | null;
  searchProgressLabel?: string | null;
  isStopPending?: boolean;
  /**
   * What to say when a stop request went unanswered long enough that the app
   * released the search's controls. Shown where the live counter was, so the
   * place that was counting upward is the place that stops.
   */
  stoppedNotice?: string | null;
  onOpenBrowserSession: () => void;
  onRunAgentDiscovery:
    | ((searchRequest?: JobFinderSearchRequest) => void)
    | undefined;
  onStopSearch?: (() => void) | undefined;
  onToggleSetup: (chipId: string | null) => void;
  searchActionDescribedBy?: string | undefined;
  searchPreferences: JobSearchPreferences;
  profileSourceEnabled?: Readonly<Record<string, boolean>>;
  isSearchRunning: boolean;
  resultScope?: "focused" | "wide";
  hiddenResultCount?: number;
  onToggleResultScope?: () => void;
}) {
  const {
    browserSession,
    isSearchDisabled,
    isSearchPending,
    isSearchRunning,
    isSetupOpen,
    searchStartedAt = null,
    backgroundPlanName = null,
    searchProgressLabel = null,
    isStopPending = false,
    stoppedNotice = null,
    onOpenBrowserSession,
    onRunAgentDiscovery,
    onStopSearch,
    onToggleSetup,
    searchActionDescribedBy,
    searchPreferences,
  } = props;
  const chips = getDiscoverySearchChips(searchPreferences);
  const elapsedSeconds = useSearchElapsedSeconds(
    isSearchRunning ? searchStartedAt : null,
  );
  const browserChipLabel = getBrowserChipLabel(browserSession);
  const availableSources = searchPreferences.discovery.targets.filter(
    (target) => target.enabled,
  );
  const [intent, setIntent] = useState("");
  const [freshness, setFreshness] =
    useState<JobFinderSearchRequest["freshness"]>("any");
  const [selectedSourceIds, setSelectedSourceIds] = useState<"all" | string[]>(
    "all",
  );
  const [isSourcePickerOpen, setIsSourcePickerOpen] = useState(false);
  const sourcePickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourcePickerSurfaceRef = useRef<HTMLDivElement | null>(null);
  const closeSourcePicker = useCallback((restoreFocus: boolean) => {
    setIsSourcePickerOpen(false);
    if (restoreFocus) sourcePickerTriggerRef.current?.focus();
  }, []);
  const { isTopmost: isSourcePickerTopmost } =
    useJobFinderOverlayOwnership({
      active: isSourcePickerOpen,
      close: () => closeSourcePicker(true),
    });
  const sourcePickerPlacement = useBoundedFloatingSurface({
    alignment: "start",
    desiredHeight: SOURCE_PICKER_DESIRED_HEIGHT_PX,
    open: isSourcePickerOpen,
    preferredWidth: SOURCE_PICKER_PREFERRED_WIDTH_PX,
    triggerRef: sourcePickerTriggerRef,
  });
  const availableSourceIdsKey = JSON.stringify(
    availableSources.map((source) => source.id).sort(),
  );
  useEffect(() => {
    setSelectedSourceIds("all");
    setIsSourcePickerOpen(false);
  }, [availableSourceIdsKey, props.activeCampaignId]);
  const selectedSourceCount =
    selectedSourceIds === "all"
      ? availableSources.length
      : selectedSourceIds.length;
  const sourceSelectionLabel =
    selectedSourceIds === "all"
      ? "All sources"
      : formatCountLabel(selectedSourceCount, "source");
  const toggleSource = (sourceId: string) => {
    setSelectedSourceIds((current) => {
      const selected =
        current === "all"
          ? new Set(availableSources.map((source) => source.id))
          : new Set(current);
      if (selected.has(sourceId)) {
        selected.delete(sourceId);
      } else {
        selected.add(sourceId);
      }
      return selected.size === availableSources.length
        ? "all"
        : [...selected];
    });
  };
  const runSearch = () => {
    if (!onRunAgentDiscovery || selectedSourceCount === 0) return;
    // How picky the search is comes from Settings, AI behavior; the bar only
    // carries what changes from one run to the next.
    onRunAgentDiscovery({
      intent,
      freshness,
      sourceIds: selectedSourceIds,
    });
  };

  useEffect(() => {
    if (!isSourcePickerOpen) return undefined;

    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !sourcePickerTriggerRef.current?.contains(target) &&
        !sourcePickerSurfaceRef.current?.contains(target)
      ) {
        closeSourcePicker(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isImeComposingEvent(event) ||
        event.key !== "Escape" ||
        !isSourcePickerTopmost()
      ) {
        return;
      }
      event.preventDefault();
      closeSourcePicker(true);
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeSourcePicker, isSourcePickerOpen, isSourcePickerTopmost]);

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 rounded-(--radius-button) border border-(--surface-panel-border) bg-(--surface-panel) px-2 py-1.5"
      data-testid="discovery-search-bar"
    >
      {/* The profile already says what the person is looking for, so this
          box is an optional note for one run ("only startups", "no agencies")
          rather than a question the app should already know the answer to. */}
      <input
        aria-label="Search focus (optional)"
        className="min-h-8 min-w-56 flex-1 rounded-(--radius-small) border border-(--control-border) bg-background px-3 text-sm text-foreground outline-none placeholder:text-foreground-muted focus-visible:ring-[3px] focus-visible:ring-ring/30"
        disabled={isSearchRunning}
        maxLength={1_000}
        onChange={(event) => setIntent(event.target.value)}
        placeholder="Optional: anything specific for this search"
        type="text"
        value={intent}
      />
      <button
        aria-pressed={freshness === "recent"}
        className={cn(
          "inline-flex min-h-8 shrink-0 items-center rounded-(--radius-small) border border-(--control-border) px-2.5 text-(length:--text-small) font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30",
          freshness === "recent"
            ? "border-primary bg-accent text-accent-foreground"
            : "text-foreground-soft hover:bg-secondary hover:text-foreground",
        )}
        disabled={isSearchRunning}
        onClick={() =>
          setFreshness((current) =>
            current === "recent" ? "any" : "recent",
          )
        }
        title="Prioritize recent listings. Older or undated roles may still appear when they fit."
        type="button"
      >
        Prefer recent
      </button>
      {availableSources.length === 1 &&
      props.profileSourceEnabled?.[availableSources[0]!.id] === false ? (
        <span className="text-xs text-foreground-muted">
          Off in Profile; this plan still searches it
        </span>
      ) : null}
      {/* With one enabled source there is nothing to choose; the picker
          returns as soon as a second source is on. */}
      {availableSources.length > 1 ? (
      <div className="relative shrink-0" data-testid="discovery-source-picker">
        <button
          aria-expanded={isSourcePickerOpen}
          aria-haspopup="dialog"
          className="inline-flex min-h-8 items-center rounded-(--radius-small) border border-(--control-border) px-2.5 text-(length:--text-small) font-medium text-foreground-soft outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
          disabled={isSearchRunning}
          onClick={() => setIsSourcePickerOpen((open) => !open)}
          ref={sourcePickerTriggerRef}
          type="button"
        >
          {sourceSelectionLabel}
        </button>
        {sourcePickerPlacement ? (
          <Popover
            className="p-2"
            label="Search sources"
            open={isSourcePickerOpen}
            placement={{
              left: sourcePickerPlacement.left,
              maxHeight: sourcePickerPlacement.maxHeight,
              top: sourcePickerPlacement.top,
              width: sourcePickerPlacement.width,
            }}
            ref={sourcePickerSurfaceRef}
            role="dialog"
          >
          <button
            className="mb-1 w-full rounded-(--radius-small) px-2 py-1.5 text-left text-sm font-medium hover:bg-secondary"
            onClick={() => setSelectedSourceIds("all")}
            type="button"
          >
            All sources in this plan
          </button>
          {availableSources.map((source) => {
            const checked =
              selectedSourceIds === "all" ||
              selectedSourceIds.includes(source.id);
            return (
              <label
                className="flex cursor-pointer items-center gap-2 rounded-(--radius-small) px-2 py-1.5 text-sm hover:bg-secondary"
                key={source.id}
              >
                <input
                  checked={checked}
                  disabled={isSearchRunning}
                  onChange={() => toggleSource(source.id)}
                  type="checkbox"
                />
                <span className="min-w-0">
                  <span className="block truncate">{source.label}</span>
                  {props.profileSourceEnabled?.[source.id] === false ? (
                    <span className="block text-xs text-foreground-muted">
                      Off in Profile; this plan still searches it
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          </Popover>
        ) : null}
      </div>
      ) : null}
      <button
        aria-controls={DISCOVERY_SEARCH_SETUP_PANEL_ID}
        aria-expanded={isSetupOpen}
        className={cn(
          "inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-(--radius-small) px-2 text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30",
          isSetupOpen ? "text-foreground" : "text-foreground-muted",
        )}
        data-discovery-search-chip="roles"
        onClick={() => onToggleSetup(isSetupOpen ? null : "roles")}
        title={chips.map((chip) => chip.label).join(" · ")}
        type="button"
      >
        <SlidersHorizontal aria-hidden="true" className="size-3.5 shrink-0" />
        Roles, places & sources
      </button>
      <Link
        className="inline-flex min-h-7 shrink-0 items-center rounded-(--radius-small) px-2 text-xs text-foreground-muted underline-offset-2 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/30"
        to="/job-finder/campaigns"
      >
        Search plans
      </Link>
      {browserChipLabel === null ? null : (
        <button
          className="inline-flex min-h-7 shrink-0 items-center rounded-(--radius-small) px-2 text-xs text-foreground-muted underline-offset-2 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/30"
          data-testid="discovery-search-bar-browser"
          onClick={onOpenBrowserSession}
          type="button"
        >
          {browserChipLabel}
        </button>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {isSearchRunning && onStopSearch ? (
          <Button
            data-testid="discovery-header-stop-search"
            onClick={onStopSearch}
            pending={isStopPending}
            size="xs"
            type="button"
            variant="outline"
          >
            {isStopPending
              ? "Stopping"
              : backgroundPlanName
                ? `Stop ${backgroundPlanName} search`
                : "Stop search"}
          </Button>
        ) : null}
        {!isSearchRunning && stoppedNotice ? (
          <span
            aria-live="polite"
            className="shrink-0 text-(length:--text-small) text-foreground-soft"
            data-testid="discovery-search-stopped-notice"
          >
            {stoppedNotice}
          </span>
        ) : null}
        {isSearchRunning && (elapsedSeconds !== null || searchProgressLabel) ? (
          <span
            aria-live="polite"
            className="shrink-0 whitespace-nowrap text-(length:--text-small) tabular-nums text-foreground-soft"
            data-testid="discovery-search-progress"
          >
            {[
              elapsedSeconds === null ? null : `${elapsedSeconds}s`,
              searchProgressLabel,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : null}
        <Button
          aria-describedby={searchActionDescribedBy}
          data-testid="discovery-search-now"
          disabled={isSearchDisabled || selectedSourceCount === 0}
          onClick={runSearch}
          pending={isSearchPending}
          size="sm"
          type="button"
          variant="primary"
        >
          {isSearchRunning ? "Searching" : "Search now"}
        </Button>
      </div>
    </div>
  );
}
