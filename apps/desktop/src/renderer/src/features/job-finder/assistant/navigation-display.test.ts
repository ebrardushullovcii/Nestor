// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { waitForDisplayedDestination } from "./navigation-display";

afterEach(() => {
  document.body.innerHTML = "";
});

it("waits for the requested job's actual details, even after the route changes", async () => {
  const route = "/job-finder/review-queue?jobId=7";
  document.body.innerHTML = '<main><h1>Shortlisted</h1><section data-job-detail-id="3"></section></main>';
  expect(await waitForDisplayedDestination(route, () => route, 0)).toMatchObject({ status: "blocked" });
  document.querySelector("section")!.setAttribute("data-job-detail-id", "7");
  expect(await waitForDisplayedDestination(route, () => route, 0)).toMatchObject({ status: "displayed" });
});

it("acknowledges Tracker only when its mounted heading matches the requested route", async () => {
  document.body.innerHTML = "<main><h1>Resume studio</h1></main>";
  expect(
    await waitForDisplayedDestination(
      "/job-finder/applications?view=tracker",
      () => "/job-finder/review-queue/job/resume",
      0,
    ),
  ).toMatchObject({ status: "blocked" });
  expect(
    await waitForDisplayedDestination(
      "/job-finder/applications?view=tracker",
      () => "/job-finder/applications?view=tracker",
      0,
    ),
  ).toMatchObject({ status: "blocked" });
  document.body.innerHTML = "<main><h1>Tracker</h1></main>";
  expect(
    await waitForDisplayedDestination(
      "/job-finder/applications?view=tracker",
      () => "/job-finder/applications?view=tracker",
      0,
    ),
  ).toMatchObject({ status: "displayed", section: "tracker", overlay: "none" });
});

it("does not acknowledge a Profile query until the visible tab changes", async () => {
  document.body.innerHTML =
    '<main><div role="tabpanel" aria-labelledby="basics-tab"></div></main>';
  expect(
    await waitForDisplayedDestination(
      "/job-finder/profile?section=background",
      () => "/job-finder/profile?section=background",
      0,
    ),
  ).toMatchObject({ status: "blocked", section: "basics" });
  document
    .querySelector("[role=tabpanel]")!
    .setAttribute("aria-labelledby", "background-tab");
  expect(
    await waitForDisplayedDestination(
      "/job-finder/profile?section=background",
      () => "/job-finder/profile?section=background",
      0,
    ),
  ).toMatchObject({ status: "displayed", section: "background" });
});

it("returns a blocked route and dialog state when unsaved edits prevent navigation", async () => {
  document.body.innerHTML =
    '<main><h1>Resume studio</h1></main><div role="dialog">Save your changes</div>';
  expect(
    await waitForDisplayedDestination(
      "/job-finder/applications?view=tracker",
      () => "/job-finder/review-queue/job/resume",
      0,
    ),
  ).toMatchObject({
    status: "blocked",
    overlay: "dialog",
    displayedRoute: "/job-finder/review-queue/job/resume",
  });
});

it("does not acknowledge a route covered by the embedded browser", async () => {
  document.body.innerHTML = "<main><h1>Tracker</h1></main>";
  (window as unknown as { nestor: unknown }).nestor = {
    browser: {
      getState: () =>
        Promise.resolve({ phase: "ready", presentation: "expanded" }),
    },
  };
  try {
    expect(
      await waitForDisplayedDestination(
        "/job-finder/applications?view=tracker",
        () => "/job-finder/applications?view=tracker",
        0,
      ),
    ).toMatchObject({ status: "blocked", overlay: "browser" });
  } finally {
    delete (window as { nestor?: unknown }).nestor;
  }
});

it("does not mistake a Tracker heading in chat for the displayed app view", async () => {
  document.body.innerHTML =
    "<main><h1>Applications</h1></main><aside><h2>Tracker</h2></aside>";
  expect(
    await waitForDisplayedDestination(
      "/job-finder/applications?view=tracker",
      () => "/job-finder/applications?view=tracker",
      0,
    ),
  ).toMatchObject({ status: "blocked", section: null });
});
