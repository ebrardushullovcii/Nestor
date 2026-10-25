import type { z } from "zod";
import type { AppCommandDefinition } from "@nestor/contracts";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolGroup,
  AssistantToolResult,
} from "./tool-kit";

type Catalog = Record<string, AppCommandDefinition>;

/** Schemas and descriptions come from the commands the screens call. */
export function assistantCommandTools<
  C extends Catalog,
  O extends { [K in keyof C]: unknown },
>(
  catalog: C,
  run: <K extends keyof C & string>(
    name: K,
    input: z.input<C[K]["input"]>,
  ) => O[K] | Promise<O[K]>,
  options: {
    group:
      | AssistantToolGroup
      | ((name: keyof C & string) => AssistantToolGroup);
    beforeRun?: (
      name: keyof C & string,
      input: unknown,
      context: AssistantToolContext,
    ) => void;
    replaces?: Partial<Record<keyof C, readonly string[]>>;
    before?: {
      [K in keyof C]?: (
        input: z.output<C[K]["input"]>,
        context: AssistantToolContext,
      ) => void | Promise<void>;
    };
    results?: {
      [K in keyof C]?: (
        value: O[K],
        input: z.output<C[K]["input"]>,
        context: AssistantToolContext,
      ) => AssistantToolResult | Promise<AssistantToolResult>;
    };
  },
): AssistantToolDefinition[] {
  const create = <K extends keyof C & string>(
    name: K,
  ): AssistantToolDefinition => {
    const command = catalog[name]!;
    const derived = zodToJsonSchema(command.input, {
      $refStrategy: "none",
    }) as Record<string, unknown>;
    return {
      name,
      ...(options.replaces?.[name] ? { replaces: options.replaces[name] } : {}),
      group:
        typeof options.group === "function"
          ? options.group(name)
          : options.group,
      description: command.description,
      input: command.input,
      parameters: {
        ...derived,
        type: "object",
        properties: (derived.properties ?? {}) as Record<string, unknown>,
      },
      effect: command.effect,
      label: () => name.replaceAll("_", " "),
      async execute(input: unknown, context) {
        context.session.assertCurrent();
        const parsed = command.input.parse(input);
        await options.before?.[name]?.(
          parsed as z.output<C[K]["input"]>,
          context,
        );
        options.beforeRun?.(name, parsed, context);
        const result = await run(name, parsed as z.input<C[K]["input"]>);
        return (
          options.results?.[name]?.(
            result,
            parsed as z.output<C[K]["input"]>,
            context,
          ) ?? {
            summary: `Completed: ${name.replaceAll("_", " ")}.`,
            data: result,
          }
        );
      },
    };
  };
  return Object.keys(catalog).map(create);
}
