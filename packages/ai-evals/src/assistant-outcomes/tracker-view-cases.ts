import type { Page } from "playwright";
import type {
  TrackerCommandInput,
  TrackerCommandName,
  TrackerCommandOutput,
  TrackerView,
} from "@nestor/contracts";
import type { BuiltAppBatch } from "./built-app";
import { equalOutcome } from "./outcome";
import { answerObject } from "./read-cases";

type AppWindow = {
  nestor: {
    tracker: {
      run<K extends TrackerCommandName>(
        name: K,
        input: TrackerCommandInput<K>,
      ): Promise<TrackerCommandOutput<K>>;
    };
  };
};
const name = "Outcome follow-up view";
const otherName = "Outcome other view";
const filter = {
  statuses: [],
  tag: null,
  text: "Application demo 1",
  due: false,
  quietForDays: null,
};
const views = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (window as unknown as AppWindow).nestor.tracker.run(
          "list_views",
          {},
        )
      ).views,
  );
const options = (page: Page) =>
  page
    .getByRole("combobox", { name: "Saved views", exact: true })
    .locator("option")
    .allTextContents();
const checkbox = (page: Page, n: number) =>
  page.getByRole("checkbox", {
    name: `Select Replica ${n}, Application demo ${n}`,
    exact: true,
  });

async function applications(page: Page) {
  await page
    .getByRole("button", { name: "Applications", exact: true })
    .first()
    .click();
  await page
    .getByRole("group", { name: "Show as", exact: true })
    .getByRole("button", { name: "List", exact: true })
    .click();
  const clear = page.getByRole("checkbox", {
    name: "Clear the selection",
    exact: true,
  });
  if (await clear.isVisible()) await clear.click();
  await page
    .getByRole("group", { name: "Which applications", exact: true })
    .getByRole("button", { name: /^All\s+\d/u })
    .click();
  await page
    .getByRole("textbox", { name: "Find an application", exact: true })
    .fill("");
  await page
    .getByRole("combobox", { name: "Sort", exact: true })
    .selectOption("recent");
  await checkbox(page, 1).waitFor();
  await checkbox(page, 2).waitFor();
}

export function trackerViewOutcomeCases(): BuiltAppBatch[] {
  let preserved: TrackerView[] = [];
  return [
    {
      id: "tracker-save-view",
      prepare: async (page) => {
        await applications(page);
        if ((await views(page)).some((view) => view.name === name))
          throw Error("The named view must start absent");
      },
      request: `Save an Applications view named "${name}" with text filter "Application demo 1", all statuses, no tag, no due or quiet-age restriction, and Next up sorting. Show Applications so I can select that saved view.`,
      actions: [
        {
          actionId: "tracker.save_view",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Exact named filter and sort persisted",
              "tracker.list_views",
              (await views(page))
                .filter((view) => view.name === name)
                .map(({ name, filter, sort }) => ({ name, filter, sort })),
              [{ name, filter, sort: "next" }],
            ),
            equalOutcome(
              "visible_state",
              "Saved view offered on screen",
              "Applications Saved views select options",
              (await options(page)).filter((text) => text === name),
              [name],
            ),
          ],
        },
      ],
    },
    {
      id: "tracker-list-views",
      requires: ["tracker-save-view"],
      prepare: async (page) => {
        if ((await views(page)).some((view) => view.name === otherName))
          throw Error("Second synthetic view must start absent");
        await page.evaluate(
          (name) =>
            (window as unknown as AppWindow).nestor.tracker.run("save_view", {
              name,
              filter: { text: "Application demo 2" },
              sort: "recent",
            }),
          otherName,
        );
      },
      request:
        "Read all my saved Applications views. Return only JSON {views:[{id,name,filter,sort}]} with every view sorted by numeric id ascending. Do not change them.",
      actions: [
        {
          actionId: "tracker.list_views",
          observe: async (page, reply) => [
            equalOutcome(
              "data",
              "Complete actual view records returned",
              "Rendered chat JSON versus tracker.list_views",
              await answerObject(page, reply),
              { views: (await views(page)).sort((a, b) => a.id - b.id) },
            ),
          ],
        },
      ],
    },
    {
      id: "tracker-apply-view",
      requires: ["tracker-save-view"],
      prepare: async (page) => {
        await applications(page);
        if (!(await views(page)).some((view) => view.name === name))
          throw Error("Applying requires the saved view");
      },
      request: `Apply my saved Applications view "${name}" to the visible Applications list.`,
      actions: [
        {
          actionId: "tracker.apply_view",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Saved text filter applied",
              "Find an application input",
              await page
                .getByRole("textbox", {
                  name: "Find an application",
                  exact: true,
                })
                .inputValue(),
              filter.text,
            ),
            equalOutcome(
              "visible_state",
              "Saved sort applied",
              "Applications Sort control",
              await page
                .getByRole("combobox", { name: "Sort", exact: true })
                .inputValue(),
              "next",
            ),
            equalOutcome(
              "visible_state",
              "Matching application shown",
              "Replica 1 row checkbox",
              await checkbox(page, 1).isVisible(),
              true,
            ),
            equalOutcome(
              "visible_state",
              "Other application excluded",
              "Replica 2 row checkbox",
              await checkbox(page, 2).isVisible(),
              false,
            ),
          ],
        },
      ],
    },
    {
      id: "tracker-delete-view",
      requires: ["tracker-list-views", "tracker-apply-view"],
      prepare: async (page) => {
        const before = await views(page);
        if (!before.some((view) => view.name === name))
          throw Error("Deleting requires a real saved view");
        preserved = before.filter((view) => view.name !== name);
        if (!preserved.some((view) => view.name === otherName))
          throw Error("Deletion proof needs another view to preserve");
      },
      request: `Delete only the saved Applications view "${name}". Keep every other saved view. Show Applications with its updated saved-view choices.`,
      actions: [
        {
          actionId: "tracker.delete_view",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Requested saved view removed",
              "tracker.list_views",
              (await views(page)).some((view) => view.name === name),
              false,
            ),
            equalOutcome(
              "unchanged",
              "All other view records preserved",
              "tracker.list_views",
              (await views(page)).filter((view) => view.name !== name),
              preserved,
            ),
            equalOutcome(
              "visible_state",
              "Deleted view no longer offered",
              "Applications Saved views options",
              (await options(page)).includes(name),
              false,
            ),
            equalOutcome(
              "visible_state",
              "Preserved view still offered",
              "Applications Saved views options",
              (await options(page)).includes(otherName),
              true,
            ),
          ],
        },
      ],
    },
  ];
}
