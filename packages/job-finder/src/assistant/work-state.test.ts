import { assistantTestReads } from "./store-reads.test-support";
import { ResumeImportRunSchema } from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../workspace-service.test-support";
import type { AssistantHostPorts } from "./ports";
import { ASSISTANT_SYSTEM_PROMPT } from "./prompt";
import type { AssistantTurnSession } from "./tool-kit";
import { getWorkspaceSummaryTool } from "./tools/workspace-tools";
import { readProfileTool } from "./tools/profile-tools";
import { pauseActivityTool } from "./tools/settings-tools";
import { readAssistantWorkState } from "./work-state";

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
        {
          service: workspaceService,
          session,
          ports: {
            ...ports,
            ...assistantTestReads(workspaceService),
            readPersonalState: () =>
              Promise.resolve({ ...snapshot, enabledSiteCount: 1 }),
          },
        },
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
    {
      service: workspaceService,
      session,
      ports: {
        ...ports,
        ...assistantTestReads(workspaceService),
        readPersonalState: () =>
          Promise.resolve({ ...snapshot, enabledSiteCount: 1 }),
      },
    },
  );
  expect(paused.summary).toContain(
    "Resume import is still running; it was not stopped.",
  );
});

it("reports file reading in read_profile before a new import run exists", async () => {
  const { workspaceService } = createWorkspaceServiceHarness();
  const result = await readProfileTool.execute(
    { section: "basics" },
    {
      service: workspaceService,
      session,
      ports: {
        ...ports,
        ...assistantTestReads(workspaceService),
        isResumeImportActive: () => true,
      },
    },
  );
  expect(result.data).toMatchObject({
    resumeImport: { active: true, actions: ["wait", "open_profile"] },
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
