// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  SavedJobSchema,
  UserActionRequestSchema,
  type JobFinderRendererWorkspaceSnapshot,
  type UserActionCommandInput,
  type UserActionRequest,
} from "@nordri/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BOUNDED_COLLECTION_PAGE_SIZE as COLLECTION_PAGE_SIZE } from "./bounded-collection";
import { ActionsScreen, buildJobIndexById } from "./actions-screen";

const ACTION_COUNT = 210;
const APPLICATION_ACTION_COUNT = 130;
const JOB_COUNT = 1000;

// Walk both independent groups with queries scoped to their pagination controls.
// Allow serial runners time to finish while guarding against unbounded row work.
const PAGING_WALK_TIMEOUT_MS = 15_000;
const PAGING_WALK_BOUND_MS = 10_000;
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

// Parsed fixtures are immutable; build them once per file so the serial
// single-worker run does not re-parse 1,000+ zod objects for every test.
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

describe("ActionsScreen workspace scale", () => {
  it("indexes the job list by id in one pass", () => {
    const index = buildJobIndexById(SCALE_JOBS);
    expect(index.size).toBe(JOB_COUNT);
    expect(index.get("scale_job_0999")?.title).toBe("Scale Engineer 0999");
    expect(index.get("scale_job_missing")).toBeUndefined();
  });

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
    expect(within(applications).getByText("51–100 of 130")).toBeTruthy();
    expect(within(sources).getByText("1–50 of 80")).toBeTruthy();
    expect(sources.querySelectorAll("article")).toHaveLength(50);
    fireEvent.click(next);
    expect(within(applications).getByText("101–130 of 130")).toBeTruthy();
    expect(applications.querySelectorAll("article")).toHaveLength(30);
    expect(
      within(applications).getByRole("button", { name: "Next page" }),
    ).toHaveProperty("disabled", true);
  });

  it("keeps search complete across the whole collection without a find loop", async () => {
    const jobs = [...SCALE_JOBS];
    const findSpy = vi.spyOn(jobs, "find");
    renderScaleInbox(jobs);
    const input = screen.getByLabelText("Find an action");
    fireEvent.change(input, { target: { value: "0195" } });
    await waitFor(() =>
      expect(screen.getAllByText("Scale action 0195")).toHaveLength(1),
    );
    expect(screen.getByText("1 of 210 results")).toBeTruthy();
    fireEvent.change(input, { target: { value: "0128" } });
    await waitFor(() =>
      expect(screen.getAllByText("Scale action 0128")).toHaveLength(1),
    );
    expect(
      screen.getByText(/Scale Engineer 0128 at Scale Company/),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("1–50 of 130")).toBeTruthy());
    expect(findSpy).not.toHaveBeenCalled();
  });

  it(
    "walks every action once with bounded pages and accessible end cues",
    () => {
      renderScaleInbox();
      const seenTitles = new Set<string>();
      const startedAt = performance.now();
      for (const name of ["Applications", "Job sources"]) {
        const section = getGroupSection(name);
        const navigation = within(section).getByRole("navigation");
        for (;;) {
          const cards = section.querySelectorAll("article");
          expect(cards.length).toBeLessThanOrEqual(COLLECTION_PAGE_SIZE);
          for (const heading of section.querySelectorAll("article h3"))
            seenTitles.add(heading.textContent ?? "");
          const next = within(navigation).getByRole<HTMLButtonElement>(
            "button",
            { name: "Next page" },
          );
          if (next.disabled) break;
          fireEvent.click(next);
        }
        expect(
          within(navigation).getByRole("button", { name: "Previous page" }),
        ).toHaveProperty("disabled", false);
      }
      expect(seenTitles.size).toBe(ACTION_COUNT);
      expect(seenTitles.has("Scale action 0000")).toBe(true);
      expect(seenTitles.has("Scale action 0209")).toBe(true);
      expect(performance.now() - startedAt).toBeLessThan(PAGING_WALK_BOUND_MS);
    },
    PAGING_WALK_TIMEOUT_MS,
  );

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
