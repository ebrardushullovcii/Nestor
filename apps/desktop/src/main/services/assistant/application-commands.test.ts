import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AssistantMessageSchema,
  type ApplicationApplyMode,
  type AssistantInstructionGrant,
  type FoundJob,
  type JobSelectionInput,
} from "@nestor/contracts";
import { openJobStore } from "@nestor/db/job-store";
import { createApplicationStore } from "@nestor/db/applications";
import {
  buildAssistantToolCatalog,
  type AssistantToolContext,
} from "@nestor/job-finder";

vi.mock("../job-finder/application-store", () => ({
  getApplicationStore: () => applications,
}));
vi.mock("../job-store", () => ({ getJobStore: () => jobs }));
vi.mock("../job-finder/workspace-service", () => ({
  getJobFinderWorkspaceService: () => Promise.resolve({}),
  startJobFinderRuntime: () =>
    Promise.resolve({
      jobFinderRepository: {
        getSettings: () => Promise.resolve({ applicationAutomationMode: mode }),
        getActivityControl: () => Promise.resolve({ paused }),
      },
    }),
}));
vi.mock("../job-finder/test-api", () => ({
  isDesktopTestApiEnabled: () => false,
}));
vi.mock("../applications", () => ({
  getApplicationService: () =>
    Promise.resolve({
      sendPrepared: (id: number) => send(id),
      open: (id: number) => open(id),
      stopApplication: (id: number) => Promise.resolve(applications.stop(id)),
    }),
}));
vi.mock("../browser/embedded-browser", () => ({
  getEmbeddedBrowser: () => ({ command: browser }),
}));

import { assistantApplicationCommands } from "./application-commands";
const recordInstructionTool = buildAssistantToolCatalog({
  mode: "flat",
  browserAvailable: false,
}).find((t) => t.name === "record_instruction")!;

let jobs: ReturnType<typeof openJobStore>;
let applications: ReturnType<typeof createApplicationStore>;
let mode: ApplicationApplyMode;
let paused: boolean;
const send = vi.fn((id: number) => Promise.resolve(id < 0));
const open = vi.fn((id: number) => Promise.resolve(id > 0));
const browser = vi.fn(() => Promise.resolve());
beforeEach(() => {
  jobs = openJobStore(":memory:");
  applications = createApplicationStore(jobs);
  mode = "confirm_before_submit";
  paused = false;
  vi.clearAllMocks();
});
afterEach(() => jobs.close());

function add(count: number) {
  const start = jobs.listJobs({ stage: "resume" }).total;
  const { added } = jobs.saveFoundJobs({
    searchId: null,
    jobs: Array.from(
      { length: count },
      (_, offset): FoundJob => ({
        title: `Engineer ${start + offset}`,
        company: "Replica",
        location: "Remote",
        workModes: ["remote"],
        url: `http://127.0.0.1/job/${start + offset}`,
        applyUrl: null,
        sourceId: "replica",
        sourceLabel: "Replica",
        sourceJobId: String(start + offset),
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: null,
        employmentType: null,
        summary: null,
        description: "Synthetic listing.",
      }),
    ),
  });
  jobs.setStage(added, "resume");
  return added;
}

function context(ids: number[] = []) {
  const grants: AssistantInstructionGrant[] = [];
  const ctx = {
    ports: {
      resolveApprovedJobs: (selection: JobSelectionInput) =>
        Promise.resolve(applications.selectedJobIds(selection)),
    },
    session: {
      assertCurrent: () => undefined,
      signal: new AbortController().signal,
      conversationId: "conversation",
      now: () => "2026-10-25T15:00:00Z",
      createId: () => `grant_${grants.length}`,
      listResultSets: () => Promise.resolve([]),
      grants: {
        list: () => Promise.resolve(grants),
        save: (grant: AssistantInstructionGrant) => {
          grants.push(grant);
          return Promise.resolve();
        },
      },
      sourceMessage: AssistantMessageSchema.parse({
        id: "message",
        conversationId: "conversation",
        role: "user",
        origin: "sidebar",
        createdAt: "2026-10-25T15:00:00Z",
        parts: [{ type: "text", text: "Apply to these" }],
        context: {
          screen: "review_queue",
          route: "/job-finder/review-queue",
          capturedAt: "2026-10-25T15:00:00Z",
          sectionLabel: null,
          focus: null,
          editor: null,
          browser: null,
          selectedText: null,
          mentions: [],
          attachments: [],
          list: {
            listKind: "shortlist",
            selectedIds: ids.map(String),
            displayedIds: ids.map(String),
            filteredIds: [],
            totalFilteredCount: ids.length,
            filterSummary: null,
            campaignId: null,
          },
        },
      }),
    },
  } as unknown as AssistantToolContext;
  return { ctx, grants };
}

async function record(
  ctx: AssistantToolContext,
  selection: JobSelectionInput,
  action:
    | "prepare"
    | "prepare_and_send"
    | "apply_saved_mode" = "apply_saved_mode",
) {
  await recordInstructionTool.execute(
    recordInstructionTool.input.parse({
      selection,
      action,
      quote: "Apply to these",
    }),
    ctx,
  );
}

