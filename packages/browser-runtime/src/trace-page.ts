import type { Page } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  runTraceEnabled,
  traceArtifact,
  traceEvent,
} from "@nestor/core/run-trace";

const bindings = new WeakMap<Page, string>();
export interface TraceCaptureInput {
  masks: { x: number; y: number; width: number; height: number }[];
  viewport: { width: number; height: number };
}
export type TracePageCapture = (
  page: Page,
  input: TraceCaptureInput,
) => Promise<Uint8Array>;
const captures = new WeakMap<ReturnType<Page["context"]>, TracePageCapture>();
export function configureTraceCapture(
  context: ReturnType<Page["context"]>,
  capture?: TracePageCapture,
): void {
  if (runTraceEnabled() && capture) captures.set(context, capture);
}
export function bindTracePage(
  page: Page,
  key: string,
  capture?: TracePageCapture,
): void {
  if (runTraceEnabled()) {
    bindings.set(page, key);
    if (capture) captures.set(page.context(), capture);
  }
}

/** Captures the supplied Page, never a last/active tab chosen by URL. */
export async function tracePage(
  page: Page,
  action: string,
  bytes?: Uint8Array,
): Promise<void> {
  if (!runTraceEnabled()) return;
  const applicationKey = bindings.get(page) ?? null;
  try {
    const started = Date.now();
    // Secrets remain masked in all frames. Text collection never reads input values.
    const masks = page
      .frames()
      .map((frame) =>
        frame.locator(
          'input[type="password"],input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="mfa" i],input[name*="token" i],input[name*="verification" i],input[name*="code" i]',
        ),
      );
    const sensitive = (
      await Promise.all(masks.map((mask) => mask.count()))
    ).some((count) => count > 0);
    const capture = captures.get(page.context());
    const boxes: TraceCaptureInput["masks"] = [];
    for (const mask of masks) {
      for (const locator of await mask.all()) {
        const box = await locator.boundingBox();
        if (box) boxes.push(box);
      }
    }
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    const image =
      bytes && !sensitive
        ? bytes
        : capture
          ? await capture(page, { masks: boxes, viewport })
          : await page.screenshot({
              type: "png",
              mask: masks,
            });
    const shot = traceArtifact("shots", image, "png");
    const visibleText = await page.locator("body").innerText();
    traceEvent("page_snapshot", {
      ...(applicationKey ? { applicationKey } : {}),
      action,
      shot,
      url: page.url(),
      visibleText,
      captureMs: Date.now() - started,
    });
  } catch (error) {
    traceEvent("page_snapshot_error", { applicationKey, action, error });
  }
}

/** Optional recording wraps the existing mechanics, preserving values/errors. */
export function tracePageHands<T extends object>(page: Page, hands: T): T {
  if (!runTraceEnabled()) return hands;
  return new Proxy(hands, {
    get(target, key, receiver) {
      const method: unknown = Reflect.get(target, key, receiver);
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        if (key === "uploadFile") {
          const file = args[1];
          if (file && typeof file === "object") {
            const metadata = file as Record<string, unknown>;
            const filePath = metadata.path ?? metadata.filePath;
            let sha256: string | null = null;
            try {
              if (typeof filePath === "string")
                sha256 = createHash("sha256")
                  .update(readFileSync(filePath))
                  .digest("hex");
            } catch {
              /* Report unavailable identity. */
            }
            if (metadata.bytes instanceof Uint8Array)
              sha256 = createHash("sha256")
                .update(metadata.bytes)
                .digest("hex");
            traceEvent("attachment", {
              ...(bindings.get(page)
                ? { applicationKey: bindings.get(page) }
                : {}),
              file: {
                name: metadata.name,
                mimeType: metadata.mimeType,
                path: filePath,
                size:
                  metadata.bytes instanceof Uint8Array
                    ? metadata.bytes.byteLength
                    : null,
              },
              sha256,
            });
          }
        }
        try {
          const value: unknown = await Reflect.apply(method, target, args);
          return value;
        } finally {
          await tracePage(page, String(key));
        }
      };
    },
  });
}
