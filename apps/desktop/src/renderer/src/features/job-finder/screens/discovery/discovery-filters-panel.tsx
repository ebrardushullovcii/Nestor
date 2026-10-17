import { useId, useMemo } from "react";
import type {
  BrowserSessionState,
  DiscoveryAdapterSessionState,
  DiscoveryRunRecord,
  SourceAccessPrompt,
  JobSearchPreferences,
  JobSearchSelectivity,
} from "@nestor/contracts";
import { AppWindow, Ban, CircleCheck, KeyRound } from "lucide-react";
import {
  DISCOVERY_OFFLINE_RUNTIME_LABEL,
  DISCOVERY_PAUSED_SEARCH_REASON,
  getDiscoveryRuntimeProjection,
} from "./discovery-search-readiness";
import {
  formatCountLabel,
  formatWorkModeLabel,
  getSessionTone,
} from "../../lib/job-finder-utils";
import {
  DiscoveryFiltersFooter,
  DiscoveryRunOneSourceSection,
  DiscoverySearchSections,
  DiscoverySessionSummary,
} from "./discovery-filters-panel-sections";
import { getDiscoverySearchReadiness } from "./discovery-search-readiness";
import { JOB_FINDER_BROWSER_LABEL } from "../../lib/job-finder-browser-handoff-copy";
import {
  JOB_FINDER_ROUTE_PATHS,
  JOB_FINDER_SETTINGS_JOB_SEARCH_HREF,
} from "../../lib/job-finder-route-hrefs";

interface DiscoveryFiltersPanelProps {
  activeRun: DiscoveryRunRecord | null;
  activityPaused?: boolean;
  browserSession: BrowserSessionState;
  discoverySessions: readonly DiscoveryAdapterSessionState[];
  isAnyDiscoveryRunActive?: boolean;
  isBrowserSessionPending: boolean;
  isBrowserSessionPendingForTarget: (targetId: string) => boolean;
  isDiscoveryAllPending: boolean;
  isTargetPending: (targetId: string) => boolean;
  planEditorHref?: string;
  onOpenBrowserSession: () => void;
  onOpenBrowserSessionForTarget: (targetId: string) => void;
  onRunAgentDiscovery: (() => void) | undefined;
  onRunDiscoveryForTarget?: (targetId: string) => void;
  onViewProgress: () => void;
  searchPreferences: JobSearchPreferences;
  /**
   * How picky the search is, saved under Settings, AI behavior (ADR 0025).
   * Shown here read-only so the one place that edits it stays the one place,
   * while the person can still see what the next search will do.
   */
  searchSelectivity?: JobSearchSelectivity | null;
  sourceAccessPrompts: readonly SourceAccessPrompt[];
}

const SEARCH_SELECTIVITY_LABELS: Record<JobSearchSelectivity, string> = {
  best_matches: "Best matches only",
  balanced: "Balanced",
  wide_net: "Cast a wide net",
};

type SectionValue =
  | string
  | {
      key: string;
      label: string;
    };

interface OtherActiveCriterion {
  label: string;
  value: string;
}

export function getDiscoveryOtherActiveCriteria(
  searchPreferences: JobSearchPreferences,
): {
  preferences: OtherActiveCriterion[];
  hardExclusions: OtherActiveCriterion[];
} {
  const preferences: OtherActiveCriterion[] = [];
  const hardExclusions: OtherActiveCriterion[] = [];
  const addList = (
    target: OtherActiveCriterion[],
    label: string,
    values: readonly string[],
  ) => {
    if (values.length > 0) {
      target.push({ label, value: values.join(" · ") });
    }
  };

  // Trade names, renamed to what a job seeker would say. Hours are gone from
  // this list entirely: they have their own row above (see HOURS_SECTION_LABEL)
  // because "part-time" is often the single most important thing about a
  // search, and folding it in here hid it behind a collapsed disclosure.
  addList(preferences, "Kinds of role", searchPreferences.jobFamilies);
  addList(preferences, "Seniority", searchPreferences.seniorityLevels);
  addList(preferences, "Industries", searchPreferences.targetIndustries);
  addList(preferences, "Company stages", searchPreferences.targetCompanyStages);
  addList(
    preferences,
    "Preferred companies",
    searchPreferences.companyWhitelist,
  );

  const { compensation } = searchPreferences;
  const formatCompensation = (amount: number) => {
    const formattedAmount = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 0,
    }).format(amount);
    const currency =
      compensation.currencyStatus === "needs_clarification" ||
      compensation.currency === null
        ? "currency needs clarification"
        : compensation.currency;
    return `${formattedAmount} ${currency} per ${compensation.interval}`;
  };
  if (compensation.minimum !== null) {
    preferences.push({
      label: "Minimum compensation",
      value: formatCompensation(compensation.minimum),
    });
  }
  if (compensation.maximum !== null) {
    preferences.push({
      label: "Target compensation",
      value: formatCompensation(compensation.maximum),
    });
  }
  if (searchPreferences.discovery.runJobBudget != null) {
    preferences.push({
      label: "Collection limit",
      value: `${formatCountLabel(searchPreferences.discovery.runJobBudget, "job")} per run`,
    });
  }

  addList(
    hardExclusions,
    "Excluded locations",
    searchPreferences.excludedLocations,
  );
  addList(
    hardExclusions,
    "Excluded companies",
    searchPreferences.companyBlacklist,
  );
  if (searchPreferences.discovery.collectOnlyHardCriteriaMatches === true) {
    hardExclusions.push({
      label: "Strict collection",
      value: "Only jobs meeting hard criteria",
    });
  }

  return { preferences, hardExclusions };
}

