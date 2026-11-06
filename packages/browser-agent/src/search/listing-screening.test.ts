import { afterEach, expect, test, vi } from "vitest";
import type { ListingCard } from "@nestor/contracts";
import { professionEvidence } from "./listing-screening";

test.each([false, true])(
  "profession screening retains duties beyond a short card prefix (structured=%s)",
  (structured) => {
    const duties = `${"Company introduction. ".repeat(100)} Build frontend product interfaces and accessible design systems.`;
    const card: ListingCard = {
      sourceId: "synthetic",
      sourceLabel: "Synthetic",
      url: "https://example.test/job",
      title: "Software Engineer",
      text: structured
        ? JSON.stringify({ department: "Engineering", description: duties })
        : duties,
      cardFingerprint: "synthetic",
    };
    expect(professionEvidence(card)).toContain(
      "Build frontend product interfaces and accessible design systems.",
    );
  },
);

afterEach(() => vi.restoreAllMocks());

test.each([false, true])(
  "profession evidence reports actual loss at 8000, never below it (structured=%s)",
  (structured) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const card = (description: string): ListingCard => ({
      sourceId: "synthetic",
      sourceLabel: "Synthetic",
      url: "https://example.test/job",
      title: "Software Engineer",
      cardFingerprint: "synthetic",
      text: structured ? JSON.stringify({ description }) : description,
    });
    const evidence = "x".repeat(8000);
    expect(professionEvidence(card(evidence))).toBe(evidence);
    expect(log).not.toHaveBeenCalled();
    expect(professionEvidence(card(evidence + "y"))).toBe(evidence);
    expect(log).toHaveBeenCalledOnce();
    const record = JSON.parse(
      String(log.mock.calls[0][0]).replace("[self_limit_hit] ", ""),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      event: "self_limit_hit",
      limit: "evidence_window",
      kind: "input",
      value: 8000,
    });
    expect(String(record.where)).toContain("listing-screening.ts:");
  },
);
