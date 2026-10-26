import { createHash } from "node:crypto";
import {
  ResumeAnalysisCacheIdentitySchema,
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
  type AgentProviderStatus,
  type CandidateProfile,
  type JobSearchPreferences,
  type ResumeAnalysisCacheIdentity,
  type ResumeDocumentBundle,
  type ResumeImportFieldCandidate,
  type ResumeImportRun,
  type ResumeImportVisionArtifact,
} from "@nestor/contracts";

import type { ProfileContext } from "./profile-context";
import { createUniqueId } from "./shared";

export const RESUME_ANALYSIS_PROMPT_VERSION = "resume-analysis-prompts-v2";
export const RESUME_ANALYSIS_SCHEMA_VERSION = "resume-analysis-schema-v1";
export const RESUME_ANALYSIS_POLICY_VERSION = "resume-analysis-policy-v2";
export const RESUME_VISION_RENDER_VERSION = "resume-vision-render-v1";

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function providerFingerprint(status: AgentProviderStatus | null): string {
  return fingerprint(
    status
      ? {
          kind: status.kind,
          role: status.role,
          ready: status.ready,
          label: status.label,
          model: status.model,
          baseUrl: status.baseUrl,
          modelContextWindowTokens: status.modelContextWindowTokens,
        }
      : { kind: "unavailable" },
  );
}

function profileAnalysisContext(profile: CandidateProfile): unknown {
  const candidateContext: Record<string, unknown> = { ...profile };
  delete candidateContext.baseResume;
  return candidateContext;
}

export function buildResumeAnalysisCacheIdentity(input: {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  documentBundle: ResumeDocumentBundle;
  visionArtifact?: ResumeImportVisionArtifact | null | undefined;
  textProviderStatus: AgentProviderStatus;
  visionProviderStatus: AgentProviderStatus | null;
  promptVersion?: string;
  schemaVersion?: string;
  policyVersion?: string;
}): ResumeAnalysisCacheIdentity | null {
  const sourceSha256 = input.profile.baseResume.sha256?.trim().toLowerCase();
  const parserManifestVersion =
    input.documentBundle.parserManifest?.manifestVersion?.trim();
  if (
    !sourceSha256 ||
    !/^[a-f0-9]{64}$/.test(sourceSha256) ||
    !parserManifestVersion
  ) {
    return null;
  }

  const parserFingerprint = fingerprint({
    primaryParserKind: input.documentBundle.primaryParserKind,
    visionRenderVersion: RESUME_VISION_RENDER_VERSION,
    parserKinds: input.documentBundle.parserKinds,
    parserManifest: input.documentBundle.parserManifest
      ? {
          workerKind: input.documentBundle.parserManifest.workerKind,
          workerVersion: input.documentBundle.parserManifest.workerVersion,
          manifestVersion: input.documentBundle.parserManifest.manifestVersion,
          executorVersions:
            input.documentBundle.parserManifest.executorVersions,
        }
      : null,
    routeKind: input.documentBundle.route?.routeKind ?? null,
    visionPages:
      input.visionArtifact?.pages.map((page) => ({
        pageNumber: page.pageNumber,
        renderKind: page.renderKind,
        mimeType: page.mimeType,
        width: page.width,
        height: page.height,
        sha256: page.sha256,
      })) ?? [],
  });

  return ResumeAnalysisCacheIdentitySchema.parse({
    sourceSha256,
    parserFingerprint,
    textProviderKind: input.textProviderStatus.kind,
    textProviderFingerprint: providerFingerprint(input.textProviderStatus),
    visionProviderKind: input.visionProviderStatus?.kind ?? null,
    visionProviderFingerprint: providerFingerprint(input.visionProviderStatus),
    promptVersion: input.promptVersion ?? RESUME_ANALYSIS_PROMPT_VERSION,
    schemaVersion: input.schemaVersion ?? RESUME_ANALYSIS_SCHEMA_VERSION,
    policyVersion: input.policyVersion ?? RESUME_ANALYSIS_POLICY_VERSION,
    contextFingerprint: fingerprint({
      profile: profileAnalysisContext(input.profile),
      searchPreferences: input.searchPreferences,
    }),
  });
}

