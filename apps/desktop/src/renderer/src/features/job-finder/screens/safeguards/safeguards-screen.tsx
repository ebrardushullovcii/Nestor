import { useToast } from "@renderer/components/ui/toast";
import {
  PageHeaderStack,
  type PageStatusItem,
} from "../../components/page-header";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  JobFinderRendererWorkspaceSnapshot,
  SetJobFinderActivityControlInput,
  SafeguardMutationInput,
} from "@nestor/contracts";
import { Search, ShieldCheck } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { EmptyState } from "@renderer/features/job-finder/components/empty-state";
import { Input } from "@renderer/components/ui/input";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import {
  describeDailyPreparationUsage,
  formatDailyPreparationCapacityReachedText,
  isDailyPreparationCapacityExhausted,
} from "@renderer/features/job-finder/lib/job-finder-daily-capacity";
import { cn } from "@renderer/lib/utils";
import { SafeguardsApplicationBoundary } from "./safeguards-application-boundary";
import {
  CollectionPagination,
  COLLECTION_PAGE_SIZE,
} from "../../components/collection-pagination";
import {
  buildSafeguardsPresentationModel,
  filterSafeguardRows,
  safeguardMutationKey,
  type SafeguardControl,
  type SafeguardRow,
  type SafeguardTabId,
} from "./safeguards-presentation";

const TAB_ORDER: readonly { id: SafeguardTabId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "caps", label: "Application limits" },
  { id: "conflicts", label: "Conflicts" },
  { id: "signals", label: "Listing signals" },
  { id: "pauses", label: "Automatic pauses" },
  { id: "reviews", label: "Reviews" },
  { id: "contradictions", label: "Conflicting answers" },
  { id: "dismissals", label: "Dismissals" },
];

