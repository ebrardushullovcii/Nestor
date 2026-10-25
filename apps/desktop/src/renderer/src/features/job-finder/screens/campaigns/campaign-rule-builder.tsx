import {
  annualizeCompensationAmount,
  campaignRuleFieldValues,
  campaignRuleOperatorsByField,
  type CampaignRule,
  type CampaignRuleField,
  type CampaignRuleFunnelProjection,
  type CampaignRuleKind,
  type CampaignRuleOperator,
  type JobSearchCampaign,
  type SaveCampaignRuleInput,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { useEffect, useMemo, useState } from "react";
import { collectionSearchFieldClass } from "../../components/collection-search-toolbar";
import { isImeComposingEvent } from "../../lib/job-finder-shortcuts";
import { useJobFinderOverlayOwnership } from "../../lib/job-finder-overlay-ownership";
import { CampaignConfirmDialog } from "./campaign-confirm-dialog";

const kindLabels: Record<CampaignRuleKind, string> = {
  must_have: "Must have",
  prefer: "Prefer",
  never: "Never",
};

const fieldLabels: Record<CampaignRuleField, string> = {
  role: "Role",
  location: "Location",
  work_mode: "Work mode",
  compensation: "Compensation",
  company: "Company",
  industry: "Industry",
  seniority: "Seniority",
  employment_type: "Employment type",
  clearance: "Security clearance",
  sponsorship: "Sponsorship",
  travel: "Travel",
  user_exclusion: "User exclusion",
};

const operatorLabels: Record<CampaignRuleOperator, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  in_list: "is one of (comma list)",
  not_in_list: "is none of (comma list)",
  greater_than: "greater than",
  greater_than_or_equal: "at least",
  less_than: "less than",
  less_than_or_equal: "at most",
};

const provenanceSourceLabels: Record<
  CampaignRule["provenance"]["source"],
  string
> = {
  user: "You",
  profile_import: "Profile import",
  campaign_template: "Search plan template",
  learning_suggestion: "Learning suggestion",
};

const kindOrder: readonly CampaignRuleKind[] = ["must_have", "prefer", "never"];

function describeRule(rule: CampaignRule): string {
  // A numeric rule stores its threshold in both `value` and `numericValue`;
  // say it once.
  const subject =
    rule.numericValue === null
      ? rule.value
      : rule.numericValue.toLocaleString();
  const currencyValue = rule.currency ? ` ${rule.currency}` : "";
  return `${fieldLabels[rule.field]} ${operatorLabels[rule.operator]} ${subject}${currencyValue}`;
}

function formatMeasuredCounts(rule: CampaignRule): string | null {
  if (!rule.enabled) {
    return null;
  }
  if (rule.effect.sampleSize === 0) {
    return "No jobs measured yet";
  }
  const parts: string[] = [];
  if (rule.effect.removedCount > 0) {
    parts.push(`${rule.effect.removedCount} removed`);
  }
  if (rule.effect.downgradedCount > 0) {
    parts.push(`${rule.effect.downgradedCount} downgraded`);
  }
  if (rule.effect.unknownCount > 0) {
    parts.push(`${rule.effect.unknownCount} unknown`);
  }
  if (parts.length === 0) {
    return `${rule.effect.sampleSize} checked, none affected`;
  }
  return `${rule.effect.sampleSize} checked · ${parts.join(", ")}`;
}

