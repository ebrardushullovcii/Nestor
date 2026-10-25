import { JobFinderIntelligenceStateSchema } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import type * as HandoffModule from "./apply-submission-handoff";

const submitPreparedApplication =
  vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("./apply-submission-handoff", async (importOriginal) => ({
  ...(await importOriginal<typeof HandoffModule>()),
  submitPreparedApplication: (...args: unknown[]) =>
    submitPreparedApplication(...args),
}));

const { sendPreparedApplicationIfAllowed } =
  await import("./apply-submission-run-step");

function sendInput(
  releaseApplicationPageBinding: ReturnType<typeof vi.fn>,
  mode = "autonomous_submit",
  confirmedByPerson = false,
) {
  const envelope = {
    id: "envelope_1",
    mode: "autonomous_submit",
    status: "active",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scope: { campaignId: null, jobIds: ["job_1"] },
    allowedResumeSha256: ["a".repeat(64)],
    decisionPolicy: {},
  };
  return {
    ctx: {
      repository: {
        getIntelligenceState: () =>
          Promise.resolve(JobFinderIntelligenceStateSchema.parse({})),
        listApplicationRecords: () => Promise.resolve([]),
        readSavedJobsProjection: () => Promise.resolve([]),
        listApplyJobResults: () => Promise.resolve([]),
        listApplyRuns: () => Promise.resolve([]),
        getSettings: () => Promise.resolve({ applicationAutomationMode: mode }),
        listApplicationAuthorityEnvelopes: () => Promise.resolve([envelope]),
      },
      browserRuntime: {
        observeApplicationForm: vi.fn(),
        executeExactlyOneFinalAction: vi.fn(),
        hasApplicationPageBinding: vi.fn(() => Promise.resolve(true)),
        releaseApplicationPageBinding,
      },
    },
    handoff: { status: "send_now", confirmedByPerson },
    envelope,
    source: { id: "source_1" },
    lineage: { jobId: "job_1", resultId: "result_1" },
    resumeArtifact: { filePath: "/tmp/resume.pdf", sha256: "a".repeat(64) },
    siteLabel: "Example Jobs",
  } as unknown as Parameters<typeof sendPreparedApplicationIfAllowed>[0];
}

// A send that did not happen says why ("Not sent: ...") instead of nothing.
const NOT_SENT: Record<string, unknown> = {
  sent: false,
  summary: expect.stringMatching(/^Not sent: /u) as unknown,
};

