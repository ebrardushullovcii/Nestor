import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ResumeStrategy,
  ResumeStrategyRecommendation,
  ResumeStrategySelection,
  SelectResumeStrategyInput,
  SetCampaignResumeStrategyDefaultInput,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { formatPersistedStrategyReason } from "../resume-strategies/resume-strategy-presentation";

function buildResumeStrategiesRoute(jobId: string): string {
  const returnTo = `/job-finder/review-queue?${new URLSearchParams({ jobId }).toString()}`;
  return `/job-finder/resume-strategies?${new URLSearchParams({ returnTo }).toString()}`;
}

interface ResumeStrategyJobPanelProps {
  campaignId: string;
  /** Persisted default approach for this job's search plan, when one is set. */
  campaignDefaultResumeStrategyId?: string | null | undefined;
  isPending: boolean;
  jobId: string;
  onRecommend: (input: {
    jobId: string;
  }) => Promise<ResumeStrategyRecommendation | null>;
  onSelect: (input: SelectResumeStrategyInput) => void;
  onSetCampaignDefault?:
    | ((input: SetCampaignResumeStrategyDefaultInput) => void)
    | undefined;
  selections: readonly ResumeStrategySelection[];
  strategies: readonly ResumeStrategy[];
}

function describeSelectionSource(
  source: ResumeStrategySelection["source"] | null | undefined,
): string {
  switch (source) {
    case "user":
      return "Your choice";
    case "campaign_default":
      return "Search plan default";
    case "rule_match":
      return "Role-family match";
    default:
      return "Selection";
  }
}

