// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordOutcomeInput } from "@nestor/contracts";
import { ApplicationsOutcomeRecorder } from "./applications-outcome-recorder";

const canonicalFieldTokens = [
  "border-(--field-border)",
  "bg-(--field)",
  "outline-none",
  "focus-visible:border-(--field-focus-border)",
  "focus-visible:bg-(--field-strong)",
  "focus-visible:shadow-[var(--field-focus-shadow)]",
];

function expectCanonicalFieldClasses(control: HTMLElement) {
  for (const token of canonicalFieldTokens) {
    expect(control.className).toContain(token);
  }
  expect(control.className).not.toContain("border-input");
  expect(control.className).not.toContain("bg-background");
  expect(control.className).not.toContain("ring-[3px]");
}

function getOutcomeSelect(): HTMLSelectElement {
  const element = screen.getByLabelText(/Outcome/);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error("Outcome control is not a select element");
  }
  return element;
}

function getRecordOutcomeButton(): HTMLButtonElement {
  const element = screen.getByRole("button", { name: "Record outcome" });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("Record outcome control is not a button");
  }
  return element;
}

describe("ApplicationsOutcomeRecorder", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("records the chosen outcome for the job with the attached resume strategy", async () => {
    const onRecordOutcome = vi
      .fn<(input: RecordOutcomeInput) => Promise<void>>()
      .mockResolvedValue(undefined);
    render(
      <ApplicationsOutcomeRecorder
        isPending={false}
        jobId="job-1"
        campaignId="campaign-1"
        applicationRecordId="application-1"
        onRecordOutcome={onRecordOutcome}
        resumeStrategyId="strategy-1"
      />,
    );

    fireEvent.change(screen.getByLabelText(/Outcome/), {
      target: { value: "interview" },
    });
    fireEvent.change(screen.getByLabelText(/Note \(optional\)/), {
      target: { value: "Recruiter call went well" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record outcome" }));

    await vi.waitFor(() => {
      expect(onRecordOutcome).toHaveBeenCalledWith({
        jobId: "job-1",
        campaignId: "campaign-1",
        applicationRecordId: "application-1",
        outcome: "interview",
        resumeStrategyId: "strategy-1",
        note: "Recruiter call went well",
      });
    });
  });

  it("recording Applied is a manual outcome only and never fabricates submission evidence", async () => {
    const onRecordOutcome = vi
      .fn<(input: RecordOutcomeInput) => Promise<void>>()
      .mockResolvedValue(undefined);
    render(
      <ApplicationsOutcomeRecorder
        isPending={false}
        jobId="job-1"
        campaignId="campaign-1"
        applicationRecordId="application-1"
        onRecordOutcome={onRecordOutcome}
        resumeStrategyId={null}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Outcome/), {
      target: { value: "applied" },
    });
    expect(
      screen.getByText(/does not claim that a browser submission happened/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Record outcome" }));

    await vi.waitFor(() => {
      expect(onRecordOutcome).toHaveBeenCalledWith({
        jobId: "job-1",
        campaignId: "campaign-1",
        applicationRecordId: "application-1",
        outcome: "applied",
        resumeStrategyId: null,
        note: null,
      });
    });
    expect(onRecordOutcome.mock.calls[0]?.[0]).not.toHaveProperty(
      "submissionEvidence",
    );
    expect(onRecordOutcome.mock.calls[0]?.[0]).not.toHaveProperty("runId");
    expect(onRecordOutcome.mock.calls[0]?.[0]).not.toHaveProperty(
      "submittedAt",
    );
  });

  it("offers every requested recording kind without any submit authority", () => {
    render(
      <ApplicationsOutcomeRecorder
        isPending={false}
        jobId="job-1"
        campaignId="campaign-1"
        applicationRecordId="application-1"
        onRecordOutcome={() => Promise.resolve()}
        resumeStrategyId={null}
      />,
    );

    const select = getOutcomeSelect();
    const optionValues = [...select.options].map((option) => option.value);

    expect(optionValues).toEqual(
      expect.arrayContaining([
        "application_completed",
        "abandoned",
        "applied",
        "employer_response",
        "assessment",
        "interview",
        "offer",
        "rejected",
        "withdrawn",
        "no_response",
      ]),
    );
    expect(optionValues).not.toContain("submitted");
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("surfaces a record failure as an alert and keeps the form filled", async () => {
    const onRecordOutcome = vi
      .fn<(input: RecordOutcomeInput) => Promise<void>>()
      .mockRejectedValue(new Error("That job is no longer available."));
    render(
      <ApplicationsOutcomeRecorder
        isPending={false}
        jobId="job-1"
        campaignId="campaign-1"
        applicationRecordId="application-1"
        onRecordOutcome={onRecordOutcome}
        resumeStrategyId={null}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Outcome/), {
      target: { value: "offer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record outcome" }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(
        /That job is no longer available/,
      );
    });
    expect(getOutcomeSelect().value).toBe("offer");
  });

  it("does not record without a chosen outcome", () => {
    const onRecordOutcome = vi
      .fn<(input: RecordOutcomeInput) => Promise<void>>()
      .mockResolvedValue(undefined);
    render(
      <ApplicationsOutcomeRecorder
        isPending={false}
        jobId="job-1"
        campaignId="campaign-1"
        applicationRecordId="application-1"
        onRecordOutcome={onRecordOutcome}
        resumeStrategyId={null}
      />,
    );

    const recordButton = getRecordOutcomeButton();
    expect(recordButton.disabled).toBe(true);
    fireEvent.click(recordButton);
    expect(onRecordOutcome).not.toHaveBeenCalled();
  });

  it("disables controls while a record is pending", () => {
    render(
      <ApplicationsOutcomeRecorder
        isPending
        jobId="job-1"
        campaignId="campaign-1"
        applicationRecordId="application-1"
        onRecordOutcome={() => Promise.resolve()}
        resumeStrategyId={null}
      />,
    );

    expect(getOutcomeSelect().disabled).toBe(true);
    // Pending keeps the record button exposed but inert instead of natively
    // disabled, so focus survives the in-flight record.
    expect(getRecordOutcomeButton().hasAttribute("disabled")).toBe(false);
    expect(getRecordOutcomeButton().getAttribute("aria-disabled")).toBe("true");
    expect(getRecordOutcomeButton().getAttribute("aria-busy")).toBe("true");
  });

  it("applies the canonical field recipe to editable controls", () => {
    render(
      <ApplicationsOutcomeRecorder
        isPending={false}
        jobId="job-1"
        campaignId={null}
        applicationRecordId="application-1"
        onRecordOutcome={() => Promise.resolve()}
        resumeStrategyId={null}
      />,
    );

    expectCanonicalFieldClasses(getOutcomeSelect());
    expectCanonicalFieldClasses(screen.getByLabelText(/Note \(optional\)/));
  });
});
