import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  AssistantToolContext,
  AssistantToolDefinition,
  AssistantToolGroup,
  AssistantToolResult,
} from "./tool-kit";

type Catalog = Record<
  string,
  { description: string; input: z.ZodType<unknown> }
>;

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
    group: AssistantToolGroup;
    writes: readonly (keyof C)[];
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
      group: options.group,
      description: command.description,
      input: command.input,
      parameters: {
        ...derived,
        type: "object",
        properties: (derived.properties ?? {}) as Record<string, unknown>,
      },
      effect: options.writes.includes(name) ? "local_write" : "read",
      label: () => name.replaceAll("_", " "),
      async execute(input: unknown, context) {
        context.session.assertCurrent();
        const parsed = command.input.parse(input);
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
