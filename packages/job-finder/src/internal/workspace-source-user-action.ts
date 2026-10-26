import {
  JOB_FINDER_BROWSER_LABEL,
  UserActionRequestSchema,
  type SourceDebugRunRecord,
  type JobDiscoveryTarget,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import { deriveSourceAccessPrompts } from "./workspace-source-access-prompts";
import { resolveAdapterKind } from "./workspace-helpers";

function stableFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export async function persistDiscoveryLoginUserAction(input: {
  repository: JobFinderRepository;
  run: SourceDebugRunRecord;
  target: JobDiscoveryTarget | null;
}): Promise<void> {
  if (input.run.state !== "paused_manual") return;

  const [searchPreferences, sourceInstructionArtifacts, sourceDebugAttempts] =
    await Promise.all([
      input.repository.getSearchPreferences(),
      input.repository.listSourceInstructionArtifacts(),
      input.repository.listSourceDebugAttempts(),
    ]);
  const target = input.target;
  if (!target) return;

  const prompt = deriveSourceAccessPrompts({
    targets: [{ ...target, lastDebugRunId: input.run.id }],
    recentSourceDebugRuns: [input.run],
    activeSourceDebugRun: null,
    sourceDebugAttempts,
    sourceInstructionArtifacts,
    searchPreferences,
    generatedAt: input.run.updatedAt,
  }).find((candidate) => candidate.state === "prompt_login_required");
  if (!prompt) return;

  const occurrenceFingerprint = stableFingerprint(
    [target.id, input.run.id, prompt.detail].join("|"),
  );
  const expectedOrigin = `${new URL(prompt.targetUrl).origin}/`;
  const dedupeKey = `source_login:${occurrenceFingerprint}`;
  const existingRequest = (
    await input.repository.listUserActionRequests()
  ).find((request) => request.dedupeKey === dedupeKey);
  if (existingRequest) return;

  await input.repository.createUserActionRequest(
    UserActionRequestSchema.parse({
      id: `source_login_${occurrenceFingerprint}`,
      dedupeKey,
      revision: 1,
      kind: "login",
      state: "pending",
      requirement: "required",
      scope: {
        type: "discovery_source",
        targetId: target.id,
        source: resolveAdapterKind(target),
        sourceDebugRunId: input.run.id,
        sourceDebugAttemptId: input.run.attemptIds.at(-1) ?? null,
      },
      verification: {
        type: "source_access",
        targetId: target.id,
        blockerFingerprint: `source_login:${occurrenceFingerprint}`,
        expectedOrigin,
      },
      title: prompt.actionLabel,
      summary: prompt.summary,
      instructions: [
        `Complete sign-in in the ${JOB_FINDER_BROWSER_LABEL}. Job Finder never receives or stores your credentials.`,
        "Then return to Needs you and choose Check whether this step is done.",
      ],
      actionUrl: prompt.targetUrl,
      displayOrigin: expectedOrigin,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: input.run.updatedAt,
      updatedAt: input.run.updatedAt,
      openedAt: null,
      resolvedAt: null,
      expiresAt: null,
    }),
  );
}
