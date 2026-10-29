import type { Page } from "playwright";
import { AssistantNeedsViewSchema } from "@nestor/contracts";
import type {
  NeedsYouCommandInput,
  NeedsYouCommandName,
  NeedsYouCommandOutput,
} from "@nestor/contracts";
import type { BuiltAppBatch } from "./built-app";
import { equalOutcome } from "./outcome";
import { savedAnswers } from "./answer-cases";

type AppWindow = {
  nestor: {
    needsYou: {
      run<K extends NeedsYouCommandName>(
        name: K,
        input: NeedsYouCommandInput<K>,
      ): Promise<NeedsYouCommandOutput<K>>;
    };
  };
};
const prefix = "Outcome view";
const prompt = (n: number) =>
  `${prefix} ${String(n).padStart(2, "0")}: preferred synthetic work arrangement?`;
const checkbox = (page: Page, n: number) =>
  page.getByRole("checkbox", { name: `Select ${prompt(n)}`, exact: true });
const region = (page: Page) =>
  page.getByRole("region", { name: "Saved form answers", exact: true });
const tabs = (page: Page) =>
  page.getByRole("group", { name: "Needs you view", exact: true });
const filter = (page: Page) =>
  page.getByRole("textbox", { name: "Filter Needs you", exact: true });

async function fixtures(page: Page) {
  const existing = new Set((await savedAnswers(page)).map((row) => row.prompt));
  for (let n = 1; n <= 55; n++) {
    if (existing.has(prompt(n))) continue;
    await page.evaluate(
      (p) =>
        (window as unknown as AppWindow).nestor.needsYou.run(
          "create_form_answer",
          { prompt: p, answer: "Remote" },
        ),
      prompt(n),
    );
  }
}
async function open(page: Page, tab: "tasks" | "saved" = "saved") {
  await page.getByRole("button", { name: /^Needs you:/u }).click();
  await tabs(page)
    .getByRole("button", {
      name: tab === "saved" ? /^Saved answers \d/u : /^Needs you \d/u,
    })
    .click();
  const clear = page.getByRole("checkbox", {
    name: "Clear the selection",
    exact: true,
  });
  if (await clear.isVisible()) await clear.click();
}
async function saved(page: Page) {
  await fixtures(page);
  await open(page);
  // A different filter resets a previous loaded window and selection. These
  // are preconditions, not the navigation requested from chat below.
  await filter(page).fill(`${prefix} absent`);
  await filter(page).fill(prefix);
  await checkbox(page, 55).waitFor();
  await checkbox(page, 54).waitFor();
}
async function actualSelection(
  page: Page,
  expected: readonly boolean[],
  selected: number,
) {
  return [
    equalOutcome(
      "visible_state",
      "Actual row ticks",
      "Needs you rendered row checkboxes 55, 54, 53",
      await Promise.all([55, 54, 53].map((n) => checkbox(page, n).isChecked())),
      expected,
    ),
    equalOutcome(
      "visible_state",
      "Actual selection count",
      "Needs you selection toolbar",
      await region(page)
        .locator("[data-selection-bar]")
        .innerText()
        .then((text) => /^\d+ selected/u.exec(text)?.[0]),
      `${selected} selected`,
    ),
  ];
}

