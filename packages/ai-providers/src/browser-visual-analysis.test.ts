import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BrowserVisualObservationSetSchema,
  type BrowserVisualAnalysisInput,
} from "@nestor/contracts";
import {
  createDeterministicBrowserVisualAnalysisProvider,
  createOpenAiCompatibleBrowserVisualAnalysisProvider,
} from "./browser-visual-analysis";

function createInput(
  overrides: Partial<BrowserVisualAnalysisInput> = {},
): BrowserVisualAnalysisInput {
  const base: BrowserVisualAnalysisInput = {
    snapshot: {
      id: "visual_snapshot_1",
      capturedAt: "2026-03-20T10:00:00.000Z",
      url: "https://jobs.example.com/apply",
      pageTitle: "Apply",
      mode: "viewport",
      purpose: "apply_checkpoint",
      label: "Apply checkpoint",
      region: null,
      viewport: { x: 0, y: 0, width: 1440, height: 900 },
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,ZmFrZQ==",
      storagePath: null,
      retention: {
        retention: "temporary",
        redactionLevel: "sensitive",
        reason: "Temporary apply visual analysis.",
        expiresAt: null,
      },
      warnings: [],
    },
    context: {
      purpose: "apply_checkpoint",
      taskGoal: "Classify visible apply form state without taking action.",
      pageUrl: "https://jobs.example.com/apply",
      pageTitle: "Apply",
      visibleTextSample:
        "Upload resume. Email is required. Apply button is disabled until required fields are complete.",
      domSignals: ["DOM field snapshot was incomplete."],
      sourceDebug: null,
      apply: {
        jobTitle: "Senior Engineer",
        company: "Example Co",
        checkpointLabel: "Review visible form state",
        recoveryMode: false,
      },
    },
  };

  return {
    ...base,
    ...overrides,
  };
}

function createSourceDebugInput(): BrowserVisualAnalysisInput {
  return createInput({
    snapshot: {
      id: "visual_snapshot_debug_1",
      capturedAt: "2026-03-20T10:00:00.000Z",
      url: "https://jobs.example.com/jobs",
      pageTitle: "Jobs",
      mode: "viewport",
      purpose: "source_debug",
      label: "Source-debug snapshot",
      region: null,
      viewport: { x: 0, y: 0, width: 1440, height: 900 },
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,ZmFrZQ==",
      storagePath: null,
      retention: {
        retention: "temporary",
        redactionLevel: "standard",
        reason: "Source-debug visual evidence.",
        expiresAt: null,
      },
      warnings: [],
    },
    context: {
      purpose: "source_debug",
      taskGoal: "Classify visible page state and identify search controls.",
      pageUrl: "https://jobs.example.com/jobs",
      pageTitle: "Jobs",
      visibleTextSample: "Search jobs. Filter by location.",
      domSignals: [],
      sourceDebug: {
        phase: "site_structure_mapping",
        targetLabel: "Example Co jobs",
        knownFacts: [],
      },
      apply: null,
    },
  });
}

