import type { TrackerRow } from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { trackerCsv } from "./tracker-csv";

const row: TrackerRow = {
  id: 1,
  title: "Frontend Engineer",
  company: "Dusk Acorn Collective",
  location: "Remote, Europe",
  status: "interview",
  statusAt: "2026-10-25T23:30:00.000Z",
  work: null,
  workError: null,
  appliedAt: "2026-10-25T08:00:00.000Z",
  nextAt: "2026-10-26T14:00:00.000Z",
  nextTitle: "Design systems interview",
  tags: [],
};

describe("Applications CSV", () => {
  const zone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "Europe/Berlin";
  });
  afterEach(() => {
    process.env.TZ = zone;
  });

  it("writes days and appointment times as the person sees them, with the offset", () => {
    const [, line] = trackerCsv([row]).split("\r\n");
    // 23:30 UTC is already the 26th in Berlin; 14:00 UTC is 15:00 there.
    expect(line).toBe(
      'Dusk Acorn Collective,Frontend Engineer,"Remote, Europe",Interview,2026-10-26,2026-10-25,Design systems interview,2026-10-26 15:00 +01:00,',
    );
  });
});
