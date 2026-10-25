import {
  ApplicationAnswerRecordSchema,
  compareApplicationAnswerRecency,
  ClearApplicationAnswerCommandSchema,
  SaveApplicationAnswerCommandSchema,
  type ApplicationAnswerRecord,
  type ApplicationAnswerValue,
  type ApplicationQuestionKind,
  type ApplyRunDetails,
  type CandidateAssetKind,
  type ClearApplicationAnswerCommand,
  type SaveApplicationAnswerCommand,
  type UserActionCommand,
} from "@nestor/contracts";
import {
  createReusableAnswerForQuestion,
  eligibilityAnswerScope,
  normalizeAnswerQuestion,
} from "./workspace-answer-memory";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import { readSavedJob } from "./read-saved-job";

function getLatestQuestionAnswer(
  details: ApplyRunDetails,
  questionId: string,
): ApplicationAnswerRecord | null {
  return (
    details.answerRecords
      .filter((answer) => answer.questionId === questionId)
      .sort(compareApplicationAnswerRecency)[0] ?? null
  );
}

function normalizeOption(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function resolveCanonicalOption(
  requested: string,
  options: readonly string[],
): string {
  if (options.length === 0) {
    return requested.trim();
  }

  const requestedKey = normalizeOption(requested);
  const match = options.find(
    (option) => normalizeOption(option) === requestedKey,
  );
  if (!match) {
    throw new Error(
      "That answer is not one of the choices currently shown by the employer.",
    );
  }
  return match;
}

function normalizeAnswerValue(
  value: ApplicationAnswerValue,
  answerOptions: readonly string[],
): ApplicationAnswerValue {
  if (value.type === "single_choice") {
    return {
      type: value.type,
      value: resolveCanonicalOption(value.value, answerOptions),
    };
  }

  if (value.type === "multi_choice") {
    const values = Array.from(
      new Set(
        value.values.map((entry) =>
          resolveCanonicalOption(entry, answerOptions),
        ),
      ),
    );
    return { type: value.type, values };
  }

  return value;
}

function assetKindMatchesQuestion(
  questionKind: ApplicationQuestionKind,
  assetKind: CandidateAssetKind,
) {
  switch (questionKind) {
    case "cover_letter":
      return (
        assetKind === "cover_letter" ||
        assetKind === "application_response" ||
        assetKind === "other"
      );
    case "portfolio":
      return ["portfolio", "work_sample", "image", "other"].includes(assetKind);
    case "resume":
      return false;
    default:
      return assetKind !== "resume";
  }
}

export function formatApplicationAnswerValue(
  value: ApplicationAnswerValue,
): string {
  switch (value.type) {
    case "text":
    case "single_choice":
    case "date":
      return value.value;
    case "multi_choice":
      return value.values.join(", ");
    case "boolean":
      return value.value ? "Yes" : "No";
    case "asset_ref":
      return `Approved asset ${value.assetId}`;
  }
}

async function saveReusableAnswer(input: {
  command: SaveApplicationAnswerCommand;
  ctx: WorkspaceServiceContext;
  prompt: string;
  applicationRecordId: string | null;
  questionKind: Parameters<typeof createReusableAnswerForQuestion>[0]["kind"];
  text: string;
}) {
  if (input.command.saveScope !== "reusable_profile") {
    return;
  }
  if (input.command.value.type === "asset_ref") {
    throw new Error(
      "Files stay scoped to an application and cannot be saved as a reusable text answer.",
    );
  }

  const job = await readSavedJob(input.ctx.repository, input.command.jobId);
  const applicationScope = eligibilityAnswerScope({
    kind: input.questionKind,
    resultId: input.command.resultId,
    applicationRecordId: input.applicationRecordId,
    location: job?.location,
  });
  const normalizedPrompt = normalizeAnswerQuestion(input.prompt);
  await input.ctx.repository.commitProfileUpdate((current) => {
    const exactMatches = current.answerBank.customAnswers.filter((candidate) =>
      [candidate.question, candidate.label].some(
        (value) =>
          normalizeAnswerQuestion(value) === normalizedPrompt &&
          (candidate.applicationScope?.location ?? null) ===
            (applicationScope?.location ?? null),
      ),
    );
    // Saving for next time replaces a different answer saved earlier for the
    // same question; refusing would leave the application stuck.
    if (exactMatches.length > 0) {
      if (
        exactMatches.every(
          (candidate) => candidate.answer.trim() === input.text,
        )
      ) {
        return current;
      }
      return {
        ...current,
        answerBank: {
          ...current.answerBank,
          customAnswers: current.answerBank.customAnswers.map((candidate) =>
            exactMatches.includes(candidate)
              ? { ...candidate, answer: input.text }
              : candidate,
          ),
        },
      };
    }

    return {
      ...current,
      answerBank: {
        ...current.answerBank,
        customAnswers: [
          ...current.answerBank.customAnswers,
          createReusableAnswerForQuestion({
            answer: input.text,
            prompt: input.prompt,
            ...(applicationScope ? { applicationScope } : {}),
            kind: input.questionKind,
          }),
        ],
      },
    };
  });
}

export function createWorkspaceApplicationAnswerMethods(
  ctx: WorkspaceServiceContext,
  getApplyRunDetails: (
    runId: string,
    jobId: string,
    applicationRecordId?: string | null,
  ) => Promise<ApplyRunDetails>,
  performUserAction?: (command: UserActionCommand) => Promise<unknown>,
) {
  const mutationFlights = new Map<string, Promise<ApplyRunDetails>>();

  async function reuseAnswerInBatch(command: SaveApplicationAnswerCommand) {
    if (
      command.saveScope !== "reusable_profile" ||
      command.value.type === "asset_ref"
    )
      return;
    const details = await getApplyRunDetails(command.runId, command.jobId);
    const source = details.questionRecords.find(
      (question) => question.id === command.questionId,
    );
    if (!source) return;
    const job = await readSavedJob(ctx.repository, command.jobId);
    const questions = await ctx.repository.listApplicationQuestionRecords({
      runId: command.runId,
    });
    for (const question of questions) {
      if (
        question.jobId === command.jobId ||
        !question.applicationRecordId ||
        question.status !== "detected" ||
        question.selectedAnswerId ||
        question.kind !== source.kind ||
        question.answerControlType !== source.answerControlType ||
        normalizeAnswerQuestion(question.prompt) !==
          normalizeAnswerQuestion(source.prompt) ||
        JSON.stringify([...question.answerOptions].sort()) !==
          JSON.stringify([...source.answerOptions].sort())
      )
        continue;
      // Country-dependent facts never spread to a different hiring context.
      if (
        source.kind === "work_authorization" ||
        source.kind === "visa_sponsorship"
      ) {
        // Conditional permits still need the ordinary per-job interpretation.
        const profile = await ctx.repository.getProfile();
        if (profile.workEligibility.limitedWorkPermissions?.length) continue;
        const peerJob = await readSavedJob(ctx.repository, question.jobId);
        if (!job?.location?.trim() || peerJob?.location !== job.location)
          continue;
      }
      const peer = await getApplyRunDetails(
        command.runId,
        question.jobId,
        question.applicationRecordId,
      );
      const latest = getLatestQuestionAnswer(peer, question.id);
      if (
        peer.result?.id !== question.resultId ||
        !["blocked", "awaiting_review"].includes(peer.result.state) ||
        (latest &&
          (latest.sourceKind === "user" || latest.status !== "suggested"))
      )
        continue;
      const reused: SaveApplicationAnswerCommand = {
        ...command,
        commandId: `${command.commandId}_reuse_${question.id}`,
        jobId: question.jobId,
        resultId: question.resultId,
        questionId: question.id,
        expectedAnswerRevision: latest?.revision ?? 0,
        saveScope: "application_once",
      };
      // The person's own answer is already saved. Another application's
      // write or continuation must not fail or hold up their Save.
      await runSingleFlight(reused.commandId, () =>
        saveApplicationAnswerOnce(reused, { continueInBackground: true }),
      ).catch((error: unknown) => {
        console.error(
          "Job Finder could not reuse an answer on another application.",
          error,
        );
      });
    }
  }

  async function continueAfterSave(
    command: SaveApplicationAnswerCommand,
    continueInBackground: boolean,
  ) {
    if (!continueInBackground) return continueAnsweredStep(command);
    void continueAnsweredStep(command).catch((error: unknown) => {
      console.error(
        "Job Finder could not continue another application after reusing an answer.",
        error,
      );
    });
  }

  async function continueAnsweredStep(command: SaveApplicationAnswerCommand) {
    if (!performUserAction) return;
    const details = await getApplyRunDetails(command.runId, command.jobId);
    if (
      details.result?.id !== command.resultId ||
      (details.result.state !== "blocked" &&
        details.result.state !== "awaiting_review")
    )
      return;
    const requiredQuestions = details.questionRecords.filter(
      (question) =>
        question.resultId === command.resultId && question.isRequired,
    );
    if (
      !requiredQuestions.length ||
      requiredQuestions.some((question) => {
        const answer = getLatestQuestionAnswer(details, question.id);
        return (
          question.status !== "answered" ||
          !answer ||
          answer.status === "rejected" ||
          answer.value === null
        );
      })
    )
      return;
    const requests = await ctx.repository.listUserActionRequests({
      scopeType: "application",
      states: ["pending", "page_opened", "awaiting_user", "still_blocked"],
    });
    const request = requests.find(
      (candidate) =>
        (candidate.kind === "manual_answer" ||
          candidate.kind === "manual_upload") &&
        candidate.scope.type === "application" &&
        candidate.scope.runId === command.runId &&
        candidate.scope.jobId === command.jobId &&
        candidate.scope.resultId === command.resultId &&
        candidate.scope.applicationRecordId ===
          details.result?.applicationRecordId,
    );
    if (!request) return;
    await performUserAction({
      action: "confirm_done",
      commandId: `${command.commandId}_continue_${request.id}_r${request.revision}`,
      requestId: request.id,
      expectedRevision: request.revision,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
  }

  async function getExactMutationContext(input: {
    expectedAnswerRevision: number;
    jobId: string;
    questionId: string;
    resultId: string;
    runId: string;
  }) {
    const details = await getApplyRunDetails(input.runId, input.jobId);
    if (details.result?.id !== input.resultId) {
      throw new Error(
        "This answer editor is stale because the application moved to a newer result. Reload the application and try again.",
      );
    }
    const question = details.questionRecords.find(
      (candidate) =>
        candidate.id === input.questionId &&
        candidate.resultId === input.resultId,
    );
    if (!question) {
      throw new Error(
        "This question is no longer available in the selected application result.",
      );
    }
    if (question.status === "submitted") {
      throw new Error("Submitted employer answers cannot be changed here.");
    }

    const latestAnswer = getLatestQuestionAnswer(details, question.id);
    const currentRevision = latestAnswer?.revision ?? 0;
    if (currentRevision !== input.expectedAnswerRevision) {
      throw new Error(
        "This answer changed in another view. Reload the application before replacing it.",
      );
    }

    return { details, latestAnswer, question };
  }

  async function saveApplicationAnswerOnce(
    command: SaveApplicationAnswerCommand,
    { continueInBackground = false } = {},
  ): Promise<ApplyRunDetails> {
    const existingDetails = await getApplyRunDetails(
      command.runId,
      command.jobId,
    );
    if (
      existingDetails.answerRecords.some(
        (answer) => answer.id === `application_answer_${command.commandId}`,
      )
    ) {
      await reuseAnswerInBatch(command);
      await continueAfterSave(command, continueInBackground);
      return getApplyRunDetails(command.runId, command.jobId);
    }

    const { latestAnswer, question } = await getExactMutationContext(command);
    const value = normalizeAnswerValue(command.value, question.answerOptions);
    if (value.type === "asset_ref" && question.answerControlType !== "file") {
      throw new Error(
        "This employer question is not a file-upload control, so an asset cannot be attached to it.",
      );
    }
    const resolvedAsset =
      value.type === "asset_ref"
        ? await ctx.candidateAssetResolver?.resolveForApplication(value.assetId)
        : null;
    if (value.type === "asset_ref" && !resolvedAsset) {
      throw new Error(
        "Candidate assets are not available in this workspace. Import the file again before preparing this application.",
      );
    }
    if (
      resolvedAsset &&
      !assetKindMatchesQuestion(question.kind, resolvedAsset.asset.kind)
    ) {
      throw new Error(
        question.kind === "resume"
          ? "Resume uploads use the approved CV selected for this job. Change the job's CV mode instead of attaching a library asset here."
          : "That asset type does not match the employer's requested document.",
      );
    }
    if (
      resolvedAsset?.asset.forJob &&
      resolvedAsset.asset.forJob.jobId !== command.jobId
    ) {
      throw new Error("That file was written for another job.");
    }
    const text = resolvedAsset
      ? resolvedAsset.asset.originalName
      : formatApplicationAnswerValue(value);
    await saveReusableAnswer({
      command: { ...command, value },
      ctx,
      prompt: question.prompt,
      applicationRecordId: question.applicationRecordId ?? null,
      questionKind: question.kind,
      text,
    });

    const createdAt = new Date().toISOString();
    const answer = ApplicationAnswerRecordSchema.parse({
      id: `application_answer_${command.commandId}`,
      runId: command.runId,
      jobId: command.jobId,
      applicationRecordId: question.applicationRecordId,
      resultId: command.resultId,
      questionId: command.questionId,
      status: "suggested",
      text,
      value,
      revision: (latestAnswer?.revision ?? 0) + 1,
      saveScope: command.saveScope,
      supersedesAnswerId: latestAnswer?.id ?? null,
      sourceKind: "user",
      sourceId: command.commandId,
      confidenceLabel: "Provided by the user for this exact application",
      provenance: [
        {
          id: `application_answer_provenance_${command.commandId}`,
          sourceKind: "user",
          sourceId: command.commandId,
          label:
            command.saveScope === "reusable_profile"
              ? "Reviewed for this application and saved to Profile"
              : "Reviewed for this application only",
          snippet: question.prompt,
        },
      ],
      createdAt,
      submittedAt: null,
    });

    const mutationResult = await ctx.repository.commitApplicationAnswerMutation(
      {
        expectedAnswer: latestAnswer,
        expectedQuestion: question,
        answer,
        question: {
          ...question,
          selectedAnswerId: answer.id,
          submittedAnswer: answer.text,
          status: "answered",
        },
      },
    );
    if (mutationResult === "stale") {
      throw new Error(
        "This answer changed in another view. Reload the application before replacing it.",
      );
    }
    await reuseAnswerInBatch(command);
    await continueAfterSave(command, continueInBackground);
    return getApplyRunDetails(command.runId, command.jobId);
  }

  async function clearApplicationAnswerOnce(
    command: ClearApplicationAnswerCommand,
  ): Promise<ApplyRunDetails> {
    const existingDetails = await getApplyRunDetails(
      command.runId,
      command.jobId,
    );
    if (
      existingDetails.answerRecords.some(
        (answer) => answer.id === `application_answer_${command.commandId}`,
      )
    ) {
      return existingDetails;
    }

    const { latestAnswer, question } = await getExactMutationContext(command);
    if (!latestAnswer) {
      throw new Error(
        "This question does not have an application answer to clear.",
      );
    }

    const clearedAt = new Date().toISOString();
    const answer = ApplicationAnswerRecordSchema.parse({
      ...latestAnswer,
      id: `application_answer_${command.commandId}`,
      status: "rejected",
      text: "Answer cleared by the user",
      value: null,
      revision: latestAnswer.revision + 1,
      saveScope: "application_once",
      supersedesAnswerId: latestAnswer.id,
      sourceKind: "user",
      sourceId: command.commandId,
      confidenceLabel: "Cleared before application preparation continued",
      provenance: [
        {
          id: `application_answer_provenance_${command.commandId}`,
          sourceKind: "user",
          sourceId: command.commandId,
          label: "Cleared from this application",
          snippet: question.prompt,
        },
      ],
      createdAt: clearedAt,
      submittedAt: null,
    });
    const mutationResult = await ctx.repository.commitApplicationAnswerMutation(
      {
        expectedAnswer: latestAnswer,
        expectedQuestion: question,
        answer,
        question: {
          ...question,
          selectedAnswerId: null,
          submittedAnswer: null,
          status: "detected",
        },
      },
    );
    if (mutationResult === "stale") {
      throw new Error(
        "This answer changed in another view. Reload the application before replacing it.",
      );
    }
    return getApplyRunDetails(command.runId, command.jobId);
  }

  function runSingleFlight(
    commandId: string,
    operation: () => Promise<ApplyRunDetails>,
  ) {
    const existing = mutationFlights.get(commandId);
    if (existing) {
      return existing;
    }
    const flight = operation().finally(() => {
      if (mutationFlights.get(commandId) === flight) {
        mutationFlights.delete(commandId);
      }
    });
    mutationFlights.set(commandId, flight);
    return flight;
  }

  /**
   * A file the person restored or added in Profile > Files is the answer to a
   * waiting file question, so the application waiting on it carries on
   * without a second press. Only unresolved upload steps whose open file
   * question takes this kind of file are continued; the continuation reads
   * the active files again and attaches the one that fits.
   */
  /** Bounded so two files that never fit cannot loop forever. */
  const MAX_FILE_FOLLOW_UP_ROUNDS = 3;

  async function continueApplicationsWaitingForFiles(
    input: {
      assetId: string;
      assetKind: CandidateAssetKind;
    },
    followUpRound = 0,
  ): Promise<number> {
    if (!performUserAction || input.assetKind === "resume") return 0;
    const requests = (
      await ctx.repository.listUserActionRequests({
        scopeType: "application",
        states: ["pending", "page_opened", "awaiting_user", "still_blocked"],
      })
    ).filter(
      (request) =>
        request.kind === "manual_upload" &&
        request.scope.type === "application" &&
        Boolean(request.scope.resultId) &&
        Boolean(request.scope.runId),
    );
    let continued = 0;
    const flights: Promise<unknown>[] = [];
    for (const request of requests) {
      if (request.scope.type !== "application" || !request.scope.runId) {
        continue;
      }
      const resultId = request.scope.resultId;
      const details = await getApplyRunDetails(
        request.scope.runId,
        request.scope.jobId,
      ).catch(() => null);
      const waitsForThisKind = (details?.questionRecords ?? []).some(
        (question) =>
          question.resultId === resultId &&
          question.answerControlType === "file" &&
          question.status !== "answered" &&
          assetKindMatchesQuestion(question.kind, input.assetKind),
      );
      if (!waitsForThisKind) continue;
      continued += 1;
      flights.push(
        performUserAction({
          action: "confirm_done",
          commandId: `files_changed_${input.assetId}_${request.id}_r${request.revision}`,
          requestId: request.id,
          expectedRevision: request.revision,
          credentialsPolicy: "browser_only",
          submitAuthorized: false,
          accountCreationAuthorized: false,
        }).catch(() => undefined),
      );
    }
    if (flights.length > 0 && followUpRound < MAX_FILE_FOLLOW_UP_ROUNDS) {
      // A continuation reads the files once, at its start. A second file the
      // person added meanwhile (a portfolio, then a transcript a few seconds
      // later) arrived too late for it, and the application came back asking
      // for the file already sitting in Profile > Files, with nothing left to
      // trigger another try. Once these continuations settle, offer every
      // active file again to whatever still waits.
      void Promise.all(flights).then(() =>
        continueWithActiveFiles(followUpRound + 1),
      );
    }
    return continued;
  }

  async function continueWithActiveFiles(followUpRound: number): Promise<void> {
    const listed = await ctx.candidateAssetResolver
      ?.list?.({ includeDeleted: false })
      .catch(() => null);
    const seenKinds = new Set<CandidateAssetKind>();
    for (const asset of listed?.assets ?? []) {
      if (
        asset.deletedAt ||
        asset.kind === "resume" ||
        asset.consentScope !== "job_application_attachment" ||
        seenKinds.has(asset.kind)
      ) {
        continue;
      }
      seenKinds.add(asset.kind);
      await continueApplicationsWaitingForFiles(
        { assetId: asset.id, assetKind: asset.kind },
        followUpRound,
      ).catch(() => 0);
    }
  }

  return {
    continueApplicationsWaitingForFiles,
    saveApplicationAnswer(input: unknown) {
      const command = SaveApplicationAnswerCommandSchema.parse(input);
      return runSingleFlight(command.commandId, () =>
        saveApplicationAnswerOnce(command),
      );
    },
    clearApplicationAnswer(input: unknown) {
      const command = ClearApplicationAnswerCommandSchema.parse(input);
      return runSingleFlight(command.commandId, () =>
        clearApplicationAnswerOnce(command),
      );
    },
  };
}