function getBrowserStatusLabel(
  status: BrowserSessionState["status"],
  isPending: boolean,
  isOfflineRuntime: boolean,
): string {
  if (isOfflineRuntime) {
    return DISCOVERY_OFFLINE_RUNTIME_LABEL;
  }

  switch (status) {
    case "ready":
      return "Ready";
    case "login_required":
      return "Needs sign-in";
    case "blocked":
      return "Blocked";
    default:
      return isPending ? "Starting browser" : "Browser not open";
  }
}

/**
 * Non-color cue for the current-search status: each state carries a distinct
 * glyph shape so Ready / Needs sign-in / Blocked stay distinguishable without
 * relying on badge tone alone.
 */
function getSessionStatusIcon(status: BrowserSessionState["status"]) {
  switch (status) {
    case "ready":
      return CircleCheck;
    case "login_required":
      return KeyRound;
    case "blocked":
      return Ban;
    default:
      // A dashed circle read as a spinner beside "Not open"; a browser-window
      // glyph is a neutral, non-progress cue.
      return AppWindow;
  }
}

export function DiscoveryFiltersPanel({
  activeRun,
  activityPaused = false,
  browserSession,
  discoverySessions,
  isAnyDiscoveryRunActive = false,
  isBrowserSessionPending,
  isBrowserSessionPendingForTarget,
  isDiscoveryAllPending,
  isTargetPending,
  planEditorHref = JOB_FINDER_ROUTE_PATHS.profileWorkModes,
  onOpenBrowserSession,
  onOpenBrowserSessionForTarget,
  onRunAgentDiscovery,
  onRunDiscoveryForTarget,
  onViewProgress,
  searchPreferences,
  searchSelectivity = null,
  sourceAccessPrompts,
}: DiscoveryFiltersPanelProps) {
  const searchControlsHeadingId = useId();
  const sectionHeadingPrefix = useId();
  const totalSourceCount = searchPreferences.discovery.targets.length;
  const isRemoteOnlySearch =
    searchPreferences.locations.length === 0 &&
    searchPreferences.workModes.length > 0 &&
    searchPreferences.workModes.every((workMode) => workMode === "remote");
  const rawCriteriaSections = useMemo<
    Array<{
      label: string;
      values: SectionValue[];
      empty: string;
      editAction?: {
        label: string;
        /** Overrides the derived "Edit <label>" wording on a filled row. */
        filledLabel?: string;
        href: string;
        variant?: "primary" | "secondary";
      };
    }>
  >(
    () => [
      {
        label: "Roles",
        values: searchPreferences.targetRoles,
        empty: "No roles added yet.",
        editAction: {
          label: "Add roles",
          href: JOB_FINDER_ROUTE_PATHS.profileTargetRoles,
          // Profile→Search handoff: empty blockers use primary CTAs so they
          // read as the next action, not gold underlines.
          variant: "primary",
        },
      },
      {
        label: "Locations",
        values: searchPreferences.locations,
        // A remote-only search legitimately has no locations, so reporting
        // it as a missing setup step reads like an error the user must fix.
        empty: isRemoteOnlySearch
          ? "Not needed — this search is remote only."
          : "No locations added yet.",
        ...(isRemoteOnlySearch
          ? {}
          : {
              editAction: {
                label: "Edit your places",
                filledLabel: "Edit your places",
                href: planEditorHref,
                variant: "primary" as const,
              },
            }),
      },
      {
        // Hours used to sit inside the collapsed "Other active criteria"
        // disclosure under a trade name, so a search that was only worth
        // running part-time showed nothing about hours on the open panel.
        // Preferences gave hours their own control; this is the matching row.
        label: "Full-time or part-time",
        values: searchPreferences.employmentTypes,
        empty: "Not set — results can be full-time or part-time.",
        editAction: {
          label: "Set hours",
          filledLabel: "Edit hours",
          href: JOB_FINDER_ROUTE_PATHS.profileTargetRoles,
          // Leaving hours unset is a real answer, not a missing setup step,
          // so this row never competes for the panel's one primary action.
          variant: "secondary",
        },
      },
      {
        label: "Work modes",
        // Stored enum values print lowercase ("remote") beside sentence-case
        // sibling rows, so they are labelled the same way results are.
        values: searchPreferences.workModes.map(formatWorkModeLabel),
        empty: "No work modes added yet.",
        editAction: {
          label: "Set work modes",
          href: JOB_FINDER_ROUTE_PATHS.profileWorkModes,
          variant: "primary",
        },
      },
      {
        label: "Sources",
        values: searchPreferences.discovery.targets
          .filter((target) => target.enabled)
          .map((target) => ({
            key: target.id,
            label: target.label,
          })),
        // Truthful states: "nothing saved" differs from "saved but all
        // disabled", which previously read as if no sources existed.
        empty:
          totalSourceCount === 0
            ? "No sources added yet."
            : `${formatCountLabel(totalSourceCount, "source")} saved, none enabled yet.`,
        editAction: {
          label: totalSourceCount === 0 ? "Add sources" : "Enable sources",
          href: JOB_FINDER_ROUTE_PATHS.profileSources,
          variant: "primary",
        },
      },
      // The one AI knob that shapes a search lives in Settings with the
      // other AI choices (ADR 0025). Naming it here answers "why did I get so
      // few / so many results" without moving the control.
      ...(searchSelectivity
        ? [
            {
              label: "How picky",
              values: [SEARCH_SELECTIVITY_LABELS[searchSelectivity]],
              empty: "",
              editAction: {
                label: "Change in Settings",
                filledLabel: "Change in Settings",
                href: JOB_FINDER_SETTINGS_JOB_SEARCH_HREF,
                variant: "secondary" as const,
              },
            },
          ]
        : []),
    ],
    [
      isRemoteOnlySearch,
      planEditorHref,
      searchPreferences,
      searchSelectivity,
      totalSourceCount,
    ],
  );
  // One primary at a time: on a blank workspace every section is empty, and
  // four primary buttons in a column read as four competing starts. The first
  // empty section keeps the primary treatment; the rest wait as secondary.
  const criteriaSections = useMemo(() => {
    let primaryAssigned = false;
    return rawCriteriaSections.map((section) => {
      if (!section.editAction || section.editAction.variant !== "primary") {
        return section;
      }
      if (section.values.length === 0 && !primaryAssigned) {
        primaryAssigned = true;
        return section;
      }
      return {
        ...section,
        editAction: { ...section.editAction, variant: "secondary" as const },
      };
    });
  }, [rawCriteriaSections]);

  const enabledTargets = searchPreferences.discovery.targets.filter(
    (target) => target.enabled,
  );
  const otherActiveCriteria =
    getDiscoveryOtherActiveCriteria(searchPreferences);
  const otherActiveCriteriaCount =
    otherActiveCriteria.preferences.length +
    otherActiveCriteria.hardExclusions.length;
  const enabledTargetIds = new Set(enabledTargets.map((target) => target.id));
  const enabledSourceAccessPrompts = sourceAccessPrompts.filter((prompt) =>
    enabledTargetIds.has(prompt.targetId),
  );
  const runOneSourceHeadingId = `${sectionHeadingPrefix}-run-one-source`;
  const chromeProfileSession =
    discoverySessions.find(
      (session) =>
        session.driver === "chrome_profile_agent" ||
        session.driver === "embedded_browser_agent",
    ) ?? null;
  const displaySessionSnapshot: BrowserSessionState = chromeProfileSession
    ? {
        source: chromeProfileSession.adapterKind,
        status: chromeProfileSession.status,
        driver: chromeProfileSession.driver,
        label: chromeProfileSession.label,
        detail: chromeProfileSession.detail ?? "",
        lastCheckedAt: chromeProfileSession.lastCheckedAt,
      }
    : browserSession;
  const runtimeProjection = getDiscoveryRuntimeProjection(
    displaySessionSnapshot,
  );
  const isOfflineRuntime = runtimeProjection.isOffline;
  const searchReadiness = getDiscoverySearchReadiness(
    searchPreferences,
    displaySessionSnapshot,
  );
  // A not-yet-opened browser carries only a generic runtime sentence; the
  // summary shows its own plain-language description for that state instead.
  const sessionDetail =
    isOfflineRuntime || displaySessionSnapshot.status === "unknown"
      ? ""
      : (displaySessionSnapshot.detail?.trim() ?? "");
  const isBrowserSessionVisible = true;
  const isReady = displaySessionSnapshot.status === "ready";
  const needsLogin = displaySessionSnapshot.status === "login_required";
  const isBlocked = displaySessionSnapshot.status === "blocked";
  const SessionStatusIcon = getSessionStatusIcon(displaySessionSnapshot.status);
  const canRunDiscovery =
    Boolean(onRunAgentDiscovery) &&
    searchReadiness.ready &&
    !isDiscoveryAllPending &&
    !isAnyDiscoveryRunActive &&
    !activityPaused;
  const searchDisabledOverrideReason = activityPaused
    ? DISCOVERY_PAUSED_SEARCH_REASON
    : null;
  const activeTargetId =
    activeRun?.state === "running" && activeRun.scope === "single_target"
      ? (activeRun.targetIds[0] ?? null)
      : null;
  const primarySourceAccessPrompt =
    enabledSourceAccessPrompts.find(
      (prompt) => prompt.state === "prompt_login_required",
    ) ?? null;
  const hasRecommendedSourceAccessPrompt = enabledSourceAccessPrompts.some(
    (prompt) => prompt.state === "prompt_login_recommended",
  );

  return (
    <section
      aria-labelledby={searchControlsHeadingId}
      className="surface-panel-shell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) xl:h-full xl:min-h-0"
    >
      <h2
        className="border-b border-(--surface-panel-border) px-4 py-3 text-(--text-headline)"
        id={searchControlsHeadingId}
      >
        What this search looks for
      </h2>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden xl:min-h-0">
        <DiscoveryFiltersFooter
          canRunDiscovery={canRunDiscovery}
          isOfflineRuntime={isOfflineRuntime}
          searchDisabledReason={
            searchDisabledOverrideReason ?? searchReadiness.reason
          }
          searchSetupActionLabel={
            searchReadiness.blocker === "no_search_roles"
              ? "Add target roles"
              : totalSourceCount === 0
                ? "Add sources"
                : "Enable sources"
          }
          searchSetupHref={
            searchReadiness.blocker === "no_search_roles"
              ? JOB_FINDER_ROUTE_PATHS.profileTargetRoles
              : JOB_FINDER_ROUTE_PATHS.profileSources
          }
          isBrowserSessionPending={isBrowserSessionPending}
          isBrowserSessionPendingForTarget={isBrowserSessionPendingForTarget}
          isDiscoveryAllPending={isDiscoveryAllPending}
          isReady={isReady}
          onOpenBrowserSession={onOpenBrowserSession}
          onOpenBrowserSessionForTarget={onOpenBrowserSessionForTarget}
          onRunAgentDiscovery={onRunAgentDiscovery}
          onViewProgress={onViewProgress}
          primarySourceAccessPrompt={primarySourceAccessPrompt}
        />

        <div
          aria-label="Current search details"
          className="grid min-h-0 min-w-0 flex-1 content-start gap-0 overflow-x-hidden overflow-y-auto overscroll-contain"
          data-locked-pane-scroll-region
          role="region"
          tabIndex={0}
        >
          <DiscoverySearchSections
            sectionHeadingPrefix={sectionHeadingPrefix}
            sections={criteriaSections}
          />

          <div className="grid min-w-0 gap-2 border-t border-(--surface-panel-border) px-3 py-3">
            {/* This block describes the browser Job Finder searches with, not
              the current search, so the label must say so: "Current search /
              Not open" read as though the search itself was not open. */}
            <p className="text-(length:--text-tiny) font-medium uppercase tracking-(--tracking-label) text-foreground-muted">
              {JOB_FINDER_BROWSER_LABEL}
            </p>
            {/* A plain status line, not a chip: the chip wrapped its icon
                above its uppercase text and looked like a broken button. */}
            <p
              className={`inline-flex min-w-0 items-center gap-1.5 text-sm ${
                isOfflineRuntime
                  ? "text-foreground-muted"
                  : {
                      active: "text-primary",
                      critical: "text-critical",
                      muted: "text-foreground-muted",
                      neutral: "text-foreground-soft",
                      positive: "text-positive",
                      warning: "text-(--warning-text)",
                    }[getSessionTone(displaySessionSnapshot)]
              }`}
              data-testid="discovery-browser-status"
            >
              <SessionStatusIcon
                aria-hidden="true"
                className="size-4 shrink-0"
              />
              {getBrowserStatusLabel(
                displaySessionSnapshot.status,
                isBrowserSessionPending,
                isOfflineRuntime,
              )}
            </p>
            <DiscoverySessionSummary
              hasRecommendedSourceAccessPrompt={
                hasRecommendedSourceAccessPrompt
              }
              isBlocked={isBlocked}
              isBrowserSessionPendingForTarget={
                isBrowserSessionPendingForTarget
              }
              isBrowserSessionVisible={isBrowserSessionVisible}
              isOfflineRuntime={isOfflineRuntime}
              isSearchSetupReady={searchReadiness.setupReady}
              isReady={isReady}
              isTargetPending={isTargetPending}
              needsLogin={needsLogin}
              onOpenBrowserSessionForTarget={onOpenBrowserSessionForTarget}
              {...(onRunDiscoveryForTarget
                ? { onConfirmSignedInForTarget: onRunDiscoveryForTarget }
                : {})}
              primarySourceAccessPrompt={primarySourceAccessPrompt}
              sectionDetail={sessionDetail}
            />
          </div>

          {otherActiveCriteriaCount > 0 ? (
            <details className="min-w-0 border-t border-(--surface-panel-border) px-4 py-3">
              <summary className="cursor-pointer text-(length:--text-small) font-medium text-foreground-soft">
                Other active criteria ({otherActiveCriteriaCount}
                {otherActiveCriteria.hardExclusions.length > 0
                  ? `, including ${formatCountLabel(otherActiveCriteria.hardExclusions.length, "hard exclusion")}`
                  : ""}
                )
              </summary>
              <div className="mt-3 grid gap-3 text-(length:--text-small)">
                {otherActiveCriteria.preferences.length > 0 ? (
                  <section aria-label="Other search preferences">
                    <h3 className="font-medium text-foreground-muted">
                      Preferences
                    </h3>
                    <ul className="mt-1 grid gap-1 text-foreground-soft">
                      {otherActiveCriteria.preferences.map((criterion) => (
                        <li className="break-words" key={criterion.label}>
                          <span className="font-medium">
                            {criterion.label}:
                          </span>{" "}
                          {criterion.value}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {otherActiveCriteria.hardExclusions.length > 0 ? (
                  <section aria-label="Hard exclusions">
                    <h3 className="font-medium text-(--warning-text)">
                      Hard exclusions
                    </h3>
                    <ul className="mt-1 grid gap-1 text-foreground-soft">
                      {otherActiveCriteria.hardExclusions.map((criterion) => (
                        <li className="break-words" key={criterion.label}>
                          <span className="font-medium">
                            {criterion.label}:
                          </span>{" "}
                          {criterion.value}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            </details>
          ) : null}

          {/* With one enabled source, "Search now" already searches exactly
              that source, so a per-source row repeats the Sources list
              directly above it. It returns as soon as there is a real choice
              to make, or a source needs its own sign-in handoff. */}
          {(enabledTargets.length > 1 ||
            enabledSourceAccessPrompts.length > 0) &&
          onRunDiscoveryForTarget ? (
            <DiscoveryRunOneSourceSection
              activeTargetId={activeTargetId}
              enabledSourceAccessPrompts={enabledSourceAccessPrompts}
              enabledTargets={enabledTargets.map((target) => ({
                id: target.id,
                label: target.label,
              }))}
              isAnyDiscoveryRunActive={isAnyDiscoveryRunActive}
              isOfflineRuntime={isOfflineRuntime}
              isSearchUnavailable={
                activityPaused || !searchReadiness.sourceSearchAvailable
              }
              isBrowserSessionPendingForTarget={
                isBrowserSessionPendingForTarget
              }
              isTargetPending={isTargetPending}
              onOpenBrowserSessionForTarget={onOpenBrowserSessionForTarget}
              onConfirmSignedInForTarget={onRunDiscoveryForTarget}
              onRunDiscoveryForTarget={onRunDiscoveryForTarget}
              primarySourceAccessPrompt={primarySourceAccessPrompt}
              runOneSourceHeadingId={runOneSourceHeadingId}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
