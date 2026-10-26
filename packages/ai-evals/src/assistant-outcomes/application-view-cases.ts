import type { Page } from "playwright";
import { AssistantTrackerViewSchema } from "@nestor/contracts";
import type { BuiltAppBatch } from "./built-app";
import { equalOutcome } from "./outcome";

const checkbox = (page: Page, n: number) =>
  page.getByRole("checkbox", {
    name: `Select Replica ${n}, Application demo ${n}`,
    exact: true,
  });
const showAs = (page: Page) =>
  page.getByRole("group", { name: "Show as", exact: true });
async function applications(page: Page) {
  await page
    .getByRole("button", { name: "Applications", exact: true })
    .first()
    .click();
  await showAs(page).getByRole("button", { name: "List", exact: true }).click();
  const clear = page.getByRole("checkbox", {
    name: "Clear the selection",
    exact: true,
  });
  if (await clear.isVisible()) await clear.click();
  await page
    .getByRole("textbox", { name: "Find an application", exact: true })
    .fill("");
  await page
    .getByRole("group", { name: "Which applications", exact: true })
    .getByRole("button", { name: /^All\s+\d/u })
    .click();
  await checkbox(page, 1).waitFor();
  await checkbox(page, 2).waitFor();
}
async function selection(page: Page, expected: readonly [boolean, boolean]) {
  return [
    equalOutcome(
      "visible_state",
      "Actual row checkboxes",
      "Rendered Applications row checkbox states",
      [
        await checkbox(page, 1).isChecked(),
        await checkbox(page, 2).isChecked(),
      ],
      expected,
    ),
  ];
}

