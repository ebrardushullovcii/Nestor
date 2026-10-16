import { describe, expect, it } from "vitest";

import { disableReactPerformanceTracks } from "./react-dev-timing";

function fakeConsole(): Console {
  return { timeStamp: () => undefined } as unknown as Console;
}

describe("disableReactPerformanceTracks", () => {
  it("removes console.timeStamp so React records no render timings", () => {
    const target = fakeConsole();
    disableReactPerformanceTracks(false, target);
    expect("timeStamp" in target).toBe(false);
  });

  it("keeps it for a profiling session", () => {
    const profiling = fakeConsole();
    disableReactPerformanceTracks(true, profiling);
    expect(typeof profiling.timeStamp).toBe("function");
  });
});