function SafeguardRowCard(props: {
  isPending: (controlId: string) => boolean;
  onMutate: (mutation: SafeguardMutationInput) => Promise<boolean>;
  row: SafeguardRow;
}) {
  const { isPending, onMutate, row } = props;
  const [error, setError] = useState<string | null>(null);

  async function runControl(control: SafeguardControl) {
    setError(null);
    const ok = await onMutate(control.mutation);
    if (!ok) {
      setError("That safeguard change could not be saved. Try again.");
    }
  }

  return (
    <article
      aria-label={row.title}
      className="grid min-w-0 gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-4 py-3"
      data-safeguard-kind={row.kind}
      data-safeguard-blocked={row.blocked ? "true" : "false"}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
          <h3 className="break-words [overflow-wrap:anywhere] font-semibold text-foreground">
            {row.title}
          </h3>
          <p className="break-words text-(length:--text-small) text-foreground-soft">
            {row.subtitle}
          </p>
        </div>
        <StatusBadge
          className="max-w-full whitespace-normal"
          tone={row.statusTone}
        >
          {row.statusLabel}
        </StatusBadge>
      </div>

      <div className="grid gap-1 text-(length:--text-small) leading-5">
        <p className="text-foreground">{row.explanation}</p>
        <p className="text-foreground-soft">Recovery: {row.recoveryGuidance}</p>
      </div>

      {row.lineage.jobs.length > 0 ||
      row.lineage.companies.length > 0 ||
      row.lineage.campaigns.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-(length:--text-small) leading-5">
          {row.lineage.jobs.length > 0 ? (
            <>
              <dt className="text-foreground-muted">Jobs</dt>
              <dd className="min-w-0 text-foreground">
                {row.lineage.jobs.map((label) => (
                  <span
                    className="block break-words [overflow-wrap:anywhere]"
                    key={label}
                    title={label}
                  >
                    {label}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          {row.lineage.companies.length > 0 ? (
            <>
              <dt className="text-foreground-muted">Companies</dt>
              <dd className="min-w-0 text-foreground">
                {row.lineage.companies.map((label) => (
                  <span
                    className="block break-words [overflow-wrap:anywhere]"
                    key={label}
                    title={label}
                  >
                    {label}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          {row.lineage.campaigns.length > 0 ? (
            <>
              <dt className="text-foreground-muted">Search plans</dt>
              <dd className="min-w-0 text-foreground">
                {row.lineage.campaigns.map((label) => (
                  <span
                    className="block break-words [overflow-wrap:anywhere]"
                    key={label}
                    title={label}
                  >
                    {label}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {row.sampleLinks?.map((link) => (
          <Button
            asChild
            key={link.href}
            size="sm"
            type="button"
            variant="outline"
          >
            <Link to={link.href}>Review {link.label}</Link>
          </Button>
        ))}
        {/* The recovery sentence above names a place to look. This is that
            place, so the guidance is never an instruction the page refuses to
            carry out. */}
        {row.recoveryLink ? (
          <Button asChild size="sm" type="button" variant="outline">
            <Link to={row.recoveryLink.href}>{row.recoveryLink.label}</Link>
          </Button>
        ) : null}
        <span className="ml-auto flex min-w-0 max-w-full flex-wrap justify-end gap-2">
          {row.controls.map((control) => (
            <Button
              // Pair choices name both jobs; they wrap instead of pushing the
              // card past a narrow column (the assistant panel open).
              className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left"
              data-safeguard-control
              disabled={isPending(safeguardMutationKey(control.mutation))}
              key={control.id}
              onClick={() => void runControl(control)}
              size="sm"
              type="button"
              variant={control.kind === "resolve" ? "primary" : "outline"}
            >
              {isPending(safeguardMutationKey(control.mutation))
                ? "Working…"
                : control.label}
            </Button>
          ))}
        </span>
      </div>
      {error ? (
        <p
          className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-small) leading-5 text-foreground-soft"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </article>
  );
}

export function SafeguardsScreen(props: {
  actionMessage: string | null;
  isPending: (controlId: string) => boolean;
  onMutateSafeguards: (input: SafeguardMutationInput) => Promise<boolean>;
  onSetActivityControl?: (
    input: SetJobFinderActivityControlInput,
  ) => Promise<boolean>;
  onResetBrowser?: () => Promise<boolean>;
  workspace: JobFinderRendererWorkspaceSnapshot | null;
}) {
  const { actionMessage, isPending, onMutateSafeguards, workspace } = props;
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<SafeguardTabId>(
    searchParams.get("tab") === "reviews" ? "reviews" : "all",
  );
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const { showToast } = useToast();
  const [browserResetPending, setBrowserResetPending] = useState(false);
  const [browserResetError, setBrowserResetError] = useState<string | null>(
    null,
  );
  const [confirmBrowserReset, setConfirmBrowserReset] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [eventsOpenOverride, setEventsOpenOverride] = useState<boolean | null>(
    null,
  );

  const model = useMemo(
    () =>
      workspace
        ? buildSafeguardsPresentationModel({
            safeguards: workspace.intelligence.safeguards,
            workspace,
          })
        : null,
    [workspace],
  );
  const activeTab = model && countForTab(model.counts, tab) > 0 ? tab : "all";
  const visibleRows = useMemo(
    () => (model ? filterSafeguardRows(model.rows, activeTab, query) : []),
    [model, activeTab, query],
  );
  const pageCount = Math.max(
    1,
    Math.ceil(visibleRows.length / COLLECTION_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount);
  const pagedRows = visibleRows.slice(
    (currentPage - 1) * COLLECTION_PAGE_SIZE,
    currentPage * COLLECTION_PAGE_SIZE,
  );
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  if (!workspace || !model) {
    return (
      <div className="grid min-h-72 place-items-center" role="status">
        <p className="text-(length:--text-small) text-foreground-soft">
          Loading safeguards…
        </p>
      </div>
    );
  }

  const blockedCount = model.counts.blockers;
  const isEmpty = model.rows.length === 0;
  // Zero-count filters were seven of eight chips on a healthy workspace and
  // wrapped the row onto a second line for nothing. Only categories that have
  // something in them are offered.
  const visibleTabs = TAB_ORDER.filter(
    (entry) => entry.id === "all" || countForTab(model.counts, entry.id) > 0,
  );
  const isNoMatch = !isEmpty && visibleRows.length === 0;
  // The event engine is secondary to the boundary above it, so it stays
  // folded away unless something is actually blocking work.
  const eventsOpen = eventsOpenOverride ?? blockedCount > 0;
  // The fixed local-day preparation limit is a limit, not a blocker: with no
  // slots left the page must not claim that "preparation is clear".
  const dailyCapacity =
    workspace.dashboard?.globalDailyApplicationPreparationCapacity ?? null;
  const dailyCapacityExhausted =
    isDailyPreparationCapacityExhausted(dailyCapacity);

  const isPaused = Boolean(workspace.activityControl?.paused);
  const resumeActivity = () => {
    setResumePending(true);
    setResumeError(null);
    void props
      .onSetActivityControl?.({ paused: false })
      .then((ok) => {
        if (!ok) throw new Error("Resume failed");
      })
      .catch(() => setResumeError("Work could not be resumed. Try again."))
      .finally(() => setResumePending(false));
  };
  // Conditions that affect this page but are owned elsewhere are items on
  // the header's status line, not boxes (ADR 0044). How many things are held
  // back is said once, on the events section below.
  const statusItems: PageStatusItem[] = [];
  if (resumeError) {
    statusItems.push({
      id: "resume-error",
      tone: "critical",
      text: resumeError,
    });
  }
  if (isPaused) {
    statusItems.push({
      id: "activity-paused",
      tone: "warning",
      text: "Everything is paused. Searches, application preparation and scheduled plans wait until you resume.",
      ...(props.onSetActivityControl
        ? {
            action: {
              kind: "button",
              label: "Resume everything",
              onClick: resumeActivity,
              pending: resumePending,
            },
          }
        : {}),
    });
  }
  if (dailyCapacityExhausted && dailyCapacity) {
    statusItems.push({
      id: "daily-capacity",
      tone: "info",
      text: formatDailyPreparationCapacityReachedText(dailyCapacity),
    });
  }

  return (
    <section aria-label="High-volume safeguards" className="min-w-0">
      {/* This screen used to paint its own <h1> at a bespoke size, so its
          page title could drift away from every other route's. It goes
          through the shared PageHeader like the rest of the app. The card
          below states the boundary in full, so the description no longer
          paraphrases it in smaller type first. */}
      <PageHeaderStack
        description="What Job Finder may do on application sites, and the limits that keep a large search safe."
        statusItems={statusItems}
        title="Safeguards"
      />

      {/* The header stack owns the seam to the content; the 16px gap is for
          the blocks below it only. */}
      <div className="grid gap-4">
        {/* An all-clear is a plain line, never a box (ADR 0042). The pause and
          the daily limit are on the status line above. With no event ever
          recorded it is the only line: an events card holding "0" and an
          empty state under it said the same thing twice. */}
        {!isPaused && blockedCount === 0 && !dailyCapacityExhausted ? (
          <div
            className="flex flex-wrap items-center gap-2 text-(length:--text-small) text-foreground-soft"
            {...(isEmpty ? { "data-safeguard-empty": "" } : {})}
            role="status"
            title={
              isEmpty
                ? "Job Finder records an event here only when one of its limits is actually reached: a per-company application limit, a listing that looks closed or suspicious, an unusual run of failures, or a batch waiting for your spot check."
                : undefined
            }
          >
            <ShieldCheck aria-hidden="true" className="size-4 text-positive" />
            <span>
              Nothing is being held back right now. Searching and preparing
              applications can both run.
              {isEmpty ? " No safety events yet." : ""}
            </span>
          </div>
        ) : null}

        {actionMessage ? (
          <p
            className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-2 text-(length:--text-small) leading-5 text-foreground-soft"
            role="status"
          >
            {actionMessage}
          </p>
        ) : null}

        {isEmpty &&
        !isPaused &&
        blockedCount === 0 &&
        !dailyCapacityExhausted ? null : (
          <details
            className="surface-panel-shell grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) p-4"
            data-safeguard-events
            onToggle={(event) =>
              setEventsOpenOverride(event.currentTarget.open ? true : false)
            }
            open={eventsOpen}
          >
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-(length:--text-body) font-semibold text-(--text-headline)">
              Safety events and automatic pauses
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-(--input) px-1 text-(length:--text-tiny) tabular-nums font-normal text-foreground">
                {model.counts.total}
              </span>
              {blockedCount > 0 ? (
                <span
                  className="inline-flex items-center gap-1.5 text-(length:--text-small) font-normal text-foreground"
                  data-safeguard-held-count
                >
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full bg-destructive"
                  />
                  {blockedCount} holding work back
                </span>
              ) : null}
            </summary>

            <div className="grid min-w-0 gap-3 pt-3">
              {!isEmpty ? (
                <div
                  className="grid min-w-0 gap-3 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,3fr)] lg:items-start"
                  data-safeguard-toolbar
                >
                  <div className="relative min-w-0">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      aria-label="Search safeguards"
                      className="pl-9"
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setPage(1);
                      }}
                      placeholder="Search safeguards"
                      type="search"
                      value={query}
                    />
                  </div>
                  <div
                    aria-label="Safeguard categories"
                    className="flex min-w-0 w-full flex-wrap items-center gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) p-1"
                    data-safeguard-categories
                    role="group"
                  >
                    {visibleTabs.map((entry) => {
                      const count = countForTab(model.counts, entry.id);
                      return (
                        <button
                          aria-pressed={activeTab === entry.id}
                          className={cn(
                            "inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-full px-3 text-(length:--text-small) font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
                            activeTab === entry.id
                              ? "bg-secondary text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          key={entry.id}
                          onClick={() => {
                            setTab(entry.id);
                            setPage(1);
                          }}
                          type="button"
                        >
                          {entry.label}
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-(--input) px-1 text-(length:--text-tiny) tabular-nums text-foreground">
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {isEmpty ? (
                <div data-safeguard-empty>
                  <EmptyState
                    className="min-h-40 px-5 py-6"
                    description="Job Finder records an event here only when one of its limits is actually reached — a per-company application limit, a listing that looks closed or suspicious, an unusual run of failures, or a batch waiting for your spot check. Nothing has been recorded yet."
                    title="No safety events yet"
                  />
                </div>
              ) : isNoMatch ? (
                <EmptyState
                  className="min-h-40 px-5 py-6"
                  description="Nothing in this category matches your search. Try a different term or clear the search box."
                  title="No matching safeguards"
                />
              ) : (
                <div className="grid min-w-0 gap-3">
                  {pagedRows.map((row) => (
                    <SafeguardRowCard
                      isPending={isPending}
                      key={row.key}
                      onMutate={(mutation) => {
                        setEventsOpenOverride(true);
                        return onMutateSafeguards(mutation);
                      }}
                      row={row}
                    />
                  ))}
                  <CollectionPagination
                    itemLabel="safeguards"
                    onPageChange={setPage}
                    page={currentPage}
                    pageSize={COLLECTION_PAGE_SIZE}
                    totalCount={visibleRows.length}
                  />
                </div>
              )}
            </div>
          </details>
        )}
        <SafeguardsApplicationBoundary>
          <div className="grid justify-items-start gap-2">
            <p className="text-sm text-foreground-soft">
              Reset closes all tabs, clears forms, attachments and sign-ins, and
              pauses work. Saved applications stay.
            </p>
            {confirmBrowserReset ? (
              <div
                role="alertdialog"
                aria-label="Reset browser confirmation"
                className="flex flex-wrap gap-3"
              >
                <span>
                  Close every browser tab and clear form entries, attachments
                  and sign-ins? Saved applications stay.
                </span>
                <Button
                  pending={browserResetPending}
                  onClick={() => {
                    setBrowserResetPending(true);
                    setBrowserResetError(null);
                    void props
                      .onResetBrowser?.()
                      .then((ok) => {
                        if (!ok) throw new Error("Browser reset failed");
                        setConfirmBrowserReset(false);
                        showToast({
                          title: "Browser cleared",
                          description:
                            "Work is paused. Resume everything when you are ready.",
                        });
                      })
                      .catch(() =>
                        setBrowserResetError(
                          "The browser could not be fully cleared. Try again before continuing.",
                        ),
                      )
                      .finally(() => setBrowserResetPending(false));
                  }}
                  variant="destructive"
                  size="sm"
                >
                  Clear browser
                </Button>
                <Button
                  disabled={browserResetPending}
                  onClick={() => setConfirmBrowserReset(false)}
                  variant="ghost"
                  size="sm"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                onClick={() => setConfirmBrowserReset(true)}
                variant="outline"
                size="sm"
              >
                Reset browser
              </Button>
            )}
            {browserResetError ? (
              <p role="alert" className="text-destructive">
                {browserResetError}
              </p>
            ) : null}
          </div>

          {dailyCapacity ? (
            <p className="text-sm text-foreground-soft">
              {describeDailyPreparationUsage({
                capacity: dailyCapacity,
                results: workspace.applyJobResults ?? [],
              })}
            </p>
          ) : null}
          {/* Limits are read when a run starts, so a change never reaches the
          run already in progress; and the per-plan limits and stop rules
          are edited on the plan, not here, which this page used to leave
          unsaid. */}
          <p className="text-(length:--text-small) leading-6 text-foreground-soft">
            Each limit is checked when its relevant work starts and applies from
            the next run you start. Per-plan limits and stop rules are edited on
            each plan in{" "}
            <Link
              className="font-medium text-foreground underline underline-offset-2"
              to="/job-finder/campaigns"
            >
              Search plans
            </Link>
            .
          </p>
        </SafeguardsApplicationBoundary>
      </div>
    </section>
  );
}

function countForTab(
  counts: {
    caps: number;
    conflicts: number;
    signals: number;
    pauses: number;
    reviews: number;
    contradictions: number;
    dismissals: number;
    total: number;
  },
  tab: SafeguardTabId,
): number {
  switch (tab) {
    case "all":
      return counts.total;
    case "caps":
      return counts.caps;
    case "conflicts":
      return counts.conflicts;
    case "signals":
      return counts.signals;
    case "pauses":
      return counts.pauses;
    case "reviews":
      return counts.reviews;
    case "contradictions":
      return counts.contradictions;
    case "dismissals":
      return counts.dismissals;
  }
}
