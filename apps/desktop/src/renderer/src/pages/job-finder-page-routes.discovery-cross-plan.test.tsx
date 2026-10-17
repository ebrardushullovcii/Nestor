// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import type { JobFinderPageContext } from "./job-finder-page-context";
import {
  JobFinderApplicationsRoute,
  JobFinderDiscoveryRoute,
} from "./job-finder-page-routes";

vi.mock(
  "@renderer/features/job-finder/screens/discovery/discovery-screen",
  () => ({
    DiscoveryScreen: () => <div>Find jobs loaded</div>,
  }),
);

vi.mock(
  "@renderer/features/job-finder/screens/applications/applications-screen",
  () => ({ ApplicationsScreen: () => <div>Applications loaded</div> }),
);

afterEach(cleanup);

function renderJobLink(
  jobId: string,
  onSelectCampaign: (campaignId: string) => Promise<boolean> = vi.fn(() =>
    Promise.resolve(false),
  ),
  applications = false,
  applySelections = false,
) {
  const workspace = {
    activeCampaignId: "plan-a",
    campaigns: [
      { id: "plan-a", name: "Plan A", jobIds: ["job-a"] },
      { id: "plan-b", name: "Plan B", jobIds: ["job-b"] },
      { id: "plan-c", name: "Plan C", jobIds: ["job-c"] },
    ],
    discoveryJobs: [
      { id: "job-a", title: "Job A" },
      { id: "job-b", title: "Job B" },
      { id: "job-c", title: "Job C" },
    ],
    applicationRecords: [
      { id: "job-b", jobId: "job-b" },
      { id: "job-c", jobId: "job-c" },
    ],
    applicationAttempts: [],
    applyJobResults: [],
    applyRuns: [],
    dismissedDiscoveryJobs: [],
    hydration: { phase: "ready", deferredCollections: [] },
    searchPreferences: { discovery: { targets: [] } },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
  const context = new Proxy(
    {
      workspace,
      onSelectCampaign,
      onSelectDiscoveryJob: vi.fn(),
      selectedDiscoveryJob: null,
      onNavigateSafely: vi.fn(),
    },
    {
      get: (target, key) =>
        key in target ? target[key as keyof typeof target] : vi.fn(),
    },
  ) as unknown as JobFinderPageContext;

  const route = applications ? "applications" : "discovery";
  const param = applications ? "applicationRecordId" : "jobId";
  function ContextOutlet() {
    const [activeCampaignId, setActiveCampaignId] = useState("plan-a");
    return (
      <Outlet
        context={
          applySelections
            ? {
                ...context,
                workspace: { ...workspace, activeCampaignId },
                onSelectCampaign: async (id: string) => {
                  const selected = await onSelectCampaign(id);
                  if (selected) setActiveCampaignId(id);
                  return selected;
                },
              }
            : context
        }
      />
    );
  }
  render(
    <MemoryRouter initialEntries={[`/job-finder/${route}?${param}=${jobId}`]}>
      <Link to={`/job-finder/${route}?${param}=job-c`}>Open next link</Link>
      <Routes>
        <Route path="/job-finder" element={<ContextOutlet />}>
          <Route path="discovery" element={<JobFinderDiscoveryRoute />} />
          <Route path="applications" element={<JobFinderApplicationsRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return { onSelectCampaign };
}

describe("Find jobs links from workspace search", () => {
  it("selects the plan containing a saved job from another plan", async () => {
    const { onSelectCampaign } = renderJobLink(
      "job-b",
      vi.fn(() => new Promise<boolean>(() => undefined)),
    );

    await waitFor(() =>
      expect(onSelectCampaign).toHaveBeenCalledExactlyOnceWith("plan-b"),
    );
    expect(screen.queryByText("Job not shown")).toBeNull();
  });

  it("keeps a genuinely unavailable job unavailable", () => {
    const { onSelectCampaign } = renderJobLink("missing-job");

    expect(screen.getByText("Job unavailable")).toBeTruthy();
    expect(onSelectCampaign).not.toHaveBeenCalled();
  });

  it("offers a working retry when a guarded plan switch is declined", async () => {
    const onSelectCampaign = vi.fn(() => Promise.resolve(false));
    renderJobLink("job-b", onSelectCampaign);

    fireEvent.click(
      await screen.findByRole("button", { name: "Switch to Plan B" }),
    );
    await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(2));
  });
});

describe.each([false, true])(
  "pending cross-plan links (applications: %s)",
  (applications) => {
    it("reopens the newest link if an older successful switch arrives last", async () => {
      const completions: Array<(value: boolean) => void> = [];
      const onSelectCampaign = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            completions.push(resolve);
          }),
      );
      renderJobLink("job-b", onSelectCampaign, applications, true);
      await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("link", { name: "Open next link" }));
      await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(2));
      await act(async () => {
        completions[1]!(true);
        completions[0]!(true);
        await Promise.resolve();
      });
      await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(3));
      expect(onSelectCampaign).toHaveBeenLastCalledWith("plan-c");
    });

    it("ignores an earlier link failure while the next link is still opening", async () => {
      let declineFirst!: (value: boolean) => void;
      const onSelectCampaign = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              declineFirst = resolve;
            }),
        )
        .mockImplementation(() => new Promise<boolean>(() => undefined));
      renderJobLink("job-b", onSelectCampaign, applications);
      await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("link", { name: "Open next link" }));
      await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(2));
      await act(async () => {
        declineFirst(false);
        await Promise.resolve();
      });
      expect(
        screen.queryByRole("button", { name: "Switch to Plan C" }),
      ).toBeNull();
      expect(
        screen.getByText(applications ? "Opening application" : "Opening job"),
      ).toBeTruthy();
    });
  },
);
