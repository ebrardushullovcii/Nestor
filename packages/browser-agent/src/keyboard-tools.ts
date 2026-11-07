import type {
  AgentLoopTool,
  AgentLoopToolDefinition,
} from "@nestor/agent-runtime";
import { z } from "zod";
import { rememberVerificationSecret } from "@nestor/core/run-trace";
import { describeObservation } from "./apply/apply-prompts";
import type { ApplyFormObservation, ApplyPageHands } from "./apply/types";

export const KEYBOARD_TOOL_DEFINITIONS: AgentLoopToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "type_keys",
      description:
        "Focus a field and type text key by key with real browser keyboard events, appending at the caret. Use for autocompletes that search on keydown or keyup. Read the suggestions, then click one or use press_key. Use the vault tools for passwords.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string" }, text: { type: "string" } },
        required: ["ref", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description:
        "Press a keyboard key on an element or on the active page. Use for Enter, Escape, Tab, ArrowDown, ControlOrMeta+A, Backspace and keyboard-only controls. Omit ref to keep the current focus.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string" }, key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
];

const textInput = z.object({ ref: z.string(), text: z.string() }).strict();
const keyInput = z
  .object({ ref: z.string().optional(), key: z.string() })
  .strict();

export function createKeyboardTools(
  hands: Pick<ApplyPageHands, "typeKeys" | "pressKey">,
  observe: () => Promise<ApplyFormObservation>,
  describe: (observation: ApplyFormObservation) => string = describeObservation,
): AgentLoopTool[] {
  return KEYBOARD_TOOL_DEFINITIONS.map((definition) => ({
    definition,
    failureKind: "browser",
    execute: async (raw, context) => {
      context.signal?.throwIfAborted();
      let args: unknown;
      try {
        args = JSON.parse(raw || "{}");
      } catch {
        return {
          kind: "ok",
          status: "failed",
          content: "Tool arguments must be valid JSON.",
        };
      }
      let result;
      let lead: string;
      if (definition.function.name === "type_keys") {
        const parsed = textInput.safeParse(args);
        if (!parsed.success)
          return {
            kind: "ok",
            status: "failed",
            content: parsed.error.message,
          };
        if (!hands.typeKeys)
          throw new Error("This browser has no key-by-key typing mechanic.");
        const { ref, text } = parsed.data;
        const before = await observe();
        if (
          before.controls.find((c) => c.ref === ref)?.credentialRole ===
          "one_time_code"
        )
          rememberVerificationSecret(text);
        result = await hands.typeKeys(ref, text);
        lead = `Typed key by key into ${ref}.`;
      } else {
        const parsed = keyInput.safeParse(args);
        if (!parsed.success)
          return {
            kind: "ok",
            status: "failed",
            content: parsed.error.message,
          };
        if (!hands.pressKey)
          throw new Error("This browser has no key-press mechanic.");
        const { ref, key } = parsed.data;
        result = await hands.pressKey(ref, key);
        lead = `Pressed ${key}${ref ? ` on ${ref}` : ""}.`;
      }
      return {
        kind: "ok",
        status: result.ok ? "done" : "failed",
        progress: result.ok,
        content: `${result.ok ? lead : result.error}${result.controlState ? `\nControl state: ${JSON.stringify(result.controlState)}` : ""}\n\nThe page now:\n\n${describe(await observe())}`,
      };
    },
  }));
}
