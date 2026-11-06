import { expect, test } from "vitest";
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
