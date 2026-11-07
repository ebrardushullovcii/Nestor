import type {
  AgentLoopTool,
  AgentLoopToolDefinition,
} from "@nestor/agent-runtime";
import {
  BrowserPointerInputSchema,
  BrowserScreenshotInputSchema,
} from "@nestor/contracts";
import type { ApplyFormObservation, ApplyPageHands } from "./apply/types";
import { describeObservation } from "./apply/apply-prompts";

export const VISUAL_PAGE_TOOL_DEFINITIONS: AgentLoopToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "screenshot",
      description:
        "See the current viewport as an image, including cross-origin frames. Omit frame for the whole page and a list of frame ids; name a returned frame id, frame name, or a control ref inside a frame to see that frame. Coordinates are CSS pixels in the top-level viewport, starting at (0,0) at its upper left. A frame image states its offset; add it to image-local coordinates for pointer. Scroll to see content outside the viewport.",
      parameters: {
        type: "object",
        properties: { frame: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pointer",
      description:
        "Click, drag, or hold at top-level viewport CSS coordinates from screenshot, including inside cross-origin frames and canvas puzzles. drag requires endX/endY; hold requires durationMs. Uses real browser input without showing or focusing the browser. Returns a fresh page observation. Follow the person's settings; use submit_application for a press you expect to send an application.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["click", "drag", "hold"] },
          x: { type: "number" },
          y: { type: "number" },
          endX: { type: "number" },
          endY: { type: "number" },
          durationMs: { type: "number", minimum: 0 },
        },
        required: ["action", "x", "y"],
        additionalProperties: false,
        allOf: [
          {
            if: {
              properties: { action: { const: "drag" } },
              required: ["action"],
            },
            then: { required: ["endX", "endY"] },
          },
          {
            if: {
              properties: { action: { const: "hold" } },
              required: ["action"],
            },
            then: { required: ["durationMs"] },
          },
        ],
      },
    },
  },
];

export function createVisualPageTools(
  hands: ApplyPageHands,
  observe: () => Promise<ApplyFormObservation>,
): AgentLoopTool[] {
  return VISUAL_PAGE_TOOL_DEFINITIONS.map((definition) => ({
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
      if (definition.function.name === "screenshot") {
        const parsed = BrowserScreenshotInputSchema.safeParse(args);
        if (!parsed.success)
          return {
            kind: "ok",
            status: "failed",
            content: parsed.error.message,
          };
        const input = parsed.data;
        if (!hands.screenshot)
          throw new Error("This browser has no screenshot mechanic.");
        const image = await hands.screenshot(input.frame);
        const label = `${image.label}. Image bounds in top-level viewport CSS pixels: ${JSON.stringify(image.bounds)}. Viewport: ${JSON.stringify(image.viewport)}. For pointer, add bounds.x/bounds.y to a position within this image. Frames: ${JSON.stringify(image.frames)}`;
        return {
          kind: "ok",
          content: label,
          images: [{ dataUrl: image.dataUrl, label }],
        };
      }
      const parsed = BrowserPointerInputSchema.safeParse(args);
      if (!parsed.success)
        return { kind: "ok", status: "failed", content: parsed.error.message };
      const input = parsed.data;
      if (!hands.pointer)
        throw new Error("This browser has no pointer mechanic.");
      const result = await hands.pointer(input);
      return {
        kind: "ok",
        status: result.ok ? "done" : "failed",
        progress: result.ok,
        content: `${result.ok ? `Pointer ${input.action} at (${input.x}, ${input.y}).` : result.error}${result.clickFacts ? `\nBrowser press facts: ${JSON.stringify(result.clickFacts)}` : ""}\n\n${describeObservation(await observe())}`,
      };
    },
  }));
}
