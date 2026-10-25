import {
  AssistantContextReferenceSchema,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../workspace-service.test-support";
import type { AssistantHostPorts } from "./ports";
import { ASSISTANT_SYSTEM_PROMPT, buildContextBlock } from "./prompt";
import { readRunStatus } from "./run-watch";
import type { AssistantTurnSession } from "./tool-kit";
import {
  getWorkspaceSummaryTool,
} from "./tools/workspace-tools";
import { readProfileTool } from "./tools/profile-tools";
import { pauseActivityTool } from "./tools/settings-tools";
import { readAssistantWorkState, } from "./work-state";

const openInApp = vi.fn();
const session = {
  firstProfileRead: () => Promise.resolve(false),
  assertCurrent: () => undefined,
  watchRun: () => Promise.resolve(),
  openInApp,
} as unknown as AssistantTurnSession;
const ports = {
  readResumeBatch: () => null,
  stopResumeBatch: () => null,
  publishWorkspaceUpdate: () => undefined,
} as unknown as AssistantHostPorts;

it("reports a UI import even before the new import has a stored run and only offers actions that can work", async () => {
  const { workspaceService } = createWorkspaceServiceHarness();
  const snapshot = await workspaceService.getWorkspaceSnapshot();
  snapshot.resumeImportActive = true;
  snapshot.latestResumeImportRun = null;
  expect(readAssistantWorkState(ports, snapshot).resumeImport).toMatchObject({
    active: true,
    status: "reading",
    actions: ["wait", "open_profile"],
  });
  snapshot.latestResumeImportRun = ResumeImportRunSchema.parse({
    id: "import_1",
    sourceResumeId: "synthetic_resume",
    sourceResumeFileName: "synthetic.txt",
    status: "parsing",
    startedAt: snapshot.generatedAt,
  });
  vi.spyOn(workspaceService, "getWorkspaceSnapshot").mockResolvedValue(
    snapshot,
  );
  expect(
    (
      await getWorkspaceSummaryTool.execute(
        {},
        { service: workspaceService, session, ports },
      )
    ).data,
  ).toMatchObject({
    resumeImport: {
      active: true,
      status: "parsing",
      actions: ["wait", "open_profile"],
    },
  });
  const paused = await pauseActivityTool.execute(
    { paused: true, finishCurrent: false },
    { service: workspaceService, session, ports },
  );
  expect(paused.summary).toContain(
    "Resume import is still running; it was not stopped.",
  );
});

it("shows current approval and saved level, instead of an earlier approval claim", async () => {
  const { workspaceService } = createWorkspaceServiceHarness();
  const snapshot = await workspaceService.getWorkspaceSnapshot();
  const workspace = await workspaceService.getResumeWorkspace(
    snapshot.reviewQueue[0]!.jobId,
  );
  snapshot.resumeDrafts = [
    { ...workspace.draft, status: "draft", approvedExportId: null },
  ];
  snapshot.reviewQueue[0]!.resumeTailoringMode = "aggressive";
  const block = buildContextBlock({
    context: AssistantContextReferenceSchema.parse({
      screen: "resume_studio",
      focus: { kind: "job", id: workspace.job.id },
      capturedAt: snapshot.generatedAt,
    }),
    resultSets: [],
    snapshot,
    plan: null,
    grants: [],
    pendingQuestions: [],
    now: snapshot.generatedAt,
  });
  expect(block).toContain('"level":"aggressive"');
  expect(block).toContain('"approved":false');
  expect(block).toContain(workspace.draft.updatedAt);
});

it("reports file reading in read_profile before a new import run exists", async () => {
  const { workspaceService } = createWorkspaceServiceHarness();
  const result = await readProfileTool.execute(
    { section: "basics" },
    {
      service: workspaceService,
      session,
      ports: { ...ports, isResumeImportActive: () => true },
    },
  );
  expect(result.data).toMatchObject({
    resumeImport: { active: true, actions: ["wait", "open_profile"] },
  });
});

it("reports the current revision after resume writing and keeps an old approval separate from Original", async () => {
  const { workspaceService } = createWorkspaceServiceHarness();
  const snapshot = await workspaceService.getWorkspaceSnapshot();
  const workspace = await workspaceService.getResumeWorkspace(
    snapshot.reviewQueue[0]!.jobId,
  );
  const item = snapshot.reviewQueue.find(
    (entry) => entry.jobId === workspace.job.id,
  )!;
  snapshot.resumeDrafts = [
    { ...workspace.draft, status: "draft", approvedExportId: null },
  ];
  snapshot.tailoredAssets = [];
  item.resumeApplicationMode = "tailored_per_job";
  item.resumeTailoringMode = "aggressive";
  const run = {
    kind: "resume_generation" as const,
    id: "finished_batch",
    jobIds: [workspace.job.id],
  };
  expect(readRunStatus(snapshot, run).details).toMatchObject({
    resumes: [
      {
        level: "aggressive",
        revision: workspace.draft.updatedAt,
        approved: false,
      },
    ],
  });
  snapshot.resumeDrafts[0]!.status = "approved";
  item.resumeApplicationMode = "original_resume";
  expect(readRunStatus(snapshot, run).details).toMatchObject({
    resumes: [{ mode: "original_resume", level: "original", approved: false }],
  });
});

it("gives the assistant ordinary eligibility wording and the text-size route", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("View → Zoom In");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("Translate browser failures");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Supporting facts are named achievements",
  );
});

it("instructs replies to use your job labels and keep internal ids out", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "never print them in replies, even in parentheses",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("plain second-person words");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("role, place and employer");
});
