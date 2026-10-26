import { describe, expect, it } from "vitest";

import {
  NO_PROGRESS_MESSAGE,
  plainRecordedJobFinderText,
  splitBlockedAttemptNote,
  describeFailure,
} from "./describe-failure";

describe("recorded Job Finder copy", () => {
  const internal =
    "The page did not expose a new form state after the previous safe advance. The runtime stopped instead of repeating a control or guessing at page behavior.";

  it("never exposes internal no-progress language", () => {
    expect(plainRecordedJobFinderText(internal)).toBe(NO_PROGRESS_MESSAGE);
    expect(
      splitBlockedAttemptNote(`${internal} Blocked: xhr POST /apply`),
    ).toEqual({
      message: NO_PROGRESS_MESSAGE,
      technicalDetails: "Blocked: xhr POST /apply",
    });
    expect(plainRecordedJobFinderText(internal)).not.toMatch(
      /safe advance|form state|runtime/iu,
    );
  });
});

describe("paused background work", () => {
  it("turns the activity-paused IPC error into a resume instruction", () => {
    const description = describeFailure(
      new Error(
        "Error invoking remote method 'job-finder:start-apply-copilot-run': Error: All work is paused, so this did not start. Press Continue on Home to start work again.",
      ),
      { action: "start this application" },
    );
    expect(description.kind).toBe("paused");
    expect(description.userMessage).toBe(
      "Could not start this application. All work is paused, so nothing new can start. Press Continue on Home, then try again.",
    );
    expect(description.userMessage).not.toContain("remote method");
  });
});

it("keeps service listing advice without its Electron wrapper and hides arbitrary errors", async () => {
  const { describeListingReadFailure, describeBrowserJobFailure } =
    await import("./describe-failure");
  const advice =
    "The listing could not be read from this page. Open the listing and try again.";
  expect(
    describeListingReadFailure(
      new Error(
        `Error invoking remote method 'job-finder:assess': Error: ${advice}`,
      ),
    ),
  ).toBe(advice);
  expect(
    describeListingReadFailure(new Error("Model provider secret payload")),
  ).toBe("Could not assess this listing. Try again.");
  expect(
    describeBrowserJobFailure(
      new Error(
        "No job listing was found on this page. Open the job's own listing and try again.",
      ),
    ),
  ).toContain("No job listing");
});

it("names a failed listing site and reserves the internet sentence for an offline device", async () => {
  const { describeListingReadFailure } = await import("./describe-failure");
  const failure = new Error("fetch failed");
  expect(
    describeListingReadFailure(failure, {
      listingUrl: "https://careers.example.test/jobs/one?private=value",
      online: true,
    }),
  ).toBe(
    "Job Finder could not reach careers.example.test. Open the listing in the browser and try again.",
  );
  expect(
    describeListingReadFailure(failure, {
      listingUrl: "https://careers.example.test/jobs/one",
      online: false,
    }),
  ).toContain("could not reach the internet");
  expect(describeListingReadFailure(failure, { online: true })).not.toContain(
    "internet",
  );
});

describe("a file that moved or was deleted", () => {
  it("says so in plain words and keeps the raw text behind details", () => {
    const failure = describeFailure(
      new Error(
        "Error invoking remote method 'job-finder:import-resume': Error: ENOENT: no such file or directory, open 'C:/Users/person/resume.pdf'",
      ),
      { action: "import your resume" },
    );
    expect(failure.kind).toBe("file_missing");
    expect(failure.userMessage).not.toMatch(/ENOENT|no such file/);
    expect(failure.technicalDetails).toContain("ENOENT");
  });
});
