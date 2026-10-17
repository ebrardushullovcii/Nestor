import type { ApplyJobResultListRow, ApplyRunSummary } from "@nestor/contracts";
import { useEffect, useMemo, useState } from "react";
import type {
  JobDiscoveryTarget,
  JobSearchCampaign,
  OutcomeAnalyticsBucket,
  OutcomeAnalyticsOverview,
  OutcomeBucketDimension,
  OutcomeEvent,
  ResumeStrategy,
  SetOutcomeSuggestionEnabledInput,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { jobSourceLabel } from "../../lib/job-source-display-name";
import { Input } from "@renderer/components/ui/input";
import { EmptyState } from "../../components/empty-state";
import { Link } from "react-router-dom";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import { PageHeaderStack } from "../../components/page-header";
import { StatusBadge } from "../../components/status-badge";
import {
  CollectionPagination,
  COLLECTION_PAGE_SIZE,
} from "../../components/collection-pagination";
import {
  OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE,
  OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_RATES,
  bucketDisplayLabel,
  countOutcomeEvents,
  deriveCampaignScopedOutcomeAnalytics,
  formatRate,
  formatSampleSize,
  formatUncertainty,
  formatUncertaintyLevel,
  outcomeDimensionLabels,
  outcomeDimensionNoun,
  outcomeDimensionOrder,
  outcomeEventsForCampaign,
} from "./outcome-analytics-presentation";
import { deriveVerifiedApplicationFunnel } from "./outcome-analytics-presentation";

type OutcomeScope = { kind: "all" } | { kind: "campaign"; campaignId: string };

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matchesBucketQuery(
  bucket: OutcomeAnalyticsBucket,
  label: string,
  query: string,
): boolean {
  const normalized = normalizeQuery(query);
  if (!normalized) return true;
  return (
    label.toLocaleLowerCase().includes(normalized) ||
    bucket.key.toLocaleLowerCase().includes(normalized)
  );
}

function OutcomeCounts(props: { bucket: OutcomeAnalyticsBucket }) {
  const { bucket } = props;
  const entries = Object.entries(bucket.outcomeCounts).sort(
    (left, right) => right[1] - left[1],
  );
  if (entries.length === 0) {
    return (
      <p className="text-(length:--text-small) leading-5 text-muted-foreground">
        No outcomes recorded for this group yet.
      </p>
    );
  }
  return (
    <p className="text-(length:--text-small) leading-5 text-foreground-soft">
      {entries
        .map(([outcome, count]) => `${count} ${outcome.replaceAll("_", " ")}`)
        .join(" · ")}
    </p>
  );
}

function SuggestionPanel(props: {
  bucket: OutcomeAnalyticsBucket;
  isPending: boolean;
  onDisable: (input: SetOutcomeSuggestionEnabledInput) => void;
  onReset: (input: SetOutcomeSuggestionEnabledInput) => void;
}) {
  const { bucket } = props;
  const suggestion = bucket.suggestion;

  if (suggestion.disabledByUser) {
    return (
      <div className="grid gap-2 rounded-(--radius-field) border border-border/50 bg-background/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">
            Suggestion disabled by you
          </p>
          <Button
            disabled={props.isPending}
            onClick={() =>
              props.onReset({
                dimension: bucket.dimension,
                key: bucket.key,
                enabled: true,
                reset: true,
              })
            }
            pending={props.isPending}
            size="sm"
            type="button"
            variant="secondary"
          >
            Reset
          </Button>
        </div>
        <p className="text-(length:--text-small) leading-5 text-muted-foreground">
          Analytics will keep this suggestion off until you reset it. Nothing
          here changes objective job facts or filters.
        </p>
      </div>
    );
  }

  if (!suggestion.enabled || !suggestion.label) {
    return null;
  }

  return (
    <div className="grid gap-2 rounded-(--radius-field) border border-primary/25 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">
          {suggestion.label}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={props.isPending}
            onClick={() =>
              props.onDisable({
                dimension: bucket.dimension,
                key: bucket.key,
                enabled: false,
                reset: false,
              })
            }
            pending={props.isPending}
            size="sm"
            type="button"
            variant="ghost"
          >
            Disable
          </Button>
          <Button
            disabled={props.isPending}
            onClick={() =>
              props.onReset({
                dimension: bucket.dimension,
                key: bucket.key,
                enabled: true,
                reset: true,
              })
            }
            pending={props.isPending}
            size="sm"
            type="button"
            variant="secondary"
          >
            Reset
          </Button>
        </div>
      </div>
      {suggestion.reason ? (
        <p className="text-(length:--text-small) leading-5 text-foreground-soft">
          {suggestion.reason}
        </p>
      ) : null}
      <p className="text-(length:--text-small) leading-5 text-muted-foreground">
        This is a suggestion only — it is never applied automatically and never
        changes objective job facts or filters.
      </p>
    </div>
  );
}

function BucketCard(props: {
  activeCampaignId: string;
  bucket: OutcomeAnalyticsBucket;
  isPending: boolean;
  onDisable: (input: SetOutcomeSuggestionEnabledInput) => void;
  onReset: (input: SetOutcomeSuggestionEnabledInput) => void;
  resolvers: {
    campaignName: (campaignId: string) => string | null;
    resumeStrategyName: (strategyId: string) => string | null;
  };
}) {
  const { bucket } = props;
  const label = bucketDisplayLabel(bucket, props.resolvers);
  const isCurrentCampaign =
    bucket.dimension === "campaign" && bucket.key === props.activeCampaignId;
  const uncertaintyTone =
    bucket.uncertainty.level === "low"
      ? "positive"
      : bucket.uncertainty.level === "medium"
        ? "neutral"
        : "critical";

  return (
    <article
      // Identity for this bucket's card. Stored keys never reach the visible
      // copy, so this attribute is how a test tells one card from another.
      data-outcome-bucket-key={bucket.key}
      className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words font-semibold text-foreground">
              {label}
            </h3>
            {isCurrentCampaign ? (
              <StatusBadge tone="active">Current search plan</StatusBadge>
            ) : null}
            {bucket.suggestion.disabledByUser ? (
              <StatusBadge tone="muted">Suggestion off</StatusBadge>
            ) : null}
          </div>
          <p className="mt-1 text-(length:--text-small) leading-5 text-muted-foreground">
            {formatSampleSize(bucket.sampleSize)} ·{" "}
            {formatUncertainty(bucket.uncertainty)}
          </p>
        </div>
        <StatusBadge tone={uncertaintyTone}>
          {formatUncertaintyLevel(bucket.uncertainty.level)}
        </StatusBadge>
      </div>

      <OutcomeCounts bucket={bucket} />

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-(--radius-field) border border-border/50 bg-background/40 p-3">
          <p className="label-mono-xs">Response rate</p>
          <p className="mt-1 text-(length:--text-section-title) font-semibold text-foreground">
            {formatRate(bucket.responseRate)}
          </p>
          <p className="mt-1 text-(length:--text-small) leading-5 text-muted-foreground">
            {bucket.responseRate === null
              ? `Hidden until ${OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_RATES} recorded applications.`
              : `${bucket.rateNumerators.response} responded out of ${bucket.sampleSize}.`}
          </p>
        </div>
        <div className="rounded-(--radius-field) border border-border/50 bg-background/40 p-3">
          <p className="label-mono-xs">Interview rate</p>
          <p className="mt-1 text-(length:--text-section-title) font-semibold text-foreground">
            {formatRate(bucket.interviewRate)}
          </p>
          <p className="mt-1 text-(length:--text-small) leading-5 text-muted-foreground">
            {bucket.interviewRate === null
              ? `Hidden until ${OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_RATES} recorded applications.`
              : `${bucket.rateNumerators.interview} interviewed out of ${bucket.sampleSize}.`}
          </p>
        </div>
      </div>

      <SuggestionPanel
        bucket={bucket}
        isPending={props.isPending}
        onDisable={props.onDisable}
        onReset={props.onReset}
      />
    </article>
  );
}

const EMPTY_SOURCE_TARGETS: readonly Pick<
  JobDiscoveryTarget,
  "id" | "label"
>[] = [];

export function OutcomeAnalyticsScreen(props: {
  actionMessage: string | null;
  activeCampaignId: string;
  campaigns: readonly JobSearchCampaign[];
  events: readonly OutcomeEvent[];
  generatedAt: string;
  isSuggestionPending: (
    dimension: OutcomeBucketDimension,
    key: string,
  ) => boolean;
  /** True while the analytics inputs are still loading (rare: analytics are
   * synchronous once the workspace snapshot is ready, so the page-level
   * loader normally covers this). */
  loading?: boolean;
  onSetOutcomeSuggestionEnabled: (
    input: SetOutcomeSuggestionEnabledInput,
  ) => Promise<boolean>;
  applyJobResults?: readonly ApplyJobResultListRow[];
  applyRuns?: readonly ApplyRunSummary[];
  overview: OutcomeAnalyticsOverview | null;
  resumeStrategies: readonly ResumeStrategy[];
  /** The saved job sources, so a source bucket prints its own name. */
  sourceTargets?: readonly Pick<JobDiscoveryTarget, "id" | "label">[];
}) {
  const [scope, setScope] = useState<OutcomeScope>({
    kind: "campaign",
    campaignId: props.activeCampaignId,
  });
  const [dimension, setDimension] =
    useState<OutcomeBucketDimension>("campaign");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const sourceTargets = props.sourceTargets ?? EMPTY_SOURCE_TARGETS;
  const campaignById = useMemo(
    () => new Map(props.campaigns.map((campaign) => [campaign.id, campaign])),
    [props.campaigns],
  );
  const strategyById = useMemo(
    () =>
      new Map(
        props.resumeStrategies.map((strategy) => [strategy.id, strategy]),
      ),
    [props.resumeStrategies],
  );
  const resolvers = useMemo(
    () => ({
      campaignName: (campaignId: string) =>
        campaignById.get(campaignId)?.name ?? null,
      resumeStrategyName: (strategyId: string) =>
        strategyById.get(strategyId)?.name ?? null,
      sourceName: (sourceTargetId: string) =>
        jobSourceLabel(sourceTargetId, sourceTargets),
    }),
    [campaignById, sourceTargets, strategyById],
  );

  // If the selected campaign no longer exists (for example the active
  // campaign changed), fall back to the all-campaigns view rather than
  // showing a stale or empty scope.
  const effectiveScope = useMemo<OutcomeScope>(
    () =>
      scope.kind === "campaign" && !campaignById.has(scope.campaignId)
        ? { kind: "all" }
        : scope,
    [campaignById, scope],
  );

  const scopedEvents = useMemo(
    () =>
      effectiveScope.kind === "all"
        ? props.events
        : outcomeEventsForCampaign(props.events, effectiveScope.campaignId),
    [effectiveScope, props.events],
  );

  const viewOverview = useMemo(() => {
    if (effectiveScope.kind === "campaign") {
      return deriveCampaignScopedOutcomeAnalytics({
        events: scopedEvents,
        generatedAt: props.generatedAt,
        dimensions: [dimension],
        previousOverview: props.overview,
      });
    }
    if (props.overview) {
      return props.overview;
    }
    if (scopedEvents.length > 0) {
      return deriveCampaignScopedOutcomeAnalytics({
        events: scopedEvents,
        generatedAt: props.generatedAt,
        dimensions: [dimension],
        previousOverview: null,
      });
    }
    return null;
  }, [
    dimension,
    effectiveScope,
    props.generatedAt,
    props.overview,
    scopedEvents,
  ]);

  const bucketsForDimension = useMemo(
    () =>
      (viewOverview?.buckets ?? []).filter(
        (bucket) => bucket.dimension === dimension,
      ),
    [dimension, viewOverview?.buckets],
  );

  const visibleBuckets = useMemo(
    () =>
      bucketsForDimension.filter((bucket) =>
        matchesBucketQuery(
          bucket,
          bucketDisplayLabel(bucket, resolvers),
          query,
        ),
      ),
    [bucketsForDimension, query, resolvers],
  );
  const pageCount = Math.max(
    1,
    Math.ceil(visibleBuckets.length / COLLECTION_PAGE_SIZE),
  );
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const pagedVisibleBuckets = useMemo(
    () =>
      visibleBuckets.slice(
        (currentPage - 1) * COLLECTION_PAGE_SIZE,
        currentPage * COLLECTION_PAGE_SIZE,
      ),
    [currentPage, visibleBuckets],
  );

  useEffect(() => {
    setPage(1);
  }, [
    dimension,
    effectiveScope.kind,
    effectiveScope.kind === "campaign" ? effectiveScope.campaignId : null,
    query,
  ]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  const funnel = deriveVerifiedApplicationFunnel({
    results: props.applyJobResults ?? [],
    runs: props.applyRuns ?? [],
    events: scopedEvents,
    ...(effectiveScope.kind === "campaign"
      ? { campaignId: effectiveScope.campaignId }
      : {}),
  });
  const totalEventCount = useMemo(
    () => countOutcomeEvents(props.events),
    [props.events],
  );
  const scopedEventCount = scopedEvents.length;
  const enabledSuggestionCount = useMemo(
    () =>
      (viewOverview?.buckets ?? []).filter(
        (bucket) => bucket.suggestion.enabled,
      ).length,
    [viewOverview?.buckets],
  );

  const activeCampaignName =
    campaignById.get(props.activeCampaignId)?.name ?? null;
  const scopeLabel =
    effectiveScope.kind === "all"
      ? "All search plans"
      : (campaignById.get(effectiveScope.campaignId)?.name ??
        effectiveScope.campaignId);

  const hasAnyEvents = props.events.length > 0;
  const scopeHasEvents = scopedEvents.length > 0;
  const hasNoMatch =
    hasAnyEvents && visibleBuckets.length === 0 && normalizeQuery(query) !== "";

  const handleDisable = (input: SetOutcomeSuggestionEnabledInput) => {
    void props.onSetOutcomeSuggestionEnabled(input);
  };
  const handleReset = (input: SetOutcomeSuggestionEnabledInput) => {
    void props.onSetOutcomeSuggestionEnabled(input);
  };

  if (props.loading) {
    return (
      <section className="grid gap-4 pb-8">
        <PageHeaderStack
          description="Response and interview rates from your recorded outcomes."
          title="Outcomes"
        />

        {props.actionMessage ? (
          <p
            aria-atomic="true"
            aria-live="polite"
            className="rounded-(--radius-field) border border-border/50 bg-(--surface-panel-tint) px-3 py-2 text-(length:--text-small) leading-5 text-foreground-soft"
            role="status"
          >
            {props.actionMessage}
          </p>
        ) : null}

        <div
          aria-busy="true"
          className="grid min-h-40 place-items-center rounded-(--radius-field) border border-dashed border-border/70 bg-(--surface-panel-tint) px-5 py-8 text-center"
          role="status"
        >
          <p className="text-(length:--text-small) text-foreground-soft">
            Loading outcome analytics…
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="grid gap-4 pb-8">
      <PageHeaderStack
        description="Response and interview rates from your recorded outcomes."
        title="Outcomes"
      />

      <div aria-label="Application funnel" className="grid gap-2 text-sm">
        <p>
          <strong>{funnel.sent} sent</strong> · {funnel.responses} employer{" "}
          {funnel.responses === 1 ? "response" : "responses"} ·{" "}
          {funnel.responseRate === null
            ? "No response rate yet"
            : `${Math.round(funnel.responseRate * 100)}% response rate`}
        </p>
        <p>
          Sent counts come from employer receipts. Outcomes below are those you
          recorded.
          {funnel.sent > 0 && funnel.smallSample
            ? " This is a small sample; the rate may change quickly."
            : ""}
        </p>
      </div>
      {props.actionMessage ? (
        <p
          aria-atomic="true"
          aria-live="polite"
          className="rounded-(--radius-field) border border-border/50 bg-(--surface-panel-tint) px-3 py-2 text-(length:--text-small) leading-5 text-foreground-soft"
          role="status"
        >
          {props.actionMessage}
        </p>
      ) : null}

      <div className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) p-4 sm:grid-cols-[minmax(14rem,0.8fr)_repeat(3,minmax(0,1fr))] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          Search plan scope
          <select
            className="h-11 w-full rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) text-foreground outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) => {
              const value = event.target.value;
              setScope(
                value === "__all__"
                  ? { kind: "all" }
                  : { kind: "campaign", campaignId: value },
              );
            }}
            value={
              effectiveScope.kind === "all"
                ? "__all__"
                : effectiveScope.campaignId
            }
          >
            <option value="__all__">All search plans</option>
            {props.campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>
        <div className="rounded-(--radius-field) border border-border/50 bg-background/40 p-3">
          <p className="label-mono-xs">Scope</p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {scopeLabel}
          </p>
          <p className="mt-1 text-(length:--text-small) leading-5 text-muted-foreground">
            {scopedEventCount} outcome{" "}
            {scopedEventCount === 1 ? "event" : "events"} in scope
          </p>
        </div>
        <div className="rounded-(--radius-field) border border-border/50 bg-background/40 p-3">
          <p className="label-mono-xs">Outcome log</p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {totalEventCount} recorded
          </p>
          <p className="mt-1 text-(length:--text-small) leading-5 text-muted-foreground">
            {activeCampaignName
              ? `Active search plan: ${activeCampaignName}`
              : "No active search plan"}
          </p>
        </div>
        <div className="rounded-(--radius-field) border border-border/50 bg-background/40 p-3">
          <p className="label-mono-xs">Suggestions</p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {enabledSuggestionCount} active
          </p>
          <p className="mt-1 text-(length:--text-small) leading-5 text-muted-foreground">
            Shown only with enough data
          </p>
        </div>
      </div>

      {!hasAnyEvents ? (
        <div className="grid gap-3">
          <EmptyState
            className="min-h-40 px-5 py-6"
            description="Record what happened to each application from Applications → Tracker: completed, abandoned, employer response, assessment, interview, offer, rejection, withdrawal, or no response. Rates and suggestions appear here only after you record outcomes — nothing is inferred."
            title="No outcomes recorded yet"
          />
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="sm" type="button">
              <Link to={JOB_FINDER_ROUTE_PATHS.applications}>
                Open Applications Tracker
              </Link>
            </Button>
          </div>
        </div>
      ) : !scopeHasEvents ? (
        <div className="grid gap-3">
          <EmptyState
            className="min-h-40 px-5 py-6"
            description="This search plan has no recorded outcomes yet. Record what happened to its applications in Applications → Tracker, then return here."
            title="No outcomes in this search plan"
          />
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="sm" type="button">
              <Link to={JOB_FINDER_ROUTE_PATHS.applications}>
                Open Applications Tracker
              </Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <div
            aria-label="Analytics dimension"
            className="flex w-fit max-w-full flex-wrap gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) p-1"
            role="group"
          >
            {outcomeDimensionOrder.map((candidate) => (
              <Button
                aria-pressed={dimension === candidate}
                key={candidate}
                onClick={() => setDimension(candidate)}
                size="sm"
                type="button"
                variant={dimension === candidate ? "secondary" : "ghost"}
              >
                {outcomeDimensionLabels[candidate]}
              </Button>
            ))}
          </div>

          <div className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) p-3">
            <label
              className="grid gap-1.5 text-sm font-medium text-foreground"
              htmlFor="outcome-analytics-search"
            >
              Filter {outcomeDimensionNoun(dimension)}
              <Input
                autoComplete="off"
                id="outcome-analytics-search"
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Filter ${outcomeDimensionNoun(dimension)} by name`}
                type="search"
                value={query}
              />
            </label>
            <p
              aria-atomic="true"
              aria-live="polite"
              className="text-(length:--text-small) text-foreground-muted"
            >
              {normalizeQuery(query) !== ""
                ? `${visibleBuckets.length} of ${bucketsForDimension.length} ${outcomeDimensionNoun(dimension, bucketsForDimension.length)} matched`
                : `${bucketsForDimension.length} ${outcomeDimensionNoun(dimension, bucketsForDimension.length)} in scope`}
            </p>
          </div>

          {hasNoMatch ? (
            <div className="grid min-h-40 place-items-center rounded-(--radius-field) border border-dashed border-border/70 bg-(--surface-panel-tint) px-5 py-8 text-center">
              <div className="grid max-w-md gap-3">
                <p className="font-semibold text-(--text-headline)">
                  No {outcomeDimensionNoun(dimension)} match “{query.trim()}”
                </p>
                <p className="text-sm text-foreground-soft">
                  Try a shorter phrase or switch to another dimension. Nothing
                  here has changed.
                </p>
                <Button
                  className="justify-self-center"
                  onClick={() => setQuery("")}
                  type="button"
                  variant="secondary"
                >
                  Clear search
                </Button>
              </div>
            </div>
          ) : (
            <>
              <ul className="grid gap-3">
                {pagedVisibleBuckets.map((bucket) => (
                  <li key={`${bucket.dimension}:${bucket.key}`}>
                    <BucketCard
                      activeCampaignId={props.activeCampaignId}
                      bucket={bucket}
                      isPending={props.isSuggestionPending(
                        bucket.dimension,
                        bucket.key,
                      )}
                      onDisable={handleDisable}
                      onReset={handleReset}
                      resolvers={resolvers}
                    />
                  </li>
                ))}
              </ul>
              <CollectionPagination
                itemLabel={outcomeDimensionNoun(dimension)}
                onPageChange={setPage}
                page={currentPage}
                pageSize={COLLECTION_PAGE_SIZE}
                totalCount={visibleBuckets.length}
              />
            </>
          )}

          {bucketsForDimension.length === 0 ? (
            <p className="text-(length:--text-small) leading-5 text-muted-foreground">
              No {outcomeDimensionNoun(dimension)} have recorded outcomes in
              this scope yet. Record outcomes from Applications → Tracker to
              build up this view.
            </p>
          ) : null}

          <div className="grid gap-1 rounded-(--radius-field) border border-border/40 bg-background/30 p-3">
            <p className="label-mono-xs">How to read this</p>
            <p className="text-(length:--text-small) leading-5 text-foreground-soft">
              Rates stay hidden until a group has at least{" "}
              {OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_RATES} recorded applications so
              small samples are never presented as measured facts. Uncertainty
              is tied to sample size, and a 95% confidence-interval half-width
              is shown from {OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE}{" "}
              applications. Suggestions appear only at that sample with a
              visible half-width, and you can disable or reset each one — they
              are never applied silently.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
