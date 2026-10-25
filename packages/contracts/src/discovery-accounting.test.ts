import { expect, it } from "vitest";
import {
  formatDiscoverySourceAccounting,
} from "./base";

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
