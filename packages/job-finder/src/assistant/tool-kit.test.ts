import {
  AssistantMessageSchema,
  AssistantResultSetSchema,
  JobPostingSchema,
  type AssistantResultSet,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceServiceHarness,
  createSeed,
} from "../workspace-service.test-support";
import type { AssistantBrowserLease, AssistantHostPorts } from "./ports";
import {
  toConversationTool,
  type AssistantToolContext,
  type AssistantToolDefinition,
  type AssistantTurnSession,
} from "./tool-kit";
import { collectPageJobsTool } from "./tools/browser-tools";
import { getJobTool, shortlistJobsTool } from "./tools/jobs-tools";
import { recordInstructionTool } from "./tools/application-tools";

function harness() {
  const { workspaceService } = createWorkspaceServiceHarness();
  const sets: AssistantResultSet[] = [];
  let serial = 0;
  const now = "2026-10-01T10:00:00.000Z";
  const posting = (name: string) =>
    JobPostingSchema.parse({
      ...createSeed().savedJobs[0],
      id: name,
      sourceJobId: name,
      canonicalUrl: `https://example.test/jobs/${name}`,
      applicationUrl: `https://example.test/jobs/${name}/apply`,
      title: `${name} Engineer`,
      company: `Company ${name}`,
    });
  const extract = vi
    .spyOn(workspaceService, "extractJobsFromPageText")
    .mockResolvedValueOnce([posting("A")])
    .mockResolvedValueOnce([posting("B")]);
  const lease = {
    revoked: new AbortController().signal,
    currentUrl: () => "https://example.test/jobs",
    hands: {
      readText: () => Promise.resolve("Jobs"),
      readPage: () => Promise.resolve({ links: [] }),
    },
  } as unknown as AssistantBrowserLease;
  const saveGrant = vi.fn(() => Promise.resolve());
  const session = {
    conversationId: "conversation_1",
    turnId: "turn_1",
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    now: () => now,
    createId: (prefix: string) => `${prefix}_${++serial}`,
    browserLease: () => Promise.resolve(lease),
    sourceMessage: AssistantMessageSchema.parse({
      id: "message_1",
      conversationId: "conversation_1",
      role: "user",
      origin: "sidebar",
      parts: [{ type: "text", text: "Prepare this job" }],
      createdAt: now,
    }),
    createResultSet: (
      input: Parameters<AssistantTurnSession["createResultSet"]>[0],
    ) => {
      const set = AssistantResultSetSchema.parse({
        ...input,
        id: `set_${++serial}`,
        conversationId: "conversation_1",
        createdAt: new Date(Date.parse(now) + serial * 1000).toISOString(),
      });
      sets.push(set);
      return Promise.resolve(set);
    },
    saveResultSet: (set: AssistantResultSet) => {
      sets[sets.findIndex((entry) => entry.id === set.id)] = set;
      return Promise.resolve();
    },
    getResultSet: (id: string) =>
      Promise.resolve(sets.find((set) => set.id === id) ?? null),
    listResultSets: () => Promise.resolve(sets),
    grants: { save: saveGrant },
  } as unknown as AssistantTurnSession;
  const context: AssistantToolContext = {
    service: workspaceService,
    session,
    ports: {
      browser: {},
      publishWorkspaceUpdate: vi.fn(),
    } as unknown as AssistantHostPorts,
  };
  const run = (definition: AssistantToolDefinition, args: unknown) =>
    toConversationTool(definition, context, {
      parts: [],
      activity: [],
      touched: [],
      endTurn: null,
    }).execute(JSON.stringify(args), { step: 0, signal: session.signal });
  return { context, sets, run, extract, saveGrant };
}

