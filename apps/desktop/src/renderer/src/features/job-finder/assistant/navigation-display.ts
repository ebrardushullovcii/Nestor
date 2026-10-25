import type { AssistantNavigationDisplay } from "@nestor/contracts";

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
    const panel = document.querySelector('[role="tabpanel"][aria-labelledby]');
    const profileSection =
      panel?.getAttribute("aria-labelledby")?.replace(/-tab$/u, "") ?? null;
    const trackerMounted = [
      ...document.querySelectorAll(
        "main h1, main h2, [role=main] h1, [role=main] h2",
      ),
    ].some((heading) => heading.textContent?.trim() === "Tracker");
    const section =
      actual.pathname === "/job-finder/profile"
        ? profileSection
        : trackerMounted
          ? "tracker"
          : null;
    const dialog = [...document.querySelectorAll("[role]")].find(
      (element) =>
        ["dialog", "alertdialog"].includes(
          element.getAttribute("role") ?? "",
        ) && !element.closest('[aria-hidden="true"], [hidden]'),
    );
    const chat =
      document.querySelector(
        '[data-assistant-narrow-switch] button[aria-pressed="true"]',
      )?.textContent === "Chat";
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
    const expectedSection =
      expected.searchParams.get("section") ??
      (expected.searchParams.get("view") === "tracker" ? "tracker" : null);
    const contentMounted = expected.pathname.includes("/resume")
      ? Boolean(document.querySelector("[data-resume-studio-content-area]"))
      : expected.pathname === "/job-finder/profile"
        ? Boolean(panel)
        : Boolean(
            document.querySelector(
              "main h1, main h2, [role=main] h1, [role=main] h2",
            ),
          );
    const jobId = expected.searchParams.get("jobId");
    const jobDisplayed = !jobId || (expected.pathname === "/job-finder/review-queue"
      ? [...document.querySelectorAll("main [data-job-detail-id]")].some((element) => element.getAttribute("data-job-detail-id") === jobId)
      : [...document.querySelectorAll("main [data-job-result-id], main [data-list-row-id]")].some((element) =>
          (element.getAttribute("data-job-result-id") ?? element.getAttribute("data-list-row-id")) === jobId &&
          Boolean(element.matches('[data-selected="true"], [aria-current="true"]') || element.querySelector('[data-selected="true"], [aria-current="true"]'))));
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
      overlay === "none" &&
      (!expectedSection || section === expectedSection)
    )
      return { ...display, status: "displayed", reason: null };
    if (overlay === "dialog") return display;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  return display;
}
