import type { Page } from "playwright";
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
const rulePrompt = "Outcome picker rule: preferred synthetic shift?";
const choicePrompt = "Outcome picker choices: preferred synthetic shift?";
const choices = Array.from(
  { length: 12 },
  (_, n) => `Shift ${String(n + 1).padStart(2, "0")}`,
);
const detail = (page: Page) =>
  page.getByRole("region", { name: "Saved answer", exact: true });
const fallbackCheck = (page: Page) =>
  detail(page).getByRole("checkbox", {
    name: "Use a fallback when my answer is missing from a list",
    exact: true,
  });

async function read(page: Page, prompt: string) {
  const row = (await savedAnswers(page)).find(
    (answer) => answer.prompt === prompt,
  );
  if (!row) throw Error("Synthetic saved answer is missing");
  const full = await page.evaluate(
    (id) =>
      (window as unknown as AppWindow).nestor.needsYou.run("get_form_answer", {
        id,
      }),
    row.id,
  );
  if (!full) throw Error("Synthetic saved answer disappeared");
  return full;
}
async function fixtures(page: Page) {
  const rows = await savedAnswers(page);
  for (const prompt of [rulePrompt, choicePrompt]) {
    if (rows.some((row) => row.prompt === prompt)) continue;
    await page.evaluate(
      (input) =>
        (window as unknown as AppWindow).nestor.needsYou.run(
          "upsert_form_answer",
          input,
        ),
      {
        key:
          prompt === rulePrompt
            ? "outcome-picker-rule"
            : "outcome-picker-choices",
        scope: {},
        prompt,
        input: prompt === rulePrompt ? ("text" as const) : ("choice" as const),
        options: prompt === rulePrompt ? [] : choices,
        answer: prompt === rulePrompt ? "Day shift" : choices[0]!,
      },
    );
  }
}
async function open(page: Page, prompt: string) {
  await fixtures(page);
  await page.getByRole("button", { name: /^Needs you:/u }).click();
  await page
    .getByRole("group", { name: "Needs you view", exact: true })
    .getByRole("button", { name: /^Saved answers \d/u })
    .click();
  const clear = page.getByRole("checkbox", {
    name: "Clear the selection",
    exact: true,
  });
  if (await clear.isVisible()) await clear.click();
  await page
    .getByRole("textbox", { name: "Filter Needs you", exact: true })
    .fill("Outcome picker");
  // Remount this detail pane before the request, so its baseline is current;
  // the observer never navigates or refreshes to manufacture the result.
  for (const p of [prompt === rulePrompt ? choicePrompt : rulePrompt, prompt])
    await page
      .getByRole("checkbox", { name: `Select ${p}`, exact: true })
      .locator("xpath=ancestor::li")
      .locator("button[aria-controls='list-detail']")
      .click();
  await detail(page).getByText(prompt, { exact: true }).waitFor();
}
async function ruleResult(page: Page, fallback: string | null) {
  const current = await read(page, rulePrompt);
  return [
    equalOutcome(
      "data",
      "Exact saved fallback rule",
      "needsYou.get_form_answer.optionFallback",
      current.optionFallback ?? null,
      fallback === null
        ? null
        : {
            primary: "Day shift",
            fallback,
            whenNeitherOffered: "skip_application",
          },
    ),
    equalOutcome(
      "unchanged",
      "Primary answer preserved",
      "needsYou.get_form_answer.answer",
      current.answer,
      "Day shift",
    ),
    equalOutcome(
      "visible_state",
      "Rendered fallback switch",
      "Saved answer fallback checkbox",
      await fallbackCheck(page).isChecked(),
      fallback !== null,
    ),
    ...(fallback === null
      ? [
          equalOutcome(
            "visible_state",
            "Fallback editor removed",
            "Fallback option textbox",
            await detail(page)
              .getByRole("textbox", { name: "Fallback option", exact: true })
              .isVisible(),
            false,
          ),
        ]
      : [
          equalOutcome(
            "visible_state",
            "Rendered fallback text",
            "Fallback option textbox",
            await detail(page)
              .getByRole("textbox", { name: "Fallback option", exact: true })
              .inputValue(),
            fallback,
          ),
        ]),
  ];
}

