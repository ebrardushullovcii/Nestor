// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLaunchDestinationCount } from "../../lib/launch-reads";
import { JobSearchHomeLaunch } from "./job-search-home-launch";

afterEach(cleanup);

const counts = {
  discovery: 530,
  dismissed: 5554,
  shortlisted: 200,
  applications: 4,
  companies: 51,
  all: 6284,
};

describe("Home while the workspace loads", () => {
  it("holds the Next step card's last height at the same window width", () => {
    localStorage.setItem(
      "nestor.job-finder.home.next-step-size.v1",
      JSON.stringify({ height: 237, windowWidth: window.innerWidth }),
    );
    try {
      render(
        <JobSearchHomeLaunch counts={counts} onNavigate={() => undefined} />,
      );
      expect(screen.getByTestId("home-next-step-launch").style.minHeight).toBe(
        "237px",
      );
      cleanup();
      localStorage.setItem(
        "nestor.job-finder.home.next-step-size.v1",
        JSON.stringify({ height: 237, windowWidth: window.innerWidth + 400 }),
      );
      render(
        <JobSearchHomeLaunch counts={counts} onNavigate={() => undefined} />,
      );
      expect(screen.getByTestId("home-next-step-launch").style.minHeight).toBe(
        "",
      );
    } finally {
      localStorage.removeItem("nestor.job-finder.home.next-step-size.v1");
    }
  });

  it("shows the three list counts where the full Home puts them", () => {
    render(
      <JobSearchHomeLaunch counts={counts} onNavigate={() => undefined} />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Home" }),
    ).toBeTruthy();
    const tiles = within(
      screen.getByRole("navigation", { name: "Where you are" }),
    );
    expect(tiles.getByRole("button", { name: /Find jobs\s*530/ })).toBeTruthy();
    expect(
      tiles.getByRole("button", { name: /Shortlisted\s*200/ }),
    ).toBeTruthy();
    expect(
      tiles.getByRole("button", { name: /Applications\s*4/ }),
    ).toBeTruthy();
  });

  it("opens the list a tile names", () => {
    const onNavigate = vi.fn();
    render(<JobSearchHomeLaunch counts={counts} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: /Shortlisted/ }));
    expect(onNavigate).toHaveBeenCalledWith("/job-finder/review-queue");
  });

  it("leaves the tiles out of an empty workspace, as the full Home does", () => {
    render(
      <JobSearchHomeLaunch
        counts={{ ...counts, discovery: 0, shortlisted: 0, applications: 0 }}
        onNavigate={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("navigation", { name: "Where you are" }),
    ).toBeNull();
  });

  it("badges only the three lists, never at zero", () => {
    expect(readLaunchDestinationCount(counts, "/job-finder/discovery")).toBe(
      530,
    );
    expect(readLaunchDestinationCount(counts, "/job-finder/review-queue")).toBe(
      200,
    );
    expect(readLaunchDestinationCount(counts, "/job-finder/applications")).toBe(
      4,
    );
    expect(
      readLaunchDestinationCount(counts, "/job-finder/profile"),
    ).toBeNull();
    expect(
      readLaunchDestinationCount(
        { ...counts, applications: 0 },
        "/job-finder/applications",
      ),
    ).toBeNull();
    expect(
      readLaunchDestinationCount(null, "/job-finder/discovery"),
    ).toBeNull();
  });
});
