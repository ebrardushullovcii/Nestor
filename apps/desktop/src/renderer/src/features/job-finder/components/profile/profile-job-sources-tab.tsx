import { useDeferredValue, useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  DiscoveryRunRecord,
  EditableSourceInstructionArtifact,
  SourceAccessPrompt,
  SourceDebugRunDetails,
  SourceDebugRunRecord,
  SourceInstructionArtifact,
} from "@nestor/contracts";
import { StatusBadge } from "../status-badge";
import { Button } from "@renderer/components/ui/button";
import { PageNavigation } from "../page-navigation";
import {
  isSourceCheckQueueActive,
  startSourceCheckQueue,
  stopSourceCheckQueue,
  useSourceCheckQueue,
} from "../../lib/source-check-queue";
import { isRunnableJobDiscoveryTarget } from "@nestor/contracts";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { FieldLabel } from "@renderer/components/ui/field";
import type { UseFormReturn } from "react-hook-form";
import {
  deriveSourceHealthSignals,
  describeEnabledSourceHealth,
  describeLatestSourceCheck,
  type SourceRuntimeSignals,
} from "@nestor/job-finder/source-health";
import {
  isSourceNeedingAttention,
  SOURCES_NEEDING_ATTENTION_FILTER,
  SOURCES_NEEDING_ATTENTION_LABEL,
} from "../../lib/source-attention";
import type { SearchPreferencesEditorValues } from "../../lib/profile-editor";
import { PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES } from "./profile-deep-link-focus";
import { ProfileDiscoveryTargetRow } from "./profile-discovery-target-row";
import { ProfileInput } from "./profile-form-primitives";
import { ProfileTextarea } from "./profile-form-primitives";
import { ProfileSectionHeader } from "./profile-section-header";
import { deriveJobSourceLabel } from "../../lib/job-source-display-name";

type DiscoveryTarget =
  SearchPreferencesEditorValues["discoveryTargets"][number];

type SourceFilter = "all" | "disabled" | "enabled" | "needs_attention";

export const JOB_SOURCES_PAGE_SIZE = 25;

const sourceFilterOptions: ReadonlyArray<{
  id: SourceFilter;
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
  {
    id: SOURCES_NEEDING_ATTENTION_FILTER,
    label: SOURCES_NEEDING_ATTENTION_LABEL,
  },
];

function parseSourceFilter(value: string | null | undefined): SourceFilter {
  return sourceFilterOptions.find((option) => option.id === value)?.id ?? "all";
}

function getSourceHost(startingUrl: string): string {
  return deriveJobSourceLabel(startingUrl);
}

export function canonicalSourceUrl(value: string): string | null {
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(value)
    ? value
    : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      /\s|%20|%09|%0a|%0d/iu.test(url.hostname)
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function parseJobSourceUrls(input: string): {
  urls: string[];
  invalid: string[];
} {
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of input.split(/[\n,]+/u)) {
    const value = rawValue.trim();
    if (!value) continue;
    // Addresses cannot contain literal spaces. A list entered without a
    // paste event uses the same parser as pasted input.
    if (/\s/u.test(value)) {
      const entries = value.split(/\s+/u);
      let invalidWords: string[] = [];
      const flushInvalid = () => {
        if (invalidWords.length) invalid.push(invalidWords.join(" "));
        invalidWords = [];
      };
      for (const entry of entries) {
        const address =
          /^https?:\/\//iu.test(entry) || entry.includes(".")
            ? canonicalSourceUrl(entry)
            : null;
        if (!address) {
          invalidWords.push(entry);
          continue;
        }
        flushInvalid();
        if (!seen.has(address)) {
          seen.add(address);
          urls.push(address);
        }
      }
      flushInvalid();
      continue;
    }
    const url = canonicalSourceUrl(value);
    if (!url) {
      invalid.push(value);
      continue;
    }
    const key = url;
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }

  return { urls, invalid };
}

/**
 * Status line for a source row. A never-checked source returns `null`: the
 * app's internal learning state is not a fact the user can act on, and the
 * Enabled/Disabled badge already carries the actionable part.
 */
function getInstructionStatusLabel(target: DiscoveryTarget): string | null {
  switch (target.instructionStatus) {
    case "validated":
      return "Guidance ready";
    case "draft":
      return "Draft guidance";
    case "stale":
      return "Guidance needs review";
    case "unsupported":
      return "Check unsupported";
    default:
      return null;
  }
}

