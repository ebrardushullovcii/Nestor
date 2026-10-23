import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  JobSearchCampaign,
  ResumeStrategy,
  ResumeStrategyEvidenceBoundaries,
  SaveResumeStrategyInput,
  SetCampaignResumeStrategyDefaultInput,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { EmptyState } from "../../components/empty-state";
import { PageHeaderStack } from "../../components/page-header";
import { StatusBadge } from "../../components/status-badge";
import {
  CollectionNoMatches,
  CollectionSearchToolbar,
  matchesCollectionSearch,
} from "../../components/collection-search-toolbar";
import {
  describeEvidenceBoundaries,
  resumeCoveragePolicyLabels,
  resumeHeadlinePolicyLabels,
  resumeSkillsPolicyLabels,
  resumeApproachLabels,
  resumeTailoringStrengthLabels,
  resumeTemplateLabels,
  strategySearchTokens,
} from "./resume-strategy-presentation";

const evidenceBoundaryOptions: ReadonlyArray<{
  key: keyof ResumeStrategyEvidenceBoundaries;
  label: string;
}> = [
  {
    key: "allowExactClaims",
    label: "Allow exact claims from saved evidence",
  },
  {
    key: "allowParaphrasedClaims",
    label: "Allow paraphrased claims grounded in evidence",
  },
  {
    key: "requireVerifierPass",
    label: "Require verifier pass before export",
  },
];

function toSaveInput(
  strategy: ResumeStrategy,
  overrides: Partial<SaveResumeStrategyInput> = {},
): SaveResumeStrategyInput {
  return {
    id: strategy.id,
    name: strategy.name,
    roleFamily: strategy.roleFamily,
    baseResumeDocumentId: strategy.baseResumeDocumentId,
    templateId: strategy.templateId,
    headlinePolicy: strategy.headlinePolicy,
    skillsPolicy: strategy.skillsPolicy,
    coveragePolicy: strategy.coveragePolicy,
    tailoringStrength: strategy.tailoringStrength,
    evidenceBoundaries: strategy.evidenceBoundaries,
    enabled: strategy.enabled,
    ...overrides,
  };
}

function emptyFormInput(baseResumeDocumentId: string): SaveResumeStrategyInput {
  return {
    id: null,
    name: "",
    roleFamily: "",
    baseResumeDocumentId,
    templateId: "classic_ats",
    headlinePolicy: "fixed",
    skillsPolicy: "base_only",
    coveragePolicy: "base_omissions",
    tailoringStrength: "conservative",
    evidenceBoundaries: {
      allowExactClaims: true,
      allowParaphrasedClaims: false,
      maxEvidenceRefsPerBullet: 3,
      requireVerifierPass: true,
    },
    enabled: true,
  };
}

