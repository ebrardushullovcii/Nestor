import { describe, expect, test, vi } from "vitest";

import type { AiAccessStatus } from "@nestor/ai-providers";
import type { AiAccessWatch } from "./internal/ai-access-watch";
import {
  createAiClient,
  createSeed,
  createProfileServiceHarness,
} from "./profile-service.test-support";
import {
  createStageCandidate,
  createTestBundle,
} from "./resume-import.test-support";

// Synthetic: no real person, service or account.
const RESUME_TEXT = ["Jamie Rivers", "Staff Frontend Engineer"].join("\n");

/** The AI account as the provider leaves it, driven by the test. */
function scriptedAccess() {
  let status: AiAccessStatus = "unknown";
  const changes = new Set<(status: AiAccessStatus) => void>();
  const rechecks: Array<() => boolean> = [];
  const watch: AiAccessWatch = {
    status: () => status,
    onChange: (listener) => {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    onRefused: () => () => undefined,
    onRecheck: (recheck) => {
      rechecks.push(recheck);
      return () => {
        const index = rechecks.indexOf(recheck);
        if (index >= 0) rechecks.splice(index, 1);
      };
    },
    letCallsThrough: vi.fn(),
  };
  return {
    watch,
    waiting: () => rechecks.length,
    set(next: AiAccessStatus) {
      status = next;
      for (const listener of [...changes]) listener(next);
    },
    recheck: () => [...rechecks].some((recheck) => recheck()),
  };
}

/**
 * A new person's first AI call is the resume import. When their account
 * refuses it (wrong key, no credit), the import has to wait on the account
 * like every other piece of AI work, not sit there until they find the
 * right button.
 */
describe("a resume import the AI account refused", () => {
  function setup() {
    const seed = createSeed();
    const access = scriptedAccess();
    let refusing = true;
    let refusingEverything = false;
    const calls: string[] = [];
    const harness = createProfileServiceHarness({
      seed,
      aiAccess: access.watch,
      aiClient: {
        ...createAiClient(),
        extractResumeImportStage(input) {
          calls.push(input.stage);
          if (
            refusing &&
            (refusingEverything || input.stage !== "shared_memory")
          ) {
            access.set("blocked");
            return Promise.reject(
              new Error(
                "Your AI account has run out of credit, so the AI could not do this and nothing was changed.",
              ),
            );
          }
          return Promise.resolve({
            stage: input.stage,
            analysisProviderKind: "openai_compatible" as const,
            analysisProviderLabel: "Test AI",
            candidates:
              input.stage === "identity_summary"
                ? [
                    createStageCandidate({
                      target: {
                        section: "identity",
                        key: "fullName",
                        recordId: null,
                      },
                      label: "Full name",
                      value: "Jamie Rivers",
                      sourceBlockIds: ["page_1_block_1"],
                      confidence: 0.95,
                    }),
                  ]
                : [],
            notes: [],
          });
        },
      },
    });
    const importResume = () =>
      harness.profileWork.runResumeImport({
        baseResume: {
          ...seed.profile.baseResume,
          id: "resume_ai_account",
          fileName: "resume.txt",
          textContent: RESUME_TEXT,
        },
        documentBundle: createTestBundle({ fullText: RESUME_TEXT }),
      });
    return {
      ...harness,
      access,
      calls,
      importResume,
      accept: () => {
        refusing = false;
      },
      refuseEverything: () => {
        refusing = true;
        refusingEverything = true;
      },
    };
  }

  const unreadStages = async (
    repository: ReturnType<typeof setup>["repository"],
  ) =>
    ((await repository.getLatestResumeImportRun())?.timing?.textStages ?? [])
      .filter((stage) => stage.status !== "completed")
      .map((stage) => stage.stage);

  test("reads the missing sections again by itself once the account answers", async () => {
    const { access, accept, calls, importResume, repository } = setup();
    await importResume().catch(() => undefined);
    expect(await unreadStages(repository)).not.toEqual([]);
    expect(access.waiting()).toBe(1);

    accept();
    const before = calls.length;
    access.set("available");
    await vi.waitFor(async () => {
      expect(calls.length).toBeGreaterThan(before);
      expect(await unreadStages(repository)).toEqual([]);
    });
    expect(access.waiting()).toBe(0);
  });

  test("is what Needs you's check starts, so the check does not say nothing waits", async () => {
    const { access, accept, calls, importResume, repository } = setup();
    await importResume().catch(() => undefined);
    accept();
    const before = calls.length;
    expect(access.recheck()).toBe(true);
    await vi.waitFor(async () => {
      expect(calls.length).toBeGreaterThan(before);
      expect(await unreadStages(repository)).toEqual([]);
    });
  });

  test("keeps waiting when the account still refuses, and waits only once", async () => {
    const { access, calls, importResume } = setup();
    await importResume().catch(() => undefined);
    const before = calls.length;
    expect(access.recheck()).toBe(true);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(access.waiting()).toBe(1));
  });

  test("waits for nothing when the account was not what stopped it", async () => {
    const { access, accept, importResume } = setup();
    accept();
    await importResume();
    expect(access.waiting()).toBe(0);
  });

  test("waits too after a read again from Profile that the account refused outright", async () => {
    const {
      access,
      accept,
      refuseEverything,
      calls,
      importResume,
      profileWork,
    } = setup();
    accept();
    await importResume();
    refuseEverything();
    await expect(profileWork.analyzeProfileFromResume()).rejects.toThrow();
    await vi.waitFor(() => expect(access.waiting()).toBe(1));
    accept();
    const before = calls.length;
    access.set("available");
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
  });
});
