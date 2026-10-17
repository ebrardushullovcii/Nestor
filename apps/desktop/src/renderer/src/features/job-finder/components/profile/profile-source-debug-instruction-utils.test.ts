import type {
  SourceDebugRunRecord,
  SourceInstructionArtifact,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { describeLearnedInstructionUsage } from "./profile-source-debug-instruction-utils";

describe("describeLearnedInstructionUsage", () => {
  it("makes retained older guidance explicit after the latest check fails", () => {
    const artifact = {
      status: "validated",
      basedOnRunId: "source_check_previous",
    } as SourceInstructionArtifact;
    const failedRun = {
      id: "source_check_latest",
      state: "failed",
      updatedAt: "2026-08-11T00:23:14.000Z",
      completedAt: "2026-08-11T00:23:14.000Z",
    } as SourceDebugRunRecord;

    const description = describeLearnedInstructionUsage(artifact, failedRun);

    expect(description).toContain("earlier successful check");
    expect(description).toContain("latest check failed");
    expect(description).toContain("did not re-verify or replace it");
  });
});