function getSafeShortlistedReturnPath(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value, "https://nestor.internal");
    if (
      parsed.origin !== "https://nestor.internal" ||
      parsed.pathname !== "/job-finder/review-queue"
    ) {
      return null;
    }

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function StrategyForm(props: {
  baseResumeDocumentId: string;
  candidateDocumentIds: readonly string[];
  isPending: boolean;
  onCancel: () => void;
  onSave: (input: SaveResumeStrategyInput) => void | Promise<void>;
  value: SaveResumeStrategyInput;
}) {
  const [draft, setDraft] = useState<SaveResumeStrategyInput>(props.value);
  const update = (patch: Partial<SaveResumeStrategyInput>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const updateBoundaries = (patch: Partial<ResumeStrategyEvidenceBoundaries>) =>
    update({
      evidenceBoundaries: { ...draft.evidenceBoundaries, ...patch },
    });
  const isEdit = Boolean(draft.id);

  return (
    <form
      className="surface-panel-shell grid gap-5 rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave(draft);
      }}
    >
      <div>
        <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
          Resume approach
        </p>
        <h2 className="mt-1 font-semibold text-(--text-headline)">
          {isEdit ? "Edit resume approach" : "Create resume approach"}
        </h2>
        <p className="mt-1 text-(length:--text-small) leading-6 text-foreground-soft">
          An approach saves how you want resumes tailored for one kind of role.
          Saving or reusing one never approves a resume — you review and approve
          each resume before it is applied.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Name</span>
          <Input
            maxLength={120}
            onChange={(event) => update({ name: event.target.value })}
            required
            value={draft.name}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Role family</span>
          <Input
            maxLength={120}
            onChange={(event) => update({ roleFamily: event.target.value })}
            placeholder="Backend Engineering"
            required
            value={draft.roleFamily}
          />
        </label>
        <label className="grid gap-1 text-sm sm:col-span-2">
          <span className="font-medium">Start from this resume</span>
          <Input
            list="resume-strategy-base-resume-options"
            onChange={(event) =>
              update({ baseResumeDocumentId: event.target.value })
            }
            required
            value={draft.baseResumeDocumentId}
          />
          <datalist id="resume-strategy-base-resume-options">
            {[props.baseResumeDocumentId, ...props.candidateDocumentIds]
              .filter(
                (value, index, all) => value && all.indexOf(value) === index,
              )
              .map((value) => (
                <option key={value} value={value} />
              ))}
          </datalist>
          <span className="text-(length:--text-tiny) leading-5 text-foreground-muted">
            The saved resume this approach starts from. Picking it here is not
            an approval — you still review each generated resume before it is
            applied.
          </span>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Template</span>
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) =>
              update({
                templateId: event.target
                  .value as SaveResumeStrategyInput["templateId"],
              })
            }
            value={draft.templateId}
          >
            {Object.entries(resumeTemplateLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Tailoring strength</span>
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) =>
              update({
                tailoringStrength: event.target
                  .value as SaveResumeStrategyInput["tailoringStrength"],
              })
            }
            value={draft.tailoringStrength}
          >
            {Object.entries(resumeTailoringStrengthLabels).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Headline policy</span>
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) =>
              update({
                headlinePolicy: event.target
                  .value as SaveResumeStrategyInput["headlinePolicy"],
              })
            }
            value={draft.headlinePolicy}
          >
            {Object.entries(resumeHeadlinePolicyLabels).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Skills policy</span>
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) =>
              update({
                skillsPolicy: event.target
                  .value as SaveResumeStrategyInput["skillsPolicy"],
              })
            }
            value={draft.skillsPolicy}
          >
            {Object.entries(resumeSkillsPolicyLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">Coverage policy</span>
          <select
            className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
            onChange={(event) =>
              update({
                coveragePolicy: event.target
                  .value as SaveResumeStrategyInput["coveragePolicy"],
              })
            }
            value={draft.coveragePolicy}
          >
            {Object.entries(resumeCoveragePolicyLabels).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
      </div>

      <fieldset className="grid gap-2 rounded-(--radius-field) border border-border-subtle p-4">
        <legend className="text-sm font-semibold text-(--text-headline)">
          Evidence boundaries
        </legend>
        <p className="text-(length:--text-small) leading-5 text-foreground-soft">
          These control what generated wording may cite from your saved
          evidence. Your per-job review and approval always have the final say.
        </p>
        {evidenceBoundaryOptions.map((option) => (
          <label className="flex items-center gap-2 text-sm" key={option.key}>
            <input
              checked={Boolean(draft.evidenceBoundaries[option.key])}
              onChange={(event) =>
                updateBoundaries({
                  [option.key]: event.target.checked,
                } as unknown as Partial<ResumeStrategyEvidenceBoundaries>)
              }
              type="checkbox"
            />
            {option.label}
          </label>
        ))}
        <label className="grid max-w-72 gap-1 text-sm">
          <span>Max evidence references per bullet</span>
          <Input
            max={10}
            min={0}
            onChange={(event) =>
              updateBoundaries({
                maxEvidenceRefsPerBullet: Number(event.target.value),
              })
            }
            type="number"
            value={draft.evidenceBoundaries.maxEvidenceRefsPerBullet}
          />
        </label>
      </fieldset>

      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={props.onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={
            draft.name.trim().length === 0 ||
            draft.roleFamily.trim().length === 0 ||
            draft.baseResumeDocumentId.trim().length === 0
          }
          pending={props.isPending}
          type="submit"
        >
          {isEdit ? "Save changes" : "Create resume approach"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Where an approach is in use: the shortlisted jobs that chose or were
 * recommended it, split by what a re-tailor may touch. Approved resumes are
 * never regenerated from here.
 */
export interface ResumeStrategyUsage {
  jobCount: number;
  retailorableJobIds: readonly string[];
  approvedCount: number;
}

function describeUsage(usage: ResumeStrategyUsage): string {
  if (usage.jobCount === 0) return "No shortlisted jobs yet";
  return `${usage.jobCount} shortlisted job${usage.jobCount === 1 ? "" : "s"}`;
}

function StrategyCard(props: {
  baseResumeDocumentId: string;
  isDisablePending: boolean;
  isSavePending: boolean;
  onDisable: (strategyId: string) => void;
  onEdit: (strategy: ResumeStrategy) => void;
  onEnable: (strategy: ResumeStrategy) => void;
  strategy: ResumeStrategy;
  usage?: ResumeStrategyUsage;
}) {
  const { strategy } = props;
  const boundaries = describeEvidenceBoundaries(strategy.evidenceBoundaries);

  return (
    <article className="surface-panel-shell grid gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-(--text-headline)">
              {strategy.name}
            </h2>
            <StatusBadge tone={strategy.enabled ? "active" : "muted"}>
              {strategy.enabled ? "Enabled" : "Disabled"}
            </StatusBadge>
          </div>
          <p className="mt-1 text-(length:--text-small) capitalize text-foreground-soft">
            {strategy.roleFamily}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {strategy.enabled ? (
            <Button
              disabled={props.isDisablePending}
              onClick={() => props.onDisable(strategy.id)}
              pending={props.isDisablePending}
              size="sm"
              type="button"
              variant="outline"
            >
              Disable
            </Button>
          ) : (
            <Button
              disabled={props.isSavePending}
              onClick={() => props.onEnable(strategy)}
              pending={props.isSavePending}
              size="sm"
              type="button"
              variant="secondary"
            >
              Enable
            </Button>
          )}
          <Button
            onClick={() => props.onEdit(strategy)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Edit
          </Button>
        </div>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Template
          </dt>
          <dd className="text-foreground-soft">
            {resumeTemplateLabels[strategy.templateId] ?? strategy.templateId}
          </dd>
        </div>
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Tailoring strength
          </dt>
          <dd className="text-foreground-soft">
            {resumeApproachLabels[strategy.tailoringStrength]}
          </dd>
        </div>
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Headline policy
          </dt>
          <dd className="text-foreground-soft">
            {resumeHeadlinePolicyLabels[strategy.headlinePolicy]}
          </dd>
        </div>
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Skills policy
          </dt>
          <dd className="text-foreground-soft">
            {resumeSkillsPolicyLabels[strategy.skillsPolicy]}
          </dd>
        </div>
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Coverage policy
          </dt>
          <dd className="text-foreground-soft">
            {resumeCoveragePolicyLabels[strategy.coveragePolicy]}
          </dd>
        </div>
        <div>
          <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
            Base resume
          </dt>
          <dd className="break-all text-foreground-soft">
            {strategy.baseResumeDocumentId === props.baseResumeDocumentId
              ? "Your imported resume"
              : strategy.baseResumeDocumentId}
          </dd>
        </div>
        {props.usage ? (
          <div>
            <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
              Used by
            </dt>
            <dd className="text-foreground-soft">
              {describeUsage(props.usage)}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="text-(length:--text-small) leading-5 text-foreground-soft">
        {boundaries}
      </p>
      <p className="text-(length:--text-tiny) leading-5 text-foreground-muted">
        Reusing this approach never approves a resume — you review before
        applying. Updated {strategy.updatedAt.slice(0, 10)}.
      </p>
    </article>
  );
}

function CampaignDefaultsSection(props: {
  campaigns: readonly JobSearchCampaign[];
  isPending: (campaignId: string) => boolean;
  onSetDefault: (input: SetCampaignResumeStrategyDefaultInput) => void;
  strategies: readonly ResumeStrategy[];
}) {
  const enabledStrategies = props.strategies.filter(
    (strategy) => strategy.enabled,
  );
  // With no approach to pick, each plan's select held only "No default".
  const anyDefaultSet = props.campaigns.some(
    (campaign) => campaign.applicationPolicy.defaultResumeStrategyId,
  );
  if (enabledStrategies.length === 0 && !anyDefaultSet) return null;

  if (props.campaigns.length === 0) {
    return (
      <section className="grid gap-3 rounded-(--radius-field) border border-border-subtle p-4">
        <h3 className="font-semibold text-(--text-headline)">
          Search plan defaults
        </h3>
        <p className="text-(length:--text-small) leading-5 text-foreground-soft">
          No search plans yet. Create one first, then assign its default resume
          approach here.
        </p>
      </section>
    );
  }

  return (
    <section className="grid gap-3 rounded-(--radius-field) border border-border-subtle p-4">
      <div>
        <h3 className="font-semibold text-(--text-headline)">
          Search plan defaults
        </h3>
        <p className="mt-1 text-(length:--text-small) leading-5 text-foreground-soft">
          Each search plan can name one enabled approach as its fallback
          recommendation. Assigning a default never approves anything on its
          own.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {props.campaigns.map((campaign) => {
          const currentDefaultId =
            campaign.applicationPolicy.defaultResumeStrategyId ?? "";
          const currentDefaultStrategy = props.strategies.find(
            (strategy) => strategy.id === currentDefaultId,
          );
          const currentDefaultIsDisabled =
            currentDefaultStrategy?.enabled === false;
          return (
            <div className="grid gap-2 text-sm" key={campaign.id}>
              <label className="grid gap-1">
                <span className="font-medium">{campaign.name}</span>
                <select
                  className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 text-(length:--text-field) outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
                  disabled={props.isPending(campaign.id)}
                  onChange={(event) =>
                    props.onSetDefault({
                      campaignId: campaign.id,
                      strategyId: event.target.value || null,
                    })
                  }
                  value={currentDefaultId}
                >
                  <option value="">No default</option>
                  {currentDefaultIsDisabled && currentDefaultStrategy ? (
                    <option disabled value={currentDefaultStrategy.id}>
                      {currentDefaultStrategy.name} (Disabled)
                    </option>
                  ) : null}
                  {enabledStrategies.map((strategy) => (
                    <option key={strategy.id} value={strategy.id}>
                      {strategy.name}
                    </option>
                  ))}
                </select>
                {props.isPending(campaign.id) ? (
                  <span className="text-(length:--text-tiny) text-foreground-muted">
                    Saving…
                  </span>
                ) : null}
              </label>
              {currentDefaultIsDisabled && currentDefaultStrategy ? (
                <div
                  aria-live="polite"
                  className="grid gap-2 rounded-(--radius-small) border border-destructive/25 bg-destructive/5 p-3"
                  role="status"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone="critical">Disabled default</StatusBadge>
                    <span className="text-(length:--text-small) leading-5 text-foreground-soft">
                      {currentDefaultStrategy.name} is still this search
                      plan&apos;s default, but it will not be recommended while
                      disabled.
                    </span>
                  </div>
                  <Button
                    disabled={props.isPending(campaign.id)}
                    onClick={() =>
                      props.onSetDefault({
                        campaignId: campaign.id,
                        strategyId: null,
                      })
                    }
                    pending={props.isPending(campaign.id)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Clear default
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ResumeStrategiesScreen(props: {
  actionMessage: string | null;
  baseResumeDocumentId: string;
  campaigns: readonly JobSearchCampaign[];
  candidateDocumentIds: readonly string[];
  isCampaignDefaultPending: (campaignId: string) => boolean;
  isDisablePending: (strategyId: string) => boolean;
  isLoading: boolean;
  isSavePending: boolean;
  loadError?: string | null;
  onDisableStrategy: (strategyId: string) => void;
  onRetry?: () => void;
  onSaveStrategy: (input: SaveResumeStrategyInput) => Promise<boolean>;
  onSetCampaignDefault: (input: SetCampaignResumeStrategyDefaultInput) => void;
  /** Re-tailors the given jobs' unapproved drafts with their current approach. */
  onRetailorJobs?: (jobIds: readonly string[]) => void;
  strategies: readonly ResumeStrategy[];
  strategyUsage?: (strategyId: string) => ResumeStrategyUsage;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SaveResumeStrategyInput | null>(null);
  // After an edit, the jobs already using the approach are the open question:
  // they keep their current drafts, and this is the one place to act on that.
  const [savedNotice, setSavedNotice] = useState<{
    strategyId: string;
    name: string;
  } | null>(null);
  const savedUsage =
    savedNotice && props.strategyUsage
      ? props.strategyUsage(savedNotice.strategyId)
      : null;
  const [searchParams] = useSearchParams();
  const shortlistedReturnPath = getSafeShortlistedReturnPath(
    searchParams.get("returnTo"),
  );

  const filteredStrategies = useMemo(
    () =>
      props.strategies.filter((strategy) =>
        matchesCollectionSearch(query, strategySearchTokens(strategy)),
      ),
    [props.strategies, query],
  );

  if (props.isLoading) {
    return (
      <main className="grid min-h-full place-items-center px-6 py-10">
        <EmptyState
          title="Loading resume approaches"
          description="Loading saved approaches, search plans, and defaults."
        />
      </main>
    );
  }

  return (
    <section className="grid gap-5 pb-8">
      <PageHeaderStack
        actions={
          <>
            {shortlistedReturnPath ? (
              <Button asChild size="sm" type="button" variant="outline">
                <Link to={shortlistedReturnPath}>Back to shortlisted job</Link>
              </Button>
            ) : null}
            {/* The empty state carries its own button; one is enough. */}
            {props.strategies.length > 0 || props.loadError ? (
              <Button
                onClick={() =>
                  setEditing(emptyFormInput(props.baseResumeDocumentId))
                }
                size="sm"
                type="button"
              >
                New resume approach
              </Button>
            ) : null}
          </>
        }
        description="Save reusable resume approaches and review every change before applying them."
        title="Resume approaches"
      />

      {props.actionMessage ? (
        <p
          aria-atomic="true"
          aria-live="polite"
          className="min-w-0 break-words rounded-(--radius-small) border border-primary/25 bg-primary/5 px-3 py-2 text-(length:--text-small) leading-6 text-foreground"
          role="status"
        >
          {props.actionMessage}
        </p>
      ) : null}

      {savedNotice && savedUsage && savedUsage.jobCount > 0 ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-(--radius-small) border border-border-subtle px-3 py-2 text-(length:--text-small) leading-6 text-foreground"
          data-testid="resume-strategy-usage-notice"
          role="status"
        >
          <span>
            {`${describeUsage(savedUsage)} use "${savedNotice.name}".`}
            {savedUsage.retailorableJobIds.length > 0
              ? ` ${savedUsage.retailorableJobIds.length === 1 ? "Its current draft stays" : "Their current drafts stay"} as ${savedUsage.retailorableJobIds.length === 1 ? "it is" : "they are"} until you re-tailor ${savedUsage.retailorableJobIds.length === 1 ? "it" : "them"}.`
              : ""}
            {savedUsage.approvedCount > 0
              ? ` ${savedUsage.approvedCount} approved resume${savedUsage.approvedCount === 1 ? " is" : "s are"} left untouched.`
              : ""}
          </span>
          {savedUsage.retailorableJobIds.length > 0 && props.onRetailorJobs ? (
            <Button
              onClick={() => {
                props.onRetailorJobs?.(savedUsage.retailorableJobIds);
                setSavedNotice(null);
              }}
              size="xs"
              type="button"
              variant="outline"
            >
              {`Re-tailor ${savedUsage.retailorableJobIds.length} draft${savedUsage.retailorableJobIds.length === 1 ? "" : "s"}`}
            </Button>
          ) : null}
          <Button
            onClick={() => setSavedNotice(null)}
            size="xs"
            type="button"
            variant="ghost"
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      {props.loadError ? (
        <div
          className="grid gap-2 rounded-(--radius-small) border border-destructive/35 bg-destructive/8 px-3 py-2"
          role="alert"
        >
          <p className="text-(length:--text-small) font-semibold text-foreground">
            Resume approaches unavailable
          </p>
          <p className="text-(length:--text-small) leading-5 text-foreground-soft">
            {props.loadError}
          </p>
          <p className="text-(length:--text-small) leading-5 text-foreground-soft">
            Your saved approaches are safe. You can retry loading them now.
          </p>
          <div className="flex flex-wrap gap-2">
            {props.onRetry ? (
              <Button
                onClick={props.onRetry}
                size="sm"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            ) : null}
            {shortlistedReturnPath ? (
              <Button asChild size="sm" type="button" variant="ghost">
                <Link to={shortlistedReturnPath}>Back to shortlisted job</Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {editing ? (
        <StrategyForm
          baseResumeDocumentId={props.baseResumeDocumentId}
          candidateDocumentIds={props.candidateDocumentIds}
          isPending={props.isSavePending}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            const saved = await props.onSaveStrategy(input);
            if (saved) {
              setEditing(null);
              setSavedNotice(
                input.id ? { strategyId: input.id, name: input.name } : null,
              );
            }
          }}
          value={editing}
        />
      ) : null}

      <CampaignDefaultsSection
        campaigns={props.campaigns}
        isPending={props.isCampaignDefaultPending}
        onSetDefault={props.onSetCampaignDefault}
        strategies={props.strategies}
      />

      {props.strategies.length > 0 ? (
        <div className="min-w-[min(100%,24rem)] flex-1">
          <CollectionSearchToolbar
            className="px-0"
            label="Search approaches"
            onQueryChange={setQuery}
            placeholder="Search name, role family, template, or policy"
            query={query}
            totalCount={props.strategies.length}
            visibleCount={filteredStrategies.length}
          />
        </div>
      ) : null}

      {!props.loadError && props.strategies.length === 0 ? (
        <div className="grid gap-3">
          <EmptyState
            className="min-h-40 px-5 py-6"
            description="If you apply for several similar roles — say backend engineering jobs — save one approach and every resume for those jobs starts the same way instead of you re-choosing each time. You still review and approve each resume."
            title="Save how you want your resume tailored"
          />
          <div className="flex justify-center">
            <Button
              onClick={() =>
                setEditing(emptyFormInput(props.baseResumeDocumentId))
              }
              size="sm"
              type="button"
            >
              New resume approach
            </Button>
          </div>
        </div>
      ) : !props.loadError && filteredStrategies.length === 0 ? (
        <CollectionNoMatches
          noun="approaches"
          onClear={() => setQuery("")}
          query={query}
        />
      ) : props.loadError && props.strategies.length === 0 ? null : (
        <div className="grid gap-3 xl:grid-cols-2">
          {filteredStrategies.map((strategy) => (
            <StrategyCard
              baseResumeDocumentId={props.baseResumeDocumentId}
              isDisablePending={props.isDisablePending(strategy.id)}
              isSavePending={props.isSavePending}
              key={strategy.id}
              onDisable={props.onDisableStrategy}
              onEdit={(next) => setEditing(toSaveInput(next))}
              onEnable={(next) => {
                void props.onSaveStrategy(toSaveInput(next, { enabled: true }));
              }}
              strategy={strategy}
              {...(props.strategyUsage
                ? { usage: props.strategyUsage(strategy.id) }
                : {})}
            />
          ))}
        </div>
      )}
    </section>
  );
}
