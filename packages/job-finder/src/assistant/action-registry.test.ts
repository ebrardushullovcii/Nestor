import { describe, expect, it, vi } from "vitest";
import type { JobFinderWorkspaceService } from "../internal/workspace-service-contracts";
import type { JobFinderActionId } from "./action-registry";
import { executeJobFinderAction, JOB_FINDER_ACTIONS } from "./action-registry";
import type { AssistantHostPorts } from "./ports";
import type { AssistantToolContext, AssistantTurnSession } from "./tool-kit";
import { buildAssistantToolCatalog } from "./tools";
import { executeRegisteredAssistantAction } from "./tools/registered-action-tools";


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
        { actionId: "apply-jobs", input: { selection: { ids: [1] } } },
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
