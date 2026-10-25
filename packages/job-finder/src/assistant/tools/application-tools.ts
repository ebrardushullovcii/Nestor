import {
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

export const applicationTools = [
  recordInstructionTool,
  updateInstructionTool,
  listInstructionsTool,
];
