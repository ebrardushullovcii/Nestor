import { assertPersonAnswerAuthority } from "../person-answer-authority";
import {
  ApplicationAnswerValueSchema,
  AssistantGrantActionSchema,
  JobSelectionSchema,
  NonEmptyStringSchema,
  type AssistantInstructionGrant,
} from "@nestor/contracts";
import { z } from "zod";
import type { JobFinderWorkspaceService } from "../../internal/workspace-service-contracts";
import { checkGrantTargets, narrowGrant } from "../grants";
import { AssistantToolError, defineTool, json } from "../tool-kit";
import { plural } from "./format";
const Id = NonEmptyStringSchema.max(200);

export const recordInstructionTool = defineTool({
  name: "record_instruction",
  group: "applications",
  description:
    "Records what the person's own message authorizes for applications before you start any: prepare (fill in and stop; they send), prepare_and_send (they wrote that the applications should be sent), or apply_saved_mode (they said apply and nothing about sending). Name the jobs by id, a result set and positions, or a typed selection. For all approved jobs use selection:{filter:{stage:resume}}; for all selected use the context filter and exclusions. Read them first when ids are not on screen. The jobs are frozen: jobs that arrive later are not added. Quote their words in 'quote'.",
  parameters: json.object(
    {
      action: json.enumOf(["prepare", "prepare_and_send", "apply_saved_mode"]),
      jobIds: json.ids(),
      selection: json.looseObject(
        "Apply choice: {ids:[numeric job ids]} or {filter:{stage:resume,text},except:[]}. A filter freezes every approved matching job, across pages.",
      ),
      resultSetId: json.string(),
      positions: json.array(
        json.number(),
        "1-based positions in the result set; omit for all of it.",
      ),
      quote: json.string("The person's words that authorize this."),
      constraints: json.array(
        json.string(),
        "Limits they stated, such as 'skip anything asking for a cover letter'.",
      ),
      resumePolicy: json.string(),
      answerPolicy: json.string(),
    },
    ["action", "quote"],
  ),
  input: z.object({
    action: AssistantGrantActionSchema,
    jobIds: z.array(Id).max(5000).default([]),
    selection: JobSelectionSchema.optional(),
    resultSetId: Id.optional(),
    positions: z.array(z.number().int().min(1)).max(2000).optional(),
    quote: z.string().trim().min(1).max(1_000),
    constraints: z.array(z.string().trim().min(1).max(400)).max(12).default([]),
    resumePolicy: z.string().max(400).optional(),
    answerPolicy: z.string().max(1_000).optional(),
  }),
  label: () => "Recording your instruction",
  effect: "local_write",
  async execute(input, { session, ports }) {
    const authorizing = session.sourceMessage;
    if (
      !authorizing ||
      authorizing.origin !== "sidebar" ||
      authorizing.role !== "user"
    ) {
      throw new AssistantToolError(
        "refused",
        "Only a message the person typed in this sidebar can authorize applications. Ask them.",
      );
    }
    let requested = [...input.jobIds];
    const frozenSelection = input.selection;
    const resolvedSelectionIds: string[] = [];
    if (frozenSelection) {
      if (!ports.resolveApprovedJobs) throw new Error("Apply is unavailable.");
      resolvedSelectionIds.push(
        ...(await ports.resolveApprovedJobs(frozenSelection)).map(String),
      );
      requested.push(...resolvedSelectionIds);
    }
    if (input.resultSetId) {
      const resultSet = await session.getResultSet(input.resultSetId);
      if (!resultSet)
        throw new AssistantToolError(
          "not_found",
          "No result set with that id.",
        );
      const picked = input.positions?.length
        ? input.positions
            .map((position) => resultSet.itemIds[position - 1])
            .filter((id): id is string => Boolean(id))
        : resultSet.itemIds;
      requested.push(...picked);
    }
    requested = [...new Set(requested)];
    if (requested.length === 0) {
      throw new AssistantToolError(
        "missing_information",
        "Name the jobs the instruction covers.",
      );
    }
    // A typed Approved filter is resolved once in storage, not one model call per page.
    const filterIds =
      frozenSelection && "filter" in frozenSelection
        ? new Set(resolvedSelectionIds)
        : new Set<string>();
    const check = checkGrantTargets({
      requestedJobIds: requested.filter((id) => !filterIds.has(id)),
      authorizingMessage: authorizing,
      resultSets: await session.listResultSets(),
    });
    check.accepted.push(...filterIds);
    if (check.accepted.length === 0) {
      throw new AssistantToolError(
        "refused",
        "None of those jobs were in your message, on the screen you sent it from, or in a list shown in this conversation.",
        { rejected: check.rejected },
      );
    }
    const now = session.now();
    const grant: AssistantInstructionGrant = {
      id: session.createId("assistant_grant"),
      conversationId: session.conversationId,
      sourceMessageId: authorizing.id,
      action: input.action,
      jobIds: check.accepted.slice(0, 2000),
      resumePolicy: input.resumePolicy ?? null,
      answerPolicy: input.answerPolicy ?? null,
      constraints: input.constraints,
      status: "active",
      history: [
        {
          at: now,
          messageId: authorizing.id,
          change: `Recorded: "${input.quote.slice(0, 300)}"`,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    for (let offset = 0; offset < check.accepted.length; offset += 2000) {
      session.assertCurrent();
      await session.grants.save({
        ...grant,
        id: offset ? session.createId("assistant_grant") : grant.id,
        jobIds: check.accepted.slice(offset, offset + 2000),
      });
    }
    return {
      summary: `Recorded: ${input.action.replaceAll("_", " ")} for ${plural(check.accepted.length, "job")}.${check.rejected.length ? ` Left out ${check.rejected.length} not named by the person.` : ""}`,
      data: {
        grantId: grant.id,
        count: check.accepted.length,
        jobIds: grant.jobIds.slice(0, 20),
        rejected: check.rejected,
      },
    };
  },
});

export const updateInstructionTool = defineTool({
  name: "update_instruction",
  group: "applications",
  description:
    "Narrows or withdraws a recorded instruction when the person corrects it ('skip the second one', 'don't send yet'): remove jobs, weaken the action to prepare, or revoke it. It never widens one; a wider instruction is a new record_instruction from a new message.",
  parameters: json.object(
    {
      grantId: json.string(),
      removeJobIds: json.ids(),
      action: json.enumOf(["prepare", "apply_saved_mode"]),
      revoke: json.boolean(),
      quote: json.string("The person's words."),
    },
    ["grantId", "quote"],
  ),
  input: z.object({
    grantId: Id,
    removeJobIds: z.array(Id).max(2000).default([]),
    action: z.enum(["prepare", "apply_saved_mode"]).optional(),
    revoke: z.boolean().default(false),
    quote: z.string().trim().min(1).max(1_000),
  }),
  label: () => "Updating your instruction",
  effect: "local_write",
  async execute(input, { session }) {
    const message = session.sourceMessage;
    if (!message || message.origin !== "sidebar") {
      throw new AssistantToolError(
        "refused",
        "Only the person's own message can change an instruction.",
      );
    }
    const grant = (await session.grants.list()).find(
      (entry) => entry.id === input.grantId,
    );
    if (!grant)
      throw new AssistantToolError("not_found", "No instruction with that id.");
    const next = narrowGrant(grant, {
      removeJobIds: input.removeJobIds,
      ...(input.action ? { action: input.action } : {}),
      revoke: input.revoke,
      messageId: message.id,
      description: `"${input.quote.slice(0, 300)}"`,
      at: session.now(),
    });
    await session.grants.save(next);
    return {
      summary: `Instruction ${next.status}: ${next.action.replaceAll("_", " ")} for ${plural(next.jobIds.length, "job")}.`,
      data: {
        grantId: next.id,
        status: next.status,
        jobIds: next.jobIds,
        action: next.action,
      },
    };
  },
});

export const listInstructionsTool = defineTool({
  name: "list_instructions",
  group: "applications",
  description:
    "Lists the instructions recorded in this conversation and what each covers.",
  parameters: json.object({}),
  input: z.object({}).passthrough(),
  label: () => "Reading your instructions",
  effect: "read",
  async execute(_input, { session }) {
    const grants = await session.grants.list();
    return {
      summary: `${plural(grants.length, "instruction")}.`,
      data: grants.map((grant) => ({
        id: grant.id,
        action: grant.action,
        status: grant.status,
        count: grant.jobIds.length,
        jobIds: grant.jobIds.slice(0, 20),
        constraints: grant.constraints,
        history: grant.history.slice(-5),
      })),
    };
  },
});

async function latestRunFor(service: JobFinderWorkspaceService, jobId: string) {
  const snapshot = await service.getWorkspaceSnapshot();
  const result = snapshot.applyJobResults
    .filter((entry) => entry.jobId === jobId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const record =
    snapshot.applicationRecords.find((entry) => entry.jobId === jobId) ?? null;
  return { snapshot, result: result ?? null, record };
}

export const answerApplicationQuestionTool = defineTool({
  name: "answer_application_question",
  group: "applications",
  description:
    "Saves the person's answer to one question an application asked (from get_application), for this application or also for later ones (saveForLater). Use their words; never make up personal facts. When the question is also a Needs you step (list_needs_you), answer it with resolve_needs_you instead: that is what continues the paused application.",
  parameters: json.object(
    {
      jobId: json.string(),
      questionId: json.string(),
      answer: json.looseObject(
        "{type:'text',value} | {type:'single_choice',value} | {type:'multi_choice',values} | {type:'boolean',value} | {type:'date',value}",
      ),
      saveForLater: json.boolean(),
    },
    ["jobId", "questionId", "answer"],
  ),
  input: z.object({
    jobId: Id,
    questionId: Id,
    answer: ApplicationAnswerValueSchema,
    saveForLater: z.boolean().default(false),
  }),
  label: () => "Saving your answer",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    const { result, record } = await latestRunFor(service, input.jobId);
    if (!result)
      throw new AssistantToolError(
        "not_found",
        "This job has no application run.",
      );
    const details = await service.getApplyRunDetails(
      result.runId,
      input.jobId,
      record?.id ?? null,
    );
    const current = details.answerRecords
      .filter((answer) => answer.questionId === input.questionId)
      .sort((left, right) => right.revision - left.revision)[0];
    const question = details.questionRecords.find(
      (entry) => entry.id === input.questionId,
    );
    if (!question)
      throw new AssistantToolError(
        "not_found",
        "That application question is no longer available.",
      );
    const answer =
      input.answer.type === "multi_choice"
        ? input.answer.values.join(", ")
        : input.answer.type === "asset_ref"
          ? input.answer.assetId
          : String(input.answer.value);
    await assertPersonAnswerAuthority(session, {
      answers: [{ question: question.prompt, answer }],
      saveForFuture: input.saveForLater,
    });
    session.assertCurrent();
    await service.saveApplicationAnswer({
      commandId: session.createId("assistant_answer"),
      runId: result.runId,
      jobId: input.jobId,
      resultId: result.id,
      questionId: input.questionId,
      expectedAnswerRevision: current?.revision ?? 0,
      value: input.answer,
      saveScope: input.saveForLater ? "reusable_profile" : "application_once",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
    ports.publishWorkspaceUpdate();
    return { summary: "Answer saved." };
  },
});

export const applicationTools = [
  recordInstructionTool,
  updateInstructionTool,
  listInstructionsTool,
  answerApplicationQuestionTool,
];
