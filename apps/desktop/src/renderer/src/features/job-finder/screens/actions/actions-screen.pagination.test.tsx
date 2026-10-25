// @vitest-environment jsdom

import {
  SavedJobSchema,
  UserActionRequestSchema,
  type JobFinderRendererWorkspaceSnapshot,
  type UserActionCommandInput,
  type UserActionRequest,
} from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionsScreen } from "./actions-screen";
import { BOUNDED_COLLECTION_PAGE_SIZE as COLLECTION_PAGE_SIZE } from "./bounded-collection";

const ACTION_COUNT = 152;
const APPLICATION_ACTION_COUNT = 101;
const JOB_COUNT = 101;

type DiscoveryJob = JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number];

function createJobs(): DiscoveryJob[] {
  return Array.from({ length: JOB_COUNT }, (_, index) => {
    const ordinal = index.toString().padStart(4, "0");

    return {
      ...SavedJobSchema.parse({
        id: `scale_job_${ordinal}`,
        source: "target_site",
        sourceJobId: `scale_source_${ordinal}`,
        canonicalUrl: `https://jobs.example.test/roles/${ordinal}`,
        applicationUrl: `https://jobs.example.test/roles/${ordinal}/apply`,
        title: `Scale Engineer ${ordinal}`,
        company: `Scale Company ${index % 50}`,
        location: index % 2 === 0 ? "Remote" : "Budapest, Hungary",
        workMode: index % 2 === 0 ? ["remote"] : ["hybrid"],
        applyPath: "external_redirect",
        easyApplyEligible: false,
        discoveredAt: "2026-07-30T10:00:00.000Z",
        salaryText: null,
        description: `Own product systems for role ${ordinal}.`,
        status: "discovered",
        matchAssessment: {
          score: 70 + (index % 30),
          reasons: ["Relevant product design experience"],
          gaps: [],
        },
      }),
      listingActivity: { status: "unknown" as const },
    };
  });
}

function createRequest(index: number): UserActionRequest {
  const ordinal = index.toString().padStart(4, "0");
  const isApplication = index < APPLICATION_ACTION_COUNT;

  const applicationScope = {
    type: "application" as const,
    runId: "run_scale",
    jobId: `scale_job_${ordinal}`,
    resultId: null,
    replayCheckpointId: null,
    source: "target_site" as const,
  };
  const discoveryScope = {
    type: "discovery_source" as const,
    targetId: `scale_target_${ordinal}`,
    source: "target_site" as const,
    sourceDebugRunId: null,
    sourceDebugAttemptId: null,
  };

  return UserActionRequestSchema.parse({
    id: `scale_action_${ordinal}`,
    dedupeKey: `scale_dedupe_${ordinal}`,
    revision: 1,
    kind: "login",
    state: "pending",
    scope: isApplication ? applicationScope : discoveryScope,
    verification: isApplication
      ? { type: "page_blocker_absent", blockerFingerprint: "blocker_1" }
      : {
          type: "source_access",
          targetId: `scale_target_${ordinal}`,
          blockerFingerprint: "blocker_1",
        },
    title: `Scale action ${ordinal}`,
    summary: "Use the Job Finder browser, then return here.",
    actionUrl: "https://jobs.example.com/login",
    displayOrigin: "https://jobs.example.com/",
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:00:00.000Z",
    resolvedAt: null,
  });
}

// Reuse the parsed fixtures across pagination cases.
const SCALE_JOBS = createJobs();
const SCALE_REQUESTS = Array.from({ length: ACTION_COUNT }, (_, index) =>
  createRequest(index),
);

function renderScaleInbox(jobs: DiscoveryJob[] = SCALE_JOBS) {
  return render(
    <ActionsScreen
      discoveryJobs={jobs}
      isPending={() => false}
      onCommand={vi.fn<(command: UserActionCommandInput) => void>()}
      onNavigate={vi.fn()}
      requests={SCALE_REQUESTS}
    />,
  );
}

function getGroupSection(headingName: string): HTMLElement {
  const section = screen
    .getByRole("heading", { name: headingName })
    .closest("section");
  if (!section) {
    throw new Error(`Missing action group section for ${headingName}`);
  }
  return section;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ActionsScreen pagination", () => {
  it("mounts independent bounded pages with full counts and indexed job lookups", () => {
    const jobs = [...SCALE_JOBS];
    const findSpy = vi.spyOn(jobs, "find");
    const { container } = renderScaleInbox(jobs);
    expect(container.querySelectorAll("article")).toHaveLength(
      COLLECTION_PAGE_SIZE * 2,
    );
    expect(screen.getByText(`${ACTION_COUNT} results`)).toBeTruthy();
    expect(
      getGroupSection("Applications").querySelectorAll("article"),
    ).toHaveLength(COLLECTION_PAGE_SIZE);
    expect(
      getGroupSection("Job sources").querySelectorAll("article"),
    ).toHaveLength(COLLECTION_PAGE_SIZE);
    expect(screen.getByText(String(APPLICATION_ACTION_COUNT))).toBeTruthy();
    expect(
      screen.getByText(String(ACTION_COUNT - APPLICATION_ACTION_COUNT)),
    ).toBeTruthy();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("pages each group independently without hiding the other group's cards", () => {
    renderScaleInbox();
    const applications = getGroupSection("Applications");
    const sources = getGroupSection("Job sources");
    const next = within(applications).getByRole("button", {
      name: "Next page",
    });
    fireEvent.click(next);
    expect(within(applications).getByText("51–100 of 101")).toBeTruthy();
    expect(within(sources).getByText("1–50 of 51")).toBeTruthy();
    expect(sources.querySelectorAll("article")).toHaveLength(50);
    fireEvent.click(next);
    expect(within(applications).getByText("101–101 of 101")).toBeTruthy();
    expect(applications.querySelectorAll("article")).toHaveLength(1);
    expect(
      within(applications).getByRole("button", { name: "Next page" }),
    ).toHaveProperty("disabled", true);
  });

  it("keeps search complete across the whole collection without a find loop", async () => {
    const jobs = [...SCALE_JOBS];
    const findSpy = vi.spyOn(jobs, "find");
    renderScaleInbox(jobs);
    const input = screen.getByLabelText("Find an action");
    fireEvent.change(input, { target: { value: "0145" } });
    await waitFor(() =>
      expect(screen.getAllByText("Scale action 0145")).toHaveLength(1),
    );
    expect(screen.getByText("1 of 152 results")).toBeTruthy();
    fireEvent.change(input, { target: { value: "0098" } });
    await waitFor(() =>
      expect(screen.getAllByText("Scale action 0098")).toHaveLength(1),
    );
    expect(
      screen.getByText(/Scale Engineer 0098 at Scale Company/),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("1–50 of 101")).toBeTruthy());
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("keeps off-page commands intact", () => {
    const onCommand = vi.fn<(command: UserActionCommandInput) => void>();
    render(
      <ActionsScreen
        discoveryJobs={SCALE_JOBS}
        isPending={() => false}
        onCommand={onCommand}
        onNavigate={vi.fn()}
        requests={SCALE_REQUESTS}
      />,
    );
    const section = getGroupSection("Applications");
    fireEvent.click(within(section).getByRole("button", { name: "Next page" }));
    const card = screen.getByText("Scale action 0055").closest("article");
    expect(card).toBeTruthy();
    fireEvent.click(
      within(card as HTMLElement).getByRole("button", {
        name: "Cancel this step",
      }),
    );
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cancel",
        requestId: "scale_action_0055",
      }),
    );
  });
});