export function filterJobSources(
  targets: readonly DiscoveryTarget[],
  query: string,
  filter: SourceFilter,
  signals: SourceRuntimeSignals,
): Array<{ index: number; target: DiscoveryTarget }> {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return targets.flatMap((target, index) => {
    const matchesQuery =
      normalizedQuery.length === 0 ||
      target.label.toLocaleLowerCase().includes(normalizedQuery) ||
      target.startingUrl.toLocaleLowerCase().includes(normalizedQuery);
    // The same definition Home counts in its "need attention" line:
    // attention is scoped to enabled sources so disabled entries never
    // inflate active health counts.
    const matchesFilter =
      filter === "all" ||
      (filter === "enabled" && target.enabled) ||
      (filter === "disabled" && !target.enabled) ||
      (filter === "needs_attention" &&
        isSourceNeedingAttention(target, signals));

    return matchesQuery && matchesFilter ? [{ index, target }] : [];
  });
}

interface SourcePagerProps {
  "aria-label": string;
  children?: ReactNode;
  className: string;
  currentPage: number;
  moveToPage: (nextPage: number) => void;
  nextAriaLabel?: string;
  pageCount: number;
  previousAriaLabel?: string;
}

/** The same numbered pager the three lists use, with this list's range. */
function SourcePager(props: SourcePagerProps) {
  return (
    <nav aria-label={props["aria-label"]} className={props.className}>
      {props.children}
      <PageNavigation
        nextLabel={props.nextAriaLabel ?? "Next"}
        onPageChange={(nextPage) => props.moveToPage(nextPage - 1)}
        page={props.currentPage + 1}
        pageCount={props.pageCount}
        pending={false}
        previousLabel={props.previousAriaLabel ?? "Previous"}
      />
    </nav>
  );
}

interface ProfileJobSourcesTabProps {
  /**
   * The filter the link asked for (`show=needs_attention` from Home's line),
   * so the count the person just read is the list they land on.
   */
  requestedFilter?: string | null;
  isBrowserSessionPending: (targetId: string) => boolean;
  isSourceDebugPending: (targetId: string) => boolean;
  isSourceInstructionPending: (targetId: string) => boolean;
  isSourceInstructionVerifyPending: (instructionId: string) => boolean;
  isTargetDiscoveryPending: (targetId: string) => boolean;
  onGetSourceDebugRunDetails: (runId: string) => Promise<SourceDebugRunDetails>;
  onOpenBrowserSessionForTarget: (targetId: string) => void;
  onRunDiscoveryForTarget?: (targetId: string) => void;
  onRunSourceDebug: (targetId: string) => void;
  /** Saves the profile form at once, so adding sources needs no Save press. */
  onSaveNow?: () => void;
  onSaveSourceInstructionArtifact: (
    targetId: string,
    artifact: EditableSourceInstructionArtifact,
  ) => void;
  onVerifySourceInstructions: (targetId: string, instructionId: string) => void;
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
  /**
   * The workspace discovery runs behind source health. Passing the same facts
   * Home uses keeps both screens on one classification: a source whose latest
   * run completed is healthy even when guidance was never verified, and a
   * source with an in-flight execution reads as running, not as a problem.
   */
  activeDiscoveryRun?: DiscoveryRunRecord | null;
  discoveryRuns?: readonly DiscoveryRunRecord[];
  recentSourceDebugRuns: readonly SourceDebugRunRecord[];
  sourceAccessPrompts: readonly SourceAccessPrompt[];
  sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
}

