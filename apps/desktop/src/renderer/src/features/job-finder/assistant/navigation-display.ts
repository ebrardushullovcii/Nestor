import {
  AssistantJobViewSchema,
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
    const section = actual.pathname === "/job-finder/profile" ? profileSection : null;
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
      [...expected.searchParams].every(
        ([key, value]) => actual.searchParams.get(key) === value,
      );
    const expectedSection = expected.searchParams.get("section");
    const contentMounted = expected.pathname.includes("/resume")
      ? shownElements("[data-resume-studio-content-area]").length > 0
      : expected.pathname === "/job-finder/profile"
        ? Boolean(panel)
        : expected.pathname === "/job-finder/applications"
          ? shownElements("main h1, [role=main] h1").some((heading) => heading.textContent?.trim() === "Applications")
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
    let viewDisplayed = true;
    const trackerView = expected.pathname === "/job-finder/applications";
    const schema = trackerView ? AssistantTrackerViewSchema : AssistantJobViewSchema;
    const view = expected.searchParams.get(trackerView ? "applications" : "jobs");
    if (view) {
      try {
        const requested = schema.parse(JSON.parse(view));
        const state = shownElements(
          trackerView ? "main [data-application-list-state]" : "main [data-job-list-state]",
        )[0]?.getAttribute(trackerView ? "data-application-list-state" : "data-job-list-state");
        viewDisplayed = matchesAssistantListView(
          schema.parse(JSON.parse(state ?? "null")),
          requested,
        );
      } catch {
        viewDisplayed = false;
      }
    }
    display = {
      displayedRoute: `${actual.pathname}${actual.search}`,
      section,
      overlay,
      status: "blocked",
      reason:
        overlay !== "none"
          ? "An overlay still covers the destination."
          : "The requested page or section has not been displayed.",
    };
    if (
      matches &&
      contentMounted &&
      jobDisplayed &&
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
