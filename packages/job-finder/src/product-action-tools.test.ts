import { describe, expect, test, vi } from "vitest";
import {
  ApplyRunDetailsSchema,
  UserActionRequestSchema,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";

import { createJobFinderProductActionToolRegistry } from "./product-action-tools";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const now = "2026-08-10T12:00:00.000Z";

async function createCapabilityHarness() {
  const harness = createWorkspaceServiceHarness();
  const baseSnapshot = await harness.workspaceService.getWorkspaceSnapshot();
  const request = UserActionRequestSchema.parse({
    id: "action_login_1",
    dedupeKey: "login_1",
    revision: 1,
    kind: "login",
    state: "pending",
    scope: {
      type: "application",
      runId: "run_1",
      jobId: "job_ready",
      source: "target_site",
    },
    verification: {
      type: "source_access",
      blockerFingerprint: "login-blocker",
      expectedOrigin: "https://jobs.example.com/",
    },
    title: "Sign in",
    summary: "Sign in to continue.",
    actionUrl: "https://jobs.example.com/login",
    displayOrigin: "https://jobs.example.com/",
    createdAt: now,
    updatedAt: now,
  });
  const snapshot: JobFinderWorkspaceSnapshot = {
    ...baseSnapshot,
    generatedAt: now,
    userActionRequests: [request],
  };
  const openedSnapshot: JobFinderWorkspaceSnapshot = {
    ...snapshot,
    userActionRequests: [
      { ...request, state: "page_opened" as const, openedAt: now },
    ],
  };
  const applyDetails = ApplyRunDetailsSchema.parse({
    run: {
      id: "run_1",
      createdAt: now,
      updatedAt: now,
      summary: "Prepared application",
      detail: "Stopped safely before final submit.",
    },
  });
  const capabilities = {
    getWorkspaceSnapshot: vi.fn(() => Promise.resolve(snapshot)),
    getApplyRunDetails: vi.fn(() => Promise.resolve(applyDetails)),
    proposeProfileCopilotChange: vi.fn(() => Promise.resolve(snapshot)),
    queueJobForReview: vi.fn(() => Promise.resolve(snapshot)),
    dismissDiscoveryJob: vi.fn(() => Promise.resolve(snapshot)),
    restoreDismissedDiscoveryJob: vi.fn(() => Promise.resolve(snapshot)),
    performUserAction: vi.fn(() => Promise.resolve(openedSnapshot)),
  };
  const registry = createJobFinderProductActionToolRegistry(capabilities, {
    now: () => now,
    createReceiptId: () => "receipt_1",
  });
  return { ...harness, applyDetails, capabilities, registry };
}

describe("Job Finder product action tools", () => {
  test("publishes only the bounded schema-strict product actions", async () => {
    const { registry } = await createCapabilityHarness();

    expect(registry.definitions.map((definition) => definition.name)).toEqual([
      "get_workspace_summary",
      "list_needs_you",
      "get_apply_run_details",
      "propose_profile_change",
      "shortlist_job",
      "dismiss_job",
      "restore_job",
      "open_user_action",
    ]);
    expect(
      registry.definitions.every(
        (definition) =>
          definition.inputJsonSchema.additionalProperties === false,
      ),
    ).toBe(true);
    expect(
      registry.definitions.map((definition) => definition.name),
    ).not.toEqual(
      expect.arrayContaining([
        "final_submit",
        "create_account",
        "navigate",
        "read_file",
      ]),
    );
  });

  test("executes bounded reads with typed receipts and actual capability calls", async () => {
    const { applyDetails, capabilities, registry } =
      await createCapabilityHarness();

    const summary = await registry.execute("get_workspace_summary", {});
    expect(summary).toMatchObject({
      ok: true,
      tool: "get_workspace_summary",
      receipt: {
        receiptId: "receipt_1",
        revision: { kind: "snapshot_generated_at", value: now },
      },
      data: { profileReady: true, unresolvedUserActions: 1 },
    });

    const needsYou = await registry.execute("list_needs_you", {});
    expect(needsYou).toMatchObject({
      ok: true,
      receipt: { nextRoute: "/job-finder/actions" },
      data: { requests: [{ id: "action_login_1" }] },
    });

    const details = await registry.execute("get_apply_run_details", {
      runId: "run_1",
      jobId: "job_ready",
    });
    expect(details).toMatchObject({ ok: true, data: applyDetails });
    expect(capabilities.getApplyRunDetails).toHaveBeenCalledWith(
      "run_1",
      "job_ready",
    );
  });

  test("requires confirmation before scoped mutations and calls each exact service capability", async () => {
    const { capabilities, registry } = await createCapabilityHarness();

    await expect(
      registry.execute("shortlist_job", { jobId: "job_ready" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "confirmation_required" },
    });
    expect(capabilities.queueJobForReview).not.toHaveBeenCalled();

    expect(
      await registry.execute(
        "shortlist_job",
        { jobId: "job_ready" },
        { confirmed: true },
      ),
    ).toMatchObject({ ok: true, data: { status: "shortlisted" } });
    expect(capabilities.queueJobForReview).toHaveBeenCalledWith("job_ready");

    await registry.execute(
      "dismiss_job",
      { jobId: "job_ready", reasons: ["role"] },
      { confirmed: true },
    );
    expect(capabilities.dismissDiscoveryJob).toHaveBeenCalledWith({
      jobId: "job_ready",
      reasons: ["role"],
    });

    await registry.execute("restore_job", { jobId: "job_ready" });
    expect(capabilities.restoreDismissedDiscoveryJob).toHaveBeenCalledWith(
      "job_ready",
    );
  });

  test("forwards an explicit closed conflict without calling the shortlist mutation", async () => {
    const { capabilities, registry } = await createCapabilityHarness();
    const snapshot = await capabilities.getWorkspaceSnapshot();
    capabilities.getWorkspaceSnapshot.mockResolvedValue({
      ...snapshot,
      discoveryJobs: snapshot.discoveryJobs.map((job) =>
        job.id === "job_ready"
          ? {
              ...job,
              listingActivity: {
                status: "closed" as const,
                observedAt: now,
                signalId: "signal_closed",
                provenance: "provider" as const,
                explanation: "The provider explicitly closed the listing.",
                detail: null,
                confidence: 1,
              },
            }
          : job,
      ),
    });

    await expect(
      registry.execute(
        "shortlist_job",
        { jobId: "job_ready" },
        { confirmed: true },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        message: "This listing is explicitly closed and cannot be shortlisted.",
        retryable: false,
      },
    });
    expect(capabilities.queueJobForReview).not.toHaveBeenCalled();
  });

  test.each(["stale", "inactive"] as const)(
    "allows %s listing activity through the product-action shortlist gate",
    async (status) => {
      const { capabilities, registry } = await createCapabilityHarness();
      const snapshot = await capabilities.getWorkspaceSnapshot();
      capabilities.getWorkspaceSnapshot.mockResolvedValue({
        ...snapshot,
        discoveryJobs: snapshot.discoveryJobs.map((job) =>
          job.id === "job_ready"
            ? {
                ...job,
                listingActivity:
                  status === "stale"
                    ? {
                        status,
                        observedAt: now,
                        signalId: "signal_stale",
                        provenance: "browser" as const,
                        explanation: "The listing may be stale.",
                        detail: null,
                        confidence: 0.8,
                      }
                    : {
                        status,
                        observedAt: now,
                        ledgerEntryId: "ledger_inactive",
                        provenance: "discovery_ledger" as const,
                        explanation: "The latest inventory did not include it.",
                      },
              }
            : job,
        ),
      });

      await expect(
        registry.execute(
          "shortlist_job",
          { jobId: "job_ready" },
          { confirmed: true },
        ),
      ).resolves.toMatchObject({ ok: true });
      expect(capabilities.queueJobForReview).toHaveBeenCalledWith("job_ready");
    },
  );

  test("opens only the existing scoped user action with all authority flags false", async () => {
    const { capabilities, registry } = await createCapabilityHarness();

    const result = await registry.execute(
      "open_user_action",
      { requestId: "action_login_1" },
      { confirmed: true },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { requestId: "action_login_1", state: "page_opened" },
    });
    expect(capabilities.performUserAction).toHaveBeenCalledWith({
      action: "open_page",
      requestId: "action_login_1",
      commandId: "product_action_open_action_login_1_1",
      expectedRevision: 1,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
  });

  test("routes natural profile requests through proposal-only service behavior", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: { ...seed.profile, yearsExperience: 6 },
      },
    });
    const registry = createJobFinderProductActionToolRegistry(
      workspaceService,
      {
        now: () => now,
        createReceiptId: () => "receipt_proposal",
      },
    );

    const result = await registry.execute("propose_profile_change", {
      request: "make my experience 7 years",
      context: { surface: "profile", section: "experience" },
    });
    const after = await workspaceService.getWorkspaceSnapshot();

    expect(result).toMatchObject({
      ok: true,
      tool: "propose_profile_change",
      receipt: { nextRoute: "/job-finder/profile" },
    });
    if (result.ok && result.tool === "propose_profile_change") {
      expect(result.data.patchGroups.length).toBeGreaterThan(0);
      expect(
        result.data.patchGroups.every(
          (patchGroup) => patchGroup.applyMode === "needs_review",
        ),
      ).toBe(true);
      expect(result.data.content).toContain("Nothing changed yet");
      expect(result.data.content.toLowerCase()).not.toContain("i applied");
    }
    expect(after.profile.yearsExperience).toBe(6);
    expect(after.profileRevisions).toEqual([]);
  });

  test("returns stable safe errors without leaking service or validation details", async () => {
    const { capabilities, registry } = await createCapabilityHarness();

    expect(await registry.execute("delete_everything", {})).toEqual({
      ok: false,
      tool: null,
      error: {
        code: "unknown_tool",
        message: "This Job Finder product action is not available.",
        retryable: false,
      },
    });
    expect(
      await registry.execute("dismiss_job", {
        jobId: "job_ready",
        reasons: ["not-a-reason"],
        rawPath: "C:\\private\\resume.pdf",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "The product action input is invalid.",
      },
    });

    capabilities.restoreDismissedDiscoveryJob.mockRejectedValueOnce(
      new Error("C:\\private\\workspace.sqlite failed unexpectedly"),
    );
    const failed = await registry.execute("restore_job", {
      jobId: "job_ready",
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "execution_failed" },
    });
    expect(JSON.stringify(failed)).not.toContain("C:\\private");
  });
});
