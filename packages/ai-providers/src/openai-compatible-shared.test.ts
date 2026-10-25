import { describe, expect, test, vi } from "vitest";
import { logFallbackError } from "./openai-compatible-shared";

describe("logFallbackError", () => {
  test("never interrupts the fallback path when the logging pipe is broken", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    });

    try {
      expect(() => logFallbackError("Resume import stage experience", new Error("offline"))).not.toThrow();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
