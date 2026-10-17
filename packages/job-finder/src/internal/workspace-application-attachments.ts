import type {
  ApplicationAnswerRecord,
  ApplicationQuestionKind,
  ApplicationQuestionRecord,
  CandidateAsset,
} from "@nestor/contracts";
import type { ApplicationAttachmentArtifact } from "@nestor/browser-runtime";
import type { CandidateAssetResolver } from "./workspace-service-contracts";

function compareAnswerRecency(
  left: ApplicationAnswerRecord,
  right: ApplicationAnswerRecord,
) {
  return (
    right.revision - left.revision ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

function catalogQuestionKind(asset: CandidateAsset): ApplicationQuestionKind {
  switch (asset.kind) {
    case "resume":
      return "resume";
    case "cover_letter":
      return "cover_letter";
    case "portfolio":
    case "work_sample":
      return "portfolio";
    default:
      return "other";
  }
}

function catalogPrompt(asset: CandidateAsset): string {
  const label = asset.kind.replaceAll("_", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} from the person's files`;
}

export async function resolveApplicationAttachmentsForExecution(input: {
  /** The job being applied to; a letter written for another job is skipped. */
  jobId: string;
  resolver: CandidateAssetResolver | undefined;
  questionRecords: readonly ApplicationQuestionRecord[];
  answerRecords: readonly ApplicationAnswerRecord[];
}): Promise<ApplicationAttachmentArtifact[]> {
  const answerById = new Map(
    input.answerRecords.map((answer) => [answer.id, answer] as const),
  );
  const answersByQuestion = new Map<string, ApplicationAnswerRecord[]>();
  for (const answer of input.answerRecords) {
    const current = answersByQuestion.get(answer.questionId) ?? [];
    current.push(answer);
    answersByQuestion.set(answer.questionId, current);
  }

  const selections = input.questionRecords.flatMap((question) => {
    const selected = question.selectedAnswerId
      ? answerById.get(question.selectedAnswerId)
      : undefined;
    const latest =
      selected ??
      [...(answersByQuestion.get(question.id) ?? [])].sort(
        compareAnswerRecency,
      )[0];
    return latest?.sourceKind === "user" &&
      (latest.status === "suggested" || latest.status === "filled") &&
      latest.value?.type === "asset_ref"
      ? [{ answer: latest, question }]
      : [];
  });
  const resolver = input.resolver;
  if (!resolver && selections.length > 0) {
    throw new Error(
      "This application references an approved asset, but the local asset library is unavailable.",
    );
  }
  if (!resolver) return [];

  const selectedAssetIds = new Set(
    selections.flatMap(({ answer }) =>
      answer.value?.type === "asset_ref" ? [answer.value.assetId] : [],
    ),
  );
  const catalogAssets = resolver.list
    ? (await resolver.list({ includeDeleted: false })).assets.filter(
        (candidate) =>
          candidate.deletedAt === null &&
          candidate.consentScope === "job_application_attachment" &&
          candidate.kind !== "resume" &&
          (candidate.forJob === null ||
            candidate.forJob.jobId === input.jobId) &&
          !selectedAssetIds.has(candidate.id),
      )
    : [];

  const selectedArtifacts = selections.map(async ({ answer, question }) => {
    const value = answer.value;
    if (value?.type !== "asset_ref") {
      throw new Error("The selected application attachment is stale.");
    }
    const resolved = await resolver.resolveForApplication(value.assetId);
    if (resolved.asset.forJob && resolved.asset.forJob.jobId !== input.jobId) {
      throw new Error("That file was written for another job.");
    }
    return {
      assetId: resolved.asset.id,
      assetKind: resolved.asset.kind,
      questionId: question.id,
      prompt: question.prompt,
      questionKind: question.kind,
      fileName: resolved.asset.originalName,
      mime: resolved.asset.mime,
      sha256: resolved.asset.sha256,
      loadVerifiedBytes: resolved.loadVerifiedBytes,
    };
  });
  const selected = await Promise.all(selectedArtifacts);
  const catalog = (
    await Promise.all(
      catalogAssets.map(async (candidate) => {
        try {
          const resolved = await resolver.resolveForApplication(candidate.id);
          return {
            assetId: resolved.asset.id,
            assetKind: resolved.asset.kind,
            questionId: null,
            prompt: catalogPrompt(resolved.asset),
            questionKind: catalogQuestionKind(resolved.asset),
            fileName: resolved.asset.originalName,
            mime: resolved.asset.mime,
            sha256: resolved.asset.sha256,
            loadVerifiedBytes: resolved.loadVerifiedBytes,
          };
        } catch {
          // Ambient Documents are conveniences, not prerequisites. An asset
          // that was removed or changed after listing is omitted; if the form
          // needs it, the normal required-upload handoff asks the person.
          return null;
        }
      }),
    )
  ).filter((artifact) => artifact !== null);
  return [...selected, ...catalog];
}
