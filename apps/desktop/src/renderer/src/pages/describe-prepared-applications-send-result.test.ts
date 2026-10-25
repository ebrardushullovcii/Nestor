import { describe, expect, it } from "vitest";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { describePreparedApplicationsSendResult } from "./use-job-finder-page-controller-actions";

describe("describePreparedApplicationsSendResult", () => {
  it("says how many of a Send all press went out", () => {
    const snapshot = {
      applyJobResults: [
        {
          jobId: "a",
          state: "submitted",
          updatedAt: "2026-09-25T01:00:00.000Z",
        },
        {
          jobId: "b",
          state: "awaiting_review",
          updatedAt: "2026-09-25T01:00:00.000Z",
        },
        {
          jobId: "c",
          state: "submitted",
          updatedAt: "2026-09-25T01:00:00.000Z",
        },
      ],
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    expect(describePreparedApplicationsSendResult(snapshot, ["a", "c"])).toBe(
      "Sent all 2 applications.",
    );
    expect(
      describePreparedApplicationsSendResult(snapshot, ["a", "b", "c"]),
    ).toBe(
      "Sent 2 of 3 applications. The others are in Applications with what stopped them.",
    );
  });
});
