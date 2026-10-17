import { JobSearchPreferencesSchema } from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listNewEnabledSourceIds,
  runBoundedNewSourceReadabilityCheck,
} from "./new-source-readability-check";

describe("new source readability check", () => {
  afterEach(() => vi.useRealTimers());

  it("checks only newly added enabled sources", () => {
    const target = (id: string, enabled = true) => ({
      id,
      label: id,
      startingUrl: `https://${id}.example/jobs`,
      enabled,
      adapterKind: "auto" as const,
      instructionStatus: "missing" as const,
      lastVerifiedAt: null,
      staleReason: null,
    });
    const before = JobSearchPreferencesSchema.parse({
      minimumSalaryUsd: null,
      approvalMode: "draft_only",
      tailoringMode: "balanced",
      discovery: { targets: [target("existing")] },
    });
    const after = JobSearchPreferencesSchema.parse({
      minimumSalaryUsd: null,
      approvalMode: "draft_only",
      tailoringMode: "balanced",
      discovery: {
        targets: [target("existing"), target("new"), target("disabled", false)],
      },
    });

    expect(listNewEnabledSourceIds(before, after)).toEqual(["new"]);
  });

  it("aborts the add-time check after its bounded timeout", async () => {
    vi.useFakeTimers();
    const run = vi.fn((signal: AbortSignal) => {
      void signal;
      return new Promise<string>(() => {});
    });
    const result = runBoundedNewSourceReadabilityCheck(run, 15_000);
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(run.mock.calls[0]?.[0].aborted).toBe(true);
  });
});