describe("sending a prepared application", () => {
  test("lets go of the page once the employer confirmed receipt", async () => {
    const release = vi.fn(() => Promise.resolve());
    submitPreparedApplication.mockResolvedValueOnce({ status: "submitted" });

    const sent = await sendPreparedApplicationIfAllowed(sendInput(release));

    expect(sent?.confirmedSubmitted).toBe(true);
    expect(release).toHaveBeenCalledWith({ id: "source_1" }, "result_1");
  });

  test("keeps the page when the outcome is not confirmed", async () => {
    const release = vi.fn(() => Promise.resolve());
    submitPreparedApplication.mockResolvedValueOnce({
      status: "outcome_uncertain",
    });

    await sendPreparedApplicationIfAllowed(sendInput(release));

    expect(release).not.toHaveBeenCalled();
  });

  test("a switch away from Send for me mid-batch stops the sends not made yet", async () => {
    submitPreparedApplication.mockClear();
    const release = vi.fn(() => Promise.resolve());
    for (const mode of ["prepare_only", "confirm_before_submit"]) {
      expect(
        await sendPreparedApplicationIfAllowed(sendInput(release, mode)),
      ).toMatchObject(NOT_SENT);
    }
    expect(submitPreparedApplication).not.toHaveBeenCalled();

    // A send the person confirmed themselves still goes.
    submitPreparedApplication.mockResolvedValueOnce({ status: "submitted" });
    const sent = await sendPreparedApplicationIfAllowed(
      sendInput(release, "confirm_before_submit", true),
    );
    expect(sent?.confirmedSubmitted).toBe(true);
  });

  test("serializes different jobs through the outcome before the next send starts", async () => {
    submitPreparedApplication.mockClear();
    let finishFirst!: (value: unknown) => void;
    submitPreparedApplication
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ status: "submitted" });
    const release = vi.fn(() => Promise.resolve());
    const firstInput = sendInput(release);
    const secondInput = sendInput(release);
    secondInput.ctx.repository = firstInput.ctx.repository;
    secondInput.lineage = { ...secondInput.lineage, jobId: "job_2" };
    const current = firstInput.envelope!;
    current.scope.jobIds.push("job_2");

    const first = sendPreparedApplicationIfAllowed(firstInput);
    await vi.waitFor(() =>
      expect(submitPreparedApplication).toHaveBeenCalledTimes(1),
    );
    const second = sendPreparedApplicationIfAllowed(secondInput);
    await Promise.resolve();
    expect(submitPreparedApplication).toHaveBeenCalledTimes(1);
    finishFirst({ status: "outcome_uncertain" });
    await first;
    await second;
    expect(submitPreparedApplication).toHaveBeenCalledTimes(2);
    expect(submitPreparedApplication.mock.calls[1]?.[0]).toMatchObject({
      lineage: { jobId: "job_2" },
    });
  });

  test("does not send a queued job after its stop signal", async () => {
    submitPreparedApplication.mockClear();
    let finishFirst!: (value: unknown) => void;
    submitPreparedApplication.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    const release = vi.fn(() => Promise.resolve());
    const firstInput = sendInput(release);
    const secondInput = sendInput(release);
    secondInput.ctx.repository = firstInput.ctx.repository;
    const controller = new AbortController();
    secondInput.signal = controller.signal;

    const first = sendPreparedApplicationIfAllowed(firstInput);
    await vi.waitFor(() =>
      expect(submitPreparedApplication).toHaveBeenCalledTimes(1),
    );
    const second = sendPreparedApplicationIfAllowed(secondInput);
    controller.abort();
    expect(await second).toMatchObject(NOT_SENT);
    finishFirst({ status: "outcome_uncertain" });
    await first;
    expect(submitPreparedApplication).toHaveBeenCalledTimes(1);
  });

  test("an aborted waiter does not let a later send pass the active send", async () => {
    submitPreparedApplication.mockClear();
    let finishFirst!: (value: unknown) => void;
    submitPreparedApplication
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue({ status: "submitted" });
    const release = vi.fn(() => Promise.resolve());
    const firstInput = sendInput(release);
    const abortedInput = sendInput(release);
    const lastInput = sendInput(release);
    abortedInput.ctx.repository = firstInput.ctx.repository;
    lastInput.ctx.repository = firstInput.ctx.repository;
    const controller = new AbortController();
    abortedInput.signal = controller.signal;

    const first = sendPreparedApplicationIfAllowed(firstInput);
    await vi.waitFor(() =>
      expect(submitPreparedApplication).toHaveBeenCalledTimes(1),
    );
    const aborted = sendPreparedApplicationIfAllowed(abortedInput);
    controller.abort();
    expect(await aborted).toMatchObject(NOT_SENT);
    const last = sendPreparedApplicationIfAllowed(lastInput);
    await Promise.resolve();
    expect(submitPreparedApplication).toHaveBeenCalledTimes(1);
    finishFirst({ status: "outcome_uncertain" });
    await Promise.all([first, last]);
    expect(submitPreparedApplication).toHaveBeenCalledTimes(2);
  });

  test("holds the exact application site before entering the authority gate", async () => {
    submitPreparedApplication
      .mockClear()
      .mockResolvedValue({ status: "submitted" });
    const order: string[] = [];
    const input = sendInput(vi.fn(() => Promise.resolve()));
    input.ctx.browserRuntime.withApplicationPageExecution = async (
      _source,
      bindingKey,
      operation,
    ) => {
      expect(bindingKey).toBe("result_1");
      order.push("site");
      const result = await operation();
      order.push("site_released");
      return result;
    };
    input.ctx.repository.listApplicationAuthorityEnvelopes = () => {
      order.push("authority");
      return Promise.resolve([input.envelope!]);
    };

    await sendPreparedApplicationIfAllowed(input);
    expect(order).toEqual(["site", "authority", "site_released"]);
  });

  test("a page closed while waiting for its site never reaches the send", async () => {
    submitPreparedApplication.mockClear();
    const input = sendInput(vi.fn(() => Promise.resolve()));
    input.ctx.browserRuntime.withApplicationPageExecution = () =>
      Promise.reject(new Error("The prepared application page was closed."));
    const result = await sendPreparedApplicationIfAllowed(input);
    expect(result?.pageClosed).toBe(true);
    expect(submitPreparedApplication).not.toHaveBeenCalled();
  });

  test("uses a later same-mode grant only when it still covers this job and resume", async () => {
    submitPreparedApplication
      .mockClear()
      .mockResolvedValue({ status: "submitted" });
    const release = vi.fn(() => Promise.resolve());
    const input = sendInput(release);
    const original = input.envelope!;
    const later = {
      ...original,
      revision: 3,
      scope: { ...original.scope, jobIds: ["job_1", "job_2"] },
    };
    input.ctx.repository.listApplicationAuthorityEnvelopes = () =>
      Promise.resolve([later]);
    await sendPreparedApplicationIfAllowed(input);
    expect(submitPreparedApplication.mock.calls.at(-1)?.[0]).toMatchObject({
      envelope: { revision: 3 },
    });

    submitPreparedApplication.mockClear();
    input.ctx.repository.listApplicationAuthorityEnvelopes = () =>
      Promise.resolve([{ ...later, mode: "confirm_before_submit" }]);
    expect(await sendPreparedApplicationIfAllowed(input)).toMatchObject(
      NOT_SENT,
    );
    expect(submitPreparedApplication).not.toHaveBeenCalled();

    input.ctx.repository.listApplicationAuthorityEnvelopes = () =>
      Promise.resolve([{ ...later, id: "unrelated_new_grant" }]);
    expect(await sendPreparedApplicationIfAllowed(input)).toMatchObject(
      NOT_SENT,
    );
    expect(submitPreparedApplication).not.toHaveBeenCalled();
  });
});

test("refuses to send when a newer approved letter differs from the prepared form", async () => {
  const input = sendInput(vi.fn());
  const finalAction = vi.fn();
  input.ctx.browserRuntime.executeExactlyOneFinalAction = finalAction;
  input.ctx.documentManager = {
    getApprovedApplicationLetter: vi.fn(() =>
      Promise.resolve({
        content: "Approved revision two",
      }),
    ),
  } as unknown as NonNullable<typeof input.ctx.documentManager>;
  input.ctx.repository.listApplyJobResults = vi.fn(() =>
    Promise.resolve([
      { id: "result_1", reviewCard: { letter: { text: "Earlier revision" } } },
    ]),
  ) as unknown as typeof input.ctx.repository.listApplyJobResults;
  const result = await sendPreparedApplicationIfAllowed(input);
  expect(result).toMatchObject({
    sent: false,
    nextActionLabel: "Prepare again",
  });
  expect(result?.detail).toContain("form still holds the earlier letter");
  expect(finalAction).not.toHaveBeenCalled();
});
