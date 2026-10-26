import { assistantTestReads } from "../store-reads.test-support";
import { randomUUID } from "node:crypto";
import { type JobFinderWorkspaceSnapshot } from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import type { AssistantHostPorts } from "../ports";
import { ASSISTANT_SYSTEM_PROMPT, buildContextBlock } from "../prompt";
import type { AssistantTurnSession } from "../tool-kit";
import { getWorkspaceSummaryTool } from "./workspace-tools";

function world() {
  const { workspaceService: service } = createWorkspaceServiceHarness();
  const session = {
    assertCurrent: () => undefined,
    now: () => "2026-10-05T12:00:00.000Z",
    createId: () => randomUUID(),
    createResultSet: (
      input: Parameters<AssistantTurnSession["createResultSet"]>[0],
    ) => Promise.resolve({ ...input, id: randomUUID() }),
    recordChange: vi.fn(
      (change: Parameters<AssistantTurnSession["recordChange"]>[0]) =>
        Promise.resolve({
          receipt: { id: randomUUID() },
          part: { type: "notice", kind: "info", text: change.summary },
        }),
    ),
  } as unknown as AssistantTurnSession;
  const ports = {
    ...assistantTestReads(service),
    publishWorkspaceUpdate: vi.fn(),
  } as unknown as AssistantHostPorts;
  return { service, session, ports };
}

function context(snapshot: JobFinderWorkspaceSnapshot) {
  return buildContextBlock({
    snapshot,
    context: null,
    resultSets: [],
    plan: null,
    grants: [],
    pendingQuestions: [],
    now: "2026-10-05T12:00:00.000Z",
  });
}

it("R3-120 tells the model that scans have no readable text and extraction can fail", async () => {
  const { importResumeTool, readDocumentTool } =
    await import("./profile-tools");
  for (const copy of [
    ASSISTANT_SYSTEM_PROMPT,
    importResumeTool.description,
    readDocumentTool.description,
  ]) {
    expect(copy.toLowerCase()).toContain(
      "scanned image pdfs have no readable text",
    );
    expect(copy).toContain("Markdown");
  }
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "do not promise that a scan is fine",
  );
  expect(importResumeTool.description).toContain("success is not guaranteed");
});

it("R3-128 keeps a complete manual profile search-ready without an imported resume", async () => {
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  snapshot.browserSession.driver = "uninitialized";
  snapshot.browserSession.status = "unknown";
  snapshot.profile.baseResume.fileName = "";
  snapshot.profile.baseResume.storagePath = null;
  snapshot.profile.fullName = "Synthetic Manual Candidate";
  snapshot.profile.email = "manual@example.test";
  vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(snapshot);
  expect((await getWorkspaceSummaryTool.execute({}, ctx)).data).toMatchObject({
    search: {
      canStartSearch: true,
      resumeRequired: false,
      missingRequirements: [],
    },
  });
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Start manually is a complete route",
  );
});

it("R3-110 treats capability reporting as a write and excludes advice-only requests", async () => {
  const { reportMissingCapabilityTool } = await import("./workspace-tools");
  expect(reportMissingCapabilityTool.effect).toBe("local_write");
  expect(reportMissingCapabilityTool.description).toContain(
    "Never call for advice-only questions",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "do not record a capability report",
  );
});

it("R3-122 reports the jobs actually found without guaranteeing the requested count", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "including fewer than requested or none",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "never fill a shortfall with unsuitable jobs",
  );
});

it("R3-157 treats keeping the person's words as Original and asks before allowing Light edits", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("mean Original, not Light");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("ask before selecting Light");
});

it("R3-125 gives source explanations and the current sending boundary before requesting a URL", async () => {
  const ctx = world();
  const snapshot = await ctx.service.getWorkspaceSnapshot();
  snapshot.settings.applicationAutomationMode = "autonomous_submit";
  expect(context(snapshot)).toContain(
    "Current saved sending mode: autonomous_submit",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Sources are the job pages Job Finder searches",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Answer every question in a mixed request before asking",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "An employer form may save entered answers",
  );
});

it("R3-214 describes a combined Undo for edits sharing one receipt", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("share one combined Undo action");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Never promise separate Undo buttons unless there are separate change receipts",
  );
});

it("does not direct a letter to the retired Application documents editor", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("Read get_application_details");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "old Application documents editor and export flow is gone",
  );
});

it("R3-061 exposes remote-country facts and keeps Americas separate from sponsorship", async () => {
  const { jobEvidence } = await import("./format");
  const ctx = world();
  const job = (await ctx.service.getWorkspaceSnapshot()).discoveryJobs[0]!;
  job.location = "Remote Americas";
  job.screeningHints.remoteGeographies = ["Americas"];
  job.screeningHints.sponsorshipText = "No sponsorship statement published";
  expect(jobEvidence(job)).toMatchObject({
    location: "Remote Americas",
    remoteGeographies: ["Americas"],
    sponsorshipText: "No sponsorship statement published",
  });
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "'Remote Americas' includes Canada and the US geographically",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "say when Canada hiring is unconfirmed",
  );
});

it("requires a text answer first and supporting cards only", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "answer the question in text first",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Do not reply with only a card or a question back",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("finish with a text answer");
});
