import { resetJobStore } from "@nestor/db/job-store";
import { describe, expect, test, vi } from "vitest";

import { createTestBundle } from "./resume-import.test-support";
import {
  createAiClient,
  createProfileServiceHarness,
  createSeed,
} from "./profile-service.test-support";

describe("stopping profile work, as Reset everything does", () => {
  test("cancels a running resume import and nothing it read comes back after the store is cleared", async () => {
    const ai = createAiClient();
    // The model answers only when this test says so, after the reset.
    let answerModel!: () => void;
    const modelAnswered = new Promise<void>((resolve) => {
      answerModel = resolve;
    });
    const stageCalls = vi.fn();
    const seed = createSeed();
    const harness = createProfileServiceHarness({
      seed,
      aiClient: {
        ...ai,
        getStatus: () => ({ ...ai.getStatus(), kind: "openai_compatible" }),
        extractResumeImportStage: async (input) => {
          stageCalls();
          await modelAnswered;
          return ai.extractResumeImportStage(input);
        },
      },
    });
    await harness.seeded;
    const text = "Alex Vanguard\nSenior systems designer";
    const importing = harness.service.runResumeImport({
      baseResume: { ...seed.profile.baseResume, textContent: text },
      documentBundle: createTestBundle({ fullText: text }),
    });
    void importing.catch(() => undefined);
    await vi.waitFor(() => expect(stageCalls).toHaveBeenCalled());

    await harness.service.stop();
    await expect(importing).rejects.toThrow();
    resetJobStore(harness.store);

    answerModel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await harness.repository.listResumeImportRuns()).toEqual([]);
    expect(await harness.repository.listResumeImportDocumentBundles()).toEqual(
      [],
    );
    expect((await harness.repository.getProfile()).baseResume.textContent).toBe(
      null,
    );
    // A stopped service takes no new import.
    await expect(
      harness.service.runResumeImport({
        baseResume: { ...seed.profile.baseResume, textContent: text },
        documentBundle: createTestBundle({ fullText: text }),
      }),
    ).rejects.toThrow("Job Finder is closing.");
  });

  test("Check site lets a browser the person closed open again", async () => {
    const onExplicitUserStart = vi.fn();
    const harness = createProfileServiceHarness({ onExplicitUserStart });
    await harness.seeded;
    await harness.service.runSourceDebug("1").catch(() => undefined);
    expect(onExplicitUserStart).toHaveBeenCalledOnce();
  });
});
