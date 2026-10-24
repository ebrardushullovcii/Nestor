import { expect, test } from "vitest";
import { JobPostingSchema } from "./discovery";
import {
  readDiscoveryPreparation,
  readPreparedDiscoveryFingerprints,
  readPreparedBodySalaryRange,
  writeDiscoveryPreparation,
} from "./discovery-preparation";

test("prepared values survive owned copies and stay outside JSON and worker messages", () => {
  const posting = { description: "Synthetic body" };
  writeDiscoveryPreparation(posting, {
    content: { description: posting.description, value: null },
  });
  expect(readDiscoveryPreparation({ ...posting })).toBe(
    readDiscoveryPreparation(posting),
  );
  expect(JSON.stringify(posting)).toBe('{"description":"Synthetic body"}');
  expect(readDiscoveryPreparation(structuredClone(posting))).toBeUndefined();
});

test("salary preparation distinguishes missing evidence from no salary and rejects changed mutable inputs", () => {
  const posting = { description: "Synthetic listing text" };
  expect(readPreparedBodySalaryRange(posting)).toBeUndefined();
  writeDiscoveryPreparation(posting, {
    content: { description: posting.description, value: null },
    bodySalaryRange: null,
  });
  expect(readPreparedBodySalaryRange(posting)).toBeNull();
  expect(
    readPreparedBodySalaryRange({ ...posting, description: "Changed text" }),
  ).toBeUndefined();
  posting.description = "Changed text";
  writeDiscoveryPreparation(posting, {
    content: { description: posting.description, value: null },
  });
  expect(readPreparedBodySalaryRange(posting)).toBeUndefined();
  writeDiscoveryPreparation(posting, { bodySalaryRange: null });
  posting.description = "Another changed text";
  writeDiscoveryPreparation(posting, {
    fingerprints: {
      basis: { description: posting.description },
      value: { version: 1, card: "card", detail: null, material: "material" },
    },
  });
  expect(readPreparedBodySalaryRange(posting)).toBeUndefined();
  const lazy = { description: "We offer EUR 96,000 per year." };
  writeDiscoveryPreparation(lazy, {
    fingerprints: {
      owner: lazy,
      value: { version: 1, card: "card", detail: null, material: "material" },
    },
    bodySalaryRange: "EUR 96,000 per year",
  });
  expect(readPreparedBodySalaryRange(lazy)).toBeUndefined();
  Object.defineProperty(lazy, "description", {
    get() {
      throw new Error("Stored salary evidence opened the body");
    },
  });
  Object.freeze(lazy);
  expect(readPreparedBodySalaryRange(lazy)).toBe("EUR 96,000 per year");
  expect(
    readPreparedBodySalaryRange(
      structuredClone({ description: "New decoded input" }),
    ),
  ).toBeUndefined();
});

test("stored fingerprints read no body and changed copies cannot reuse them", () => {
  const posting = JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "synthetic",
    canonicalUrl: "https://example.test/job",
    title: "Engineer",
    company: "Synthetic Company",
    location: "Remote",
    applyPath: "unknown",
    easyApplyEligible: false,
    salaryText: null,
    description: "Synthetic listing body.",
    discoveredAt: "2026-10-24T00:00:00.000Z",
  });
  const value = {
    version: 1 as const,
    card: "card",
    detail: "detail",
    material: "material",
  };
  writeDiscoveryPreparation(posting, {
    fingerprints: { owner: posting, value },
  });
  expect(readPreparedDiscoveryFingerprints(posting)).toBeNull();
  Object.freeze(posting);
  expect(readPreparedDiscoveryFingerprints(posting)).toEqual(value);
  expect(readPreparedDiscoveryFingerprints({ ...posting })).toEqual(value);
  expect(
    readPreparedDiscoveryFingerprints({ ...posting, description: "Changed" }),
  ).toBeNull();
  expect(
    readPreparedDiscoveryFingerprints({
      ...posting,
      workMode: [...posting.workMode, "hybrid"],
    }),
  ).toBeNull();
  const lazy = { ...posting };
  writeDiscoveryPreparation(lazy, { fingerprints: { owner: lazy, value } });
  Object.defineProperty(lazy, "description", {
    get() {
      throw new Error("body was read");
    },
  });
  Object.freeze(lazy);
  expect(readPreparedDiscoveryFingerprints(lazy)).toEqual(value);
});
