import type {
  NeedsYouCommandName,
  NeedsYouCommandInput,
  NeedsYouCommandOutput,
  SavedFormAnswer,
  SavedFormAnswerSummary,
  SavedFormAnswersPage,
} from "@nestor/contracts";
import type { Page } from "playwright";
import {
  currentRequestChanges,
  type BuiltAppBatch,
  type BuiltAppEvidence,
} from "./built-app";
import { equalOutcome } from "./outcome";
import { answerObject } from "./read-cases";

interface NeedsBridge {
  run<K extends NeedsYouCommandName>(
    name: K,
    input: NeedsYouCommandInput<K>,
  ): Promise<NeedsYouCommandOutput<K>>;
}
type AppWindow = { nestor: { needsYou: NeedsBridge } };
const prompts = [
  "Outcome saved A: preferred work arrangement?",
  "Outcome saved B: notice period in days?",
  "Outcome saved C: preferred weekly hours?",
  "Outcome saved D: preferred contact channel?",
] as const;
const values = ["Hybrid", "15", "32", "Email"] as const;
export const savedAnswers = (page: Page) =>
  page.evaluate(async () => {
    const bridge = (window as unknown as AppWindow).nestor.needsYou;
    const rows: SavedFormAnswerSummary[] = [];
    let after = 0;
    for (;;) {
      const result: SavedFormAnswersPage = await bridge.run(
        "list_form_answers",
        { after, limit: 200 },
      );
      rows.push(...result.rows);
      if (result.nextCursor === null) return rows;
      after = result.nextCursor;
    }
  });
const fullAnswer = async (page: Page, prompt: string) => {
  const row = (await savedAnswers(page)).find(
    (answer) => answer.prompt === prompt,
  );
  return row
    ? page.evaluate(
        (id) =>
          (window as unknown as AppWindow).nestor.needsYou.run(
            "get_form_answer",
            { id },
          ),
        row.id,
      )
    : null;
};
const stableAnswer = (value: SavedFormAnswer | null | undefined) =>
  value
    ? Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "updatedAt"),
      )
    : null;
const answerCheckbox = (page: Page, prompt: string) =>
  page.getByRole("checkbox", { name: `Select ${prompt}`, exact: true });
async function openAnswers(page: Page, text = "Outcome saved") {
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
    .fill(text);
}
function answerReceipt(
  reply: Parameters<BuiltAppBatch["actions"][number]["observe"]>[1],
  evidence: BuiltAppEvidence,
) {
  const ids = new Set(
    currentRequestChanges(reply).map((part) => part.receiptId),
  );
  return evidence.receipts.find(
    (receipt) =>
      ids.has(receipt.id) &&
      receipt.undoCommand?.name === "undo_form_answer_change",
  );
}