function RuleRow(props: {
  rule: CampaignRule;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const { rule } = props;
  const measured = formatMeasuredCounts(rule);
  return (
    <li className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-(--text-headline)">
            {describeRule(rule)}
          </p>
          <p className="mt-0.5 text-xs text-foreground-muted">
            {rule.enabled ? "Enabled" : "Disabled"} · Source:{" "}
            {provenanceSourceLabels[rule.provenance.source]}
            {rule.provenance.confidence < 1
              ? ` · ${Math.round(rule.provenance.confidence * 100)}% confidence`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {measured ? (
            <span
              className={`rounded-full border px-2 py-0.5 text-xs ${rule.enabled ? "border-accent/40 text-accent" : "border-border-subtle text-foreground-muted"}`}
            >
              {measured}
            </span>
          ) : (
            <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-foreground-muted">
              Disabled — not measured
            </span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-foreground-soft">
            <input
              aria-label={`Toggle rule: ${describeRule(rule)}`}
              checked={rule.enabled}
              onChange={(event) => props.onToggle(event.target.checked)}
              type="checkbox"
            />
            {rule.enabled ? "On" : "Off"}
          </label>
          <Button
            onClick={props.onDelete}
            size="xs"
            type="button"
            variant="ghost"
          >
            Remove
          </Button>
        </div>
      </div>
    </li>
  );
}

function RuleGroup(props: {
  kind: CampaignRuleKind;
  rules: readonly CampaignRule[];
  onDelete: (ruleId: string) => void;
  onToggle: (ruleId: string, enabled: boolean) => void;
}) {
  if (props.rules.length === 0) {
    return null;
  }
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-bold uppercase tracking-(--tracking-label) text-foreground-muted">
        {kindLabels[props.kind]} · {props.rules.length}
      </h3>
      <ul className="grid gap-2">
        {props.rules.map((rule) => (
          <RuleRow
            key={rule.id}
            onDelete={() => props.onDelete(rule.id)}
            onToggle={(enabled) => props.onToggle(rule.id, enabled)}
            rule={rule}
          />
        ))}
      </ul>
    </section>
  );
}

export function CampaignRuleBuilder(props: {
  campaign: JobSearchCampaign;
  projection: CampaignRuleFunnelProjection | null;
  pending: boolean;
  onClose: () => void;
  onDeleteRule: (ruleId: string) => void;
  onSaveRule: (rule: SaveCampaignRuleInput) => void;
  onToggleRule: (ruleId: string, enabled: boolean) => void;
}) {
  const [draftKind, setDraftKind] = useState<CampaignRuleKind>("must_have");
  const [draftField, setDraftField] = useState<CampaignRuleField>("role");
  const [draftOperator, setDraftOperator] =
    useState<CampaignRuleOperator>("contains");
  const [draftValue, setDraftValue] = useState("");
  const [draftCurrency, setDraftCurrency] = useState(
    props.campaign.searchPreferences.compensation.currency ??
      props.campaign.searchPreferences.salaryCurrency ??
      "",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [ruleRemovalCandidateId, setRuleRemovalCandidateId] = useState<
    string | null
  >(null);
  // The rule editor is a screen-level Escape owner; joining the overlay stack
  // keeps a stacked search/modal from closing it in the same keypress and
  // blocks shell aliases while editing.
  const { isTopmost: isBuilderTopmost } = useJobFinderOverlayOwnership({
    active: true,
    close: () => props.onClose(),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingEvent(event)) {
        return;
      }
      if (event.key !== "Escape" || !isBuilderTopmost()) {
        return;
      }
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isBuilderTopmost, props.onClose]);

  const availableOperators = campaignRuleOperatorsByField[draftField];
  const needsNumeric = draftField === "compensation" || draftField === "travel";
  const needsCurrency = draftField === "compensation";
  const trimmedDraftValue = draftValue.trim();
  const numericValueError = (() => {
    if (!needsNumeric || trimmedDraftValue.length === 0) {
      return null;
    }
    const numericValue = Number(trimmedDraftValue);
    return Number.isFinite(numericValue) && numericValue >= 0
      ? null
      : "Enter a valid non-negative number.";
  })();

  const changeField = (field: CampaignRuleField) => {
    setDraftField(field);
    if (field === "compensation" && draftField !== "compensation") {
      const compensation = props.campaign.searchPreferences.compensation;
      setDraftCurrency(
        compensation.currency ??
          props.campaign.searchPreferences.salaryCurrency ??
          "",
      );
      setDraftValue(
        compensation.minimum === null
          ? ""
          : String(
              annualizeCompensationAmount(
                compensation.minimum,
                compensation.interval,
              ),
            ),
      );
    }
    const operators = campaignRuleOperatorsByField[field];
    if (field === "compensation") {
      setDraftOperator("greater_than_or_equal");
      return;
    }
    if (!operators.includes(draftOperator)) {
      setDraftOperator(operators[0] ?? "equals");
    }
  };

  const submitRule = () => {
    const value = trimmedDraftValue;
    if (value.length === 0) {
      return;
    }
    if (numericValueError !== null) {
      return;
    }
    const numericValue = needsNumeric ? Number(value) : null;
    props.onSaveRule({
      id: null,
      kind: draftKind,
      field: draftField,
      operator: draftOperator,
      value,
      numericValue,
      currency: needsCurrency ? draftCurrency.trim().toUpperCase() : null,
      enabled: true,
      effect: {
        sampleSize: 0,
        removedCount: 0,
        downgradedCount: 0,
        unknownCount: 0,
        measuredAt: null,
      },
      provenance: {
        source: "user",
        confidence: 1,
        note: null,
        recordedAt: new Date().toISOString(),
      },
    });
    setDraftValue("");
  };

  const projectedEffectById = useMemo(() => {
    const map = new Map<string, CampaignRule["effect"]>();
    for (const rule of props.projection?.rules ?? []) {
      map.set(rule.id, rule.effect);
    }
    return map;
  }, [props.projection]);

  const requestRemoveRule = (ruleId: string) => {
    setRuleRemovalCandidateId(ruleId);
  };

  const ruleRemovalCandidate =
    ruleRemovalCandidateId === null
      ? null
      : (props.campaign.rules.find(
          (candidate) => candidate.id === ruleRemovalCandidateId,
        ) ?? null);

  const rulesByKind = useMemo(() => {
    const grouped: Record<CampaignRuleKind, CampaignRule[]> = {
      must_have: [],
      prefer: [],
      never: [],
    };
    const query = searchQuery.trim().toLowerCase();
    for (const rule of props.campaign.rules) {
      if (
        query &&
        !`${describeRule(rule)} ${kindLabels[rule.kind]} ${rule.id}`
          .toLowerCase()
          .includes(query)
      ) {
        continue;
      }
      grouped[rule.kind].push({
        ...rule,
        // Prefer the freshly measured projection effect so the counts shown
        // always match the current real job sample; fall back to the last
        // persisted discovery-run effect while the projection loads.
        effect: projectedEffectById.get(rule.id) ?? rule.effect,
      });
    }
    return grouped;
  }, [props.campaign.rules, projectedEffectById, searchQuery]);

  const funnel = props.projection?.funnel ?? null;
  const hasSample = (funnel?.sampleSize ?? 0) > 0;
  const hasEnabledRule = props.campaign.rules.some((rule) => rule.enabled);
  const visibleRules =
    rulesByKind.must_have.length +
    rulesByKind.prefer.length +
    rulesByKind.never.length;

  return (
    <section
      aria-label={`Rules for ${props.campaign.name}`}
      className="surface-panel-shell grid gap-5 rounded-(--radius-panel) border border-accent/40 p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
            Search plan rules
          </p>
          <h2 className="mt-1 font-semibold text-(--text-headline)">
            {props.campaign.name}
          </h2>
          <p className="mt-1 text-xs text-foreground-muted">
            Rules only ever read real saved job evidence. Missing evidence is
            never guessed — it counts as unknown and the job is kept.
          </p>
        </div>
        <Button onClick={props.onClose} type="button" variant="outline">
          Close
        </Button>
      </div>

      <section className="grid gap-2 rounded-(--radius-field) border border-border-subtle p-4">
        <h3 className="text-xs font-bold uppercase tracking-(--tracking-label) text-foreground-muted">
          What these rules did to your saved jobs
        </h3>
        {/* Six labelled counts under an eyebrow reading "MEASURED FUNNEL
            (SAVED JOBS ONLY)" was a report, not an answer. One sentence says
            the same numbers in the order a person asks for them. */}
        {!funnel ? (
          <p className="text-sm text-foreground-soft">
            Counting… numbers appear once this search plan has kept some jobs.
          </p>
        ) : !hasSample ? (
          <p className="text-sm text-foreground-soft">
            This search plan has not kept any jobs yet, so there is nothing to
            count. Once a search keeps real jobs here, this line says how many
            these rules removed, downgraded, and left uncertain — measured,
            never estimated.
          </p>
        ) : !hasEnabledRule ? (
          <p className="text-sm text-foreground-soft">
            No rules are on, so all {funnel.sampleSize} saved{" "}
            {funnel.sampleSize === 1 ? "job is" : "jobs are"} kept without being
            screened.
          </p>
        ) : (
          <p className="text-sm text-foreground-soft">
            Of {funnel.sampleSize} saved{" "}
            {funnel.sampleSize === 1 ? "job" : "jobs"}, these rules kept{" "}
            {funnel.retainedCount}, removed {funnel.hardRemovedCount}, and
            ranked {funnel.preferDowngradedCount} lower. {funnel.uncertainCount}{" "}
            {funnel.uncertainCount === 1 ? "job was" : "jobs were"} kept because
            the listing did not say enough to judge, and{" "}
            {funnel.confirmedRetainedCount} matched on evidence the listing
            stated.
          </p>
        )}
      </section>

      <form
        className="grid gap-3 rounded-(--radius-field) border border-border-subtle p-4"
        onSubmit={(event) => {
          event.preventDefault();
          submitRule();
        }}
      >
        <h3 className="text-xs font-bold uppercase tracking-(--tracking-label) text-foreground-muted">
          Add a rule
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="grid gap-1 text-sm">
            <span>Kind</span>
            <select
              className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
              onChange={(event) =>
                setDraftKind(event.target.value as CampaignRuleKind)
              }
              value={draftKind}
            >
              <option value="must_have">Must have</option>
              <option value="prefer">Prefer</option>
              <option value="never">Never</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span>Job field</span>
            <select
              className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
              onChange={(event) =>
                changeField(event.target.value as CampaignRuleField)
              }
              value={draftField}
            >
              {campaignRuleFieldValues.map((field) => (
                <option key={field} value={field}>
                  {fieldLabels[field]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span>Operator</span>
            <select
              className="h-11 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 outline-none focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-[var(--field-focus-shadow)]"
              onChange={(event) =>
                setDraftOperator(event.target.value as CampaignRuleOperator)
              }
              value={draftOperator}
            >
              {availableOperators.map((operator) => (
                <option key={operator} value={operator}>
                  {operatorLabels[operator]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span>{needsNumeric ? "Value (number)" : "Value"}</span>
            <Input
              aria-describedby={
                numericValueError ? "campaign-rule-value-error" : undefined
              }
              aria-invalid={numericValueError !== null}
              onChange={(event) => setDraftValue(event.target.value)}
              placeholder={
                needsNumeric
                  ? draftField === "travel"
                    ? "25"
                    : "Yearly amount"
                  : draftField === "work_mode"
                    ? "remote"
                    : "Example"
              }
              value={draftValue}
            />
          </label>
          {needsCurrency ? (
            <label className="grid gap-1 text-sm">
              <span>Currency</span>
              <Input
                maxLength={3}
                onChange={(event) =>
                  setDraftCurrency(event.target.value.toUpperCase())
                }
                value={draftCurrency}
              />
            </label>
          ) : (
            <div className="hidden lg:block" />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="text-xs text-foreground-muted">
            {needsCurrency ? (
              <>
                Compare yearly pay in the selected currency.{" "}
                {draftOperator === "less_than_or_equal" ||
                draftOperator === "less_than"
                  ? "Compares the advertised maximum."
                  : draftOperator === "equals"
                    ? "Compares the advertised pay band."
                    : "Compares the advertised minimum."}{" "}
                Hourly pay uses 2,080 hours per year; weekly and monthly pay use
                52 weeks and 12 months. Missing pay or a different currency
                stays unknown.
              </>
            ) : (
              "Compensation and travel rules need a numeric value; compensation also needs a currency code."
            )}
          </p>
          <Button
            disabled={
              trimmedDraftValue.length === 0 || numericValueError !== null
            }
            pending={props.pending}
            type="submit"
          >
            Add rule
          </Button>
        </div>
        {numericValueError ? (
          <p
            className="text-sm text-destructive"
            id="campaign-rule-value-error"
            role="alert"
          >
            {numericValueError}
          </p>
        ) : null}
      </form>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-(--tracking-label) text-foreground-muted">
              Rules · {props.campaign.rules.length}
            </h3>
            <p className="mt-0.5 text-xs text-foreground-muted">
              Enabled rules are applied during a search and counted above.
              Disabled rules are kept but never applied.
            </p>
          </div>
          <label className="grid gap-1 text-sm">
            <span className="sr-only">Search rules</span>
            <Input
              aria-label="Search rules"
              className={collectionSearchFieldClass}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search field, value, or kind"
              type="search"
              value={searchQuery}
            />
          </label>
        </div>
        {visibleRules === 0 ? (
          <p className="rounded-(--radius-field) border border-border-subtle p-4 text-sm text-foreground-soft">
            {props.campaign.rules.length === 0
              ? "No rules yet. Add a Must have, Prefer, or Never rule above."
              : "No rules match your search."}
          </p>
        ) : (
          <div className="grid gap-4">
            {kindOrder.map((kind) => (
              <RuleGroup
                key={kind}
                kind={kind}
                onDelete={requestRemoveRule}
                onToggle={props.onToggleRule}
                rules={rulesByKind[kind] ?? []}
              />
            ))}
          </div>
        )}
      </section>

      <CampaignConfirmDialog
        confirmLabel="Remove rule"
        detail={
          ruleRemovalCandidate === null
            ? ""
            : `“${describeRule(ruleRemovalCandidate)}” will be permanently removed from ${props.campaign.name}. Jobs it excluded or downgraded will no longer be affected. This cannot be undone.`
        }
        eyebrow="Search plan rule"
        onCancel={() => setRuleRemovalCandidateId(null)}
        onConfirm={() => {
          if (ruleRemovalCandidate === null) {
            return;
          }
          const ruleId = ruleRemovalCandidate.id;
          // Close first so a re-render can never confirm twice; the callback
          // then runs exactly once for this explicit confirmation.
          setRuleRemovalCandidateId(null);
          props.onDeleteRule(ruleId);
        }}
        open={ruleRemovalCandidate !== null}
        title="Remove this rule?"
      />
    </section>
  );
}
