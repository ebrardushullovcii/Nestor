import {
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
  },
) {
  const handlers: {
    [K in NeedsYouCommandName]: (
      input: NeedsYouCommandInput<K>,
    ) => NeedsYouCommandOutput<K> | Promise<NeedsYouCommandOutput<K>>;
  } = {
    list_needs_you: (input) => getStore().needsYou.list(input),
    needs_you_counts: () => getStore().needsYou.counts(),
    get_need: ({ id }) => getStore().needsYou.details(id),
    save_need_draft: (input) => getStore().needsYou.saveDraft(input),
    answer_need: (input) => getStore().needsYou.answer(input),
    list_form_answers: (input) => getStore().needsYou.listAnswers(input),
    get_form_answer: ({ id }) => getStore().needsYou.savedAnswer(id),
    save_form_answer: (input) => getStore().needsYou.saveAnswer(input),
    forget_form_answers: (input) => getStore().needsYou.forgetAnswers(input),
    open_need: ({ id }) => browser.open(id),
    check_need: ({ id }) => browser.check(id),
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
