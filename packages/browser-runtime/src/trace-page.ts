import type { Locator, Page } from "playwright";
import { isDetachedFrameError, readVisibleText } from "./visible-page-text";
import { withBrowserReadLiveness } from "./browser-read-liveness";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  holdVerificationTrace,
  runTraceEnabled,
  traceArtifact,
  traceEvent,
  verificationIsPrivate,
} from "@nestor/core/run-trace";

const bindings = new WeakMap<Page, string>();
const privatePages = new WeakSet<Page>();
const mailboxPages = new WeakSet<Page>();
/** Pages that displayed a code have no retained text or pixels. */
export function markPrivateTracePage(page: Page): void {
  privatePages.add(page);
}
/**
 * A mailbox or other auxiliary task tab. Its evidence is kept unless the run
 * used an emailed code; then its text and pixels are omitted, also later.
 */
export function markMailboxTracePage(page: Page): void {
  mailboxPages.add(page);
  holdVerificationTrace((codeSeen) => {
    if (codeSeen) privatePages.add(page);
  });
}
/** Whether stored copies of this page must be skipped now. */
export const pageTraceIsPrivate = (page: Page): boolean =>
  privatePages.has(page) || (mailboxPages.has(page) && verificationIsPrivate());
export interface TraceCaptureInput {
  masks: { x: number; y: number; width: number; height: number }[];
  viewport: { width: number; height: number };
  clip?: { x: number; y: number; width: number; height: number };
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
  if (capture) captures.set(context, capture);
}
export function bindTracePage(
  page: Page,
  key: string,
  capture?: TracePageCapture,
): void {
  if (capture) captures.set(page.context(), capture);
  if (runTraceEnabled()) {
    bindings.set(page, key);
  }
}

const SECRET_FIELDS =
  'input[type="password"],input[name*="password" i],input[autocomplete*="password" i],input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="mfa" i],input[name*="token" i],input[name*="verification" i],input[name="code" i],input[name="passcode" i]';

/**
 * Secret fields to mask, frame by frame. An ad frame that detaches during the
 * capture is no longer drawn, so it has nothing to mask and no longer fails
 * the capture.
 */
async function secretFieldMasks(page: Page): Promise<{
  masks: Locator[];
  boxes: TraceCaptureInput["masks"];
  sensitive: boolean;
}> {
  const masks: Locator[] = [];
  const boxes: TraceCaptureInput["masks"] = [];
  let sensitive = false;
  for (const frame of page.frames()) {
    const mask = frame.locator(SECRET_FIELDS);
    try {
      const fields = await mask.all();
      sensitive ||= fields.length > 0;
      for (const locator of fields) {
        const box = await locator.boundingBox();
        if (box) boxes.push(box);
      }
      masks.push(mask);
    } catch (error) {
      if (frame === page.mainFrame() || !isDetachedFrameError(frame, error))
        throw error;
    }
  }
  return { masks, boxes, sensitive };
}

/** Hidden native capture when embedded; CSS-sized Playwright capture otherwise. */
export async function captureModelPageImage(
  page: Page,
  clip?: TraceCaptureInput["clip"],
): Promise<Uint8Array> {
  return captureMaskedPageImage(page, await secretFieldMasks(page), clip);
}

async function captureMaskedPageImage(
  page: Page,
  { masks, boxes }: Awaited<ReturnType<typeof secretFieldMasks>>,
  clip?: TraceCaptureInput["clip"],
): Promise<Uint8Array> {
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  const capture = captures.get(page.context());
  const native = capture
    ? await capture(page, {
        masks: boxes,
        viewport,
        ...(clip ? { clip } : {}),
      }).catch(() => null)
    : null;
  return (
    native ??
    page.screenshot({
      type: "png",
      scale: "css",
      timeout: 0,
      mask: masks,
      ...(clip ? { clip } : {}),
    })
  );
}

/** Captures the supplied Page, never a last/active tab chosen by URL. */
export function tracePage(
  page: Page,
  action: string,
  bytes?: Uint8Array,
): Promise<void> {
  // Recording must never hold the browser action or its result. In particular,
  // a navigating page or a stalled native capture must not stop the model.
  void capturePageTrace(page, action, bytes).catch(() => undefined);
  return Promise.resolve();
}

async function capturePageTrace(
  page: Page,
  action: string,
  bytes?: Uint8Array,
): Promise<void> {
  if (!runTraceEnabled()) return;
  if (privatePages.has(page)) {
    traceEvent("page_snapshot", {
      applicationKey: bindings.get(page) ?? null,
      action,
      shot: null,
      omitted: "verification privacy",
    });
    return;
  }
  const applicationKey = bindings.get(page) ?? null;
  try {
    const started = Date.now();
    // Secrets remain masked in all frames. Text collection never reads input values.
    const image = await withBrowserReadLiveness(page, async () => {
      const masks = await secretFieldMasks(page);
      return bytes && !masks.sensitive
        ? bytes
        : captureMaskedPageImage(page, masks);
    });
    if (privatePages.has(page)) {
      traceEvent("page_snapshot", {
        applicationKey,
        action,
        shot: null,
        omitted: "verification privacy",
      });
      return;
    }
    const mailboxPage = mailboxPages.has(page);
    const shot = traceArtifact("shots", image, "png", { mailboxPage });
    const visibleText = await readVisibleText(page.locator("body"));
    traceEvent("page_snapshot", {
      ...(applicationKey ? { applicationKey } : {}),
      action,
      shot,
      url: page.url(),
      visibleText,
      captureMs: Date.now() - started,
      ...(mailboxPage ? { mailboxPage } : {}),
    });
  } catch (error) {
    traceEvent("page_snapshot_error", { applicationKey, action, error });
  }
}

/** Final evidence is collected after the outcome and before this exact tab closes. */
export async function traceFinalPage(page: Page): Promise<void> {
  if (runTraceEnabled()) await capturePageTrace(page, "final_outcome");
}

/** Optional recording wraps the existing mechanics, preserving values/errors. */
export function tracePageHands<T extends object>(page: Page, hands: T): T {
  if (!runTraceEnabled()) return hands;
  return new Proxy(hands, {
    get(target, key, receiver) {
      const method: unknown = Reflect.get(target, key, receiver);
      if (typeof method !== "function") return method;
      return (...args: unknown[]) => {
        if (key === "uploadFile")
          setImmediate(() => {
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
          });
        try {
          const value: unknown = Reflect.apply(method, target, args);
          if (
            value &&
            typeof value === "object" &&
            "then" in value &&
            typeof value.then === "function"
          )
            return Promise.resolve(value).finally(() => {
              void tracePage(page, String(key));
            });
          void tracePage(page, String(key));
          return value;
        } catch (error) {
          void tracePage(page, String(key));
          throw error;
        }
      };
    },
  });
}
