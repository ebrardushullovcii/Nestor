import type { BrowserWindow } from "electron";
import type { EmbeddedBrowser } from "./embedded-browser";

let loading: Promise<EmbeddedBrowser> | null = null;
let appWindow: BrowserWindow | null = null;

/**
 * The embedded browser and its runtime load after the first window opens,
 * not before it. Each load attaches the app window first, so a browser call
 * that awaits this finds it attached. A failed load is not kept: the next
 * call tries again.
 */
export function loadEmbeddedBrowser(): Promise<EmbeddedBrowser> {
  loading ??= import("./embedded-browser")
    .then((module) => {
      const browser = module.getEmbeddedBrowser();
      if (appWindow) browser.attachWindow(appWindow);
      return browser;
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

/** The window the browser attaches to; starts loading it. */
export function attachEmbeddedBrowserWhenLoaded(window: BrowserWindow): void {
  appWindow = window;
  void loadEmbeddedBrowser()
    .then((browser) => browser.attachWindow(window))
    .catch((error: unknown) => {
      console.error("[Desktop] The embedded browser could not load.", error);
    });
}
