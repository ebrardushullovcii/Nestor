import { describe, expect, test } from "vitest";

import { normalizeInstructionLine } from "./source-instruction-filtering";

describe("source instruction filtering", () => {
  test("scrubs broken route examples from reusable instruction text", () => {
    expect(
      normalizeInstructionLine(
        "Direct path guesses like https://example.com/404 are broken and should be ignored.",
      ),
    ).toBe("Direct path guesses like that route are broken and should be ignored.");
    expect(
      normalizeInstructionLine(
        "Broken templated routes like /jobs/{slug} should not be reused.",
      ),
    ).toBe("Broken templated routes like that route should not be reused.");
  });
});