export function resumeAnalysisCacheIdentitiesMatch(
  left: ResumeAnalysisCacheIdentity | null | undefined,
  right: ResumeAnalysisCacheIdentity | null | undefined,
): boolean {
  return Boolean(
    left && right && stableSerialize(left) === stableSerialize(right),
  );
}

export interface CompatibleResumeAnalysisCacheEntry {
  run: ResumeImportRun;
  bundle: ResumeDocumentBundle;
  candidates: readonly ResumeImportFieldCandidate[];
}

export async function findCompatibleResumeAnalysisCacheEntry(
  ctx: Pick<ProfileContext, "repository">,
  identity: ResumeAnalysisCacheIdentity | null,
): Promise<CompatibleResumeAnalysisCacheEntry | null> {
  if (!identity) {
    return null;
  }

  const runs = await ctx.repository.listResumeImportRuns({
    statuses: ["applied", "review_ready"],
    limit: 100,
  });
  const cachedRun = runs.find((run) => {
    const roles = run.modelRoles;
    const hasIncompleteTextStage =
      run.timing?.textStages.some(
        (stage) =>
          stage.status !== "completed" ||
          stage.providerKind !== identity.textProviderKind,
      ) ?? false;
    const hasFailedModelRole = [
      roles?.text.status,
      roles?.vision.status,
      roles?.adjudication.status,
    ].some((status) => status === "failed" || status === "timed_out");

    return (
      !run.analysisCacheHit &&
      run.analysisProviderKind === identity.textProviderKind &&
      (identity.visionProviderKind === null ||
        run.visionProviderKind === identity.visionProviderKind) &&
      !hasIncompleteTextStage &&
      !hasFailedModelRole &&
      !run.warnings.some((warning) =>
        /(?:fell back|provider[^.]*failed|stage[^.]*failed|timed out)/iu.test(
          warning,
        ),
      ) &&
      resumeAnalysisCacheIdentitiesMatch(run.analysisCacheIdentity, identity)
    );
  });
  if (!cachedRun) {
    return null;
  }

  const [bundles, candidates] = await Promise.all([
    ctx.repository.listResumeImportDocumentBundles({ runId: cachedRun.id }),
    ctx.repository.listResumeImportFieldCandidates({ runId: cachedRun.id }),
  ]);
  const bundle = bundles[0];
  if (!bundle || candidates.length === 0) {
    return null;
  }

  return {
    run: ResumeImportRunSchema.parse(cachedRun),
    bundle: ResumeDocumentBundleSchema.parse(bundle),
    candidates: ResumeImportFieldCandidateSchema.array().parse(candidates),
  };
}

export function cloneCachedResumeAnalysisArtifacts(input: {
  entry: CompatibleResumeAnalysisCacheEntry;
  runId: string;
  sourceResumeId: string;
  now: string;
}): {
  bundle: ResumeDocumentBundle;
  candidates: ResumeImportFieldCandidate[];
} {
  const bundle = ResumeDocumentBundleSchema.parse({
    ...input.entry.bundle,
    id: createUniqueId("resume_bundle"),
    runId: input.runId,
    sourceResumeId: input.sourceResumeId,
    createdAt: input.now,
  });
  const candidateIdMap = new Map(
    input.entry.candidates.map((candidate) => [
      candidate.id,
      createUniqueId("resume_candidate"),
    ]),
  );
  const candidates = input.entry.candidates.map((candidate) =>
    ResumeImportFieldCandidateSchema.parse({
      ...candidate,
      id: candidateIdMap.get(candidate.id),
      runId: input.runId,
      conflictChoices: candidate.conflictChoices?.map((choice) => ({
        ...choice,
        sourceCandidateIds: choice.sourceCandidateIds.map(
          (sourceCandidateId) =>
            candidateIdMap.get(sourceCandidateId) ?? sourceCandidateId,
        ),
      })),
      createdAt: input.now,
      resolvedAt: candidate.resolvedAt ? input.now : null,
    }),
  );

  return { bundle, candidates };
}