/** Stored rows establish the list; each tested view change comes from chat. */
export function needsViewOutcomeCases(): BuiltAppBatch[] {
  return [
    ...(["tasks", "saved"] as const).map(
      (tab): BuiltAppBatch => ({
        id: `needs-view-${tab}`,
        prepare: async (page) => {
          await fixtures(page);
          await open(page, tab === "tasks" ? "saved" : "tasks");
        },
        request:
          tab === "tasks"
            ? "Show the Needs you tasks tab, not saved answers."
            : "Show Saved answers in Needs you.",
        actions: [
          {
            actionId: tab === "tasks" ? "needs_you.tasks" : "needs_you.answers",
            observe: async (page) => [
              equalOutcome(
                "visible_state",
                "Selected Needs you tab",
                "Needs you view segment",
                await tabs(page)
                  .getByRole("button", {
                    name:
                      tab === "tasks" ? /^Needs you \d/u : /^Saved answers \d/u,
                  })
                  .getAttribute("aria-pressed"),
                "true",
              ),
              equalOutcome(
                "visible_state",
                "Requested list rendered",
                "Needs you actual list region",
                await page
                  .getByRole("region", {
                    name:
                      tab === "tasks"
                        ? "Things needing you"
                        : "Saved form answers",
                    exact: true,
                  })
                  .isVisible(),
                true,
              ),
              ...(tab === "saved"
                ? [
                    equalOutcome(
                      "visible_state",
                      "Saved rows actually shown",
                      "Saved-answer row checkbox",
                      await checkbox(page, 55).isVisible(),
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
      id: "needs-view-kind",
      prepare: async (page) => open(page, "tasks"),
      request: "Show only CAPTCHA checks in the Needs you tasks tab.",
      actions: [
        {
          actionId: "needs_you.kind",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Kind filter displayed",
              "Needs you filter explanation",
              await page
                .getByText("Showing captcha checks only.", { exact: true })
                .isVisible(),
              true,
            ),
            equalOutcome(
              "visible_state",
              "Task list shown",
              "Things needing you region",
              await page
                .getByRole("region", {
                  name: "Things needing you",
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
      id: "needs-view-clear-filters",
      requires: ["needs-view-kind"],
      prepare: async (page) => {
        if (
          !(await page
            .getByRole("button", { name: "Show everything", exact: true })
            .isVisible())
        )
          throw Error(
            "Clearing filters requires the CAPTCHA filter to be active",
          );
        await filter(page).fill("Outcome absent task");
      },
      request: "Clear the kind and text filters in Needs you; show all tasks.",
      actions: [
        {
          actionId: "needs_you.clear_filters",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Kind restriction removed",
              "Needs you Show everything control",
              await page
                .getByRole("button", { name: "Show everything", exact: true })
                .isVisible(),
              false,
            ),
            equalOutcome(
              "visible_state",
              "Text filter cleared",
              "Filter Needs you input",
              await filter(page).inputValue(),
              "",
            ),
            equalOutcome(
              "visible_state",
              "Task list retained",
              "Things needing you region",
              await page
                .getByRole("region", {
                  name: "Things needing you",
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
      id: "needs-view-text",
      prepare: saved,
      request: `Show Saved answers in Needs you filtered to the exact text "${prefix} 55".`,
      actions: [
        {
          actionId: "needs_you.text",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Filter input updated",
              "Filter Needs you input",
              await filter(page).inputValue(),
              `${prefix} 55`,
            ),
            equalOutcome(
              "visible_state",
              "Matching answer rendered",
              "Saved-answer checkbox 55",
              await checkbox(page, 55).isVisible(),
              true,
            ),
            equalOutcome(
              "visible_state",
              "Other answer absent",
              "Saved-answer checkbox 54",
              await checkbox(page, 54).isVisible(),
              false,
            ),
          ],
        },
      ],
    },
    {
      id: "needs-view-focus",
      prepare: async (page) => {
        await saved(page);
        await checkbox(page, 55)
          .locator("xpath=ancestor::li")
          .getByRole("button")
          .click();
      },
      request: `In Needs you Saved answers, open the details of "${prompt(54)}" without editing its answer.`,
      actions: [
        {
          actionId: "needs_you.focus",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Actual detail question",
              "Saved answer detail textbox label",
              await page
                .getByRole("region", { name: "Saved answer", exact: true })
                .getByRole("textbox", { name: prompt(54), exact: true })
                .isVisible(),
              true,
            ),
            equalOutcome(
              "visible_state",
              "Answer is intact",
              "Saved answer detail textbox value",
              await page
                .getByRole("region", { name: "Saved answer", exact: true })
                .getByRole("textbox", { name: prompt(54), exact: true })
                .inputValue(),
              "Remote",
            ),
          ],
        },
      ],
    },
    {
      id: "needs-view-select-one",
      prepare: saved,
      request: `In Needs you Saved answers, tick only "${prompt(55)}". Keep the other answers unticked.`,
      actions: [
        {
          actionId: "needs_you.select_one",
          observe: (page) => actualSelection(page, [true, false, false], 1),
        },
      ],
    },
    {
      id: "needs-view-toggle-one",
      requires: ["needs-view-select-one"],
      prepare: async (page) => {
        if (
          !(await checkbox(page, 55).isChecked()) ||
          (await checkbox(page, 54).isChecked())
        )
          throw Error(
            "Unticking requires only the requested answer to start ticked",
          );
      },
      request: `Untick "${prompt(55)}" in Needs you. Keep the other rows unticked.`,
      actions: [
        {
          actionId: "needs_you.toggle_one",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Actual row ticks cleared",
              "Needs you row checkboxes",
              await Promise.all(
                [55, 54, 53].map((n) => checkbox(page, n).isChecked()),
              ),
              [false, false, false],
            ),
            equalOutcome(
              "visible_state",
              "Selection toolbar cleared",
              "Saved answers selection toolbar",
              await region(page).locator("[data-selection-bar]").isVisible(),
              false,
            ),
          ],
        },
      ],
    },
    ...(["range", "page", "all"] as const).map(
      (scope): BuiltAppBatch => ({
        id: `needs-view-select-${scope}`,
        prepare: async (page) => {
          await saved(page);
          if (await checkbox(page, 1).count())
            throw Error(
              "Paging proof needs the last five answers outside the loaded window",
            );
        },
        request:
          scope === "range"
            ? `In Needs you Saved answers, select the range from "${prompt(55)}" through "${prompt(53)}", including the middle row.`
            : scope === "page"
              ? "In Needs you Saved answers, tick the 50 currently loaded rows only; do not select the remaining page."
              : "In Needs you Saved answers, select all 55 answers matching the current filter, across pages.",
        actions: [
          {
            actionId: `needs_you.select_${scope}`,
            observe: async (page) => {
              const count = scope === "range" ? 3 : scope === "page" ? 50 : 55;
              const view = AssistantNeedsViewSchema.parse(
                JSON.parse(
                  (await page
                    .locator("[data-needs-list-state]")
                    .getAttribute("data-needs-list-state")) ?? "{}",
                ),
              );
              return [
                ...(await actualSelection(page, [true, true, true], count)),
                equalOutcome(
                  "visible_state",
                  "Only the intended loaded rows ticked",
                  "Actual checked row inputs",
                  await region(page)
                    .locator("li [role='checkbox'][aria-checked='true']")
                    .count(),
                  scope === "range" ? 3 : 50,
                ),
                equalOutcome(
                  "visible_state",
                  "Selection scope matches real ticks",
                  "Needs you all-matching mode with actual checkbox and count assertions",
                  view.all === true,
                  scope === "all",
                ),
              ];
            },
          },
        ],
      }),
    ),
    {
      id: "needs-view-exclude-selection",
      requires: ["needs-view-select-all"],
      prepare: async (page) => {
        if (
          !(await checkbox(page, 54).isChecked()) ||
          !(
            await region(page).locator("[data-selection-bar]").innerText()
          ).startsWith("55 selected")
        )
          throw Error(
            "An exception requires all 55 answers initially selected",
          );
      },
      request: `Keep every matching saved answer selected except "${prompt(54)}". Untick that one exception.`,
      actions: [
        {
          actionId: "needs_you.exclude_selection",
          observe: (page) => actualSelection(page, [true, false, true], 54),
        },
      ],
    },
    {
      id: "needs-view-clear-selection",
      requires: ["needs-view-exclude-selection"],
      prepare: async (page) => {
        if (
          !(await checkbox(page, 55).isChecked()) ||
          (await checkbox(page, 54).isChecked())
        )
          throw Error(
            "Clearing selection requires the preceding real selection and exception",
          );
      },
      request: "Clear the entire selection in Needs you Saved answers.",
      actions: [
        {
          actionId: "needs_you.clear_selection",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Every loaded row unticked",
              "Rendered saved-answer row checkbox inputs",
              await region(page)
                .locator("li [role='checkbox'][aria-checked='true']")
                .count(),
              0,
            ),
            equalOutcome(
              "visible_state",
              "Selection toolbar removed",
              "Saved answers selection toolbar",
              await region(page).locator("[data-selection-bar]").isVisible(),
              false,
            ),
          ],
        },
      ],
    },
  ];
}
