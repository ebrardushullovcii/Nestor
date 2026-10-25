// @vitest-environment jsdom

import { Suspense, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  Link,
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import type { JobFinderPageContext } from "./job-finder-page-context";
import { JobFinderCampaignsRoute } from "./job-finder-page-routes";
import { campaignPlanEditorHref } from "@renderer/features/job-finder/lib/job-finder-route-hrefs";

vi.mock(
  "@renderer/features/job-finder/screens/campaigns/campaigns-screen",
  () => ({
    CampaignsScreen: (props: Record<string, unknown>) => (
      <>
        <button
          data-testid="campaigns-screen-delete"
          onClick={() => {
            void (
              props.onDeleteCampaign as
                | ((campaignId: string) => Promise<boolean>)
                | undefined
            )?.("campaign_requested");
          }}
          type="button"
        >
          delete
        </button>
        <button
          type="button"
          disabled={Boolean(props.pending)}
          onClick={() =>
            (props.onSelectCampaign as (id: string) => void)("campaign_2")
          }
        >
          Select second plan
        </button>
        <span data-testid="campaigns-screen-edit-campaign-id">
          {typeof props.editCampaignId === "string" ? props.editCampaignId : ""}
        </span>
      </>
    ),
  }),
);

function createContext(
  overrides: Partial<JobFinderPageContext> = {},
): JobFinderPageContext {
  return {
    actionState: { message: null },
    isPending: vi.fn(() => false),
    onDeleteCampaign: vi.fn(() => Promise.resolve(true)),
    workspace: {
      activeCampaignId: "campaign_1",
      campaigns: [],
      hydration: { phase: "ready", deferredCollections: [] },
    } as unknown as JobFinderRendererWorkspaceSnapshot,
    ...overrides,
  } as unknown as JobFinderPageContext;
}

afterEach(cleanup);

describe("JobFinderCampaignsRoute", () => {
  it("shows a dismissible campaign action failure and shows a repeated failure again", async () => {
    const message = "The search plan could not be saved. Try again.";
    const view = (context: JobFinderPageContext) => (
      <MemoryRouter initialEntries={["/job-finder/campaigns"]}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route
              path="/job-finder/campaigns"
              element={<Suspense fallback={null}><JobFinderCampaignsRoute /></Suspense>}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    const rendered = render(view(createContext({ actionState: { message } })));
    expect(await screen.findByText(message)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(message)).toBeNull();
    rendered.rerender(view(createContext({ actionState: { message } })));
    expect(await screen.findByText(message)).toBeTruthy();
    rendered.rerender(view(createContext()));
    expect(screen.queryByText(message)).toBeNull();
  });

  it("selects the exact valid campaign requested by global search", async () => {
    const context = createContext({
      onSelectCampaign: vi.fn(() => Promise.resolve(true)),
      workspace: {
        activeCampaignId: "campaign_1",
        campaigns: [{ id: "campaign_1" }, { id: "campaign_2" }],
        hydration: { phase: "ready", deferredCollections: [] },
      } as unknown as JobFinderRendererWorkspaceSnapshot,
    });
    render(
      <MemoryRouter
        initialEntries={["/job-finder/campaigns?campaignId=campaign_2"]}
      >
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route
              path="/job-finder/campaigns"
              element={
                <Suspense fallback={null}>
                  <JobFinderCampaignsRoute />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(context.onSelectCampaign).toHaveBeenCalledWith("campaign_2"),
    );
  });

  it("does not restart a pending linked plan selection when context refreshes", async () => {
    const onSelectCampaign = vi.fn<
      (id: string, revision: number) => Promise<boolean>
    >(() => new Promise<boolean>(() => undefined));
    const workspace = {
      activeCampaignId: "campaign_1",
      campaigns: [{ id: "campaign_1" }, { id: "campaign_2" }],
      hydration: { phase: "ready", deferredCollections: [] },
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    const view = (revision: number) => (
      <MemoryRouter
        initialEntries={["/job-finder/campaigns?campaignId=campaign_2"]}
      >
        <Routes>
          <Route
            element={
              <Outlet
                context={createContext({
                  workspace: {
                    ...workspace,
                    campaigns: [...workspace.campaigns],
                  },
                  onSelectCampaign: (id) => onSelectCampaign(id, revision),
                })}
              />
            }
          >
            <Route
              path="/job-finder/campaigns"
              element={
                <Suspense fallback={null}>
                  <JobFinderCampaignsRoute />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    const mounted = render(view(1));
    await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(1));
    act(() => mounted.rerender(view(2)));
    expect(onSelectCampaign).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest plan link until older successful switches settle", async () => {
    const completions: Array<(value: boolean) => void> = [];
    const onSelectCampaign = vi.fn<(id: string) => Promise<boolean>>(
      () =>
        new Promise<boolean>((resolve) => {
          completions.push(resolve);
        }),
    );
    function ContextOutlet() {
      const [activeCampaignId, setActiveCampaignId] = useState("campaign_1");
      const context = createContext({
        onSelectCampaign: async (id) => {
          const selected = await onSelectCampaign(id);
          if (selected) setActiveCampaignId(id);
          return selected;
        },
        workspace: {
          activeCampaignId,
          campaigns: [
            { id: "campaign_1" },
            { id: "campaign_2" },
            { id: "campaign_3" },
          ],
          hydration: { phase: "ready", deferredCollections: [] },
        } as unknown as JobFinderRendererWorkspaceSnapshot,
      });
      return (
        <>
          <span data-testid="active-plan">{activeCampaignId}</span>
          <Outlet context={context} />
        </>
      );
    }
    function LocationProbe() {
      return <span data-testid="query">{useLocation().search}</span>;
    }
    render(
      <MemoryRouter
        initialEntries={["/job-finder/campaigns?campaignId=campaign_2"]}
      >
        <Link to="/job-finder/campaigns?campaignId=campaign_3">
          Open newer plan
        </Link>
        <LocationProbe />
        <Routes>
          <Route element={<ContextOutlet />}>
            <Route
              path="/job-finder/campaigns"
              element={
                <Suspense fallback={null}>
                  <JobFinderCampaignsRoute />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("link", { name: "Open newer plan" }));
    await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(2));
    await act(async () => {
      completions[1]!(true);
      await Promise.resolve();
    });
    expect(screen.getByTestId("query").textContent).toContain("campaign_3");
    await act(async () => {
      completions[0]!(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(3));
    expect(onSelectCampaign).toHaveBeenLastCalledWith("campaign_3");
    await act(async () => {
      completions[2]!(true);
      await Promise.resolve();
    });
    expect(screen.getByTestId("active-plan").textContent).toBe("campaign_3");
    await waitFor(() =>
      expect(screen.getByTestId("query").textContent).toBe(""),
    );
  });

  it("leaves a declined linked switch available to retry without looping", async () => {
    const onSelectCampaign = vi.fn(() => Promise.resolve(false));
    const context = createContext({
      onSelectCampaign,
      workspace: {
        activeCampaignId: "campaign_1",
        campaigns: [{ id: "campaign_1" }, { id: "campaign_2" }],
        hydration: { phase: "ready", deferredCollections: [] },
      } as unknown as JobFinderRendererWorkspaceSnapshot,
    });
    render(
      <MemoryRouter
        initialEntries={["/job-finder/campaigns?campaignId=campaign_2"]}
      >
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route
              path="/job-finder/campaigns"
              element={
                <Suspense fallback={null}>
                  <JobFinderCampaignsRoute />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const retry = await screen.findByRole("button", {
      name: "Select second plan",
    });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
    expect(onSelectCampaign).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
    expect(onSelectCampaign).toHaveBeenCalledTimes(2);
  });

  it("does not navigate back when a linked selection completes after leaving", async () => {
    let complete!: (value: boolean) => void;
    const context = createContext({
      onSelectCampaign: () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
      workspace: {
        activeCampaignId: "campaign_1",
        campaigns: [{ id: "campaign_1" }, { id: "campaign_2" }],
        hydration: { phase: "ready", deferredCollections: [] },
      } as unknown as JobFinderRendererWorkspaceSnapshot,
    });
    function LocationProbe() {
      return <span data-testid="location">{useLocation().pathname}</span>;
    }
    render(
      <MemoryRouter
        initialEntries={["/job-finder/campaigns?campaignId=campaign_2"]}
      >
        <Link to="/elsewhere">Leave plans</Link>
        <LocationProbe />
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route
              path="/job-finder/campaigns"
              element={
                <Suspense fallback={null}>
                  <JobFinderCampaignsRoute />
                </Suspense>
              }
            />
            <Route path="/elsewhere" element={<div>Elsewhere</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Leave plans" }));
    await act(async () => {
      complete(true);
      await Promise.resolve();
    });
    expect(screen.getByTestId("location").textContent).toBe("/elsewhere");
  });

  it("asks the campaigns screen to open the plan editor a Find jobs link named", async () => {
    const context = createContext({
      onSelectCampaign: vi.fn(() => Promise.resolve(true)),
      workspace: {
        activeCampaignId: "campaign_1",
        campaigns: [{ id: "campaign_1" }, { id: "campaign_2" }],
        hydration: { phase: "ready", deferredCollections: [] },
      } as unknown as JobFinderRendererWorkspaceSnapshot,
    });
    render(
      <MemoryRouter initialEntries={[campaignPlanEditorHref("campaign_2")]}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route
              path="/job-finder/campaigns"
              element={
                <Suspense fallback={null}>
                  <JobFinderCampaignsRoute />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(
      (await screen.findByTestId("campaigns-screen-edit-campaign-id"))
        .textContent,
    ).toBe("campaign_2");
  });

  it("leaves the plan editor closed for a plain plan link", async () => {
    const context = createContext();
    render(
      <MemoryRouter initialEntries={["/job-finder/campaigns"]}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route
              path="/job-finder/campaigns"
              element={
                <Suspense fallback={null}>
                  <JobFinderCampaignsRoute />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(
      (await screen.findByTestId("campaigns-screen-edit-campaign-id"))
        .textContent,
    ).toBe("");
  });

  it("passes the delete-campaign handler through to the campaigns screen", async () => {
    const context = createContext();
    render(
      <MemoryRouter initialEntries={["/job-finder/campaigns"]}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route
              path="/job-finder/campaigns"
              element={
                <Suspense fallback={null}>
                  <JobFinderCampaignsRoute />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("campaigns-screen-delete"));

    expect(context.onDeleteCampaign).toHaveBeenCalledTimes(1);
    expect(context.onDeleteCampaign).toHaveBeenCalledWith("campaign_requested");
  });
});