export function answerOutcomeCases(): BuiltAppBatch[] {
  let removed: SavedFormAnswer | null = null;
  let removalReceiptId: string | undefined;
  let beforeOthers: SavedFormAnswerSummary[] = [];
  let beforeAllOthers: SavedFormAnswerSummary[] = [];
  let editBaseline: SavedFormAnswer | null = null;
  return [
    {
      id: "answers-add",
      prepare: async (page) => {
        if (
          (await savedAnswers(page)).some((row) =>
            prompts.includes(row.prompt as (typeof prompts)[number]),
          )
        )
          throw Error("Saved-answer fixtures must start absent");
      },
      request: `Save these four exact questions and supplied synthetic answers for reuse in future forms, without answering or sending any application: ${JSON.stringify(prompts.map((prompt, index) => ({ prompt, answer: values[index] })))}`,
      actions: [
        {
          actionId: "answers.add",
          observe: async (page) => [
            equalOutcome(
              "data",
              "All four reusable answers saved",
              "needsYou.get_form_answer",
              await Promise.all(
                prompts.map(async (prompt) => {
                  const row = await fullAnswer(page, prompt);
                  return row
                    ? { prompt: row.prompt, answer: row.answer }
                    : null;
                }),
              ),
              prompts.map((prompt, index) => ({
                prompt,
                answer: values[index],
              })),
            ),
          ],
        },
      ],
    },
    {
      id: "answers-read",
      requires: ["answers-add"],
      request: `Read my saved answer to "${prompts[0]}". Return only JSON with prompt, answer and scope. Do not change it.`,
      actions: [
        {
          actionId: "answers.read",
          observe: async (page, reply) => {
            const current = await fullAnswer(page, prompts[0]);
            return [
              equalOutcome(
                "data",
                "Exact answer and scope returned to the person",
                "Rendered Assistant answer versus needsYou.get_form_answer",
                await answerObject(page, reply),
                current
                  ? {
                      prompt: current.prompt,
                      answer: current.answer,
                      scope: current.scope,
                    }
                  : null,
              ),
            ];
          },
        },
      ],
    },
    {
      id: "answers-edit",
      requires: ["answers-add"],
      prepare: async (page) => {
        editBaseline = await fullAnswer(page, prompts[0]);
        if (!editBaseline || editBaseline.answer !== "Hybrid")
          throw Error("Answer edit requires the original Hybrid answer");
      },
      request: `Change only the saved answer to "${prompts[0]}" from Hybrid to Remote. Keep the question and scope unchanged.`,
      actions: [
        {
          actionId: "answers.edit",
          observe: async (page) => [
            equalOutcome(
              "unchanged",
              "Question, scope and other answer metadata preserved",
              "needsYou.get_form_answer excluding the change timestamp",
              stableAnswer(await fullAnswer(page, prompts[0])),
              {
                ...stableAnswer(editBaseline),
                answer: "Remote",
                preview: "Remote",
              },
            ),
            equalOutcome(
              "data",
              "Requested answer updated",
              "needsYou.get_form_answer.answer",
              (await fullAnswer(page, prompts[0]))?.answer,
              "Remote",
            ),
            equalOutcome(
              "unchanged",
              "Other saved answers retained",
              "needsYou.get_form_answer",
              await Promise.all(
                prompts
                  .slice(1)
                  .map(
                    async (prompt) => (await fullAnswer(page, prompt))?.answer,
                  ),
              ),
              values.slice(1),
            ),
          ],
        },
      ],
    },
    {
      id: "answers-forget-one",
      requires: ["answers-edit"],
      prepare: async (page) => {
        removed = await fullAnswer(page, prompts[0]);
        if (!removed) throw Error("The answer to forget must exist");
        beforeOthers = (await savedAnswers(page)).filter(
          (row) => row.prompt !== prompts[0],
        );
      },
      request: `Forget only my saved answer to "${prompts[0]}". Preserve all other saved answers.`,
      actions: [
        {
          actionId: "answers.forget_one",
          observe: async (page, reply, evidence) => {
            removalReceiptId = answerReceipt(reply, evidence)?.id;
            return [
              equalOutcome(
                "data",
                "Requested answer absent",
                "needsYou.get_form_answer",
                await fullAnswer(page, prompts[0]),
                null,
              ),
              equalOutcome(
                "unchanged",
                "Other saved answers unchanged",
                "needsYou.list_form_answers",
                (await savedAnswers(page)).filter(
                  (row) => row.prompt !== prompts[0],
                ),
                beforeOthers,
              ),
              equalOutcome(
                "data",
                "Forget action has an Undo receipt",
                "Current persisted Assistant receipt",
                Boolean(removalReceiptId),
                true,
              ),
            ];
          },
        },
      ],
    },
    {
      id: "answers-undo-forget",
      requires: ["answers-forget-one"],
      request:
        "Undo only the saved-answer removal in your previous reply. Restore its exact answer, question and scope.",
      actions: [
        {
          actionId: "answers.undo",
          observe: async (page, _reply, evidence) => [
            equalOutcome(
              "data",
              "Saved answer content, scope and identity restored",
              "needsYou.get_form_answer, excluding the change timestamp",
              stableAnswer(await fullAnswer(page, prompts[0])),
              stableAnswer(removed),
            ),
            equalOutcome(
              "data",
              "Original removal receipt undone",
              "Persisted Assistant receipt status",
              evidence.receipts.find(
                (receipt) => receipt.id === removalReceiptId,
              )?.status,
              "undone",
            ),
          ],
        },
      ],
    },
    {
      id: "answers-forget-selected",
      requires: ["answers-undo-forget"],
      prepare: async (page) => {
        await openAnswers(page);
        await answerCheckbox(page, prompts[1]).check();
        await answerCheckbox(page, prompts[2]).check();
        if (
          (await answerCheckbox(page, prompts[0]).isChecked()) ||
          (await answerCheckbox(page, prompts[3]).isChecked())
        )
          throw Error("Only B and C may start ticked");
      },
      // The request intentionally names no IDs: it must use the real on-screen
      // selection, including the distinction from the open detail record.
      request:
        "Forget the selected saved answers. Preserve every unticked answer.",
      actions: [
        {
          actionId: "answers.forget_selected",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Only the actual selected answers forgotten",
              "needsYou.get_form_answer",
              await Promise.all(
                prompts.map(async (prompt) =>
                  Boolean(await fullAnswer(page, prompt)),
                ),
              ),
              [true, false, false, true],
            ),
          ],
        },
      ],
    },
    {
      id: "answers-forget-all",
      prepare: async (page) => {
        await page.evaluate(async () => {
          const bridge = (window as unknown as AppWindow).nestor.needsYou;
          await bridge.run("create_form_answer", {
            prompt: "Outcome outside-filter: keep this answer?",
            answer: "Keep",
          });
          for (const n of [1, 2])
            await bridge.run("create_form_answer", {
              prompt: `Outcome forget-all ${n}: synthetic question?`,
              answer: `Synthetic answer ${n}`,
            });
        });
        beforeAllOthers = (await savedAnswers(page)).filter(
          (row) => !row.prompt.startsWith("Outcome forget-all"),
        );
        if (!beforeAllOthers.length)
          throw Error(
            "Filtered forgetting needs a real answer outside the filter to preserve",
          );
        await openAnswers(page, "Outcome forget-all");
        await page
          .getByRole("checkbox", { name: /^Select all 2 answers$/u })
          .check();
      },
      request:
        "Forget all matching saved answers in this filtered view. Preserve answers outside this filter.",
      actions: [
        {
          actionId: "answers.forget_all",
          observe: async (page) => [
            equalOutcome(
              "data",
              "All matching answers absent",
              "needsYou.list_form_answers",
              (await savedAnswers(page)).filter((row) =>
                row.prompt.startsWith("Outcome forget-all"),
              ).length,
              0,
            ),
            equalOutcome(
              "unchanged",
              "Every answer outside the filter preserved",
              "needsYou.list_form_answers",
              (await savedAnswers(page)).filter(
                (row) => !row.prompt.startsWith("Outcome forget-all"),
              ),
              beforeAllOthers,
            ),
          ],
        },
      ],
    },
  ];
}
