// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { JobSearchCampaign } from "@nestor/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { SearchPlanScope } from "./search-plan-scope";

afterEach(cleanup);
it("names an empty current plan and directly switches to one with saved work", async () => {
  const campaigns = [
    {
      id: "empty",
      name: "Inventory",
      status: "active",
      progress: { jobsRetained: 0 },
    },
    {
      id: "saved",
      name: "Backend volume",
      status: "active",
      progress: { jobsRetained: 32 },
    },
  ] as JobSearchCampaign[];
  const onSelect = vi.fn().mockResolvedValue(true);
  render(
    <SearchPlanScope
      campaigns={campaigns}
      activeCampaignId="empty"
      countsByCampaignId={{ empty: 0, saved: 32 }}
      collection="Shortlisted"
      onSelect={onSelect}
    />,
  );
  expect(
    screen
      .getByRole("combobox", { name: "Shortlisted search plan" })
      .getAttribute("data-slot"),
  ).toBe("select-trigger");
  expect(screen.getByText("Shortlisted jobs in other plans:")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Backend volume (32)" }));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith("saved"));
});
