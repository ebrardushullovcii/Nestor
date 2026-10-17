// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { JobFinderPerformanceSnapshotSchema } from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsPerformanceEvidence } from "./settings-performance-evidence";

const generatedAt = "2026-08-09T10:00:00.000Z";

describe("SettingsPerformanceEvidence", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows measured zero, partial, and unavailable timings as distinct states", async () => {
    const snapshot = JobFinderPerformanceSnapshotSchema.parse({
      generatedAt,
      waitingFormMemory: {
        recordedAt: generatedAt,
        budgetBytes: 805306368,
        totalBytes: 104857600,
        measurementComplete: false,
        overBudget: false,
        tabs: [
          {
            tabId: "synthetic",
            processId: 100,
            processBytes: 104857600,
            backgroundThrottled: true,
          },
          {
            tabId: "unmeasured",
            processId: 0,
            processBytes: null,
            backgroundThrottled: true,
          },
        ],
      },
      latestDiscoveryRun: null,
      latestSourceDebugRun: null,
      evidence: [
        {
          area: "resume_import",
          measurementStatus: "available",
          durationMs: 0,
          recordedAt: generatedAt,
          method: "resume_import_run",
          sampleCount: 1,
          budgetStatus: "not_evaluated",
          stageDurations: [
            { id: "resume_import.literal_extraction", durationMs: 0 },
          ],
        },
        {
          area: "application_preparation",
          agentTiming: {
            totalMs: 4200,
            modelMs: 3000,
            modelTurns: 3,
            auxiliaryModelMs: 400,
            auxiliaryModelCalls: 6,
            questionReadingCalls: 5,
            questionReadingMs: 350,
            answerCheckCalls: 1,
            answerCheckMs: 50,
            toolMs: 1000,
            pageReadMs: 300,
            pageReads: 12,
            writeMs: 100,
            uploadMs: 50,
            longestSteps: [{ toolName: "fill_fields", durationMs: 600 }],
            requests: [
              {
                turn: 1,
                historyChars: 15000,
                observationChars: 2000,
                fieldsFilled: 4,
                storedFactFills: 3,
                answersWaited: 1,
                stepsAdvanced: 1,
                uploadsAttached: 1,
              },
              {
                turn: 2,
                historyChars: 15000,
                observationChars: 2000,
                fieldsFilled: 0,
                storedFactFills: 0,
                answersWaited: 0,
                stepsAdvanced: 0,
                uploadsAttached: 0,
              },
              { turn: 3, historyChars: 15000, observationChars: 2000 },
            ],
          },
          measurementStatus: "partial",
          durationMs: null,
          recordedAt: generatedAt,
          method: "application_attempt",
          sampleCount: 1,
          budgetStatus: "not_evaluated",
          stageDurations: [
            {
              id: "application_preparation.form_preparation",
              durationMs: 2_500,
            },
          ],
          unavailableReason: "total_not_recorded",
        },
        {
          area: "renderer_commit",
          measurementStatus: "unavailable",
          durationMs: null,
          recordedAt: null,
          method: "none",
          sampleCount: 0,
          budgetStatus: "unavailable",
          unavailableReason: "no_recorded_measurement",
        },
      ],
    });
    const getPerformanceSnapshot = vi.fn().mockResolvedValue(snapshot);
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { jobFinder: { getPerformanceSnapshot } },
    });
    const { getAllByText, getByRole, getByText } = render(
      <SettingsPerformanceEvidence />,
    );

    fireEvent.click(getByRole("button", { name: "Load performance evidence" }));

    await waitFor(() => expect(getPerformanceSnapshot).toHaveBeenCalledOnce());
    expect(getByText("Waiting forms memory")).toBeTruthy();
    expect(getByText(/100.0 MiB of 768 MiB budget/u)).toBeTruthy();
    expect(getByText(/Form 1: 100.0 MiB/u)).toBeTruthy();
    expect(
      getByText(/Some process memory could not be measured/u),
    ).toBeTruthy();
    expect(getByText("Resume import")).toBeTruthy();
    expect(getAllByText("0 ms").length).toBeGreaterThanOrEqual(1);
    expect(getByText("Application preparation")).toBeTruthy();
    expect(getByText("Form preparation details")).toBeTruthy();
    expect(getByText("Question reading")).toBeTruthy();
    expect(getByText("5 calls · 350 ms")).toBeTruthy();
    expect(getByText("Answer checks")).toBeTruthy();
    expect(getByText("1 call · 50 ms")).toBeTruthy();
    expect(getByText("Slowest steps")).toBeTruthy();
    expect(getByText("3 turns · 3.0 s")).toBeTruthy();
    expect(getByText("12 reads · 300 ms")).toBeTruthy();
    expect(
      getByText("Entering answers and checking facts: 600 ms"),
    ).toBeTruthy();
    expect(getByText(/15000 \(page update 2000\)/u)).toBeTruthy();
    expect(
      getByText(
        /Turn 1: 4 fields filled; 3 from stored facts; 1 waited for a check; 1 step advanced; 1 file attached/u,
      ),
    ).toBeTruthy();
    expect(
      getByText(
        /Turn 2: 0 fields filled; 0 from stored facts; 0 waited for a check; 0 steps advanced; 0 files attached/u,
      ),
    ).toBeTruthy();
    expect(
      getByText(
        /Turn 3: fields filled not recorded; stored facts not recorded; answer checks not recorded; steps advanced not recorded; uploads not recorded/u,
      ),
    ).toBeTruthy();
    expect(getByText("Total not recorded")).toBeTruthy();
    expect(getByText("Renderer commit")).toBeTruthy();
    expect(getByText("Not recorded")).toBeTruthy();
    expect(getAllByText("No stable budget yet")).toHaveLength(2);
    expect(
      getAllByText("Stage details")[0]
        ?.closest("details")
        ?.hasAttribute("open"),
    ).toBe(false);
  });
});

it.each([0, 1, 2])(
  "uses the right waiting form count for %s forms",
  async (count) => {
    const getPerformanceSnapshot = vi.fn().mockResolvedValue(
      JobFinderPerformanceSnapshotSchema.parse({
        generatedAt,
        waitingFormMemory: {
          recordedAt: generatedAt,
          budgetBytes: 805306368,
          totalBytes: 0,
          measurementComplete: true,
          overBudget: false,
          tabs: Array.from({ length: count }, (_, index) => ({
            tabId: `synthetic_${index}`,
            processId: index + 1,
            processBytes: 0,
            backgroundThrottled: true,
          })),
        },
        latestDiscoveryRun: null,
        latestSourceDebugRun: null,
        evidence: [],
      }),
    );
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { jobFinder: { getPerformanceSnapshot } },
    });
    const view = render(<SettingsPerformanceEvidence />);
    fireEvent.click(
      view.getByRole("button", { name: "Load performance evidence" }),
    );
    await waitFor(() =>
      expect(
        view.getByText(
          `0.0 MiB of 768 MiB budget · ${count} ${count === 1 ? "form" : "forms"}`,
        ),
      ).toBeTruthy(),
    );
    cleanup();
  },
);
