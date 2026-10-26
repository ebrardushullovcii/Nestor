import type { Page } from "playwright";
import { equalOutcome } from "./outcome";
import type { BuiltAppBatch } from "./built-app";

const route = (page: Page) => page.evaluate(() => location.hash.slice(1));
const routePath = async (page: Page) => (await route(page)).split(/[?#]/u)[0];
type DialogTraceWindow = Window & {
  assistantOutcomeDialogTrace?: {
    states: boolean[];
    observer: MutationObserver;
  };
};

/** Synthetic Profile must already be set up, with the Assistant visible. */
export function navigationOutcomeCases(): BuiltAppBatch[] {
  const screens = [
    ["home", "Home", "/job-finder/home"],
    ["profile", "Profile", "/job-finder/profile"],
    ["discovery", "Find jobs", "/job-finder/discovery"],
    ["shortlisted", "Shortlisted", "/job-finder/review-queue"],
    ["applications", "Applications", "/job-finder/applications"],
    ["needs_you", "Needs you", "/job-finder/actions"],
    ["settings", "Settings", "/job-finder/settings"],
  ] as const;
  const cases: BuiltAppBatch[] = screens.map(([id, label, destination]) => ({
    id: `open-${id}`,
    request: `Show ${label} in the app.`,
    prepare: async (page) => {
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", {
          name: id === "home" ? "Profile" : "Home",
          exact: false,
        })
        .filter({ has: page.locator("svg") })
        .first()
        .click();
    },
    actions: [
      {
        actionId: `navigation.${id}`,
        observe: async (page) => [
          equalOutcome(
            "visible_state",
            "Displayed route",
            "window.location.hash",
            await routePath(page),
            destination,
          ),
          equalOutcome(
            "visible_state",
            "Screen heading",
            "Visible main heading",
            await page
              .locator("main:visible")
              .getByRole("heading", { name: label, exact: true })
              .first()
              .isVisible(),
            true,
          ),
        ],
      },
    ],
  }));
  for (const [section, label] of [
    ["basics", "Basics"],
    ["experience", "Work history"],
    ["background", "Background"],
    ["preferences", "Preferences"],
    ["sources", "Job sources"],
    ["files", "Files"],
  ] as const)
    cases.push({
      id: `profile-tab-${section}`,
      request: `Show the Profile ${label} tab.`,
      prepare: async (page) => {
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", {
            name: "Profile",
            exact: true,
          })
          .click();
        await page
          .locator(`#${section === "basics" ? "experience" : "basics"}-tab`)
          .click();
      },
      actions: [
        {
          actionId: `navigation.profile.${section}`,
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Profile destination",
              "window.location.hash",
              await routePath(page),
              "/job-finder/profile",
            ),
            equalOutcome(
              "visible_state",
              "Selected tab",
              `Visible ${label} tab aria-selected`,
              await page
                .locator(`#${section}-tab`)
                .getAttribute("aria-selected"),
              "true",
            ),
          ],
        },
      ],
    });
  for (const [section, label] of [
    ["app-device", "App & device"],
    ["ai-behavior", "AI behavior"],
    ["application-defaults", "Resume look"],
    ["application-authority", "Applying"],
    ["workspace-behavior", "Browser & saved jobs"],
    ["diagnostics", "Diagnostics"],
    ["danger-zone", "Delete everything"],
  ] as const)
    cases.push({
      id: `settings-section-${section}`,
      request: `Show Settings, ${label} section. Do not change any settings.`,
      actions: [
        {
          actionId: `navigation.settings.${section}`,
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Settings destination",
              "window.location.hash",
              await routePath(page),
              "/job-finder/settings",
            ),
            equalOutcome(
              "visible_state",
              "Section receives focus",
              "document.activeElement.id",
              await page.evaluate(() => document.activeElement?.id ?? null),
              `settings-${section}`,
            ),
          ],
        },
      ],
    });
  return cases;
}

export function shellOutcomeCases(): BuiltAppBatch[] {
  return [
    ...([false, true] as const).map(
      (collapsed): BuiltAppBatch => ({
        id: `sidebar-${collapsed ? "collapse" : "expand"}`,
        prepare: async (page) => {
          const current = await page
            .locator("[data-job-finder-shell]")
            .getAttribute("data-sidebar-collapsed");
          if (current === String(collapsed))
            await page
              .getByRole("button", {
                name: collapsed ? "Expand sidebar" : "Collapse sidebar",
                exact: true,
              })
              .click();
        },
        request: `${collapsed ? "Collapse" : "Expand"} the left sidebar.`,
        actions: [
          {
            actionId: `shell.sidebar_${collapsed ? "collapse" : "expand"}`,
            observe: async (page) => [
              equalOutcome(
                "visible_state",
                "Sidebar state",
                "Shell data-sidebar-collapsed",
                await page
                  .locator("[data-job-finder-shell]")
                  .getAttribute("data-sidebar-collapsed"),
                String(collapsed),
              ),
              equalOutcome(
                "data",
                "Saved sidebar preference",
                "localStorage sidebar-collapsed.v1",
                await page.evaluate(() =>
                  localStorage.getItem(
                    "nestor.job-finder.sidebar-collapsed.v1",
                  ),
                ),
                String(collapsed),
              ),
            ],
          },
        ],
      }),
    ),
    {
      id: "shortcuts-open-close",
      // Submit while the composer is reachable. The requested second action
      // must then work while the real modal is covering it.
      request:
        "Open keyboard shortcut help, wait for it to be visible, then close it again. Perform both actions.",
      prepare: (page) =>
        page.evaluate(() => {
          const target = window as DialogTraceWindow;
          target.assistantOutcomeDialogTrace?.observer.disconnect();
          const states: boolean[] = [];
          const record = () => {
            const element = document.querySelector(
              "[data-job-finder-shortcuts-dialog]",
            );
            const visible =
              element !== null &&
              element.getBoundingClientRect().height > 0 &&
              getComputedStyle(element).visibility !== "hidden";
            if (states.at(-1) !== visible) states.push(visible);
          };
          const observer = new MutationObserver(record);
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
          });
          target.assistantOutcomeDialogTrace = { states, observer };
          record();
        }),
      actions: [
        {
          actionId: "shell.shortcuts_open",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Shortcut dialog actually opened",
              "DOM visibility transition trace",
              await page.evaluate(
                () =>
                  (
                    window as DialogTraceWindow
                  ).assistantOutcomeDialogTrace?.states.includes(true) ?? false,
              ),
              true,
            ),
          ],
        },
        {
          actionId: "shell.shortcuts_close",
          observe: async (page) => {
            const states = await page.evaluate(() => {
              const trace = (window as DialogTraceWindow)
                .assistantOutcomeDialogTrace;
              trace?.observer.disconnect();
              return trace?.states ?? [];
            });
            return [
              equalOutcome(
                "visible_state",
                "Opened dialog then closed",
                "DOM visibility transition trace",
                states,
                [false, true, false],
              ),
              equalOutcome(
                "visible_state",
                "Shortcut dialog now hidden",
                "Keyboard shortcuts dialog visibility",
                await page
                  .getByRole("dialog", { name: "Keyboard shortcuts" })
                  .isVisible(),
                false,
              ),
            ];
          },
        },
      ],
    },
  ];
}