/** Choice text is synthetic; no real candidate answer belongs in this eval. */
export function answerChoiceOutcomeCases(): BuiltAppBatch[] {
  return [
    ...(
      [
        {
          id: "add",
          before: null,
          after: "Evening shift",
          request: `For the saved answer "${rulePrompt}", keep Day shift as the primary answer. If it is missing from a list, use Evening shift. If neither is offered, skip that application. Save this rule and show the updated saved answer.`,
        },
        {
          id: "edit",
          before: "Evening shift",
          after: "Night shift",
          request: `Change only the fallback for the saved answer "${rulePrompt}" to Night shift. Keep Day shift primary and skip if neither is offered. Save it and show the updated answer.`,
        },
        {
          id: "remove",
          before: "Night shift",
          after: null,
          request: `Remove the fallback rule from the saved answer "${rulePrompt}". Keep Day shift as the answer. Save and show it with no fallback enabled.`,
        },
      ] as const
    ).map(
      (test, index): BuiltAppBatch => ({
        id: `answer-fallback-${test.id}`,
        ...(index
          ? { requires: [`answer-fallback-${index === 1 ? "add" : "edit"}`] }
          : {}),
        prepare: async (page) => {
          await open(page, rulePrompt);
          const current = await read(page, rulePrompt);
          if (
            current.answer !== "Day shift" ||
            (current.optionFallback?.fallback ?? null) !== test.before
          )
            throw Error(
              "Fallback mutation requires its distinct saved baseline",
            );
          if (
            (await fallbackCheck(page).isChecked()) !==
            (test.before !== null)
          )
            throw Error(
              "Fallback switch must display the baseline before chat changes it",
            );
        },
        request: test.request,
        actions: [
          {
            actionId: `answers.fallback_${test.id}`,
            observe: (page) => ruleResult(page, test.after),
          },
        ],
      }),
    ),
    {
      id: "answer-choice-search",
      prepare: async (page) => {
        await open(page, choicePrompt);
        if ((await read(page, choicePrompt)).answer !== choices[0])
          throw Error("Search needs the original choice to preserve");
        if (
          await detail(page)
            .getByRole("textbox", { name: "Search options", exact: true })
            .inputValue()
        )
          throw Error("Search must start empty");
      },
      request: `In the displayed saved answer "${choicePrompt}", search its offered options for Shift 12. Keep the saved answer unchanged; only filter the displayed choices.`,
      actions: [
        {
          actionId: "answers.option_search",
          observe: async (page) => [
            equalOutcome(
              "visible_state",
              "Options search text",
              "Saved answer Search options input",
              await detail(page)
                .getByRole("textbox", { name: "Search options", exact: true })
                .inputValue(),
              "Shift 12",
            ),
            equalOutcome(
              "visible_state",
              "Actual displayed choices narrowed",
              "Saved answer rendered radio values",
              await detail(page)
                .getByRole("radiogroup", { name: choicePrompt, exact: true })
                .getByRole("radio")
                .evaluateAll((elements) =>
                  elements.map((e) => (e as HTMLInputElement).value),
                ),
              ["Shift 12"],
            ),
            equalOutcome(
              "unchanged",
              "Stored answer preserved",
              "needsYou.get_form_answer.answer",
              (await read(page, choicePrompt)).answer,
              choices[0],
            ),
          ],
        },
      ],
    },
    {
      id: "answer-choice-choose",
      prepare: async (page) => {
        await open(page, choicePrompt);
        if (
          (await read(page, choicePrompt)).answer !== choices[0] ||
          !(await detail(page)
            .getByRole("radio", { name: choices[0], exact: true })
            .isChecked())
        )
          throw Error(
            "Choosing needs Shift 01 to be the original visible and saved answer",
          );
      },
      request: `Choose Shift 12 for the saved answer "${choicePrompt}" and save it. Show the saved answer with Shift 12 selected.`,
      actions: [
        {
          actionId: "answers.option_choose",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Requested choice saved",
              "needsYou.get_form_answer.answer",
              (await read(page, choicePrompt)).answer,
              "Shift 12",
            ),
            equalOutcome(
              "visible_state",
              "New choice visibly selected",
              "Saved answer Shift 12 radio",
              await detail(page)
                .getByRole("radio", { name: "Shift 12", exact: true })
                .isChecked(),
              true,
            ),
            equalOutcome(
              "visible_state",
              "Original choice visibly cleared",
              "Saved answer Shift 01 radio",
              await detail(page)
                .getByRole("radio", { name: choices[0]!, exact: true })
                .isChecked(),
              false,
            ),
          ],
        },
      ],
    },
  ];
}