describe("collected page-job references", () => {
  it.each([true, false])("ends a simple action only when its verified receipt allows it (%s)", async (canFinish) => {
    const { run } = harness();
    const execute = vi.fn(() => Promise.resolve({ summary: "Saved the exact headline.", data: { headline: "Engineer" }, canFinish, parts: [{ type: "change" as const, receiptId: "receipt", target: "profile" as const, targetId: null, summary: "Headline", fields: [], preview: [], status: "applied" as const, unsaved: false }] }));
    const tool: AssistantToolDefinition = { ...getJobTool, name: "edit_profile", execute };
    const result = await run(tool, { jobId: "job", complete: true });
    expect(execute).toHaveBeenCalledWith({ jobId: "job" }, expect.anything());
    expect(result.kind).toBe(canFinish ? "finish" : "ok");
    if (result.kind === "finish") {
      expect(result.finish.output).toContain('"headline":"Engineer"');
      expect(result.finish.output).toContain('"receiptId":"receipt"');
    }
  });

  it("keeps the model's next step when it did not request completion", async () => {
    const { run } = harness();
    const tool: AssistantToolDefinition = { ...getJobTool, name: "edit_profile", execute: () => Promise.resolve({ summary: "Saved.", canFinish: true }) };
    expect((await run(tool, { jobId: "job" })).kind).toBe("ok");
  });
  it.each([
    ["get_job", getJobTool],
    ["shortlist_jobs", shortlistJobsTool],
  ] as const)(
    "%s resolves an older collection's job after another collection",
    async (_name, tool) => {
      const { context, sets, run } = harness();
      await collectPageJobsTool.execute({ single: false }, context);
      const firstId = sets[0]!.itemIds[0]!;
      await collectPageJobsTool.execute({ single: false }, context);
      const result = await run(
        tool,
        tool.name === "get_job"
          ? { jobId: firstId }
          : { jobIds: [firstId], evenIfExcludedOrApplied: false },
      );
      expect(result).toMatchObject({ status: "done" });
      const snapshot = await context.service.getWorkspaceSnapshot();
      expect(
        [...snapshot.discoveryJobs, ...snapshot.reviewQueue].some(
          (job) => job.title === "A Engineer",
        ),
      ).toBe(true);
      expect(
        snapshot.discoveryJobs.some((job) => job.title === "B Engineer"),
      ).toBe(false);
      expect(
        sets.filter((set) => set.kind === "page_jobs")[1]!.itemIds,
      ).not.toContain(firstId);
    },
  );

  it("records a saved mapping before checking an instruction grant", async () => {
    const { context, sets, run, saveGrant } = harness();
    await collectPageJobsTool.execute({ single: false }, context);
    const result = await run(recordInstructionTool, {
      action: "prepare",
      jobIds: [sets[0]!.itemIds[0]],
      quote: "Prepare this job",
    });
    expect(result).toMatchObject({ status: "done" });
    const saved = (
      await context.service.getWorkspaceSnapshot()
    ).discoveryJobs.find((job) => job.title === "A Engineer")!;
    expect(saveGrant).toHaveBeenCalledWith(
      expect.objectContaining({ jobIds: [saved.id] }),
    );
    expect(
      sets.some((set) => set.kind === "jobs" && set.itemIds.includes(saved.id)),
    ).toBe(true);
  });

  it("also grants an unambiguous legacy page_job_1 reference after saving it", async () => {
    const { context, sets, run } = harness();
    await collectPageJobsTool.execute({ single: false }, context);
    sets[0]!.itemIds = ["page_job_1"];
    expect(
      await run(recordInstructionTool, {
        action: "prepare",
        jobIds: ["page_job_1"],
        quote: "Prepare this job",
      }),
    ).toMatchObject({ status: "done" });
  });

  it("does not save a job from ambiguous legacy positional references", async () => {
    const { context, sets, run } = harness();
    await collectPageJobsTool.execute({ single: false }, context);
    await collectPageJobsTool.execute({ single: false }, context);
    for (const set of sets) set.itemIds = ["page_job_1"];
    const save = vi.spyOn(context.service, "saveJobsFromPage");
    expect(await run(getJobTool, { jobId: "page_job_1" })).toMatchObject({
      status: "failed",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps existing references when appending more jobs", async () => {
    const { context, sets } = harness();
    await collectPageJobsTool.execute({ single: false }, context);
    const id = sets[0]!.itemIds[0];
    await collectPageJobsTool.execute(
      { single: false, appendTo: sets[0]!.id },
      context,
    );
    expect(sets[0]!.itemIds).toHaveLength(2);
    expect(sets[0]!.itemIds[0]).toBe(id);
    expect(new Set(sets[0]!.itemIds).size).toBe(2);
  });
});
