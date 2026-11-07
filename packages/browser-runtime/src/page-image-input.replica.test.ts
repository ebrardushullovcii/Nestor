import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";
import { configureTraceCapture, type TraceCaptureInput } from "./trace-page";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("No fixture address");
  return `http://127.0.0.1:${address.port}`;
}

test("page and named cross-origin frame images use viewport coordinates; trusted click, drag and hold land inside it", async () => {
  const child = createServer((_req, res) =>
    res.end(`<!doctype html><style>body{margin:0}</style><canvas width="300" height="200"></canvas><input type="password" value="synthetic-secret"><script>
    const c=document.querySelector('canvas');c.getContext('2d').fillRect(20,20,60,60);
    window.events=[];for(const name of ['pointerdown','pointermove','pointerup','click'])c.addEventListener(name,e=>events.push({type:e.type,x:e.clientX,y:e.clientY,trusted:e.isTrusted,at:performance.now()}));</script>`),
  );
  const childUrl = await listen(child);
  const parent = createServer((_req, res) =>
    res.end(
      `<!doctype html><style>body{margin:0}iframe{position:absolute;left:110px;top:80px;width:320px;height:240px;border:0}</style><h1>Image fixture</h1><iframe name="puzzle" src="${childUrl}"></iframe>`,
    ),
  );
  const parentUrl = await listen(parent);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
    });
    await page.goto(parentUrl);
    const hands = createPlaywrightApplyPageMechanics(page);
    const whole = await hands.screenshot!();
    const png = Buffer.from(whole.dataUrl.split(",")[1]!, "base64");
    expect(png.readUInt32BE(16)).toBe(800);
    expect(png.readUInt32BE(20)).toBe(600);
    const frame = whole.frames.find((frame) => frame.name === "puzzle")!;
    expect(frame.origin).not.toBe(new URL(parentUrl).origin);
    expect(frame.bounds).toEqual({ x: 110, y: 80, width: 320, height: 240 });
    for (const name of [frame.id, "puzzle"]) {
      const image = await hands.screenshot!(name);
      const bytes = Buffer.from(image.dataUrl.split(",")[1]!, "base64");
      expect(bytes.readUInt32BE(16)).toBe(320);
      expect(bytes.readUInt32BE(20)).toBe(240);
      expect(image.bounds).toEqual(frame.bounds);
    }
    const childFrame = page
      .frames()
      .find((frame) => frame.name() === "puzzle")!;
    expect(
      await hands.pointer!({ action: "click", x: 150, y: 130 }),
    ).toMatchObject({ ok: true });
    expect(
      await childFrame.evaluate(
        () => (window as unknown as { events: unknown[] }).events,
      ),
    ).toContainEqual(
      expect.objectContaining({ type: "click", x: 40, y: 50, trusted: true }),
    );
    await hands.pointer!({
      action: "drag",
      x: 150,
      y: 130,
      endX: 250,
      endY: 180,
    });
    await hands.pointer!({ action: "hold", x: 150, y: 130, durationMs: 80 });
    const events = await childFrame.evaluate(
      () =>
        (
          window as unknown as {
            events: Array<{
              type: string;
              x: number;
              y: number;
              at: number;
              trusted: boolean;
            }>;
          }
        ).events,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "pointerup",
        x: 140,
        y: 100,
        trusted: true,
      }),
    );
    const down = events.filter((e) => e.type === "pointerdown").at(-1)!;
    const up = events.filter((e) => e.type === "pointerup").at(-1)!;
    expect(up.at - down.at).toBeGreaterThanOrEqual(70);
    // Native hidden capture is used even when tracing is OFF, with frame secrets masked.
    let masks: TraceCaptureInput["masks"] = [];
    configureTraceCapture(page.context(), (_page, input) => {
      masks = input.masks;
      return Promise.resolve(png);
    });
    await hands.screenshot!();
    expect(masks.length).toBeGreaterThan(0);
    expect(masks[0]!.width).toBeGreaterThan(0);
    expect(masks[0]!.x).toBeGreaterThanOrEqual(110);
  } finally {
    await browser.close();
    await Promise.all(
      [child, parent].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }
}, 30_000);