describe("browser visual analysis providers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("deterministic provider returns schema-valid apply observations", async () => {
    const provider = createDeterministicBrowserVisualAnalysisProvider();

    const result = await provider.analyzeBrowserVisualSnapshot(createInput());

    expect(result.providerKind).toBe("deterministic");
    expect(result.fieldControls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("resume"),
        expect.stringContaining("upload"),
      ]),
    );
    expect(result.validationErrors[0]).toContain("required");
    expect(BrowserVisualObservationSetSchema.parse(result).snapshotId).toBe(
      "visual_snapshot_1",
    );
  });

  test("visual schema rejects selectors and action directives", () => {
    expect(() =>
      BrowserVisualObservationSetSchema.parse({
        id: "visual_observation_bad",
        snapshotId: "visual_snapshot_bad",
        observedAt: "2026-03-20T10:00:00.000Z",
        purpose: "apply_checkpoint",
        providerKind: "deterministic",
        providerLabel: "Deterministic browser visual analysis",
        visibleControls: ["Click the #submit button"],
      }),
    ).toThrow(/cannot include selectors|cannot direct browser actions/i);
  });

  test("openai-compatible provider does not upload sensitive image data", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ summary: "Visible form state." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createOpenAiCompatibleBrowserVisualAnalysisProvider({
      apiKey: "test-key",
      baseUrl: "https://vision.example.com/v1",
      model: "vision-test",
    });

    const result = await provider.analyzeBrowserVisualSnapshot(createInput());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.uncertainty).toContain(
      "Sensitive visual snapshot was not uploaded to the configured vision provider; deterministic visual fallback was used.",
    );
  });

  test("openai-compatible provider calls fetch with expected JSON body and merges observation sets", async () => {
    const primarySummary = "Search controls and job cards are visible.";
    const primaryControl =
      "Visible text includes a search control or search area.";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          summary: primarySummary,
          visibleControls: [primaryControl],
          observations: [],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const provider = createOpenAiCompatibleBrowserVisualAnalysisProvider({
      apiKey: "test-key",
      baseUrl: "https://vision.example.com/v1",
      model: "vision-test",
    });

    const input = createSourceDebugInput();
    const result = await provider.analyzeBrowserVisualSnapshot(input);

    // fetch was called exactly once with the correct endpoint
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe("https://vision.example.com/v1/chat/completions");
    expect((calledInit as RequestInit).method).toBe("POST");

    // body includes snapshot id and context
    const body = JSON.parse(
      (calledInit as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toHaveProperty("model", "vision-test");
    const messages = body.messages as { role: string; content: unknown }[];
    const userContent = messages.find((m) => m.role === "user")?.content;
    expect(JSON.stringify(userContent)).toContain("visual_snapshot_debug_1");

    // The merged result remains schema-safe; summary may prefer deterministic wording.
    expect(result.summary && result.summary.length > 0).toBe(true);
    expect(/search|job/i.test(result.summary ?? "")).toBe(true);

    // deterministic fallback observations are merged in from visibleTextSample ("search jobs. filter by location.")
    expect(result.visibleControls.length).toBeGreaterThanOrEqual(2);
  });

  test("normalizes common model aliases and locally supplies observation metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "A cookie dialog blocks the job cards.",
                  observations: [
                    {
                      kind: "control",
                      label: "Cookie choices",
                      description: "Reject all and Accept buttons are visible.",
                      confidence: 0.98,
                      severity: "normal",
                      tags: ["consent"],
                    },
                    {
                      kind: "blocker",
                      label: "Cookie dialog",
                      description: "The dialog obscures the job cards.",
                      confidence: 0.99,
                      severity: "blocking",
                      tags: ["overlay"],
                    },
                  ],
                  reconciliations: [
                    {
                      targetKind: "page-content",
                      status: "partially-obscured",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = createOpenAiCompatibleBrowserVisualAnalysisProvider({
      apiKey: "test-key",
      baseUrl: "https://vision.example.com/v1",
      model: "vision-test",
    });

    const result = await provider.analyzeBrowserVisualSnapshot(
      createSourceDebugInput(),
    );

    expect(result.fallbackUsed, JSON.stringify(result, null, 2)).toBe(false);
    expect(
      result.observations.some(
        (observation) =>
          observation.id.startsWith("visual_observation_") &&
          observation.kind === "visible_control" &&
          observation.severity === "info",
      ),
    ).toBe(true);
    expect(
      result.observations.some(
        (observation) =>
          observation.kind === "blocker" && observation.severity === "critical",
      ),
    ).toBe(true);
    expect(result.reconciliations).toEqual([]);
    expect(result.rejectedOutputReasons).toEqual([]);
  });

  test("openai-compatible provider produces rejectedOutputReasons and deterministic fallback when response violates schema", async () => {
    // Return a visibleControls entry with a CSS selector — violates visual observation rules
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          summary: "Form is visible.",
          visibleControls: ["Click the #submit-button to apply"],
          fieldControls: ["Resume field found."],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const provider = createOpenAiCompatibleBrowserVisualAnalysisProvider({
      apiKey: "test-key",
      baseUrl: "https://vision.example.com/v1",
      model: "vision-test",
    });

    const result = await provider.analyzeBrowserVisualSnapshot(
      createSourceDebugInput(),
    );

    // The schema-violating model value is stripped; deterministic fallback controls may still be merged in.
    expect(
      result.visibleControls.some((value) => /#submit-button/i.test(value)),
    ).toBe(false);
    expect(
      result.visibleControls.some((value) =>
        /search control|filter control/i.test(value),
      ),
    ).toBe(true);
    // The rejectedOutputReasons record what was stripped
    expect(result.rejectedOutputReasons.length).toBeGreaterThan(0);
    expect(
      result.rejectedOutputReasons.every((reason) => reason.trim().length > 0),
    ).toBe(true);
    // Fields that did NOT fail validation are preserved where schema-safe; summary remains meaningful.
    expect(result.summary && result.summary.length > 0).toBe(true);
    expect(Array.isArray(result.fieldControls)).toBe(true);
    // Result still satisfies the schema
    expect(() => BrowserVisualObservationSetSchema.parse(result)).not.toThrow();
  });
});
