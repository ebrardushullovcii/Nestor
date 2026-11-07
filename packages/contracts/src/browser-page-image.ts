import { z } from "zod";

/** Transient model input, never a file or authenticated browser state. */
export interface ModelImageInput {
  dataUrl: string;
  label: string;
}

export const BrowserScreenshotInputSchema = z
  .object({
    frame: z.string().optional(),
  })
  .strict();

export const BrowserPointerInputSchema = z
  .object({
    action: z.enum(["click", "drag", "hold"]),
    x: z.number().finite(),
    y: z.number().finite(),
    endX: z.number().finite().optional(),
    endY: z.number().finite().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.action === "drag" &&
      (input.endX === undefined || input.endY === undefined)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "drag requires endX and endY",
      });
    if (input.action === "hold" && input.durationMs === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hold requires durationMs",
      });
  });
export type BrowserPointerInput = z.infer<typeof BrowserPointerInputSchema>;
export interface BrowserPageImage extends ModelImageInput {
  /** The image bounds in CSS pixels relative to the top-level viewport. */
  bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  frames: Array<{
    id: string;
    name: string;
    origin: string;
    bounds: BrowserPageImage["bounds"] | null;
  }>;
}
