import { expect, it } from "vitest";
import {
  formatDiscoveryAccounting,
  formatDiscoverySourceAccounting,
} from "./base";

it("uses a singular page when one page was covered", () => {
  expect(
    formatDiscoveryAccounting({
      found: 1,
      unique: 1,
      new: 1,
      retained: 1,
      duplicates: 0,
      rejected: 0,
      deferred: 0,
      pagesCovered: 1,
    }),
  ).toContain("1 page covered");
});

it("shows only known counts in a first search's partial report", () => {
  expect(
    formatDiscoveryAccounting({
      found: 2,
      unique: 2,
      new: 2,
      retained: null,
      duplicates: 0,
      rejected: null,
      deferred: null,
      pagesCovered: null,
    }),
  ).toBe("2 postings seen · 2 unique jobs · 2 new to you");
});

it("leaves zero merges, rejects and deferrals out of the run line", () => {
  expect(
    formatDiscoveryAccounting({
      found: 52,
      unique: 25,
      new: 0,
      retained: 22,
      duplicates: 27,
      rejected: 0,
      deferred: 0,
      pagesCovered: 7,
    }),
  ).toBe(
    "52 postings seen · 25 unique jobs · 0 new to you · 22 kept by this plan · 27 duplicates merged · 7 pages covered",
  );
});

it("keeps a source line to the counts that happened", () => {
  expect(
    formatDiscoverySourceAccounting({
      targetId: "target_1",
      inspected: 0,
      saved: 0,
      rejected: 0,
      duplicates: 0,
      deferred: 0,
      pagesCovered: 1,
    }),
  ).toBe("0 inspected · 1 page covered");
  expect(
    formatDiscoverySourceAccounting({
      targetId: "target_2",
      inspected: 40,
      saved: 0,
      rejected: 0,
      duplicates: 40,
      deferred: 0,
      pagesCovered: 1,
    }),
  ).toBe("40 inspected · 40 duplicates · 1 page covered");
});
