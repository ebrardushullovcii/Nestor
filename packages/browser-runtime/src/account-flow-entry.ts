import type { Frame, Page, Request } from "playwright";

type Flow = { origins: Set<string>; entries: string[]; overflow: boolean };
const flows = new WeakMap<Page, Flow>();
/** Includes document hops fetched by the existing guarded redirect forwarder. */
export function recordAccountFlowEntry(page: Page, url: string): void {
  trackAccountFlowEntry(page);
  const flow = flows.get(page);
  if (!flow) return;
  if (flow.entries.includes(url)) return;
  if (url.length > 16_384 || flow.entries.length >= 64) {
    flow.overflow = true;
    return;
  }
  flow.entries.push(url);
}
/** Private per-Page navigation evidence. No provider classification or persistence. */
export function trackAccountFlowEntry(page: Page): void {
  if (flows.has(page)) return;
  // Without navigation events there is no trustworthy flow proof.
  if (typeof page.on !== "function" || typeof page.once !== "function") return;
  const flow: Flow = { origins: new Set(), entries: [], overflow: false };
  flows.set(page, flow);
  const requested = (request: Request) => {
    try {
      if (
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()
      )
        return;
      const chain: string[] = [];
      for (let hop: Request | null = request; hop; hop = hop.redirectedFrom())
        chain.unshift(hop.url());
      for (const url of chain) recordAccountFlowEntry(page, url);
    } catch {
      flow.overflow = true;
    }
  };
  const committed = (frame: Frame) => {
    if (frame !== page.mainFrame() || !flow.origins.size) return;
    try {
      if (flow.origins.has(new URL(frame.url()).origin)) return;
    } catch {
      /* An unresolved document ends the old flow. */
    }
    flow.entries = [];
    flow.overflow = false;
  };
  page.on("request", requested);
  page.on("framenavigated", committed);
  page.once("close", () => {
    page.off("request", requested);
    page.off("framenavigated", committed);
    flows.delete(page);
  });
}
export function readAccountFlowEntry(
  page: Page,
  origins: readonly string[],
): readonly string[] {
  trackAccountFlowEntry(page);
  const flow = flows.get(page);
  if (!flow) return [""];
  flow.origins = new Set(origins);
  if (flow.overflow) return [""];
  return flow.entries.filter((url) => {
    try {
      return flow.origins.has(new URL(url).origin);
    } catch {
      return false;
    }
  });
}
export function redactAccountUrl(value: string | null): string | null {
  try {
    const url = new URL(value ?? "");
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}
