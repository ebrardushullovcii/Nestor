import {
  trackerFilterStatusValues,
  type HomeSummary,
  type TrackerFilterStatus,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { describeApply, nextSteps } from "./home-screen";

const noStatuses = Object.fromEntries(
  trackerFilterStatusValues.map((status) => [status, 0]),
) as Record<TrackerFilterStatus, number>;

function summary(toReview: number): HomeSummary {
  return {
    jobs: { found: 0, hidden: 0, shortlisted: 0, resume: 0, applied: 0 },
    tracker: noStatuses,
    resumes: { writing: 0, toReview, failed: 0 },
    readyToApply: 0,
    applyWorking: 0,
    applyWaiting: { needsYou: 0, ready: 0 },
    needsYou: { questions: 0, signIns: 0, signInSites: 0, checks: 0 },
    interviewsThisWeek: 0,
    followUpsDue: 0,
    foundToday: 0,
    days: [],
    recent: noStatuses,
    upcoming: [],
  };
}

describe("Home's next steps", () => {
  it("makes the resume count and its pronoun agree", () => {
    expect(nextSteps(summary(1)).map((step) => step.text)).toEqual([
      "Read 1 resume and approve it",
    ]);
    expect(nextSteps(summary(3)).map((step) => step.text)).toEqual([
      "Read 3 resumes and approve them",
    ]);
  });

  it("counts every shortlisted job, as Shortlisted does, while resumes are written", () => {
    const writing = summary(1);
    writing.resumes = { writing: 2, toReview: 1, failed: 0 };
    expect(nextSteps(writing)[0]).toMatchObject({
      text: "Review 3 shortlisted jobs",
      detail: "1 resume ready to read · 2 being written.",
    });
  });

  it("counts sign-ins by job site, as Needs you does, and names both when they differ", () => {
    const grouped = summary(0);
    grouped.needsYou = {
      questions: 0,
      signIns: 52,
      signInSites: 2,
      checks: 0,
    };
    expect(nextSteps(grouped)[0]).toMatchObject({
      text: "Sign in to 2 job sites",
      detail:
        "52 sign-ins on these sites; searching or applying there waits until you sign in.",
    });
    const one = summary(0);
    one.needsYou = { questions: 0, signIns: 3, signInSites: 3, checks: 0 };
    expect(nextSteps(one)[0]).toMatchObject({
      text: "Sign in to 3 job sites",
      detail: "Searching or applying there waits until you do.",
    });
  });

  it("puts setting up the profile first until setup is finished", () => {
    expect(nextSteps(summary(2), "not_started")[0]).toMatchObject({
      text: "Set up your profile",
      action: "Set up",
      to: "/job-finder/profile/setup",
    });
    expect(nextSteps(summary(0), "in_progress").map((s) => s.action)).toEqual([
      "Continue setup",
    ]);
    expect(nextSteps(summary(0), "completed")).toEqual([]);
    // An unknown setup state never nags.
    expect(nextSteps(summary(0))).toEqual([]);
  });
});

describe("what Apply is doing", () => {
  it("never counts work waiting on the person as Apply's", () => {
    expect(
      describeApply({
        ...summary(0),
        applyWorking: 3,
        applyWaiting: { needsYou: 1, ready: 2 },
      }),
    ).toBe("1 application waiting on you · 2 ready to send.");
    // Leading alone, the count names what it counts.
    expect(
      describeApply({
        ...summary(0),
        applyWorking: 3,
        applyWaiting: { needsYou: 3, ready: 0 },
      }),
    ).toBe("3 applications waiting on you.");
    expect(
      describeApply({
        ...summary(0),
        applyWorking: 2,
        applyWaiting: { needsYou: 0, ready: 1 },
      }),
    ).toBe("Apply is working on 1 application · 1 ready to send.");
  });
});
