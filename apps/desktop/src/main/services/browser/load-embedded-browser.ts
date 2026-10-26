import type { EmbeddedBrowser } from "./embedded-browser";

let loading: Promise<EmbeddedBrowser> | null = null;

/**
 * The embedded browser and its runtime load after the first window opens,
 * not before it. The window attaches first, so a browser call made once the
 * page is up finds it attached.
 */
export function loadEmbeddedBrowser(): Promise<EmbeddedBrowser> {
  loading ??= import("./embedded-browser").then((module) =>
    module.getEmbeddedBrowser(),
  );
  return loading;
}
