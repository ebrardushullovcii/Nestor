import type {
  BrowserPageImage,
  BrowserPointerInput,
  ApplyWriteResult,
} from "@nestor/contracts";
import type { Frame, Page } from "playwright";
import { captureModelPageImage } from "./trace-page";
import { controlRefFrame } from "./page-control-refs";
import { watchPagePress } from "./page-press-facts";

const frameIds = new WeakMap<Page, Map<Frame, string>>();
function idsFor(page: Page): Map<Frame, string> {
  const ids = frameIds.get(page) ?? new Map<Frame, string>();
  frameIds.set(page, ids);
  for (const frame of page.frames())
    if (frame !== page.mainFrame() && !ids.has(frame))
      ids.set(frame, `frame${ids.size + 1}`);
  return ids;
}

export async function screenshotPage(
  page: Page,
  name?: string,
): Promise<BrowserPageImage> {
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  const ids = idsFor(page);
  const frames = await Promise.all(
    page
      .frames()
      .filter((frame) => frame !== page.mainFrame())
      .map(async (frame) => {
        const element = await frame.frameElement();
        const bounds = await element.boundingBox();
        await element.dispose();
        let origin = "null";
        try {
          origin = new URL(frame.url()).origin;
        } catch {
          /* Opaque document. */
        }
        return { id: ids.get(frame)!, name: frame.name(), origin, bounds };
      }),
  );
  let bounds = { x: 0, y: 0, ...viewport };
  if (name && name !== "main") {
    const bound = controlRefFrame(page, name);
    const matches = page
      .frames()
      .filter(
        (frame) =>
          frame !== page.mainFrame() &&
          (frame === bound || ids.get(frame) === name || frame.name() === name),
      );
    if (matches.length !== 1)
      throw new Error(
        "Frame missing or ambiguous; take a whole-page screenshot again and use its frame id.",
      );
    const box = frames.find(
      (frame) => frame.id === ids.get(matches[0]!),
    )?.bounds;
    if (!box) throw new Error("Frame is no longer visible; observe again.");
    const x = Math.max(0, Math.floor(box.x)),
      y = Math.max(0, Math.floor(box.y));
    bounds = {
      x,
      y,
      width: Math.min(viewport.width, Math.ceil(box.x + box.width)) - x,
      height: Math.min(viewport.height, Math.ceil(box.y + box.height)) - y,
    };
    if (bounds.width <= 0 || bounds.height <= 0)
      throw new Error("Frame is outside the viewport; scroll and look again.");
  }
  const bytes = await captureModelPageImage(
    page,
    name && name !== "main" ? bounds : undefined,
  );
  return {
    label: name ? `Current frame ${name}` : "Current page",
    dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    bounds,
    viewport,
    frames,
  };
}

/** CDP input is routed by the browser's hit testing, including OOPIFs. */
export async function pointerPage(
  page: Page,
  input: BrowserPointerInput,
): Promise<ApplyWriteResult> {
  const press = watchPagePress(page);
  try {
    await page.mouse.move(input.x, input.y);
    if (input.action === "click") await page.mouse.click(input.x, input.y);
    else {
      await page.mouse.down();
      try {
        if (input.action === "drag")
          await page.mouse.move(input.endX!, input.endY!, { steps: 20 });
        if (input.durationMs) await page.waitForTimeout(input.durationMs);
      } finally {
        await page.mouse.up();
      }
    }
    return {
      ok: true,
      observedValue: input.action,
      clickFacts: await press.finish(),
    };
  } catch {
    return {
      ok: false,
      error: "The browser pointer action failed; look at the page again.",
      clickFacts: await press.finish(),
    };
  }
}
