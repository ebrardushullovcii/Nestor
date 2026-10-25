import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const browserPeekCss = read(
  "../features/job-finder/components/browser-peek.css",
);
const globalsCss = read("./globals.css");

// Signals that can show for minutes. An endless loop on any of them made the
// window draw every frame for as long as the work ran.
const longLivedSignals = [
  [
    "../features/job-finder/assistant/assistant-toggle.tsx",
    "{assistant.working && !assistant.open ? (",
  ],
  ["../features/job-finder/components/apply-queue-strip.tsx", "view.active"],
  [
    "../features/job-finder/screens/job-search-home/job-search-home-screen.tsx",
    "item.active === false",
  ],
  [
    "../features/job-finder/screens/discovery/discovery-results-panel.tsx",
    "{resultsStatusLine.busy ? (",
  ],
  ["../components/ui/progress-bar.tsx", "data-progress-indeterminate"],
] as const;

describe("working signals rest", () => {
  it("the browser badge ripples and nudges a few times, not forever", () => {
    const rule = (selector: string) =>
      browserPeekCss.slice(browserPeekCss.indexOf(selector)).split("}")[0];
    expect(
      rule(".browser-peek-trigger.is-working .browser-trigger-badge::after {"),
    ).toMatch(/browser-ripple 1\.6s ease-out 3;/);
    expect(
      rule(".browser-peek-trigger.is-needs-you .browser-trigger-icon {"),
    ).toMatch(/browser-nudge [^;]* 3;/);
  });

  it("the brief pulse and spin stop after three turns", () => {
    expect(globalsCss).toMatch(/--animate-pulse-brief: pulse [^;]* 3;/);
    expect(globalsCss).toMatch(/--animate-spin-brief: spin [^;]* 3;/);
  });

  it.each(longLivedSignals)("%s uses a brief animation", (path, marker) => {
    const source = read(path);
    const at = source.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const signal = source.slice(at, at + 600);
    expect(signal).toMatch(/animate-(pulse|spin)-brief/);
    expect(signal).not.toMatch(/animate-(pulse|spin)(?!-brief)\b/);
  });
});
