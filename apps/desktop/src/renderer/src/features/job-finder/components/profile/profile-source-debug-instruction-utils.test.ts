import type { SourceInstructionArtifact } from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { describeLearnedInstructionUsage } from "./profile-source-debug-instruction-utils";

describe("describeLearnedInstructionUsage", () => {
  it("says how saved guidance is used, from the guidance alone", () => {
    expect(
      describeLearnedInstructionUsage({
        status: "validated",
      } as SourceInstructionArtifact),
    ).toContain("used automatically");
    expect(
      describeLearnedInstructionUsage({
        status: "draft",
      } as SourceInstructionArtifact),
    ).toContain("draft guidance");
    expect(describeLearnedInstructionUsage(null)).toBe(
      "Saved from the latest source check.",
    );
  });
});
