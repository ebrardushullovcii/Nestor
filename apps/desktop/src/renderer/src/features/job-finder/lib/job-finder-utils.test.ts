// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { jobDescriptionToText } from "./job-description-text";
import {
  getDefaultProfileRoute,
  getPostedDateLabel,
  parseListInput,
  parseTokenListInput,
} from "./job-finder-utils";

describe("getDefaultProfileRoute", () => {
  test("routes fresh workspaces to guided setup by default", () => {
    expect(
      getDefaultProfileRoute({
        status: "not_started",
        currentStep: "import",
        completedAt: null,
        reviewItems: [],
        lastResumedAt: null,
      }),
    ).toBe("/job-finder/profile/setup");
  });

  test("allows explicitly opening the full profile during fresh setup", () => {
    expect(
      getDefaultProfileRoute(
        {
          status: "not_started",
          currentStep: "import",
          completedAt: null,
          reviewItems: [],
          lastResumedAt: null,
        },
        { forceFullProfile: true },
      ),
    ).toBe("/job-finder/profile");
  });

  test("keeps in-progress and completed setup on the full profile route", () => {
    expect(
      getDefaultProfileRoute({
        status: "in_progress",
        currentStep: "background",
        completedAt: null,
        reviewItems: [],
        lastResumedAt: null,
      }),
    ).toBe("/job-finder/profile");

    expect(
      getDefaultProfileRoute({
        status: "completed",
        currentStep: "ready_check",
        completedAt: "2026-04-15T00:00:00.000Z",
        reviewItems: [],
        lastResumedAt: "2026-04-15T00:00:00.000Z",
      }),
    ).toBe("/job-finder/profile");
  });
});

describe("jobDescriptionToText", () => {
  test("strips encoded html markup from stored job descriptions", () => {
    expect(
      jobDescriptionToText(
        '&lt;div class="content-intro"&gt;&lt;h2&gt;&lt;strong&gt;About Remote&lt;/strong&gt;&lt;/h2&gt;&lt;div&gt;Remote is solving modern organizations&apos; biggest challenge.&lt;/div&gt;&lt;/div&gt;',
      ),
    ).toBe(
      "About Remote Remote is solving modern organizations' biggest challenge.",
    );
  });
});

describe("getPostedDateLabel", () => {
  const providerUpdatedAt = "2026-07-30T12:00:00.000Z";
  const now = new Date("2026-10-15T12:00:00.000Z").getTime();

  test("labels a known posting date as Posted, in one age shape", () => {
    const at = (iso: string) =>
      getPostedDateLabel(
        { postedAt: iso, postedAtText: null, providerUpdatedAt },
        now,
      )?.value;
    expect(at("2026-10-15T08:00:00.000Z")).toBe("today");
    expect(at("2026-10-14T08:00:00.000Z")).toBe("yesterday");
    expect(at("2026-10-10T08:00:00.000Z")).toBe("5 days ago");
    expect(at("2026-09-24T08:00:00.000Z")).toBe("3 weeks ago");
    expect(at("2026-07-01T12:00:00.000Z")).toBe("01 Jul 2026");
  });

  test("prefers the stored posting date over the site's own aging words", () => {
    expect(
      getPostedDateLabel(
        {
          postedAt: "2026-10-10T12:00:00.000Z",
          postedAtText: "2 days ago",
          providerUpdatedAt,
        },
        now,
      ),
    ).toEqual({ label: "Posted", value: "5 days ago" });
  });

  test("writes a site's relative wording in the same shape", () => {
    const text = (postedAtText: string) =>
      getPostedDateLabel(
        { postedAt: null, postedAtText, providerUpdatedAt: null },
        now,
      )?.value;
    expect(text("38 day(s) ago")).toBe("5 weeks ago");
    expect(text("3wks ago")).toBe("3 weeks ago");
    expect(text("5h ago")).toBe("today");
    expect(text("September 24, 2026")).toBe("3 weeks ago");
    expect(text("Recently")).toBe("Recently");
  });

  test("labels a provider-only update time as Updated instead of claiming a posted date", () => {
    expect(
      getPostedDateLabel(
        { postedAt: null, postedAtText: null, providerUpdatedAt },
        now,
      ),
    ).toEqual({ label: "Updated", value: "30 Jul 2026" });
  });

  test("renders nothing when no date exists at all", () => {
    expect(
      getPostedDateLabel({
        postedAt: null,
        postedAtText: null,
        providerUpdatedAt: null,
      }),
    ).toBeNull();
  });

  test("renders nothing when the posted slot holds a non-date token", () => {
    expect(
      getPostedDateLabel({
        postedAt: null,
        postedAtText: "NOPE",
        providerUpdatedAt: null,
      }),
    ).toBeNull();
  });

  test("ignores a non-date posted token in favour of a real posting date", () => {
    expect(
      getPostedDateLabel(
        {
          postedAt: "2026-09-04T12:00:00.000Z",
          postedAtText: "NOPE",
          providerUpdatedAt,
        },
        now,
      ),
    ).toEqual({ label: "Posted", value: "6 weeks ago" });
  });

  test("still renders a written-out posting date", () => {
    expect(
      getPostedDateLabel(
        {
          postedAt: null,
          postedAtText: "04 Sept 2026",
          providerUpdatedAt: null,
        },
        now,
      ),
    ).toEqual({ label: "Posted", value: "6 weeks ago" });
  });
});

describe("list input parsers", () => {
  test("keeps parseListInput strictly line-based for newline list fields", () => {
    expect(parseListInput("React\nTypeScript")).toEqual([
      "React",
      "TypeScript",
    ]);
    // A comma inside one line stays part of that line: this parser never
    // invents token boundaries.
    expect(parseListInput("frontend, fullstack")).toEqual([
      "frontend, fullstack",
    ]);
  });

  test("treats nullish watch values as empty lists instead of throwing", () => {
    expect(parseListInput(undefined)).toEqual([]);
    expect(parseListInput(null)).toEqual([]);
    expect(parseListInput("")).toEqual([]);
  });

  test("parses role-family tokens from commas and newlines together", () => {
    expect(parseTokenListInput("frontend, fullstack\ndesign systems")).toEqual([
      "frontend",
      "fullstack",
      "design systems",
    ]);
    expect(parseTokenListInput("backend,platform ,")).toEqual([
      "backend",
      "platform",
    ]);
    expect(parseTokenListInput("")).toEqual([]);
  });
});
