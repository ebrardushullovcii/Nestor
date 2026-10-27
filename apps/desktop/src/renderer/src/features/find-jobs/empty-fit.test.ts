import { expect, test } from "vitest";
import { emptyFitReason } from "./empty-fit";

test("a dominant authorization limit explains the empty list and directs profile review", () => {
  expect(
    emptyFitReason(
      {
        total: 60,
        checking: 0,
        limits: [
          { kind: "eligibility_unconfirmed", countries: ["DE"], count: 60 },
        ],
        workCountries: [],
      },
      65,
    ),
  ).toEqual({
    eligibility: true,
    detail:
      "All 60 are held back by work authorization in Germany. Your profile doesn't list Germany as a place you can work.",
  });
});

test("mixed limits show counts without claiming they all share one reason", () => {
  expect(
    emptyFitReason(
      {
        total: 60,
        checking: 0,
        limits: [
          { kind: "eligibility", countries: ["DE"], count: 32 },
          { kind: "role", countries: [], count: 20 },
        ],
      },
      65,
    ),
  ).toEqual({
    eligibility: false,
    detail:
      "60 found jobs score below 65. Most often: work authorization (32), role (20).",
  });
});
