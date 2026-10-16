// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  UserActionRequestSchema,
  type JobFinderRendererWorkspaceSnapshot,
} from "@nordri/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionsScreen, isSameSiteApplicationActive } from "./actions-screen";

afterEach(cleanup);

function request(input: {
  kind: "login" | "manual_upload";
  verification: Record<string, unknown>;
  summary?: string;
}) {
  return UserActionRequestSchema.parse({
    id: `action_${input.kind}`,
    dedupeKey: `dedupe_${input.kind}`,
    revision: 1,
    kind: input.kind,
    state: "page_opened",
    scope: {
      type: "application",
      runId: "run_1",
      jobId: "job_1",
      resultId: "result_1",
      applicationRecordId: "application_job_1",
      source: "target_site",
    },
    verification: input.verification,
    title: input.kind === "login" ? "Sign in to continue" : "Attach a file",
    summary: input.summary ?? "The application needs you.",
    actionUrl: "https://jobs.example.com/application",
    displayOrigin: "https://jobs.example.com/",
    createdAt: "2026-09-23T08:00:00.000Z",
    updatedAt: "2026-09-23T08:00:00.000Z",
  });
}

describe("Needs you application hand-offs that carry on by themselves", () => {
  it("offers no check press for an application sign-in Job Finder watches", () => {
    const { getByRole, getByTestId, queryByRole } = render(
      <ActionsScreen
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[
          request({
            kind: "login",
            verification: {
              type: "source_access",
              blockerFingerprint: "blocker_login",
              expectedOrigin: "https://jobs.example.com/",
            },
          }),
        ]}
      />,
    );

    expect(
      getByRole("button", { name: "Open the Job Finder browser" }),
    ).toBeTruthy();
    expect(
      queryByRole("button", { name: "Check whether this step is done" }),
    ).toBeNull();
    expect(getByTestId("needs-you-sign-in-continues-note").textContent).toMatch(
      /carries on with this application by itself/i,
    );
  });

  it("sends a waiting file question to Profile › Files", () => {
    const onNavigate = vi.fn();
    const applicationAttempts = [
      {
        applicationRecordId: "application_job_1",
        jobId: "job_1",
        blocker: { code: "missing_candidate_answer" },
        questions: [
          {
            id: "question_portfolio",
            prompt: "Portfolio",
            kind: "portfolio",
            answerControlType: "file",
            status: "detected",
          },
        ],
        updatedAt: "2026-09-23T08:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationAttempts"];
    const { getByRole, getByTestId } = render(
      <ActionsScreen
        applicationAttempts={applicationAttempts}
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={onNavigate}
        requests={[
          request({
            kind: "manual_upload",
            verification: {
              type: "page_blocker_absent",
              blockerFingerprint: "blocker_1",
            },
          }),
        ]}
      />,
    );

    expect(getByTestId("needs-you-file-continues-note").textContent).toMatch(
      /carries on with this application by itself/i,
    );
    fireEvent.click(
      getByRole("button", { name: "Choose a file in Profile › Files" }),
    );
    // The card asked for a portfolio, so Files opens with Portfolio chosen.
    expect(onNavigate).toHaveBeenCalledWith(
      "/job-finder/profile?section=files&kind=portfolio",
    );
  });

  it("says the Files sentence once when the step already says it", () => {
    const applicationAttempts = [
      {
        applicationRecordId: "application_job_1",
        jobId: "job_1",
        blocker: { code: "missing_candidate_answer" },
        questions: [
          {
            id: "question_portfolio",
            prompt: "Portfolio",
            kind: "portfolio",
            answerControlType: "file",
            status: "detected",
          },
        ],
        updatedAt: "2026-09-23T08:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationAttempts"];
    const { queryByTestId, getByRole } = render(
      <ActionsScreen
        applicationAttempts={applicationAttempts}
        discoveryJobs={[]}
        isPending={() => false}
        onCommand={vi.fn()}
        onNavigate={vi.fn()}
        requests={[
          request({
            kind: "manual_upload",
            summary:
              "The form needs a portfolio. Add or restore the file in Profile › Files and Job Finder attaches it and carries on by itself.",
            verification: {
              type: "page_blocker_absent",
              blockerFingerprint: "blocker_1",
            },
          }),
        ]}
      />,
    );

    expect(queryByTestId("needs-you-file-continues-note")).toBeNull();
    expect(
      getByRole("button", { name: "Choose a file in Profile › Files" }),
    ).toBeTruthy();
  });
});

describe("isSameSiteApplicationActive", () => {
  const job = (id: string, host: string) => ({
    id,
    canonicalUrl: `http://${host}:47970/listing/${id}`,
    applicationUrl: `http://${host}:47970/apply/${id}`,
  });
  it("is true only while another job on the same site is being filled in", () => {
    const jobsById = new Map([
      ["willow", job("willow", "127.0.0.1")],
      ["cedar", job("cedar", "127.0.0.1")],
      ["cloud", job("cloud", "localhost")],
    ]);
    const willow = jobsById.get("willow")!;
    expect(
      isSameSiteApplicationActive(
        willow,
        [{ jobId: "cedar", state: "filling" }],
        jobsById,
      ),
    ).toBe(true);
    expect(
      isSameSiteApplicationActive(
        willow,
        [
          { jobId: "cloud", state: "filling" },
          { jobId: "cedar", state: "submitted" },
          { jobId: "willow", state: "filling" },
        ],
        jobsById,
      ),
    ).toBe(false);
  });
});

describe("a checked step behind another application on the same site", () => {
  it("says it waits for the other application on this site after a minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T08:02:00.000Z"));
    try {
      const checking = UserActionRequestSchema.parse({
        ...request({
          kind: "manual_upload",
          verification: {
            type: "page_blocker_absent",
            blockerFingerprint: "blocker_1",
          },
        }),
        state: "verifying",
        updatedAt: "2026-09-23T08:00:30.000Z",
      });
      const job = (id: string) => ({
        id,
        title: `Engineer ${id}`,
        company: "Example",
        canonicalUrl: `http://127.0.0.1:47970/greenhouse/jobs/${id}`,
        applicationUrl: `http://127.0.0.1:47970/greenhouse/apply/${id}`,
      });
      const { container } = render(
        <ActionsScreen
          applyJobResults={
            [
              { jobId: "job_2", state: "filling" },
            ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"]
          }
          discoveryJobs={
            [
              job("job_1"),
              job("job_2"),
            ] as unknown as JobFinderRendererWorkspaceSnapshot["discoveryJobs"]
          }
          isPending={() => false}
          onCommand={vi.fn()}
          onNavigate={vi.fn()}
          requests={[checking]}
        />,
      );
      expect(container.textContent).toContain(
        "Waiting for the other application on this site to finish.",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
