// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isAnyString, useRememberedString } from "./use-remembered-string";

const isTab = (value: string): value is "all" | "ready" =>
  value === "all" || value === "ready";

afterEach(() => window.localStorage.clear());

describe("useRememberedString", () => {
  it("keeps a list's search after it unmounts and mounts again", () => {
    const first = renderHook(() =>
      useRememberedString("test.query", "", isAnyString),
    );
    act(() => first.result.current[1]("platform engineer"));
    first.unmount();

    const again = renderHook(() =>
      useRememberedString("test.query", "", isAnyString),
    );
    expect(again.result.current[0]).toBe("platform engineer");

    // Back to the start value leaves nothing behind.
    act(() => again.result.current[1](""));
    expect(
      window.localStorage.getItem("nestor.job-finder.remembered.test.query"),
    ).toBeNull();
  });

  it("starts from the default when the saved value is no longer a choice", () => {
    window.localStorage.setItem(
      "nestor.job-finder.remembered.test.tab",
      "gone",
    );
    const { result } = renderHook(() =>
      useRememberedString("test.tab", "all", isTab),
    );
    expect(result.current[0]).toBe("all");
  });
});
