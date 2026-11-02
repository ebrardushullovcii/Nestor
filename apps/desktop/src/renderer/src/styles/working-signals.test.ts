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
  ["../features/job-finder/assistant/assistant-toggle.tsx", "{assistant.working && !assistant.open ? ("],
] as const;

describe("working signals rest", () => {
  it("the browser badge ripples and nudges a few times, not forever", () => {
    const rule = (selector: string) =>
      browserPeekCss.slice(browserPeekCss.indexOf(selector)).split("}")[0];
    expect(rule(".browser-peek-trigger.is-working .browser-trigger-badge::after {")).toMatch(/browser-ripple 1\.6s ease-out 3;/);
    expect(rule(".browser-peek-trigger.is-needs-you .browser-trigger-icon {")).toMatch(/browser-nudge [^;]* 3;/);
  });

  it("the brief pulse and spin stop after three turns", () => {
    expect(globalsCss).toMatch(/--animate-pulse-brief: pulse [^;]* 3;/);
    expect(globalsCss).toMatch(/--animate-spin-brief: spin [^;]* 3;/);
  });

  // Work of unknown length (searching, checking fit, writing a resume) shows
  // an indicator that keeps going until the work ends: one that pulsed three
  // times and stopped read as finished. It moves by transform alone, so the
  // compositor animates it without repainting the page each frame.
  it("long work keeps moving, by transform only", () => {
    const progress = read("../components/ui/progress-bar.tsx");
    const at = progress.indexOf("data-progress-indeterminate");
    expect(progress.slice(at, at + 600)).toMatch(/progress-indeterminate/);
    const keyframes = (name: string) =>
      globalsCss.slice(globalsCss.indexOf(`@keyframes ${name}`)).split(/\n}\n/)[0]!;
    for (const name of ["progress-indeterminate", "skeleton-shimmer"]) {
      const block = keyframes(name);
      expect(block).toMatch(/transform:/);
      expect(block).not.toMatch(/background|width|left|opacity/);
    }
    expect(globalsCss).toMatch(/\.progress-indeterminate \{\s*animation: progress-indeterminate [^;]* infinite;/);
    // Reduced motion parks it.
    const reduced = globalsCss.slice(
      globalsCss.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(reduced).toMatch(/\.progress-indeterminate \{\s*animation: none;/);
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
