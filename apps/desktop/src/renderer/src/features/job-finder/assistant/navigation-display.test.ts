// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { waitForDisplayedDestination } from "./navigation-display";

afterEach(() => {
  document.body.innerHTML = "";
});

it("confirms Settings anchors from the active section, including repeated navigation", async () => {
  const route = "/job-finder/settings#settings-application-authority";
  document.body.innerHTML =
    '<main><h1>Settings</h1><nav aria-label="Settings sections"><a aria-current="location" href="#settings-app-device">App</a></nav></main>';
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "blocked", section: "settings-app-device" });
  document
    .querySelector("a")!
    .setAttribute("href", "#settings-application-authority");
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({
    status: "displayed",
    section: "settings-application-authority",
    displayedRoute: route,
  });
});

it("confirms the actual resume read/edit mode for the requested job", async () => {
  const route = "/job-finder/review-queue?jobId=7&resumeMode=edit";
  document.body.innerHTML =
    '<main><h1>Shortlisted</h1><section data-job-detail-id="7" data-resume-mode="read"></section></main>';
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "blocked" });
  document.querySelector("section")!.setAttribute("data-resume-mode", "edit");
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "displayed" });
});

it("explains when unsaved answer text blocks a Needs you view change", async () => {
  const route = `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify({ tab: "tasks" }))}`;
  document.body.innerHTML =
    '<main><h1>Needs you</h1><div data-needs-editing="true" data-needs-list-state=\'{"tab":"saved"}\'></div></main>';
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({
    status: "blocked",
    reason:
      "Needs you has unsaved answer text. Save it before changing its view.",
  });
});

it("confirms the Needs you tab, filter, selection and loaded focused answer together", async () => {
  const view = {
    tab: "saved",
    text: "notice",
    focusId: 7,
    selectedIds: [7],
    all: false,
  };
  const route = `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify(view))}`;
  document.body.innerHTML =
    '<main><h1>Needs you</h1><div data-needs-list-state="{}"></div><section></section></main>';
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "blocked" });
  document
    .querySelector("[data-needs-list-state]")!
    .setAttribute("data-needs-list-state", JSON.stringify(view));
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "blocked" });
  document.querySelector("section")!.setAttribute("data-needs-detail-id", "7");
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "displayed" });
});

it("waits for the requested job's actual details, even after the route changes", async () => {
  const route = "/job-finder/review-queue?jobId=7";
  document.body.innerHTML =
    '<main><h1>Shortlisted</h1><section data-job-detail-id="3"></section></main>';
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "blocked" });
  document.querySelector("section")!.setAttribute("data-job-detail-id", "7");
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "displayed" });
});

it("acknowledges filters and selection only after the list actually applies them", async () => {
  const view = {
    stage: "hidden",
    text: "Engineer",
    selectedIds: [7],
    all: false,
  };
  const route = `/job-finder/discovery?jobs=${encodeURIComponent(JSON.stringify(view))}`;
  document.body.innerHTML =
    '<main><h1>Find jobs</h1><div data-job-list-state="{}"></div></main>';
  const hidden = document.createElement("div");
  hidden.setAttribute("data-kept-route", "hidden");
  hidden.innerHTML =
    '<main><h1>Shortlisted</h1><div data-job-list-state="{}"></div></main>';
  document.body.prepend(hidden);
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "blocked" });
  document
    .querySelector("body > main [data-job-list-state]")!
    .setAttribute("data-job-list-state", JSON.stringify(view));
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "displayed" });
});

it("waits for the linked Application and its actual filter and selection", async () => {
  const view = { statuses: ["interview"], selectedIds: [7] };
  const route = `/job-finder/applications?jobId=7&applications=${encodeURIComponent(JSON.stringify(view))}`;
  document.body.innerHTML =
    '<main><h1>Applications</h1><section data-job-detail-id="3"></section><div data-application-list-state="{}"></div></main>';
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "blocked" });
  document.querySelector("section")!.setAttribute("data-job-detail-id", "7");
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "blocked" });
  document
    .querySelector("[data-application-list-state]")!
    .setAttribute("data-application-list-state", JSON.stringify(view));
  expect(
    await waitForDisplayedDestination(route, () => route, 0),
  ).toMatchObject({ status: "displayed", section: null });
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
