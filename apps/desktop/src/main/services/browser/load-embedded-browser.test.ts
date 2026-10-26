import type { BrowserWindow } from "electron";
import { expect, test, vi } from "vitest";

const { attempts, attachWindow } = vi.hoisted(() => ({
  attempts: { count: 0 },
  attachWindow: vi.fn(),
}));

vi.mock("./embedded-browser", () => {
  attempts.count++;
  if (attempts.count === 1) throw new Error("chunk failed to load");
  return { getEmbeddedBrowser: () => ({ attachWindow }) };
});

test("retries a failed load, and attaches the app window once it loads", async () => {
  const { attachEmbeddedBrowserWhenLoaded, loadEmbeddedBrowser } =
    await import("./load-embedded-browser");
  const window = {} as BrowserWindow;
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  attachEmbeddedBrowserWhenLoaded(window);
  await expect(loadEmbeddedBrowser()).rejects.toThrow();

  vi.resetModules();
  await loadEmbeddedBrowser();
  expect(attachWindow).toHaveBeenCalledWith(window);
});
