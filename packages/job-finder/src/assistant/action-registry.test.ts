import { describe, expect, it, vi } from "vitest";

import { createWorkspaceServiceHarness } from "../workspace-service.test-support";
import type { JobFinderWorkspaceService } from "../internal/workspace-service-contracts";
import {
  executeJobFinderAction,
  JOB_FINDER_ACTIONS,
  type JobFinderActionId,
} from "./action-registry";
import type { AssistantHostPorts } from "./ports";
import type { AssistantToolContext, AssistantTurnSession } from "./tool-kit";
import { buildAssistantToolCatalog } from "./tools";
import { executeRegisteredAssistantAction } from "./tools/registered-action-tools";

const at = "2026-10-24T01:00:00.000Z";

describe("registered user actions", () => {
  const catalog = buildAssistantToolCatalog({
    mode: "flat",
    browserAvailable: true,
  });
  it.each(Object.entries(JOB_FINDER_ACTIONS))(
    "%s has a validated input and a reachable tool",
    (_name, action) => {
      expect(action.input.safeParse(null).success).toBe(false);
      expect(["read", "local", "confirm", "application"]).toContain(
        action.safety,
      );
      const tool =
        action.tool?.name ?? `action_${_name.replaceAll(/[:-]/gu, "_")}`;
      expect(
        catalog.find((entry) => entry.name === tool),
        tool,
      ).toBeDefined();
    },
  );

  const calls: [
    JobFinderActionId,
    unknown,
    keyof JobFinderWorkspaceService,
    unknown[],
  ][] = [
    [
      "return-application-to-shortlist",
      { applicationRecordId: "a" },
      "returnApplicationToShortlist",
      ["a"],
    ],
    [
      "undo-return-application-to-shortlist",
      { jobId: "j" },
      "undoReturnApplicationToShortlist",
      ["j"],
    ],
    ["clear-resume-approval", { jobId: "j" }, "clearResumeApproval", ["j"]],
    [
      "clear-resume-approval",
      { jobId: "j", restoreStatus: "needs_review" },
      "clearResumeApproval",
      ["j", { restoreStatus: "needs_review" }],
    ],
    ["judge-unjudged-jobs", {}, "judgeUnjudgedJobs", []],
    ["cancel-source-debug", { runId: "r" }, "cancelSourceDebug", ["r"]],
    ["get-source-debug-run", { runId: "r" }, "getSourceDebugRun", ["r"]],
    [
      "get-source-debug-run-details",
      { runId: "r" },
      "getSourceDebugRunDetails",
      ["r"],
    ],
    ["list-source-debug-runs", { targetId: "t" }, "listSourceDebugRuns", ["t"]],
    [
      "accept-source-instruction-draft",
      { targetId: "t", instructionId: "i" },
      "acceptSourceInstructionDraft",
      ["t", "i"],
    ],
    [
      "verify-source-instructions",
      { targetId: "t", instructionId: "i" },
      "verifySourceInstructions",
      ["t", "i"],
    ],
    [
      "delete-campaign",
      { campaignId: "c" },
      "deleteCampaign",
      [{ campaignId: "c" }],
    ],
    [
      "delete-campaign-rule",
      { campaignId: "c", ruleId: "r" },
      "deleteCampaignRule",
      [{ campaignId: "c", ruleId: "r" }],
    ],
    [
      "toggle-campaign-rule",
      { campaignId: "c", ruleId: "r", enabled: false },
      "toggleCampaignRule",
      [{ campaignId: "c", ruleId: "r", enabled: false }],
    ],
    [
      "regenerate-resume-section",
      { jobId: "j", sectionId: "s" },
      "regenerateResumeSection",
      ["j", "s"],
    ],
    [
      "restore-resume-draft-revision",
      { jobId: "j", revisionId: "v" },
      "restoreResumeDraftRevision",
      ["j", "v"],
    ],
    [
      "run-application-no-response-automation",
      {},
      "runApplicationNoResponseAutomation",
      [],
    ],
    [
      "snooze-grouped-decision",
      { decisionId: "d", expectedRevision: 1, until: at },
      "snoozeGroupedDecision",
      [{ decisionId: "d", expectedRevision: 1, until: at, reason: null }],
    ],
  ];
  it.each(calls)(
    "%s calls the UI's service method with the exact contract",
    async (name, input, method, args) => {
      const methodCall = vi.fn().mockResolvedValue(true);
      const service = new Proxy({} as JobFinderWorkspaceService, {
        get: (_target, key) => (key === method ? methodCall : undefined),
      });
      await executeJobFinderAction(name, input, { service });
      expect(methodCall).toHaveBeenCalledExactlyOnceWith(...args);
    },
  );

  it.each([
    ["candidate-assets:list", {}],
    ["candidate-assets:delete", { assetId: "file" }],
    [
      "candidate-assets:restore",
      { assetId: "file", retention: "until_deleted" },
    ],
    ["control-apply-queue", { action: "pause" }],
    ["remove-from-apply-queue", { jobIds: ["j"] }],
    ["approve-resumes", { jobIds: ["j"] }],
    ["get-application-page-states", { resultIds: ["r"] }],
    ["reopen-application-page", { resultId: "r" }],
    ["list-application-documents", { jobId: "j", applicationRecordId: "a" }],
    [
      "propose-application-document",
      { kind: "cover_letter", jobId: "j", applicationRecordId: "a" },
    ],
    [
      "edit-application-document",
      { documentId: "d", expectedRevision: 2, content: "Revised text" },
    ],
    ["approve-application-document", { documentId: "d", expectedRevision: 2 }],
    ["export-application-document", { documentId: "d", expectedRevision: 2 }],
  ] satisfies [JobFinderActionId, unknown][])(
    "%s uses the shared desktop operation",
    async (name, input) => {
      const host = vi.fn().mockResolvedValue({ ok: true });
      await executeJobFinderAction(name, input, {
        service: {} as JobFinderWorkspaceService,
        host,
      });
      expect(host).toHaveBeenCalledExactlyOnceWith(
        name,
        JOB_FINDER_ACTIONS[name].input.parse(input),
      );
    },
  );

  it("edits and removes only the named source, retaining unrelated preferences", async () => {
    const { workspaceService: service } = createWorkspaceServiceHarness();
    const before = await service.getWorkspaceSnapshot();
    const source = before.searchPreferences.discovery.targets[0]!;
    await executeJobFinderAction(
      "edit-source",
      {
        sourceId: source.id,
        changes: { label: "Renamed source", enabled: false },
      },
      { service },
    );
    const after = await service.getWorkspaceSnapshot();
    expect(after.searchPreferences.discovery.targets[0]).toMatchObject({
      id: source.id,
      label: "Renamed source",
      enabled: false,
      startingUrl: source.startingUrl,
    });
    expect(after.searchPreferences.targetRoles).toEqual(
      before.searchPreferences.targetRoles,
    );
    await executeJobFinderAction(
      "remove-source",
      { sourceId: source.id },
      { service },
    );
    expect(
      (
        await service.getWorkspaceSnapshot()
      ).searchPreferences.discovery.targets.some(
        (entry) => entry.id === source.id,
      ),
    ).toBe(false);
  });

  it("applies an explicitly requested reversible resume approval without another confirmation", async () => {
    const executeAction = vi.fn().mockResolvedValue(true);
    const createProposal = vi.fn();
    const context = { service: {}, ports: { executeAction, publishWorkspaceUpdate: vi.fn() }, session: { assertCurrent: vi.fn(), createProposal } } as unknown as AssistantToolContext;
    await executeRegisteredAssistantAction({ actionId: "approve-resumes", input: { jobIds: ["j"] } }, context);
    expect(executeAction).toHaveBeenCalledExactlyOnceWith("approve-resumes", { jobIds: ["j"] });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("proposes deletion, revalidates on acceptance and never opens an application bypass", async () => {
    const createProposal = vi
      .fn()
      .mockResolvedValue({ part: { type: "proposal" } });
    const executeAction = vi.fn().mockResolvedValue({ asset: { id: "f" } });
    const context: AssistantToolContext = {
      service: {} as JobFinderWorkspaceService,
      ports: {
        executeAction,
        publishWorkspaceUpdate: vi.fn(),
      } as unknown as AssistantHostPorts,
      session: {
        assertCurrent: vi.fn(),
        createId: () => "p",
        createProposal,
      } as unknown as AssistantTurnSession,
    };
    const payload = {
      actionId: "candidate-assets:delete",
      input: { assetId: "f" },
    };
    await executeRegisteredAssistantAction(payload, context);
    expect(executeAction).not.toHaveBeenCalled();
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "job_finder_action",
        items: [expect.objectContaining({ payload })],
      }),
    );
    await executeRegisteredAssistantAction(payload, context, true);
    expect(executeAction).toHaveBeenCalledExactlyOnceWith(
      "candidate-assets:delete",
      { assetId: "f" },
    );
    await expect(
      executeRegisteredAssistantAction(
        { actionId: "start-apply-queue", input: { jobIds: ["j"] } },
        context,
        true,
      ),
    ).rejects.toThrow("grants");
    await expect(
      executeRegisteredAssistantAction(
        { actionId: "save-profile", input: {} },
        context,
        true,
      ),
    ).rejects.toThrow("safeguards");
  });
});
