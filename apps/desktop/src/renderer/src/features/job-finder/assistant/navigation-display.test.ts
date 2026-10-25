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

it("acknowledges filters and selection only after the list actually applies them", async () => {
  const view = { stage: "hidden", text: "Engineer", selectedIds: [7], all: false };
  const route = `/job-finder/discovery?jobs=${encodeURIComponent(JSON.stringify(view))}`;
  document.body.innerHTML = '<main><h1>Find jobs</h1><div data-job-list-state="{}"></div></main>';
  const hidden = document.createElement("div");
  hidden.setAttribute("data-kept-route", "hidden");
  hidden.innerHTML = '<main><h1>Shortlisted</h1><div data-job-list-state="{}"></div></main>';
  document.body.prepend(hidden);
  expect(await waitForDisplayedDestination(route, () => route, 0)).toMatchObject({ status: "blocked" });
  document.querySelector("body > main [data-job-list-state]")!.setAttribute("data-job-list-state", JSON.stringify(view));
  expect(await waitForDisplayedDestination(route, () => route, 0)).toMatchObject({ status: "displayed" });
});

it("waits for the linked Application and its actual filter and selection", async () => {
  const view = { statuses: ["interview"], selectedIds: [7] };
  const route = `/job-finder/applications?jobId=7&applications=${encodeURIComponent(JSON.stringify(view))}`;
  document.body.innerHTML = '<main><h1>Applications</h1><section data-job-detail-id="3"></section><div data-application-list-state="{}"></div></main>';
  expect(await waitForDisplayedDestination(route, () => route, 0)).toMatchObject({ status: "blocked" });
  document.querySelector("section")!.setAttribute("data-job-detail-id", "7");
  expect(await waitForDisplayedDestination(route, () => route, 0)).toMatchObject({ status: "blocked" });
  document.querySelector("[data-application-list-state]")!.setAttribute("data-application-list-state", JSON.stringify(view));
  expect(await waitForDisplayedDestination(route, () => route, 0)).toMatchObject({ status: "displayed", section: null });
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
      "/job-finder/applications",
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
  document.body.innerHTML = "<main><h1>Applications</h1></main>";
  (window as unknown as { nestor: unknown }).nestor = {
    browser: {
      getState: () =>
        Promise.resolve({ phase: "ready", presentation: "expanded" }),
    },
  };
  try {
    expect(
      await waitForDisplayedDestination(
        "/job-finder/applications",
        () => "/job-finder/applications",
        0,
      ),
    ).toMatchObject({ status: "blocked", overlay: "browser" });
  } finally {
    delete (window as { nestor?: unknown }).nestor;
  }
});