it("freezes all approved jobs across pages, respects exclusions and keeps later arrivals out through the shared executor", async () => {
  const ids = add(205);
  const { ctx } = context();
  const selection = { filter: { stage: "resume" as const }, except: [ids[0]!] };
  await record(ctx, selection);
  const later = add(1)[0]!;
  const tools = assistantApplicationCommands();
  {
    const result = await tools
      .find((t) => t.name === "apply_to_jobs")!
      .execute({ selection }, ctx);
    expect(result.data).toEqual({
      queued: 204,
      unchanged: 0,
      notApproved: 0,
      refused: 1,
    });
    expect(applications.forJobs([ids[0]!, later])).toEqual([]);
    expect(
      applications
        .listApplications({ limit: 200 })
        .rows.every((r) => r.mode === "confirm_before_submit"),
    ).toBe(true);
  }
});

it("uses one/selected ids, refuses unapproved jobs and never upgrades or duplicates existing Fill work", async () => {
  const ids = add(3);
  const { ctx } = context(ids);
  const selection = { ids: ids.slice(0, 2) };
  await record(ctx, selection, "prepare");
  const tool = assistantApplicationCommands().find(
    (t) => t.name === "apply_to_jobs",
  )!;
  await tool.execute({ selection }, ctx);
  mode = "autonomous_submit";
  await record(ctx, selection, "prepare_and_send");
  expect((await tool.execute({ selection }, ctx)).data).toMatchObject({
    queued: 0,
    unchanged: 2,
  });
  expect(applications.forJobs(ids).map((r) => r.mode)).toEqual([
    "confirm_before_submit",
    "confirm_before_submit",
  ]);
  jobs.setStage([ids[2]!], "shortlisted");
  await record(ctx, { ids: [ids[2]!] });
  expect(
    (await tool.execute({ selection: { ids: [ids[2]!] } }, ctx)).data,
  ).toMatchObject({ queued: 0, notApproved: 1 });
});

it("requires a send instruction in Fill mode; Open and Stop use the work id and never send", async () => {
  const ids = add(1);
  const { ctx } = context(ids);
  const tools = assistantApplicationCommands();
  await record(ctx, { ids });
  await tools
    .find((t) => t.name === "apply_to_jobs")!
    .execute({ selection: { ids } }, ctx);
  const target = { id: applications.forJobs(ids)[0]!.id };
  const sendTool = tools.find((t) => t.name === "send_application")!;
  await expect(sendTool.execute(target, ctx)).rejects.toThrow("Fill in for me");
  mode = "autonomous_submit";
  await expect(sendTool.execute(target, ctx)).rejects.toThrow("Fill in for me");
  expect(send).not.toHaveBeenCalled();
  await tools.find((t) => t.name === "open_application")!.execute(target, ctx);
  expect(open).toHaveBeenCalledWith(target.id);
  expect(browser).toHaveBeenCalledWith({ type: "open" });
  await record(ctx, { ids }, "prepare_and_send");
  await sendTool.execute(target, ctx);
  expect(send).toHaveBeenCalledOnce();
  await tools.find((t) => t.name === "stop_application")!.execute(target, ctx);
  expect(applications.getApplication(target.id)?.state).toBe("stopped");
});

it("keeps the person's pause and refuses a host-generated instruction", async () => {
  const ids = add(1);
  const { ctx } = context(ids);
  await record(ctx, { ids });
  paused = true;
  await expect(
    assistantApplicationCommands()
      .find((t) => t.name === "apply_to_jobs")!
      .execute({ selection: { ids } }, ctx),
  ).rejects.toThrow("paused");
  expect(applications.forJobs(ids)).toEqual([]);
  ctx.session.sourceMessage = { ...ctx.session.sourceMessage!, origin: "host" };
  await expect(record(ctx, { ids }, "prepare_and_send")).rejects.toThrow(
    "typed in this sidebar",
  );
});

it("reports the actual guard refusal without claiming an unconfirmed send attempt", async () => {
  const ids = add(1);
  applications.applyJobs({ selection: { ids } });
  const row = applications.claimNext()!;
  applications.finishPreparation({
    id: row.id,
    attempt: row.attempt,
    state: "ready",
  });
  const { ctx } = context(ids);
  await record(ctx, { ids }, "prepare_and_send");
  send.mockImplementationOnce(() => {
    applications.submissionRefused(
      row.id,
      row.attempt,
      "The permission to send this application changed.",
    );
    return Promise.resolve(false);
  });
  const result = await assistantApplicationCommands()
    .find((tool) => tool.name === "send_application")!
    .execute({ id: row.id }, ctx);
  expect(result.summary).toBe(
    "Not sent: The permission to send this application changed.",
  );
  expect(result.data).toMatchObject({
    application: {
      state: "ready",
      error: "The permission to send this application changed.",
    },
  });
});
