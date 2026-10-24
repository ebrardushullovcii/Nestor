// @vitest-environment jsdom

import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssistantProvider,
  useAssistant,
} from "../../assistant/assistant-provider";
import {
  DiscoveryResultsPanelWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

function createJob(index: number): SavedJob {
  return SavedJobSchema.parse({
    id: `ticked_job_${index}`,
    source: "target_site",
    sourceJobId: `ticked_source_${index}`,
    canonicalUrl: `https://jobs.example.test/roles/${index}`,
    applicationUrl: `https://jobs.example.test/roles/${index}/apply`,
    title: `Role ${index}`,
    company: `Company ${index}`,
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-09-27T10:00:00.000Z",
    salaryText: null,
    description: `Role ${index}.`,
    status: "discovered",
    discoveryMethod: "browser_agent",
    matchAssessment: { score: 90 - index, reasons: ["Fit"], gaps: [] },
  });
}

let capture: ReturnType<typeof useAssistant> = null;
function Probe() {
  capture = useAssistant();
  return null;
}

afterEach(() => {
  cleanup();
  capture = null;
});

describe("Find jobs publishes ticked rows to the assistant", () => {
  it("sends the ticked rows as the selection, never the inspected row", async () => {
    const jobs = [createJob(1), createJob(2), createJob(3)];
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <AssistantProvider>
          <Probe />
          <DiscoveryResultsPanelWithJobs
            browserSession={{
              source: "target_site",
              status: "ready",
              driver: "chrome_profile_agent",
              label: "Browser ready",
              detail: "Ready.",
              lastCheckedAt: "2026-09-27T10:00:00.000Z",
            }}
            hasCompletedSearch
            jobs={jobs}
            onSelectJob={vi.fn()}
            onShortlistJobs={vi.fn(() => Promise.resolve())}
            selectedJob={jobs[0] ?? null}
          />
        </AssistantProvider>
      </MemoryRouter>,
    );
    await flushFindJobsQueries();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role 2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role 3" }));
    let reference: Awaited<
      ReturnType<NonNullable<typeof capture>["captureContext"]>
    > | null = null;
    await act(async () => {
      reference =
        (await capture?.captureContext({
          mentions: [],
          attachments: [],
        })) ?? null;
    });
    expect(reference!.list?.selectedIds).toEqual([
      "ticked_job_2",
      "ticked_job_3",
    ]);
    expect(reference!.list?.filteredIds).toEqual([
      "ticked_job_1",
      "ticked_job_2",
      "ticked_job_3",
    ]);
  });
});
