import type { z } from "zod";

/** Command metadata stays with the schema for every UI and MCP caller. */
export interface AppCommandDefinition {
  description: string;
  input: z.ZodType<unknown>;
  effect: "read" | "local_write" | "external";
}
