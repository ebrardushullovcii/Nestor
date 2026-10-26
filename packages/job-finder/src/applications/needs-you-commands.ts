import { describeSavedFormAnswer } from "./questions";
import {
  UpsertSavedFormAnswerInputSchema,
  NEEDS_YOU_COMMANDS,
  type NeedsYouCommandName,
  type NeedsYouCommandInput,
  type NeedsYouCommandOutput,
} from "@nestor/contracts";
import type { ApplicationStore } from "@nestor/db/applications";

/** One command implementation for the screen, the sidebar and local checks. */
export function createNeedsYouCommandRunner(
  getStore: () => ApplicationStore,
  browser: {
    open: (id: number) => Promise<boolean>;
    check: (id: number) => Promise<boolean>;
    retry: (sourceId: number) => Promise<void>;
  },
) {
  const handlers: {
    [K in NeedsYouCommandName]: (
      input: NeedsYouCommandInput<K>,
    ) => NeedsYouCommandOutput<K> | Promise<NeedsYouCommandOutput<K>>;
  } = {
    application_needs: ({ id }) => getStore().needsYou.forApplication(id),
    list_needs_you: (input) => getStore().needsYou.list(input),
    needs_you_counts: () => getStore().needsYou.counts(),
    get_need: ({ id }) => getStore().needsYou.details(id),
    save_need_draft: (input) => getStore().needsYou.saveDraft(input),
    answer_need: (input) => {
      const { value, ...change } = getStore().needsYou.changeAnswers(() =>
        getStore().needsYou.answer(input),
      );
      return { ...value, ...change };
    },
    list_form_answers: (input) => getStore().needsYou.listAnswers(input),
    get_form_answer: ({ id }) => getStore().needsYou.savedAnswer(id),
    create_form_answer: (input) => {
      const { value, ...change } = getStore().needsYou.changeAnswers(() =>
        getStore().needsYou.remember({
          ...describeSavedFormAnswer(input.prompt, input.answer),
          prompt: input.prompt,
          scope: {},
        }),
      );
      return { ...value, ...change };
    },
    get_form_answer_by_key: (input) =>
      getStore().needsYou.getAnswerByKey(input),
    upsert_form_answer: (input) => {
      const { value, ...change } = getStore().needsYou.changeAnswers(() =>
        getStore().needsYou.remember(
          UpsertSavedFormAnswerInputSchema.parse(input),
        ),
      );
      return { ...value, ...change };
    },
    save_form_answer: (input) => {
      const { value: saved, ...change } = getStore().needsYou.changeAnswers(
        () => getStore().needsYou.saveAnswer(input),
      );
      return { saved, ...change };
    },
    forget_form_answers: (input) => {
      const { value: forgotten, ...change } = getStore().needsYou.changeAnswers(
        () => getStore().needsYou.forgetAnswers(input),
      );
      return { forgotten, ...change };
    },
    undo_form_answer_change: ({ undoId }) =>
      getStore().needsYou.undoAnswerChange(undoId),
    open_need: ({ id }) => browser.open(id),
    check_need: ({ id }) => browser.check(id),
    retry_need: async ({ id }) => {
      const source = getStore().needsYou.details(id)?.task.source;
      if (!source) return false;
      await browser.retry(source.id);
      return true;
    },
  };
  return async function run<K extends NeedsYouCommandName>(
    name: K,
    input: unknown,
  ): Promise<NeedsYouCommandOutput<K>> {
    if (!Object.hasOwn(NEEDS_YOU_COMMANDS, name))
      throw new Error("Unknown Needs you command.");
    const specification = NEEDS_YOU_COMMANDS[name];
    const execute = handlers[name] as (value: unknown) => unknown;
    return specification.output.parse(
      await execute(specification.input.parse(input)),
    ) as NeedsYouCommandOutput<K>;
  };
}
