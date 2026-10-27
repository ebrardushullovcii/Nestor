import { describe, expect, test } from "vitest";
import { UpdateApplicationDefaultsInputSchema } from "./index";

describe("contracts workspace snapshot schema", () => {
  test("the Apply setting accepts fill or send and rejects the engine-only prepare capability", () => {
    for (const mode of ["confirm_before_submit", "autonomous_submit"]) {
      expect(
        UpdateApplicationDefaultsInputSchema.parse({
          applicationAutomationMode: mode,
        }).applicationAutomationMode,
      ).toBe(mode);
    }
    expect(() =>
      UpdateApplicationDefaultsInputSchema.parse({
        applicationAutomationMode: "prepare_only",
      }),
    ).toThrow();
  });
});
