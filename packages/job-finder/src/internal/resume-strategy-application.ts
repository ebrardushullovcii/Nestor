import {
  ResumeGenerationStrategyPolicySchema,
  type ResumeGenerationStrategyPolicy,
} from "@nestor/ai-providers";
import {
  JobFinderResumeWorkspaceStrategyContextSchema,
  type JobFinderIntelligenceState,
  type JobFinderResumeWorkspaceStrategyContext,
  type ResumeStrategy,
  type ResumeTemplateId,
  type SavedJob,
} from "@nestor/contracts";
import {
  recommendResumeStrategy,
  type RecommendResumeStrategyResult,
} from "./resume-strategy-operations";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/**
 * Deterministic helpers that connect named resume strategies to a specific
 * job and to Resume Studio.
 *
 * Everything here is advisory. The helpers resolve which enabled strategy is
 * recommended for a job's role family and which strategy the user selected,
 * and they surface the strategy's policy fields (template, headline/skills/
 * coverage policy, tailoring strength, evidence boundaries) as presentation
 * defaults only. They never read or write resume artifact approval, digest,
 * application-readiness, or current status, so reusing a strategy can never
 * make a stale or unapproved artifact application-ready.
 */

type RecommendOk = Extract<RecommendResumeStrategyResult, { ok: true }>;

function normalizeRoleText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9+#.-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function roleTokens(value: string): string[] {
  return normalizeRoleText(value).split(" ").filter(Boolean);
}

function roleTokenMatches(familyToken: string, titleToken: string): boolean {
  if (familyToken === titleToken) {
    return true;
  }

  const shorter =
    familyToken.length <= titleToken.length ? familyToken : titleToken;
  const longer =
    familyToken.length <= titleToken.length ? titleToken : familyToken;

  return shorter.length >= 5 && longer.startsWith(shorter);
}

function distinctRoleFamilies(
  strategies: readonly Pick<ResumeStrategy, "roleFamily">[],
): Set<string> {
  return new Set(strategies.map((strategy) => strategy.roleFamily));
}

/**
 * Derives the role family a job belongs to by comparing the job title against
 * enabled strategy role families. Exact normalized equality wins; otherwise a
 * family matches when every family token matches a title token (equal or a
 * stable prefix). The most specific family wins, and an ambiguity between two
 * distinct same-specificity families resolves to null so the caller falls
 * through to the campaign default or no recommendation. The returned value is
 * the exact persisted roleFamily string of the winning strategy.
 */
export function deriveResumeStrategyRoleFamily(
  jobTitle: string,
  strategies: readonly Pick<ResumeStrategy, "roleFamily" | "enabled">[],
): string | null {
  const enabled = strategies.filter((strategy) => strategy.enabled);

  if (enabled.length === 0) {
    return null;
  }

  const normalizedTitle = normalizeRoleText(jobTitle);

  if (!normalizedTitle) {
    return null;
  }

  const titleTokens = roleTokens(jobTitle);

  if (titleTokens.length === 0) {
    return null;
  }

  const exactMatches = enabled.filter(
    (strategy) => normalizeRoleText(strategy.roleFamily) === normalizedTitle,
  );

  if (exactMatches.length > 0) {
    const exactFamilies = distinctRoleFamilies(exactMatches);
    return exactFamilies.size === 1 ? exactMatches[0]!.roleFamily : null;
  }

  const containedMatches = enabled
    .map((strategy) => ({
      strategy,
      tokens: roleTokens(strategy.roleFamily),
    }))
    .filter(({ tokens }) => {
      if (tokens.length === 0) {
        return false;
      }

      return tokens.every((familyToken) =>
        titleTokens.some((titleToken) =>
          roleTokenMatches(familyToken, titleToken),
        ),
      );
    })
    .sort((left, right) => right.tokens.length - left.tokens.length);

  if (containedMatches.length === 0) {
    return null;
  }

  const bestTokenCount = containedMatches[0]!.tokens.length;
  const bestMatches = containedMatches.filter(
    (match) => match.tokens.length === bestTokenCount,
  );
  const bestFamilies = distinctRoleFamilies(
    bestMatches.map((match) => match.strategy),
  );

  return bestFamilies.size === 1 ? bestMatches[0]!.strategy.roleFamily : null;
}

export function recommendResumeStrategyForJob(input: {
  state: JobFinderIntelligenceState;
  job: Pick<SavedJob, "title">;
  campaignDefaultResumeStrategyId?: string | null;
}): { roleFamily: string | null; recommendation: RecommendOk } {
  const roleFamily = deriveResumeStrategyRoleFamily(
    input.job.title,
    input.state.resumeStrategies,
  );
  const result = recommendResumeStrategy({
    state: input.state,
    roleFamily: roleFamily ?? "",
    campaignDefaultResumeStrategyId:
      input.campaignDefaultResumeStrategyId ?? null,
  });

  if (!result.ok) {
    throw new Error(
      `The resume strategy recommendation failed: ${result.failure.message}`,
    );
  }

  return { roleFamily, recommendation: result };
}

function findEnabledStrategy(
  state: JobFinderIntelligenceState,
  strategyId: string | null,
): ResumeStrategy | null {
  if (!strategyId) {
    return null;
  }

  return (
    state.resumeStrategies.find(
      (strategy) => strategy.id === strategyId && strategy.enabled,
    ) ?? null
  );
}

