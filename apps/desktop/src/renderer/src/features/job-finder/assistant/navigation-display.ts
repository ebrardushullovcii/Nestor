import {
  AssistantJobViewSchema,
  AssistantNeedsViewSchema,
  AssistantTrackerViewSchema,
  matchesAssistantListView,
  type AssistantNavigationDisplay,
} from "@nestor/contracts";

function shownElements(selector: string): Element[] {
  return [...document.querySelectorAll(selector)].filter(
    (element) =>
      !element.closest(
        '[data-kept-route="hidden"], [hidden], [aria-hidden="true"]',
      ),
  );
}

/** A route request is complete only after its content is mounted and uncovered. */
export async function waitForDisplayedDestination(
  route: string,
  readRoute: () => string,
  timeoutMs = 2_000,
): Promise<AssistantNavigationDisplay> {
  const expected = new URL(route, "https://nestor.local");
  const deadline = Date.now() + timeoutMs;
  let display: AssistantNavigationDisplay = {
    displayedRoute: readRoute(),
    section: null,
    overlay: "none",
    status: "blocked",
    reason: "The requested page has not been displayed.",
  };
  do {
    const actual = new URL(readRoute(), "https://nestor.local");
    const panel = shownElements('[role="tabpanel"][aria-labelledby]')[0];
    const profileSection =
      panel?.getAttribute("aria-labelledby")?.replace(/-tab$/u, "") ?? null;
    const section =
      actual.pathname === "/job-finder/profile"
        ? profileSection
        : actual.pathname === "/job-finder/settings"
          ? (shownElements(
              'nav[aria-label="Settings sections"] a[aria-current="location"]',
            )[0]
              ?.getAttribute("href")
              ?.slice(1) ?? null)
          : null;
    const dialog = shownElements("[role]").find(
      (element) =>
        ["dialog", "alertdialog"].includes(
          element.getAttribute("role") ?? "",
        ) && !element.closest('[aria-hidden="true"], [hidden]'),
    );
    const chat =
      shownElements(
        '[data-assistant-narrow-switch] button[aria-pressed="true"]',
      )[0]?.textContent === "Chat";
    let overlay: AssistantNavigationDisplay["overlay"] = dialog
      ? "dialog"
      : chat
        ? "chat"
        : "none";
    try {
      const browser = await window.nestor?.browser?.getState();
      if (
        browser &&
        browser.phase !== "closed" &&
        browser.presentation !== "minimized"
      )
        overlay = "browser";
    } catch {
      return {
        ...display,
        reason: "The browser overlay could not be checked.",
      };
    }
    const matches =
      actual.pathname === expected.pathname &&
      (!expected.hash || actual.hash === expected.hash) &&
      [...expected.searchParams].every(
        ([key, value]) => actual.searchParams.get(key) === value,
      );
    const expectedSection =
      expected.pathname === "/job-finder/settings"
        ? expected.hash.slice(1) || null
        : expected.searchParams.get("section");
    const contentMounted = expected.pathname.includes("/resume")
      ? shownElements("[data-resume-studio-content-area]").length > 0
      : expected.pathname === "/job-finder/profile"
        ? Boolean(panel)
        : expected.pathname === "/job-finder/applications"
          ? shownElements("main h1, [role=main] h1").some(
              (heading) => heading.textContent?.trim() === "Applications",
            )
          : Boolean(
              shownElements(
                "main h1, main h2, [role=main] h1, [role=main] h2",
              )[0],
            );
    const jobId = expected.searchParams.get(
      expected.pathname === "/job-finder/discovery" ? "job" : "jobId",
    );
    const jobDisplayed =
      !jobId ||
      shownElements("main [data-job-detail-id]").some(
        (element) => element.getAttribute("data-job-detail-id") === jobId,
      );
    const resumeMode = expected.searchParams.get("resumeMode");
    const resumeModeDisplayed =
      !resumeMode ||
      shownElements("main [data-resume-mode]").some(
        (element) =>
          element.getAttribute("data-resume-mode") === resumeMode &&
          (!jobId || element.getAttribute("data-job-detail-id") === jobId),
      );
    let viewDisplayed = true;
    const trackerView = expected.pathname === "/job-finder/applications";
    const needsView = expected.pathname === "/job-finder/actions";
    const schema = needsView
      ? AssistantNeedsViewSchema
      : trackerView
        ? AssistantTrackerViewSchema
        : AssistantJobViewSchema;
    const view = expected.searchParams.get(
      needsView ? "needs" : trackerView ? "applications" : "jobs",
    );
    if (view) {
      try {
        const requested = schema.parse(JSON.parse(view));
        const stateAttribute = needsView
          ? "data-needs-list-state"
          : trackerView
            ? "data-application-list-state"
            : "data-job-list-state";
        const state = shownElements(
          `main [${stateAttribute}]`,
        )[0]?.getAttribute(stateAttribute);
        viewDisplayed = matchesAssistantListView(
          schema.parse(JSON.parse(state ?? "null")),
          requested,
        );
        if (needsView) {
          const focusId = AssistantNeedsViewSchema.parse(requested).focusId;
          if (focusId !== undefined)
            viewDisplayed &&= shownElements("main [data-needs-detail-id]").some(
              (element) =>
                element.getAttribute("data-needs-detail-id") ===
                String(focusId),
            );
        }
      } catch {
        viewDisplayed = false;
      }
    }
    display = {
      displayedRoute: `${actual.pathname}${actual.search}${actual.hash}`,
      section,
      overlay,
      status: "blocked",
      reason:
        overlay !== "none"
          ? "An overlay still covers the destination."
          : needsView &&
              view &&
              !viewDisplayed &&
              shownElements('main [data-needs-editing="true"]').length > 0
            ? "Needs you has unsaved answer text. Save it before changing its view."
            : "The requested page or section has not been displayed.",
    };
    if (
      matches &&
      contentMounted &&
      jobDisplayed &&
      resumeModeDisplayed &&
      viewDisplayed &&
      overlay === "none" &&
      (!expectedSection || section === expectedSection)
    )
      return { ...display, status: "displayed", reason: null };
    if (overlay === "dialog") return display;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  return display;
}