/** Navigation is credited only when the screen's actual controls change. */
export function applicationViewOutcomeCases(): BuiltAppBatch[] {
  return [
    {
      id: "applications-text",
      prepare: applications,
      request:
        "Show Applications filtered to the text Application demo 1, with all statuses.",
      actions: [
        {
          actionId: "applications.text",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Text filter control",
              "Find an application input",
              await page
                .getByRole("textbox", {
                  name: "Find an application",
                  exact: true,
                })
                .inputValue(),
              "Application demo 1",
            ),
            equalOutcome(
              "visible_state",
              "Matching row shown",
              "Application demo 1 checkbox visibility",
              await checkbox(page, 1).isVisible(),
              true,
            ),
            equalOutcome(
              "visible_state",
              "Nonmatching row hidden",
              "Application demo 2 checkbox visibility",
              await checkbox(page, 2).isVisible(),
              false,
            ),
          ],
        },
      ],
    },
    {
      id: "applications-filter",
      prepare: applications,
      request:
        "Show Applications with only Applied status, no text filter, list layout.",
      actions: [
        {
          actionId: "applications.filter",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Applied filter selected",
              "Which applications Applied button aria-pressed",
              await page
                .getByRole("group", { name: "Which applications", exact: true })
                .getByRole("button", { name: /^Applied\s+\d/u })
                .getAttribute("aria-pressed"),
              "true",
            ),
            equalOutcome(
              "visible_state",
              "All status filter unselected",
              "Which applications All button aria-pressed",
              await page
                .getByRole("group", { name: "Which applications", exact: true })
                .getByRole("button", { name: /^All\s+\d/u })
                .getAttribute("aria-pressed"),
              "false",
            ),
          ],
        },
      ],
    },
    {
      id: "applications-sort",
      prepare: async (page) => {
        await applications(page);
        await page
          .getByRole("combobox", { name: "Sort", exact: true })
          .selectOption("recent");
      },
      request: "Sort Applications by Next up, in list layout.",
      actions: [
        {
          actionId: "applications.sort",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Actual sort control",
              "Applications Sort select",
              await page
                .getByRole("combobox", { name: "Sort", exact: true })
                .inputValue(),
              "next",
            ),
          ],
        },
      ],
    },
    ...(["list", "board"] as const).map(
      (layout): BuiltAppBatch => ({
        id: `applications-${layout}`,
        prepare: async (page) => {
          await applications(page);
          if (layout === "list")
            await showAs(page)
              .getByRole("button", { name: "Board", exact: true })
              .click();
        },
        request: `Show Applications in ${layout} layout.`,
        actions: [
          {
            actionId: `applications.${layout}`,
            observe: async (page) => [
              equalOutcome(
                "visible_state",
                "Layout control",
                "Show as segment aria-pressed",
                await showAs(page)
                  .getByRole("button", {
                    name: layout === "list" ? "List" : "Board",
                    exact: true,
                  })
                  .getAttribute("aria-pressed"),
                "true",
              ),
              equalOutcome(
                "visible_state",
                "Actual board visibility",
                "Applications by stage region",
                await page
                  .getByRole("region", {
                    name: "Applications by stage",
                    exact: true,
                  })
                  .isVisible(),
                layout === "board",
              ),
              equalOutcome(
                "visible_state",
                "Actual list visibility",
                "Applications row checkbox",
                await checkbox(page, 1).isVisible(),
                layout === "list",
              ),
            ],
          },
        ],
      }),
    ),
    {
      id: "applications-density",
      prepare: async (page) => {
        await applications(page);
        await page
          .getByRole("button", { name: "Columns", exact: true })
          .click();
        await page
          .getByRole("group", { name: "Density", exact: true })
          .getByRole("button", { name: "Roomy", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Columns", exact: true })
          .click();
      },
      request: "Use compact density for the Applications list.",
      actions: [
        {
          actionId: "applications.density",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Rendered compact row padding",
              "Computed padding on Applications row button",
              await page
                .locator(
                  "[data-application-list-state] [data-list-row-id] button[aria-controls='list-detail']",
                )
                .first()
                .evaluate((element) => getComputedStyle(element).paddingTop),
              "6px",
            ),
          ],
        },
      ],
    },
    {
      id: "applications-focus",
      prepare: async (page) => {
        await applications(page);
        await page
          .locator("[data-list-row-id]")
          .filter({ has: checkbox(page, 2) })
          .getByRole("button")
          .click();
      },
      request:
        "Show Application demo 1 from Replica 1 in Applications. Open its details.",
      actions: [
        {
          actionId: "applications.focus",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Actual detail pane",
              "Visible Application to Replica 1 section heading",
              await page
                .getByRole("region", {
                  name: "Application to Replica 1",
                  exact: true,
                })
                .getByRole("heading", {
                  name: "Application demo 1",
                  exact: true,
                })
                .isVisible(),
              true,
            ),
          ],
        },
      ],
    },
    {
      id: "applications-select-one",
      prepare: applications,
      request:
        "Tick only Application demo 1 from Replica 1 in the Applications list. Do not change its status.",
      actions: [
        {
          actionId: "applications.select_one",
          observe: (page) => selection(page, [true, false]),
        },
      ],
    },
    {
      id: "applications-toggle-one",
      requires: ["applications-select-one"],
      prepare: async (page) => {
        if (
          !(await checkbox(page, 1).isChecked()) ||
          (await checkbox(page, 2).isChecked())
        )
          throw Error(
            "Toggle proof requires only the first row to start ticked",
          );
      },
      request:
        "Untick Application demo 1 in Applications. Keep the other row unticked.",
      actions: [
        {
          actionId: "applications.toggle_one",
          observe: (page) => selection(page, [false, false]),
        },
      ],
    },
    ...(["range", "page", "all"] as const).map(
      (scope): BuiltAppBatch => ({
        id: `applications-select-${scope}`,
        prepare: applications,
        request:
          scope === "range"
            ? "In the Applications list, select the range spanning Application demo 1 and Application demo 2, including both endpoints."
            : scope === "page"
              ? "Tick every currently displayed row in the Applications list, just this loaded page."
              : "Select all matching Applications, across pages. Keep every matching row selected.",
        actions: [
          {
            actionId: `applications.select_${scope}`,
            observe: async (page) => [
              ...(await selection(page, [true, true])),
              ...(scope === "all"
                ? [
                    equalOutcome(
                      "visible_state",
                      "All-matching selection mode",
                      "Applications list selection state plus real row checkboxes",
                      AssistantTrackerViewSchema.parse(
                        JSON.parse(
                          (await page
                            .locator("[data-application-list-state]")
                            .getAttribute("data-application-list-state")) ??
                            "{}",
                        ),
                      ).all,
                      true,
                    ),
                  ]
                : []),
            ],
          },
        ],
      }),
    ),
    {
      id: "applications-exclude-selection",
      requires: ["applications-select-all"],
      prepare: async (page) => {
        if (
          !(await checkbox(page, 1).isChecked()) ||
          !(await checkbox(page, 2).isChecked())
        )
          throw Error("Exclusion proof requires both rows initially ticked");
      },
      request:
        "Keep all matching Applications selected except Application demo 2 from Replica 2. Untick only that exception.",
      actions: [
        {
          actionId: "applications.exclude_selection",
          observe: (page) => selection(page, [true, false]),
        },
      ],
    },
    {
      id: "applications-clear-selection",
      requires: ["applications-exclude-selection"],
      prepare: async (page) => {
        if (
          !(await checkbox(page, 1).isChecked()) &&
          !(await checkbox(page, 2).isChecked())
        )
          throw Error("Clear selection requires an initially ticked row");
      },
      request: "Clear all selections in the Applications list.",
      actions: [
        {
          actionId: "applications.clear_selection",
          observe: (page) => selection(page, [false, false]),
        },
      ],
    },
  ];
}
