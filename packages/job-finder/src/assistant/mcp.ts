import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AssistantMessagePartSchema } from "@nestor/contracts";
import { z } from "zod";

import {
  AssistantToolError,
  type AssistantToolContext,
  type AssistantToolDefinition,
} from "./tool-kit";

const ResultSchema = z.object({
  summary: z.string(),
  data: z.unknown().optional(),
  status: z.enum(["done", "refused", "failed"]).optional(),
  parts: z.array(AssistantMessagePartSchema).optional(),
  canFinish: z.boolean().optional(),
  endTurn: z.object({ reason: z.string() }).optional(),
});
const ErrorSchema = z.object({
  error: z.object({
    kind: z.enum([
      "stale_revision",
      "invalid_input",
      "missing_information",
      "not_found",
      "transient",
      "uncertain_outcome",
      "refused",
      "conflict",
    ]),
    message: z.string(),
    current: z.unknown().optional(),
  }),
});

/** A turn's private MCP connection. No socket, login or renderer IPC surface. */
export async function connectAssistantMcp(
  definitions: readonly AssistantToolDefinition[],
  context: AssistantToolContext,
) {
  const byName = new Map(definitions.map((tool) => [tool.name, tool]));
  if (byName.size !== definitions.length)
    throw new Error("Duplicate app command names.");
  const server = new Server(
    { name: "nestor-job-finder", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: definitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
        annotations: {
          readOnlyHint: tool.effect === "read",
          openWorldHint: tool.effect === "external",
        },
      })),
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const definition = byName.get(params.name);
    try {
      if (!definition) throw new Error("Unknown app command.");
      const input: unknown = definition.input.parse(params.arguments ?? {});
      context.session.assertCurrent();
      const result = await definition.execute(input, context);
      return {
        content: [{ type: "text", text: result.summary }],
        structuredContent: ResultSchema.parse(result),
        isError: result.status === "failed" || result.status === "refused",
      };
    } catch (error) {
      if (context.session.signal.aborted) throw error;
      const message =
        error instanceof Error ? error.message : "The action failed.";
      const kind =
        error instanceof AssistantToolError
          ? error.kind
          : error instanceof z.ZodError
            ? "invalid_input"
            : /stale|changed since|conflict/iu.test(message)
              ? "stale_revision"
              : "transient";
      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          error: {
            kind,
            message,
            ...(error instanceof AssistantToolError
              ? { current: error.current }
              : {}),
          },
        },
        isError: true,
      };
    }
  });
  const client = new Client({ name: "nestor-assistant", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const close = async () => {
    await client.close();
    await server.close();
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    return {
      close,
      tools: listed.tools.map((tool): AssistantToolDefinition => {
        const definition = byName.get(tool.name)!;
        return {
          ...definition,
          description: tool.description ?? definition.description,
          parameters: {
            type: "object",
            properties: tool.inputSchema.properties ?? {},
            ...(tool.inputSchema.required
              ? { required: tool.inputSchema.required }
              : {}),
          },
          async execute(input: unknown) {
            const result = CallToolResultSchema.parse(
              await client.callTool(
                {
                  name: tool.name,
                  arguments: input as Record<string, unknown>,
                },
                undefined,
                { signal: context.session.signal },
              ),
            );
            const parsed = ResultSchema.safeParse(result.structuredContent);
            if (parsed.success)
              return {
                summary: parsed.data.summary,
                ...(parsed.data.data !== undefined
                  ? { data: parsed.data.data }
                  : {}),
                ...(parsed.data.status !== undefined
                  ? { status: parsed.data.status }
                  : {}),
                ...(parsed.data.parts ? { parts: parsed.data.parts } : {}),
                ...(parsed.data.endTurn
                  ? { endTurn: parsed.data.endTurn }
                  : {}),
                ...(parsed.data.canFinish !== undefined
                  ? { canFinish: parsed.data.canFinish }
                  : {}),
              };
            const failure = ErrorSchema.safeParse(result.structuredContent);
            if (failure.success)
              throw new AssistantToolError(
                failure.data.error.kind,
                failure.data.error.message,
                failure.data.error.current,
              );
            throw new AssistantToolError(
              "invalid_input",
              result.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n") || "The app command returned no result.",
            );
          },
        };
      }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
