import {
  ApplicationPacketSchema,
  ApplicationPrivacyDestinationSchema,
  ApplyRunDetailsSchema,
  type ApplicationPacket,
  type ApplicationPrivacyDestination,
  type ApplyRunDetails,
} from "@nestor/contracts";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import { readSavedJob } from "./read-saved-job";

function parsePersistedTimestamp(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      "Encountered invalid persisted timestamp while sorting apply run details.",
    );
  }

  return parsed;
}

function toSafeDestination(
  value: string | null | undefined,
): ApplicationPrivacyDestination | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return ApplicationPrivacyDestinationSchema.parse({
      origin: url.origin,
      safePath: url.pathname || "/",
    });
  } catch {
    return null;
  }
}

export function createWorkspaceApplyRunStoreMethods(
  ctx: WorkspaceServiceContext,
) {
  async function getApplyRunDetails(
    runId: string,
    jobId: string,
    applicationRecordId?: string | null,
  ): Promise<ApplyRunDetails> {
    const [
      runMatches,
      results,
      approvals,
      questionRecords,
      answerRecords,
      artifactRefs,
      checkpoints,
      consentRequests,
      applicationRecords,
    ] = await Promise.all([
      ctx.repository.listApplyRuns({ id: runId }),
      ctx.repository.listApplyJobResults({ runId, jobId }),
      ctx.repository.listApplySubmitApprovals({ runId }),
      ctx.repository.listApplicationQuestionRecords({ runId, jobId }),
      ctx.repository.listApplicationAnswerRecords({ runId, jobId }),
      ctx.repository.listApplicationArtifactRefs({ runId, jobId }),
      ctx.repository.listApplicationReplayCheckpoints({ runId, jobId }),
      ctx.repository.listApplicationConsentRequests({ runId, jobId }),
      ctx.repository.listApplicationRecords(),
    ]);
    const run = runMatches[0];

    if (!run) {
      throw new Error(`Unknown apply run '${runId}'.`);
    }

    if (!run.jobIds.includes(jobId)) {
      throw new Error(`Apply run '${runId}' does not include job '${jobId}'.`);
    }

    if (applicationRecordId) {
      const record = applicationRecords.find(
        (entry) => entry.id === applicationRecordId,
      );
      if (!record || record.jobId !== jobId) {
        throw new Error(
          `Application record '${applicationRecordId}' does not belong to job '${jobId}'.`,
        );
      }
    }

    const lineageIds = new Set(
      results
        .map((result) => result.applicationRecordId)
        .filter((value): value is string => value !== null),
    );
    if (!applicationRecordId && lineageIds.size > 1) {
      throw new Error(
        `Apply run '${runId}' has ambiguous application lineage for job '${jobId}'.`,
      );
    }
    const exactApplicationRecordId =
      applicationRecordId ?? [...lineageIds][0] ?? null;
    if (results.length > 0 && exactApplicationRecordId === null) {
      throw new Error(
        `Apply run '${runId}' has legacy application lineage and is non-actionable.`,
      );
    }
    if (exactApplicationRecordId) {
      const exactRecord = applicationRecords.find(
        (record) => record.id === exactApplicationRecordId,
      );
      if (!exactRecord || exactRecord.jobId !== jobId) {
        throw new Error(
          `Application record '${exactApplicationRecordId}' does not belong to job '${jobId}'.`,
        );
      }
    }
    // Legacy v12 migration rows can legitimately persist a null result
    // lineage. Such rows are treated as belonging to the resolved record only
    // when the workspace has exactly one application record for this job and
    // it is the resolved record; zero or multiple candidates fail closed.
    // Explicit non-null lineage stays authoritative, so any non-null mismatch
    // still rejects.
    const scopedJobRecordIds = applicationRecords
      .filter((record) => record.jobId === jobId)
      .map((record) => record.id);
    const allowsLegacyNullLineage =
      exactApplicationRecordId !== null &&
      scopedJobRecordIds.length === 1 &&
      scopedJobRecordIds[0] === exactApplicationRecordId;
    const belongsToExactLineage = (value: {
      applicationRecordId: string | null;
    }) =>
      value.applicationRecordId === exactApplicationRecordId ||
      (value.applicationRecordId === null && allowsLegacyNullLineage);
    if (
      results.some((value) => !belongsToExactLineage(value)) ||
      questionRecords.some((value) => !belongsToExactLineage(value)) ||
      answerRecords.some((value) => !belongsToExactLineage(value)) ||
      artifactRefs.some((value) => !belongsToExactLineage(value)) ||
      checkpoints.some((value) => !belongsToExactLineage(value)) ||
      consentRequests.some((value) => !belongsToExactLineage(value))
    ) {
      throw new Error(
        `Apply run '${runId}' contains mismatched application record lineage.`,
      );
    }

    const latestResult =
      [...results].sort(
        (left, right) =>
          parsePersistedTimestamp(right.updatedAt) -
            parsePersistedTimestamp(left.updatedAt) ||
          right.id.localeCompare(left.id),
      )[0] ?? null;
    const latestApproval =
      approvals.find((entry) => entry.id === run.submitApprovalId) ??
      [...approvals].sort(
        (left, right) =>
          parsePersistedTimestamp(right.createdAt) -
            parsePersistedTimestamp(left.createdAt) ||
          right.id.localeCompare(left.id),
      )[0] ??
      null;

    const sortByTimestamp = <TValue>(
      values: readonly TValue[],
      getTimestamp: (value: TValue) => string,
      tieBreak?: (left: TValue, right: TValue) => number,
    ) =>
      values
        .map((value) => ({
          value,
          timestamp: parsePersistedTimestamp(getTimestamp(value)),
        }))
        .sort(
          (left, right) =>
            left.timestamp - right.timestamp ||
            (tieBreak ? tieBreak(left.value, right.value) : 0),
        )
        .map(({ value }) => value);

    return ApplyRunDetailsSchema.parse({
      run,
      result: latestResult,
      // The review belongs to the attempt that wrote it, so it travels with
      // the result rather than being rebuilt from the records afterwards.
      reviewCard: latestResult?.reviewCard ?? null,
      results,
      submitApproval: latestApproval,
      questionRecords: sortByTimestamp(
        questionRecords,
        (record) => record.detectedAt,
        (left, right) => left.id.localeCompare(right.id),
      ),
      answerRecords: sortByTimestamp(
        answerRecords,
        (record) => record.createdAt,
        (left, right) =>
          left.revision - right.revision || left.id.localeCompare(right.id),
      ),
      artifactRefs: sortByTimestamp(
        artifactRefs,
        (record) => record.createdAt,
        (left, right) => left.id.localeCompare(right.id),
      ),
      checkpoints: sortByTimestamp(
        checkpoints,
        (record) => record.createdAt,
        (left, right) => left.id.localeCompare(right.id),
      ),
      consentRequests: sortByTimestamp(
        consentRequests,
        (record) => record.requestedAt,
        (left, right) => left.id.localeCompare(right.id),
      ),
    });
  }

  async function buildApplicationPacket(
    runId: string,
    jobId: string,
    applicationRecordId?: string | null,
  ): Promise<ApplicationPacket> {
    const [details, job] = await Promise.all([
      getApplyRunDetails(runId, jobId, applicationRecordId),
      readSavedJob(ctx.repository, jobId),
    ]);
    if (!job) {
      throw new Error(`Unable to export unknown job '${jobId}'.`);
    }
    if (!details.result) {
      throw new Error(
        `Apply run '${runId}' has no result for job '${jobId}' to export.`,
      );
    }

    const listingDestination = toSafeDestination(job.canonicalUrl);
    if (!listingDestination) {
      throw new Error(`Job '${jobId}' has no safe listing destination.`);
    }

    const answerById = new Map(
      details.answerRecords.map((answer) => [answer.id, answer] as const),
    );
    const answersByQuestionId = new Map<string, typeof details.answerRecords>();
    for (const answer of details.answerRecords) {
      const values = answersByQuestionId.get(answer.questionId) ?? [];
      answersByQuestionId.set(answer.questionId, [...values, answer]);
    }

    const receipt = details.result.privacyReceipt;
    return ApplicationPacketSchema.parse({
      generatedAt: new Date().toISOString(),
      job: {
        id: job.id,
        source: job.source,
        title: job.title,
        company: job.company,
        location: job.location,
        listingDestination,
        applicationDestination: toSafeDestination(
          job.applicationUrl ?? job.canonicalUrl,
        ),
        summary: job.summary,
      },
      run: {
        id: details.run.id,
        mode: details.run.mode,
        state: details.run.state,
      },
      result: {
        id: details.result.id,
        applicationRecordId: details.result.applicationRecordId,
        state: details.result.state,
        summary: details.result.summary,
        detail: details.result.detail,
        blockerReason: details.result.blockerReason,
        blockerSummary: details.result.blockerSummary,
        updatedAt: details.result.updatedAt,
      },
      resume: receipt?.resume ?? null,
      questions: details.questionRecords.map((question) => {
        const questionAnswers = answersByQuestionId.get(question.id) ?? [];
        const selectedAnswer = question.selectedAnswerId
          ? (answerById.get(question.selectedAnswerId) ?? null)
          : null;
        const matchingSubmittedAnswer = question.submittedAnswer
          ? ([...questionAnswers]
              .reverse()
              .find((answer) => answer.text === question.submittedAnswer) ??
            null)
          : null;
        const preparedAnswer =
          question.kind === "resume"
            ? (receipt?.resume.fileName ?? null)
            : (selectedAnswer?.text ?? question.submittedAnswer ?? null);
        const preparedAnswerSource = selectedAnswer ?? matchingSubmittedAnswer;
        return {
          id: question.id,
          prompt: question.prompt,
          kind: question.kind,
          isRequired: question.isRequired,
          status: question.status,
          preparedAnswer,
          sourceKinds: preparedAnswerSource
            ? [preparedAnswerSource.sourceKind]
            : [],
        };
      }),
      consent: details.consentRequests.map((request) => ({
        kind: request.kind,
        label: request.label,
        detail: request.detail,
        status: request.status,
        requestedAt: request.requestedAt,
        decidedAt: request.decidedAt,
      })),
      checkpoints: details.checkpoints.map((checkpoint) => ({
        label: checkpoint.label,
        detail: checkpoint.detail,
        jobState: checkpoint.jobState,
        createdAt: checkpoint.createdAt,
        destination: toSafeDestination(checkpoint.url),
      })),
      privacyReceipt: receipt,
      submissionOccurred:
        details.result.state === "submitted" &&
        receipt?.finalSubmitOccurred === true,
    });
  }

  return {
    getApplyRunDetails,
    buildApplicationPacket,
  };
}