export function ResumeStrategyJobPanel(props: ResumeStrategyJobPanelProps) {
  const [recommendation, setRecommendation] =
    useState<ResumeStrategyRecommendation | null>(null);
  const [recommendationState, setRecommendationState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [recommendError, setRecommendError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const onRecommendRef = useRef(props.onRecommend);
  const recommendationRequestRef = useRef<{
    jobId: string;
    searchPlanDefaultId: string | null;
    promise: Promise<ResumeStrategyRecommendation | null>;
  } | null>(null);
  onRecommendRef.current = props.onRecommend;
  // The persisted search-plan default is part of the recommendation inputs:
  // when it changes (for example after an explicit fallback assignment), the
  // recommendation must be re-requested so its source stays truthful.
  const campaignDefaultResumeStrategyId =
    props.campaignDefaultResumeStrategyId ?? null;

  useEffect(() => {
    let cancelled = false;
    setRecommendationState("loading");
    setRecommendation(null);
    setRecommendError(null);

    const existingRequest = recommendationRequestRef.current;
    const shouldReuse =
      retryNonce === 0 &&
      existingRequest?.jobId === props.jobId &&
      existingRequest.searchPlanDefaultId === campaignDefaultResumeStrategyId;
    const request = shouldReuse
      ? existingRequest.promise
      : Promise.resolve().then(() =>
          onRecommendRef.current({ jobId: props.jobId }),
        );
    recommendationRequestRef.current = {
      jobId: props.jobId,
      searchPlanDefaultId: campaignDefaultResumeStrategyId,
      promise: request,
    };

    void request
      .then((result) => {
        if (cancelled) return;
        setRecommendation(result);
        setRecommendationState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRecommendationState("error");
        setRecommendError(
          error instanceof Error
            ? error.message
            : "The recommendation could not be loaded.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [props.jobId, campaignDefaultResumeStrategyId, retryNonce]);

  const selection = useMemo(
    () => props.selections.find((entry) => entry.jobId === props.jobId) ?? null,
    [props.jobId, props.selections],
  );

  const strategyById = useMemo(
    () => new Map(props.strategies.map((strategy) => [strategy.id, strategy])),
    [props.strategies],
  );
  const enabledStrategies = props.strategies.filter(
    (strategy) => strategy.enabled,
  );
  const recommendedId = recommendation?.strategyId ?? null;
  const selectionStrategy = selection
    ? (strategyById.get(selection.strategyId) ?? null)
    : null;
  // Only an explicit per-job choice counts as "chosen" here. A rule match or a
  // search-plan default was applied by the product, not picked by the user.
  const chosenStrategy =
    selection && selection.source === "user" ? selectionStrategy : null;
  const fallbackCandidate =
    chosenStrategy && chosenStrategy.enabled ? chosenStrategy : null;
  const isFallbackAlreadyDefault =
    fallbackCandidate != null &&
    campaignDefaultResumeStrategyId === fallbackCandidate.id;

  const handleSelect = (strategyId: string) => {
    if (!strategyId || strategyId === selection?.strategyId) {
      return;
    }
    const strategy = strategyById.get(strategyId);
    if (!strategy) {
      return;
    }
    const reason =
      recommendedId === strategyId
        ? `User accepted the recommended approach "${strategy.name}"${
            recommendation?.reason ? ` (${recommendation.reason})` : ""
          }.`
        : `User chose approach "${strategy.name}" for this job instead of the recommendation.`;
    props.onSelect({
      jobId: props.jobId,
      campaignId: props.campaignId,
      strategyId,
      source: "manual",
      reason,
    });
  };

  return (
    <div className="surface-card-tint grid min-w-0 gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-4">
      <div className="grid gap-1">
        <span className="text-(length:--text-label) uppercase tracking-(--tracking-heading) text-foreground-soft">
          Resume approach
        </span>
        <p className="text-(length:--text-small) leading-6 text-foreground-soft">
          Optional: reuse a saved tailoring approach for this job.
        </p>
      </div>

      {recommendationState === "loading" ? (
        <p
          aria-atomic="true"
          aria-live="polite"
          className="text-(length:--text-small) leading-6 text-foreground-soft"
          role="status"
        >
          Checking approaches for this job…
        </p>
      ) : null}

      {recommendationState === "error" ? (
        <div
          className="grid gap-2 rounded-(--radius-small) border border-destructive/35 bg-destructive/8 px-3 py-2"
          role="alert"
        >
          <p className="text-(length:--text-small) font-semibold text-foreground">
            Recommendation unavailable
          </p>
          <p className="text-(length:--text-small) leading-5 text-foreground-soft">
            {recommendError}
          </p>
          <p className="text-(length:--text-small) leading-5 text-foreground-soft">
            Nothing was changed. You can retry the recommendation or manage your
            approaches directly.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setRetryNonce((current) => current + 1)}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
            <Button asChild size="sm" type="button" variant="ghost">
              <a href={buildResumeStrategiesRoute(props.jobId)}>
                Manage resume approaches
              </a>
            </Button>
          </div>
        </div>
      ) : null}

      {recommendationState === "ready" ? (
        <div className="grid gap-2">
          {recommendedId && recommendation?.strategyName ? (
            <div className="grid gap-1 rounded-(--radius-small) border border-primary/25 bg-primary/5 px-3 py-2.5">
              <p className="text-(length:--text-small) font-semibold text-(--text-headline)">
                Recommended: {recommendation.strategyName}
              </p>
              <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                {recommendation.reason}
              </p>
            </div>
          ) : enabledStrategies.length === 0 ? null : (
            <div className="grid gap-1 rounded-(--radius-small) border border-border-subtle px-3 py-2.5">
              <p className="text-(length:--text-small) font-semibold text-(--text-headline)">
                No resume approach recommended
              </p>
              <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                {recommendation?.reason ??
                  "No enabled approach matches this job's role family and no search plan default is set."}
              </p>
              <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                None of your enabled approaches matched this job. Creating a new
                approach never applies it automatically — you can use it for
                this job only below, or choose it first and then make it this
                search plan&apos;s default.
              </p>
            </div>
          )}

          {selection && selectionStrategy ? (
            <div className="grid gap-1 rounded-(--radius-small) border border-border-subtle bg-background/35 px-3 py-2.5">
              <p className="text-(length:--text-small) font-semibold text-(--text-headline)">
                {describeSelectionSource(selection.source)}:{" "}
                {selectionStrategy.name}
              </p>
              <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                {formatPersistedStrategyReason(selection.reason)}
              </p>
              {selection.source === "user" ? (
                <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                  Applies to this job only — other jobs and the search plan
                  default are unchanged.
                </p>
              ) : null}
              {selection.selectedAt ? (
                <p className="text-(length:--text-tiny) leading-5 text-foreground-muted">
                  Selected {new Date(selection.selectedAt).toLocaleString()}
                </p>
              ) : null}
            </div>
          ) : null}

          {enabledStrategies.length > 0 ? (
            <div className="grid gap-1 text-sm">
              <span className="font-medium">Use for this job only</span>
              <select
                aria-label="Choose a resume approach for this job"
                className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
                disabled={props.isPending}
                onChange={(event) => handleSelect(event.target.value)}
                // The control shows the approach in force for this job; the
                // placeholder only exists while nothing has been chosen yet.
                value={selection?.strategyId ?? ""}
              >
                {selection ? null : (
                  <option disabled value="">
                    {recommendedId
                      ? "Apply the recommendation…"
                      : "Choose a resume approach…"}
                  </option>
                )}
                {enabledStrategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.name}
                    {recommendedId === strategy.id ? " (recommended)" : ""}
                    {selection?.strategyId === strategy.id ? " (current)" : ""}
                  </option>
                ))}
              </select>
              <span className="text-(length:--text-tiny) leading-5 text-foreground-soft">
                Affects the tailored resumes for this job alone. Other jobs and
                this search plan&apos;s default stay unchanged.
              </span>
            </div>
          ) : null}

          {fallbackCandidate ? (
            isFallbackAlreadyDefault ? (
              <div className="grid gap-1 rounded-(--radius-small) border border-border-subtle bg-background/35 px-3 py-2.5">
                <p className="text-(length:--text-small) font-semibold text-(--text-headline)">
                  Search plan default: {fallbackCandidate.name}
                </p>
                <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                  Future jobs in this search plan are recommended this approach
                  whenever no enabled approach matches their role family more
                  closely. This job keeps your explicit choice.
                </p>
                <Button asChild size="sm" type="button" variant="ghost">
                  <a href={buildResumeStrategiesRoute(props.jobId)}>
                    Manage search plan default
                  </a>
                </Button>
              </div>
            ) : props.onSetCampaignDefault && props.campaignId ? (
              <div className="grid gap-2 rounded-(--radius-small) border border-border-subtle bg-background/35 px-3 py-2.5">
                <p className="text-(length:--text-small) font-semibold text-(--text-headline)">
                  Set as search plan default
                </p>
                <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                  &quot;{fallbackCandidate.name}&quot; would be recommended for
                  future jobs in this search plan whenever no enabled approach
                  matches their role family more closely — not just jobs like
                  this one. Nothing is approved by this, and this job keeps your
                  explicit choice.
                </p>
                <Button
                  onClick={() =>
                    props.onSetCampaignDefault?.({
                      campaignId: props.campaignId,
                      strategyId: fallbackCandidate.id,
                    })
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Set as search plan default
                </Button>
              </div>
            ) : (
              <div className="grid gap-1 rounded-(--radius-small) border border-border-subtle bg-background/35 px-3 py-2.5">
                <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                  You can make {fallbackCandidate.name} the default for future
                  jobs in this search plan — used whenever no enabled approach
                  matches their role family more closely — from your resume
                  approaches.
                </p>
                <Button asChild size="sm" type="button" variant="ghost">
                  <a href={buildResumeStrategiesRoute(props.jobId)}>
                    Manage search plan default
                  </a>
                </Button>
              </div>
            )
          ) : null}

          {props.isPending ? (
            <p
              aria-atomic="true"
              aria-live="polite"
              className="text-(length:--text-tiny) leading-5 text-foreground-muted"
              role="status"
            >
              Saving your choice…
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