export function ProfileJobSourcesTab(props: ProfileJobSourcesTabProps) {
  const searchInputId = useId();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState<SourceFilter>(() =>
    parseSourceFilter(props.requestedFilter),
  );
  useEffect(() => {
    if (props.requestedFilter)
      setFilter(parseSourceFilter(props.requestedFilter));
  }, [props.requestedFilter]);
  const [page, setPage] = useState(0);
  const [expandedTargetId, setExpandedTargetId] = useState<string | null>(null);
  const [sourceUrlDraft, setSourceUrlDraft] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [sourceAddMessage, setSourceAddMessage] = useState<string | null>(null);
  const discoveryTargets = props.preferencesForm.watch("discoveryTargets");
  const listFieldOptions = {
    shouldDirty: true,
    shouldTouch: true,
    shouldValidate: true,
  } as const;
  const accessPromptByTargetId = useMemo(
    () =>
      new Map(
        props.sourceAccessPrompts.map((prompt) => [prompt.targetId, prompt]),
      ),
    [props.sourceAccessPrompts],
  );
  // One shared classification for Home and Profile: same login prompts, same
  // running executions, same completed-run evidence.
  const sourceHealthSignals = useMemo(
    () =>
      deriveSourceHealthSignals({
        activeRun: props.activeDiscoveryRun ?? null,
        recentRuns: props.discoveryRuns ?? [],
        sourceAccessPrompts: props.sourceAccessPrompts,
      }),
    [props.activeDiscoveryRun, props.discoveryRuns, props.sourceAccessPrompts],
  );
  const instructionArtifactById = useMemo(
    () =>
      new Map(
        props.sourceInstructionArtifacts.map((artifact) => [
          artifact.id,
          artifact,
        ]),
      ),
    [props.sourceInstructionArtifacts],
  );
  const filteredSources = useMemo(
    () =>
      filterJobSources(
        discoveryTargets,
        deferredQuery,
        filter,
        sourceHealthSignals,
      ),
    [deferredQuery, discoveryTargets, filter, sourceHealthSignals],
  );
  // "Check these N sources" runs through a queue that lives outside this
  // screen (see source-check-queue.ts), so leaving Profile does not drop it.
  const checkQueue = useSourceCheckQueue();
  const checkQueueActive = isSourceCheckQueueActive(checkQueue);
  const anySourceCheckRunning =
    checkQueueActive ||
    props.recentSourceDebugRuns.some((run) => run.state === "running") ||
    discoveryTargets.some((target) => props.isSourceDebugPending(target.id));
  const checkingTarget = checkQueue.launched
    ? discoveryTargets.find(
        (target) => target.id === checkQueue.launched?.targetId,
      )
    : undefined;
  // Each filter's count over the searched sources, in one pass: with ~900
  // sources the four full re-filters this replaced re-ran per keystroke.
  // A filter that would show all of them or none of them is not offered;
  // the active one stays.
  const filterCounts = useMemo(() => {
    const counts: Record<SourceFilter, number> = {
      all: 0,
      disabled: 0,
      enabled: 0,
      needs_attention: 0,
    };
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
    for (const target of discoveryTargets) {
      if (
        normalizedQuery.length > 0 &&
        !target.label.toLocaleLowerCase().includes(normalizedQuery) &&
        !target.startingUrl.toLocaleLowerCase().includes(normalizedQuery)
      ) {
        continue;
      }
      counts.all += 1;
      if (target.enabled) counts.enabled += 1;
      else counts.disabled += 1;
      if (isSourceNeedingAttention(target, sourceHealthSignals)) {
        counts.needs_attention += 1;
      }
    }
    return counts;
  }, [deferredQuery, discoveryTargets, sourceHealthSignals]);
  // Grouped once per run list instead of filtering every run for every row.
  const sourceDebugRunsByTargetId = useMemo(() => {
    const grouped = new Map<string, SourceDebugRunRecord[]>();
    for (const run of props.recentSourceDebugRuns) {
      const existing = grouped.get(run.targetId);
      if (existing) existing.push(run);
      else grouped.set(run.targetId, [run]);
    }
    return grouped;
  }, [props.recentSourceDebugRuns]);
  const filterChoices = sourceFilterOptions.filter(
    (option) =>
      option.id !== "all" &&
      (option.id === filter ||
        (filterCounts[option.id] > 0 &&
          filterCounts[option.id] < filterCounts.all)),
  );
  const visibleFilterOptions =
    filterChoices.length > 0
      ? sourceFilterOptions.filter(
          (option) => option.id === "all" || filterChoices.includes(option),
        )
      : [];
  const checkableFilteredSources = filteredSources
    .map((entry) => entry.target)
    .filter((target) => target.enabled && isRunnableJobDiscoveryTarget(target));
  const pageCount = Math.max(
    1,
    Math.ceil(filteredSources.length / JOB_SOURCES_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount - 1);
  const visibleSources = filteredSources.slice(
    currentPage * JOB_SOURCES_PAGE_SIZE,
    (currentPage + 1) * JOB_SOURCES_PAGE_SIZE,
  );
  const firstVisibleSourceNumber =
    filteredSources.length === 0 ? 0 : currentPage * JOB_SOURCES_PAGE_SIZE + 1;
  const lastVisibleSourceNumber = Math.min(
    filteredSources.length,
    firstVisibleSourceNumber + visibleSources.length - 1,
  );
  const updateDiscoveryTargets = (
    nextTargets: SearchPreferencesEditorValues["discoveryTargets"],
  ) => {
    props.preferencesForm.setValue(
      "discoveryTargets",
      nextTargets,
      listFieldOptions,
    );
  };

  const setLibraryView = (nextFilter: SourceFilter, nextQuery = query) => {
    setFilter(nextFilter);
    setQuery(nextQuery);
    setPage(0);
    setExpandedTargetId(null);
  };

  const createDiscoveryTargetId = () => {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return `target_${globalThis.crypto.randomUUID()}`;
    }

    return `target_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  };

  // Memoized: unmemoized, every keystroke anywhere on the page
  // re-canonicalized all ~900 saved addresses through the URL parser.
  const parsedSourceDraft = useMemo(
    () => parseJobSourceUrls(sourceUrlDraft),
    [sourceUrlDraft],
  );
  const existingSourceUrls = useMemo(
    () =>
      new Set(
        discoveryTargets
          .map((target) => canonicalSourceUrl(target.startingUrl))
          .filter((value): value is string => Boolean(value)),
      ),
    [discoveryTargets],
  );
  const newSourceUrls = useMemo(
    () => parsedSourceDraft.urls.filter((url) => !existingSourceUrls.has(url)),
    [existingSourceUrls, parsedSourceDraft],
  );
  const duplicateSourceCount =
    parsedSourceDraft.urls.length - newSourceUrls.length;

  const addSourceUrls = () => {
    if (newSourceUrls.length === 0) return;
    const skippedDuplicates = duplicateSourceCount;
    const additions = newSourceUrls.map((startingUrl) => ({
      id: createDiscoveryTargetId(),
      label: getSourceHost(startingUrl),
      startingUrl,
      enabled: true,
      adapterKind: "auto" as const,
      customInstructions: "",
      instructionStatus: "missing" as const,
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    }));
    updateDiscoveryTargets([...discoveryTargets, ...additions]);
    setLibraryView("all", "");
    setPage(Math.floor(discoveryTargets.length / JOB_SOURCES_PAGE_SIZE));
    setSourceUrlDraft("");
    setSourceAddMessage(
      `Added and turned on ${additions.length} source${additions.length === 1 ? "" : "s"}.` +
        (skippedDuplicates > 0
          ? ` ${skippedDuplicates} ${skippedDuplicates === 1 ? "was" : "were"} already in your list.`
          : ""),
    );
    // Adding is the whole act: the person should not have to find Save.
    if (props.onSaveNow) {
      const saveNow = props.onSaveNow;
      window.setTimeout(() => saveNow(), 0);
    }
  };

  // A tick is the whole act too, like a Settings switch: it saves at once
  // instead of turning the page's footer to "Unsaved changes".
  const toggleTarget = (targetId: string, enabled: boolean) => {
    updateDiscoveryTargets(
      discoveryTargets.map((target) =>
        target.id === targetId ? { ...target, enabled } : target,
      ),
    );
    if (props.onSaveNow) {
      const saveNow = props.onSaveNow;
      window.setTimeout(() => saveNow(), 0);
    }
  };

  const moveToPage = (nextPage: number) => {
    setPage(nextPage);
    setExpandedTargetId(null);
    window.requestAnimationFrame(() => {
      document
        .getElementById("profile-job-sources-list-heading")
        ?.scrollIntoView({ behavior: "auto", block: "start" });
    });
  };

  return (
    <section
      className={`grid content-start gap-(--gap-card) ${PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.base} ${PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.fixedHeader} ${PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.internalScroller}`}
      data-job-sources-library
      id="profile-job-sources"
    >
      <ProfileSectionHeader
        action={
          <Button
            aria-expanded={isAddOpen}
            onClick={() => setIsAddOpen((open) => !open)}
            type="button"
            variant={isAddOpen ? "secondary" : "primary"}
          >
            {isAddOpen ? "Close" : "Add sources"}
          </Button>
        }
        description="The careers pages and job boards Job Finder searches."
        eyebrow="Discovery library"
        headingId="profile-job-sources-heading"
        title="Job sources"
      />

      <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
        {isAddOpen ? (
          <div className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/35 p-3">
            <div className="grid gap-1">
              <FieldLabel htmlFor={`${searchInputId}-add-sources`}>
                Add sources
              </FieldLabel>
              <p className="text-sm leading-5 text-foreground-soft">
                Paste one or many careers pages or job boards, one per line or
                separated by commas. They are saved and turned on straight away.
              </p>
            </div>
            <ProfileTextarea
              id={`${searchInputId}-add-sources`}
              onChange={(event) => {
                setSourceUrlDraft(event.target.value);
                setSourceAddMessage(null);
              }}
              placeholder={
                "https://company.example/careers\nhttps://jobs.example/your-team"
              }
              value={sourceUrlDraft}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button
                disabled={newSourceUrls.length === 0}
                onClick={addSourceUrls}
                size="sm"
                type="button"
                variant="secondary"
              >
                {`Add ${newSourceUrls.length} source${newSourceUrls.length === 1 ? "" : "s"}`}
              </Button>
              {parsedSourceDraft.invalid.length > 0 ? (
                <p className="text-sm text-destructive" role="alert">
                  {`${parsedSourceDraft.invalid.length} entr${parsedSourceDraft.invalid.length === 1 ? "y is" : "ies are"} not a web address.`}
                </p>
              ) : duplicateSourceCount > 0 ? (
                <p className="text-sm text-foreground-soft" role="status">
                  {`${duplicateSourceCount} ${duplicateSourceCount === 1 ? "is" : "are"} already in your list.`}
                </p>
              ) : sourceAddMessage ? (
                <p className="text-sm text-foreground-soft" role="status">
                  {sourceAddMessage}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* One toolbar: search, the filters that would change the list,
            Check all, the count and the pager. A "Find a source" label row and
            a "Source library" heading row above the list said nothing the
            field and the rows do not. */}
        <div
          className={`flex min-w-0 flex-wrap items-center gap-2 ${PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.base} ${PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.fixedHeader} ${PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.internalScroller}`}
        >
          <h3
            className="sr-only"
            id="profile-job-sources-list-heading"
            tabIndex={-1}
          >
            Source library
          </h3>
          <label className="sr-only" htmlFor={searchInputId}>
            Find a source
          </label>
          <ProfileInput
            autoComplete="off"
            className="min-w-56 flex-1"
            id={searchInputId}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
              setExpandedTargetId(null);
            }}
            placeholder="Find a source by company, board, or URL"
            type="search"
            value={query}
          />
          {visibleFilterOptions.length > 1 ? (
            <div
              aria-label="Filter job sources"
              className="flex flex-wrap gap-1.5"
              role="group"
            >
              {visibleFilterOptions.map((option) => (
                <Button
                  aria-pressed={filter === option.id}
                  key={option.id}
                  onClick={() => setLibraryView(option.id)}
                  size="sm"
                  type="button"
                  variant={filter === option.id ? "primary" : "outline"}
                >
                  {option.label}
                  {option.id === "all" ? null : (
                    <span
                      aria-hidden="true"
                      className="tabular-nums opacity-75"
                    >
                      {filterCounts[option.id]}
                    </span>
                  )}
                </Button>
              ))}
            </div>
          ) : null}
          {anySourceCheckRunning ? (
            <Button
              disabled={!checkQueueActive}
              onClick={() => stopSourceCheckQueue()}
              size="sm"
              title={
                checkQueueActive
                  ? "Stops after the check that is running now."
                  : undefined
              }
              type="button"
              variant="outline"
            >
              {checkQueueActive
                ? `Checking ${Math.min(checkQueue.done + 1, checkQueue.total)} of ${checkQueue.total}${checkingTarget ? ` · ${checkingTarget.label}` : ""} · Stop`
                : "Checking one source…"}
            </Button>
          ) : checkableFilteredSources.length > 0 ? (
            <Button
              onClick={() =>
                startSourceCheckQueue(
                  checkableFilteredSources.map((target) => target.id),
                )
              }
              size="sm"
              title="Runs Check source on every enabled source in the current filter, one after another. Each check takes about five minutes, so ten sources is most of an hour."
              type="button"
              variant="outline"
            >
              {checkableFilteredSources.length === 1
                ? "Check this source"
                : `Check all ${checkableFilteredSources.length} sources`}
            </Button>
          ) : null}
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <p
              aria-atomic="true"
              aria-live="polite"
              className="text-(length:--text-small) text-foreground-muted"
              role="status"
            >
              {filteredSources.length === discoveryTargets.length
                ? `${discoveryTargets.length} ${discoveryTargets.length === 1 ? "source" : "sources"}`
                : `${filteredSources.length} of ${discoveryTargets.length} sources`}
            </p>
            {pageCount > 1 ? (
              <SourcePager
                aria-label="Job source pages (top of list)"
                className="flex flex-wrap items-center gap-2"
                currentPage={currentPage}
                moveToPage={moveToPage}
                nextAriaLabel="Next source page (top of list)"
                pageCount={pageCount}
                previousAriaLabel="Previous source page (top of list)"
              />
            ) : null}
          </div>
        </div>

        {discoveryTargets.length === 0 ? (
          <div className="rounded-(--radius-field) border border-dashed border-(--surface-panel-border) px-4 py-3 text-[0.9rem] leading-6 text-foreground-soft">
            <p className="font-medium text-foreground">
              Add your first public job source
            </p>
            <p className="mt-1">
              Add the careers page or job board you would normally browse. It is
              saved and turned on for searches straight away.
            </p>
          </div>
        ) : null}

        {discoveryTargets.length > 0 && filteredSources.length === 0 ? (
          <div className="rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-5 text-center">
            <p className="font-medium text-(--text-headline)">
              No sources match this view
            </p>
            <p className="mt-1 text-sm text-foreground-muted">
              Clear the search or choose All to return to the complete library.
            </p>
            {deferredQuery.trim().length > 0 ? (
              <p
                aria-live="polite"
                className="text-sm text-foreground-muted"
                role="status"
              >
                {`No sources match "${deferredQuery.trim()}"`}
              </p>
            ) : null}
            <Button
              className="mt-3"
              onClick={() => setLibraryView("all", "")}
              size="sm"
              type="button"
              variant="secondary"
            >
              Show all sources
            </Button>
          </div>
        ) : null}

        {visibleSources.length > 0 ? (
          <ul
            aria-label="Configured job sources"
            className="m-0 grid list-none gap-2 p-0"
          >
            {visibleSources.map(({ index, target }) => {
              const instructionArtifactId =
                target.draftInstructionId ?? target.validatedInstructionId;
              const isExpanded = expandedTargetId === target.id;
              const displayName =
                target.label.trim() || `New source ${index + 1}`;
              const accessPrompt =
                accessPromptByTargetId.get(target.id) ?? null;
              const health = describeEnabledSourceHealth(
                target,
                sourceHealthSignals,
              );
              const needsAttention =
                target.enabled && health.state === "needs_attention";
              // A check newer than the last search is what the row reports.
              const checkLine = describeLatestSourceCheck(
                target,
                sourceDebugRunsByTargetId.get(target.id) ?? [],
                sourceHealthSignals.latestExecutions?.get(target.id) ?? null,
              );

              return (
                <li className="min-w-0" key={target.id}>
                  {isExpanded ? (
                    <div
                      className="grid gap-2"
                      data-expanded-source-id={target.id}
                    >
                      <div className="flex justify-end">
                        <Button
                          aria-label={`Collapse editor for ${displayName}`}
                          onClick={() => setExpandedTargetId(null)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Collapse editor
                        </Button>
                      </div>
                      <ProfileDiscoveryTargetRow
                        discoveryTargets={discoveryTargets}
                        index={index}
                        instructionArtifact={
                          instructionArtifactId
                            ? (instructionArtifactById.get(
                                instructionArtifactId,
                              ) ?? null)
                            : null
                        }
                        isBrowserSessionPending={props.isBrowserSessionPending}
                        isSourceDebugPending={props.isSourceDebugPending}
                        isSourceInstructionPending={
                          props.isSourceInstructionPending
                        }
                        isSourceInstructionVerifyPending={
                          props.isSourceInstructionVerifyPending
                        }
                        isTargetDiscoveryPending={
                          props.isTargetDiscoveryPending
                        }
                        onGetSourceDebugRunDetails={
                          props.onGetSourceDebugRunDetails
                        }
                        onOpenBrowserSessionForTarget={
                          props.onOpenBrowserSessionForTarget
                        }
                        {...(props.onRunDiscoveryForTarget
                          ? {
                              onRunDiscoveryForTarget:
                                props.onRunDiscoveryForTarget,
                            }
                          : {})}
                        onRunSourceDebug={props.onRunSourceDebug}
                        onSaveSourceInstructionArtifact={
                          props.onSaveSourceInstructionArtifact
                        }
                        onVerifySourceInstructions={
                          props.onVerifySourceInstructions
                        }
                        recentSourceDebugRuns={props.recentSourceDebugRuns}
                        sourceAccessPrompt={accessPrompt}
                        target={target}
                        updateDiscoveryTargets={updateDiscoveryTargets}
                      />
                    </div>
                  ) : (
                    <article
                      className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-fill-subtle) px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                      data-compact-source-id={target.id}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4
                            className="min-w-0 max-w-full truncate font-semibold text-(--text-headline)"
                            title={displayName}
                          >
                            {displayName}
                          </h4>
                          {/* No Enabled/Disabled badge: the "Include in
                              search" checkbox on this row states it. */}
                          {needsAttention ? (
                            // Amber, not red: a source that failed is
                            // retried by the next search.
                            <span title={health.reason}>
                              <StatusBadge tone="warning">
                                Needs attention
                              </StatusBadge>
                            </span>
                          ) : null}
                        </div>
                        <p
                          className="mt-1 truncate text-sm text-foreground-muted"
                          title={target.startingUrl}
                        >
                          {target.startingUrl}
                        </p>
                        {target.enabled ? (
                          <p
                            className="mt-1 text-xs text-foreground-soft"
                            data-source-status-line
                          >
                            {checkLine ?? health.reason}
                          </p>
                        ) : getInstructionStatusLabel(target) ? (
                          <p className="mt-1 text-xs text-foreground-muted">
                            {getInstructionStatusLabel(target)}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                        {/* F78: this toggle was wrapped in a bordered pill at
                            the same height and border weight as the real
                            `Edit source` button beside it, so a checkbox and a
                            navigation read as two identical controls. The
                            toggle is now a plain checkbox+label with no button
                            chrome, and it reports its committed state in words
                            rather than leaving the tick as the only feedback. */}
                        <label className="flex min-h-9 items-center gap-2 text-sm text-foreground-soft">
                          <Checkbox
                            aria-label={`Include ${displayName} in searches`}
                            checked={target.enabled}
                            onCheckedChange={(checked) =>
                              toggleTarget(target.id, checked === true)
                            }
                          />
                          {/* The tick says on or off; a word beside it
                              said it again. */}
                          <span>Include in search</span>
                        </label>
                        <Button
                          aria-label={`Check ${displayName}`}
                          disabled={
                            props.isBrowserSessionPending(target.id) ||
                            props.isTargetDiscoveryPending(target.id)
                          }
                          onClick={() => props.onRunSourceDebug(target.id)}
                          pending={props.isSourceDebugPending(target.id)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {props.isSourceDebugPending(target.id)
                            ? "Checking"
                            : "Check source"}
                        </Button>
                        {props.onRunDiscoveryForTarget && target.enabled ? (
                          <Button
                            aria-label={`Search ${displayName} now`}
                            disabled={
                              props.isBrowserSessionPending(target.id) ||
                              props.isSourceDebugPending(target.id)
                            }
                            onClick={() =>
                              props.onRunDiscoveryForTarget?.(target.id)
                            }
                            pending={props.isTargetDiscoveryPending(target.id)}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            {props.isTargetDiscoveryPending(target.id)
                              ? "Searching"
                              : "Search now"}
                          </Button>
                        ) : null}
                        <Button
                          aria-expanded={false}
                          aria-label={`Edit ${displayName}`}
                          onClick={() => setExpandedTargetId(target.id)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Edit
                        </Button>
                      </div>
                    </article>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {pageCount > 1 ? (
          <SourcePager
            aria-label="Job source pages"
            className="flex flex-wrap items-center justify-between gap-3 border-t border-(--surface-panel-border) pt-3"
            currentPage={currentPage}
            moveToPage={moveToPage}
            pageCount={pageCount}
          >
            <span className="text-center text-(length:--text-small) text-foreground-muted">
              {firstVisibleSourceNumber}–{lastVisibleSourceNumber} of{" "}
              {filteredSources.length}
            </span>
          </SourcePager>
        ) : null}
      </article>
    </section>
  );
}