interface ResumeStrategyApplicationResolution {
  context: JobFinderResumeWorkspaceStrategyContext;
  policy: ResumeGenerationStrategyPolicy | null;
}

function resolveResumeStrategyApplication(input: {
  state: JobFinderIntelligenceState;
  job: SavedJob;
  campaignDefaultResumeStrategyId?: string | null;
}): ResumeStrategyApplicationResolution {
  const { roleFamily, recommendation } = recommendResumeStrategyForJob(input);
  const selection =
    input.state.resumeStrategySelections.find(
      (entry) => entry.jobId === input.job.id,
    ) ?? null;
  const recommendedStrategy = recommendation.strategyId
    ? (input.state.resumeStrategies.find(
        (strategy) => strategy.id === recommendation.strategyId,
      ) ?? null)
    : null;
  const selectedStrategy = selection
    ? (input.state.resumeStrategies.find(
        (strategy) => strategy.id === selection.strategyId,
      ) ?? null)
    : null;
  const effectiveStrategy =
    findEnabledStrategy(input.state, selectedStrategy?.id ?? null) ??
    findEnabledStrategy(input.state, recommendedStrategy?.id ?? null);
  const effectiveSource = selectedStrategy?.enabled
    ? "selection"
    : effectiveStrategy
      ? "recommendation"
      : null;
  const effectiveReason = selectedStrategy?.enabled
    ? selection?.reason
    : recommendation.reason;

  const context = JobFinderResumeWorkspaceStrategyContextSchema.parse({
    roleFamily,
    recommendedStrategyId: recommendation.strategyId,
    recommendedStrategyName: recommendedStrategy?.name ?? null,
    recommendationSource: recommendation.source,
    recommendationReason: recommendation.reason,
    selectedStrategyId: selection?.strategyId ?? null,
    selectedStrategyName: selectedStrategy?.name ?? null,
    selectionSource: selection?.source ?? null,
    selectionReason: selection?.reason ?? null,
    selectedAt: selection?.selectedAt ?? null,
    templateId: effectiveStrategy?.templateId ?? null,
    headlinePolicy: effectiveStrategy?.headlinePolicy ?? null,
    skillsPolicy: effectiveStrategy?.skillsPolicy ?? null,
    coveragePolicy: effectiveStrategy?.coveragePolicy ?? null,
    tailoringStrength: effectiveStrategy?.tailoringStrength ?? null,
    evidenceBoundaries: effectiveStrategy?.evidenceBoundaries ?? null,
  });

  const policy =
    effectiveStrategy && effectiveSource && effectiveReason
      ? ResumeGenerationStrategyPolicySchema.parse({
          strategyId: effectiveStrategy.id,
          strategyName: effectiveStrategy.name,
          roleFamily: effectiveStrategy.roleFamily,
          baseResumeDocumentId: effectiveStrategy.baseResumeDocumentId,
          templateId: effectiveStrategy.templateId,
          headlinePolicy: effectiveStrategy.headlinePolicy,
          skillsPolicy: effectiveStrategy.skillsPolicy,
          coveragePolicy: effectiveStrategy.coveragePolicy,
          tailoringStrength: effectiveStrategy.tailoringStrength,
          evidenceBoundaries: effectiveStrategy.evidenceBoundaries,
          effectiveSource,
          effectiveReason,
          recommendationSource: recommendation.source,
          recommendationReason: recommendation.reason,
          selectionSource: selection?.source ?? null,
          selectionReason: selection?.reason ?? null,
        })
      : null;

  return { context, policy };
}

/**
 * Builds the read-only strategy context shown in Resume Studio: the current
 * recommendation (with its inspectable reason), the persisted per-job
 * selection (with its own reason), and the policy fields of the enabled
 * strategy that currently applies as a presentation default.
 */
export function buildResumeStrategyContext(input: {
  state: JobFinderIntelligenceState;
  job: SavedJob;
  campaignDefaultResumeStrategyId?: string | null;
}): JobFinderResumeWorkspaceStrategyContext {
  return resolveResumeStrategyApplication(input).context;
}

export function buildResumeGenerationStrategyPolicy(input: {
  state: JobFinderIntelligenceState;
  job: SavedJob;
  campaignDefaultResumeStrategyId?: string | null;
}): ResumeGenerationStrategyPolicy | null {
  return resolveResumeStrategyApplication(input).policy;
}

export function resolveCampaignDefaultResumeStrategyId(
  campaignState: Awaited<
    ReturnType<WorkspaceServiceContext["repository"]["getCampaignState"]>
  >,
  jobId: string,
): string | null {
  if (!campaignState) {
    return null;
  }

  const campaign =
    campaignState.campaigns.find((candidate) =>
      candidate.jobIds.includes(jobId),
    ) ??
    campaignState.campaigns.find(
      (candidate) => candidate.id === campaignState.activeCampaignId,
    ) ??
    null;

  return campaign?.applicationPolicy.defaultResumeStrategyId ?? null;
}

export function resolveResumeStrategyTemplateDefault(
  state: JobFinderIntelligenceState,
  job: SavedJob,
  campaignDefaultResumeStrategyId: string | null,
): ResumeTemplateId | null {
  return buildResumeStrategyContext({
    state,
    job,
    campaignDefaultResumeStrategyId,
  }).templateId;
}
